import { TestBed } from '@angular/core/testing';

import {
  DEFAULT_PANE_LAYOUT,
  INSPECTOR_DEFAULT_PERCENT,
  INSPECTOR_MAX_PERCENT,
  INSPECTOR_MIN_PERCENT,
  INSPECTOR_MIN_WIDTH_PX,
  PANE_LAYOUT_STORAGE_KEY,
  PaneLayout,
  RAIL_DEFAULT_WIDTH_PX,
  RAIL_MAX_WIDTH_PX,
  RAIL_MIN_WIDTH_PX,
} from './pane-layout';
import { PaneLayoutService } from './pane-layout.service';

/**
 * The persistence half of R3.
 *
 * The arithmetic is covered DOM-free in `pane-layout.spec.ts`; what is left for
 * this file is the part that talks to the browser: that the stored arrangement
 * is in hand before anything renders, that one drag costs exactly one write,
 * and that a browser which refuses storage outright costs the preference rather
 * than the console.
 */
describe('PaneLayoutService (R3)', () => {
  /**
   * Built lazily, because the constructor is where the read happens: a spec
   * that wants to see a stored value — or a throwing store — has to arrange it
   * BEFORE the service exists.
   */
  function service(): PaneLayoutService {
    return TestBed.inject(PaneLayoutService);
  }

  /**
   * Seeds the key DIRECTLY, not through `formatPaneLayout`, so that a spec can
   * arrange a document this module would not write — including the pre-rail
   * two-field one every existing browser actually holds.
   */
  function store(layout: Partial<PaneLayout>): void {
    localStorage.setItem(PANE_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  }

  function stored(): Partial<PaneLayout> | null {
    const raw = localStorage.getItem(PANE_LAYOUT_STORAGE_KEY);
    return raw === null ? null : (JSON.parse(raw) as Partial<PaneLayout>);
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    localStorage.removeItem(PANE_LAYOUT_STORAGE_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(PANE_LAYOUT_STORAGE_KEY);
  });

  describe('hydration', () => {
    it('starts on the default arrangement when nothing is stored', () => {
      expect(service().layout()).toEqual(DEFAULT_PANE_LAYOUT);
      expect(service().inspectorSide()).toBe('right');
      expect(service().inspectorPercent()).toBe(INSPECTOR_DEFAULT_PERCENT);
    });

    /**
     * Read in the CONSTRUCTOR, not on first subscription: the service is
     * root-scoped and built once, so the first paint of the console already has
     * the stored arrangement and there is no frame of default layout to see.
     */
    it('adopts a stored arrangement before anyone asks for it', () => {
      store({ inspectorSide: 'left', inspectorPercent: 40 });

      expect(service().layout()).toEqual({
        inspectorSide: 'left',
        inspectorPercent: 40,
        railWidth: RAIL_DEFAULT_WIDTH_PX,
      });
    });

    it('clamps a stored width that is out of range rather than discarding it', () => {
      store({ inspectorSide: 'left', inspectorPercent: 95 });

      expect(service().inspectorPercent()).toBe(INSPECTOR_MAX_PERCENT);
    });

    it('falls back to the default for a corrupt entry rather than laying out from it', () => {
      localStorage.setItem(PANE_LAYOUT_STORAGE_KEY, 'not json at all');

      expect(service().layout()).toEqual(DEFAULT_PANE_LAYOUT);
    });

    it('falls back to the default for a HALF entry — a side with no width', () => {
      localStorage.setItem(PANE_LAYOUT_STORAGE_KEY, '{"inspectorSide":"left"}');

      expect(service().layout()).toEqual(DEFAULT_PANE_LAYOUT);
    });

    /**
     * `localStorage.getItem` does not return null when the origin is blocked —
     * it THROWS. An unwrapped read here is a console that fails to boot in
     * Safari private browsing and inside a cookie-blocked iframe, which is
     * exactly where this app is embedded.
     */
    it('boots on the default when the browser refuses to be read', () => {
      spyOn(Storage.prototype, 'getItem').and.throwError('SecurityError');

      expect(() => service()).not.toThrow();
      expect(service().layout()).toEqual(DEFAULT_PANE_LAYOUT);
    });
  });

  describe('the two channels are not the same event', () => {
    /**
     * The whole reason the divider has two outputs. `setPercent` runs on every
     * pointer move; a version of it that wrote storage would write sixty times
     * for one drag.
     */
    it('a live move lays out but stores NOTHING', () => {
      const s = service();

      s.setPercent(30);
      s.setPercent(31);
      s.setPercent(32);

      expect(s.inspectorPercent()).toBe(32);
      expect(stored()).toBeNull();
    });

    it('the drop persists, once', () => {
      const s = service();
      const setItem = spyOn(Storage.prototype, 'setItem').and.callThrough();

      s.setPercent(30);
      s.setPercent(31);
      expect(setItem).not.toHaveBeenCalled();

      s.commitPercent(31);

      expect(setItem).toHaveBeenCalledTimes(1);
      expect(stored()).toEqual({ inspectorSide: 'right', inspectorPercent: 31 });
    });

    it('a commit carrying a NEW width both lays out and persists it', () => {
      const s = service();

      s.commitPercent(44);

      expect(s.inspectorPercent()).toBe(44);
      expect(stored()!.inspectorPercent).toBe(44);
    });

    it('never stores a width it would refuse to read back', () => {
      const s = service();

      s.commitPercent(1000);

      expect(s.inspectorPercent()).toBe(INSPECTOR_MAX_PERCENT);
      expect(stored()!.inspectorPercent).toBe(INSPECTOR_MAX_PERCENT);
    });

    it('clamps a live move too, so the signal never holds an unlayoutable width', () => {
      const s = service();

      s.setPercent(-50);

      expect(s.inspectorPercent()).toBe(INSPECTOR_MIN_PERCENT);
    });

    /** As the read: a refused write costs the preference, not the session. */
    it('survives a browser that refuses to be written to', () => {
      const s = service();
      spyOn(Storage.prototype, 'setItem').and.throwError('QuotaExceededError');

      expect(() => s.commitPercent(35)).not.toThrow();
      expect(() => s.swap()).not.toThrow();
      // The arrangement still applies for this visit; only the memory is lost.
      expect(s.inspectorPercent()).toBe(35);
      expect(s.inspectorSide()).toBe('left');
    });
  });

  describe('swapping sides', () => {
    it('moves the inspector to the other side and remembers it', () => {
      const s = service();
      expect(s.inspectorSide()).toBe('right');

      s.swap();

      expect(s.inspectorSide()).toBe('left');
      expect(stored()).toEqual({ inspectorSide: 'left', inspectorPercent: INSPECTOR_DEFAULT_PERCENT });
    });

    it('swapping twice comes back to where it started', () => {
      const s = service();

      s.swap();
      s.swap();

      expect(s.inspectorSide()).toBe('right');
    });

    /**
     * The stored quantity is the INSPECTOR's share, always. If it were the
     * leading pane's share instead, this swap would resize the pane as well as
     * move it — a 30% inspector reappearing as a 70% one — and nothing else in
     * the suite would notice.
     */
    it('carries the width across unchanged: a swap moves the pane, it does not resize it', () => {
      const s = service();
      s.commitPercent(30);

      s.swap();

      expect(s.inspectorPercent()).toBe(30);
      expect(stored()).toEqual({ inspectorSide: 'left', inspectorPercent: 30 });
    });
  });

  describe('the divider frame', () => {
    it('reports the leading share as the inspector share when it is on the left', () => {
      store({ inspectorSide: 'left', inspectorPercent: 30 });

      expect(service().leadingPercent()).toBe(30);
    });

    it('reports the complement when the conversation leads', () => {
      store({ inspectorSide: 'right', inspectorPercent: 30 });

      expect(service().leadingPercent()).toBe(70);
    });

    it('mirrors the bounds with the side, so the clamp follows the pane', () => {
      const s = service();

      expect(s.leadingBounds()).toEqual({
        min: 100 - INSPECTOR_MAX_PERCENT,
        max: 100 - INSPECTOR_MIN_PERCENT,
      });

      s.swap();

      expect(s.leadingBounds()).toEqual({
        min: INSPECTOR_MIN_PERCENT,
        max: INSPECTOR_MAX_PERCENT,
      });
    });

    /**
     * The measured row width is the OTHER input to the same question.
     *
     * The service is proud of being DOM-free and it still is — it does not
     * measure, it is told. What it owns is the consequence, because "how narrow
     * may the inspector get" has one right answer and it depends on both the
     * arrangement and the row. Two owners for one answer is how the percentage
     * floor and the CSS pixel floor got out of step to begin with.
     */
    it('raises the floor once it knows the row is too narrow for 18% to mean 240px', () => {
      const s = service();
      s.swap(); // inspector on the left, so the bounds read directly.

      expect(s.leadingBounds().min).toBe(INSPECTOR_MIN_PERCENT);

      // 1440px viewport minus the 268px rail.
      s.setTrackWidth(1180);

      expect(s.leadingBounds().min).toBeGreaterThan(INSPECTOR_MIN_PERCENT);
      expect((s.leadingBounds().min / 100) * 1180).toBeGreaterThanOrEqual(
        INSPECTOR_MIN_WIDTH_PX,
      );
    });

    it('mirrors the raised floor onto the other side too', () => {
      const s = service(); // inspector on the right by default.
      s.setTrackWidth(1180);

      // The conversation leads, so the inspector's floor is the CEILING of the
      // leading pane's range. A fix applied to `min` alone would leave the
      // dead zone intact for exactly half the arrangements.
      expect(s.leadingBounds().max).toBeLessThan(100 - INSPECTOR_MIN_PERCENT);
      expect(((100 - s.leadingBounds().max) / 100) * 1180).toBeGreaterThanOrEqual(
        INSPECTOR_MIN_WIDTH_PX,
      );
    });

    it('forgets a retracted measurement rather than bounding against a dead row', () => {
      const s = service();
      s.setTrackWidth(1180);
      const narrow = s.leadingBounds();

      s.setTrackWidth(null);

      expect(s.leadingBounds()).not.toEqual(narrow);
      expect(s.leadingBounds()).toEqual({
        min: 100 - INSPECTOR_MAX_PERCENT,
        max: 100 - INSPECTOR_MIN_PERCENT,
      });
    });

    it('treats an unmeasurable width as no measurement at all', () => {
      const s = service();

      // A detached element reports 0; a pre-layout read can report NaN. Neither
      // is a row, and a floor derived from either would be arithmetic on noise.
      for (const width of [0, -1, Number.NaN]) {
        s.setTrackWidth(1180);
        s.setTrackWidth(width);
        expect(s.leadingBounds())
          .withContext(String(width))
          .toEqual({
            min: 100 - INSPECTOR_MAX_PERCENT,
            max: 100 - INSPECTOR_MIN_PERCENT,
          });
      }
    });
  });

  /**
   * THE RAIL'S HALF OF THE SAME PREFERENCE (W8b).
   *
   * Two boundaries, one document, one key — which is the only thing that stops
   * a rail drag and an inspector drag from overwriting each other with their
   * own stale copy of the other's value. That is what most of this block is
   * actually testing; the clamping arithmetic is proved DOM-free next door.
   */
  describe('the rail', () => {
    it('starts at the width the token draws it at', () => {
      expect(service().railWidth()).toBe(RAIL_DEFAULT_WIDTH_PX);
    });

    it('adopts a stored rail width before anyone asks for it', () => {
      store({ inspectorSide: 'right', inspectorPercent: 26, railWidth: 340 });

      expect(service().railWidth()).toBe(340);
    });

    /**
     * THE MIGRATION, at the layer the user meets it: every browser that has
     * ever opened this console holds a two-field document.
     */
    it('reads a pre-rail arrangement without losing the inspector preference', () => {
      store({ inspectorSide: 'left', inspectorPercent: 44 });

      const s = service();
      expect(s.inspectorSide()).toBe('left');
      expect(s.inspectorPercent()).toBe(44);
      expect(s.railWidth()).toBe(RAIL_DEFAULT_WIDTH_PX);
    });

    it('a live move lays the rail out but stores NOTHING', () => {
      const s = service();

      s.setRailWidth(300);
      s.setRailWidth(310);

      expect(s.railWidth()).toBe(310);
      expect(stored()).toBeNull();
    });

    it('the drop persists, once', () => {
      const s = service();
      const setItem = spyOn(Storage.prototype, 'setItem').and.callThrough();

      s.setRailWidth(300);
      s.setRailWidth(310);
      expect(setItem).not.toHaveBeenCalled();

      s.commitRailWidth(310);

      expect(setItem).toHaveBeenCalledTimes(1);
      expect(stored()!.railWidth).toBe(310);
    });

    it('clamps a live move too, so the signal never holds an unadoptable width', () => {
      const s = service();

      s.setRailWidth(-40);
      expect(s.railWidth()).toBe(RAIL_MIN_WIDTH_PX);

      s.setRailWidth(9000);
      expect(s.railWidth()).toBe(RAIL_MAX_WIDTH_PX);
    });

    /**
     * THE ONE THAT JUSTIFIES SHARING THE DOCUMENT. Before this, the rail's
     * width would have been a second key read at a second moment; the failure
     * that produces is a write of one preference carrying a stale copy of the
     * other. One object makes it unrepresentable, and this is the assertion
     * that says so.
     */
    it('a rail drag preserves the inspector, and an inspector drag preserves the rail', () => {
      const s = service();

      s.commitPercent(41);
      s.commitRailWidth(330);

      expect(stored()).toEqual({
        inspectorSide: 'right',
        inspectorPercent: 41,
        railWidth: 330,
      });

      s.swap();

      expect(stored()).toEqual({
        inspectorSide: 'left',
        inspectorPercent: 41,
        railWidth: 330,
      });
      expect(s.railWidth()).toBe(330);
    });

    it('writes no rail field at all while the rail is untouched', () => {
      const s = service();

      s.commitPercent(41);

      // The default is stored as absence, so a build that predates the rail
      // still reads this document as its own.
      expect(stored()).toEqual({ inspectorSide: 'right', inspectorPercent: 41 });
    });

    it('survives a browser that refuses to be written to', () => {
      const s = service();
      spyOn(Storage.prototype, 'setItem').and.throwError('QuotaExceededError');

      expect(() => s.commitRailWidth(330)).not.toThrow();
      expect(s.railWidth()).toBe(330);
    });
  });

  /**
   * Root-scoped is the point: the arrangement belongs to the window, not to
   * whichever team is open. `ProcessComponent` is destroyed and rebuilt on every
   * team switch, so a preference scoped to it would be re-read (and a mid-drag
   * width lost) each time the user changed team.
   */
  it('is one instance for the whole application', () => {
    expect(TestBed.inject(PaneLayoutService)).toBe(TestBed.inject(PaneLayoutService));
  });
});
