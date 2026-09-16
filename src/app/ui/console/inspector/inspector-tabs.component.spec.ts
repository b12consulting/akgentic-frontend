import { ComponentFixture, TestBed } from '@angular/core/testing';

import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../testing/i18n-testing';
import {
  InspectorTabsComponent,
  VisualizationOption,
} from './inspector-tabs.component';

/**
 * One of the entries `ProcessComponent` can offer. Specs pass SUBSETS on
 * purpose: the two conditional entries (Knowledge graph, Workspaces) are
 * filtered out by the host when their tool is absent, and the strip must render
 * exactly what it was handed rather than a fixed count.
 */
function option(value: string): VisualizationOption {
  return {
    labelKey: 'visualization.' + value,
    value,
    icon: 'pi pi-users',
  };
}

/**
 * The full six, with the REAL icons `ProcessComponent` ships.
 *
 * The width specs below have to use the production glyphs: the whole point of
 * the icon-only strip is a pixel budget, and a budget measured against a
 * stand-in icon measures nothing. Six is also the worst case — it is the set
 * the user sees when both conditional tools are present.
 */
function allSixOptions(): VisualizationOption[] {
  return [
    { labelKey: 'visualization.team', value: 'team', icon: 'pi pi-users' },
    {
      labelKey: 'visualization.hierarchy',
      value: 'hierarchy',
      icon: 'pi pi-share-alt',
    },
    { labelKey: 'visualization.member', value: 'member', icon: 'pi pi-id-card' },
    {
      labelKey: 'visualization.knowledgeGraph',
      value: 'knowledge-graph',
      icon: 'pi pi-sitemap',
    },
    {
      labelKey: 'visualization.workspaces',
      value: 'workspace',
      icon: 'pi pi-folder-open',
    },
    {
      labelKey: 'visualization.messages',
      value: 'messages',
      icon: 'pi pi-envelope',
    },
  ];
}

