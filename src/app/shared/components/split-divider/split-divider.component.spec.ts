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
});
