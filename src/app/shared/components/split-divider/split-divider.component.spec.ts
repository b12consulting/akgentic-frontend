import { Component, ViewChild } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import {
  SPLIT_COARSE_STEP_PERCENT,
  SPLIT_DEFAULT_PERCENT,
  SPLIT_FINE_STEP_PERCENT,
  SPLIT_MAX_PERCENT,
  SPLIT_MIN_PERCENT,
} from '../../util/split-width';
import { SplitDividerComponent } from './split-divider.component';

/**
 * Story 52-2. The ARITHMETIC has its own browser-free suite in
 * `split-width.spec.ts` (NFR3); what is left for this file is the part that
 * genuinely needs an element: the ARIA a separator carries (FR6), which keys
 * are handled and which are left alone, and the two-output contract that keeps
 * one drag from writing storage sixty times.
 */
@Component({
  imports: [SplitDividerComponent],
  template: `
    <div #track style="width: 1000px">
      <app-split-divider
        [track]="track"
        [percent]="percent"
        [label]="label"
        [min]="min"
        [max]="max"
        [defaultPercent]="defaultPercent"
        (percentChange)="live.push($event)"
        (commit)="commits.push($event)"
      />
    </div>
  `,
})
class HostComponent {
  @ViewChild(SplitDividerComponent) divider!: SplitDividerComponent;
  percent = 40;
  label = 'Teams list width';
  // Bound to the module defaults, so every spec below this one exercises the
  // pre-R3 behaviour through the new inputs rather than around them — which is
  // the thing that would otherwise rot: a defaulted input nobody ever binds.
  min = SPLIT_MIN_PERCENT;
  max = SPLIT_MAX_PERCENT;
  defaultPercent = SPLIT_DEFAULT_PERCENT;
  live: number[] = [];
  commits: number[] = [];
}

