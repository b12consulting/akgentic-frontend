/**
 * The arithmetic of a two-pane split: clamping, stepping, and what a stored
 * width means.
 *
 * Pure and DOM-free on purpose (Epic 52 NFR3). The drag needs a real pointer;
 * the maths around it does not, and the maths is where an off-by-one shifts
 * the layout silently on every reload — a bug that only ever shows up as "the
 * panes look slightly wrong today".
 *
 * Everything here is expressed as a PERCENTAGE of the container (FR5). A width
 * in pixels stops meaning what it meant the moment the window is resized: a
 * list that was two fifths of a wide screen becomes almost all of a narrow
 * one, and the pane it was supposed to share with disappears.
 */

/**
 * The narrowest and widest the list may be, as a percentage of the split.
 *
 * FR4: neither pane may be collapsed. The floor is what stops the list being
 * dragged to nothing; the ceiling is what stops it squeezing the open team
 * out. They are not symmetric because the two panes are not: a team list is
 * legible in a fifth of the width, and the team view — a conversation beside a
 * visualization panel — is not.
 */
export const SPLIT_MIN_PERCENT = 20;
export const SPLIT_MAX_PERCENT = 70;

/** Where the split starts before anyone has ever dragged it. */
export const SPLIT_DEFAULT_PERCENT = 40;

/**
 * The two keyboard steps (FR6).
 *
 * The coarse step exists because the fine one is unusable on its own: crossing
 * the clamped range one percent at a time is fifty keystrokes. The fine step
 * exists because the coarse one cannot land on a particular width. Neither
 * substitutes for the other.
 */
export const SPLIT_FINE_STEP_PERCENT = 1;
export const SPLIT_COARSE_STEP_PERCENT = 10;

/** Where the split width is remembered across reloads (FR5). */
export const SPLIT_STORAGE_KEY = 'akgentic.home.split-percent';

/**
 * Bring a percentage inside the allowed range, at one decimal of precision.
 *
 * The rounding is here rather than at the call sites so that a value which has
 * been through this function once cannot move again by going through it twice
 * — `clamp(clamp(x)) === clamp(x)`. `stepSplitPercent` depends on that: it
 * clamps its input before adding the step, so a run of keystrokes accumulates
 * exactly, instead of drifting by a rounding error per press.
 *
 * A non-finite input yields the DEFAULT rather than a bound. It means the
 * caller had no usable number at all — a corrupt stored value, a measurement
 * taken before layout — and either bound would be an assertion about intent
 * that nothing supports.
 */
export function clampSplitPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return SPLIT_DEFAULT_PERCENT;
  }
  const rounded = Math.round(percent * 10) / 10;
  return Math.min(SPLIT_MAX_PERCENT, Math.max(SPLIT_MIN_PERCENT, rounded));
}

/** Everything the pointer maths needs, in the units the DOM reports them in. */
export interface SplitPointerGeometry {
  /** `PointerEvent.clientX`. */
  pointerX: number;
  /** The split container's `getBoundingClientRect().left`. */
  containerLeft: number;
  /** The split container's `getBoundingClientRect().width`. */
  containerWidth: number;
  /** The divider's own rendered width. */
  dividerWidth: number;
}

/**
 * The list width, as a percentage, that puts the divider under the pointer.
 *
 * The divider is CENTRED on the pointer, which is why its width appears here
 * at all: the grab handle is several pixels wide, and sizing the list to the
 * raw pointer offset makes the divider jump half its own width the instant a
 * drag starts. Dropping the term is the off-by-one this module exists to pin
 * down.
 *
 * The denominator is the container's FULL width, not the width minus the
 * divider, because the percentage is a `flex-basis` and a percentage
 * `flex-basis` resolves against the container — the divider's pixels are taken
 * out of the other pane, not out of the percentage.
 *
 * `null` means "not a usable measurement": a zero-width container (measured
 * before layout, or while hidden) would otherwise divide by zero and report a
 * bound as though the user had dragged there.
 */
export function splitPercentFromPointer(
  geometry: SplitPointerGeometry,
): number | null {
  const { pointerX, containerLeft, containerWidth, dividerWidth } = geometry;
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return null;
  }
  if (!Number.isFinite(pointerX) || !Number.isFinite(containerLeft)) {
    return null;
  }
  const halfDivider = Number.isFinite(dividerWidth) ? dividerWidth / 2 : 0;
  const listWidth = pointerX - containerLeft - halfDivider;
  return clampSplitPercent((listWidth / containerWidth) * 100);
}

/**
 * Move the split by `delta` percentage points, staying inside the range.
 *
 * The current value is clamped BEFORE the step is added, so a caller that has
 * somehow been handed an out-of-range value walks back into the range rather
 * than being pinned at a bound: stepping from 95 by -10 gives 60, not 70.
 */
export function stepSplitPercent(current: number, delta: number): number {
  return clampSplitPercent(clampSplitPercent(current) + delta);
}

/**
 * Read a width back out of storage.
 *
 * `null` for anything that is not a usable number, INCLUDING an empty string —
 * `Number('')` is 0, which would otherwise read as a deliberate "collapse the
 * list" and come back as the minimum. Anything that IS a number is clamped
 * rather than rejected: a stored value predating a change to the bounds is
 * still a statement of preference, and the nearest allowed width honours it.
 */
export function parseSplitPercent(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return null;
  }
  return clampSplitPercent(value);
}

/** Render a width for storage. Clamped, so nothing out of range is ever stored. */
export function formatSplitPercent(percent: number): string {
  return String(clampSplitPercent(percent));
}
