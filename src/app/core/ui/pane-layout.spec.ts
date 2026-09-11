import {
  clampInspectorPercent,
  clampRailWidth,
  DEFAULT_PANE_LAYOUT,
  formatPaneLayout,
  INSPECTOR_DEFAULT_PERCENT,
  INSPECTOR_MAX_PERCENT,
  INSPECTOR_MIN_PERCENT,
  inspectorPercentFromLeading,
  isInspectorSide,
  INSPECTOR_MIN_WIDTH_PX,
  leadingBounds,
  leadingPercent,
  pixelFloorPercent,
  oppositeSide,
  PANE_LAYOUT_STORAGE_KEY,
  PaneLayout,
  parsePaneLayout,
  RAIL_DEFAULT_WIDTH_PX,
  RAIL_MAX_TRACK_PERCENT,
  RAIL_MAX_WIDTH_PX,
  RAIL_MIN_WIDTH_PX,
  RAIL_NOMINAL_TRACK_PX,
  railBounds,
  railMaxWidth,
  railPercentOf,
  railWidthFromPercent,
} from './pane-layout';

/**
 * The pane-arrangement arithmetic, tested WITHOUT a browser.
 *
 * No TestBed, no fixture, no pointer — these are functions over numbers and
 * strings, and the bug they guard against is the one a rendered test cannot
 * see: a console that lays itself out slightly wrong on every reload, or a
 * swap that makes the panes jump because the stored quantity meant something
 * different on the other side.
 */
