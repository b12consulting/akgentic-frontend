import { Injectable } from '@angular/core';

import { Observable, BehaviorSubject, Subscription } from 'rxjs';
import { take } from 'rxjs/operators';

/**
 * Story 4-10 (AC7): minimum visible duration of the loading spinner.
 * When the first event / WS error / stopped-team replay lands before this
 * floor, the flip to `loadingProcess$.next(false)` is deferred so users
 * never see a sub-perception flash of the spinner before the UI transitions.
 */
const SPINNER_MIN_VISIBLE_MS = 500;

/**
 * `LoadingIndicator` — the spinner-floor REACTOR (Epic 34 / ADR-025 §0-§1). It
 * owns `loadingProcess$`, the 500 ms floor, the pending-flip timer, the
 * per-cycle first-event latch and the `take(1)` side-channel, and is the only
 * reason `Date.now()` and `setTimeout` appear anywhere in the ingestion layer.
 *
 * A reactor that HOLDS STATE, which the epic's review test otherwise forbids
 * ("if a unit needs to remember something, it is a projection"). This is the one
 * sanctioned exception, and not as a concession: the spinner depends on WHEN
 * frames arrived, and the log records what happened, never when it was
 * delivered. No fold over the log can produce this value, even in principle — so
 * it can never be a projection. The rule it does obey is the one that matters:
 * its state is about the TRANSPORT, never about the domain. A reactor holding
 * domain state stays a defect.
 *
 * Nothing is self-wired: the constructor subscribes to nothing and starts no
 * timer (ADR-025 §2, restating ADR-005 §Decision 6). `beginCycle()` /
 * `watchFirstEvent()` / `stop()` are the explicit invocation points, sequenced
 * by `IngestionService.init()` — and the two cycle-start points sit either side
 * of its REST-replay `await` deliberately, so `t0` is stamped before the network
 * round-trip rather than after it.
 *
 * Teardown is per-cycle and manual, never `takeUntilDestroyed()`: `init()` runs
 * repeatedly within one component lifetime (team switch), so destroy-scoped
 * teardown alone would leak each cycle's side-channel into the next.
 *
 * Component-scoped (`@Injectable()` with no `providedIn`), provided on
 * `ProcessComponent` alongside every other unit in this folder: a root instance
 * would outlive the process view and carry a prior team's spinner state — and
 * its `| async`-bound subject — into the next one.
 */
@Injectable()
export class LoadingIndicator {
  /**
   * Story 4-10 (AC7) / Epic 18 (ADR-015 §2): the loading-spinner state. Read by
   * `ChatPanelComponent` through `IngestionService.loadingProcess$`, which
   * re-exports THIS instance.
   *
   * Constructed once here and never reassigned. `ChatPanelComponent` captures
   * the reference in a field initializer and binds it with `| async` for the
   * component's whole life, so a per-cycle replacement would leave the chat
   * panel bound to a dead subject — spinner frozen, and nothing failing
   * anywhere. `beginCycle()` calls `next(true)` on it; it never builds a new one.
   *
   * A `BehaviorSubject`, not an `Observable`: `.value` is part of the surface.
   */
  readonly loadingProcess$: BehaviorSubject<boolean> =
    new BehaviorSubject<boolean>(false);

  /**
   * Story 4-10 (AC7): timestamp (ms since epoch) of the most recent
   * `loadingProcess$.next(true)` emission in `beginCycle()`. Used to compute the
   * elapsed visible duration when scheduling the flip-to-false.
   *
   * Keep this and `spinnerFlipTimer` declared WITH their initialisers. The
   * structural probe in `ingestion.service.spec.ts` reads the own properties of
   * the injected instance and treats any object whose values are ALL
   * `BehaviorSubject`s as a bespoke per-agent state container; these
   * non-subject own properties sitting alongside `loadingProcess$` are the only
   * reason this unit is not misread as one. Tidying them into lazily-assigned
   * fields turns a spec red for a reason having nothing to do with the spinner.
   */
  private spinnerShownAt: number = 0;
  /**
   * Story 4-10 (AC7): handle of a pending `setTimeout` that will flip the
   * spinner to `false` once the 500ms floor is reached. Cleared on re-init
   * so a stale `false` can never clobber a fresh spinner cycle.
   */
  private spinnerFlipTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Story 4-10 (AC1): single-shot latch for the WS paths, reset by every
   * `beginCycle()` so it is PER-CYCLE and not per-instance — a latch left spent
   * from cycle 1 would freeze the spinner on for the whole of cycle 2.
   *
   * It was a `let` local inside `init()` before Epic 34; a field is what lets
   * the WS handlers reach it now that they live in a different class.
   */
  private firstEventReceived: boolean = false;

