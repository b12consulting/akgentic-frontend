import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

import { AkgenticMessage } from '../models/message.types';

/**
 * Story 6.1 — MessageLogService (ADR-005 §Decision 1).
 *
 * Append-only ordered buffer of every WS/REST-replay message received by
 * `ActorMessageService`. Deliberately domain-agnostic: no `__model__`
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

  /** Append a single message to the log. Prefer `appendAll` when a batch is
   *  available — `appendAll` produces one `log$` emission per batch, whereas
   *  calling `append` N times produces N emissions. */
  append(msg: AkgenticMessage): void {
    this._log$.next([...this._log$.value, msg]);
  }

  /** Append N messages in a single emission. Under ADR-005's frame-batched
   *  ingestion (NFR7: N<1000) a plain array spread is acceptable — no need
   *  for immutable-list data structures. */
  appendAll(msgs: AkgenticMessage[]): void {
    if (msgs.length === 0) return;
    this._log$.next([...this._log$.value, ...msgs]);
  }

  /** Reset the log to empty. Called in `ActorMessageService.init()` step (b)
   *  on every team switch. */
  reset(): void {
    this._log$.next([]);
  }

  /** Synchronous accessor for the current log contents. Matches
   *  `ActorMessageService.messages$.value` ergonomics for tests / imperative
   *  callers. */
  snapshot(): AkgenticMessage[] {
    return this._log$.value;
  }
}
