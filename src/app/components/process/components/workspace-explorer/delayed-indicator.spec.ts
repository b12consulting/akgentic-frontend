import {
  DelayedIndicator,
  INDICATOR_DELAY_MS,
  INDICATOR_MIN_MS,
} from './workspace-explorer.component';

/**
 * The indicator is a plain object, so it is tested as one.
 *
 * Driving it through the component meant fighting the harness for control of
 * two timers and a change-detection tick, and the assertion that mattered — the
 * minimum being HELD — was the one that lost. Here the only thing in play is
 * the clock.
 */
describe('DelayedIndicator', () => {
  let indicator: DelayedIndicator;

  beforeEach(() => {
    jasmine.clock().install();
    indicator = new DelayedIndicator(INDICATOR_DELAY_MS, INDICATOR_MIN_MS);
  });

  afterEach(() => jasmine.clock().uninstall());

  it('starts hidden', () => {
    expect(indicator.visible()).toBeFalse();
  });

  it('shows nothing for a wait SHORTER than the delay', () => {
    // Most reads are this. An indicator that appears and vanishes inside a
    // tenth of a second reads as a flicker rather than as feedback.
    indicator.set(true);
    jasmine.clock().tick(INDICATOR_DELAY_MS - 1);
    indicator.set(false);
    jasmine.clock().tick(INDICATOR_MIN_MS * 2);

    expect(indicator.visible()).toBeFalse();
  });

  it('shows once the wait outlives the delay', () => {
    indicator.set(true);
    jasmine.clock().tick(INDICATOR_DELAY_MS);

    expect(indicator.visible()).toBeTrue();
  });

  it('HOLDS for its minimum when the work finishes first', () => {
    // The rule this class exists for. Without it a read that only just crossed
    // the delay shows something for a few milliseconds — exactly the blink the
    // delay was added to remove.
    indicator.set(true);
    jasmine.clock().tick(INDICATOR_DELAY_MS);
    indicator.set(false);

    expect(indicator.visible())
      .withContext('still up immediately after the work ends')
      .toBeTrue();

    jasmine.clock().tick(INDICATOR_MIN_MS - 1);
    expect(indicator.visible())
      .withContext('still up one tick short of the minimum')
      .toBeTrue();

    jasmine.clock().tick(1);
    expect(indicator.visible())
      .withContext('and down once the minimum is served')
      .toBeFalse();
  });

  it('stays up past its minimum while the work is STILL running', () => {
    // The minimum is a floor, not a ceiling.
    indicator.set(true);
    jasmine.clock().tick(INDICATOR_DELAY_MS + INDICATOR_MIN_MS * 2);

    expect(indicator.visible()).toBeTrue();

    indicator.set(false);
    expect(indicator.visible())
      .withContext('and clears at once, its minimum long since served')
      .toBeFalse();
  });

  it('a second overlapping read does not restart the delay', () => {
    // Two panes can be re-reading at once. Restarting the countdown on each
    // would mean a steady stream of reads never showed anything.
    indicator.set(true);
    jasmine.clock().tick(INDICATOR_DELAY_MS - 10);
    indicator.set(true);
    jasmine.clock().tick(10);

    expect(indicator.visible()).toBeTrue();
  });
});
