import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute } from '@angular/router';
import { BehaviorSubject } from 'rxjs';

import { KnowledgeGraphComponent } from './knowledge-graph.component';
import { KGStateReducer } from '../../../../features/process/selectors/knowledge-graph.selector';
import { GRAPH_CATEGORY_COUNT } from '../../../../core/ui/category.service';
import { provideTranslateTesting } from '../../../../../testing/i18n-testing';

/**
 * The Knowledge-graph panel had NO spec at all, which is most of why it stayed
 * the old design: nothing described what it was supposed to look like, so
 * nothing noticed when the rest of the console moved and it did not.
 *
 * The assertions here are deliberately about the two things a redesign can
 * silently undo — where the colours come from, and whether both readings of the
 * graph are still reachable — rather than about pixel values, which are the
 * stylesheet's business and would pin the design rather than the behaviour.
 */
describe('KnowledgeGraphComponent', () => {
  let fixture: ComponentFixture<KnowledgeGraphComponent>;
  let component: KnowledgeGraphComponent;
  let knowledgeGraph$: BehaviorSubject<{ nodes: unknown[]; edges: unknown[] }>;

  /** The resolved value of a `:root` custom property, as the browser sees it.
   *  `src/styles.scss` is in the Karma bundle, so these are real values. */
  function token(name: string): string {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
  }

  function entity(name: string, type: string): Record<string, unknown> {
    return { id: name, name, entity_type: type, observations: [] };
  }

  /** `getNodeColor` is private by design — it is an implementation of the
   *  palette, not an API — but the palette is exactly what this spec is about,
   *  so it is reached through an index rather than made public for a test. */
  function colorFor(types: string[], type: string): string {
    return (
      component as unknown as {
        getNodeColor(types: string[], type: string): string;
      }
    ).getNodeColor(types, type);
  }

  beforeEach(async () => {
    knowledgeGraph$ = new BehaviorSubject<{ nodes: unknown[]; edges: unknown[] }>(
      { nodes: [], edges: [] },
    );

    await TestBed.configureTestingModule({
      imports: [KnowledgeGraphComponent],
      providers: [
        provideTranslateTesting(),
        provideNoopAnimations(),
        { provide: KGStateReducer, useValue: { knowledgeGraph$ } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { params: { id: 'proc-1' } } },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(KnowledgeGraphComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  /**
   * THE REGRESSION THIS FILE WAS WRITTEN FOR.
   *
   * `getNodeColor` held ten literal hexes — ECharts' own cool default set —
   * against a warm neutral console, and being in a `.ts` file they were the one
   * part of this panel's appearance no deployment could re-point.
   *
   * The assertions are POSITIVE ("this is the ramp's first stop"), not negative
   * ("not one of the old ten"), because any invented colour would pass the
   * negative form. They also pin the panel to the SHARED ramp rather than to a
   * list of its own: two graphs in one inspector painted from two palettes is
   * the same bug one step later.
   */
  describe('the categorical palette', () => {
    it('paints the first entity type in the shared ramp\'s first stop', () => {
      const expected = token('--akg-graph-category-1');
      expect(expected).not.toBe('');
      expect(colorFor(['tool', 'doc'], 'tool')).toBe(expected);
    });

    it('paints the second entity type in the second stop, not a shade of the first', () => {
      expect(colorFor(['tool', 'doc'], 'doc')).toBe(
        token('--akg-graph-category-2'),
      );
      expect(colorFor(['tool', 'doc'], 'doc')).not.toBe(
        colorFor(['tool', 'doc'], 'tool'),
      );
    });

    it('keeps every stop distinguishable — a categorical ramp with a repeat in it is not one', () => {
      const types = Array.from({ length: GRAPH_CATEGORY_COUNT }, (_, i) => `type-${i}`);
      const colours = types.map((t) => colorFor(types, t));
      expect(new Set(colours).size)
        .withContext(`ramp had duplicates: ${colours.join(', ')}`)
        .toBe(types.length);
    });

    it('wraps past the end of the ramp rather than returning nothing', () => {
      const types = Array.from(
        { length: GRAPH_CATEGORY_COUNT + 2 },
        (_, i) => `type-${i}`,
      );
      expect(colorFor(types, `type-${GRAPH_CATEGORY_COUNT}`)).toBe(
        colorFor(types, 'type-0'),
      );
      expect(colorFor(types, `type-${GRAPH_CATEGORY_COUNT + 1}`)).toBe(
        colorFor(types, 'type-1'),
      );
    });

    it('falls back to the first stop for a type the graph does not declare', () => {
      expect(colorFor(['tool'], 'nowhere')).toBe(colorFor(['tool'], 'tool'));
    });
  });

  /**
   * The chart's non-categorical ink. These were left to ECharts' defaults —
   * black labels, mid-grey edges — which is the other half of why the graph
   * read as a screenshot of a different application.
   */
  describe('the chart chrome', () => {
    it('draws labels and edges in the palette, and insets only for the legend', () => {
      knowledgeGraph$.next({
        nodes: [entity('Alpha', 'tool'), entity('Beta', 'doc')],
        edges: [],
      });
      fixture.detectChanges();

      const series = (
        component.graphOptions as {
          series?: { label?: { color?: string }; lineStyle?: { color?: string };
            left?: number; right?: number; top?: number; bottom?: number }[];
        }
      ).series?.[0];

      // The SHARED graph ink, not this panel's own reading of `--akg-text`:
      // the hierarchy tab paints from the same two tokens.
      expect(series?.label?.color).toBe(token('--akg-graph-label'));
      expect(series?.lineStyle?.color).toBe(token('--akg-graph-edge'));

      // `top` clears the legend: the rect is where nodes START and where
      // gravity PULLS, and both want to be under the legend rather than
      // through it.
      expect(series?.top).toBeGreaterThan(0);

      // THE OTHER THREE MUST STAY OFF. They were added as a label-clipping
      // guard and ECharts' force layout has no such guard to arm: the rect
      // sets the gravity centre and the initial scatter, and the stepper never
      // clamps to it. What they did do was take 112px of width out of a ~310px
      // pane and squeeze the simulation into a column.
      expect(series?.left).toBeUndefined();
      expect(series?.right).toBeUndefined();
      expect(series?.bottom).toBeUndefined();
    });

    it('spreads nodes with repulsion, and lets the simulation run to completion', () => {
      const force = (
        component.graphOptions as {
          series?: {
            force?: {
              gravity?: number;
              repulsion?: number;
              friction?: number;
            };
          }[];
        }
      ).series?.[0]?.force;

      // Repulsion acts between EVERY pair, so it is the force that makes the
      // spacing look even; edgeLength speaks only for pairs sharing an edge.
      expect(force?.repulsion).toBeGreaterThanOrEqual(500);

      // A node with no edge feels repulsion only, so gravity has to give it
      // somewhere to fall back to — without being strong enough to collapse
      // the connected cluster onto the centre.
      expect(force?.gravity).toBeGreaterThan(0.1);
      expect(force?.gravity).toBeLessThan(0.2);

      // THE ONE THAT MUST NOT BE SET. In `forceHelper`, friction scales every
      // displacement and decays 0.992 per step until `friction < 0.01` ends
      // the run — so lowering it does not damp the layout, it truncates it.
      // At 0.3 the simulation froze roughly half-relaxed.
      expect(force?.friction).toBeUndefined();
    });

    /**
     * `labelLayout` is series-wide and cannot be scoped: ECharts registers
     * every label — node AND edge — as soon as the option is a function or a
     * non-empty object, then forces each one out of its host's local space and
     * restores the position captured at first render. An edge label is
     * positioned in its LINE'S coordinate space, so that detaches it, and roam
     * re-applies the stale value on every zoom.
     */
    it('sets no labelLayout, which would detach every edge label from its edge', () => {
      const series = (
        component.graphOptions as {
          series?: { labelLayout?: unknown }[];
        }
      ).series?.[0];

      expect(series?.labelLayout).toBeUndefined();
    });
  });

  /**
   * Two relations between the same pair used to be two links with the same
   * endpoints and the same curveness — one stroke, and both captions printed
   * at the same point, on top of each other.
   */
  describe('relations that share a pair', () => {
    function links(): { source: string; target: string;
      label: { formatter: string } }[] {
      return (
        component.graphOptions as {
          series?: { links: { source: string; target: string;
            label: { formatter: string } }[] }[];
        }
      ).series?.[0]?.links ?? [];
    }

    function edge(from: string, to: string, type: string) {
      return { from_entity: from, to_entity: to, relation_type: type };
    }

    it('stacks both captions on the one edge that is actually drawn', () => {
      knowledgeGraph$.next({
        nodes: [entity('Person', 'person'), entity('School', 'org')],
        edges: [
          edge('Person', 'School', 'earned_degree_from'),
          edge('Person', 'School', 'invited_lecturer_at'),
        ],
      });
      fixture.detectChanges();

      expect(links().length).toBe(1);
      // A newline, NOT a comma: read one below the other, as two captions.
      expect(links()[0].label.formatter).toBe(
        'earned_degree_from\ninvited_lecturer_at'
      );
    });

    it('keeps the two directions apart — an arrow must not carry the other way round', () => {
      knowledgeGraph$.next({
        nodes: [entity('Person', 'person'), entity('School', 'org')],
        edges: [
          edge('Person', 'School', 'studied_at'),
          edge('School', 'Person', 'awarded'),
        ],
      });
      fixture.detectChanges();

      expect(links().length).toBe(2);
      expect(links().map((l) => l.label.formatter).sort()).toEqual([
        'awarded',
        'studied_at',
      ]);
    });

    it('prints a relation reported twice over one pair once', () => {
      knowledgeGraph$.next({
        nodes: [entity('Person', 'person'), entity('School', 'org')],
        edges: [
          edge('Person', 'School', 'studied_at'),
          edge('Person', 'School', 'studied_at'),
        ],
      });
      fixture.detectChanges();

      expect(links()[0].label.formatter).toBe('studied_at');
    });

    /**
     * A map keyed on a printable separator would fold `"A|B" -> "C"` into
     * `"A" -> "B|C"`, silently drawing one edge where there are two.
     */
    it('does not confuse two pairs whose names run together', () => {
      knowledgeGraph$.next({
        nodes: [
          entity('A B', 'x'),
          entity('C', 'x'),
          entity('A', 'x'),
          entity('B C', 'x'),
        ],
        edges: [edge('A B', 'C', 'one'), edge('A', 'B C', 'two')],
      });
      fixture.detectChanges();

      expect(links().length).toBe(2);
    });
  });

  /**
   * The two readings, after the `<p-tabView>` came out. The strip was replaced,
   * NOT dropped: both views are still reachable and the panel still opens on
   * the graph.
   */
  describe('the view switch', () => {
    function tabs(): HTMLButtonElement[] {
      return Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
          '.kg-view-tab',
        ),
      );
    }

    it('offers both readings as a tablist and opens on the graph', () => {
      const list = (fixture.nativeElement as HTMLElement).querySelector(
        '[role="tablist"]',
      );
      expect(list).not.toBeNull();
      expect(tabs().length).toBe(2);
      expect(component.activeView).toBe('graph');
      expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
      expect(tabs()[1].getAttribute('aria-selected')).toBe('false');
    });

    it('swaps the canvas for the entity and relation lists when Raw data is chosen', () => {
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('.graph-canvas')).not.toBeNull();
      expect(el.querySelector('.raw-data-content')).toBeNull();

      tabs()[1].click();
      fixture.detectChanges();

      expect(component.activeView).toBe('raw');
      expect(el.querySelector('.raw-data-content')).not.toBeNull();
      expect(el.querySelector('.graph-canvas')).toBeNull();
      expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
    });

    it('keeps the way out of the pane beside the views rather than on top of them', () => {
      const el = fixture.nativeElement as HTMLElement;
      const toolbar = el.querySelector('.kg-toolbar');
      expect(toolbar).not.toBeNull();
      // A SIBLING of the tablist, which is what lets it have a seat of its own:
      // the old Expand button was absolutely positioned over the tab strip
      // because the strip owned the whole row.
      expect(toolbar!.querySelector(':scope > .kg-expand')).not.toBeNull();
      expect(toolbar!.querySelector(':scope > [role="tablist"]')).not.toBeNull();
    });
  });

  /**
   * The empty state is the SHARED component now, not a local reproduction of
   * it. Asserting the element (rather than the classes the copy used) is what
   * makes a future re-fork of the idiom fail here.
   */
  describe('the empty state', () => {
    it('stands in for the canvas with the console\'s one empty-state shape', () => {
      const el = fixture.nativeElement as HTMLElement;
      const empty = el.querySelector('.kg-graph-empty app-inspector-empty-state');
      expect(empty).not.toBeNull();
      expect(empty!.textContent).toContain('knowledgeGraph.emptyTitle');
      expect(empty!.textContent).toContain('knowledgeGraph.emptyBody');
    });

    it('gets out of the way once entities arrive', () => {
      knowledgeGraph$.next({
        nodes: [entity('Alpha', 'tool')],
        edges: [],
      });
      fixture.detectChanges();

      expect(
        (fixture.nativeElement as HTMLElement).querySelector('.kg-graph-empty'),
      ).toBeNull();
    });
  });
});

/**
 * THE PANEL MUST NOT THROW AWAY WHERE THE USER IS LOOKING.
 *
 * `knowledgeGraph$` is `log$.pipe(map(kgFold))` — it emits once per message
 * APPENDED TO THE LOG, not once per knowledge-graph change, and `kgFold`
 * returns a fresh object every time, so there is nothing upstream to dedupe it.
 * A redraw therefore happens on every ordinary chat turn.
 *
 * That is survivable only if a redraw is cheap and non-destructive. A full
 * `setOption(option, true)` is neither: it restarts the force layout and, since
 * the rebuilt option carries `zoom: 1`, resets the pan and zoom the user set by
 * hand. On a graph with enough entities to be worth roaming — the only kind
 * anyone roams — the panel snaps back to the top of the world mid-sentence.
 *
 * This is the same defect the hierarchy graph closed, one panel over, and it is
 * pinned here the same way: the invariants, not a screenshot.
 */
describe('the knowledge canvas', () => {
  let fixture: ComponentFixture<KnowledgeGraphComponent>;
  let component: KnowledgeGraphComponent;
  let knowledgeGraph$: BehaviorSubject<{ nodes: unknown[]; edges: unknown[] }>;

  function entity(name: string, type: string): Record<string, unknown> {
    return { id: name, name, entity_type: type, observations: [] };
  }

  function relation(from: string, to: string): Record<string, unknown> {
    return { from_entity: from, to_entity: to, relation_type: 'uses' };
  }

  /** One macrotask. NOT `whenStable()` — echarts schedules animation work, so
   *  this fixture never reports stable. */
  function settle(): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  async function quiesce(): Promise<void> {
    await settle();
    await settle();
    await settle();
  }

  function chart(): any {
    return (component as unknown as { echartsInstance: any }).echartsInstance;
  }

  /** What echarts will draw from, as its own public API reports it. */
  function drawn(): { nodes: number; links: number; zoom: number } {
    const series = chart().getOption().series[0];
    return {
      nodes: series.data.length,
      links: series.links.length,
      zoom: series.zoom,
    };
  }

  beforeEach(async () => {
    knowledgeGraph$ = new BehaviorSubject<{ nodes: unknown[]; edges: unknown[] }>({
      nodes: [],
      edges: [],
    });

    await TestBed.configureTestingModule({
      imports: [KnowledgeGraphComponent],
      providers: [
        provideTranslateTesting(),
        provideNoopAnimations(),
        { provide: KGStateReducer, useValue: { knowledgeGraph$ } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { params: { id: 'proc-1' } } },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(KnowledgeGraphComponent);
    component = fixture.componentInstance;
    fixture.autoDetectChanges();
    await quiesce();
  });

  it('keeps the pan and zoom the user set when the next message arrives', async () => {
    knowledgeGraph$.next({
      nodes: [entity('Alpha', 'tool'), entity('Beta', 'doc')],
      edges: [relation('Alpha', 'Beta')],
    });
    await quiesce();
    expect(drawn().nodes).toBe(2);

    // The user roams. echarts folds roam into the series' own `zoom`, which is
    // why a rebuilt option carrying `zoom: 1` silently undoes it.
    chart().dispatchAction({ type: 'graphRoam', zoom: 2, originX: 10, originY: 10 });
    await quiesce();
    expect(drawn().zoom)
      .withContext('the roam took effect at all')
      .toBeGreaterThan(1);
    const roamed = drawn().zoom;

    // A GENUINE knowledge-graph change — a third entity — so the redraw really
    // happens rather than being collapsed by the dedupe below. This is the
    // strong form: even a redraw that must occur has to leave the user where
    // they were.
    knowledgeGraph$.next({
      nodes: [
        entity('Alpha', 'tool'),
        entity('Beta', 'doc'),
        entity('Gamma', 'tool'),
      ],
      edges: [relation('Alpha', 'Beta')],
    });
    await quiesce();
    expect(drawn().nodes).withContext('the redraw really happened').toBe(3);

    expect(drawn().zoom)
      .withContext('a message must not send the user back to the top of the world')
      .toBe(roamed);
  });

  it('never hands ngx-echarts a SECOND option object', async () => {
    // `[options]` is a second, NON-merging channel into the same chart:
    // ngx-echarts skips the first change and answers every later one with
    // `setOption(options, true)`. Reassigning `graphOptions` per emission
    // therefore fires a full replace per message on top of whatever the
    // component did itself — the duplicate-channel defect the hierarchy graph
    // closed. One object, built once, filled in place.
    const built = component.graphOptions;
    expect(built).withContext('built before the canvas exists').not.toEqual({});

    knowledgeGraph$.next({
      nodes: [entity('Alpha', 'tool')],
      edges: [],
    });
    await quiesce();

    expect(component.graphOptions)
      .withContext('the same object the directive already applied')
      .toBe(built);
  });

  it('CLEARS when the knowledge graph legitimately goes away', async () => {
    // The other half, and the reason the old code reached for a full replace.
    // A merging `setOption` REPLACES an array-valued key rather than
    // concatenating, so an empty `data` empties the canvas — but that is not
    // obvious from the word "merge", and a chart that kept its last drawing
    // under an empty-state overlay is precisely how the hierarchy pane hid a
    // bug for a release. Asserted, not trusted.
    knowledgeGraph$.next({
      nodes: [entity('Alpha', 'tool'), entity('Beta', 'doc')],
      edges: [relation('Alpha', 'Beta')],
    });
    await quiesce();
    expect(drawn().nodes).toBe(2);

    knowledgeGraph$.next({ nodes: [], edges: [] });
    await quiesce();

    expect(drawn().nodes).toBe(0);
    expect(drawn().links).toBe(0);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.kg-graph-empty'),
    )
      .withContext('and the overlay comes back to say so')
      .not.toBeNull();
  });

  it('drops a legend that no longer has any entity types behind it', async () => {
    knowledgeGraph$.next({
      nodes: [entity('Alpha', 'tool'), entity('Beta', 'doc')],
      edges: [],
    });
    await quiesce();
    expect(chart().getOption().legend[0].data.length).toBe(2);

    knowledgeGraph$.next({ nodes: [], edges: [] });
    await quiesce();

    expect(chart().getOption().legend[0].data.length)
      .withContext('a key for categories that are no longer on the canvas')
      .toBe(0);
  });

  it('does not redraw when the log grew but the knowledge graph did not', async () => {
    // `knowledgeGraph$` emits once per MESSAGE, not once per knowledge-graph
    // change, and the fold hands back a fresh object every time. Re-pushing
    // identical data restarts the force simulation, so the whole graph shuffles
    // itself on every chat turn with nothing new to show for it.
    const data = () => ({
      nodes: [entity('Alpha', 'tool'), entity('Beta', 'doc')],
      edges: [relation('Alpha', 'Beta')],
    });
    knowledgeGraph$.next(data());
    await quiesce();

    const pushed = spyOn(chart(), 'setOption').and.callThrough();
    // Equal, but a different object — exactly what the fold emits.
    knowledgeGraph$.next(data());
    await quiesce();

    expect(pushed).not.toHaveBeenCalled();
  });
});
