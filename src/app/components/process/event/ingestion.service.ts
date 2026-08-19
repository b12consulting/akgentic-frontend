import { inject, Injectable } from '@angular/core';

import { BehaviorSubject, concatAll, Subscription } from 'rxjs';
import {
  AkgenticMessage,
  CommandDescriptor,
} from '../../../protocol/message.types';

import { ConnectionToast } from './connection-toast';
import { LoadingIndicator } from './loading-indicator';
import { LogFeeder } from './log-feeder';
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
import { TeamSocket, TeamSocketStatus } from './team-socket';
import { TeamStatusReactor } from './team-status-reactor';
import { MessageService } from 'primeng/api';

/**
 * `IngestionService` — the ORCHESTRATOR of the ingestion layer (Epic 34 /
 * ADR-025). After the decomposition it does two things and no others: it
 * SEQUENCES the units below, and it re-exports the five per-agent stores plus
 * `loadingProcess$` so no consumer had to change.
 *
 * Every unit it drives is inert until called — none subscribes, opens a socket
 * or touches the log in its constructor (ADR-025 §2). That is what makes the
 * order in `init()` the real order: if a unit self-wired, Angular DI would
 * decide when its work happened, and the team-switch guarantee below would
 * evaporate silently, because a green single-team suite is exactly what a
 * self-wired implementation produces.
 *
 * The units, all component-scoped and provided on `ProcessComponent`:
 *   - `TeamSocket` (`team-socket.ts`) — WS transport, the `createWebSocket`
 *     seam, `inbound$` / `frames$` / `status$`.
 *   - `LogFeeder` (`log-feeder.ts`) — `bufferTime(16)` → `log.appendAll`, the
 *     only live-path writer of the log.
 *   - `ReplaySeeder` (`replay-seeder.ts`) — the two stopped-team REST calls. The
 *     `appendAll` of what it returns stays HERE, because it is a sequenced step.
 *   - `ProcessStores` (`process-stores.ts`) — declares the five per-agent stores.
 *   - `LoadingIndicator` (`loading-indicator.ts`) — the spinner floor; the only
 *     `Date.now()` and `setTimeout` in the layer.
 *   - `ConnectionToast` (`connection-toast.ts`) — the disconnect warning.
 *   - `NotificationToasts` (`notification-toasts.ts`) — the notification family.
 *     Story 35-1 (ADR-027) took it off the transport: it is handed
 *     `log.appended$`, the post-dedup delta, so every delivery path toasts and
 *     the log's id-dedup is the only idempotence there is. Its WIRING POSITION
 *     is part of that contract — see step (b) in `init()`. `LoadingIndicator`
 *     and `ConnectionToast` stay on the raw socket, and correctly so: they are
 *     transport concerns, which is why this folder now has reactors on both
 *     streams. Do not "unify" the two.
 *   - `TeamStatusReactor` (`team-status-reactor.ts`) — Story 37-2. The second
 *     log-side reactor, and it shares the wiring position for the same reason:
 *     a stopped team's `TeamStoppingEvent` only ever arrives in step (c)'s REST
 *     replay.
 *
 * `messageService.clear()` stays here rather than moving into either toast unit:
 * it empties the whole keyless `<p-toast>` container, both families at once, so
 * it is lifecycle sequencing.
 *
 * Per-agent state (Epic 17 / ADR-014, re-homed by Epic 34 / ADR-025 §1):
 * `state`, `context`, `commands`, `systemPrompt` and `tokenUsage` are ALL
 * `PerAgentStore` instances owned by the component-scoped
 * `PerAgentStoreRegistry` and DECLARED by `ProcessStores`. They are merely
 * re-exported below — aliases, never re-registrations, since `register()`
 * returns a NEW store per call and a second one here would give the app two
 * independent maps folding the same log, each correct in isolation.
 */
@Injectable()
export class IngestionService {
  messageService: MessageService = inject(MessageService);

  /**
   * Story 6.1 (ADR-005 §Decision 1): component-scoped append-only log of every
   * WS + REST-replay message. Reset in step (b) of every cycle; written by
   * `LogFeeder` on the live path and by the two replay `appendAll` calls below.
   */
  private log: MessageLogService = inject(MessageLogService);