describe('InspectorTabsComponent', () => {
  let fixture: ComponentFixture<InspectorTabsComponent>;
  let component: InspectorTabsComponent;
  let emitted: string[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InspectorTabsComponent],
      providers: [provideTranslateTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(InspectorTabsComponent);
    component = fixture.componentInstance;
    emitted = [];
    component.modeChange.subscribe((value) => emitted.push(value));
  });

  /** Bind the two inputs the way the inspector does, and render. */
  function render(options: VisualizationOption[], mode: string): void {
    fixture.componentRef.setInput('options', options);
    fixture.componentRef.setInput('mode', mode);
    fixture.detectChanges();
  }

  function tabs(): HTMLButtonElement[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
        '[role="tab"]',
      ),
    );
  }

  /**
   * The guard on the host's filtering.
   *
   * `visualizationOptions$` drops Knowledge graph and Workspaces when their
   * tools are absent, and that filtering is a live rule that reacts mid-team.
   * A strip that drew a fixed five, or that kept a stale entry, would offer a
   * tab whose panel is not mounted — so the count is asserted, not just the
   * presence of the ones passed.
   */
  it('renders one tab per option and no more', () => {
    render([option('team'), option('member'), option('messages')], 'team');

    expect(tabs().length).toBe(3);
  });

  /**
   * The caption is threaded onto every tab — it is only DRAWN on one.
   *
   * This assertion used to read `textContent`. It moved to `aria-label` rather
   * than being deleted, because it is the only guard that the label reaches the
   * five tabs that do not draw it: a dropped binding would show up on screen as
   * a perfectly normal-looking row of glyphs and nowhere else.
   */
  it('labels each tab with its translation KEY, not a caption', () => {
    render([option('team'), option('member')], 'team');

    // The no-op loader echoes the key back, so this asserts the key reached the
    // template — and keeps passing the day the English changes.
    expect(tabs().map((tab) => tab.getAttribute('aria-label'))).toEqual([
      'visualization.team',
      'visualization.member',
    ]);
  });

  /**
   * `title` is the sighted user's half of the trade: the caption is one hover
   * away rather than on screen. It resolves the SAME key as `aria-label` —
   * two surfaces for one string, so they cannot drift into disagreeing about
   * what a tab is called.
   */
  it('puts the same caption in the native title, for a hover', () => {
    render([option('team'), option('member')], 'team');

    expect(tabs().map((tab) => tab.getAttribute('title'))).toEqual([
      'visualization.team',
      'visualization.member',
    ]);
  });

  /**
   * The accessible-name guard.
   *
   * Five of the six tabs draw nothing but a glyph, so `aria-label` is their
   * ONLY source of a name — drop it and the strip becomes five unnamed buttons,
   * which is worse than the `p-selectbutton` this component replaced.
   */
  it('gives every tab a non-empty accessible name, drawn or not', () => {
    render(allSixOptions(), 'team');

    for (const tab of tabs()) {
      expect(tab.getAttribute('aria-label')?.length).toBeGreaterThan(0);
    }
  });

  /**
   * R4. ONE caption on screen, and it is the current tab's.
   *
   * The icon-only strip that closed the overflow left `title` as the only
   * sighted affordance — and `title` needs a hover, which a touch device does
   * not have. This is the half that gives the name back without reintroducing
   * the six-caption overflow: the selected tab is the one tab whose caption can
   * be afforded, and it is also the one whose name is worth stating.
   */
  it('draws the caption on the SELECTED tab and on no other', () => {
    render(allSixOptions(), 'member');

    const drawn = tabs()
      .filter((tab) => (tab.textContent ?? '').trim() !== '')
      .map((tab) => tab.getAttribute('aria-label'));

    expect(drawn).toEqual(['visualization.member']);
  });

  it('moves the caption with the selection', () => {
    render(allSixOptions(), 'team');
    expect(tabs()[0].textContent?.trim()).toBe('visualization.team');

    fixture.componentRef.setInput('mode', 'messages');
    fixture.detectChanges();

    expect(tabs()[0].textContent?.trim()).toBe('');
    expect(tabs()[5].textContent?.trim()).toBe('visualization.messages');
  });

  /**
   * The visible caption and the accessible name must be ONE string, not two
   * that happen to agree today (WCAG 2.5.3, Label in Name). They resolve the
   * same key, which is what makes that structural rather than a coincidence to
   * re-verify on every copy change.
   */
  it('draws exactly the string it announces', () => {
    setTestTranslations({ visualization: { team: '<<team>>' } });
    render([option('team'), option('member')], 'team');

    expect(tabs()[0].textContent?.trim()).toBe('<<team>>');
    expect(tabs()[0].getAttribute('aria-label')).toBe('<<team>>');
    expect(tabs()[0].getAttribute('title')).toBe('<<team>>');
  });

  /**
   * Exactly ONE name per tab. The icon was `aria-hidden` before because it
   * repeated the caption beside it; it stays `aria-hidden` for the opposite
   * reason — it is now decorative relative to the button's own `aria-label`,
   * and announced it would give the tab a second name. The drawn caption is
   * hidden for that same reason.
   */
  it('hides the icon AND the drawn caption from the accessibility tree', () => {
    render(allSixOptions(), 'team');

    const host = fixture.nativeElement as HTMLElement;
    const icons = host.querySelectorAll('i');
    expect(icons.length).toBe(6);
    for (const icon of Array.from(icons)) {
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }

    const captions = host.querySelectorAll('.inspector-tabs__caption');
    expect(captions.length).toBe(1);
    expect(captions[0].getAttribute('aria-hidden')).toBe('true');
  });

  /**
   * R4's other half: the glyph is the only thing telling the five unselected
   * tabs apart, so two of them may not share a mark. `pi-user` against
   * `pi-users` was one head against two at 13px — the exact pair this asserts
   * cannot come back.
   */
  it('gives the six real tabs six distinct glyphs', () => {
    const icons = allSixOptions().map((entry) => entry.icon);

    expect(new Set(icons).size).toBe(icons.length);
    expect(icons).not.toContain('pi pi-user');
  });

  it('marks exactly one tab selected, and it is the one `mode` names', () => {
    render([option('team'), option('member'), option('messages')], 'member');

    const selected = tabs().filter(
      (tab) => tab.getAttribute('aria-selected') === 'true',
    );
    expect(selected.length).toBe(1);
    expect(selected[0].getAttribute('aria-label')).toBe('visualization.member');
  });

  /**
   * A roving tabindex: the whole strip is one Tab stop, not five. Without it a
   * keyboard user pays four extra keystrokes to walk past a control they were
   * not aiming for.
   */
  it('keeps a single tab stop — only the selected tab is tabbable', () => {
    render([option('team'), option('member'), option('messages')], 'member');

    expect(tabs().map((tab) => tab.getAttribute('tabindex'))).toEqual([
      '-1',
      '0',
      '-1',
    ]);
  });

  /**
   * The link that lets a screen reader say what a tab reveals. It is asserted
   * because nothing errors when `aria-controls` names an element that does not
   * exist — the ids on the projected panels in `process.component.html` are the
   * other half of this contract.
   */
  it('points each tab at the panel it reveals', () => {
    render([option('team'), option('knowledge-graph')], 'team');

    expect(tabs().map((tab) => tab.getAttribute('aria-controls'))).toEqual([
      'inspector-panel-team',
      'inspector-panel-knowledge-graph',
    ]);
    expect(tabs().map((tab) => tab.id)).toEqual([
      'inspector-tab-team',
      'inspector-tab-knowledge-graph',
    ]);
  });

  it('emits the option VALUE on click, never its label', () => {
    render([option('team'), option('messages')], 'team');

    tabs()[1].click();

    expect(emitted).toEqual(['messages']);
  });

  /**
   * The strip is stateless: it asks for a change and waits to be told. If it
   * moved its own selection, the host's rule that snaps the mode back to `team`
   * when a tool disappears would have a second opinion to fight.
   */
  it('does not select itself — the view follows `mode`, not the click', () => {
    render([option('team'), option('messages')], 'team');

    tabs()[1].click();
    fixture.detectChanges();

    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs()[1].getAttribute('aria-selected')).toBe('false');
  });

  function arrow(key: string): void {
    (fixture.nativeElement as HTMLElement)
      .querySelector('[role="tablist"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }

  it('ArrowRight moves to the next tab', () => {
    render([option('team'), option('member'), option('messages')], 'team');

    arrow('ArrowRight');

    expect(emitted).toEqual(['member']);
  });

  it('ArrowRight from the LAST tab wraps to the first', () => {
    render([option('team'), option('member'), option('messages')], 'messages');

    arrow('ArrowRight');

    expect(emitted).toEqual(['team']);
  });

  it('ArrowLeft from the FIRST tab wraps to the last', () => {
    render([option('team'), option('member'), option('messages')], 'team');

    arrow('ArrowLeft');

    expect(emitted).toEqual(['messages']);
  });

  it('Home and End jump to the ends', () => {
    render([option('team'), option('member'), option('messages')], 'member');

    arrow('Home');
    arrow('End');

    expect(emitted).toEqual(['team', 'messages']);
  });

  /**
   * Selection and focus move together. An arrow key that changed the selection
   * without moving focus would leave focus on a tab that `aria-selected` now
   * says is not the current one — which is the exact state the attribute
   * promises cannot happen.
   */
  it('moves focus with the selection', () => {
    render([option('team'), option('member'), option('messages')], 'team');

    arrow('ArrowRight');

    expect(document.activeElement).toBe(tabs()[1]);
  });

  it('ignores keys it does not handle', () => {
    render([option('team'), option('member')], 'team');

    arrow('a');

    expect(emitted).toEqual([]);
  });

  it('survives an empty option list', () => {
    render([], 'team');

    arrow('ArrowRight');

    expect(tabs().length).toBe(0);
    expect(emitted).toEqual([]);
  });

  /**
   * The tablist needs a name of its own — there are two tab strips reachable on
   * this screen once the panels have their own sub-tabs, and "tab list" twice
   * over tells a screen-reader user nothing.
   */
  it('names the tablist from a translation key', () => {
    setTestTranslations({ inspector: { tablist: '<<tablist>>' } });
    render([option('team')], 'team');

    const tablist = (fixture.nativeElement as HTMLElement).querySelector(
      '[role="tablist"]',
    );
    expect(tablist?.getAttribute('aria-label')).toBe('<<tablist>>');
  });

  // -------------------------------------------------------------------
  // R4 — the strip must fit, at every width the pane can take.
  // -------------------------------------------------------------------

  /**
   * Put the rendered strip in a lane of a known width and measure it.
   *
   * The fixture's own host is attached to the document by the TestBed but sits
   * at the body's width, which is not a pane. Moving it into a fixed-width
   * container is what makes `scrollWidth` / `offsetTop` mean what the budget
   * says they mean.
   */
  function measureInLane<T>(width: number, read: (strip: HTMLElement) => T): T {
    const host = fixture.nativeElement as HTMLElement;
    const lane = document.createElement('div');
    lane.style.width = width + 'px';
    document.body.appendChild(lane);
    lane.appendChild(host);
    try {
      return read(host.querySelector<HTMLElement>('[role="tablist"]')!);
    } finally {
      // Karma keeps the document between specs; a stray lane would change the
      // next measurement.
      lane.remove();
    }
  }

  /**
   * The requirement itself, stated as a measurement.
   *
   * 310px is the inspector's width today; 240px is the pixel floor the pane
   * carries (`--akg-inspector-min-width`) so that a user dragging the divider
   * cannot squeeze the strip below its one-row budget. Both are asserted
   * because fixing R4 at only one width is how it regressed the first time —
   * the scroll hid an overflow that was present at every width.
   *
   * Rendered WITH the selected tab's caption, which is the state a user is
   * always in: there is no mode in which no tab is selected. The caption's cap
   * is a share of the strip rather than a fixed width, so the one-row property
   * has to hold at the narrow end too — a cap tuned for 310px that overflows at
   * 240px would be the same class of bug measured at one width.
   */
  for (const width of [310, 240]) {
    it('fits all six tabs in one row at ' + width + 'px, with no horizontal scrolling', () => {
      render(allSixOptions(), 'team');

      const { scrollWidth, clientWidth, rows } = measureInLane(width, (strip) => ({
        scrollWidth: strip.scrollWidth,
        clientWidth: strip.clientWidth,
        // Distinct vertical offsets = distinct rows. One row means `flex-wrap`
        // never fired, which is the difference between the safety net being
        // available and it being load-bearing.
        rows: new Set(tabs().map((tab) => tab.offsetTop)).size,
      }));

      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      expect(rows).toBe(1);
    });
  }

  /**
   * The mechanism, not just the outcome.
   *
   * `overflow-x: auto` was the old answer and it is the one thing R4 forbids:
   * it does not make the tabs reachable, it makes them scrollable, which is why
   * "Messages" was effectively invisible. `flex-wrap: wrap` replaces it so that
   * an unexpected width produces a second row rather than a hidden tab — the
   * outcome above proves the budget, this proves there is no scrollbar to fall
   * back on if the budget is ever wrong.
   */
  it('never offers a horizontal scrollbar — it wraps instead', () => {
    render(allSixOptions(), 'team');

    // Snapshot INSIDE the lane: `getComputedStyle` returns a live declaration,
    // and once `measureInLane` detaches the element every property reads back
    // as an empty string — a passing-looking assertion measuring nothing.
    const styles = measureInLane(310, (strip) => {
      const computed = window.getComputedStyle(strip);
      return { overflowX: computed.overflowX, flexWrap: computed.flexWrap };
    });

    expect(['auto', 'scroll']).not.toContain(styles.overflowX);
    expect(styles.flexWrap).toBe('wrap');
  });

  /**
   * The wrap is a net, and a net has to actually catch. At a width no pane can
   * reach, the failure mode must still be a second row rather than a clipped
   * or scrolled tab — every tab stays on screen and stays clickable.
   */
  /**
   * The caption yields before the layout does.
   *
   * `knowledge-graph` carries the longest English name in the set and a longer
   * French one. At the pane's floor there is not room for it, and the required
   * behaviour is that it ELLIPSISES — the strip stays one row and the full
   * string stays on `title`/`aria-label`. If the caption could push the tab
   * onto a second row, the strip's height would change with the selection, and
   * every translation would be a fresh layout risk.
   */
  it('ellipsises a caption that will not fit rather than wrapping the strip', () => {
    setTestTranslations({
      visualization: { knowledgeGraph: 'A caption far longer than any pane' },
    });
    render(allSixOptions(), 'knowledge-graph');

    const { rows, scrollWidth, clientWidth, clipped } = measureInLane(240, (strip) => {
      const caption = strip.querySelector<HTMLElement>('.inspector-tabs__caption')!;
      return {
        rows: new Set(tabs().map((tab) => tab.offsetTop)).size,
        scrollWidth: strip.scrollWidth,
        clientWidth: strip.clientWidth,
        // The ellipsis fired: the text wants more room than it was given.
        clipped: caption.scrollWidth > caption.clientWidth,
      };
    });

    expect(rows).toBe(1);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    expect(clipped).toBeTrue();
  });

  it('wraps rather than clips when squeezed below the budget', () => {
    render(allSixOptions(), 'team');

    const { scrollWidth, clientWidth, rows } = measureInLane(120, (strip) => ({
      scrollWidth: strip.scrollWidth,
      clientWidth: strip.clientWidth,
      rows: new Set(tabs().map((tab) => tab.offsetTop)).size,
    }));

    expect(rows).toBeGreaterThan(1);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});
