import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { BehaviorSubject } from 'rxjs';

import { ViewService } from '../view.service';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../testing/i18n-testing';
import { InspectorSide } from '../pane-layout';
import { ConsoleInspectorComponent } from './console-inspector.component';
import { VisualizationOption } from '../../../components/console/inspector/inspector-tabs.component';

/**
 * The inspector is only ever used as a projector, so it is exercised as one:
 * a host that binds the three inputs and drops content into the single slot.
 * Testing it bare would leave the projection contract — the reason the panels
 * can keep `ProcessComponent`'s injector — unasserted.
 */
@Component({
  imports: [ConsoleInspectorComponent],
  template: `
    <app-console-inspector
      [options]="options"
      [mode]="mode"
      [side]="side"
      (modeChange)="seen.push($event)"
      (swapSides)="swaps = swaps + 1"
    >
      <div class="projected-panel">panel body</div>
    </app-console-inspector>
  `,
})
class HostComponent {
  options: VisualizationOption[] = [
    { labelKey: 'visualization.team', value: 'team', icon: 'pi pi-users' },
    { labelKey: 'visualization.member', value: 'member', icon: 'pi pi-user' },
  ];
  mode = 'team';
  side: InspectorSide = 'right';
  seen: string[] = [];
  swaps = 0;
}

