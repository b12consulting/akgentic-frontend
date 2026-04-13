import { inject, Injectable } from '@angular/core';

import { BehaviorSubject, Subject, Subscription } from 'rxjs';
import { bufferTime, filter, take } from 'rxjs/operators';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { environment } from '../../environments/environment';
import { buildPreview } from '../models/chat-message.model';
import {
  AkgenticMessage,
  isReceivedMessage,
  isSentMessage,
} from '../models/message.types';
import { EventResponse } from '../models/team.interface';

import { ApiService } from '../services/api.service';
import { ChatService } from './chat.service';
import { KGStateReducer, KnowledgeGraphData } from './kg-state.reducer';
import { MessageLogService } from './message-log.service';
import { ToolPresenceService } from './tool-presence.service';
import { MessageService } from 'primeng/api';

/**
 * Story 4-10 (AC7): minimum visible duration of the loading spinner.
 * When the first event / WS error / stopped-team replay lands before this
 * floor, the flip to `loadingProcess$.next(false)` is deferred so users
 * never see a sub-perception flash of the spinner before the UI transitions.
 */
const SPINNER_MIN_VISIBLE_MS = 500;

/** V2 message types that feed the agent graph and message list. */
const GRAPH_RELEVANT_MODELS = [
  'StartMessage',
  'SentMessage',
  'StopMessage',
  'ErrorMessage',
  'UserMessage',
  'ResultMessage',
];

@Injectable()
export class ActorMessageService {
  apiService: ApiService = inject(ApiService);
  chatService: ChatService = inject(ChatService);
  messageService: MessageService = inject(MessageService);
  private kgReducer: KGStateReducer = inject(KGStateReducer);
  private toolPresenceService: ToolPresenceService = inject(ToolPresenceService);
  /**
   * Story 6.1 (ADR-005 §Decision 1): component-scoped append-only log of
   * every WS + REST-replay message. Parallel-populated in PR 1 — consumer
   * migration lands in Stories 6.2–6.4.
   */
  private log: MessageLogService = inject(MessageLogService);

  webSocket: WebSocketSubject<any> = new WebSocketSubject({ url: '' });

  createAgentGraph$: BehaviorSubject<AkgenticMessage[] | null> =
    new BehaviorSubject<AkgenticMessage[] | null>(null);

  messages$: BehaviorSubject<AkgenticMessage[]> = new BehaviorSubject<
    AkgenticMessage[]
  >([]);
  message$: BehaviorSubject<AkgenticMessage | null> =
    new BehaviorSubject<AkgenticMessage | null>(null);

  contextDict$: { [key: string]: BehaviorSubject<any[]> } = {};
  stateDict$: { [key: string]: BehaviorSubject<any> } = {};

  knowledgeGraph$: BehaviorSubject<KnowledgeGraphData> =
    new BehaviorSubject<KnowledgeGraphData>({ nodes: [], edges: [] });
  knowledgeGraphLoading$: BehaviorSubject<boolean> =
    new BehaviorSubject<boolean>(false);

  subscribe: Subscription = new Subscription();
  paused: boolean = false;
  messages: AkgenticMessage[] = [];

  processId: string = '';

  /**
   * Story 4-10 (AC7): timestamp (ms since epoch) of the most recent
   * `loadingProcess$.next(true)` emission in `init()`. Used to compute the
   * elapsed visible duration when scheduling the flip-to-false.
   */
  private spinnerShownAt: number = 0;
  /**
   * Story 4-10 (AC7): handle of a pending `setTimeout` that will flip the
   * spinner to `false` once the 500ms floor is reached. Cleared on re-init
   * so a stale `false` can never clobber a fresh spinner cycle.
   */
  private spinnerFlipTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Story 6.1 (ADR-005 §Decision 3): raw WS inbound stream. Every WS event
   * is `next()`ed onto this Subject at the top of the `webSocket.subscribe`
   * callback so the `bufferTime(16)` batched subscriber (and the `take(1)`
   * spinner side-channel) can consume it without coupling to the per-model
   * dispatch below — which stays intact in PR 1 for parallel populate (AC8).
   */
  private readonly _wsInbound$ = new Subject<AkgenticMessage>();
  /** Frame-batched subscriber (bufferTime 16ms). Held so init()'s (a) step
   *  can dispose it deterministically before (b)-(e) run. */
  private bufferSub: Subscription | null = null;
  /** Spinner-first-event side-channel subscriber (take(1)). Held for
   *  disposal in init()'s (a) step and in ngOnDestroy. */
  private spinnerSub: Subscription | null = null;

