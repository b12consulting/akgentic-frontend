/**
 * How the console's panes are ARRANGED: which side the inspector is on, how
 * much of the row it takes, and how wide the rail is.
 *
 * Pure and DOM-free, for the same reason `split-width.ts` is (Epic 52 NFR3):
 * the drag needs a real pointer, the arithmetic around it does not, and the
 * arithmetic is where a mistake is invisible. A parse that clamps to the wrong
 * end, or a side conversion that is off by an inversion, does not throw and
 * does not fail a rendered test — it just lays the console out slightly wrong
 * on every reload, for ever.
 *
 * THE INSPECTOR'S STORED QUANTITY IS ALWAYS THE INSPECTOR'S SHARE. `app-split-
 * divider` talks in terms of the LEFTMOST pane's share, which is a perfectly
 * good thing for a divider to measure and a hopeless thing to persist the
 * moment the two panes can trade places: a 26% conversation would come back as
 * a 26% inspector after a swap, and the layout would visibly jump. So the
 * identity-stable quantity is what is stored and reasoned about, and the
 * conversion to and from the divider's frame happens at the binding, once, in
 * `leadingPercent` / `inspectorPercentFromLeading`.
 *
 * TWO BOUNDARIES, ONE DOCUMENT (W8b). The rail's width lives in the same
 * object under the same key, for the same reason the side and the inspector
 * width do: they are one preference about one console, and a second key is a
 * second thing that can be half-restored, read at a different moment, or
 * cleared on its own. The rail is measured in PIXELS rather than per cent —
 * see `PaneLayout.railWidth` — which is a difference in what the two panes
 * ARE, not a second mechanism.
 */

/** Which side of the conversation the inspector sits on. */
export type InspectorSide = 'left' | 'right';

/**
 * The whole preference, in one object.
 *
 * ONE object and not two loose values, because side and width are a single
 * preference: a half-restored state (a swap that comes back without its width)
 * has no sensible behaviour, so it is not a state this type can express.
 */
export interface PaneLayout {
  readonly inspectorSide: InspectorSide;
  readonly inspectorPercent: number;
  /**
   * The rail's width, in CSS PIXELS.
   *
   * THE ONE QUANTITY HERE THAT IS NOT A PERCENTAGE, and that is the decision
   * rather than an oversight. `split-width.ts` argues — correctly, for the pane
   * it was written for — that a width in pixels stops meaning what it meant the
   * moment the window is resized. That argument is about a pane that SHARES a
   * row: two fifths of a wide screen really is almost all of a narrow one.
   *
   * The rail shares nothing. It is a fixed column holding team names, and a
   * name is a number of pixels wide, not a fraction of a window. Stored as a
   * share, a rail dragged to a comfortable 268px on a 3440px ultrawide comes
   * back as 100px on a laptop — narrower than the thing it exists to show —
   * and a rail widened to fit long names on a laptop eats a third of the
   * ultrawide. Stored as pixels it comes back fitting exactly what it fitted
   * before, which is the only property a user would recognise as "remembered".
   *
   * The window still gets a say, but at the BINDING and not in the store: see
   * `railMaxWidth`, which caps what is APPLIED without overwriting what was
   * PREFERRED. A narrow window therefore borrows the rail's width for as long
   * as it is narrow, and gives it back.
   */
  readonly railWidth: number;
}

/**
 * The narrowest and widest the INSPECTOR may be, as a percentage of the pane
 * row.
 *
 * Deliberately NOT `split-width.ts`'s 20/70. Those bounds were chosen for a
 * teams list beside an open team; applied here, the ceiling would give a
 * ~1008px inspector on a 1440px screen — half again as wide as the
 * conversation it is meant to annotate. Neither of these numbers is arbitrary:
 * the floor is roughly the width at which the tab strip and the roster chips
 * stop being legible, and the ceiling is the point past which the conversation
 * — the thing the user actually came for — starts wrapping every other word.
 *
 * The floor is a PREFERENCE, not a guarantee. A percentage cannot promise a
 * pixel minimum across viewports, so the guarantee is CSS's:
 * `--akg-inspector-min-width` on the pane itself. See `INSPECTOR_MIN_WIDTH_PX`
 * below for why the two have to be reconciled rather than merely coexist, and
 * the note in `inspector.component.scss`.
 */
