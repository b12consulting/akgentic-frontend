import { inject, Injectable } from '@angular/core';

import { BehaviorSubject, Subject, Subscription } from 'rxjs';
import { bufferTime, filter, take } from 'rxjs/operators';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { ConfigService } from '../../../core/config/config.service';
import {
  AkgenticMessage,
  CommandDescriptor,
  ErrorMessage,
  NotificationMessage,
  notificationSeverity,
  NotificationSeverity,
  WarningMessage,
} from '../../../protocol/message.types';

import { MessageLogService } from './message-log.service';
import { PerAgentStore } from './per-agent-store';
import {
  AgentStateValue,
  AgentTokenUsage,
  SystemPromptValue,
} from './per-agent-specs';
import { ProcessStores } from './process-stores';
import { ReplaySeeder } from './replay-seeder';
import { MessageService } from 'primeng/api';
import { NotificationToastService } from '../../../core/ui/notification-toast.service';

/**
 * Story 4-10 (AC7): minimum visible duration of the loading spinner.
 * When the first event / WS error / stopped-team replay lands before this
 * floor, the flip to `loadingProcess$.next(false)` is deferred so users
 * never see a sub-perception flash of the spinner before the UI transitions.
 */
const SPINNER_MIN_VISIBLE_MS = 500;

/**
 * Story 31-6 (FR19): the toast header of last resort, used only when BOTH parts
 * of `"{name} - {content_type}"` are absent — an orchestrator-sent notification
 * with a null `content_type`, or one whose sender never arrived.
 *
 * Deliberately NOT `MessageListComponent`'s `LEGEND_FALLBACK`, whose
 * `error → null` is correct there and wrong here: the Messages tab renders a
 * `p-fieldset` that can legitimately show an empty legend, whereas an empty
 * toast `summary` renders a blank header. The `'Error'` below is therefore not
 * the old hardcoded error-toast summary coming back — that one headed EVERY
 * error; this one is reached only when there is nothing else to say.
 */
const TOAST_FALLBACK: Record<NotificationSeverity, string> = {
  error: 'Error',
  warn: 'Warning',
  info: 'Notification',
};

/**
 * Role of the team orchestrator on `ActorAddress` (akgentic-team `factory.py` /
 * `restorer.py` set `BaseConfig(name="@Orchestrator", role="Orchestrator")`).
 * Matched on `role` and never on `name`: `role` is the domain field, while
 * `name` is a display label carrying a decorative `@` and is the one of the pair
 * that could plausibly be renamed.
 */
const ORCHESTRATOR_ROLE = 'Orchestrator';

