import { computed, Injectable, Signal, signal } from '@angular/core';

import {
  clampInspectorPercent,
  clampRailWidth,
  DEFAULT_PANE_LAYOUT,
  formatPaneLayout,
  InspectorSide,
  LeadingBounds,
  leadingBounds,
  leadingPercent,
  oppositeSide,
  PANE_LAYOUT_STORAGE_KEY,
  PaneLayout,
  parsePaneLayout,
} from './pane-layout';

/**
 * How the console's two panes are arranged, per browser, remembered (R3).
 *
 * WHY THIS IS NOT PART OF `ViewService`. That service's own doc comment says
 * what it is: which panes are COLLAPSED, for this session, seeded from the
 * deployment's `ConfigService`, persisting nothing. Adding a stored preference
 * to it would make that sentence false and would force a
 * deployment-default-versus-stored-preference precedence rule into a class that
 * today has no notion of either. Two services, one sentence each, is cheaper to
 * read than one service with a caveat. Nothing here touches `view.service.ts`.
 *
 * WHY THIS IS NOT PROVIDED ON `ProcessComponent`. That component is destroyed
 * and recreated on every team switch — deliberately, since its ordered
 * `providers` array is the only thing stopping one team's state reaching the
 * next. A preference re-read from storage on every team switch is a preference
 * that flickers, and a mid-drag value that resets when the user changes team.
 * Root scope is what makes the arrangement a property of the WINDOW rather than
 * of whichever team happens to be open.
 *
 * WHY THE READ IS IN THE CONSTRUCTOR. Root-scoped means constructed once, at
 * first injection, before the first paint of any view that asks for it — so the
 * stored arrangement is already in hand when `ProcessComponent` renders, and
 * there is no frame of default layout to see.
 *
 * ONE WRITE PER GESTURE. `setPercent` / `setRailWidth` are the live channels
 * and write nothing; `commitPercent`, `commitRailWidth` and `swap` are the
 * settled ones and write. A drag is dozens of live calls and exactly one
 * commit, which is the same two-output contract `app-split-divider` was built
 * around — and the reason both of the console's boundaries can use that one
 * component without either of them writing storage sixty times a second.
 *
 * TWO BOUNDARIES, ONE DOCUMENT, ONE KEY (W8b). The rail's width is a field of
 * the same `PaneLayout`, so a rail drag and an inspector drag write the same
 * entry and neither can resurrect the other's stale value. It is stored in
 * PIXELS rather than per cent; `pane-layout.ts` argues why, and the asymmetry
 * in which clamp knows about the window is documented on `railWidth` below.
 */
@Injectable({ providedIn: 'root' })
export class PaneLayoutService {
  private readonly _layout = signal<PaneLayout>(DEFAULT_PANE_LAYOUT);

  /** The arrangement in force. Read-only to everyone but this service. */
  readonly layout: Signal<PaneLayout> = this._layout.asReadonly();

  /** Which side the inspector is on, for the swap control's direction. */
  readonly inspectorSide: Signal<InspectorSide> = computed(
    () => this._layout().inspectorSide,
  );

  /** The inspector's share of the row, for its `flex-basis`. */
  readonly inspectorPercent: Signal<number> = computed(
    () => this._layout().inspectorPercent,
  );

  /**
   * The rail's PREFERRED width in CSS pixels — what the user last dragged it
   * to, not necessarily what it is currently drawn at.
   *
   * THE DIFFERENCE IS THE WHOLE POINT. A window too narrow for the preference
   * borrows width from the rail (`railMaxWidth`, applied at the binding in
   * `console-shell.component.ts`) and gives it back when the window grows.
   * Clamping the PREFERENCE to the current window instead would mean that
   * opening the app once on a small screen silently and permanently narrows a
   * rail the user widened on a large one.
   */
  readonly railWidth: Signal<number> = computed(() => this._layout().railWidth);

  /**
   * The same width restated as the LEFTMOST pane's share, which is the only
   * thing `app-split-divider` understands. Derived rather than stored — see the
   * long note in `pane-layout.ts` about why persisting this number instead
   * makes a swap jump.
   */
  readonly leadingPercent: Signal<number> = computed(() =>
    leadingPercent(this._layout()),
  );