export const INSPECTOR_MIN_PERCENT = 18;
export const INSPECTOR_MAX_PERCENT = 50;

/**
 * The PIXEL floor, and the TypeScript half of a pair whose other half is
 * `--akg-inspector-min-width` in `_conversation-tokens.scss`.
 *
 * IT OUTRANKS THE PERCENTAGE FLOOR AT EVERY VIEWPORT BELOW ~1600px, WHICH IS
 * MOST OF THEM. `min-width` beats `flex-basis`, so whenever 18% of the pane row
 * is under 240px it is this number, not `INSPECTOR_MIN_PERCENT`, that decides
 * how narrow the pane can get. Left unreconciled that produces a dead zone at
 * the narrow end of the drag: the divider keeps accepting percentages the pane
 * will never adopt, so the handle moves and the boundary does not — and the
 * value gets PERSISTED, so the pane comes back at a width it never had.
 *
 * The arithmetic, at the two widths that matter (row = viewport - 268px rail):
 *
 *   1440px viewport → 1180px row → 18% = 212px, real floor 20.3% → 2.3pp dead
 *   1280px viewport → 1020px row → 18% = 184px, real floor 23.5% → 5.5pp dead
 *
 * 1440px is the width the design was drawn against, so this is not a
 * small-viewport edge case; it is the reference case. `pixelFloorPercent`
 * below converts this number into the divider's frame at the row width
 * actually measured, and `leadingBounds` takes whichever floor is higher.
 *
 * DUPLICATED FROM CSS ON PURPOSE, AND ONLY ONCE. The divider's clamp runs in
 * TypeScript and the pane's floor is applied by the cascade; neither can read
 * the other. What can be prevented is a THIRD copy, so this is the only literal
 * 240 outside the token, and the token's comment names this constant.
 */
export const INSPECTOR_MIN_WIDTH_PX = 240;

/**
 * `INSPECTOR_MIN_WIDTH_PX` restated as a share of a row that is `trackWidth`
 * pixels wide.
 *
 * Returns `INSPECTOR_MIN_PERCENT` for an unmeasurable row — `null` before the
 * first layout, `0` for a detached element — because a floor derived from a
 * width nobody measured is a guess, and the percentage floor is the honest
 * answer when there is nothing to reconcile it against.
 *
 * The result is capped at `INSPECTOR_MAX_PERCENT`: on a row narrower than
 * 480px the pixel floor exceeds the ceiling, and a `min` above its `max` is a
 * range no clamp can satisfy. The pane is squeezed by CSS at that point
 * whatever the divider says, so the honest bound is "the whole allowed range".
 */
export function pixelFloorPercent(trackWidth: number | null): number {
  if (trackWidth === null || !Number.isFinite(trackWidth) || trackWidth <= 0) {
    return INSPECTOR_MIN_PERCENT;
  }
  // CEIL, not round. The result is quantised to a tenth to match
  // `clampInspectorPercent`, and rounding to the NEAREST tenth can land a
  // fraction of a pixel BELOW the floor it exists to enforce — 240/1180 is
  // 20.3389%, which rounds to 20.3% and yields a 239.5px pane. A floor that is
  // half a pixel short is the same bug in miniature.
  const floor = (INSPECTOR_MIN_WIDTH_PX / trackWidth) * 100;
  return Math.min(
    INSPECTOR_MAX_PERCENT,
    Math.max(INSPECTOR_MIN_PERCENT, Math.ceil(floor * 10) / 10),
  );
}

/**
 * Where the inspector starts before anyone has ever dragged it.
 *
 * 26% is ≈305px on a 1440px window with the rail expanded — i.e. the 310px the
 * pane was fixed at before it could be resized at all, expressed as a ratio so
 * that it survives a window resize instead of eating a phone-width screen.
 */
export const INSPECTOR_DEFAULT_PERCENT = 26;