describe('ConsoleInspectorComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let collapsed$: BehaviorSubject<boolean>;
  let toggle: jasmine.Spy;

  beforeEach(async () => {
    collapsed$ = new BehaviorSubject<boolean>(false);
    toggle = jasmine.createSpy('toggleRightColumn');

    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideTranslateTesting(),
        {
          provide: ViewService,
          useValue: {
            isRightColumnCollapsed$: collapsed$,
            toggleRightColumn: toggle,
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
  });

  /**
   * First render, deferred out of `beforeEach` so a spec can register its
   * synthetic translations before the first pass — the shape the rest of this
   * codebase's translated specs use, and the one that does not depend on the
   * pipe re-running after a late `setTranslation`.
   */
  function render(): void {
    fixture.detectChanges();
  }

  function inspectorEl(): HTMLElement {
    return fixture.debugElement.query(By.css('app-console-inspector'))
      .nativeElement as HTMLElement;
  }

  /**
   * Addressed by `data-test`, not by position. The title row holds two icon
   * buttons since R3 and a positional query would silently start asserting
   * against the wrong one — which, for a control whose only distinguishing
   * feature is its label, would pass for a while.
   */
  function closeButton(): HTMLButtonElement {
    return fixture.debugElement.query(
      By.css('app-icon-button[data-test="inspector-close"] button'),
    ).nativeElement as HTMLButtonElement;
  }

  function swapButton(): HTMLButtonElement {
    return fixture.debugElement.query(
      By.css('app-icon-button[data-test="inspector-swap"] button'),
    ).nativeElement as HTMLButtonElement;
  }

  /**
   * The id is the conversation header's `aria-controls` target. Nothing errors
   * when `aria-controls` points at an element that does not exist, so the only
   * thing keeping that link honest is an assertion on this side of it.
   */
  it('exposes the pane under the id the header points at', () => {
    render();

    const aside = inspectorEl().querySelector('aside');
    expect(aside).not.toBeNull();
    expect(aside!.id).toBe('console-inspector');
  });

  it('renders whatever the host projects', () => {
    render();

    const projected = inspectorEl().querySelector('.projected-panel');
    expect(projected?.textContent).toBe('panel body');
  });

  /**
   * Collapse is a class on the HOST element, because the host is the flex item
   * whose width the row measures. A class on the inner `<aside>` would animate
   * inside a lane that never changed size, and the conversation beside it would
   * not reclaim the space.
   */
  it('carries the collapsed class only while the pane is collapsed', () => {
    render();

    expect(inspectorEl().classList.contains('collapsed')).toBe(false);

    collapsed$.next(true);
    fixture.detectChanges();
    expect(inspectorEl().classList.contains('collapsed')).toBe(true);

    collapsed$.next(false);
    fixture.detectChanges();
    expect(inspectorEl().classList.contains('collapsed')).toBe(false);
  });

  it('takes a collapsed inspector out of the tab order and off the a11y tree', () => {
    // Worse here than on the rail: this pane holds the tab strip AND the
    // projected panels, so a collapsed pane without `inert` leaves six tab
    // buttons and a whole panel reachable from the keyboard, off screen.
    render();
    const host = inspectorEl();
    expect(host.hasAttribute('inert')).toBeFalse();
    expect(host.getAttribute('aria-hidden')).toBeNull();

    collapsed$.next(true);
    fixture.detectChanges();
    expect(host.hasAttribute('inert')).toBeTrue();
    expect(host.getAttribute('aria-hidden')).toBe('true');

    collapsed$.next(false);
    fixture.detectChanges();
    expect(host.hasAttribute('inert')).toBeFalse();
    expect(host.getAttribute('aria-hidden')).toBeNull();
  });

  /**
   * The pane's own close X and the header's Details button are two controls on
   * ONE piece of root-scoped state, by design. This asserts the pane asks the
   * shared service rather than holding a flag of its own — a local flag would
   * leave the two controls disagreeing after the other one was used.
   */
  it('closes through the shared view state, not a local flag', () => {
    render();

    closeButton().click();

    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('gives the icon-only close control an accessible name', () => {
    setTestTranslations({ inspector: { close: '<<close>>' } });
    render();

    expect(closeButton().getAttribute('aria-label')).toBe('<<close>>');
  });

  it('titles the pane from a translation key, not a caption', () => {
    setTestTranslations({ inspector: { title: '<<details>>' } });
    render();

    expect(inspectorEl().textContent).toContain('<<details>>');
  });

  it('passes the option list straight through to the tab strip', () => {
    render();

    const tabs = inspectorEl().querySelectorAll('[role="tab"]');

    expect(tabs.length).toBe(2);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  });

  /**
   * The mode round-trip. The inspector holds no selection of its own: a tab
   * click has to reach the host, because the host is what decides which panels
   * exist at all and snaps the mode back when one disappears.
   */
  it('re-emits a tab selection to its host without acting on it', () => {
    render();

    const memberTab = inspectorEl().querySelectorAll<HTMLButtonElement>(
      '[role="tab"]',
    )[1];

    memberTab.click();
    fixture.detectChanges();

    expect(host.seen).toEqual(['member']);
    // Untouched until the host binds it back.
    expect(
      inspectorEl().querySelectorAll('[role="tab"]')[0].getAttribute('aria-selected'),
    ).toBe('true');

    host.mode = 'member';
    fixture.detectChanges();
    expect(
      inspectorEl().querySelectorAll('[role="tab"]')[1].getAttribute('aria-selected'),
    ).toBe('true');
  });

  /**
   * R3: the pane can be moved to the other side, and it is the PANE that
   * carries the control — the user decides it is on the wrong side while
   * looking at it.
   */
  describe('(R3) the swap control', () => {
    /**
     * An OUTPUT, not a call into the layout service. The pane holds no
     * arrangement of its own for the same reason it holds no tab selection: the
     * host is what knows there are two panes, and a pane that wrote root state
     * directly would be doing something its host could neither intercept nor
     * decline.
     */
    it('reports the intent to its host rather than acting on it', () => {
      render();

      swapButton().click();
      fixture.detectChanges();

      expect(host.swaps).toBe(1);
      // Nothing moved in here: the pane still faces the way its host says,
      // until the host binds the new side back.
      expect(host.side).toBe('right');
    });

    /**
     * The label names the DESTINATION, not the current position. That is the
     * only thing a button label should promise, and it is what lets a screen
     * reader user know which way the pane will go without knowing which way it
     * faces now.
     */
    it('names where the pane will GO, and flips with the side', () => {
      setTestTranslations({
        inspector: { moveLeft: '<<to-left>>', moveRight: '<<to-right>>' },
      });
      render();

      expect(swapButton().getAttribute('aria-label')).toBe('<<to-left>>');

      host.side = 'left';
      fixture.detectChanges();

      expect(swapButton().getAttribute('aria-label')).toBe('<<to-right>>');
    });

    it('gives the icon-only control a tooltip as well as a name', () => {
      setTestTranslations({ inspector: { moveLeft: '<<to-left>>' } });
      render();

      expect(swapButton().getAttribute('title')).toBe('<<to-left>>');
    });

    /**
     * One glyph, mirrored, rather than two path sets — so the picture cannot
     * drift from the label. The mirror is the marker that says which way it is
     * pointing.
     */
    it('mirrors its glyph rather than carrying a second one', () => {
      render();
      const glyph = (): SVGElement =>
        swapButton().querySelector('svg') as unknown as SVGElement;

      expect(glyph().classList.contains('inspector__swap-glyph--mirrored')).toBeFalse();

      host.side = 'left';
      fixture.detectChanges();

      expect(glyph().classList.contains('inspector__swap-glyph--mirrored')).toBeTrue();
    });

    /** Adding a control must not have moved the one that was already there. */
    it('leaves the close control working', () => {
      render();

      closeButton().click();

      expect(toggle).toHaveBeenCalledTimes(1);
      expect(host.swaps).toBe(0);
    });

    /**
     * Unbound, the pane renders where every version of this console has drawn
     * it. A default of `left` would make an un-migrated host paint the swapped
     * layout with no user having asked for it.
     */
    it('defaults to the right-hand side', () => {
      render();
      // Constructed rather than rendered: the default is what an UNBOUND host
      // gets, and a host that binds `side` — as this fixture's does — cannot
      // show it. `runInInjectionContext` because the component injects
      // `ViewService`.
      const bare = TestBed.runInInjectionContext(
        () => new ConsoleInspectorComponent(),
      );

      expect(bare.side).toBe('right');
      expect(bare.swapLabelKey).toBe('inspector.moveLeft');
    });
  });

  /**
   * W17 — a pane too narrow for a panel says so instead of drawing it.
   *
   * These drive the REAL `ResizeObserver`, by setting a width on the pane and
   * waiting for the measurement to arrive. A stubbed observer would assert that
   * a boolean renders, which is the part that cannot be wrong; the part that
   * can is whether the pane measures the right box and notices at all.
   */
  describe('(W17) the narrow-pane message', () => {
    function inspector(): ConsoleInspectorComponent {
      return fixture.debugElement.query(By.directive(ConsoleInspectorComponent))
        .componentInstance as ConsoleInspectorComponent;
    }

    function notice(): HTMLElement | null {
      return inspectorEl().querySelector('[data-test="inspector-narrow-notice"]');
    }

    function body(): HTMLElement {
      return inspectorEl().querySelector('.inspector__body') as HTMLElement;
    }

    /**
     * Poll a real layout change into view.
     *
     * `ResizeObserver` delivers on a later frame and nothing in Angular knows
     * it is coming, so there is no `whenStable` to await. The loop gives up
     * after ~500ms and lets the assertion that follows fail on its own terms —
     * it never masks a miss by returning early.
     */
    async function until(condition: () => boolean): Promise<void> {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        fixture.detectChanges();
        if (condition()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      fixture.detectChanges();
    }

    /**
     * Size the PANE, as a drag or a rail collapse does, and wait for the
     * measurement rather than for a frame count.
     *
     * The `expect` inside a helper is deliberate: every spec below depends on
     * the observer having fired, and a helper that returned quietly on a
     * timeout would turn "the pane never measured itself" into "the message
     * correctly did not appear".
     */
    async function widthOf(px: number, expectNarrow: boolean): Promise<void> {
      inspectorEl().style.width = `${px}px`;
      await until(() => inspector().isNarrow() === expectNarrow);
      expect(inspector().isNarrow())
        .withContext(`pane measured itself at ${px}px`)
        .toBe(expectNarrow);
    }

    it('replaces a panel that needs room once the pane gets narrow', async () => {
      setTestTranslations({
        inspector: { narrow: { title: '<<narrow>>', blurb: '<<widen>>' } },
      });
      host.mode = 'hierarchy';
      render();

      // Wide: the panel is what the pane shows.
      expect(notice()).toBeNull();
      expect(inspectorEl().querySelector('.projected-panel')).not.toBeNull();

      await widthOf(250, true);

      expect(notice()).not.toBeNull();
      expect(notice()!.textContent).toContain('<<narrow>>');
      expect(notice()!.textContent).toContain('<<widen>>');
    });

    /**
     * REPLACES, not overlays. The projected panel keeps its place in the DOM —
     * remounting the graph on a drag is exactly what `.moved-offscreen` exists
     * to avoid — but it gives up the lane and the tab order, so there is no
     * message printed over a drawing nobody can read.
     */
    it('hides the panel it stands in for, without unmounting it', async () => {
      host.mode = 'hierarchy';
      render();

      await widthOf(250, true);

      expect(body().classList).toContain('inspector__body--replaced');
      expect(body().hasAttribute('inert')).toBeTrue();
      expect(getComputedStyle(body()).display).toBe('none');
      // Still mounted: the panel is hidden, not destroyed.
      expect(inspectorEl().querySelector('.projected-panel')).not.toBeNull();
    });

    /** The user's way out is not only the divider: the strip stays live. */
    it('leaves the tab strip usable so a narrow-friendly panel is one click away', async () => {
      host.mode = 'hierarchy';
      render();

      await widthOf(250, true);

      const tabs = inspectorEl().querySelectorAll<HTMLButtonElement>('[role="tab"]');
      expect(tabs.length).toBe(2);

      tabs[1].click();
      fixture.detectChanges();
      expect(host.seen).toEqual(['member']);
    });

    it('says nothing for a panel that reads fine narrow', async () => {
      host.mode = 'team';
      render();

      await widthOf(250, true);

      expect(notice()).toBeNull();
      expect(body().classList).not.toContain('inspector__body--replaced');
      expect(getComputedStyle(body()).display).not.toBe('none');
    });

    it('withdraws the message the moment the pane is widened again', async () => {
      host.mode = 'hierarchy';
      render();

      await widthOf(250, true);
      expect(notice()).not.toBeNull();

      await widthOf(700, false);

      expect(notice()).toBeNull();
      expect(getComputedStyle(body()).display).not.toBe('none');
    });

    /**
     * Switching TO a panel that needs room, while already narrow, has to show
     * the message too — the width has not changed, so nothing re-measures. This
     * is the case a width-only implementation gets wrong.
     */
    it('answers a tab change as well as a width change', async () => {
      host.mode = 'team';
      render();

      await widthOf(250, true);
      expect(notice()).toBeNull();

      host.mode = 'knowledge-graph';
      fixture.detectChanges();

      expect(notice()).not.toBeNull();
    });

    /**
     * A pane being CLOSED is not a pane that is cramped. The collapse is
     * animated, so it passes through every width on the way to zero; without
     * the collapsed gate the user would watch the graph swap itself for a
     * message on the way out of a pane they just shut.
     */
    it('stays quiet while the pane is collapsed', async () => {
      host.mode = 'hierarchy';
      render();

      await widthOf(250, true);
      expect(notice()).not.toBeNull();

      collapsed$.next(true);
      fixture.detectChanges();

      expect(notice()).toBeNull();
    });
  });
});