describe('SplitDividerComponent (Story 52-2)', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let element: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
    element = fixture.debugElement.query(By.directive(SplitDividerComponent))
      .nativeElement as HTMLElement;
  });

  function press(key: string, options: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    element.dispatchEvent(event);
    fixture.detectChanges();
    return event;
  }

  describe('(FR6) the ARIA a separator needs', () => {
    it('is a focusable separator with a range and a label', () => {
      expect(element.getAttribute('role')).toBe('separator');
      expect(element.getAttribute('aria-orientation')).toBe('vertical');
      expect(element.getAttribute('tabindex')).toBe('0');
      expect(element.getAttribute('aria-label')).toBe('Teams list width');
      expect(element.getAttribute('aria-valuemin')).toBe(String(SPLIT_MIN_PERCENT));
      expect(element.getAttribute('aria-valuemax')).toBe(String(SPLIT_MAX_PERCENT));
    });

    it('reports the current width, rounded — a tenth is layout, not information', () => {
      expect(element.getAttribute('aria-valuenow')).toBe('40');
      expect(element.getAttribute('aria-valuetext')).toBe('40%');

      host.percent = 43.4;
      fixture.detectChanges();
      expect(element.getAttribute('aria-valuenow')).toBe('43');
      expect(element.getAttribute('aria-valuetext')).toBe('43%');
    });

    it('reports a clamped value even when handed one out of range', () => {
      host.percent = 500;
      fixture.detectChanges();
      expect(element.getAttribute('aria-valuenow')).toBe(String(SPLIT_MAX_PERCENT));
    });
  });

  /**
   * W8a — IT HAS TO LOOK LIKE A CONTROL BEFORE IT IS TOUCHED.
   *
   * The user's report was not "the divider is ugly", it was "I cannot resize".
   * The divider was there and worked; it drew a 2px hairline in the same tone
   * as every other border and only distinguished itself on HOVER — which is
   * the one state a user who cannot find it will never reach, and which no
   * touch device has at all.
   *
   * So the assertion is specifically about the RESTING state. A grip that
   * exists but is `display: none` or transparent until `:hover` would satisfy
   * "there is a grip" and would reproduce the bug exactly.
   */
  describe('(W8a) the resting affordance', () => {
    function grip(): HTMLElement | null {
      return element.querySelector('.split-divider__grip');
    }

    it('draws a grip mark without being touched first', () => {
      const mark = grip();
      expect(mark).not.toBeNull();

      const style = getComputedStyle(mark!);
      expect(style.display).not.toBe('none');
      expect(style.visibility).not.toBe('hidden');
      expect(Number.parseFloat(style.opacity)).toBeGreaterThan(0);
      // A mark with no area is a mark nobody can see.
      expect(mark!.getBoundingClientRect().height).toBeGreaterThan(0);
      expect(mark!.getBoundingClientRect().width).toBeGreaterThan(0);
    });

    /**
     * The host is already a labelled `separator` carrying a value and a range.
     * The grip is that control's paint; announced separately it would be one
     * control spoken as two.
     */
    it('is paint, not a second control: hidden from the reader and from the pointer', () => {
      expect(grip()!.getAttribute('aria-hidden')).toBe('true');
      expect(getComputedStyle(grip()!).pointerEvents).toBe('none');
    });

    /**
     * The hit area is the HOST, and it has only ever been allowed to grow: the
     * grip sits a few pixels from the transcript's scrollbar, and the strip is
     * what keeps the two from reading as one smudge. Anything narrower than
     * the original 0.65rem would make a divider that was merely hard to find
     * hard to HIT as well.
     */
    it('keeps a hit area wider than the mark it draws', () => {
      const strip = element.getBoundingClientRect();
      const mark = grip()!.getBoundingClientRect();

      // 0.65rem at the default 16px root.
      expect(strip.width).toBeGreaterThanOrEqual(10.4);
      expect(strip.width).toBeGreaterThan(mark.width);
    });

    it('still reports the pointer to the HOST, so the grip is not a hole in the control', () => {
      // `pointer-events: none` on the mark is what makes this true; without it
      // a press that landed on the middle of the divider — the part that looks
      // most like a handle — would never start a drag.
      //
      // SCROLLED INTO VIEW FIRST, and that is not a formality.
      // `elementFromPoint` takes VIEWPORT coordinates and returns null for any
      // point outside it. Karma stacks every suite's fixture in one document,
      // so where this one lands vertically depends on which specs ran before
      // it — and the suite order is randomised. Without this the test passed
      // or failed by lottery: it failed on two runs out of three here while
      // the behaviour it describes never changed.
      element.scrollIntoView({ block: 'center' });
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      // If the probe is still outside the viewport the hit test cannot mean
      // anything, so say THAT rather than reporting a null as a design defect.
      expect(x)
        .withContext('probe x is outside the viewport')
        .toBeGreaterThanOrEqual(0);
      expect(y)
        .withContext('probe y is outside the viewport')
        .toBeGreaterThanOrEqual(0);
      expect(y)
        .withContext('probe y is below the viewport')
        .toBeLessThan(window.innerHeight);

      expect(document.elementFromPoint(x, y)).toBe(element);
    });
  });

  describe('(FR6) keyboard operation', () => {
    it('arrows move by the fine step', () => {
      press('ArrowRight');
      expect(host.live).toEqual([40 + SPLIT_FINE_STEP_PERCENT]);
      host.live = [];
      press('ArrowLeft');
      expect(host.live).toEqual([40 - SPLIT_FINE_STEP_PERCENT]);
    });

    it('Shift makes the arrows coarse', () => {
      press('ArrowRight', { shiftKey: true });
      expect(host.live).toEqual([40 + SPLIT_COARSE_STEP_PERCENT]);
    });

    it('PageUp / PageDown are coarse without needing a modifier', () => {
      press('PageUp');
      expect(host.live).toEqual([40 + SPLIT_COARSE_STEP_PERCENT]);
      host.live = [];
      press('PageDown');
      expect(host.live).toEqual([40 - SPLIT_COARSE_STEP_PERCENT]);
    });

    it('Home and End go to the bounds', () => {
      press('Home');
      expect(host.live).toEqual([SPLIT_MIN_PERCENT]);
      host.live = [];
      host.percent = 40;
      fixture.detectChanges();
      press('End');
      expect(host.live).toEqual([SPLIT_MAX_PERCENT]);
    });

    it('a keystroke is a settled change — it moves the panes AND persists', () => {
      press('ArrowRight');
      expect(host.live).toEqual([41]);
      expect(host.commits).toEqual([41]);
    });

    it('prevents the default so the page does not scroll under a moving divider', () => {
      for (const key of ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']) {
        host.percent = 40;
        fixture.detectChanges();
        expect(press(key).defaultPrevented)
          .withContext(key)
          .toBeTrue();
      }
    });

    it('leaves keys it does not handle to whatever else wants them', () => {
      const event = press('Tab');
      expect(event.defaultPrevented).toBeFalse();
      expect(host.live).toEqual([]);
      expect(host.commits).toEqual([]);
    });

    it('(FR4) a keystroke at a bound announces and stores nothing', () => {
      host.percent = SPLIT_MIN_PERCENT;
      fixture.detectChanges();
      press('ArrowLeft');
      expect(host.live).toEqual([]);
      expect(host.commits).toEqual([]);
    });
  });

  describe('the two outputs are not the same event', () => {
    it('double-click restores the default, as one settled change', () => {
      host.percent = 62;
      fixture.detectChanges();
      element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      fixture.detectChanges();
      expect(host.live).toEqual([SPLIT_DEFAULT_PERCENT]);
      expect(host.commits).toEqual([SPLIT_DEFAULT_PERCENT]);
    });

    it('double-click at the default width changes nothing and stores nothing', () => {
      host.percent = SPLIT_DEFAULT_PERCENT;
      fixture.detectChanges();
      element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      fixture.detectChanges();
      expect(host.live).toEqual([]);
      expect(host.commits).toEqual([]);
    });

    it('a move with no drag in progress emits nothing at all', () => {
      host.divider.onPointerMove({ clientX: 800 } as PointerEvent);
      expect(host.live).toEqual([]);
    });
  });

  /**
   * THE DRAG THAT WOULD NOT LET GO.
   *
   * Reported from use: after releasing the button, the divider sometimes keeps
   * following the pointer. `pointerup` is the only path the original code had,
   * and it is not a guaranteed event — capture can end without one (released
   * outside the window, the element re-rendered mid-drag, the OS taking the
   * pointer), and `setPointerCapture` can throw before the handler that would
   * have cleared `dragging` was ever reachable.
   *
   * Three ways out, because no single one of them is certain to arrive. Each
   * spec here drives ONE of them with the others withheld, which is what makes
   * them evidence about that path rather than about whichever fires first.
   */
  describe('a drag always ends', () => {
    /** A drag in progress that has already moved the panes once. */
    function dragging(): void {
      const trackEl = fixture.nativeElement.querySelector('div') as HTMLElement;
      spyOn(trackEl, 'getBoundingClientRect').and.returnValue({
        left: 0,
        width: 1000,
      } as DOMRect);
      // Set directly rather than via `pointerdown`: `setPointerCapture`
      // rejects a pointer id the browser has no record of, and the capture is
      // not what these specs are about.
      host.divider.dragging = true;
      host.divider.onPointerMove({ clientX: 600, buttons: 1 } as PointerEvent);
      expect(host.live.length)
        .withContext('the drag must actually be moving before it is ended')
        .toBe(1);
    }

    it('stops on the first move with no button held, and settles there', () => {
      dragging();
      const moved = host.live[0];

      host.divider.onPointerMove({ clientX: 800, buttons: 0 } as PointerEvent);

      expect(host.divider.dragging).toBeFalse();
      // The move that ended the drag is not also a drag step: the pointer was
      // no longer held anywhere along the way to 800.
      expect(host.live).toEqual([moved]);
      expect(host.commits)
        .withContext('the width the user let go at is the one to keep')
        .toEqual([moved]);
    });

    it('does not follow the pointer once a buttonless move has ended it', () => {
      dragging();
      const moved = host.live[0];

      host.divider.onPointerMove({ clientX: 800, buttons: 0 } as PointerEvent);
      host.divider.onPointerMove({ clientX: 300, buttons: 0 } as PointerEvent);
      host.divider.onPointerMove({ clientX: 900, buttons: 0 } as PointerEvent);

      expect(host.live).toEqual([moved]);
      expect(host.commits).toEqual([moved]);
    });

    it('stops when capture is lost without any pointerup', () => {
      dragging();
      const moved = host.live[0];

      element.dispatchEvent(
        new Event('lostpointercapture', { bubbles: true }),
      );
      fixture.detectChanges();

      expect(host.divider.dragging).toBeFalse();
      expect(host.commits).toEqual([moved]);
    });

    /**
     * The release fires BOTH `pointerup` and `lostpointercapture`, so the
     * second one to arrive must be a no-op. Committing twice would persist the
     * same width twice and, on a host that treats a commit as a user action,
     * count one drag as two. Clearing `lastEmitted` is what prevents it — this
     * spec is what says so, having gone green against a `dragging` guard that
     * looked like the reason and was not.
     */
    it('settles once when both end-of-drag events arrive', () => {
      dragging();
      const moved = host.live[0];

      host.divider.onPointerUp({ pointerId: 1 } as PointerEvent);
      element.dispatchEvent(
        new Event('lostpointercapture', { bubbles: true }),
      );
      fixture.detectChanges();

      expect(host.commits).toEqual([moved]);
    });

    /**
     * `setPointerCapture` throws on a pointer id the browser has no record of
     * — which is every synthetic `pointerdown`, and in a real browser a pointer
     * the OS has already taken back. The throw used to escape the handler with
     * `dragging` already set, leaving a divider nothing on the page could stop.
     */
    it('starts a drag even when the pointer cannot be captured', () => {
      spyOn(element, 'setPointerCapture').and.throwError('NotFoundError');

      expect(() =>
        element.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
        ),
      ).not.toThrow();
      expect(host.divider.dragging).toBeTrue();

      // And it is still a drag that ends: the backstop does not need capture.
      host.divider.onPointerMove({ clientX: 800, buttons: 0 } as PointerEvent);
      expect(host.divider.dragging).toBeFalse();
    });
  });

  /**
   * R3. The range is the HOST's.
   *
   * This divider measures the LEFTMOST pane, so one preference about one
   * identified pane ("the inspector may have 18..50% of the row") reads as two
   * different ranges depending on which side that pane is on. Hard-coded
   * bounds cannot express that, and the failure is silent: the drag simply
   * stops somewhere the user did not ask for.
   */
  describe('(R3) the bounds are inputs, not module constants', () => {
    /** The console's range with the inspector leading: 18..50. */
    function narrowRange(): void {
      host.min = 18;
      host.max = 50;
      host.defaultPercent = 26;
      fixture.detectChanges();
    }

    it('defaults to the teams-list range, so an unbound host is unchanged', () => {
      expect(host.divider.min).toBe(SPLIT_MIN_PERCENT);
      expect(host.divider.max).toBe(SPLIT_MAX_PERCENT);
      expect(host.divider.defaultPercent).toBe(SPLIT_DEFAULT_PERCENT);
    });

    it('announces the bound range, not the module one', () => {
      narrowRange();

      expect(element.getAttribute('aria-valuemin')).toBe('18');
      expect(element.getAttribute('aria-valuemax')).toBe('50');
    });

    it('clamps the value it reports to the bound range', () => {
      narrowRange();
      host.percent = 65;
      fixture.detectChanges();

      expect(element.getAttribute('aria-valuenow')).toBe('50');
    });

    it('steps inside the bound range and stops at its ceiling', () => {
      narrowRange();
      host.percent = 49;
      fixture.detectChanges();

      press('ArrowRight', { shiftKey: true });

      expect(host.live).toEqual([50]);
    });

    it('Home and End go to the BOUND range, not the module one', () => {
      narrowRange();

      press('Home');
      expect(host.live).toEqual([18]);

      host.live = [];
      host.percent = 30;
      fixture.detectChanges();
      press('End');
      expect(host.live).toEqual([50]);
    });

    it('a keystroke at a bound of the NARROWED range announces and stores nothing', () => {
      narrowRange();
      host.percent = 50;
      fixture.detectChanges();

      press('ArrowRight');

      expect(host.live).toEqual([]);
      expect(host.commits).toEqual([]);
    });

    /**
     * The mirrored arrangement: the inspector on the RIGHT makes the
     * conversation the leading pane, and the same preference reads as 50..82.
     * Both halves have to be reachable, or a swap would silently lose range.
     */
    it('serves the mirrored range just as well', () => {
      host.min = 50;
      host.max = 82;
      host.percent = 74;
      fixture.detectChanges();

      press('Home');
      expect(host.live).toEqual([50]);

      host.live = [];
      host.percent = 74;
      fixture.detectChanges();
      press('End');
      expect(host.live).toEqual([82]);
    });

    it('double-click restores the BOUND default, which the module one is not', () => {
      narrowRange();
      host.percent = 44;
      fixture.detectChanges();

      element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      fixture.detectChanges();

      expect(host.live).toEqual([26]);
      expect(host.commits).toEqual([26]);
    });

    it('double-click at the bound default changes nothing', () => {
      narrowRange();
      host.percent = 26;
      fixture.detectChanges();

      element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      fixture.detectChanges();

      expect(host.live).toEqual([]);
      expect(host.commits).toEqual([]);
    });

    /**
     * The pointer path takes the bounds too. It is the only one a user drives
     * with a mouse, so a clamp missing HERE is the one they would actually hit.
     */
    it('a drag is clamped to the bound range', () => {
      narrowRange();
      const trackEl = fixture.nativeElement.querySelector('div') as HTMLElement;
      spyOn(trackEl, 'getBoundingClientRect').and.returnValue({
        left: 0,
        width: 1000,
      } as DOMRect);

      // `dragging` directly rather than a synthetic `pointerdown`:
      // `setPointerCapture` rejects a pointer id the browser has no record of,
      // and the capture is not what this spec is about.
      host.divider.dragging = true;
      // 900px of a 1000px track is 90% — well past the 50% ceiling.
      host.divider.onPointerMove({ clientX: 900 } as PointerEvent);

      expect(host.live).toEqual([50]);
    });
  });
});
