import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, Subject } from 'rxjs';

import { LoadingIndicator } from './loading-indicator';

/**
 * The MINIMAL provider set is itself an assertion (Epic 34 / ADR-025 §1):
 * `LoadingIndicator` depends on NOTHING. No `WebSocketSubject`, no
 * `ApiService`, no `ConfigService`, no PrimeNG `MessageService`, no
 * `MessageLogService`, no `PerAgentStoreRegistry` — the whole spinner-floor
 * concern specs with no transport, no log and no toast harness. If this unit
 * ever grows a dependency, every test in this file fails at `TestBed.inject`
 * with `NullInjectorError`, which is the intended alarm and not a nuisance.
 *
 * Time is `jasmine.clock()` throughout, never a real timer: the floor is
 * measured with the wall clock, so both branches of it are only deterministic
 * under a mocked date.
 */
function setup(): LoadingIndicator {
  TestBed.configureTestingModule({ providers: [LoadingIndicator] });
  return TestBed.inject(LoadingIndicator);
}

/** Record every emission of the subject, including the replayed current value. */
function record(unit: LoadingIndicator): boolean[] {
  const emitted: boolean[] = [];
  unit.loadingProcess$.subscribe((v) => emitted.push(v));
  return emitted;
}

describe('LoadingIndicator — the spinner subject (AC2, AC3)', () => {
  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));
  });

  afterEach(() => jasmine.clock().uninstall());

  it('starts as a BehaviorSubject<boolean> holding false', () => {
    const unit = setup();

    // A BehaviorSubject and not an Observable: `.value` is part of the surface
    // `IngestionService` re-exports, and existing specs read it directly.
    expect(unit.loadingProcess$).toBeInstanceOf(BehaviorSubject);
    expect(unit.loadingProcess$.value).toBeFalse();
  });

  it('beginCycle() turns the spinner on', () => {
    const unit = setup();

    unit.beginCycle();

    expect(unit.loadingProcess$.value).toBeTrue();
  });

  it('AC3: the subject instance survives every cycle, and an early subscriber sees the second cycle', () => {
    const unit = setup();

    // Captured BEFORE the first cycle, exactly as `ChatPanelComponent` captures
    // it in a field initializer at construction time and binds it with
    // `| async` for the component's whole life.
    const ref = unit.loadingProcess$;
    const emitted = record(unit);

    unit.beginCycle();
    expect(unit.loadingProcess$).toBe(ref);

    jasmine.clock().tick(600);
    unit.scheduleSpinnerFlipFalse();
    unit.beginCycle();
    expect(unit.loadingProcess$).toBe(ref);

    // Reference identity alone would not prove the binding still LIVES — a unit
    // that swapped in a fresh subject per cycle leaves the chat panel bound to a
    // dead one, spinner frozen, with nothing else failing. The subscriber
    // attached before the first cycle must still receive the second cycle's
    // `true`.
    expect(emitted).toEqual([false, true, false, true]);
  });
});

describe('LoadingIndicator — the 500ms floor (AC4)', () => {
  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));
  });

  afterEach(() => jasmine.clock().uninstall());

  it('AC4 immediate branch: past the floor, the flip needs no timer', () => {
    const unit = setup();
    unit.beginCycle();

    jasmine.clock().tick(800);
    unit.scheduleSpinnerFlipFalse();

    // No further tick: the elapsed window already satisfies the floor.
    expect(unit.loadingProcess$.value).toBeFalse();
  });

  it('AC4 deferred branch: before the floor, the flip waits exactly the remainder', () => {
    const unit = setup();
    unit.beginCycle();

    jasmine.clock().tick(100);
    unit.scheduleSpinnerFlipFalse();
    expect(unit.loadingProcess$.value).toBeTrue();

    // t=400: still inside the floor.
    jasmine.clock().tick(300);
    expect(unit.loadingProcess$.value).toBeTrue();

    // t=500: the remainder (500 - 100) has elapsed, so the deferred flip fires.
    jasmine.clock().tick(100);
    expect(unit.loadingProcess$.value).toBeFalse();
  });

  it('AC4: the floor is measured from the next(true) emission, not from the request', () => {
    const unit = setup();

    // A cycle started late must still hold the spinner for its own 500ms — if
    // `t0` were stamped anywhere but at the emission, this flip would be
    // immediate.
    jasmine.clock().tick(5000);
    unit.beginCycle();
    jasmine.clock().tick(100);
    unit.scheduleSpinnerFlipFalse();

    expect(unit.loadingProcess$.value).toBeTrue();
    jasmine.clock().tick(400);
    expect(unit.loadingProcess$.value).toBeFalse();
  });
});