  constructor() {
    // Wire the KG reducer's projection stream into `knowledgeGraph$`
    // (AC4, Option A). One-time bind avoids a circular DI dependency —
    // the reducer never injects back into this service.
    this.kgReducer.bind(this.knowledgeGraph$);
    // Bind the presence service to our replay + live message streams.
    // Same bind-from-outside pattern (AC6) — the presence service does
    // not `inject(ActorMessageService)`.
    this.toolPresenceService.bindTo(this);
  }

  async init(processId: string, running: boolean): Promise<void> {
    this.processId = processId;
    let messages: AkgenticMessage[] = [];

    // --- ADR-005 §Decision 6 step (a) ---------------------------------
    // Dispose prior WS + bufferTime + spinner + message$ subscriptions so a
    // stale team's pipeline cannot deliver events into the fresh cycle.
    // Load-bearing for AC5 (team-switch correctness) and AC7 (no leaks).
    this.disposePriorSubscriptions();

    // Team switch: drop any KG state / presence carried over from a prior
    // team load so replay rebuilds from zero (ADR-004 §Decision 5).
    this.kgReducer.resetForTeam();
    this.toolPresenceService.resetForTeam();

    // --- ADR-005 §Decision 6 step (b) ---------------------------------
    // Reset the log and clear the per-agent exception dicts BEFORE any
    // replay / WS wiring so process-A state cannot leak into process-B.
    this.log.reset();
    this.stateDict$ = {};
    this.contextDict$ = {};

    // Story 4-10 (AC7): cancel any pending flip from a prior `init()` call
    // (team switch / re-init) before we start a new spinner cycle, otherwise
    // a stale timer could emit `false` against the new cycle.
    if (this.spinnerFlipTimer !== null) {
      clearTimeout(this.spinnerFlipTimer);
      this.spinnerFlipTimer = null;
    }
    this.spinnerShownAt = Date.now();
    this.chatService.loadingProcess$.next(true);

    if (!running) {
      // V2: use getEvents() for stopped teams
      const eventResponses: EventResponse[] =
        await this.apiService.getEvents(processId);

      // --- ADR-005 §Decision 6 step (c) -------------------------------
      // log.appendAll runs FIRST (atomic snapshot of the full replay),
      // BEFORE per-dict seeding. Story 6.1 Task 3.2 documents this choice:
      // selectors in PR 2/3 will fold `log$`; the per-agent dicts are
      // imperative side state and are seeded by the loop below in the same
      // synchronous pass.
      const replayMessages: AkgenticMessage[] = eventResponses
        .map((er: EventResponse) => er.event as AkgenticMessage)
        .filter((evt) => !!evt && !!evt.__model__);
      this.log.appendAll(replayMessages);

      // Reconstruct stateDict$ and contextDict$ from persisted events.
      // Events arrive sorted by sequence (ascending) from the API.
      // - StateChangedMessage: later events overwrite earlier (keeps latest state per agent)
      // - LlmMessageEvent: messages appended in chronological order (ordered context)
      const latestStates: { [agentId: string]: any } = {};
      const contextArrays: { [agentId: string]: any[] } = {};

      for (const er of eventResponses) {
        const evt = er.event;
        if (!evt || !evt.__model__) continue;

        if (evt.__model__.includes('StateChangedMessage')) {
          const agentId = evt.sender?.agent_id;
          if (agentId) {
            latestStates[agentId] = evt.state;
          }
        } else if (evt.__model__.includes('EventMessage')) {
          const inner = evt.event;
          if (inner?.__model__?.includes('LlmMessageEvent')) {
            const agentId = evt.sender?.agent_id;
            if (agentId && inner.message) {
              if (!contextArrays[agentId]) contextArrays[agentId] = [];
              contextArrays[agentId].push(inner.message);
            }
          } else if (inner?.__model__?.includes('ToolStateEvent')) {
            // Story 5-2: rebuild KG state during replay through the same
            // reducer used by the live path (AC5 — live/replay parity).
            this.kgReducer.apply(inner);
          }
        }
      }

      for (const [agentId, state] of Object.entries(latestStates)) {
        this.initDict(this.stateDict$, agentId, null);
        this.stateDict$[agentId].next({ schema: {}, state });
      }

      for (const [agentId, msgs] of Object.entries(contextArrays)) {
        this.initDict(this.contextDict$, agentId, []);
        this.contextDict$[agentId].next(msgs);
      }

      // Filter graph-relevant messages for the agent graph and message list
      messages = eventResponses
        .map((er: EventResponse) => er.event as AkgenticMessage)
        .filter(
          (evt: AkgenticMessage) =>
            evt &&
            evt.__model__ &&
            GRAPH_RELEVANT_MODELS.some((m) => evt.__model__.includes(m))
        );

      // Story 4-8: seed thinking-bubble lifecycle from replayed envelopes AND
      // from replayed EventMessage (tool events) in order, so the final
      // `thinkingAgents$` state is consistent with the live path (AC10).
      for (const er of eventResponses) {
        const evt = er.event as AkgenticMessage | undefined;
        if (!evt || !evt.__model__) continue;
        if (evt.__model__.includes('EventMessage')) {
          this.dispatchToolEventToThinking(evt as any);
          continue;
        }
        this.applyThinkingLifecycle(evt);
      }
    }

    this.createAgentGraph$.next(messages);
    this.messages$.next(messages);
    this.subscribe = this.message$.subscribe((message) => {
      if (message) {
        this.messages$.next([...this.messages$.value, message]);
      }
    });

    // V2: connect directly -- no ticket needed (community tier, AC8)
    const wsProtocol =
      window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    const api = environment.api.replace(/(^\w+:|^)\/\//, '');

    // Story 4-10 (AC2): stopped-team path has already populated replay state
    // via HTTP getEvents() above — flip the spinner off BEFORE wiring up the
    // WS subscription so the user never sees `#emptyState` flash.
    if (!running) {
      this.scheduleSpinnerFlipFalse();
    }

    // Story 4-10 (AC1): running-team path keeps the spinner on until the
    // first WS event actually lands. Closure flag guards against re-emitting
    // `false` for every subsequent event. PR 1 keeps this closure alongside
    // the new `take(1)` spinner side-channel (Task 2.5) — parallel populate
    // per AC8. The second call is a no-op: scheduleSpinnerFlipFalse is
    // idempotent and the guard flag is flipped on first entry.
    let firstEventReceived = false;
    const flipOnFirstEvent = (): void => {
      if (firstEventReceived) return;
      firstEventReceived = true;
      this.scheduleSpinnerFlipFalse();
    };

    // --- ADR-005 §Decision 6 step (d) ---------------------------------
    // Wire the frame-batched subscriber AND the spinner take(1) side-channel
    // BEFORE opening the WebSocket so every first `_wsInbound$.next(...)`
    // fires against a live subscription. Load-bearing for AC3 / AC6.
    this.setupBatchedSubscriber();
    this.setupSpinnerSideChannel();

    try {
      this.webSocket = this.createWebSocket(
        `${wsProtocol}${api}/ws/${this.processId}`,
      );
    } catch (err) {
      // Story 4-10 (AC3): synchronous ctor failure must not leave the UI
      // spinning forever.
      console.error('WebSocket construction failed:', err);
      this.scheduleSpinnerFlipFalse();
      throw err;
    }

    this.webSocket.subscribe({
      next: (data: any) => {
        // Story 4-10 (AC1): first event over the wire ends the loading
        // window. Runs for EVERY event shape (including ones we ignore
        // below) — receiving bytes is proof the replay stream has started.
        flipOnFirstEvent();

        // V2: data is a raw Message with __model__ discriminator
        const event = data;
        if (!event || !event.__model__) return;

        // Story 6.1 (Task 2.6 / AC8): feed the unified log via the frame
        // batched subscriber. Inserted BEFORE the per-__model__ dispatch so
        // every inbound message reaches the log while the existing closures
        // below continue to emit on the parallel-populated streams.
        this._wsInbound$.next(event as AkgenticMessage);

        if (event.__model__.includes('StateChangedMessage')) {
          // Story 6.1 (AC8 fix): stateDict$ is updated by the batched
          // subscriber only (`applyStateChanged`). The inline write was
          // removed to prevent double-emission to agent-tabs consumers
          // (which would otherwise re-render twice per state change and,
          // for context, surface duplicated messages — see
          // `agent-tabs.component.ts:67-87`). The batched path remains the
          // single source of truth for dict updates as Story 6.4's
          // selector migration lands.
        } else if (event.__model__.includes('EventMessage')) {
          this.handleEventMessage(event);
        } else if (event.__model__.includes('ErrorMessage')) {
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: event.exception_value,
            life: 5000,
          });
          this.message$.next(event);
        } else {
          // Story 4-8: observe raw envelopes for thinking-bubble lifecycle.
          // Guarded with try/catch so a malformed envelope can never tear
          // down the WS subscription (which would silently break the graph
          // red border and all subsequent events).
          try {
            this.applyThinkingLifecycle(event as AkgenticMessage);
          } catch (err) {
            console.error('applyThinkingLifecycle failed:', err, event);
          }
          // All other messages: forward to message$ for graph + message list
          if (this.paused) {
            this.messages.push(event);
            return;
          }
          this.message$.next(event);
        }
      },
      error: (err: any) => {
        // Story 4-10 (AC3): failure before any event landed must not leave
        // the UI spinning forever — flip the flag so the chat panel falls
        // through to `#emptyState` (or the subsequent error affordance)
        // instead of showing the "Loading process..." placeholder for ever.
        flipOnFirstEvent();
        console.error('WebSocket error:', err);
        this.messageService.add({
          severity: 'error',
          summary: 'Connection Error',
          detail: 'WebSocket connection failed. Real-time updates unavailable.',
          life: 5000,
        });
      },
      complete: () => console.log('webSocket - complete'),
    });
  }

  /**
   * Story 4-10: indirection point for WebSocket construction so tests can
   * inject a fake Subject without trying to rewrite the rxjs module
   * namespace (which is frozen under ES modules).
   */
  protected createWebSocket(url: string): WebSocketSubject<any> {
    return webSocket(url);
  }

  /**
   * Story 6.1 (ADR-005 §Decision 6 step (a)): dispose every subscription
   * owned by a previous `init()` cycle in one place. Called from `init()`
   * BEFORE any new state is wired so a stale WS / bufferTime / message$
   * subscription cannot bleed into the fresh team.
   */
  private disposePriorSubscriptions(): void {
    try {
      this.webSocket.unsubscribe();
    } catch {
      /* first-init path: no prior webSocket — ignore */
    }
    this.subscribe.unsubscribe();
    this.subscribe = new Subscription();
    if (this.bufferSub) {
      this.bufferSub.unsubscribe();
      this.bufferSub = null;
    }
    if (this.spinnerSub) {
      this.spinnerSub.unsubscribe();
      this.spinnerSub = null;
    }
  }

  /**
   * Story 6.1 (ADR-005 §Decision 3 + §Decision 5): frame-batched consumer
   * of the raw WS inbound stream. `bufferTime(16)` coalesces every message
   * that lands in a single 16ms window into one `log.appendAll` call and
   * one `log$` emission (AC3). Per-agent exception-dict updates
   * (`stateDict$`, `contextDict$`) run in the SAME synchronous pass inside
   * the subscriber callback (AC4).
   */
  private setupBatchedSubscriber(): void {
    this.bufferSub = this._wsInbound$
      .pipe(
        bufferTime(16),
        filter((batch: AkgenticMessage[]) => batch.length > 0),
      )
      .subscribe((batch: AkgenticMessage[]) => {
        this.log.appendAll(batch);
        for (const msg of batch) {
          if (!msg.__model__) continue;
          if (msg.__model__.includes('StateChangedMessage')) {
            this.applyStateChanged(msg as any);
          } else if (msg.__model__.includes('EventMessage')) {
            this.applyEventMessageDicts(msg as any);
          }
        }
      });
  }

  /**
   * Story 6.1 (ADR-005 §Decision 8): spinner first-event flip. `take(1)` on
   * the raw `_wsInbound$` fires once per `init()` cycle and is independent
   * of the batched subscriber (so a tight batch does not delay the flip).
   * `take(1)` (not `first()`) is used so an immediately-completed stream
   * (e.g. unmount before any WS event) doesn't throw `EmptyError`.
   */
  private setupSpinnerSideChannel(): void {
    this.spinnerSub = this._wsInbound$
      .pipe(take(1))
      .subscribe(() => this.scheduleSpinnerFlipFalse());
  }

  /**
   * Story 6.1 (Task 2.4): apply a `StateChangedMessage` to `stateDict$`.
   * Extracted from the bufferSub callback to keep the subscribe body <10
   * LoC (CLAUDE.md ~50-line ceiling).
   */
  private applyStateChanged(event: any): void {
    const agentId = event?.sender?.agent_id;
    if (!agentId) return;
    this.initDict(this.stateDict$, agentId, null);
    this.stateDict$[agentId].next({ schema: {}, state: event.state });
  }

  /**
   * Story 6.1 (Task 2.4): apply an `EventMessage` carrying an
   * `LlmMessageEvent` / `ToolStateEvent` to the exception dicts and to the
   * KG reducer. Preserves the live-path semantics of the existing
   * `handleEventMessage` dispatch (AC8 parallel populate: the batched
   * subscriber and the per-message dispatch both run — the batched version
   * is the new source of truth from Story 6.4 onward).
   */
  private applyEventMessageDicts(event: any): void {
    const inner = event?.event;
    if (!inner?.__model__) return;
    if (inner.__model__.includes('LlmMessageEvent')) {
      const agentId = event.sender?.agent_id;
      if (agentId && inner.message) {
        this.initDict(this.contextDict$, agentId, []);
        const current = this.contextDict$[agentId].getValue();
        this.contextDict$[agentId].next([...current, inner.message]);
      }
    } else if (inner.__model__.includes('ToolStateEvent')) {
      this.kgReducer.apply(inner);
    }
  }

  /**
   * Story 4-10 (AC7): flip `loadingProcess$` to `false`, but respect the
   * `SPINNER_MIN_VISIBLE_MS` floor measured from the spinner-on emission
   * time. If the floor has already been reached, flip immediately; otherwise
   * defer via `setTimeout` so the user always sees the spinner for at least
   * half a second.
   *
   * Called from THREE sites (all share the same floor semantics):
   *   - WS first-event path (running=true)
   *   - WS error path (failure-safety)
   *   - stopped-team path (after HTTP replay seeds state)
   *   - synchronous `createWebSocket` throw (failure-safety)
   */
  private scheduleSpinnerFlipFalse(): void {
    // Story 6.1 idempotency: PR 1 keeps both the legacy `flipOnFirstEvent`
    // closure AND the new `take(1)` side-channel (Task 2.5 parallel
    // populate). Both fire on the first WS event, so this method is called
    // twice. Skip the second call if the spinner is already false AND no
    // deferred flip is pending — otherwise the subscriber would see an
    // extra redundant `false` emission, breaking Story 4-10 AC1's "subsequent
    // events do not re-emit false" test.
    if (
      this.chatService.loadingProcess$.value === false &&
      this.spinnerFlipTimer === null
    ) {
      return;
    }
    const elapsed = Date.now() - this.spinnerShownAt;
    if (elapsed >= SPINNER_MIN_VISIBLE_MS) {
      this.chatService.loadingProcess$.next(false);
      return;
    }
    // Clear any pending timer (should normally be null here because the
    // single-shot guard in `flipOnFirstEvent()` prevents double-scheduling,
    // but the stopped-team path and failure paths do not use that guard).
    if (this.spinnerFlipTimer !== null) {
      clearTimeout(this.spinnerFlipTimer);
    }
    this.spinnerFlipTimer = setTimeout(() => {
      this.spinnerFlipTimer = null;
      this.chatService.loadingProcess$.next(false);
    }, SPINNER_MIN_VISIBLE_MS - elapsed);
  }

  /**
   * Handle V2 EventMessage: delegates to LlmMessageEvent or ToolCallEvent handlers.
   */
  private handleEventMessage(event: any): void {
    // Story 6.1 (AC8 fix): contextDict$ and kgReducer.apply() are now driven
    // by the batched subscriber's `applyEventMessageDicts` helper exclusively.
    // The inline writes were removed to prevent:
    //   - Duplicated entries in `contextDict$[agentId]` (consumer:
    //     `agent-tabs.component.ts` would render every LLM message twice).
    //   - Double `kgReducer.apply()` per ToolStateEvent (the reducer is NOT
    //     idempotent on `seq` — second call logs "seq gap" warnings AND
    //     emits a duplicate `knowledgeGraph$` projection, breaking AC8 for
    //     the KG panel rewired in Story 5-3).
    // Story 4-8: route tool events into ChatService for the thinking bubble.
    // Thinking-bubble dispatch is NOT a duplicate concern — the batched
    // subscriber does not touch the chat thinking lifecycle.
    this.dispatchToolEventToThinking(event);
  }

  /**
   * Story 4-8: Convert an EventMessage carrying a ToolCallEvent or
   * ToolReturnEvent into ChatService.appendToolCall / markToolDone. Unknown
   * inner __model__ values are silently ignored (no regression — matches
   * existing behaviour).
   */
  private dispatchToolEventToThinking(event: any): void {
    const inner = event?.event;
    const agentId = event?.sender?.agent_id;
    if (!inner || !agentId) return;
    if (inner.__model__?.includes('ToolCallEvent')) {
      this.chatService.appendToolCall(agentId, {
        tool_call_id: inner.tool_call_id,
        tool_name: inner.tool_name,
        arguments_preview: buildPreview(inner.arguments, 60),
        done: false,
      });
    } else if (inner.__model__?.includes('ToolReturnEvent')) {
      this.chatService.markToolDone(agentId, inner.tool_call_id);
    }
  }

  /**
   * Story 4-8 (AC3): Single dispatch point for thinking-bubble lifecycle.
   * Called from BOTH the live WebSocket branch and the replay-seeding loop
   * so live-vs-replay parity (AC10) is guaranteed by construction.
   */
  private applyThinkingLifecycle(msg: AkgenticMessage): void {
    if (isReceivedMessage(msg)) {
      // Python `ReceivedMessage` is a lightweight telemetry envelope — it
      // carries only `message_id` (UUID of the inner message being
      // received), NOT the full inner `BaseMessage`. Using `msg.message.id`
      // here previously threw `TypeError: Cannot read properties of
      // undefined (reading 'id')`, which tore down the WS subscription and
      // silently killed downstream consumers (graph red border, thinking
      // bubbles, every subsequent event).
      //
      // Human-role agents (HumanProxy) never "think" — they wait for user
      // input. Skip the bubble entirely; the user's own reply path drives
      // the UI, not a simulated thinking state.
      if (msg.sender.role === 'Human') return;
      this.chatService.beginThinking({
        agent_id: msg.sender.agent_id,
        agent_name: msg.sender.name,
        start_time: new Date(msg.timestamp),
        anchor_message_id: msg.message_id,
      });
      return;
    }
    if (isSentMessage(msg) && msg.sender.role !== 'ActorSystem') {
      this.chatService.finaliseOrDiscard(msg.sender.agent_id);
    }
  }

  backwardClicked() {
    this.messages = [...this.messages$.value, ...this.messages];
    this.messages$.next([]);
    this.createAgentGraph$.next(null);
  }

  backClicked() {
    const currentMessages = this.messages$.value;
    if (currentMessages.length > 0) {
      const lastMessage = currentMessages[currentMessages.length - 1];
      this.messages.unshift(lastMessage);
      this.messages$.next(currentMessages.slice(0, -1));
      this.createAgentGraph$.next(null);
      this.createAgentGraph$.next(this.messages$.value);
    }
  }

  pauseClicked() {
    this.paused = true;
  }

  playClicked() {
    this.paused = false;
    this.forwardClicked();
  }

  nextClicked() {
    const msg = this.messages.shift();
    if (msg) {
      this.message$.next(msg);
    }
  }

  forwardClicked() {
    while (this.messages.length > 0) {
      this.nextClicked();
    }
  }

  controlStatus() {
    return [
      this.messages$.value.length + this.messages.length,
      this.messages$.value.length,
    ];
  }

  initDict(
    dict: { [key: string]: BehaviorSubject<any[]> },
    key: string,
    defaultValue: any
  ) {
    if (dict[key]) return;
    dict[key] = new BehaviorSubject<any>(defaultValue);
  }

  ngOnDestroy() {
    this.subscribe.unsubscribe();
    try {
      this.webSocket.unsubscribe();
    } catch {
      /* never-opened WS — ignore */
    }
    // Story 6.1 (Task 4.1 / AC7): dispose the bufferTime + spinner
    // subscriptions and complete the inbound Subject so no leaked listener
    // survives the component teardown. Manual unsubscribe (not
    // takeUntilDestroyed) is chosen for symmetry with `init()`'s (a) step,
    // which must dispose these same subscriptions on re-init WITHOUT
    // tearing the service down.
    this.bufferSub?.unsubscribe();
    this.spinnerSub?.unsubscribe();
    this._wsInbound$.complete();
    if (this.spinnerFlipTimer !== null) {
      clearTimeout(this.spinnerFlipTimer);
      this.spinnerFlipTimer = null;
    }
  }
}