/* --- The rail ------------------------------------------------------------
 *
 * THE SECOND DRAGGABLE BOUNDARY, AND THE SAME PREFERENCE (W8b). Everything
 * below extends the object above rather than opening a second store: one key,
 * one document, one read at boot. A rail width kept under its own key would be
 * a second thing that can be half-restored, and the whole reason this module
 * holds ONE object is that a half-restored arrangement has no sensible
 * behaviour.
 *
 * It is nevertheless expressed in PIXELS while the inspector is expressed in
 * per cent — see `PaneLayout.railWidth` for why the two panes genuinely want
 * different units. The conversion into the divider's frame happens here, in
 * `railBounds` / `railPercentOf` / `railWidthFromPercent`, and nowhere else,
 * for exactly the reason `leadingPercent` exists: a frame conversion scattered
 * across call sites is a frame conversion that will be done twice somewhere.
 */

/**
 * What the rail is before anybody drags it, and the TypeScript half of a pair
 * whose other half is `--akg-rail-width: 268px` in `_conversation-tokens.scss`.
 *
 * DUPLICATED FROM CSS ON PURPOSE, AND ONLY ONCE — the same bargain as
 * `INSPECTOR_MIN_WIDTH_PX`. The cascade applies the token; the drag arithmetic
 * runs in TypeScript; neither can read the other. What CAN be prevented is a
 * third copy, so this is the only literal 268 outside the token.
 */
export const RAIL_DEFAULT_WIDTH_PX = 268;

/**
 * The narrowest and widest the rail may be dragged, in CSS pixels.
 *
 * Neither is arbitrary. The floor is roughly where a team row stops being able
 * to show a name and its group chip side by side, so below it the rail is a
 * column of ellipses; the ceiling is where the rail stops being navigation and
 * starts being the page. FR4's rule that no pane may be collapsed BY DRAGGING
 * is what the floor enforces — collapsing the rail entirely is a different
 * gesture with its own control, and it is reversible.
 */
export const RAIL_MIN_WIDTH_PX = 208;
export const RAIL_MAX_WIDTH_PX = 420;

/**
 * The viewport cap, mirroring `--akg-rail-max-width: 26vw`.
 *
 * IT EXISTS TO CLOSE A DEAD ZONE, not to add a second opinion. `max-width`
 * beats `width`, so on any window narrower than ~1615px the CSS cap — not
 * `RAIL_MAX_WIDTH_PX` — is what actually stops the rail growing. Left
 * unreconciled that is the inspector's old narrow-end bug in a mirror: the
 * divider would keep accepting widths the rail will never adopt, so the handle
 * moves, the boundary does not, and the value gets persisted anyway.
 *
 * `railMaxWidth` takes whichever of the two is lower, so the drag never
 * proposes a width the cascade will refuse. The CSS cap stays where it is, as
 * the guarantee rather than the mechanism.
 */
export const RAIL_MAX_TRACK_PERCENT = 26;

/**
 * The row width assumed when nobody has measured one.
 *
 * 1440px, because that is the width the console was drawn against — the same
 * stand-in `INSPECTOR_MIN_WIDTH_PX`'s arithmetic reasons from. It only ever
 * reaches a user through a divider that is not rendered until the shell HAS
 * measured itself; it is here so that the pure functions have a defined answer
 * instead of a `null` that every caller would have to re-decide.
 */
export const RAIL_NOMINAL_TRACK_PX = 1440;

/**
 * The measured row, or the nominal one when there is nothing to measure.
 *
 * ONLY FOR RATIOS. Percentages need a denominator and there is no honest
 * `null`-shaped answer to "what fraction of nothing is 268px"; a CAP, by
 * contrast, has one — see `railMaxWidth`.
 */
function usableTrack(trackWidth: number | null): number {
  return trackWidth === null || !Number.isFinite(trackWidth) || trackWidth <= 0
    ? RAIL_NOMINAL_TRACK_PX
    : trackWidth;
}

/**
 * The widest the rail may actually be on a row this wide.
 *
 * AN UNMEASURED ROW IMPOSES NO CAP. `null` here is not "assume 1440px" — it is
 * "there is no viewport in this question", which is exactly the case when the
 * STORE clamps a preference. A preference must not be trimmed by a window that
 * was not even measured, let alone by a stand-in for one; the nominal row
 * exists for the ratio in `railBounds` and its neighbours, where a division
 * needs a denominator, and nowhere else.
 *
 * FLOOR, not round: the result is compared against the cascade's cap, and a
 * ceiling half a pixel above the cap is the dead zone this function exists to
 * remove. Flooring also keeps every bound an integer, which is what makes
 * `clampRailWidth` idempotent.
 *
 * `Math.max(RAIL_MIN_WIDTH_PX, …)` because on a row under 800px the cap falls
 * below the floor, and a `min` above its own `max` is a range no clamp can
 * satisfy. The rail is squeezed by CSS at that point whatever this says.
 */
