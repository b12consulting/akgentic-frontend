import { CommonModule } from '@angular/common';
import { Component, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import {
  clampRailWidth,
  PANE_LAYOUT_STORAGE_KEY,
  RAIL_DEFAULT_WIDTH_PX,
  RAIL_MIN_WIDTH_PX,
  railBounds,
  railPercentOf,
} from './pane-layout';
import { PaneLayoutService } from './pane-layout.service';
import { SplitDividerComponent } from '../../core/components/primitives/split-divider/split-divider.component';
import { provideTranslateTesting } from '../../../testing/i18n-testing';
import { ConsoleShellComponent } from './console-shell.component';

/**
 * Epic 56 — the console frame.
 *
 * The rail is STUBBED OUT here, by overriding the shell's imports down to
 * `CommonModule` and admitting unknown elements. That is not laziness: the
 * shell's contract with the rail is the SELECTOR and nothing else — no inputs,
 * no outputs — so rendering the real rail would drag its services into this
 * TestBed and would make a rail-internal change fail a shell spec. The rail's
 * own suite owns the rail. `*ngIf` still comes from `CommonModule`, so the one
 * thing this file cares about — whether the element is in the DOM — is live.
 */
@Component({
  imports: [ConsoleShellComponent],
  template: `
    <app-console-shell [chromeVisible]="chromeVisible">
      <p data-test="routed">routed content</p>
    </app-console-shell>
  `,
})
class HostComponent {
  chromeVisible = false;
}

describe('ConsoleShellComponent (Epic 56)', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(async () => {
    localStorage.removeItem(PANE_LAYOUT_STORAGE_KEY);
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [provideTranslateTesting()],
    })
      .overrideComponent(ConsoleShellComponent, {
        set: {
          imports: [CommonModule],
          schemas: [CUSTOM_ELEMENTS_SCHEMA],
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  function rail(): Element | null {
    return fixture.nativeElement.querySelector('app-console-rail');
  }

  function routed(): Element | null {
    return fixture.nativeElement.querySelector('[data-test="routed"]');
  }

  it('renders no rail when the chrome is hidden — the signed-out case', () => {
    // The default, and the safe one: a login screen must not show a rail full
    // of the previous session's teams.
    expect(rail()).toBeNull();
  });

  it('renders the rail when the chrome is visible', () => {
    host.chromeVisible = true;
    fixture.detectChanges();

    expect(rail()).not.toBeNull();
  });

  it('removes the rail again when the chrome is hidden — e.g. on logout', () => {
    host.chromeVisible = true;
    fixture.detectChanges();
    expect(rail()).not.toBeNull();

    host.chromeVisible = false;
    fixture.detectChanges();

    // `*ngIf`, not a CSS class: a hidden-but-mounted rail keeps its
    // subscriptions to the teams list open after sign-out.
    expect(rail()).toBeNull();
  });

  it('projects the routed content in BOTH chrome states', () => {
    // The regression that would break the login route outright: the router
    // outlet is projected, so a shell that only rendered its content when
    // furnished would render a blank page to a signed-out user.
    expect(routed()).not.toBeNull();

    host.chromeVisible = true;
    fixture.detectChanges();

    expect(routed()).not.toBeNull();
  });

  it('projects the routed content INTO the main column, not beside it', () => {
    // The height chain runs host → .console-main → the routed component.
    // Content projected outside that column would be measured against the
    // 100vh host directly and every `flex: 1` below it would resolve against
    // the wrong parent.
    host.chromeVisible = true;
    fixture.detectChanges();

    const main = fixture.nativeElement.querySelector('main.console-main');
    expect(main).not.toBeNull();
    expect(main.contains(routed())).toBeTrue();
  });

  it('orders the rail, then its boundary, then the main column', () => {
    // The shell is one flex row with no `order` anywhere, so DOM order is the
    // visual order — and it is also the tab order, which is the reason to pin
    // it: navigation, then the control that resizes it, then content. The
    // divider is a SIBLING of the rail and never a wrapper around it; wrapped,
    // it would measure the wrong box and the rail would stop being a flex item
    // of this row.
    host.chromeVisible = true;
    fixture.detectChanges();

    const children = Array.from(
      fixture.nativeElement.querySelector('app-console-shell').children,
    ) as Element[];
    expect(children.map((c) => c.tagName.toLowerCase())).toEqual([
      'app-console-rail',
      'app-split-divider',
      'main',
    ]);
  });

  it('defaults chromeVisible to false when the host binds nothing', async () => {
    // A shell dropped in without a binding must fail closed.
    const bare = TestBed.createComponent(ConsoleShellComponent);
    bare.detectChanges();

    expect(bare.componentInstance.chromeVisible).toBeFalse();
    expect(
      bare.nativeElement.querySelector('app-console-rail'),
    ).toBeNull();
  });
});

/**
 * W8b — THE RAIL'S DRAGGABLE EDGE.
 *
 * The rail used to be fixed at `--akg-rail-width` with a collapse toggle and
 * nothing else, and there was exactly ONE `app-split-divider` in the whole
 * application. This block is the second one, and everything it asserts is
 * about the two of them being the SAME mechanism: one component, one
 * preference object, one storage key, one two-channel write contract.
 *
 * THE REAL DIVIDER IS MOUNTED HERE and the rail is still stubbed. The shell's
 * contract with the rail is a selector and two attributes; its contract with
 * the divider is four inputs, two outputs and a measured element, and stubbing
 * that away would leave nothing worth testing.
 *
 * THE SHELL IS GIVEN AN EXPLICIT 1400px WIDTH. Its own `:host` rule is
 * `width: 100%`, which in a Karma iframe is under 800px — narrow enough that
 * the viewport cap (26% ≈ 204px) falls below the rail's 208px floor and the
 * whole range collapses to a point. Every drag assertion would then pass
 * against a divider that cannot move. The inline width beats the `:host` rule,
 * so the specs run against a row the size of the screen the console is used on.
 */
@Component({
  imports: [ConsoleShellComponent],
  template: `
    <app-console-shell style="width: 1400px" [chromeVisible]="chromeVisible">
      <p data-test="routed">routed content</p>
    </app-console-shell>
  `,
})
class ResizeHostComponent {
  chromeVisible = true;
}

describe('ConsoleShellComponent — the rail is resizable (W8b)', () => {
  const TRACK = 1400;

  let fixture: ComponentFixture<ResizeHostComponent>;
  let host: ResizeHostComponent;
  let layout: PaneLayoutService;

  /**
   * Arranged BEFORE the service exists, because `PaneLayoutService` reads
   * storage in its constructor — that is what puts the stored arrangement in
   * hand before the first paint.
   */
  async function render(seed?: Record<string, unknown>): Promise<void> {
    localStorage.removeItem(PANE_LAYOUT_STORAGE_KEY);
    if (seed !== undefined) {
      localStorage.setItem(PANE_LAYOUT_STORAGE_KEY, JSON.stringify(seed));
    }
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ResizeHostComponent],
      providers: [provideTranslateTesting()],
    })
      .overrideComponent(ConsoleShellComponent, {
        set: {
          imports: [CommonModule, SplitDividerComponent],
          schemas: [CUSTOM_ELEMENTS_SCHEMA],
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(ResizeHostComponent);
    host = fixture.componentInstance;
    layout = TestBed.inject(PaneLayoutService);
    fixture.detectChanges();
  }

  afterEach(() => {
    localStorage.removeItem(PANE_LAYOUT_STORAGE_KEY);
  });

  function railEl(): HTMLElement | null {
    return fixture.nativeElement.querySelector('app-console-rail');
  }

  function dividerEl(): HTMLElement | null {
    return fixture.nativeElement.querySelector('app-split-divider');
  }

  function divider(): SplitDividerComponent {
    return fixture.debugElement.query(By.directive(SplitDividerComponent))
      .componentInstance as SplitDividerComponent;
  }

  /** The width actually applied to the rail, in pixels. */
  function appliedWidth(): number {
    return Number.parseFloat(
      railEl()!.style.getPropertyValue('--akg-rail-width').replace('px', ''),
    );
  }

  function stored(): Record<string, number | string> | null {
    const raw = localStorage.getItem(PANE_LAYOUT_STORAGE_KEY);
    return raw === null ? null : (JSON.parse(raw) as Record<string, number | string>);
  }

  /** Drive the divider's outputs, which is what a pointer eventually does. */
  function dragTo(widthPx: number): void {
    dragToPercent(railPercentOf(widthPx, TRACK));
  }

  /**
   * The raw channel, for the cases where the point is a percentage the rail
   * must REFUSE — converting those through `railPercentOf` first would clamp
   * them before the shell ever saw them, and the spec would prove nothing.
   */
  function dragToPercent(percent: number): void {
    divider().percentChange.emit(percent);
    fixture.detectChanges();
  }

  function drop(widthPx: number): void {
    divider().commit.emit(railPercentOf(widthPx, TRACK));
    fixture.detectChanges();
  }

  describe('when the boundary exists at all', () => {
    it('gives the rail a boundary it never had', async () => {
      await render();

      expect(dividerEl()).not.toBeNull();
    });

    it('renders no boundary when there is no rail to move', async () => {
      await render();
      host.chromeVisible = false;
      fixture.detectChanges();

      expect(dividerEl()).toBeNull();
    });

    /**
     * A COLLAPSED RAIL HAS NO DRAGGABLE EDGE — and the reason is not tidiness.
     * With the rail pinned at `width: 0` a drag moves nothing on screen and
     * would still rewrite the stored width, so the user would find the rail at
     * a size they never chose the next time they opened it. Exactly the rule
     * `process.component.html` applies to the inspector's divider.
     *
     * The collapse is expressed as the rail's own host class, which is what
     * the shell's stylesheet keys on — so the class is what this spec sets. It
     * asserts the three properties that make `display: none` an adequate
     * substitute for removing the element: no box, no hit area, no tab stop.
     */
    it('takes the boundary out of reach when the rail collapses, and gives it back', async () => {
      await render();
      const strip = dividerEl()!;

      railEl()!.classList.add('collapsed');
      expect(getComputedStyle(strip).display).toBe('none');
      expect(strip.getBoundingClientRect().width).toBe(0);
      // `display: none` is what takes it out of the tab order; a merely
      // invisible divider would still be focusable from a rail that is not on
      // the screen.
      expect(strip.offsetParent).toBeNull();

      railEl()!.classList.remove('collapsed');
      expect(getComputedStyle(strip).display).not.toBe('none');
      expect(strip.getBoundingClientRect().width).toBeGreaterThan(0);
    });

    it('leaves the stored width alone across a collapse and an expand', async () => {
      await render();
      drop(330);
      const afterDrag = stored();

      railEl()!.classList.add('collapsed');
      fixture.detectChanges();
      railEl()!.classList.remove('collapsed');
      fixture.detectChanges();

      expect(stored()).toEqual(afterDrag!);
    });
  });

  describe('the width it applies', () => {
    it('draws the rail at the token default when nothing is stored', async () => {
      await render();

      expect(appliedWidth()).toBe(RAIL_DEFAULT_WIDTH_PX);
    });

    it('draws the rail at the width the user last dragged it to', async () => {
      await render({ inspectorSide: 'right', inspectorPercent: 26, railWidth: 340 });

      expect(appliedWidth()).toBe(340);
    });

    /**
     * THE MIGRATION, seen from the screen: a browser holding a pre-rail
     * arrangement must render, must render the rail at its default, and must
     * NOT lose the inspector preference it does hold.
     */
    it('renders a pre-rail arrangement without losing the inspector', async () => {
      await render({ inspectorSide: 'left', inspectorPercent: 44 });

      expect(appliedWidth()).toBe(RAIL_DEFAULT_WIDTH_PX);
      expect(layout.inspectorSide()).toBe('left');
      expect(layout.inspectorPercent()).toBe(44);
    });

    /**
     * A WINDOW BORROWS THE WIDTH; IT DOES NOT TAKE IT. The applied width is
     * capped to what fits this row, while the PREFERENCE is left as the user
     * set it — otherwise opening the console once on a laptop would silently
     * and permanently narrow a rail widened on a desktop.
     */
    it('caps what it draws without rewriting what was preferred', async () => {
      await render({ inspectorSide: 'right', inspectorPercent: 26, railWidth: 420 });

      expect(appliedWidth()).toBe(clampRailWidth(420, TRACK));
      expect(appliedWidth()).toBeLessThan(420);
      expect(layout.railWidth()).toBe(420);
      expect(stored()!['railWidth']).toBe(420);
    });
  });

  describe('the boundary is the same control, driving the same preference', () => {
    it('hands the divider the rail range for THIS row, not a nominal one', async () => {
      await render();

      const bounds = railBounds(TRACK);
      expect(divider().min).toBe(bounds.min);
      expect(divider().max).toBe(bounds.max);
      // The measurement is real: a shell that fell back to the nominal row
      // would report a visibly different range.
      expect(divider().percent).toBe(railPercentOf(RAIL_DEFAULT_WIDTH_PX, TRACK));
    });

    it('a live drag lays out but stores NOTHING', async () => {
      await render();

      dragTo(330);

      expect(Math.abs(appliedWidth() - 330)).toBeLessThanOrEqual(1);
      expect(stored()).toBeNull();
    });

    it('the drop persists, into the same document as the inspector', async () => {
      await render();
      layout.commitPercent(41);

      dragTo(330);
      drop(330);

      const entry = stored()!;
      expect(Math.abs((entry['railWidth'] as number) - 330)).toBeLessThanOrEqual(1);
      // One key, one document: the inspector's half is still there and still
      // correct, which a second storage key could not guarantee.
      expect(entry['inspectorPercent']).toBe(41);
      expect(entry['inspectorSide']).toBe('right');
    });

    /**
     * The conversion the shell exists to perform. If it measured the wrong box
     * — the nominal row, the main column, the window — the pixel width would
     * be out by tens of pixels rather than by the tenth-of-a-per-cent the
     * divider quantises to.
     */
    it('converts the divider per cent against the row it measured', async () => {
      await render();

      for (const target of [220, 268, 300, 360]) {
        dragTo(target);
        expect(Math.abs(layout.railWidth() - target))
          .withContext(`${target}px`)
          .toBeLessThanOrEqual(1);
      }
    });

    it('(FR4) refuses to let a drag erase the rail, or let it eat the row', async () => {
      await render();

      dragToPercent(0);
      expect(layout.railWidth()).toBe(RAIL_MIN_WIDTH_PX);
      expect(railEl()).not.toBeNull();

      dragToPercent(100);
      expect(layout.railWidth()).toBe(clampRailWidth(Number.MAX_SAFE_INTEGER, TRACK));
    });

    /**
     * FR6 through the SAME component: a keystroke is a settled change, so it
     * both moves the rail and persists, in one gesture and one write.
     */
    it('is operable from the keyboard, and one keystroke is one write', async () => {
      await render();
      const before = layout.railWidth();

      dividerEl()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
      fixture.detectChanges();

      expect(layout.railWidth()).toBeGreaterThan(before);
      expect(stored()!['railWidth']).toBe(layout.railWidth());
    });

    it('double-click restores the rail to the width the design draws it at', async () => {
      await render({ inspectorSide: 'right', inspectorPercent: 26, railWidth: 360 });

      dividerEl()!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      fixture.detectChanges();

      expect(Math.abs(layout.railWidth() - RAIL_DEFAULT_WIDTH_PX)).toBeLessThanOrEqual(1);
    });
  });

  /**
   * A DRAG IS NOT A COLLAPSE. The rail carries `transition: width` so the
   * collapse toggle reads as a movement; left on during a drag it makes the
   * rail trail the pointer by the transition's duration and never quite
   * arrive. The class is the shell's way of saying "this movement is the
   * pointer's, not an animation".
   */
  it('suppresses the rail width transition for the length of a drag only', async () => {
    await render();
    expect(railEl()!.classList).not.toContain('resizing');

    dragTo(330);
    expect(railEl()!.classList).toContain('resizing');

    drop(330);
    expect(railEl()!.classList).not.toContain('resizing');
  });

  it('labels the separator from the translation catalogue, not a literal', async () => {
    await render();

    // The no-op loader echoes the key, which is the assertion: the label is
    // resolved through `TranslateService` rather than hardcoded English.
    //
    // And it is the RAIL's own key, not the conversation/inspector divider's
    // `console.splitLabel`. There are two splitters on this screen; naming both
    // of them the same thing costs a screen-reader user the only signal that
    // says which one they are on.
    expect(dividerEl()!.getAttribute('aria-label')).toBe(
      'console.railWidthLabel',
    );
  });
});
