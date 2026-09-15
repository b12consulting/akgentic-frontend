import {
  Component,
  ElementRef,
  EventEmitter,
  inject,
  Input,
  Output,
} from '@angular/core';

import {
  clampSplitPercent,
  SPLIT_COARSE_STEP_PERCENT,
  SPLIT_DEFAULT_PERCENT,
  SPLIT_FINE_STEP_PERCENT,
  SPLIT_MAX_PERCENT,
  SPLIT_MIN_PERCENT,
  SplitBounds,
  splitPercentFromPointer,
  stepSplitPercent,
} from '../../../shared/util/split-width';

/**
 * The draggable boundary between two panes (Epic 52, story 52-2).
 *
 * It renders a grab handle and reports where the user put it. It owns NO
 * width: `percent` is an input and is never written from in here, and nothing
 * about which panes exist, how they are sized, or where the width is stored is
 * this component's business. That separation is what lets the arithmetic live
 * in `split-width.ts` as plain functions over numbers, and it is why this file
 * has no maths in it at all.
 *
 * TWO outputs rather than one, and they are not the same event. `percentChange`
 * fires continuously so the panes track the pointer; `commit` fires when the
 * user has finished — the end of a drag, or a keystroke, which is complete the
 * moment it happens. A host that persists on `percentChange` writes storage
 * sixty times a second for one drag; a host that lays out on `commit` alone
 * has a divider that does not move until you let go of it.
 *
 * IT LOOKS LIKE A CONTROL BEFORE IT IS TOUCHED (W8a). The first version drew a
 * 2px hairline in the surface-border tone and revealed itself only on hover,
 * which reads as a seam between two panes rather than as something to grab —
 * and hover is precisely the state a user who cannot find the divider will
 * never reach. So there is a grip mark at rest, and hover/drag/focus are
 * changes to a thing already on screen instead of the thing appearing. No
 * touch device has a hover state at all, which makes a hover-only affordance
 * not merely hard to find there but absent.
 *
 * `track` is the element the percentage is OF, passed in rather than
 * discovered: reaching for `parentElement` would make the maths depend on how
 * the host chose to wrap this element, which is the kind of coupling that
 * survives until someone adds a wrapper div.
 *
 * THE RANGE IS THE HOST'S, NOT THIS COMPONENT'S (R3). `min`, `max` and
 * `defaultPercent` are inputs, defaulted to the teams-list split's values so
 * that a host which says nothing gets exactly the behaviour this component
 * shipped with. They had to become inputs the moment a second host appeared
 * whose two panes can trade places: this component measures the LEFTMOST pane,
 * so a single preference about one identified pane reads as two different
 * ranges depending on which side that pane is currently on. See `SplitBounds`
 * in `split-width.ts`.
 */
@Component({
  selector: 'app-split-divider',
  // THE GRIP IS A REAL ELEMENT, NOT A PSEUDO-ELEMENT (W8a). It has to be
  // findable by a spec: the user's complaint was not that the divider looked
  // wrong but that they could not tell it was a control, and the only
  // regression worth pinning is "the affordance is present AT REST" — which a
  // `::after` cannot be asked about. It is `aria-hidden` because the host is
  // already a labelled `separator` with a value and a range; the grip is that
  // control's paint, and announcing it a second time would be one control
  // spoken as two.
  template: '<span class="split-divider__grip" aria-hidden="true"></span>',
  styleUrl: './split-divider.component.scss',
  host: {
    // WAI-ARIA "window splitter": a separator that takes focus is operable, and
    // then it needs a value and a range like any other range widget (FR6).
    // `aria-orientation` describes the SEPARATOR, which stands vertically
    // between a left and a right pane — not the axis it moves along.
    role: 'separator',
    'aria-orientation': 'vertical',
    tabindex: '0',
    '[attr.aria-label]': 'label',
    // Rounded for the reader: a screen reader announcing "forty-three point
    // one percent" on every arrow press is noise, and the tenth is a layout
    // precision rather than something a listener can act on.
    '[attr.aria-valuenow]': 'Math.round(clamped)',
    '[attr.aria-valuemin]': 'min',
    '[attr.aria-valuemax]': 'max',
    '[attr.aria-valuetext]': 'valueText',
    '[class.split-divider--dragging]': 'dragging',
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'onPointerUp($event)',
    '(pointercancel)': 'onPointerUp($event)',
    // THE RELEASE THIS COMPONENT NEVER HEARS ABOUT. `pointerup` is not
    // guaranteed: capture can end without one — the button released outside the
    // window, the element re-rendered mid-drag, the OS taking the pointer. Left
    // unhandled, `dragging` stays true and the divider keeps following a
    // pointer with nothing held down. See `endDrag`.
    '(lostpointercapture)': 'onLostPointerCapture()',
    '(keydown)': 'onKeyDown($event)',
    '(dblclick)': 'onDoubleClick()',
  },
})
export class SplitDividerComponent {
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  /** The element the percentage is measured against. */
  @Input({ required: true }) track!: HTMLElement;

