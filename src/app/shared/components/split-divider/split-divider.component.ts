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
  splitPercentFromPointer,
  stepSplitPercent,
} from '../../util/split-width';

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
 * `track` is the element the percentage is OF, passed in rather than
 * discovered: reaching for `parentElement` would make the maths depend on how
 * the host chose to wrap this element, which is the kind of coupling that
 * survives until someone adds a wrapper div.
 */
@Component({
  selector: 'app-split-divider',
  template: '',
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

  /** Live — every pointer move. The panes follow this. */
  @Output() percentChange = new EventEmitter<number>();

  /** Settled — end of drag, or one keystroke. Persistence follows this. */
  @Output() commit = new EventEmitter<number>();

  /** Exposed to the host bindings above; `Math` is not in template scope. */
  readonly Math = Math;
  readonly min = SPLIT_MIN_PERCENT;
  readonly max = SPLIT_MAX_PERCENT;

  dragging = false;

  /**
   * The last value this divider emitted, so `commit` reports what the user
   * actually dropped even if the host has not fed the new value back yet.
   */
  private lastEmitted: number | null = null;

  /** The bound value, defended against a host that hands over a bad one. */
  get clamped(): number {
    return clampSplitPercent(this.percent);
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
    this.dragging = true;
    this.lastEmitted = null;
    // Pointer capture, not a document listener: it keeps the events coming
    // when the pointer leaves this 8px strip — which it does immediately —
    // and it releases itself if the pointer is lost.
    this.host.nativeElement.setPointerCapture(event.pointerId);
    // Otherwise the drag selects the text of both panes as it crosses them.
    event.preventDefault();
    this.host.nativeElement.focus();
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.dragging) {
      return;
    }
    const rect = this.track.getBoundingClientRect();
    const next = splitPercentFromPointer({
      pointerX: event.clientX,
      containerLeft: rect.left,
      containerWidth: rect.width,
      dividerWidth: this.host.nativeElement.getBoundingClientRect().width,
    });
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
    if (!this.dragging) {
      return;
    }
    this.dragging = false;
    if (this.host.nativeElement.hasPointerCapture(event.pointerId)) {
      this.host.nativeElement.releasePointerCapture(event.pointerId);
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
        return stepSplitPercent(this.percent, -step);
      case 'ArrowRight':
        return stepSplitPercent(this.percent, step);
      case 'PageDown':
        return stepSplitPercent(this.percent, -SPLIT_COARSE_STEP_PERCENT);
      case 'PageUp':
        return stepSplitPercent(this.percent, SPLIT_COARSE_STEP_PERCENT);
      case 'Home':
        return SPLIT_MIN_PERCENT;
      case 'End':
        return SPLIT_MAX_PERCENT;
      default:
        return null;
    }
  }

  /** Double-click restores the default width — the usual splitter idiom. */
  onDoubleClick(): void {
    if (this.clamped === SPLIT_DEFAULT_PERCENT) {
      return;
    }
    this.percentChange.emit(SPLIT_DEFAULT_PERCENT);
    this.commit.emit(SPLIT_DEFAULT_PERCENT);
  }
}