export function railMaxWidth(trackWidth: number | null = null): number {
  if (trackWidth === null || !Number.isFinite(trackWidth) || trackWidth <= 0) {
    return RAIL_MAX_WIDTH_PX;
  }
  const cap = Math.floor((trackWidth * RAIL_MAX_TRACK_PERCENT) / 100);
  return Math.max(RAIL_MIN_WIDTH_PX, Math.min(RAIL_MAX_WIDTH_PX, cap));
}

/**
 * Bring a rail width inside the allowed range, at whole pixels.
 *
 * WHOLE pixels because that is what the rail is: a fractional width buys
 * nothing a user can see and costs a blurred border and a storage write per
 * sub-pixel of pointer movement. Rounding here rather than at the call sites
 * keeps `clamp(clamp(x)) === clamp(x)`, which a run of keystrokes depends on.
 *
 * `trackWidth` is OPTIONAL and defaults to "unmeasured". Omit it and you get
 * the pixel range alone, which is the right answer for the STORE — a
 * preference must not be rewritten by the window that happened to be open when
 * it was last read. Pass it at the BINDING, where the question is what the
 * rail may be right now.
 *
 * A non-finite width yields the DEFAULT rather than a bound: it means the
 * caller had no usable number at all, and either bound would assert an intent
 * nothing supports.
 */
export function clampRailWidth(
  width: number,
  trackWidth: number | null = null,
): number {
  const max = railMaxWidth(trackWidth);
  const inRange = (value: number): number =>
    Math.min(max, Math.max(RAIL_MIN_WIDTH_PX, value));
  if (!Number.isFinite(width)) {
    return inRange(RAIL_DEFAULT_WIDTH_PX);
  }
  return inRange(Math.round(width));
}

/** One decimal, matching `clampSplitPercent`'s precision in the same frame. */
function tenth(value: number, round: (n: number) => number): number {
  return round(value * 10) / 10;
}

/**
 * The rail's pixel range restated as the percentage range `app-split-divider`
 * clamps against.
 *
 * THE ROUNDING GOES OUTWARDS — floor DOWN, ceiling UP — which is the opposite
 * of `pixelFloorPercent`'s direction, and for a reason specific to this frame.
 * A tenth of a per cent is one and a half pixels on an ordinary window, so a
 * bound rounded INWARDS names a percentage whose pixel value is a pixel short
 * of the limit, and the user simply cannot drag the rail to its own minimum:
 * the handle stops, the number sticks at 209, and nothing says why. Rounding
 * outwards cannot overshoot, because `railWidthFromPercent` clamps in PIXELS
 * afterwards — the pixel range is the authority, and this range is only the
 * window it is reached through.
 */
export function railBounds(trackWidth: number | null = null): LeadingBounds {
  const track = usableTrack(trackWidth);
  const min = tenth((RAIL_MIN_WIDTH_PX / track) * 100, Math.floor);
  const max = tenth((railMaxWidth(trackWidth) / track) * 100, Math.ceil);
  // On a row narrow enough for the floor to overtake the ceiling there is no
  // range left; report the degenerate one rather than an inverted one, which
  // `clampSplitPercent` would resolve by silently preferring its `max`.
  return min > max ? { min: max, max } : { min, max };
}

/** A rail width, in the divider's frame. Clamped first, so it is reachable. */
export function railPercentOf(
  width: number,
  trackWidth: number | null = null,
): number {
  const track = usableTrack(trackWidth);
  return tenth((clampRailWidth(width, trackWidth) / track) * 100, Math.round);
}

/** What the divider just reported, restated as a width the rail can adopt. */
export function railWidthFromPercent(
  percent: number,
  trackWidth: number | null = null,
): number {
  if (!Number.isFinite(percent)) {
    return clampRailWidth(RAIL_DEFAULT_WIDTH_PX, trackWidth);
  }
  return clampRailWidth((percent / 100) * usableTrack(trackWidth), trackWidth);
}