  /** The width of the FIRST pane, as a percentage of `track`. */
  @Input() percent: number = SPLIT_DEFAULT_PERCENT;

  /** What this separator is for, spoken by a screen reader. */
  @Input() label = 'Resize panes';

  /**
   * The narrowest and widest the FIRST pane may be, as a percentage of `track`.
   *
   * Defaulted to the module constants, so every pre-R3 call site and its specs
   * keep the range they had. A host with two arrangeable panes rebinds them per
   * arrangement — see `leadingBounds` in `core/ui/pane-layout.ts`.
   */
  @Input() min = SPLIT_MIN_PERCENT;
  @Input() max = SPLIT_MAX_PERCENT;

  /**
   * What double-click restores.
   *
   * An input for the same reason the bounds are: the module's 40% is the teams
   * list's resting width and is not necessarily even INSIDE a different host's
   * range. Left as a constant, "double-click restores the default" would quietly
   * become "double-click jumps to whatever 40 clamps to here", which is a worse
   * affordance than not having it.
   */
  @Input() defaultPercent = SPLIT_DEFAULT_PERCENT;

  /** Live — every pointer move. The panes follow this. */
  @Output() percentChange = new EventEmitter<number>();

  /** Settled — end of drag, or one keystroke. Persistence follows this. */
  @Output() commit = new EventEmitter<number>();

  /** Exposed to the host bindings above; `Math` is not in template scope. */
  readonly Math = Math;

  dragging = false;

  /** The two inputs in the shape every function in `split-width.ts` wants. */
  private get bounds(): SplitBounds {
    return { min: this.min, max: this.max };
  }

  /**
   * The last value this divider emitted, so `commit` reports what the user
   * actually dropped even if the host has not fed the new value back yet.
   */
  private lastEmitted: number | null = null;

  /** The bound value, defended against a host that hands over a bad one. */
  get clamped(): number {
    return clampSplitPercent(this.percent, this.bounds);
  }

  get valueText(): string {
    return `${Math.round(this.clamped)}%`;
  }