  /**
   * The measured width of the INSPECTOR's pane row, in CSS pixels, or `null`
   * before anything has measured it.
   *
   * The rail's boundary measures a different box — the whole shell — and that
   * measurement deliberately does NOT come here: one field called "the track"
   * holding whichever of two unrelated rows reported last is a bug with no
   * symptom until a bound comes out wrong. The shell keeps its own measurement
   * and converts at its own binding; see `console-shell.component.ts`.
   *
   * WHY A SERVICE THAT IS PROUD OF BEING DOM-FREE HOLDS A MEASUREMENT. It does
   * not take one — `setTrackWidth` is called by the view that owns the element.
   * What lives here is the CONSEQUENCE: "how narrow may the inspector get" has
   * exactly one right answer at any moment, and that answer depends on both the
   * arrangement (which this service owns) and the row width (which it does
   * not). Splitting the question across two owners is how the two floors got
   * out of step in the first place.
   */
  private readonly _trackWidth = signal<number | null>(null);

  /**
   * The view reports the row it measured. `null` retracts the measurement —
   * the view is gone, and a stale width would bound a divider that no longer
   * exists against a row that no longer exists.
   */
  setTrackWidth(width: number | null): void {
    const next = width === null || !Number.isFinite(width) || width <= 0 ? null : width;
    if (next === this._trackWidth()) {
      return;
    }
    this._trackWidth.set(next);
  }

  /**
   * The divider's clamp, mirrored for whichever pane currently leads AND
   * reconciled with the pane's CSS pixel floor at the measured row width.
   *
   * Both halves matter. Without the mirroring the drag stops at the wrong end
   * after a swap; without the width the drag has a dead zone at the narrow end
   * on every viewport below ~1600px — see `INSPECTOR_MIN_WIDTH_PX`.
   */
  readonly leadingBounds: Signal<LeadingBounds> = computed(() =>
    leadingBounds(this._layout().inspectorSide, this._trackWidth()),
  );

  constructor() {
    const stored = parsePaneLayout(this.read());
    if (stored !== null) {
      this._layout.set(stored);
    }
  }

  /**
   * The live channel: the pointer moved. Lays out, stores nothing.
   *
   * Clamped HERE as well as inside the divider, so "the layout signal always
   * holds a width this app would lay out" is true of the signal itself rather
   * than a property of whoever last wrote to it. The value reaches the DOM as a
   * custom property and storage as a string, and neither has an opinion about
   * 1000%.
   */
  setPercent(percent: number): void {
    const next = clampInspectorPercent(percent);
    if (next === this._layout().inspectorPercent) {
      return;
    }
    this._layout.set({ ...this._layout(), inspectorPercent: next });
  }

  /** The settled channel: the drag ended, or one key was pressed. Persists. */
  commitPercent(percent: number): void {
    this.setPercent(percent);
    this.write();
  }

  /**
   * Put the inspector on the other side.
   *
   * The WIDTH is deliberately carried across unchanged, because it is the
   * inspector's width and the inspector is still the inspector. Recomputing it
   * would be the bug this module's "always the inspector's share" rule exists
   * to prevent: the pane would keep its position on screen and change size, as
   * though swapping sides had also resized it.
   */
  /**
   * The rail's live channel: the pointer moved. Lays out, stores nothing.
   *
   * Clamped to the PIXEL range only, with no window in the argument list, and
   * that omission is deliberate — see `railWidth` above. The view has already
   * applied the viewport cap to the value it is reporting; what this clamp
   * guarantees is the thing no view can, namely that the signal never holds a
   * width outside the range this module is willing to read back.
   */
  setRailWidth(width: number): void {
    const next = clampRailWidth(width);
    if (next === this._layout().railWidth) {
      return;
    }
    this._layout.set({ ...this._layout(), railWidth: next });
  }

  /** The rail's settled channel: the drag ended, or one key was pressed. */
  commitRailWidth(width: number): void {
    this.setRailWidth(width);
    this.write();
  }

  swap(): void {
    this._layout.set({
      ...this._layout(),
      inspectorSide: oppositeSide(this._layout().inspectorSide),
    });
    this.write();
  }

  /**
   * `localStorage` is not merely a map: reading it THROWS outright when the
   * browser blocks storage for the origin (Safari private browsing, a
   * third-party-cookie-blocked iframe — and this app is embedded in one). A
   * remembered pane arrangement is not worth a console that fails to boot, so a
   * refusal reads as "no preference stored". Same pattern as `i18n.service.ts`
   * and the home page's split width.
   */
  private read(): string | null {
    try {
      return localStorage.getItem(PANE_LAYOUT_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  /** As `read`: a refused write costs the preference and nothing more. */
  private write(): void {
    try {
      localStorage.setItem(PANE_LAYOUT_STORAGE_KEY, formatPaneLayout(this._layout()));
    } catch {
      /* storage unavailable — the arrangement still applies for this visit */
    }
  }
}