  /**
   * Epic 34 (ADR-025 §1): the projection unit that DECLARES the five per-agent
   * stores. Declared ABOVE the aliases that read it — TypeScript initialises
   * class fields in declaration order, so an alias declared first reads
   * `undefined`.
   */
  private readonly stores: ProcessStores = inject(ProcessStores);

  /** Epic 34 (ADR-025 §1): the WS transport source. Opened LAST in `init()`. */
  private readonly socket: TeamSocket = inject(TeamSocket);

  /** Epic 34 (ADR-025 §1): the frame-batched log feed. Wired FIRST in step (d). */
  private readonly feeder: LogFeeder = inject(LogFeeder);

  /** Epic 34 (ADR-025 §1): the stopped-team REST replay source. */
  private readonly replay: ReplaySeeder = inject(ReplaySeeder);

  /**
   * Epic 34 (ADR-025 §0-§1): the spinner-floor reactor. Declared ABOVE the
   * `loadingProcess$` alias for the same declaration-order reason as `stores`.
   */
  private readonly loading: LoadingIndicator = inject(LoadingIndicator);

  /** Epic 34 (ADR-025 §0-§1): the disconnect-toast reactor, driven by `status$`. */
  private readonly connectionToast: ConnectionToast = inject(ConnectionToast);

  /** Epic 34 (ADR-025 §0-§1): the notification-toast reactor. */
  private readonly notificationToasts: NotificationToasts =
    inject(NotificationToasts);

  /**
   * Story 37-2: the team-stopping reactor. Reads the same log delta as
   * `NotificationToasts` and for the same transport reason — a stopped team's
   * history arrives over REST, not over the socket — and patches
   * `ContextService` so a team stopped by another tab, the idle timer, an
   * operator or a worker crash stops being shown as live.
   */
  private readonly teamStatusReactor: TeamStatusReactor =
    inject(TeamStatusReactor);

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

  // Epic 34 (ADR-025 §1): the five per-agent stores, re-exported from
  // `ProcessStores`. The rationale for each store's keying and reducer lives
  // with its declaration in `process-stores.ts`.

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
   * Epic 34 (ADR-025 §3): ALL of this cycle's subscriptions, in one bag. Three
   * hand-managed `Subscription` fields collapsed into it — the log feed, the
   * every-frame spinner tap and the connection-status tap.
   *
   * A FRESH bag per `init()`, and the old one unsubscribed before the new one is
   * built: rxjs adds a child to an already-unsubscribed parent by unsubscribing
   * the child immediately, so reusing a disposed bag would silently kill the
   * fresh cycle's subscriptions.
   *
   * Disposed on BOTH re-init and destroy, and that is not
   * `takeUntilDestroyed()` territory: `init()` runs several times per component
   * lifetime (team switch), so destroy-scoped teardown alone leaks a cycle's
   * subscriptions into the next — a leak the mount/unmount probe cannot see.
   *
   * Two teardown handles deliberately stay OUT of this bag because neither is a
   * subscription: the socket (`TeamSocket.stop()`, a try/catch unsubscribe — a
   * never-opened WS throws) and the pending spinner flip
   * (`LoadingIndicator.stop()`, a `clearTimeout`).
   */
  private cycle: Subscription | null = null;