/**
 * Where the arrangement is remembered.
 *
 * Namespaced `.console.` to sit beside `akgentic.home.split-percent` without
 * colliding. That key is NOT reused: it means "the teams list's share of the
 * home page", which is a different pane in a different view, and inheriting
 * one page's dragged width as another's would be a preference nobody set.
 */
export const PANE_LAYOUT_STORAGE_KEY = 'akgentic.console.pane-layout';

/**
 * The arrangement with nothing stored: inspector on the right, as every
 * version of this console has drawn it.
 */
export const DEFAULT_PANE_LAYOUT: PaneLayout = {
  inspectorSide: 'right',
  inspectorPercent: INSPECTOR_DEFAULT_PERCENT,
  railWidth: RAIL_DEFAULT_WIDTH_PX,
};

/**
 * Bring an inspector share inside the allowed range, at one decimal.
 *
 * Rounding lives here rather than at the call sites so that
 * `clamp(clamp(x)) === clamp(x)` — a value that has been through this once
 * cannot move by going through it twice. Without that, a percentage that is
 * read, bound, reported back by the divider and re-clamped would drift by a
 * rounding error per gesture.
 *
 * A non-finite input yields the DEFAULT rather than a bound, because it means
 * the caller had no usable number at all (a corrupt store, a measurement taken
 * before layout) and either bound would assert an intent nothing supports.
 */
export function clampInspectorPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return INSPECTOR_DEFAULT_PERCENT;
  }
  const rounded = Math.round(percent * 10) / 10;
  return Math.min(INSPECTOR_MAX_PERCENT, Math.max(INSPECTOR_MIN_PERCENT, rounded));
}

/** Narrowing guard for the side literal, used by the parser and by callers. */
export function isInspectorSide(value: unknown): value is InspectorSide {
  return value === 'left' || value === 'right';
}

/** The other side. Trivial, and named so `swap()` reads as what it does. */
export function oppositeSide(side: InspectorSide): InspectorSide {
  return side === 'left' ? 'right' : 'left';
}

/**
 * The LEADING pane's share — what `app-split-divider` measures and reports.
 *
 * This is the single conversion between the two frames of reference. The
 * inspector's share is what is stored; the leftmost pane's share is what the
 * divider understands; they are the same number only when the inspector IS the
 * leftmost pane.
 */
export function leadingPercent(
  layout: Pick<PaneLayout, 'inspectorSide' | 'inspectorPercent'>,
): number {
  const inspector = clampInspectorPercent(layout.inspectorPercent);
  return layout.inspectorSide === 'left' ? inspector : 100 - inspector;
}

/** The inverse of `leadingPercent`: what the divider just said, restated. */
export function inspectorPercentFromLeading(
  side: InspectorSide,
  leading: number,
): number {
  if (!Number.isFinite(leading)) {
    return INSPECTOR_DEFAULT_PERCENT;
  }
  return clampInspectorPercent(side === 'left' ? leading : 100 - leading);
}

/** The divider's own min/max, expressed in the leftmost pane's terms. */
export interface LeadingBounds {
  readonly min: number;
  readonly max: number;
}

/**
 * The inspector's bounds, restated for whichever pane is currently leading.
 *
 * This is why the divider's bounds had to become inputs. With the inspector on
 * the left the clamp is 18..50 directly; with it on the right the leftmost pane
 * is the CONVERSATION, and the same preference reads as 50..82. One pair of
 * module constants cannot be both, and a divider clamped to the wrong pair
 * stops at the wrong place with nothing to say about it.
 *
 * `trackWidth` is the MEASURED width of the pane row, and it is what closes the
 * dead zone at the narrow end: the inspector's real floor is the HIGHER of the
 * percentage preference and the CSS pixel floor, and which of the two wins
 * depends on a number only the DOM knows. Pass `null` and the bounds fall back
 * to the percentage floor alone — the pre-R3 behaviour, which is right for a
 * caller that has not laid out yet and wrong for one that has.
 *
 * Note the ASYMMETRY: only the inspector's floor moves. The ceiling is a
 * percentage all the way down because nothing in CSS caps this pane any more
 * (the `max-width` was removed precisely so the drag could not outrun it), and
 * the conversation has no pixel minimum of its own.
 */
export function leadingBounds(
  side: InspectorSide,
  trackWidth: number | null = null,
): LeadingBounds {
  const min = pixelFloorPercent(trackWidth);
  return side === 'left'
    ? { min, max: INSPECTOR_MAX_PERCENT }
    : { min: 100 - INSPECTOR_MAX_PERCENT, max: 100 - min };
}

