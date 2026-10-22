import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';

import {
  defer,
  EMPTY,
  filter,
  fromEvent,
  map,
  merge,
  Observable,
  throttleTime,
} from 'rxjs';

/**
 * How long the page must have been hidden for its return to count as a
 * wake-up (ADR-040 §2). A tab switch of a few seconds leaves a healthy socket
 * behind; a sleeping laptop leaves one the browser may not have noticed is dead.
 */
export const WAKE_UP_HIDDEN_MS = 30_000;

/**
 * Emissions closer than this to the previous one are dropped. A laptop waking
 * fires `online` and `visibilitychange` close together, and each would
 * otherwise cost its own reconnect and cursor-0 replay — correct by the log's
 * dedup, just paid twice.
 */
export const WAKE_UP_COALESCE_MS = 1_000;

/**
 * `WakeUpSource` — Story 63-1 (ADR-040 §2). A SOURCE: it turns the browser's
 * "the page is back" signals into one stream and decides nothing about them.
 * It imports no socket, no log and no toast; `IngestionService` subscribes in
 * its cycle bag and forces the reconnect.
 *
 * Two signals:
 *   - `visibilitychange` on the document, when the page turns visible after at
 *     least `WAKE_UP_HIDDEN_MS` hidden;
 *   - `online` on the document's window, every time — it means a network
 *     interface came up, not that the server is reachable, which is why it
 *     triggers an attempt and not a status change.
 *
 * Nothing is self-wired (ADR-025 §2): `wake$` is COLD. Nothing listens, reads
 * the clock or touches the DOM until it is subscribed, every listener is removed
 * on unsubscribe, and the "hidden since" time lives in the subscription's
 * closure — so the class holds no state of its own and two subscriptions never
 * share one.
 *
 * Route-scoped (`@Injectable()` with no `providedIn`), provided on the
 * `process/:id` route before `IngestionService`, which injects it.
 */
@Injectable()
export class WakeUpSource {
  private readonly document: Document = inject(DOCUMENT);

  readonly wake$: Observable<void> = defer(() => {
    let hiddenAt: number | null =
      this.visibilityState() === 'hidden' ? this.now() : null;

    const shown$ = fromEvent(this.document, 'visibilitychange').pipe(
      filter(() => {
        if (this.visibilityState() === 'hidden') {
          hiddenAt ??= this.now();
          return false;
        }
        const since = hiddenAt;
        hiddenAt = null;
        return since !== null && this.now() - since >= WAKE_UP_HIDDEN_MS;
      }),
    );
    const view = this.document.defaultView;
    const online$ = view ? fromEvent(view, 'online') : EMPTY;

    return merge(shown$, online$).pipe(
      throttleTime(WAKE_UP_COALESCE_MS),
      map((): void => undefined),
    );
  });

  /**
   * The page's visibility, behind a seam for the same reason as
   * `TeamSocket.pageProtocol()`: Chrome's `document.visibilityState` is not
   * stubbable, and the Karma page is always visible. Not a configuration point.
   */
  protected visibilityState(): DocumentVisibilityState {
    return this.document.visibilityState;
  }

  /** The clock, behind a seam for the specs. Not a configuration point. */
  protected now(): number {
    return Date.now();
  }
}