describe('LoadingIndicator — the idempotency guard (AC5)', () => {
  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));
  });

  afterEach(() => jasmine.clock().uninstall());

  it('AC5: a second flip request past the floor emits no second false', () => {
    const unit = setup();
    unit.beginCycle();
    const emitted = record(unit);

    jasmine.clock().tick(600);
    // BOTH first-event mechanisms fire for the SAME first frame, so the
    // scheduler is genuinely called twice. `loadingProcess$` is a
    // BehaviorSubject: without the early return the second call emits a
    // redundant `false` to every subscriber.
    unit.scheduleSpinnerFlipFalse();
    unit.scheduleSpinnerFlipFalse();

    expect(emitted).toEqual([true, false]);
  });

  it('AC5: many later requests still emit no further false', () => {
    const unit = setup();
    unit.beginCycle();
    const emitted = record(unit);

    jasmine.clock().tick(600);
    unit.scheduleSpinnerFlipFalse();
    unit.scheduleSpinnerFlipFalse();
    jasmine.clock().tick(1000);
    unit.scheduleSpinnerFlipFalse();
    unit.scheduleSpinnerFlipFalse();

    expect(emitted).toEqual([true, false]);
  });

  it('AC5: the guard does NOT swallow a pending deferred flip', () => {
    const unit = setup();
    unit.beginCycle();
    const emitted = record(unit);

    // Still `true` with a timer pending — the early return must not fire here,
    // or a guard written as "already requested once" would cancel the flip
    // outright instead of merely de-duplicating it.
    jasmine.clock().tick(100);
    unit.scheduleSpinnerFlipFalse();
    unit.scheduleSpinnerFlipFalse();
    jasmine.clock().tick(400);

    expect(emitted).toEqual([true, false]);
  });
});

describe('LoadingIndicator — the first-event latch (AC6)', () => {
  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));
  });

  afterEach(() => jasmine.clock().uninstall());

  it('AC6: the latch is single-shot WITHIN a cycle — later events do not re-enter the scheduler', () => {
    const unit = setup();
    const scheduler = spyOn(unit, 'scheduleSpinnerFlipFalse').and.callThrough();
    unit.beginCycle();

    jasmine.clock().tick(100);
    unit.flipOnFirstEvent();
    unit.flipOnFirstEvent();
    unit.flipOnFirstEvent();

    // Observed on the CALL and not on the emission, deliberately: the
    // idempotency guard downstream would absorb the extra calls, so an emission
    // assertion would stay green with the latch deleted and prove nothing. What
    // the latch buys is that a live team's every subsequent frame does not
    // re-enter the scheduler and churn the pending timer.
    expect(scheduler).toHaveBeenCalledTimes(1);
  });

  it('AC6: the latch is PER-CYCLE — a second cycle flips again', () => {
    const unit = setup();

    unit.beginCycle();
    jasmine.clock().tick(600);
    unit.flipOnFirstEvent();
    expect(unit.loadingProcess$.value).toBeFalse();

    // Second cycle (team switch). A latch that is per-instance rather than
    // per-cycle stays spent here and the spinner never turns off again — the
    // existing suite would not notice, because it only ever runs two cycles in
    // a test that pushes no events.
    unit.beginCycle();
    expect(unit.loadingProcess$.value).toBeTrue();
    jasmine.clock().tick(600);
    unit.flipOnFirstEvent();

    expect(unit.loadingProcess$.value).toBeFalse();
  });
});

describe('LoadingIndicator — re-init cancels a pending flip (AC7)', () => {
  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));
  });

  afterEach(() => jasmine.clock().uninstall());

  it('AC7: a stale timer cannot emit false against the fresh cycle', () => {
    const unit = setup();
    unit.beginCycle();

    // Deferred flip scheduled for t=500.
    jasmine.clock().tick(100);
    unit.scheduleSpinnerFlipFalse();
    expect(unit.loadingProcess$.value).toBeTrue();

    // Team switch before it fires.
    unit.beginCycle();
    expect(unit.loadingProcess$.value).toBeTrue();

    // Past the ORIGINAL scheduled moment: an uncancelled timer fires here and
    // clobbers the fresh cycle with a `false` nobody asked for.
    jasmine.clock().tick(500);
    expect(unit.loadingProcess$.value).toBeTrue();
  });

  it('AC7: stop() also cancels a pending flip', () => {
    const unit = setup();
    unit.beginCycle();

    jasmine.clock().tick(100);
    unit.scheduleSpinnerFlipFalse();
    unit.stop();

    jasmine.clock().tick(1000);
    expect(unit.loadingProcess$.value).toBeTrue();
  });

  it('stop() is idempotent and safe before any cycle has started', () => {
    const unit = setup();

    expect(() => {
      unit.stop();
      unit.stop();
    }).not.toThrow();
    expect(unit.loadingProcess$.value).toBeFalse();
  });
});

