import {
  clampSplitPercent,
  formatSplitPercent,
  parseSplitPercent,
  SPLIT_COARSE_STEP_PERCENT,
  SPLIT_DEFAULT_PERCENT,
  SPLIT_FINE_STEP_PERCENT,
  SPLIT_MAX_PERCENT,
  SPLIT_MIN_PERCENT,
  splitPercentFromPointer,
  stepSplitPercent,
} from './split-width';

/**
 * Epic 52 NFR3: the clamping and persistence arithmetic, tested WITHOUT a
 * browser. No TestBed, no fixture, no pointer — these are functions over
 * numbers, and the failure they guard against (a width that shifts a little on
 * every reload) is invisible in a rendered test.
 */
describe('split-width (Story 52-2)', () => {
  describe('clampSplitPercent', () => {
    it('leaves a value inside the range alone', () => {
      expect(clampSplitPercent(45)).toBe(45);
    });

    it('(FR4) pins a collapse attempt at the floor, so the list cannot vanish', () => {
      expect(clampSplitPercent(0)).toBe(SPLIT_MIN_PERCENT);
      expect(clampSplitPercent(-40)).toBe(SPLIT_MIN_PERCENT);
    });

    it('(FR4) pins an overrun at the ceiling, so the team pane cannot vanish', () => {
      expect(clampSplitPercent(100)).toBe(SPLIT_MAX_PERCENT);
      expect(clampSplitPercent(180)).toBe(SPLIT_MAX_PERCENT);
    });

    it('admits both bounds themselves — the range is closed, not open', () => {
      expect(clampSplitPercent(SPLIT_MIN_PERCENT)).toBe(SPLIT_MIN_PERCENT);
      expect(clampSplitPercent(SPLIT_MAX_PERCENT)).toBe(SPLIT_MAX_PERCENT);
    });

    it('rounds to one decimal', () => {
      expect(clampSplitPercent(33.333333)).toBe(33.3);
      expect(clampSplitPercent(33.35)).toBe(33.4);
    });

    it('is idempotent — a clamped value cannot move by being clamped again', () => {
      for (const raw of [-10, 0, 20.04, 33.333333, 45.55, 70, 99.9]) {
        expect(clampSplitPercent(clampSplitPercent(raw))).toBe(
          clampSplitPercent(raw),
        );
      }
    });

    it('answers the default for a value that is not a number at all', () => {
      expect(clampSplitPercent(NaN)).toBe(SPLIT_DEFAULT_PERCENT);
      expect(clampSplitPercent(Infinity)).toBe(SPLIT_DEFAULT_PERCENT);
    });
  });

  describe('splitPercentFromPointer', () => {
    const geometry = {
      containerLeft: 100,
      containerWidth: 1000,
      dividerWidth: 8,
    };

    it('centres the divider on the pointer', () => {
      // Pointer 504px into a 1000px container, minus half of the 8px divider,
      // leaves the list 500px wide: exactly half.
      expect(
        splitPercentFromPointer({ ...geometry, pointerX: 100 + 504 }),
      ).toBe(50);
    });

    it('the divider width is not a rounding detail — dropping it shifts the split', () => {
      const withDivider = splitPercentFromPointer({
        ...geometry,
        pointerX: 100 + 504,
      });
      const withoutDivider = splitPercentFromPointer({
        ...geometry,
        dividerWidth: 0,
        pointerX: 100 + 504,
      });
      expect(withDivider).not.toBe(withoutDivider);
      expect(withoutDivider).toBe(50.4);
    });

    it('measures from the container, not from the viewport', () => {
      // The same pointer position against a container that starts at 0 is a
      // different split. Forgetting `containerLeft` is how a divider snaps to a
      // bound the moment the page has anything to the left of it.
      expect(
        splitPercentFromPointer({
          ...geometry,
          containerLeft: 0,
          pointerX: 100 + 504,
        }),
      ).toBe(60);
    });

    it('(FR4) clamps a drag past either edge', () => {
      expect(splitPercentFromPointer({ ...geometry, pointerX: -5000 })).toBe(
        SPLIT_MIN_PERCENT,
      );
      expect(splitPercentFromPointer({ ...geometry, pointerX: 5000 })).toBe(
        SPLIT_MAX_PERCENT,
      );
    });

    it('refuses an unmeasurable container instead of reporting a bound', () => {
      expect(
        splitPercentFromPointer({ ...geometry, containerWidth: 0, pointerX: 500 }),
      ).toBeNull();
      expect(
        splitPercentFromPointer({ ...geometry, containerWidth: NaN, pointerX: 500 }),
      ).toBeNull();
      expect(
        splitPercentFromPointer({ ...geometry, pointerX: NaN }),
      ).toBeNull();
    });

    it('(FR5) the same pointer fraction gives the same percentage at any window width', () => {
      const narrow = splitPercentFromPointer({
        containerLeft: 0,
        containerWidth: 600,
        dividerWidth: 0,
        pointerX: 240,
      });
      const wide = splitPercentFromPointer({
        containerLeft: 0,
        containerWidth: 2400,
        dividerWidth: 0,
        pointerX: 960,
      });
      expect(narrow).toBe(40);
      expect(wide).toBe(40);
    });
  });

  describe('stepSplitPercent', () => {
    it('(FR6) the fine step moves by one point', () => {
      expect(stepSplitPercent(45, SPLIT_FINE_STEP_PERCENT)).toBe(46);
      expect(stepSplitPercent(45, -SPLIT_FINE_STEP_PERCENT)).toBe(44);
    });

    it('(FR6) the coarse step moves by ten', () => {
      expect(stepSplitPercent(45, SPLIT_COARSE_STEP_PERCENT)).toBe(55);
      expect(stepSplitPercent(45, -SPLIT_COARSE_STEP_PERCENT)).toBe(35);
    });

    it('(FR4) stepping stops at the bounds rather than running past them', () => {
      expect(stepSplitPercent(SPLIT_MIN_PERCENT, -SPLIT_COARSE_STEP_PERCENT)).toBe(
        SPLIT_MIN_PERCENT,
      );
      expect(stepSplitPercent(SPLIT_MAX_PERCENT, SPLIT_COARSE_STEP_PERCENT)).toBe(
        SPLIT_MAX_PERCENT,
      );
    });

    it('a run of fine steps accumulates exactly — no drift per keystroke', () => {
      let percent = SPLIT_MIN_PERCENT;
      for (let i = 0; i < 25; i++) {
        percent = stepSplitPercent(percent, SPLIT_FINE_STEP_PERCENT);
      }
      expect(percent).toBe(SPLIT_MIN_PERCENT + 25);
    });

    it('walks an out-of-range value back INTO the range rather than pinning it', () => {
      expect(stepSplitPercent(95, -SPLIT_COARSE_STEP_PERCENT)).toBe(60);
    });
  });

  describe('parseSplitPercent / formatSplitPercent', () => {
    it('(FR5) a stored width round-trips unchanged', () => {
      for (const percent of [SPLIT_MIN_PERCENT, 33.3, 50, SPLIT_MAX_PERCENT]) {
        expect(parseSplitPercent(formatSplitPercent(percent))).toBe(percent);
      }
    });

    it('reads nothing stored as nothing, so the caller can apply its own default', () => {
      expect(parseSplitPercent(null)).toBeNull();
      expect(parseSplitPercent('')).toBeNull();
      expect(parseSplitPercent('   ')).toBeNull();
    });

    it('an empty string is NOT zero — it must not read as a collapsed list', () => {
      expect(parseSplitPercent('')).not.toBe(SPLIT_MIN_PERCENT);
    });

    it('rejects a corrupt value rather than laying out from it', () => {
      expect(parseSplitPercent('forty')).toBeNull();
      expect(parseSplitPercent('40%')).toBeNull();
    });

    it('honours an out-of-range stored value at the nearest allowed width', () => {
      expect(parseSplitPercent('5')).toBe(SPLIT_MIN_PERCENT);
      expect(parseSplitPercent('99')).toBe(SPLIT_MAX_PERCENT);
    });

    it('never writes a width it would refuse to read back', () => {
      expect(formatSplitPercent(0)).toBe(String(SPLIT_MIN_PERCENT));
      expect(formatSplitPercent(1000)).toBe(String(SPLIT_MAX_PERCENT));
      expect(parseSplitPercent(formatSplitPercent(1000))).toBe(SPLIT_MAX_PERCENT);
    });
  });
});