  /**
   * ADR-005 §Decision 6 — the four ordered steps, in the order that ADR and
   * architecture shard 02 §4 fix them. The order is load-bearing: it closes the
   * team-switch race, and the failure it prevents is INVISIBLE in single-team
   * testing, because with one `init()` every order works.
   *
   *   (a) dispose the prior cycle — old socket closed, old subscriptions gone,
   *       so a stale team's pipeline cannot deliver into the fresh cycle;
   *   (b) `log.reset()` — the registry sees the shrink, clears every map and
   *       rewinds its cursor to 0. There is no per-store reset code, by design.
   *       Story 35-1 (ADR-027 §3) also starts `NotificationToasts` here, since
   *       it now reads the log rather than the socket and the replay in (c)
   *       must find it already subscribed;
   *   (c) seed the replay (stopped teams only) — `getAgentStates` + `getEvents`
   *       → `appendAll`. Every selector then holds its history;
   *   (d) wire the consumers, THEN open the socket. Both halves matter: the
   *       consumers must be live before the first frame, and the socket must
   *       open after the replay so nothing can arrive between (b) and (d).
   *
   * The non-ordering side effects keep their current relative positions: the
   * toast clear and the disconnect re-arm sit after the reset and before the
   * spinner turns on; the stopped-team spinner flip fires after the replay and
   * before the socket opens.
   */
  async init(processId: string, running: boolean): Promise<void> {
    this.processId = processId;

    // --- (a) dispose the prior cycle ---------------------------------
    this.disposePriorSubscriptions();

    // --- (b) reset the log -------------------------------------------
    // Every selector and per-agent store is a fold over `log$`, so this one
    // call is the whole of "clear process A's state" (ADR-014 §Decision 3).
    this.log.reset();

    // Story 8-2: clear any stale toasts from a prior init() cycle so process-A's
    // warnings do not persist into process-B. Both families at once.
    this.messageService.clear();
    // Epic 34 (ADR-025 §1): re-arm the disconnect toast for this cycle, at
    // exactly the point the inline flag reset held — after the toast clear,
    // before the spinner cycle — so a prior team's disconnect cannot suppress
    // this one's.
    this.connectionToast.start();

    // Story 4-10 (AC7): start the spinner cycle. This call belongs HERE, BEFORE
    // the `!running` REST replay below: moving it after the await would measure
    // the 500ms floor from the end of a network round-trip, and would put the
    // stopped-team flip ahead of the `true` it is supposed to follow.
    this.loading.beginCycle();

    // Story 35-1 (ADR-027 §2-§3): the notification reactor, fed the LOG's
    // post-dedup delta and wired ABOVE the replay block below — that position is
    // the fix, not the argument. `appended$` is a plain `Subject`, so a
    // subscriber arriving after an `appendAll` receives nothing: leave this call
    // in step (d) and the stopped-team replay emits into no subscriber, the
    // reported bug survives, and every live-path spec still passes. It can sit
    // here because both arguments come from `MessageLogService` and neither
    // needs the socket; it must stay after step (a)'s
    // `disposePriorSubscriptions()`, which calls `stop()`. `concatAll` and never
    // `mergeAll`: within-batch order is what the reactor's per-message contract
    // is written against.
    this.notificationToasts.start(
      this.log.appended$.pipe(concatAll()),
      this.log.closedNotificationIds$,
    );

    // Story 37-2: the team-stopping reactor, wired HERE for exactly the reason
    // above it. The cold load of an already-stopped team is the case that needs
    // it: that team's `TeamStoppingEvent` arrives in step (c)'s REST replay and
    // nowhere else, so a `start()` sequenced below the replay block observes an
    // empty stream, the stopped team keeps reporting itself running, and every
    // live-path spec stays green.
    this.teamStatusReactor.start(this.log.appended$.pipe(concatAll()));

    // --- (c) seed the replay (stopped teams only) --------------------
    if (!running) {
      // Story 25-1 (ADR-020 §2, !running gate): a stopped team's durable event
      // log carries no `StateChangedMessage` (ADR-013), so without this seed the
      // backstory head-block stays blank. A running team — including a freshly
      // restored one — already gets its `StateChangedMessage`(s) on the cursor-0
      // WS replay, so `getAgentStates` MUST NOT be called for it. The gate lives
      // HERE and never inside the seeder, which knows no team status.
      //
      // TWO sequential awaits and TWO appends, never `Promise.all` and never one
      // merged array: the state seed must be folded BEFORE the event replay,
      // since `stateSpec` is latest-wins and a real replayed
      // `StateChangedMessage` has to be able to overwrite a synthesized seed
      // (never the reverse). Parallelising would also change failure semantics —
      // a `getAgentStates` rejection today means `getEvents` is never issued and
      // `init()` rejects before the socket opens.
      const seeds: AkgenticMessage[] = await this.replay.seedMessages(processId);
      this.log.appendAll(seeds);

      const replayMessages: AkgenticMessage[] =
        await this.replay.replayMessages(processId);
      this.log.appendAll(replayMessages);

      // Story 4-10 (AC2): replay state is populated — flip the spinner off
      // BEFORE the socket is wired so the user never sees `#emptyState` flash.
      // Site 3 of the four floor call sites: direct, NOT through the latch. It
      // happens at most once per cycle by construction, and consuming the shared
      // latch here would leave a later live frame finding it already spent.
      this.loading.scheduleSpinnerFlipFalse();
    }

    // --- (d) wire the consumers, THEN open the socket -----------------
    // Every subscription below is opened against a socket that is not yet
    // constructed, so the first frame — including the first frame of a cursor-0
    // replay, which a transport can deliver synchronously at subscribe time —
    // always meets a live subscriber.
    const cycle = new Subscription();
    this.cycle = cycle;

    // The log feed FIRST, so "the frame reaches the log, then the toast fires"
    // survives the decomposition.
    cycle.add(this.feeder.start(this.socket.inbound$));
    // The spinner's `take(1)` side-channel on the protocol stream. Owned and
    // disposed by `LoadingIndicator` itself (a `clearTimeout` lives alongside
    // it), which is why it is not added to the bag.
    this.loading.watchFirstEvent(this.socket.inbound$);
    // Story 4-10 (AC1): the every-frame tap. Fires for frames with no
    // `__model__` too — receiving bytes is proof the replay stream started. This
    // is the direct `flipOnFirstEvent()` call the WS `next` handler used to make
    // inline, now that the handler lives in another file.
    cycle.add(this.socket.frames$.subscribe(() => this.loading.flipOnFirstEvent()));
    cycle.add(
      this.socket.status$.subscribe((status: TeamSocketStatus) =>
        this.onSocketStatus(status),
      ),
    );

    try {
      this.socket.start(processId);
    } catch (err) {
      // Story 4-10 (AC3): synchronous ctor failure must not leave the UI
      // spinning for ever — there is no socket left to deliver the event that
      // would end the wait. `TeamSocket.start()` deliberately lets the throw
      // out; the flip is sequenced here, and the error still reaches the caller.
      // Site 4: direct, NOT through the latch — same reason as site 3.
      console.error('WebSocket construction failed:', err);
      this.loading.scheduleSpinnerFlipFalse();
      throw err;
    }
  }