/**
 * Read an arrangement back out of storage.
 *
 * `null` means "no usable preference", and the caller uses `DEFAULT_PANE_LAYOUT`
 * instead. This function NEVER throws: everything a browser can hand back —
 * a missing key, an empty string, half a JSON document, an array, a bare
 * number, an object missing a field — has to come out as `null`, because the
 * alternative is a console that fails to render because somebody once had a
 * different version of this app open.
 *
 * THREE outcomes, not two, since the rail joined the document: reject, clamp,
 * and DEFAULT. The line between "null" and "clamp" is STRUCTURE versus RANGE. A value of the
 * wrong shape (no `inspectorSide`, a percent that is a string, a side that is
 * neither literal) is not a preference at all and is rejected whole — restoring
 * half of a two-field preference is exactly the half-restore this single-key
 * design exists to make impossible. A percent of the right shape but outside
 * the bounds IS a preference — most likely one stored before the bounds
 * changed — and the nearest allowed width honours it. The third outcome
 * belongs to `railWidth` alone and is the migration: a document written before
 * the rail could be dragged simply has no such field, which is a valid
 * document and means "the default", not "corrupt". See the comment at the
 * check itself.
 */
export function parsePaneLayout(raw: string | null): PaneLayout | null {
  if (raw === null || raw.trim() === '') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  // `typeof null === 'object'` and so does an array; both are rejected here
  // rather than surviving to the property reads below, where they would simply
  // yield `undefined` and look like a missing field.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Partial<Record<keyof PaneLayout, unknown>>;
  const side = candidate.inspectorSide;
  const percent = candidate.inspectorPercent;
  const rail = candidate.railWidth;

  if (!isInspectorSide(side)) {
    return null;
  }
  // `typeof` first: `Number.isFinite('26')` is false, but so is
  // `Number.isFinite(undefined)`, and only one of those is a shape problem.
  // A quoted number is still the wrong shape — this module wrote it, and it
  // writes numbers.
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    return null;
  }
  // MISSING IS NOT MALFORMED, and this is the whole migration (W8b). Every
  // arrangement stored before the rail could be dragged is a two-field
  // document, and it is a perfectly good statement of a preference about the
  // inspector. Reading it as corrupt would throw away a width and a side the
  // user chose, in order to punish them for the absence of a field that did
  // not exist when they chose it. So absence means DEFAULT.
  //
  // A rail width that is PRESENT and of the wrong shape is a different thing
  // and is rejected whole, exactly as a malformed `inspectorPercent` is: this
  // module wrote the document, it writes numbers, and a writer that produced
  // something else is not a version of this module — which makes the rest of
  // what it wrote untrustworthy too. Out of RANGE is not wrong shape: like the
  // inspector's, it is honoured at the nearest allowed width.
  if (rail !== undefined && (typeof rail !== 'number' || !Number.isFinite(rail))) {
    return null;
  }

  return {
    inspectorSide: side,
    inspectorPercent: clampInspectorPercent(percent),
    railWidth: rail === undefined ? RAIL_DEFAULT_WIDTH_PX : clampRailWidth(rail),
  };
}

/**
 * Render an arrangement for storage.
 *
 * Clamped on the way out as well as on the way in, so nothing this module
 * would refuse to read back can ever be written — the failure mode that
 * otherwise shows up as "it remembers a width it will not restore".
 */
export function formatPaneLayout(layout: PaneLayout): string {
  const railWidth = clampRailWidth(layout.railWidth);
  return JSON.stringify({
    inspectorSide: layout.inspectorSide,
    inspectorPercent: clampInspectorPercent(layout.inspectorPercent),
    // THE DEFAULT IS WRITTEN AS ABSENCE, because that is how it is read. The
    // parser already treats a missing rail width as the default, so storing
    // `268` says nothing the empty document did not — and saying it has a
    // cost: an older build of this app, and any other reader of this key,
    // would start seeing a field where the contract it was written against
    // had none. A document that names only what the user actually moved is
    // the one that stays readable in both directions.
    ...(railWidth === RAIL_DEFAULT_WIDTH_PX ? {} : { railWidth }),
  });
}
