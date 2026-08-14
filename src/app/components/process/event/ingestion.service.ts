import { inject, Injectable } from '@angular/core';

import { BehaviorSubject, Subject, Subscription } from 'rxjs';
import { bufferTime, filter } from 'rxjs/operators';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { ConfigService } from '../../../core/config/config.service';
import {
  AkgenticMessage,
  CommandDescriptor,
} from '../../../protocol/message.types';

import { ConnectionToast } from './connection-toast';
import { LoadingIndicator } from './loading-indicator';
import { MessageLogService } from './message-log.service';
import { NotificationToasts } from './notification-toasts';
import { PerAgentStore } from './per-agent-store';
import {
  AgentStateValue,
  AgentTokenUsage,
  SystemPromptValue,
} from './per-agent-specs';
import { ProcessStores } from './process-stores';
import { ReplaySeeder } from './replay-seeder';
import { MessageService } from 'primeng/api';

/**
 * `IngestionService` — minimal ingestion surface (post Story 6.4 / Epic 17):
 *   - REST init replay is owned by `ReplaySeeder` (`replay-seeder.ts`, Epic 34 /
 *     ADR-025 §1), which OWNS both REST calls and the `synthesizeStateChanged`
 *     shaping; `init()` keeps the two `log.appendAll` calls that fold its output
 *     into `MessageLogService.log$`, because they are sequenced steps here. The
 *     registry folds that replay tail exactly as it folds live WS frames.
 *   - WS `bufferTime(16)` ingestion appends to the log; the registry derives
 *     per-agent `state` / `context` from `log$` (O(Δ), automatic replay/reset).
 *   - Spinner floor (`loadingProcess$`, AC7) is owned by `LoadingIndicator`
 *     (`loading-indicator.ts`, Epic 34 / ADR-025 §1); `init()` drives it at four
 *     call sites and re-exports its subject unchanged. The only wall-clock read
 *     and the only timer in the ingestion layer now live there, not here.
 *   - The WS-disconnect toast is owned by `ConnectionToast`
 *     (`connection-toast.ts`, Epic 34 / ADR-025 §1), which holds the payload,
 *     the dedup flag and the teardown suppression. This class keeps only the
 *     three sequencing calls (`start()` in `init()`, `show()` from the two WS
 *     callbacks, `stop()` first in `ngOnDestroy()`).
 *   - The notification-family toast surface (stories 31-3 / 31-4 / 31-5 / 31-6)
 *     is owned by `NotificationToasts` (`notification-toasts.ts`, Epic 34 /
 *     ADR-025 §1): severity dispatch, the summary, the payload, the closed-ids
 *     suppressor and the after-the-fact removal. This class keeps only the two
 *     sequencing calls, and hands `start()` the RAW `_wsInbound$` — never
 *     `log$` or anything downstream of `bufferTime(16)`, which would erase both
 *     the 16 ms cache lag and the stopped-REST-silent / running-WS-toasting
 *     replay asymmetry. Both are current behaviour; changing either is
 *     ADR-025 Open Question 1, not a refactor.
 *
 *     Do NOT re-add a local disconnect toast here. It sat next to
 *     `showNotificationToast` with the OPPOSITE `closable` semantics, and the
 *     adjacency alone had already produced one copy-paste defect; the whole
 *     point of the move is that the two can no longer be read as variants of
 *     each other. `messageService.clear()` stays here, though — it empties the
 *     entire keyless toast container, notification toasts included, so it is
 *     lifecycle sequencing rather than either toast's business.
 *
 * Per-agent state (Epic 17 / ADR-014, re-homed by Epic 34 / ADR-025 §1):
 * `state`, `context`, `commands`, `systemPrompt` and `tokenUsage` are ALL
 * `PerAgentStore` instances owned by the component-scoped
 * `PerAgentStoreRegistry` (single `log$` subscription, replay + reset for free).
 * They are DECLARED by `ProcessStores` (`process-stores.ts`) and merely
 * re-exported here, so this service no longer injects the registry and holds no
 * `register()` call of its own; adding a new per-agent event is a single
 * `register({...})` line in `ProcessStores`. The five properties below keep
 * their names, types and semantics — consumers are unaffected by the move.
 */
@Injectable()
export class IngestionService {
  messageService: MessageService = inject(MessageService);
  private config: ConfigService = inject(ConfigService);

