import { inject, Injectable } from '@angular/core';

import { Observable, Subscription } from 'rxjs';

import { ContextService } from '../../../core/context/context.service';
import {
  AkgenticMessage,
  isEventMessage,
  isTeamStoppingEvent,
} from '../../../protocol/message.types';

/**
 * `TeamStatusReactor` — Story 37-2. Watches the message log for the
 * orchestrator's `TeamStoppingEvent` and patches the team status in
 * `ContextService`, so a team stopped by anything other than THIS browser tab
 * stops being shown as live.
 *
 * The defect it closes is the REMOTE stop — the idle timer, another tab, an
 * operator, a worker crash. The LOCAL stop already worked:
 * `ContextService.stopTeamAndAwait` polls and upserts, and `currentTeam$`
 * re-emits off that. When this tab did not issue the stop, nothing writes
 * `_context$` at all, `currentTeam$` never re-emits, and every live subscription
 * keeps reporting `true` indefinitely.
 *
 * It reads THE LOG and not `TeamSocket.inbound$`, and that is the correctness
 * argument rather than a stylistic match with `NotificationToasts`. Two client
 * situations carry the event over different transports:
 *
 *   - a RESTORED (running) team replays over the WS from cursor 0, which does
 *     NOT carry the stop event — core's `restore_message` skips it — and must
 *     stay running;
 *   - a COLD LOAD of an already-stopped team replays over REST `getEvents`,
 *     which DOES carry it, and must be marked stopped.
 *
 * A socket-side reactor would miss the second case entirely. `markStopped`'s own
 * idempotence is what makes it a no-op rather than a redundant write when the
 * cached team is already `'stopped'`.
 *
 * A REACTOR by the shard's tier table, and held to it: it reads the log, calls
 * one method on the outside world, and REMEMBERS NOTHING. There is deliberately
 * no "already marked stopped" set here — `ContextService.markStopped` carries
 * that guard, and a second copy of it in this class is exactly the smear the
 * tier table exists to prevent. `LoadingIndicator` and `ConnectionToast` do hold
 * flags, but those are TRANSPORT state and are the folder's two sanctioned
 * exceptions; domain state here would be a defect.
 *
 * Why not a selector: `_context$` is a root-scoped REST-fed cache of every team
 * the user can see, so no fold of THIS process's log produces it; a selector
 * must survive `log.reset()` on every team switch, and one over `_context$`
 * would zero the user's team list. Writing from the component-scoped process
 * view into a root service that outlives it IS "acting on the outside world".
 *
 * Nothing is self-wired: the constructor subscribes to nothing and calls
 * nothing (ADR-025 §2). Its `start()` deliberately does NOT dispose a previous
 * bag of its own — the orchestrator's `disposePriorSubscriptions()` calls
 * `stop()`, and that call is what a spec pins. A self-disposing `start()` would
 * make deleting that call harmless and the doubling guard unfalsifiable, which
 * is the same reasoning written out on `NotificationToasts`.
 *
 * Component-scoped (`@Injectable()` with no `providedIn`), provided on
 * `ProcessComponent` before `IngestionService`, which injects it.
 */
@Injectable()
export class TeamStatusReactor {
  private readonly context: ContextService = inject(ContextService);

  /**
   * The one subscription opened by `start()`. `null` before the first `start()`
   * and again after every `stop()` — the unit's only field beyond its injected
   * dependency, by design.
   */
  private subs: Subscription | null = null;

  /**
   * Open the subscription for one `init()` cycle.
   *
   * `messages$` carries ONE MESSAGE AT A TIME, already in the log: the caller
   * flattens `log.appended$` with `concatAll()` so within-batch order survives.
   * The stream must ALSO already be live when the log is first written —
   * `appended$` is a plain `Subject` and replays nothing, so a `start()`
   * sequenced after the stopped-team replay observes an empty stream, the
   * cold-load path silently does nothing, and every live-path spec still passes.
   * That is why the wiring sits in `IngestionService.init()` step (b).
   */
  start(messages$: Observable<AkgenticMessage>): void {
    const subs = new Subscription();
    subs.add(
      messages$.subscribe((msg: AkgenticMessage) => {
        // TWO guards, and the second one keys on the INNER payload. Applied to
        // the envelope, `isTeamStoppingEvent` would either never match (dead
        // reactor) or — with an envelope-level tag — match EVERY `EventMessage`,
        // marking healthy teams dead on every `ClosedNotification`.
        if (!isEventMessage(msg)) return;
        if (!isTeamStoppingEvent(msg.event)) return;
        // The envelope's `team_id`, never navigation state: the event names the
        // team it belongs to, and `markStopped` ignores an id it does not hold.
        this.context.markStopped(msg.team_id);
      }),
    );
    this.subs = subs;
  }

  /**
   * Dispose the subscription. Safe before any `start()` and safe to call twice —
   * it is driven from BOTH `IngestionService.disposePriorSubscriptions()` (per
   * re-init cycle) and its `ngOnDestroy`, so the same bag must be releasable
   * without tearing the unit down.
   */
  stop(): void {
    this.subs?.unsubscribe();
    this.subs = null;
  }
}
