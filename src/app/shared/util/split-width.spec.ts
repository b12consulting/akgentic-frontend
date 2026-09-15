import {
  clampSplitPercent,
  DEFAULT_SPLIT_BOUNDS,
  formatSplitPercent,
  parseSplitPercent,
  SPLIT_COARSE_STEP_PERCENT,
  SPLIT_DEFAULT_PERCENT,
  SPLIT_FINE_STEP_PERCENT,
  SPLIT_MAX_PERCENT,
  SPLIT_MIN_PERCENT,
  SplitBounds,
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

  /**
   * R3: the bounds became a parameter.
   *
   * A second host arrived whose two panes can trade places, and this module
   * measures the LEFTMOST one — so a preference about one identified pane reads
   * as two different ranges depending on which side it is on. The parameter is
   * DEFAULTED, so every pre-R3 call site keeps its behaviour; these specs pin
   * both halves of that.
   */
  describe('(R3) an explicit range', () => {
    /** The console's range with the inspector leading. */
    const narrow: SplitBounds = { min: 18, max: 50 };
    /** The same preference with the conversation leading. */
    const mirrored: SplitBounds = { min: 50, max: 82 };

    it('the default really is the module range — an unpassed bound changes nothing', () => {
      expect(DEFAULT_SPLIT_BOUNDS).toEqual({
        min: SPLIT_MIN_PERCENT,
        max: SPLIT_MAX_PERCENT,
      });
      for (const raw of [-10, 0, 25, 40, 85, 200]) {
        expect(clampSplitPercent(raw, DEFAULT_SPLIT_BOUNDS))
          .withContext(String(raw))
          .toBe(clampSplitPercent(raw));
      }
    });

    it('clamps to the range it was handed', () => {
      expect(clampSplitPercent(65, narrow)).toBe(50);
      expect(clampSplitPercent(5, narrow)).toBe(18);
      expect(clampSplitPercent(30, narrow)).toBe(30);
    });

    it('clamps to a range that does not contain the module default either', () => {
      expect(clampSplitPercent(20, mirrored)).toBe(50);
      expect(clampSplitPercent(95, mirrored)).toBe(82);
    });

    /**
     * The non-finite fallback is the module default — but a caller whose range
     * does not CONTAIN 40 must not be handed 40. Returning a width outside the
     * range the caller just declared is the kind of thing that shows up as a
     * divider parked somewhere it cannot be dragged back from.
     */
    it('brings even its own fallback inside the range', () => {
      expect(clampSplitPercent(NaN, mirrored)).toBe(50);
      expect(clampSplitPercent(Infinity, mirrored)).toBe(50);
      expect(clampSplitPercent(NaN, narrow)).toBe(SPLIT_DEFAULT_PERCENT);
    });

    it('steps inside the range it was handed', () => {
      expect(stepSplitPercent(45, SPLIT_COARSE_STEP_PERCENT, narrow)).toBe(50);
      expect(stepSplitPercent(20, -SPLIT_FINE_STEP_PERCENT, narrow)).toBe(19);
      expect(stepSplitPercent(19, -SPLIT_COARSE_STEP_PERCENT, narrow)).toBe(18);
    });

    it('walks an out-of-range value back INTO the handed range, as it always did', () => {
      // Clamped before the step is added: 95 clamps to 50, then -10.
      expect(stepSplitPercent(95, -SPLIT_COARSE_STEP_PERCENT, narrow)).toBe(40);
    });

    it('parses a stored width against the range it was handed', () => {
      expect(parseSplitPercent('65', narrow)).toBe(50);
      expect(parseSplitPercent('30', narrow)).toBe(30);
      // Still structure first: a non-number is no preference at all, whatever
      // the range.
      expect(parseSplitPercent('forty', narrow)).toBeNull();
      expect(parseSplitPercent('', narrow)).toBeNull();
      expect(parseSplitPercent(null, narrow)).toBeNull();
    });

    it('formats against the range it was handed, so nothing unreadable is written', () => {
      expect(formatSplitPercent(65, narrow)).toBe('50');
      expect(parseSplitPercent(formatSplitPercent(65, narrow), narrow)).toBe(50);
    });

    it('measures a pointer against the range it was handed', () => {
      const geometry = {
        pointerX: 900,
        containerLeft: 0,
        containerWidth: 1000,
        dividerWidth: 0,
      };
      expect(splitPercentFromPointer(geometry)).toBe(SPLIT_MAX_PERCENT);
      expect(splitPercentFromPointer(geometry, narrow)).toBe(50);
      expect(splitPercentFromPointer(geometry, mirrored)).toBe(82);
    });

    it('still refuses an unmeasurable container, range or no range', () => {
      expect(
        splitPercentFromPointer(
          { pointerX: 900, containerLeft: 0, containerWidth: 0, dividerWidth: 0 },
          narrow,
        ),
      ).toBeNull();
    });
  });
});
