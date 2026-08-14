import { inject, Injectable } from '@angular/core';

import { Observable, Subscription } from 'rxjs';
import { bufferTime, filter } from 'rxjs/operators';

import { MessageLogService } from './message-log.service';
import { AkgenticMessage } from '../../../protocol/message.types';

/**
 * Story 6.1 (ADR-005 §Decision 3): the frame-coalescing window, ≈ the 60fps
 * ceiling. One backend burst becomes ONE `appendAll`, ONE `log$` emission and
 * ONE change-detection pass across every selector — the bounded-CD-load
 * guarantee. The added latency is imperceptible; the value lives HERE and
 * nowhere else, so there is one place to change it and one place to read it.
 */
const FRAME_WINDOW_MS = 16;

/**
 * `LogFeeder` — the live-path log SOURCE (Epic 34 / ADR-025 §1). It owns the
 * whole batching policy and is the ONLY live-path caller of
 * `MessageLogService.appendAll`; the sole other call site in the tree is
 * `IngestionService.init()`'s replay seeding, which stays there because it is a
 * sequenced step (ADR-005 §Decision 6 step 3) rather than a stream.
 *
 * A source: it writes the log and holds no derived state, no cursor and no
 * cache. Ordering within a batch is preserved, and the empty-batch filter is
 * what keeps `bufferTime`'s idle ticks from emitting `log$` fifteen times a
 * second forever.
 *
 * Nothing is self-wired: the constructor subscribes to nothing (ADR-025 §2).
 * `start()` RETURNS its handle rather than only storing it, and deliberately
 * does NOT dispose a previous one of its own — the orchestrator's per-cycle
 * `Subscription` bag is the disposal mechanism, and a `start()` that
 * self-disposed would make removing the bag harmless, i.e. would make the
 * re-init leak spec unfalsifiable. `stop()` is the belt-and-braces half, driven
 * from teardown.
 *
 * Component-scoped (`@Injectable()` with no `providedIn`), provided on
 * `ProcessComponent` before `IngestionService`. Root scope would feed one team's
 * frames into the next team's log.
 */
@Injectable()
export class LogFeeder {
  private log: MessageLogService = inject(MessageLogService);

  /** Handle of the current cycle's feed. `null` before `start()` / after `stop()`. */
  private feedSub: Subscription | null = null;

  /**
   * Open the batched feed for one `init()` cycle and hand the handle back so the
   * orchestrator can add it to that cycle's bag.
   *
   * Wired FIRST inside `init()`'s step (d), ahead of every reactor and well
   * ahead of the socket, so the first frame of a cursor-0 replay meets a live
   * log feed rather than an empty subject.
   */
  start(inbound$: Observable<AkgenticMessage>): Subscription {
    this.feedSub = inbound$
      .pipe(
        bufferTime(FRAME_WINDOW_MS),
        filter((batch: AkgenticMessage[]) => batch.length > 0),
      )
      .subscribe((batch: AkgenticMessage[]) => {
        this.log.appendAll(batch);
      });
    return this.feedSub;
  }

  /**
   * Dispose the feed. Safe before any `start()` and safe twice — the cycle bag
   * disposes the same subscription, and `Subscription.unsubscribe()` is
   * idempotent, so the two mechanisms cannot double-throw.
   */
  stop(): void {
    this.feedSub?.unsubscribe();
    this.feedSub = null;
  }
}