describe('LoadingIndicator — no self-wiring, the orchestrator drives it (AC9)', () => {
  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));
  });

  afterEach(() => jasmine.clock().uninstall());

  it('AC9: a freshly constructed unit ignores a stream it was never given', () => {
    const unit = setup();
    const inbound$ = new Subject<unknown>();

    // Constructed, never wired. Pushing frames must change nothing, and no
    // timer may be running before the first cycle.
    inbound$.next({});
    inbound$.next({});
    jasmine.clock().tick(5000);

    expect(unit.loadingProcess$.value).toBeFalse();
    expect(inbound$.observed).toBeFalse();
  });

  it('AC9: it reacts only once the orchestrator hands it the stream', () => {
    const unit = setup();
    const inbound$ = new Subject<unknown>();

    unit.beginCycle();
    unit.watchFirstEvent(inbound$);
    jasmine.clock().tick(600);
    inbound$.next({});

    expect(unit.loadingProcess$.value).toBeFalse();
  });

  it('AC9: watchFirstEvent takes exactly ONE frame per wiring', () => {
    const unit = setup();
    const inbound$ = new Subject<unknown>();
    const scheduler = spyOn(unit, 'scheduleSpinnerFlipFalse').and.callThrough();

    unit.beginCycle();
    unit.watchFirstEvent(inbound$);
    inbound$.next({});
    inbound$.next({});
    inbound$.next({});

    expect(scheduler).toHaveBeenCalledTimes(1);
  });

  it('AC9: an immediately-completed stream does not throw (take(1), not first())', () => {
    const unit = setup();
    const inbound$ = new Subject<unknown>();

    unit.beginCycle();
    unit.watchFirstEvent(inbound$);

    // `first()` would raise EmptyError here — an unmount before any WS frame.
    expect(() => inbound$.complete()).not.toThrow();
  });
});

describe('LoadingIndicator — subscription ownership (AC11)', () => {
  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));
  });

  afterEach(() => jasmine.clock().uninstall());

  it('AC11: watchFirstEvent leaves exactly one observer, stop() leaves none', () => {
    const unit = setup();
    const inbound$ = new Subject<unknown>();

    unit.beginCycle();
    unit.watchFirstEvent(inbound$);
    expect((inbound$ as unknown as { observers: unknown[] }).observers.length).toBe(1);
    expect(inbound$.observed).toBeTrue();

    unit.stop();
    expect((inbound$ as unknown as { observers: unknown[] }).observers.length).toBe(0);
    expect(inbound$.observed).toBeFalse();
  });

  it('AC11: re-wiring never stacks a second side-channel on the same stream', () => {
    const unit = setup();
    const inbound$ = new Subject<unknown>();

    unit.beginCycle();
    unit.watchFirstEvent(inbound$);
    unit.beginCycle();
    unit.watchFirstEvent(inbound$);

    // The unit OWNS this subscription, so it disposes its own before opening
    // another — the `observers.length === 2` pin over in
    // `ingestion.service.spec.ts` counts this one plus the batched subscriber.
    expect((inbound$ as unknown as { observers: unknown[] }).observers.length).toBe(1);
  });

  it('AC11: the take(1) subscription releases itself after the first frame', () => {
    const unit = setup();
    const inbound$ = new Subject<unknown>();

    unit.beginCycle();
    unit.watchFirstEvent(inbound$);
    inbound$.next({});

    expect(inbound$.observed).toBeFalse();
  });
});

describe('LoadingIndicator — component-scoped, never root-provided (Epic 34)', () => {
  it('is NOT reachable from an injector that does not provide it', () => {
    TestBed.resetTestingModule();
    // It has no dependencies at all, so a failure to inject can only mean
    // `LoadingIndicator` itself is unreachable. Give the class
    // `providedIn: 'root'` and this injection SUCCEEDS instead — and one
    // spinner, with one `| async`-bound subject, would then be shared across
    // every team the user visits.
    TestBed.configureTestingModule({ providers: [] });

    expect(() => TestBed.inject(LoadingIndicator)).toThrowError(/No provider/);
  });
});