  /**
   * Story 6.1 (ADR-005 §Decision 1): component-scoped append-only log of
   * every WS + REST-replay message. Story 6.2 migrated KG presence + KG
   * projection to pure selectors (`ToolPresenceService.hasKnowledgeGraph$`,
   * `KGStateReducer.knowledgeGraph$`) — both fold the same log, so the
   * message service no longer injects either of them.
   */
  private log: MessageLogService = inject(MessageLogService);

  /**
   * Epic 34 (ADR-025 §1): the projection unit that DECLARES the five per-agent
   * stores. The five `readonly` fields below are aliases onto its instances —
   * same objects, not copies — so `ingestion.state` and `processStores.state`
   * are one store, folded once. Declared ABOVE those aliases: TypeScript
   * initialises class fields in declaration order, so an alias declared first
   * would read `undefined`.
   */
  private readonly stores: ProcessStores = inject(ProcessStores);

  /**
   * Epic 34 (ADR-025 §1): the REST replay source. It performs both stopped-team
   * REST calls and returns `AkgenticMessage[]`; the `appendAll` of what it
   * returns stays in `init()` below, where the ordering is sequenced and
   * visible.
   */
  private readonly replay: ReplaySeeder = inject(ReplaySeeder);

  /**
   * Epic 34 (ADR-025 §0-§1): the spinner-floor reactor. Declared ABOVE the
   * `loadingProcess$` alias below for the same reason as `stores`: TypeScript
   * initialises class fields in declaration order, so an alias declared first
   * would read `undefined`.
   */
  private readonly loading: LoadingIndicator = inject(LoadingIndicator);

  /**
   * Epic 34 (ADR-025 §0-§1): the disconnect-toast reactor. Push-driven — this
   * class calls `show()` from the two WS callbacks; the unit subscribes to
   * nothing of its own.
   */
  private readonly connectionToast: ConnectionToast = inject(ConnectionToast);

  /**
   * Epic 34 (ADR-025 §0-§1): the notification-toast reactor. Subscription-driven
   * but never self-wired — it opens nothing until `start()` hands it the two
   * streams, and `init()` sequences that AFTER `setupBatchedSubscriber()` so the
   * log feed is registered first.
   */
  private readonly notificationToasts: NotificationToasts =
    inject(NotificationToasts);

  /**
   * Story 4-10 (AC7) / Epic 18 (ADR-015 §2): the loading-spinner state, read by
   * `ChatPanelComponent` from here. An alias onto `LoadingIndicator`'s subject —
   * the same object, not a copy, and never a `.pipe(...)` derivative: the type
   * stays `BehaviorSubject<boolean>` because `.value` is part of the surface,
   * and the reference must survive every cycle because the chat panel captures
   * it once in a field initializer and binds it with `| async` for its whole
   * life.
   */
  readonly loadingProcess$: BehaviorSubject<boolean> =
    this.loading.loadingProcess$;

  webSocket: WebSocketSubject<any> = new WebSocketSubject({ url: '' });

  // Epic 34 (ADR-025 §1): the five per-agent stores, re-exported from
  // `ProcessStores`. Aliases, never re-registrations — `register()` pushes a
  // NEW bucket and returns a NEW store per call, so a second call here would
  // give the app two independent maps folding the same log, each correct in
  // isolation and therefore invisible to every existing spec. The rationale
  // for each store's keying and reducer lives with its declaration in
  // `process-stores.ts`.

  /** Per-agent latest `{ schema, state }`. Declared by `ProcessStores.state`. */
  readonly state: PerAgentStore<AgentStateValue> = this.stores.state;

  /** Per-agent ordered conversation array. Declared by `ProcessStores.context`. */
  readonly context: PerAgentStore<unknown[]> = this.stores.context;

  /** Per-agent slash commands. Declared by `ProcessStores.commands`. */
  readonly commands: PerAgentStore<CommandDescriptor[]> = this.stores.commands;

  /** Per-agent system-prompt head block. Declared by `ProcessStores.systemPrompt`. */
  readonly systemPrompt: PerAgentStore<SystemPromptValue> =
    this.stores.systemPrompt;

  /** Per-agent token usage. Declared by `ProcessStores.tokenUsage`. */
  readonly tokenUsage: PerAgentStore<AgentTokenUsage> = this.stores.tokenUsage;

  processId: string = '';