  onPointerDown(event: PointerEvent): void {
    // Primary button only: a right-click drag is a context menu, and a middle
    // one is a paste on some platforms.
    if (event.button !== 0) {
      return;
    }
    this.lastEmitted = null;
    // Pointer capture, not a document listener: it keeps the events coming
    // when the pointer leaves this 8px strip — which it does immediately. It
    // also releases ITSELF when the pointer is lost, which is not the same as
    // telling us: that is what `lostpointercapture` is bound for.
    //
    // It THROWS on a pointer id the browser has no record of, and an exception
    // escaping here used to leave `dragging` already true with no capture and
    // no handler to clear it — a divider stuck to the pointer until the next
    // release that happens to land on the strip itself. The drag is still
    // worth starting without capture (it just stops tracking once the pointer
    // leaves the strip), so this catches rather than returns.
    try {
      this.host.nativeElement.setPointerCapture(event.pointerId);
    } catch {
      // Nothing to do: `endDrag` tolerates a capture that was never taken.
    }
    this.dragging = true;
    // Otherwise the drag selects the text of both panes as it crosses them.
    event.preventDefault();
    this.host.nativeElement.focus();
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.dragging) {
      return;
    }
    /*
     * THE BACKSTOP, AND THE ONLY ONE THAT CANNOT BE MISSED.
     *
     * Every other end-of-drag path is an event the browser may not send. This
     * one is a fact carried BY the move itself: no button is down, so whatever
     * happened to the release, the drag is over. It is what turns "the divider
     * is still dragging minutes later" into one stale frame.
     *
     * Explicitly `=== 0` rather than falsy: `buttons` is absent on the partial
     * objects specs construct, and treating "not reported" as "released" would
     * make a synthetic drag impossible to write.
     */
    if (event.buttons === 0) {
      this.endDrag(event.pointerId);
      return;
    }
    const rect = this.track.getBoundingClientRect();
    const next = splitPercentFromPointer({
      pointerX: event.clientX,
      containerLeft: rect.left,
      containerWidth: rect.width,
      dividerWidth: this.host.nativeElement.getBoundingClientRect().width,
    }, this.bounds);
    // `null` is an unmeasurable container, and an unchanged value is a pointer
    // move inside the same tenth of a percent — neither is a layout change,
    // and emitting either would re-run change detection for nothing.
    if (next === null || next === this.lastEmitted) {
      return;
    }
    this.lastEmitted = next;
    this.percentChange.emit(next);
  }

  onPointerUp(event: PointerEvent): void {
    this.endDrag(event.pointerId);
  }

  /**
   * Capture ended without a `pointerup` reaching us.
   *
   * The width the panes are showing is the one the user dropped them at, so
   * this settles exactly like a release. There is no pointer id to give back —
   * the capture is already gone, which is what this event means.
   */
  onLostPointerCapture(): void {
    this.endDrag();
  }

  /**
   * The single end of a drag, whichever way it arrives.
   *
   * MUST be safe to run twice, because the paths overlap: an ordinary release
   * fires `pointerup` AND `lostpointercapture`, and a stuck one is ended by the
   * next move instead. What makes it safe is clearing `lastEmitted` — the
   * second call finds nothing to commit, so one drag persists one width. A
   * `dragging` guard here would look like the mechanism and is not one; it was
   * tried, and removing it changed no test and no behaviour.
   */
  private endDrag(pointerId?: number): void {
    this.dragging = false;
    if (
      pointerId !== undefined &&
      this.host.nativeElement.hasPointerCapture(pointerId)
    ) {
      this.host.nativeElement.releasePointerCapture(pointerId);
    }
    // A press-and-release that never moved emitted nothing, and commits
    // nothing: there is no new width, and re-persisting the old one would be a
    // write with no cause.
    if (this.lastEmitted !== null) {
      this.commit.emit(this.lastEmitted);
    }
    this.lastEmitted = null;
  }

  /**
   * FR6. Arrows move the split; Shift makes them coarse, and PageUp/PageDown
   * do the same for a keyboard without a usable Shift+Arrow. Home and End go
   * to the bounds, which is the fastest way to see what each pane looks like
   * at its extreme without dragging there.
   *
   * Every handled key is `preventDefault`ed. Left un-prevented, PageUp/PageDown
   * and Home/End scroll the page under the divider while it moves, and the two
   * motions read as one broken one.
   */
  onKeyDown(event: KeyboardEvent): void {
    const next = this.percentForKey(event);
    if (next === null) {
      return;
    }
    event.preventDefault();
    if (next === this.clamped) {
      // Already at that width — most often a bound. Nothing changed, so
      // nothing is announced and nothing is stored.
      return;
    }
    this.percentChange.emit(next);
    this.commit.emit(next);
  }

  private percentForKey(event: KeyboardEvent): number | null {
    const coarse = event.shiftKey;
    const step = coarse ? SPLIT_COARSE_STEP_PERCENT : SPLIT_FINE_STEP_PERCENT;
    switch (event.key) {
      case 'ArrowLeft':
        return stepSplitPercent(this.percent, -step, this.bounds);
      case 'ArrowRight':
        return stepSplitPercent(this.percent, step, this.bounds);
      case 'PageDown':
        return stepSplitPercent(this.percent, -SPLIT_COARSE_STEP_PERCENT, this.bounds);
      case 'PageUp':
        return stepSplitPercent(this.percent, SPLIT_COARSE_STEP_PERCENT, this.bounds);
      case 'Home':
        return this.min;
      case 'End':
        return this.max;
      default:
        return null;
    }
  }

  /** Double-click restores the default width — the usual splitter idiom. */
  onDoubleClick(): void {
    const restored = clampSplitPercent(this.defaultPercent, this.bounds);
    if (this.clamped === restored) {
      return;
    }
    this.percentChange.emit(restored);
    this.commit.emit(restored);
  }
}