  /**
   * Story 8-2 / Story 4-10 (AC3): the two socket endings, which are NOT
   * symmetric. `error` flips the spinner as well as warning — a failure before
   * any frame landed must not leave the UI spinning — while `complete` warns
   * only, having already had its first frame.
   */
  private onSocketStatus(status: TeamSocketStatus): void {
    if (status === 'error') this.loading.flipOnFirstEvent();
    this.connectionToast.show();
  }

  /**
   * ADR-005 §Decision 6 step (a): release everything a previous cycle owns, in
   * one place, before any new state is wired.
   *
   * Each unit's `stop()` is per-cycle rather than destroy-scoped, and
   * `notificationToasts.stop()` in particular is load-bearing HERE and not only
   * in `ngOnDestroy`: drop it and `start()` leaves a SECOND live subscription on
   * `log.appended$`, doubling every toast — and its cache reset is what makes
   * the per-cycle subscription equivalent to the service-lifetime one it
   * replaced.
   */
  private disposePriorSubscriptions(): void {
    this.socket.stop();
    this.cycle?.unsubscribe();
    this.cycle = null;
    this.loading.stop();
    this.notificationToasts.stop();
    this.teamStatusReactor.stop();
  }

  ngOnDestroy(): void {
    // FIRST, and load-bearing: closing the socket below completes its stream,
    // whose `complete` reaches `connectionToast.show()`. Moving this line after
    // it raises a "Connection Lost" toast on every intentional navigation. The
    // two statements now live in different files, which makes the ordering
    // easier to break and is why a spec pins it.
    this.connectionToast.stop();

    // Story 8-2 (AC4): clear all toasts so navigating away removes warnings and
    // a fresh process view starts clean.
    this.messageService.clear();

    this.disposePriorSubscriptions();

    // Only on destroy, never per cycle: completing the socket's streams ends
    // them for good, and the next cycle needs them alive.
    this.socket.destroy();
  }
}
