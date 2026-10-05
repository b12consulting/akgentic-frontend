import { inject, Injectable } from '@angular/core';

import { Observable, Subscription } from 'rxjs';

import { ContextService } from '../../../platform/context/context.service';
import { isStaleFrame } from '../../../platform/context/team.interface';
import {
  AkgenticMessage,
  isNotificationMessage,
  TEAM_DESCRIPTION_CONTENT_TYPE,
} from '../../../protocol/message.types';

/**
 * `TeamDescriptionReactor` — Story 58-1. Watches the message log for the
 * worker's generated-description notification and patches the team's
 * description in `ContextService`, so a description generated while the team's
 * page is open appears on the home list without a refresh.
 *
 * The frame it reacts to is a bare `NotificationMessage` whose `content_type`
 * is `TEAM_DESCRIPTION_CONTENT_TYPE` and whose `content` is the new text. It is
 * a REACTOR and not a selector for the same reason `TeamStatusReactor` is
 * (ADR-029 §D1-§D2): `_context$` is a root-scoped REST-fed cache of every team
 * the user can see, no fold of THIS process's log produces it, and the rule is
 * to PATCH that cache from the event, never to refetch the team on its account.
 *
 * It reads THE LOG and not `TeamSocket.inbound$`, by the same transport
 * argument as `TeamStatusReactor`: a stopped team's history arrives over REST
 * `getEvents`, not over the socket, and a socket-side reactor would miss a
 * description generated just before the team stopped. Reading the log also
 * means the log's id-dedup is the only idempotence there is, and that is
 * enough.
 *
 * Two guards, in this order, and the FIRST is deliberately `isNotificationMessage`
 * rather than a `.includes('NotificationMessage')` check: `ErrorMessage` and
 * `WarningMessage` ARE `NotificationMessage` subclasses upstream and carry the
 * same `content_type` field, so the looser check would let a warning with a
 * stray `content_type` overwrite a team's description. `isNotificationMessage`
 * is an `endsWith('.NotificationMessage')` and admits only the bare base.
 *
 * It REMEMBERS NOTHING, but it READS the cache once per matching frame
 * (Story 58-2). Reading the log means seeing the persisted frame on BOTH
 * replay paths — a stopped team's REST history and a restored team's cursor-0
 * replay — and that frame always carries the GENERATED text. Once the owner
 * has edited the description, that text is stale, and applying it would
 * replace a correct cached value with a wrong one until the next list read.
 * So after the two guards above, the reactor reads the cached team through
 * `ContextService.getCachedTeam` (synchronous, never a fetch) and drops the
 * frame when `isStaleFrame` says its `timestamp` is OLDER than the team's
 * `updated_at`. Every description write bumps `updated_at`, so an older frame
 * is superseded by definition, and a live frame emitted right after the
 * generated write is newer than any stamp this page holds. EQUAL APPLIES: the
 * server truncates to milliseconds, and a frame sharing one with its own write
 * must not be dropped. An unknown team (`null`) is forwarded unchanged, so the
 * unknown-id guard stays where it was.
 *
 * There is still no "already applied" set here and no "unchanged" guard:
 * `ContextService.setTeamDescription` owns the unknown-id guard (an event for a
 * team this tab never listed materialises no row), and two identical not-stale
 * notifications producing two identical upserts is acceptable — a second copy
 * of a guard in this class would be the tier smear the folder's rules exist to
 * prevent. A cache read per frame is not memory. The only fields are the
 * injected service and the subscription bag, and a spec pins that.
 *
 * Nothing is self-wired: the constructor subscribes to nothing (ADR-025 §2),
 * and `start()` deliberately does NOT dispose a previous bag of its own — the
 * orchestrator's `disposePriorSubscriptions()` calls `stop()`, and that call is
 * what the wiring spec pins. A self-disposing `start()` would make deleting it
 * harmless.
 *
 * Component-scoped (`@Injectable()` with no `providedIn`), provided on the
 * `process/:id` route before `IngestionService`, which injects it.
 */
@Injectable()
export class TeamDescriptionReactor {
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
   * flattens `log.appended$` with `concatAll()`. The stream must already be
   * live when the log is first written — `appended$` is a plain `Subject` and
   * replays nothing — which is why the wiring sits in `IngestionService.init()`
   * step (b), above the stopped-team replay.
   */
  start(messages$: Observable<AkgenticMessage>): void {
    const subs = new Subscription();
    subs.add(
      messages$.subscribe((msg: AkgenticMessage) => {
        if (!isNotificationMessage(msg)) return;
        if (msg.content_type !== TEAM_DESCRIPTION_CONTENT_TYPE) return;
        // The staleness guard (Story 58-2), and ONLY after the two guards
        // above so an ignored frame never reads the cache. A replayed frame
        // older than the team's last write is superseded; an unknown team is
        // forwarded, since `setTeamDescription` owns that guard.
        const team = this.context.getCachedTeam(msg.team_id);
        if (team && isStaleFrame(msg.timestamp, team)) return;
        // The envelope's `team_id`, never navigation state: the notification
        // names the team it belongs to, and `setTeamDescription` ignores an id
        // it does not hold. `content` is forwarded verbatim — this layer does
        // not decide what `''` means.
        this.context.setTeamDescription(msg.team_id, msg.content);
      }),
    );
    this.subs = subs;
  }

  /**
   * Dispose the subscription. Safe before any `start()` and safe to call twice —
   * it is driven from BOTH `IngestionService.disposePriorSubscriptions()` (per
   * re-init cycle) and its `ngOnDestroy`.
   */
  stop(): void {
    this.subs?.unsubscribe();
    this.subs = null;
  }
}
