import { Injectable } from '@angular/core';
import { BehaviorSubject, distinctUntilChanged, map, Observable } from 'rxjs';

import {
  AkgenticMessage,
  isClosedNotification,
  isEventMessage,
  isWelcomeAnnouncement,
} from '../../../protocol/message.types';

/**
 * The allowlist of class-name suffixes `messageListFold` admits. Adding a future
 * admitted type is one array entry.
 *
 * Each entry MUST match exactly what `MessageListComponent.notificationSeverity`
 * can classify. A model this fold admits but that predicate returns `null` for
 * falls through to the component's `SentMessage` branch, which reads a payload it
 * does not have. Hence the leading dot on `.NotificationMessage`: it mirrors
 * `isNotificationMessage`'s `endsWith('.NotificationMessage')` so a sibling such
 * as `FooNotificationMessage` — admitted by a bare `'NotificationMessage'`
 * entry, classifiable by nothing — never enters the list. The other three
 * entries are bare because their guards are bare `.includes()` too.
 *
 * No entry double-admits another's messages either: a `__model__` is fully
 * qualified and ends in its concrete class name, so `'…orchestrator.ErrorMessage'`
 * does not contain `'WarningMessage'` (nor the reverse).
 */
const MESSAGE_LIST_MODELS = [
  'SentMessage',
  'ErrorMessage',
  'WarningMessage',
  '.NotificationMessage',
] as const;

/**
 * Story 6.4 (AC4) — pure selector over the log producing the inputs for
 * `MessageListComponent`. Extracted as a module-scope helper so the fold is
 * trivially unit-testable without instantiating the service. FR11 passthrough:
 * messages with an unknown or missing `__model__` are silently excluded
 * (not thrown) — the selector is domain-meaningful, not a validator.
 */
export function messageListFold(log: AkgenticMessage[]): AkgenticMessage[] {
  return log.filter(
    (m) =>
      !!m.__model__ &&
      MESSAGE_LIST_MODELS.some((t) => m.__model__!.includes(t)) &&
      // ADR-011 Decision 2: the welcome announcement carries an `ActorSystem`
      // transport sender, but is admitted via the structural exception.
      (m.sender?.role !== 'ActorSystem' || isWelcomeAnnouncement(m)),
  );
}

/**
 * Story 31-4 (AC #7) — pure fold collecting the ids of every notification the
 * user has dismissed, from the `ClosedNotification` events on the log.
 *
 * It lives HERE, in the event layer, rather than under `components/process/
 * selectors/` where a log-derived projection would normally go: the consumer is
 * `IngestionService`, and the Epic 18 import DAG allows `proc-event` to reach
 * only `proc-models | core | protocol`. Story 18-3 broke the event→selectors
 * edge deliberately to kill a circular import; a selector-homed fold would fail
 * `npm run lint`, not merely offend a convention.
 *
 * Live-stream ids and replayed ids are indistinguishable to the fold — both are
 * just log entries — which is what makes a dismissal survive a reload.
 */
export function closedNotificationIdsFold(log: AkgenticMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of log) {
    if (!m.__model__ || !isEventMessage(m)) continue;
    const event = m.event;
    if (isClosedNotification(event) && event.message_id) {
      ids.add(event.message_id);
    }
  }
  return ids;
}

/**
 * Story 31-4 (AC #7): set equality by size then membership. `closedNotificationIdsFold`
 * builds a FRESH `Set` per log emission, so the default reference comparison in
 * `distinctUntilChanged` would re-emit on every unrelated frame and make every
 * downstream consumer re-run for nothing.
 */
function sameIdSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

/**
 * Story 6.1 — MessageLogService (ADR-005 §Decision 1).
 *
 * Append-only ordered buffer of every WS/REST-replay message received by
 * `IngestionService`. Deliberately domain-agnostic: no `__model__`
 * discriminators, no routing, no knowledge of message types. Consumers
 * (Stories 6.2–6.4) derive their reactive state by folding `log$`.
 *
 * IMPORTANT: This service MUST be provided component-scoped (on
 * `ProcessComponent.providers`), NEVER `providedIn: 'root'`. Team switches
 * destroy the component, which destroys the log — preventing process-A data
 * from leaking into process-B's display (AC5).
 */
@Injectable()
export class MessageLogService {
  private readonly _log$ = new BehaviorSubject<AkgenticMessage[]>([]);

  /** Live observable of the ordered message log. Emits `[]` on subscribe
   *  when the log is empty, followed by the current array after each
   *  `append` / `appendAll` / `reset`. Emits a NEW array reference on every
   *  mutation so OnPush consumers (NFR3) re-evaluate. */
  readonly log$: Observable<AkgenticMessage[]> = this._log$.asObservable();

  /**
   * Story 6.4 (AC4): log-derived selector for `MessageListComponent`. Emits
   * every message whose `__model__` is in `MESSAGE_LIST_MODELS` (the
   * `SentMessage` plus the `ErrorMessage`/`WarningMessage`/`NotificationMessage`
   * family) and whose sender is not `ActorSystem`, in arrival order.
   * `distinctUntilChanged` preserves reference equality across no-op log
   * emissions (OnPush safety, NFR3).
   */
  readonly messageList$: Observable<AkgenticMessage[]> = this.log$.pipe(
    map(messageListFold),
    distinctUntilChanged(),
  );

  /**
   * Story 31-4 (AC #7): ids of the notifications the user has dismissed, folded
   * from the `ClosedNotification` events on the log. `IngestionService` consults
   * it at toast-dispatch time so a dismissed notification never re-toasts.
   *
   * `log$` is a `BehaviorSubject`, so a subscriber receives the current set
   * synchronously — the suppression cache is never momentarily empty on init.
   */
  readonly closedNotificationIds$: Observable<Set<string>> = this.log$.pipe(
    map(closedNotificationIdsFold),
    distinctUntilChanged(sameIdSet),
  );

  /** Append a single message to the log. Prefer `appendAll` when a batch is
   *  available — `appendAll` produces one `log$` emission per batch, whereas
   *  calling `append` N times produces N emissions. Skips duplicates by `id`. */
  append(msg: AkgenticMessage): void {
    if (msg.id && this._log$.value.some(m => m.id === msg.id)) return;
    this._log$.next([...this._log$.value, msg]);
  }

  /** Append N messages in a single emission, deduplicating by `id`.
   *  Under ADR-005's frame-batched ingestion (NFR7: N<1000) a plain array
   *  spread is acceptable — no need for immutable-list data structures.
   *
   *  Deduplication handles the case where a WS replay delivers events
   *  already loaded via REST getEvents() (e.g., team restored while the
   *  frontend is viewing the stopped team's history). */
  appendAll(msgs: AkgenticMessage[]): void {
    if (msgs.length === 0) return;
    const current = this._log$.value;
    const existingIds = new Set(current.map(m => m.id).filter(Boolean));
    const newMsgs = msgs.filter(m => !m.id || !existingIds.has(m.id));
    if (newMsgs.length === 0) return;
    this._log$.next([...current, ...newMsgs]);
  }

  /** Reset the log to empty. Called in `IngestionService.init()` step (b)
   *  on every team switch. */
  reset(): void {
    this._log$.next([]);
  }

  /** Synchronous accessor for the current log contents. Matches
   *  `IngestionService.messages$.value` ergonomics for tests / imperative
   *  callers. */
  snapshot(): AkgenticMessage[] {
    return this._log$.value;
  }
}