/**
 * `IngestionService` — minimal ingestion surface (post Story 6.4 / Epic 17):
 *   - REST init replay is owned by `ReplaySeeder` (`replay-seeder.ts`, Epic 34 /
 *     ADR-025 §1), which OWNS both REST calls and the `synthesizeStateChanged`
 *     shaping; `init()` keeps the two `log.appendAll` calls that fold its output
 *     into `MessageLogService.log$`, because they are sequenced steps here. The
 *     registry folds that replay tail exactly as it folds live WS frames.
 *   - WS `bufferTime(16)` ingestion appends to the log; the registry derives
 *     per-agent `state` / `context` from `log$` (O(Δ), automatic replay/reset).
 *   - Spinner floor (`loadingProcess$`, AC7) — UX concern owned by ingestion.
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
   * Story 31-5: the other half of dismissal. `messageService` raises toasts;
   * this removes a single one that is already on screen — an operation PrimeNG's
   * `MessageService` does not offer. Declared here, above `closedIdsSub`,
   * because that field's initializer subscribes to a `BehaviorSubject` and so
   * fires during construction.
   */
  private notificationToast: NotificationToastService = inject(
    NotificationToastService,
  );

  /**
   * Story 4-10 (AC7) / Epic 18 (ADR-015 §2): the loading-spinner state.
   * Owned by `IngestionService` (which drives the spinner-floor timing) rather
   * than `ChatService` — the sole reader (`ChatPanelComponent`) reads it from
   * here. Initial value `false`, same as the prior `ChatService` field.
   */
  readonly loadingProcess$: BehaviorSubject<boolean> =
    new BehaviorSubject<boolean>(false);

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
   * Story 8-2 (AC3): deduplication flag — prevents stacking duplicate
   * disconnect toasts when both error and complete fire in sequence.
   */
  private wsDisconnectToastShown = false;
  /** True during ngOnDestroy — suppresses disconnect toast on intentional navigation. */
  private destroying = false;

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

  /**
   * Story 31-4 (AC #9): latest snapshot of `MessageLogService.closedNotificationIds$`,
   * cached synchronously because `showNotificationToast` runs inside the WS
   * `next` callback and cannot await an observable.
   *
   * The cache lags the wire by up to one `bufferTime(16)` window — a
   * `ClosedNotification` reaches the log only when its frame is flushed. That is
   * by design: on the live path a dismissal always precedes the next delivery of
   * that message by far more than a frame, and the replay path (where the
   * ordering genuinely bites) is story 31-5's batch computation. Do NOT close the
   * gap with a synchronous side-channel off `_wsInbound$` — that is a partial,
   * untested version of 31-5.
   *
   * Story 31-5 kept that instruction and answered the ordering the other way
   * round: see `onClosedNotificationIds` below.
   */
  private closedNotificationIds: Set<string> = new Set<string>();
  /** Subscription feeding `closedNotificationIds` and (31-5) the toast removal
   *  it now also drives. Torn down in ngOnDestroy alongside `bufferSub` /
   *  `spinnerSub`. */
  private closedIdsSub: Subscription = this.log.closedNotificationIds$.subscribe(
    (ids) => this.onClosedNotificationIds(ids),
  );

  /**
   * Story 31-5: dismissal, in the direction the 31-4 suppressor cannot cover.
   *
   * The suppressor is pre-emptive — it refuses to raise a toast for an id the
   * log already knows to be closed. That handles a `ClosedNotification` that
   * arrives FIRST. On a reload of a running team the wire delivers the opposite
   * order: history replays from cursor 0, so the `WarningMessage` (older) lands
   * before its `ClosedNotification` (newer), the toast opens, and nothing ever
   * took it down again. A warning dismissed days ago came back on every reload
   * and stayed.
   *
   * Removing the toast when the closure is folded makes the pair
   * order-independent, which is why no replay/live boundary is needed here —
   * there is none on the wire, and this design does not want one.
   *
   * Only ids that are NEW to the set trigger a removal: `closedNotificationIds$`
   * re-emits a fresh `Set` whenever the closed set changes, and re-dismissing
   * the whole set each time would be wasted work that also blunts the tests.
   */
  private onClosedNotificationIds(ids: Set<string>): void {
    const previous = this.closedNotificationIds;
    this.closedNotificationIds = ids;
    for (const id of ids) {
      if (!previous.has(id)) this.notificationToast.dismiss(id);
    }
  }

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
    this.wsDisconnectToastShown = false;

    // Story 4-10 (AC7): cancel any pending flip from a prior `init()` call
    // (team switch / re-init) before we start a new spinner cycle, otherwise
    // a stale timer could emit `false` against the new cycle.
    if (this.spinnerFlipTimer !== null) {
      clearTimeout(this.spinnerFlipTimer);
      this.spinnerFlipTimer = null;
    }
    this.spinnerShownAt = Date.now();
    this.loadingProcess$.next(true);

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
        // batched subscriber. The batched path is now the SOLE producer of
        // dict updates and log emissions (Story 6.4 retired the parallel
        // per-__model__ dispatch).
        this._wsInbound$.next(event as AkgenticMessage);

        // Story 31-6 (FR17): all three severities take ONE dispatch. The
        // separate `messageService.add({ severity: 'error', … life: 5000 })`
        // branch that used to sit here is deleted — errors are notifications
        // like any other now, which is what buys them the durable-dismissal
        // round-trip (FR18) with no wiring of their own. `null` means "not a
        // notification": no toast, and no early return either, so the frame has
        // already reached `_wsInbound$` above and still lands in the log.
        const severity = notificationSeverity(event);
        if (severity) this.showNotificationToast(event, severity);
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
        flipOnFirstEvent();
        console.error('WebSocket error:', err);
        // Story 8-2 (AC1, AC5): persistent warning toast replaces the
        // transient 5-second error toast. flipOnFirstEvent() is preserved above.
        this.showDisconnectToast();
      },
      complete: () => {
        console.log('webSocket - complete');
        // Story 8-2 (AC2): persistent warning on stream completion.
        this.showDisconnectToast();
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
    if (this.spinnerSub) {
      this.spinnerSub.unsubscribe();
      this.spinnerSub = null;
    }
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
      this.loadingProcess$.value === false &&
      this.spinnerFlipTimer === null
    ) {
      return;
    }
    const elapsed = Date.now() - this.spinnerShownAt;
    if (elapsed >= SPINNER_MIN_VISIBLE_MS) {
      this.loadingProcess$.next(false);
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
      this.loadingProcess$.next(false);
    }, SPINNER_MIN_VISIBLE_MS - elapsed);
  }

  /**
   * Story 8-2 (AC1, AC2, AC3): show a persistent, non-closable warning toast
   * when the WebSocket disconnects. The deduplication guard ensures only one
   * toast is visible even if both error and complete fire in sequence.
   */
  private showDisconnectToast(): void {
    if (this.wsDisconnectToastShown || this.destroying) return;
    this.wsDisconnectToastShown = true;
    this.messageService.add({
      severity: 'warn',
      summary: 'Connection Lost',
      detail: 'Real-time connection to the server has been lost. Updates are paused.',
      sticky: true,
      closable: false,
    });
  }

  /**
   * Story 31-6 (FR19): the toast header — `"{agent name} - {content_type}"`,
   * with either half dropped when it carries nothing.
   *
   * The name half is dropped when the sender IS the orchestrator (it raises
   * most of these, and "@Orchestrator" names nothing useful) or when no sender
   * arrived at all. The type half is dropped when `content_type` is null or
   * empty — structurally nullable upstream, and in practice always null for a
   * warning, since nothing yet gives one the "kind" an exception class name
   * gives an error.
   *
   * The `' - '` separator therefore appears ONLY between two present parts,
   * never leading or trailing; when neither survives, the per-severity
   * `TOAST_FALLBACK` heads the toast rather than a blank string.
   *
   * A pure function of its arguments (no `this` state) so it can be spec'd
   * directly, without driving a frame through the socket.
   */
  private toastSummary(
    event: ErrorMessage | WarningMessage | NotificationMessage,
    severity: NotificationSeverity,
  ): string {
    const sender = event.sender;
    const namePart =
      sender && sender.role !== ORCHESTRATOR_ROLE ? sender.name : null;
    const typePart = event.content_type || null;
    const parts = [namePart, typePart].filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join(' - ') : TOAST_FALLBACK[severity];
  }

  /**
   * Story 31-3 (FR11), widened by Story 31-6 (FR17): one permanent, closable
   * toast per member of the notification family — errors included.
   *
   * Errors reached this method by deleting the WS handler's separate
   * `life: 5000` branch, which is the whole of FR18: `data.messageId` and
   * `AppComponent.onToastClose` are type-agnostic, so an error dismissal
   * round-trips and survives a reload with no error-specific code anywhere in
   * the chain. Do not add any. The accepted cost is that error toasts no longer
   * auto-dismiss — if the resulting pile ever needs relief the answer is a
   * "dismiss all" affordance, never a `life` value, which silently defeats
   * `sticky: true`.
   *
   * `severity` is a PARAMETER, not recomputed here. It used to be
   * `isWarningMessage(event) ? 'warn' : 'info'`, correct only while the caller
   * excluded errors: once errors were admitted that expression sent every one
   * of them to `'info'` — a red error rendered as a blue info toast, with
   * nothing failing. The caller now classifies once through the shared
   * `notificationSeverity` and passes the answer down.
   *
   * Three properties are deliberately ABSENT, and each omission is
   * load-bearing — do not "complete" this object:
   *
   *   - **no `key`** — `app.component.html` mounts a single keyless
   *     `<p-toast>`, and PrimeNG admits a message only when the mount's key
   *     equals the message's (`Toast.canAdd`). A keyed message is silently
   *     dropped and never renders. Per-event identity travels in `data`
   *     instead; `Toast.add()` appends, so keyless messages already coexist
   *     rather than clobbering one another. Story 31-5 re-tested this before
   *     building removal on top of it and reached the same conclusion: a key
   *     here would buy nothing anyway, since `MessageService.clear(key)` empties
   *     a whole container rather than one message.
   *   - **no `closable`** — the neighbouring `showDisconnectToast` sets
   *     `closable: false` on purpose; this toast is its exact opposite and
   *     needs the close cross that PrimeNG renders by default.
   *   - **no `life`** — any value defeats `sticky: true`.
   *
   * `data.messageId` (not `id`, which PrimeNG binds to the rendered DOM `id`
   * attribute) carries the source event id; `Toast.onClose` re-emits the whole
   * message, so it survives to `AppComponent.onToastClose`. Story 31-4 added
   * `data.teamId` alongside it so that handler can address the dismissal POST
   * without reading navigation state — `event.team_id` is populated on the wire
   * by `Message.init` in `Agent._notify_orchestrator`.
   *
   * Story 31-4 also added the suppression guard below: an id already carried by
   * a `ClosedNotification` on the log raises no toast at all. It is an early
   * return HERE and not in the WS `next` handler, so the message still reaches
   * `_wsInbound$` and the Messages tab — closing dismisses the popup, not the
   * historical record. Story 31-5 covers the opposite arrival order by removing
   * the toast after the fact (`onClosedNotificationIds`); `data.messageId` is
   * what addresses it, which is why that field is load-bearing and not debug
   * decoration.
   */
  private showNotificationToast(
    event: ErrorMessage | WarningMessage | NotificationMessage,
    severity: NotificationSeverity,
  ): void {
    if (this.closedNotificationIds.has(event.id)) return;
    this.messageService.add({
      severity,
      summary: this.toastSummary(event, severity),
      detail: event.content,
      sticky: true,
      data: { messageId: event.id, teamId: event.team_id },
    });
  }

  ngOnDestroy() {
    // Suppress disconnect toast triggered by the unsubscribe below —
    // this is intentional navigation, not a connection loss.
    this.destroying = true;

    // Story 8-2 (AC4): clear all toasts and reset the flag so
    // navigating away removes warnings and a fresh process view starts clean.
    this.messageService.clear();
    this.wsDisconnectToastShown = false;

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
    // Story 31-4: the closed-ids cache subscribes for the service's whole
    // lifetime (not per init() cycle — `log.reset()` re-emits an empty set on
    // a team switch, so the cache clears itself).
    this.closedIdsSub.unsubscribe();
    this._wsInbound$.complete();
    // Epic 17 (ADR-014): the `commands` store is owned by the registry; its
    // single `log$` subscription is torn down by `PerAgentStoreRegistry`'s own
    // ngOnDestroy — no per-store completion needed here.
    if (this.spinnerFlipTimer !== null) {
      clearTimeout(this.spinnerFlipTimer);
      this.spinnerFlipTimer = null;
    }
  }
}