  /** Spinner-first-event side-channel subscriber (take(1)). Held so `stop()`
   *  can dispose it per cycle, not merely on destroy. */
  private spinnerSub: Subscription | null = null;

  /**
   * Start a spinner cycle: cancel any pending flip left by the previous cycle,
   * reset the first-event latch, stamp `t0` and turn the spinner on — in that
   * order. Cancelling FIRST is what stops a stale timer from emitting `false`
   * against the fresh cycle a few milliseconds later.
   */
  beginCycle(): void {
    if (this.spinnerFlipTimer !== null) {
      clearTimeout(this.spinnerFlipTimer);
      this.spinnerFlipTimer = null;
    }
    this.firstEventReceived = false;
    this.spinnerShownAt = Date.now();
    this.loadingProcess$.next(true);
  }

  /**
   * Story 6.1 (ADR-005 §Decision 8): spinner first-event flip. `take(1)` on the
   * raw inbound stream fires once per cycle and is independent of the batched
   * subscriber (so a tight batch does not delay the flip). `take(1)` (not
   * `first()`) is used so an immediately-completed stream (e.g. unmount before
   * any WS event) doesn't throw `EmptyError`.
   *
   * Re-wiring disposes the previous side-channel first: this unit owns that
   * subscription, so it must never leave two of them on the stream — the
   * `observers.length === 2` pin in `ingestion.service.spec.ts` is what would
   * otherwise catch it, one story too late.
   */
  watchFirstEvent(inbound$: Observable<unknown>): void {
    this.spinnerSub?.unsubscribe();
    this.spinnerSub = inbound$
      .pipe(take(1))
      .subscribe(() => this.scheduleSpinnerFlipFalse());
  }

  /**
   * Story 4-10 (AC1): the latch used by the two WS call sites, which can fire
   * many times per cycle. Keeping it ALONGSIDE the idempotency guard in
   * `scheduleSpinnerFlipFalse` is deliberate — dropping it "because the guard
   * makes it redundant" would let every subsequent frame re-enter the scheduler
   * and re-create the pending timer.
   *
   * The stopped-team and `createWebSocket`-throw sites call the scheduler
   * DIRECTLY instead: each happens at most once per cycle by construction, and
   * routing them through this shared latch would let a stopped team's flip
   * consume it, so a later live frame in the same cycle would find it spent.
   */
  flipOnFirstEvent(): void {
    if (this.firstEventReceived) return;
    this.firstEventReceived = true;
    this.scheduleSpinnerFlipFalse();
  }

  /**
   * Story 4-10 (AC7): flip `loadingProcess$` to `false`, but respect the
   * `SPINNER_MIN_VISIBLE_MS` floor measured from the spinner-on emission
   * time. If the floor has already been reached, flip immediately; otherwise
   * defer via `setTimeout` so the user always sees the spinner for at least
   * half a second.
   *
   * Called from FOUR sites (all share the same floor semantics):
   *   - WS first-event path (running=true) — via `flipOnFirstEvent`
   *   - WS error path (failure-safety) — via `flipOnFirstEvent`
   *   - stopped-team path (after HTTP replay seeds state) — directly
   *   - synchronous `createWebSocket` throw (failure-safety) — directly
   */
  scheduleSpinnerFlipFalse(): void {
    // Story 6.1 idempotency: the WS `next` handler's latch AND the `take(1)`
    // side-channel both fire on the first event (deliberate parallel-populate
    // wiring), so this method is called TWICE for that one event. Skip the
    // second call if the spinner is already false AND no deferred flip is
    // pending — `loadingProcess$` is a BehaviorSubject, so a second
    // `next(false)` emits a redundant `false` to every subscriber, breaking
    // Story 4-10 AC1's "subsequent events do not re-emit false" test.
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
   * Dispose everything this unit owns: the side-channel subscription and any
   * pending flip. Idempotent and safe before any cycle has started, because it
   * is called from BOTH the orchestrator's re-init disposal step and its
   * `ngOnDestroy` — the same subscription must be releasable without tearing
   * the unit down.
   *
   * `loadingProcess$` is deliberately NOT completed: the chat panel holds it
   * across cycles, and completing it would end that binding permanently.
   */
  stop(): void {
    if (this.spinnerSub) {
      this.spinnerSub.unsubscribe();
      this.spinnerSub = null;
    }
    if (this.spinnerFlipTimer !== null) {
      clearTimeout(this.spinnerFlipTimer);
      this.spinnerFlipTimer = null;
    }
  }
}