  /**
   * Story 6.1 (ADR-005 §Decision 3): raw WS inbound stream. Every WS event
   * is `next()`ed onto this Subject at the top of the `webSocket.subscribe`
   * callback so the `bufferTime(16)` batched subscriber (and the spinner
   * side-channel `LoadingIndicator` opens on it) can consume it without coupling
   * to the per-model dispatch below — which stays intact in PR 1 for parallel
   * populate (AC8).
   */
  private readonly _wsInbound$ = new Subject<AkgenticMessage>();
  /** Frame-batched subscriber (bufferTime 16ms). Held so init()'s (a) step
   *  can dispose it deterministically before (b)-(e) run. */
  private bufferSub: Subscription | null = null;

  async init(processId: string, running: boolean): Promise<void> {
    this.processId = processId;

    // --- ADR-005 §Decision 6 step (a) ---------------------------------
    // Dispose prior WS + bufferTime + spinner subscriptions so a stale
    // team's pipeline cannot deliver events into the fresh cycle.
    // Load-bearing for AC5 (team-switch correctness) and AC7 (no leaks).
    this.disposePriorSubscriptions();

    // Story 6.2 (ADR-005 §Decision 4): KG state + KG presence are now pure
    // selectors over `log$`. `this.log.reset()` below causes both selectors
    // to re-emit their empty-log derivatives automatically — no explicit
    // `resetForTeam()` calls required.

    // --- ADR-005 §Decision 6 step (b) ---------------------------------
    // Reset the log BEFORE any replay / WS wiring so process-A state cannot
    // leak into process-B. Epic 17 (ADR-014 §Decision 3): the `state` /
    // `context` / `commands` registry detects this log shrink, clears its maps,
    // and rewinds its cursor automatically — no bespoke per-store reset needed.
    this.log.reset();

    // Story 8-2: clear any stale toasts from a prior init() cycle
    // so process-A's warnings do not persist into process-B.
    this.messageService.clear();
    // Epic 34 (ADR-025 §1): re-arm the disconnect toast for this cycle. Same
    // position the inline flag reset held — after the toast clear, before the
    // spinner cycle — so a prior team's disconnect cannot suppress this one's.
    this.connectionToast.start();

    // Story 4-10 (AC7): start the spinner cycle — `LoadingIndicator` cancels any
    // pending flip from a prior `init()` (team switch / re-init), resets its
    // first-event latch, stamps `t0` and emits `true`. This call belongs HERE,
    // BEFORE the `!running` REST replay below: moving it after the await would
    // measure the 500ms floor from the end of a network round-trip, and would
    // put the stopped-team flip ahead of the `true` it is supposed to follow.
    this.loading.beginCycle();

    if (!running) {
      // Story 25-1 (ADR-020 §2, !running gate): seed the per-agent `state`
      // store from the dedicated snapshot endpoint for STOPPED teams ONLY. A
      // stopped team has no live WS, and its durable event log carries no
      // `StateChangedMessage` (ADR-013), so without this seed the backstory
      // head-block (`state.forAgent(uuid)`) stays blank on load. A running team
      // (including a freshly restored one, team Story 23-3) already receives its
      // `StateChangedMessage`(s) on the cursor-0 WS replay, so the REST seed is
      // redundant there and `getAgentStates` MUST NOT be called for it. The gate
      // lives HERE and never inside the seeder, which knows no team status.
      const seeds: AkgenticMessage[] = await this.replay.seedMessages(processId);
      this.log.appendAll(seeds);

      // V2: use getEvents() for stopped teams.
      //
      // --- ADR-005 §Decision 6 step (c) -------------------------------
      // log.appendAll is the ONLY replay seeding now. Epic 17 (ADR-014
      // §Decision 3): the registry folds this replay tail exactly as it folds
      // live WS frames, so `state` / `context` / `commands` are reconstructed
      // for free — replay is just another `log$` tail. The bespoke
      // `latestStates` / `contextArrays` / `commandsByAgent` reconstruction
      // loops are deleted (Story 17-2 / 17-3).
      //
      // TWO sequential awaits and TWO appends, never `Promise.all` and never
      // one merged array: the state seed must be folded BEFORE the event
      // replay, since `stateSpec` is latest-wins and a real replayed
      // `StateChangedMessage` has to be able to overwrite a synthesized seed
      // (never the reverse). Parallelising would also change failure
      // semantics — a `getAgentStates` rejection today means `getEvents` is
      // never issued and `init()` rejects before the socket opens.
      const replayMessages: AkgenticMessage[] =
        await this.replay.replayMessages(processId);
      this.log.appendAll(replayMessages);

      // Story 6.4 (AC1): `GRAPH_RELEVANT_MODELS` filtering and the
      // `createAgentGraph$` / `messages$` emits below are deleted along with
      // the streams themselves. The agent graph + message list now consume
      // log-derived selectors (`GraphDataService.graph$`, Story 6.3;
      // `MessageLogService.messageList$`, Story 6.4).
      // Story 6.3 (AC9, FR7): thinking-bubble lifecycle is reconstructed by
      // `chatFold` over `log$` (seeded above by `log.appendAll`). The prior
      // imperative replay loop has been deleted.
    }

    // V2: connect directly -- no ticket needed (community tier, AC8)
    const wsProtocol =
      window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    const api = this.config.api.replace(/(^\w+:|^)\/\//, '');

    // Story 4-10 (AC2): stopped-team path has already populated replay state
    // via HTTP getEvents() above — flip the spinner off BEFORE wiring up the
    // WS subscription so the user never sees `#emptyState` flash.
    // Site 3 of the four floor call sites: direct, NOT through the latch. It
    // happens at most once per cycle by construction, and consuming the shared
    // latch here would leave a later live frame finding it already spent.
    if (!running) {
      this.loading.scheduleSpinnerFlipFalse();
    }

    // --- ADR-005 §Decision 6 step (d) ---------------------------------
    // Wire the frame-batched subscriber AND the spinner side-channel BEFORE
    // opening the WebSocket so every first `_wsInbound$.next(...)` fires
    // against a live subscription. Load-bearing for AC3 / AC6. This is the
    // SECOND cycle point and sits AFTER the replay await — separate from
    // `beginCycle()` above by design; collapsing the two into one call would
    // move `t0` past the network round-trip.
    this.setupBatchedSubscriber();
    this.loading.watchFirstEvent(this._wsInbound$);
    // Epic 34 (ADR-025 §1): the notification-toast reactor, wired AFTER the log
    // feed above and BEFORE the socket below. Both orderings are load-bearing:
    // the batched subscriber must be registered first so "the frame reaches the
    // log feed, then the toast fires" survives the move, and both must be live
    // before the socket opens (ADR-005 §Decision 6).
    //
    // It is handed the RAW `_wsInbound$` — a plain Subject with one producer,
    // fanning out synchronously at the same instant the old inline dispatch ran.
    // `bufferTime(16)` sits on the log-feed subscriber, not on the subject, so
    // this is equivalent to the inline call rather than a move downstream of the
    // batching. Handing it `log$` instead would silently delete the 16 ms cache
    // lag AND the replay asymmetry — a behaviour change, not a tidy.
    this.notificationToasts.start(
      this._wsInbound$.asObservable(),
      this.log.closedNotificationIds$,
    );

    try {
      this.webSocket = this.createWebSocket(
        `${wsProtocol}${api}/ws/${this.processId}`,
      );
    } catch (err) {
      // Story 4-10 (AC3): synchronous ctor failure must not leave the UI
      // spinning forever.
      // Site 4: direct, NOT through the latch — same reason as site 3.
      console.error('WebSocket construction failed:', err);
      this.loading.scheduleSpinnerFlipFalse();
      throw err;
    }

    this.webSocket.subscribe({
      next: (data: any) => {
        // Story 4-10 (AC1): first event over the wire ends the loading
        // window (site 1, via the latch). Runs for EVERY event shape
        // (including ones we ignore below) — receiving bytes is proof the
        // replay stream has started, so this stays the FIRST statement here,
        // ahead of the `__model__` guard.
        this.loading.flipOnFirstEvent();

        // V2: data is a raw Message with __model__ discriminator
        const event = data;
        if (!event || !event.__model__) return;

        // Story 6.1 (Task 2.6 / AC8): feed the unified log via the frame
        // batched subscriber. The batched path is now the SOLE producer of
        // dict updates and log emissions (Story 6.4 retired the parallel
        // per-__model__ dispatch).
        this._wsInbound$.next(event as AkgenticMessage);

        // Epic 34 (ADR-025 §1): the notification-toast dispatch that used to sit
        // HERE is now a subscriber of `_wsInbound$` above (`NotificationToasts`).
        // The `__model__` guard is what makes the two equivalent — it runs before
        // the `next(...)`, so the reactor sees exactly the frames the inline call
        // saw. Do NOT re-add a dispatch here.
        // Story 6.4 (AC1): every other branch (StateChangedMessage,
        // EventMessage, fallthrough) is now pure log-feed via
        // `_wsInbound$.next(...)` above. The per-__model__ dispatch + VCR
        // `paused` early-return have been deleted.
      },
      error: (err: any) => {
        // Story 4-10 (AC3): failure before any event landed must not leave
        // the UI spinning forever — flip the flag so the chat panel falls
        // through to `#emptyState` (or the subsequent error affordance)
        // instead of showing the "Loading process..." placeholder for ever.
        this.loading.flipOnFirstEvent();
        console.error('WebSocket error:', err);
        // Story 8-2 (AC1, AC5): persistent warning toast replaces the
        // transient 5-second error toast. flipOnFirstEvent() is preserved above.
        this.connectionToast.show();
      },
      complete: () => {
        console.log('webSocket - complete');
        // Story 8-2 (AC2): persistent warning on stream completion. The dedup
        // flag inside the unit is what makes error-then-complete one toast.
        this.connectionToast.show();
      },
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
   * BEFORE any new state is wired so a stale WS / bufferTime subscription
   * cannot bleed into the fresh team.
   */
  private disposePriorSubscriptions(): void {
    try {
      this.webSocket.unsubscribe();
    } catch {
      /* first-init path: no prior webSocket — ignore */
    }
    if (this.bufferSub) {
      this.bufferSub.unsubscribe();
      this.bufferSub = null;
    }
    // Epic 34 (ADR-025 §3): `LoadingIndicator` disposes its OWN side-channel
    // and pending timer. Per-cycle, not destroy-scoped — `init()` runs again on
    // every team switch within one component lifetime.
    this.loading.stop();
    // Epic 34 (ADR-025 §1-§2): same story for the notification-toast reactor —
    // its two subscriptions are per-cycle, and `stop()` also clears its
    // dismissal cache so the fresh cycle re-derives closures from an empty
    // baseline (exactly what `log.reset()`'s empty emission did for the old
    // service-lifetime subscription). Drop this call and `start()` below leaves a
    // SECOND live subscription on `_wsInbound$`, doubling every toast.
    this.notificationToasts.stop();
  }

  /**
   * Story 6.1 (ADR-005 §Decision 3 + §Decision 5): frame-batched consumer
   * of the raw WS inbound stream. `bufferTime(16)` coalesces every message
   * that lands in a single 16ms window into one `log.appendAll` call and
   * one `log$` emission (AC3). Epic 17 (ADR-014): `state` / `context` /
   * `commands` are all folded off `log$` by the registry, so there is no
   * remaining per-message dispatch — the batched subscriber only feeds the log.
   */
  private setupBatchedSubscriber(): void {
    this.bufferSub = this._wsInbound$
      .pipe(
        bufferTime(16),
        filter((batch: AkgenticMessage[]) => batch.length > 0),
      )
      .subscribe((batch: AkgenticMessage[]) => {
        this.log.appendAll(batch);
      });
  }

  ngOnDestroy() {
    // FIRST, and load-bearing: `webSocket.unsubscribe()` below closes the
    // socket, whose `complete` callback calls `connectionToast.show()`. Moving
    // this line after it raises a "Connection Lost" toast on every intentional
    // navigation. The two statements now live in different files, which makes
    // the ordering easier to break and is why a spec pins it.
    this.connectionToast.stop();

    // Story 8-2 (AC4): clear all toasts so navigating away removes warnings and
    // a fresh process view starts clean. Stays HERE rather than moving into
    // either toast unit: `clear()` empties the whole keyless container.
    this.messageService.clear();

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
    this.loading.stop();
    // Epic 34 (ADR-025 §1-§2): the notification-toast reactor owns the closed-ids
    // subscription now, and disposes it here exactly as `init()`'s (a) step does
    // per cycle. Before the move this was a service-lifetime subscription opened
    // in a field initializer; it is per-cycle now, which is equivalent only
    // because `stop()` also clears the dismissal cache.
    this.notificationToasts.stop();
    this._wsInbound$.complete();
    // Epic 17 (ADR-014): the `commands` store is owned by the registry; its
    // single `log$` subscription is torn down by `PerAgentStoreRegistry`'s own
    // ngOnDestroy — no per-store completion needed here. Epic 34 (ADR-025 §3):
    // the pending spinner flip is cleared by the `loading.stop()` above, which
    // owns that timer.
  }
}