describe('pane-layout (R3)', () => {
  describe('clampInspectorPercent', () => {
    it('leaves a value inside the range alone', () => {
      expect(clampInspectorPercent(30)).toBe(30);
    });

    it('pins a collapse attempt at the floor — neither pane may vanish by dragging', () => {
      expect(clampInspectorPercent(0)).toBe(INSPECTOR_MIN_PERCENT);
      expect(clampInspectorPercent(-40)).toBe(INSPECTOR_MIN_PERCENT);
    });

    it('pins an overrun at the ceiling, so the conversation keeps half the row', () => {
      expect(clampInspectorPercent(100)).toBe(INSPECTOR_MAX_PERCENT);
      expect(clampInspectorPercent(180)).toBe(INSPECTOR_MAX_PERCENT);
    });

    it('admits both bounds themselves — the range is closed, not open', () => {
      expect(clampInspectorPercent(INSPECTOR_MIN_PERCENT)).toBe(INSPECTOR_MIN_PERCENT);
      expect(clampInspectorPercent(INSPECTOR_MAX_PERCENT)).toBe(INSPECTOR_MAX_PERCENT);
    });

    it('rounds to one decimal', () => {
      expect(clampInspectorPercent(33.333333)).toBe(33.3);
      expect(clampInspectorPercent(33.35)).toBe(33.4);
    });

    it('is idempotent — a clamped value cannot move by being clamped again', () => {
      for (const raw of [-10, 0, 18.04, 26.5, 33.333333, 49.99, 50, 120]) {
        expect(clampInspectorPercent(clampInspectorPercent(raw)))
          .withContext(String(raw))
          .toBe(clampInspectorPercent(raw));
      }
    });

    it('answers the default for a value that is not a number at all', () => {
      expect(clampInspectorPercent(NaN)).toBe(INSPECTOR_DEFAULT_PERCENT);
      expect(clampInspectorPercent(Infinity)).toBe(INSPECTOR_DEFAULT_PERCENT);
      expect(clampInspectorPercent(-Infinity)).toBe(INSPECTOR_DEFAULT_PERCENT);
    });

    /**
     * The bounds this epic deliberately did NOT inherit. `split-width.ts` caps
     * the leading pane at 70%, which here would be a ~1008px inspector on a
     * 1440px screen. Nothing about that is a test failure anywhere else, so it
     * is pinned here.
     */
    it('is bounded far more tightly than the home page split it does not reuse', () => {
      expect(INSPECTOR_MAX_PERCENT).toBeLessThan(70);
      expect(INSPECTOR_MIN_PERCENT).toBeLessThan(INSPECTOR_DEFAULT_PERCENT);
      expect(INSPECTOR_DEFAULT_PERCENT).toBeLessThan(INSPECTOR_MAX_PERCENT);
    });
  });

  describe('isInspectorSide / oppositeSide', () => {
    it('admits exactly the two literals', () => {
      expect(isInspectorSide('left')).toBeTrue();
      expect(isInspectorSide('right')).toBeTrue();
    });

    it('rejects everything else, including the near-misses a store might hold', () => {
      for (const value of ['LEFT', 'Right', '', 'centre', 0, 1, null, undefined, {}, []]) {
        expect(isInspectorSide(value)).withContext(JSON.stringify(value)).toBeFalse();
      }
    });

    it('flips, and flipping twice is the identity', () => {
      expect(oppositeSide('left')).toBe('right');
      expect(oppositeSide('right')).toBe('left');
      expect(oppositeSide(oppositeSide('left'))).toBe('left');
    });
  });

  /**
   * The conversion that stops a swap from jumping.
   *
   * The divider reports the LEFTMOST pane's share; the preference stores the
   * INSPECTOR's. Get the inversion wrong and a 26% inspector on the right comes
   * back as a 74% inspector on the left — which is not a failing assertion
   * anywhere, just a console that redraws itself wrong the first time anyone
   * uses the swap control.
   */
  describe('leadingPercent / inspectorPercentFromLeading', () => {
    it('is the same number when the inspector IS the leading pane', () => {
      expect(leadingPercent({ inspectorSide: 'left', inspectorPercent: 26 })).toBe(26);
    });

    it('is the complement when the conversation leads', () => {
      expect(leadingPercent({ inspectorSide: 'right', inspectorPercent: 26 })).toBe(74);
    });

    it('clamps before converting, so a corrupt width cannot escape through the inversion', () => {
      expect(leadingPercent({ inspectorSide: 'right', inspectorPercent: 500 })).toBe(
        100 - INSPECTOR_MAX_PERCENT,
      );
      expect(leadingPercent({ inspectorSide: 'left', inspectorPercent: NaN })).toBe(
        INSPECTOR_DEFAULT_PERCENT,
      );
    });

    it('round-trips on both sides — what the divider reports is what gets stored', () => {
      for (const side of ['left', 'right'] as const) {
        for (const percent of [INSPECTOR_MIN_PERCENT, 26, 33.3, INSPECTOR_MAX_PERCENT]) {
          const layout: PaneLayout = {
            inspectorSide: side,
            inspectorPercent: percent,
            railWidth: RAIL_DEFAULT_WIDTH_PX,
          };
          expect(inspectorPercentFromLeading(side, leadingPercent(layout)))
            .withContext(`${side} ${percent}`)
            .toBe(percent);
        }
      }
    });

    it('clamps what comes back from the divider, in the inspector frame', () => {
      // 10% of the row given to a right-hand inspector is below the floor.
      expect(inspectorPercentFromLeading('right', 90)).toBe(INSPECTOR_MIN_PERCENT);
      // 90% given to a left-hand inspector is above the ceiling.
      expect(inspectorPercentFromLeading('left', 90)).toBe(INSPECTOR_MAX_PERCENT);
    });

    it('answers the default for an unmeasurable report rather than a bound', () => {
      expect(inspectorPercentFromLeading('left', NaN)).toBe(INSPECTOR_DEFAULT_PERCENT);
      expect(inspectorPercentFromLeading('right', Infinity)).toBe(INSPECTOR_DEFAULT_PERCENT);
    });
  });

  describe('leadingBounds', () => {
    it('hands the inspector its own bounds when it leads', () => {
      expect(leadingBounds('left')).toEqual({
        min: INSPECTOR_MIN_PERCENT,
        max: INSPECTOR_MAX_PERCENT,
      });
    });

    it('mirrors them when the conversation leads', () => {
      expect(leadingBounds('right')).toEqual({
        min: 100 - INSPECTOR_MAX_PERCENT,
        max: 100 - INSPECTOR_MIN_PERCENT,
      });
    });

    /**
     * The reason the divider's bounds had to become inputs at all: the two
     * sides need different pairs, so no single module constant pair can serve
     * both. Dragging to a bound on one side must reach the SAME inspector width
     * as dragging to the mirrored bound on the other.
     */
    it('describes one preference from two directions', () => {
      for (const side of ['left', 'right'] as const) {
        const { min, max } = leadingBounds(side);
        const atMin = inspectorPercentFromLeading(side, min);
        const atMax = inspectorPercentFromLeading(side, max);
        expect([atMin, atMax].sort((a, b) => a - b))
          .withContext(side)
          .toEqual([INSPECTOR_MIN_PERCENT, INSPECTOR_MAX_PERCENT]);
      }
    });

    /**
     * THE NARROW-END DEAD ZONE, stated as the property that closes it.
     *
     * The inspector is `flex-basis` + `min-width: 240px`, and `min-width` wins.
     * So a divider clamped to a flat 18% accepts — and persists — percentages
     * the pane will never adopt: the handle keeps tracking the pointer and the
     * boundary stops. These are the two widths that matter, and both of them
     * are ordinary laptops rather than edge cases: 1440px is the width the
     * console was drawn against.
     *
     * The assertion is deliberately about PIXELS, not about a magic percentage.
     * What has to be true is that the narrowest width the divider will hand
     * back is a width the pane can actually be.
     */
    describe('reconciles the percentage floor with the CSS pixel floor', () => {
      // viewport minus the 268px rail.
      const rows = [
        { viewport: 1440, width: 1180 },
        { viewport: 1280, width: 1020 },
      ];

      for (const { viewport, width } of rows) {
        it(`yields a reachable inspector at ${viewport}px, where 18% does not`, () => {
          // The premise: at this width the percentage floor is the WRONG floor.
          expect((INSPECTOR_MIN_PERCENT / 100) * width).toBeLessThan(
            INSPECTOR_MIN_WIDTH_PX,
          );

          for (const side of ['left', 'right'] as const) {
            const { min, max } = leadingBounds(side, width);
            // Whichever end of the divider's range puts the inspector at its
            // narrowest, that width must be one the pane will adopt.
            const narrowest = Math.min(
              inspectorPercentFromLeading(side, min),
              inspectorPercentFromLeading(side, max),
            );
            expect((narrowest / 100) * width)
              .withContext(`${side} @ ${viewport}px`)
              .toBeGreaterThanOrEqual(INSPECTOR_MIN_WIDTH_PX);
          }
        });
      }

      it('leaves the percentage floor alone once the row is wide enough', () => {
        // 240px is 18% of 1333px, so above that the preference is the binding
        // constraint again and nothing should move.
        expect(leadingBounds('left', 1600)).toEqual({
          min: INSPECTOR_MIN_PERCENT,
          max: INSPECTOR_MAX_PERCENT,
        });
      });

      it('falls back to the percentage floor when nothing has been measured', () => {
        // The pre-R3 answer, which is the right one for a caller that has not
        // laid out yet — a floor derived from a width nobody measured is a
        // guess dressed up as a guarantee.
        expect(leadingBounds('left')).toEqual({
          min: INSPECTOR_MIN_PERCENT,
          max: INSPECTOR_MAX_PERCENT,
        });
        expect(leadingBounds('left', 0)).toEqual({
          min: INSPECTOR_MIN_PERCENT,
          max: INSPECTOR_MAX_PERCENT,
        });
        expect(leadingBounds('left', Number.NaN)).toEqual({
          min: INSPECTOR_MIN_PERCENT,
          max: INSPECTOR_MAX_PERCENT,
        });
      });

      it('never returns a min above its own max, however narrow the row', () => {
        // Below a 480px row the pixel floor exceeds the ceiling. A range no
        // clamp can satisfy is worse than a wrong one: `clampSplitPercent`
        // would return the max for every input, pinning the divider.
        for (const width of [1, 120, 300, 479, 480]) {
          for (const side of ['left', 'right'] as const) {
            const { min, max } = leadingBounds(side, width);
            expect(min).withContext(`${side} @ ${width}px`).toBeLessThanOrEqual(max);
          }
        }
      });

      it('states the conversion once, so the two floors cannot drift', () => {
        expect(pixelFloorPercent(1180)).toBe(20.4);
        expect(pixelFloorPercent(1020)).toBe(23.6);
        expect(pixelFloorPercent(null)).toBe(INSPECTOR_MIN_PERCENT);
      });
    });
  });

  /**
   * Every corruption mode a real browser can hand back. This is the function
   * that stands between a stale or hand-edited storage entry and a console that
   * throws on boot, so it is exercised against the whole zoo rather than
   * against the happy path plus one.
   */
  /**
   * THE RAIL (W8b).
   *
   * The rail's boundary is the same component, driving the same document,
   * through a frame conversion this block is the whole test of: the divider
   * speaks per cent of a measured row and the rail is stored in pixels. The
   * bug this guards against is silent by construction — a conversion that is
   * off by a rounding direction produces a rail that will not go quite to its
   * own limit, or that reports a limit the cascade then refuses, and neither
   * throws anything.
   */
  describe('the rail is measured in pixels, and dragged in per cent', () => {
    describe('railMaxWidth', () => {
      it('is the pixel ceiling on a row wide enough to allow it', () => {
        // 420px is 26% of ~1615px, so anything wider is bounded by the pixel
        // ceiling rather than by the viewport cap.
        expect(railMaxWidth(2400)).toBe(RAIL_MAX_WIDTH_PX);
      });

      /**
       * THE DEAD ZONE THIS EXISTS TO CLOSE. `max-width: 26vw` beats `width`,
       * so on any ordinary laptop it is the CAP, not `RAIL_MAX_WIDTH_PX`, that
       * decides how wide the rail can get. A divider bounded by the pixel
       * ceiling alone would keep accepting widths the rail will never adopt:
       * the handle moves, the boundary does not, and the value is persisted.
       */
      it('is the viewport cap on every row the cap actually binds', () => {
        expect(railMaxWidth(1440)).toBe(374); // floor(1440 * 0.26)
        expect(railMaxWidth(1280)).toBe(332);
        expect(railMaxWidth(1440)).toBeLessThan(RAIL_MAX_WIDTH_PX);
      });

      it('states the cap once, so the two copies of 26% cannot drift', () => {
        for (const row of [1024, 1280, 1440, 1600]) {
          expect(railMaxWidth(row))
            .withContext(`${row}px`)
            .toBe(Math.min(RAIL_MAX_WIDTH_PX, Math.floor((row * RAIL_MAX_TRACK_PERCENT) / 100)));
        }
      });

      it('never returns a ceiling below its own floor, however narrow the row', () => {
        // On a 600px row the cap is 156px — under the rail's floor. A `min`
        // above its `max` is a range no clamp can satisfy; CSS squeezes the
        // rail at that point whatever this says.
        expect(railMaxWidth(600)).toBe(RAIL_MIN_WIDTH_PX);
        expect(railMaxWidth(1)).toBe(RAIL_MIN_WIDTH_PX);
      });

      /**
       * An unmeasured row is NOT a 1440px row. The nominal width exists so
       * that a ratio has a denominator; a cap has an honest answer without
       * one, and applying a stand-in viewport's cap to a stored preference
       * would trim a width against a window nobody ever opened.
       */
      it('imposes no cap at all when there is no row to cap against', () => {
        expect(railMaxWidth(null)).toBe(RAIL_MAX_WIDTH_PX);
        expect(railMaxWidth(0)).toBe(RAIL_MAX_WIDTH_PX);
        expect(railMaxWidth(Number.NaN)).toBe(RAIL_MAX_WIDTH_PX);
        expect(railMaxWidth(RAIL_NOMINAL_TRACK_PX)).toBeLessThan(RAIL_MAX_WIDTH_PX);
      });
    });

    describe('clampRailWidth', () => {
      it('leaves a width inside the range alone', () => {
        expect(clampRailWidth(300, 1440)).toBe(300);
      });

      it('(FR4) pins a collapse attempt at the floor — dragging may not erase a pane', () => {
        expect(clampRailWidth(0, 1440)).toBe(RAIL_MIN_WIDTH_PX);
        expect(clampRailWidth(-500, 1440)).toBe(RAIL_MIN_WIDTH_PX);
      });

      it('pins an overrun at whatever the ceiling is on THIS row', () => {
        expect(clampRailWidth(9000, 1440)).toBe(374);
        expect(clampRailWidth(9000, 2400)).toBe(RAIL_MAX_WIDTH_PX);
      });

      /**
       * THE ASYMMETRY THAT KEEPS A SMALL WINDOW FROM EATING A PREFERENCE. With
       * no row in the argument list the answer is the pixel range alone —
       * which is what the STORE wants. Applied to the store, the cap would
       * mean that opening the console once on a laptop permanently narrows a
       * rail widened on a desktop.
       */
      it('leaves the window out of it when no row is given', () => {
        expect(clampRailWidth(400)).toBe(400);
        expect(clampRailWidth(400, 1280)).toBe(332);
      });

      it('rounds to whole pixels, and is idempotent at every row width', () => {
        expect(clampRailWidth(300.4, 1440)).toBe(300);
        for (const row of [null, 900, 1280, 1440, 2400]) {
          for (const width of [0, 209.6, 268, 373.9, 1000]) {
            const once = clampRailWidth(width, row);
            expect(clampRailWidth(once, row))
              .withContext(`${String(row)} / ${width}`)
              .toBe(once);
          }
        }
      });

      it('answers the default for a width that is not a number at all', () => {
        expect(clampRailWidth(Number.NaN, 1440)).toBe(RAIL_DEFAULT_WIDTH_PX);
        expect(clampRailWidth(Number.POSITIVE_INFINITY, 1440)).toBe(RAIL_DEFAULT_WIDTH_PX);
      });
    });

    describe('railBounds / railPercentOf / railWidthFromPercent', () => {
      /**
       * The property that matters more than any single number: pressing Home
       * or End on the divider must land the rail EXACTLY on its own limit. A
       * bound rounded inwards names a percentage worth 209px, and the rail
       * then cannot be dragged to the 208 it claims as its minimum — a dead
       * pixel at each end that no error reports.
       */
      it('hands the divider bounds that reach the pixel range EXACTLY', () => {
        for (const row of [1024, 1280, 1440, 1920, 2560]) {
          const bounds = railBounds(row);
          expect(railWidthFromPercent(bounds.min, row))
            .withContext(`min @ ${row}`)
            .toBe(RAIL_MIN_WIDTH_PX);
          expect(railWidthFromPercent(bounds.max, row))
            .withContext(`max @ ${row}`)
            .toBe(railMaxWidth(row));
        }
      });

      it('never reports an inverted range, however narrow the row', () => {
        for (const row of [1, 200, 600, 1440]) {
          const bounds = railBounds(row);
          expect(bounds.min).withContext(`${row}px`).toBeLessThanOrEqual(bounds.max);
        }
      });

      /**
       * A tenth of a per cent is ~1.4px on this row, so the round trip is
       * accurate to a pixel and no better. That is a property of driving a
       * pixel width from a percentage divider, not a defect — what would be a
       * defect is DRIFT, a width that moves a little further every time it is
       * read back and re-reported, which the second assertion rules out.
       */
      it('round-trips a width the user actually dragged to, to the pixel', () => {
        for (const width of [RAIL_MIN_WIDTH_PX, 240, 268, 300, 374]) {
          const back = railWidthFromPercent(railPercentOf(width, 1440), 1440);
          expect(Math.abs(back - width))
            .withContext(`${width}px -> ${back}px`)
            .toBeLessThanOrEqual(1);
          expect(railWidthFromPercent(railPercentOf(back, 1440), 1440))
            .withContext(`${width}px does not drift`)
            .toBe(back);
        }
      });

      it('reports a width already out of range at the nearest reachable one', () => {
        expect(railPercentOf(9000, 1440)).toBe(railPercentOf(374, 1440));
        expect(railPercentOf(0, 1440)).toBe(railPercentOf(RAIL_MIN_WIDTH_PX, 1440));
      });

      it('answers the default width for a percentage that is not a number', () => {
        expect(railWidthFromPercent(Number.NaN, 1440)).toBe(RAIL_DEFAULT_WIDTH_PX);
      });

      it('clamps what the divider reports, so a bad report cannot escape', () => {
        expect(railWidthFromPercent(90, 1440)).toBe(374);
        expect(railWidthFromPercent(-10, 1440)).toBe(RAIL_MIN_WIDTH_PX);
      });

      it('keeps the default reachable on every row a console is opened at', () => {
        // Double-click restores `RAIL_DEFAULT_WIDTH_PX`; on a row where the cap
        // is below it, restoring must land on the cap rather than throw the
        // gesture away.
        for (const row of [1024, 1280, 1440, 2560]) {
          const restored = railWidthFromPercent(railPercentOf(RAIL_DEFAULT_WIDTH_PX, row), row);
          // To the pixel, for the reason the round-trip spec above states: a
          // tenth of a per cent is a pixel or so of a real window.
          expect(Math.abs(restored - clampRailWidth(RAIL_DEFAULT_WIDTH_PX, row)))
            .withContext(`${row}px -> ${restored}px`)
            .toBeLessThanOrEqual(1);
        }
      });
    });

    it('mirrors the CSS token rather than inventing a second default', () => {
      // `--akg-rail-width: 268px`. The cascade applies the token, the drag
      // arithmetic runs here, and neither can read the other — so the one
      // thing worth pinning is that there is exactly one duplicate.
      expect(RAIL_DEFAULT_WIDTH_PX).toBe(268);
      expect(DEFAULT_PANE_LAYOUT.railWidth).toBe(RAIL_DEFAULT_WIDTH_PX);
    });
  });

  describe('parsePaneLayout', () => {
    it('reads back exactly what was written', () => {
      const layout: PaneLayout = {
        inspectorSide: 'left',
        inspectorPercent: 33.3,
        railWidth: 300,
      };
      expect(parsePaneLayout(formatPaneLayout(layout))).toEqual(layout);
    });

    it('round-trips the default, so a fresh browser and a stored default agree', () => {
      expect(parsePaneLayout(formatPaneLayout(DEFAULT_PANE_LAYOUT))).toEqual(
        DEFAULT_PANE_LAYOUT,
      );
    });

    it('answers null for nothing stored', () => {
      expect(parsePaneLayout(null)).toBeNull();
    });

    it('answers null for an empty or blank entry rather than reading it as zero', () => {
      expect(parsePaneLayout('')).toBeNull();
      expect(parsePaneLayout('   ')).toBeNull();
      expect(parsePaneLayout('\n\t')).toBeNull();
    });

    it('answers null for something that is not JSON at all', () => {
      for (const raw of ['left', '{oops', '26', 'undefined', '{"a":}']) {
        expect(parsePaneLayout(raw)).withContext(raw).toBeNull();
      }
    });

    it('answers null for valid JSON of the wrong shape', () => {
      // An array is `typeof 'object'`, and so is `null`. Both would otherwise
      // survive as far as the property reads and look like a missing field.
      for (const raw of ['[]', '["left", 26]', 'null', 'true', '42', '"left"']) {
        expect(parsePaneLayout(raw)).withContext(raw).toBeNull();
      }
    });

    it('answers null for a HALF preference — a side without a width, or the reverse', () => {
      expect(parsePaneLayout('{"inspectorSide":"left"}')).toBeNull();
      expect(parsePaneLayout('{"inspectorPercent":26}')).toBeNull();
      expect(parsePaneLayout('{}')).toBeNull();
    });

    it('answers null for a side that is not one of the two literals', () => {
      for (const side of ['LEFT', 'centre', '', '0', 'null']) {
        expect(parsePaneLayout(`{"inspectorSide":"${side}","inspectorPercent":26}`))
          .withContext(side)
          .toBeNull();
      }
    });

    it('answers null for a percent that is not a finite number', () => {
      // `null` and a quoted number are both shape problems, not range ones:
      // this module writes numbers, so anything else came from somewhere else.
      for (const percent of ['null', '"26"', 'true', '{}', '[]']) {
        expect(parsePaneLayout(`{"inspectorSide":"left","inspectorPercent":${percent}}`))
          .withContext(percent)
          .toBeNull();
      }
    });

    it('CLAMPS a width that is merely out of range — it is still a preference', () => {
      expect(parsePaneLayout('{"inspectorSide":"left","inspectorPercent":99}')).toEqual({
        inspectorSide: 'left',
        inspectorPercent: INSPECTOR_MAX_PERCENT,
        railWidth: RAIL_DEFAULT_WIDTH_PX,
      });
      expect(parsePaneLayout('{"inspectorSide":"right","inspectorPercent":1}')).toEqual({
        inspectorSide: 'right',
        inspectorPercent: INSPECTOR_MIN_PERCENT,
        railWidth: RAIL_DEFAULT_WIDTH_PX,
      });
    });

    /**
     * DELIBERATE REQUIREMENT CHANGE, NOT A REGRESSION (W8b).
     *
     * This assertion used to read `railWidth` as an unknown field and drop it,
     * which was correct while the rail could not be dragged. It can now, and
     * its width is a field of this document by design — one preference, one
     * key. The rule the old test was really pinning is the one below it:
     * fields this module does not write are still ignored. Both are kept,
     * because the reason for the first is now a property of a NAMED field and
     * not of unknown fields in general.
     */
    it('adopts a rail width, clamped into the rail\'s own range', () => {
      expect(
        parsePaneLayout('{"inspectorSide":"left","inspectorPercent":26,"railWidth":320}'),
      ).toEqual({ inspectorSide: 'left', inspectorPercent: 26, railWidth: 320 });

      // 99px is a width this module would never write. It is still a statement
      // of preference, so it is honoured at the nearest reachable width rather
      // than discarded — the same RANGE-versus-STRUCTURE line the inspector's
      // percentage is held to.
      expect(
        parsePaneLayout('{"inspectorSide":"left","inspectorPercent":26,"railWidth":99}'),
      ).toEqual({
        inspectorSide: 'left',
        inspectorPercent: 26,
        railWidth: RAIL_MIN_WIDTH_PX,
      });
    });

    it('ignores fields it does not know about', () => {
      expect(
        parsePaneLayout(
          '{"inspectorSide":"left","inspectorPercent":26,"somethingElse":99}',
        ),
      ).toEqual({
        inspectorSide: 'left',
        inspectorPercent: 26,
        railWidth: RAIL_DEFAULT_WIDTH_PX,
      });
    });

    /**
     * THE MIGRATION, and the one case a user actually lives through: every
     * arrangement stored before this round is a two-field document.
     *
     * Two promises, and the second is the one that would hurt. It must not
     * throw — and it must not RESET, because the field that is missing is the
     * rail's and the fields that are present are the inspector's.
     */
    it('reads a pre-rail document without throwing and without losing the inspector', () => {
      expect(
        parsePaneLayout('{"inspectorSide":"left","inspectorPercent":33.3}'),
      ).toEqual({
        inspectorSide: 'left',
        inspectorPercent: 33.3,
        railWidth: RAIL_DEFAULT_WIDTH_PX,
      });
    });

    /**
     * The other side of the migration: a document written NOW, read by a build
     * that predates the rail field, is still a valid two-field document —
     * because the default is stored as absence. Pinned as a round trip through
     * the only thing that writes the key.
     */
    it('writes nothing at all for a rail nobody has moved', () => {
      const raw = formatPaneLayout({
        inspectorSide: 'right',
        inspectorPercent: 26,
        railWidth: RAIL_DEFAULT_WIDTH_PX,
      });

      expect(Object.keys(JSON.parse(raw) as object)).toEqual([
        'inspectorSide',
        'inspectorPercent',
      ]);
      // …and reading it back still yields the default, so the omission is
      // lossless rather than merely quiet.
      expect(parsePaneLayout(raw)!.railWidth).toBe(RAIL_DEFAULT_WIDTH_PX);
    });

    it('writes a rail width the moment it is not the default', () => {
      const raw = formatPaneLayout({
        inspectorSide: 'right',
        inspectorPercent: 26,
        railWidth: 300,
      });

      expect(JSON.parse(raw)).toEqual({
        inspectorSide: 'right',
        inspectorPercent: 26,
        railWidth: 300,
      });
    });

    /**
     * PRESENT BUT MALFORMED is not the migration case. A writer that put a
     * string there is not a version of this module, which makes the rest of
     * what it wrote untrustworthy too — the same verdict a malformed
     * `inspectorPercent` gets.
     */
    it('rejects a rail width of the wrong SHAPE, as it does any other field', () => {
      expect(
        parsePaneLayout('{"inspectorSide":"left","inspectorPercent":26,"railWidth":"300"}'),
      ).toBeNull();
      expect(
        parsePaneLayout('{"inspectorSide":"left","inspectorPercent":26,"railWidth":null}'),
      ).toBeNull();
      expect(
        parsePaneLayout('{"inspectorSide":"left","inspectorPercent":26,"railWidth":1e400}'),
      ).toBeNull();
    });

    it('never throws, whatever it is handed', () => {
      const zoo = [
        null,
        '',
        '{',
        '}',
        '[',
        'NaN',
        '{"inspectorSide":{"toString":1},"inspectorPercent":{}}',
        '{"inspectorPercent":1e400,"inspectorSide":"left"}',
        String.fromCharCode(0),
      ];
      for (const raw of zoo) {
        expect(() => parsePaneLayout(raw)).withContext(String(raw)).not.toThrow();
      }
    });

    /**
     * `1e400` is `Infinity` once JSON.parse has had it — a value that is a
     * number, is not finite, and did not come from an obviously broken string.
     * Clamping it would silently produce the default width and hide the fact
     * that the entry is nonsense.
     */
    it('rejects an overflowed number rather than clamping it to a width', () => {
      expect(parsePaneLayout('{"inspectorSide":"left","inspectorPercent":1e400}')).toBeNull();
    });
  });

  describe('formatPaneLayout', () => {
    it('writes an object this module can read back', () => {
      const raw = formatPaneLayout({
        inspectorSide: 'right',
        inspectorPercent: 40,
        railWidth: RAIL_DEFAULT_WIDTH_PX,
      });
      // No `railWidth` in the output: the default is written as absence, which
      // is how it is read. See the round-trip pair in `parsePaneLayout` above.
      expect(JSON.parse(raw)).toEqual({ inspectorSide: 'right', inspectorPercent: 40 });
    });

    it('never writes a width it would refuse to restore', () => {
      const raw = formatPaneLayout({
        inspectorSide: 'left',
        inspectorPercent: 1000,
        railWidth: 9000,
      });
      expect(parsePaneLayout(raw)).toEqual({
        inspectorSide: 'left',
        inspectorPercent: INSPECTOR_MAX_PERCENT,
        railWidth: RAIL_MAX_WIDTH_PX,
      });
    });

    it('turns an unusable width into the default rather than a bound', () => {
      const raw = formatPaneLayout({
        inspectorSide: 'right',
        inspectorPercent: NaN,
        railWidth: NaN,
      });
      expect(parsePaneLayout(raw)).toEqual({
        inspectorSide: 'right',
        inspectorPercent: INSPECTOR_DEFAULT_PERCENT,
        railWidth: RAIL_DEFAULT_WIDTH_PX,
      });
    });
  });

  describe('the storage key', () => {
    /**
     * `akgentic.home.split-percent` is the home page's dragged width. R1 orphans
     * it, and reusing it here would inherit one page's preference as another's
     * — a width nobody set, for a pane that is not the one they dragged.
     */
    it('is its own, not the home page\'s orphaned one', () => {
      expect(PANE_LAYOUT_STORAGE_KEY).toBe('akgentic.console.pane-layout');
      expect(PANE_LAYOUT_STORAGE_KEY).not.toBe('akgentic.home.split-percent');
    });
  });
});
