import { Component, NgZone } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { GraphComponent } from './graph.component';
import { TeamTabsComponent } from '../team-tabs.component';
import { AkgentService } from '../../../../core/ui/akgent.service';
import { ApiService } from '../../../../core/http/api.service';
import {
  CategoryService,
  graphCategoryColors,
  readToken,
} from '../../../../core/ui/category.service';
import { GraphDataService } from '../../../../services/process/selectors/graph.selector';
import { SelectionService } from '../../../../services/process/ui-state/selection.service';
import { provideTranslateTesting } from '../../../../../testing/i18n-testing';

/**
 * WHAT IS ACTUALLY ON THE CANVAS — which is a different question from what the
 * component thinks it has, and the pane has now lied about it twice.
 *
 * `graph.component.spec.ts` covers the OVERLAY: the DOM that sits on top. This
 * file covers the drawing underneath, because the two can disagree, and when
 * they do neither one is visibly wrong — "No agents available" over a drawn
 * graph, or a blank canvas with no message at all, both look like a styling
 * accident rather than a defect.
 *
 * MOUNTED THROUGH THE REAL `<app-team-tabs>` WRAPPER, and that is load-bearing.
 * The wrapper is `OnPush` with an empty class body, and a fixture that mounts
 * `<app-graph>` as its own root silently deletes it — a fixture root is checked
 * on every tick whatever its strategy, so the barrier that exists in production
 * is absent from the harness. Both defects below live in the gap between those
 * two topologies.
 */

@Component({
  standalone: true,
  imports: [TeamTabsComponent],
  // Default change detection, exactly as `process.component.html` declares it.
  template: `<app-team-tabs></app-team-tabs>`,
})
class HostComponent {}

describe('the hierarchy canvas', () => {
  let fixture: ComponentFixture<HostComponent>;
  let nodes$: BehaviorSubject<any[]>;
  let edges$: BehaviorSubject<any[]>;
  let categories$: BehaviorSubject<any[]>;

  function node(name: string): any {
    return { id: name, name, actorName: name, category: 0, value: 1 };
  }

  function squad(name: string, colour: string): any {
    return { name, squadId: name, itemStyle: { color: colour } };
  }

  /**
   * One macrotask. NOT `whenStable()`: echarts schedules its own animation
   * work, so this fixture never reports stable.
   */
  function settle(): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Let the canvas come up AND let a change-detection pass go by afterwards.
   *
   * Three macrotasks rather than one, and the wait is the point: ngx-echarts
   * creates the chart in a `setTimeout` from `ngAfterViewInit`, so anything
   * emitted before that races the chart's own startup and borrows the
   * change-detection pass that startup produces. Production never has that
   * luck — the first agent arrives seconds after the canvas exists.
   */
  async function quiesce(): Promise<void> {
    await settle();
    await settle();
    await settle();
  }

  function graph(): GraphComponent {
    return fixture.debugElement.query(
      (found) => found.componentInstance instanceof GraphComponent,
    ).componentInstance as GraphComponent;
  }

  function chart(): any {
    return (graph() as any).echartsInstance;
  }

  /** What echarts will draw from, as its own public API reports it. */
  function drawn(): { nodes: number; links: number; legend: string[] } {
    const option = chart().getOption();
    return {
      nodes: option.series[0].data.length,
      links: option.series[0].links.length,
      legend: option.legend[0].data.map((entry: any) =>
        typeof entry === 'string' ? entry : entry.name,
      ),
    };
  }

  beforeEach(async () => {
    nodes$ = new BehaviorSubject<any[]>([]);
    edges$ = new BehaviorSubject<any[]>([]);
    categories$ = new BehaviorSubject<any[]>([]);

    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideTranslateTesting(),
        { provide: GraphDataService, useValue: { nodes$, edges$, categories$ } },
        { provide: ApiService, useValue: {} },
        { provide: AkgentService, useValue: {} },
        {
          //  is part of this service's shape and the graph reads it to
          // colour a node per agent. A stub that omitted it crashed the pane the
          // moment nodes arrived — the stub was lying about the contract, not the
          // caller being unsafe.
          provide: CategoryService,
          useValue: { setSelectedCategory: () => {}, COLORS: ['#101010', '#202020'] },
        },
        { provide: SelectionService, useValue: { handleSelection: () => {} } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(HostComponent);
    // autoDetectChanges: Angular ticks on ZONE ACTIVITY, as the browser does.
    // A manual `detectChanges()` after each emission would supply exactly the
    // pass production is missing and both defects below would pass the test.
    fixture.autoDetectChanges();
  });

  it('never hands ngx-echarts a SECOND option object', async () => {
    // `[options]` is a second channel into the same chart, and it does not
    // merge. ngx-echarts skips only the FIRST change on that input; every
    // later one it answers with `setOption(options, true)` — a full replace of
    // whatever is on the canvas with whatever that object happens to hold.
    //
    // The option used to be built in `onChartInit`, i.e. assigned a second
    // time, carrying a snapshot of `nodes` as they stood when the canvas
    // appeared. Replaying a snapshot over live data is a blank graph with no
    // empty-state to explain it, because `nodes.length` is not what went
    // wrong. It survived only because the OnPush wrapper above meant the
    // binding never fired at all — so the change that makes the overlay work
    // is exactly the change that arms it.
    //
    // The invariant is therefore identity, asserted directly rather than
    // through a symptom: one object, built before the chart exists, never
    // replaced. Data has one route in, the merging `setOption`.
    const zone = TestBed.inject(NgZone);
    const built = graph().graphOptions;
    expect(built)
      .withContext('built in ngOnInit, before the canvas exists')
      .not.toEqual({});

    await quiesce();
    zone.runOutsideAngular(() => {
      categories$.next([squad('Team 0', '#005d46')]);
      edges$.next([{ source: '@Generalist', target: '@Quant' }]);
      nodes$.next([node('@Generalist'), node('@Quant'), node('@Scribe')]);
    });
    await quiesce();

    expect(graph().graphOptions)
      .withContext('the same object the directive already applied')
      .toBe(built);
    expect(graph().nodes.length).toBe(3);
    expect(drawn().nodes)
      .withContext('and the canvas is still drawing the team')
      .toBe(3);
    expect(drawn().links).toBe(1);
    expect(drawn().legend).toEqual(['Team 0']);
  });

  it('CLEARS when the team legitimately goes away', async () => {
    // The other half. An overlay that says "no agents" over a chart that kept
    // its last drawing is indistinguishable from the defect above, so the
    // clearing is asserted rather than trusted to echarts' merge rules:
    // `setOption` REPLACES an array-valued key instead of concatenating, which
    // is the behaviour the empty-state depends on and is not obvious from the
    // word "merge".
    const zone = TestBed.inject(NgZone);
    await quiesce();

    zone.runOutsideAngular(() => {
      categories$.next([squad('Team 0', '#005d46')]);
      edges$.next([{ source: '@Generalist', target: '@Quant' }]);
      nodes$.next([node('@Generalist'), node('@Quant')]);
    });
    await quiesce();
    expect(drawn().nodes).toBe(2);

    zone.runOutsideAngular(() => {
      nodes$.next([]);
      edges$.next([]);
      categories$.next([]);
    });
    await quiesce();

    expect(drawn()).toEqual({ nodes: 0, links: 0, legend: [] });
    expect(fixture.nativeElement.querySelector('.graph-empty'))
      .withContext('and the overlay comes back to say so')
      .not.toBeNull();
  });

  it('DRAWS a team that was already running before the canvas existed', async () => {
    // The ordinary case, and the one with no second chance: opening a team
    // that is already under way. `GraphDataService` is a `BehaviorSubject`
    // chain, so the whole roster is delivered the instant `ngOnInit`
    // subscribes — a macrotask before ngx-echarts creates the canvas. There is
    // nothing to merge into in that window, so the option object the directive
    // is about to apply is filled IN PLACE instead. If it were replaced rather
    // than filled, the new reference would be answered with a notMerge replace
    // and the team would be wiped by the change-detection pass after it.
    //
    // No `quiesce()` first: emitting into the window is the whole test.
    const zone = TestBed.inject(NgZone);
    zone.runOutsideAngular(() => {
      categories$.next([squad('Team 0', '#005d46')]);
      nodes$.next([node('@Generalist'), node('@Quant'), node('@Scribe')]);
    });
    await quiesce();

    expect(drawn().nodes).toBe(3);
    expect(drawn().legend).toEqual(['Team 0']);
    expect(fixture.nativeElement.querySelector('.graph-empty')).toBeNull();
  });

  /**
   * A tool is not an actor. The pane answers "who is on this team and who
   * talks to whom"; a tool is something an agent HOLDS, and it is listed as
   * such on the Team panel. On the canvas it was noise the force layout could
   * only push around, since an unused tool has no edge at all.
   */
  describe('tools', () => {
    it('draws the actors and leaves the #-prefixed tools off', async () => {
      nodes$.next([node('@Manager'), node('#VectorStore'), node('@Expert')]);
      await quiesce();

      expect(drawn().nodes).toBe(2);
    });

    it('drops an edge with a tool at either end rather than leaving it dangling', async () => {
      nodes$.next([node('@Manager'), node('#VectorStore'), node('@Expert')]);
      edges$.next([
        { source: '@Manager', target: '@Expert' },
        { source: '@Manager', target: '#VectorStore' },
        { source: '#VectorStore', target: '@Expert' },
      ]);
      await quiesce();

      expect(drawn().links).toBe(1);
    });

    /**
     * FILTERED FOR THE CANVAS ONLY. `nodes` is also what the human-request
     * panel reads and what the empty-state overlay counts — a team of one
     * agent and six tools is not an empty team.
     */
    it('keeps every actor on the component, tools included', async () => {
      nodes$.next([node('@Manager'), node('#VectorStore')]);
      await quiesce();

      expect(graph().nodes.length).toBe(2);
    });
  });
});

describe('the hierarchy canvas — how it is painted', () => {
  let fixture: ComponentFixture<HostComponent>;

  function settle(): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  function graph(): GraphComponent {
    return fixture.debugElement.query(
      (found) => found.componentInstance instanceof GraphComponent,
    ).componentInstance as GraphComponent;
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideTranslateTesting(),
        {
          provide: GraphDataService,
          useValue: {
            nodes$: new BehaviorSubject<any[]>([]),
            edges$: new BehaviorSubject<any[]>([]),
            categories$: new BehaviorSubject<any[]>([]),
          },
        },
        { provide: ApiService, useValue: {} },
        { provide: AkgentService, useValue: {} },
        {
          //  is part of this service's shape and the graph reads it to
          // colour a node per agent. A stub that omitted it crashed the pane the
          // moment nodes arrived — the stub was lying about the contract, not the
          // caller being unsafe.
          provide: CategoryService,
          useValue: { setSelectedCategory: () => {}, COLORS: ['#101010', '#202020'] },
        },
        { provide: SelectionService, useValue: { handleSelection: () => {} } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(HostComponent);
    fixture.autoDetectChanges();
    await settle();
    await settle();
    await settle();
  });

  /** Every string anywhere in a subtree, with the path that reached it. */
  function strings(value: unknown, path = ''): { path: string; value: string }[] {
    if (typeof value === 'string') return [{ path, value }];
    if (Array.isArray(value)) {
      return value.flatMap((entry, index) => strings(entry, `${path}[${index}]`));
    }
    if (value !== null && typeof value === 'object') {
      return Object.entries(value).flatMap(([key, entry]) =>
        strings(entry, path ? `${path}.${key}` : key),
      );
    }
    return [];
  }

  it('hands the canvas RESOLVED colours, never a var() reference', () => {
    // THE ONE RULE THIS CHART BREAKS DIFFERENTLY FROM EVERY OTHER SURFACE.
    // Elsewhere "use a token" means writing `var(--akg-…)` in CSS. echarts
    // paints with the CANVAS renderer, and a canvas has no cascade: `var(...)`
    // is not a colour it fails to look up, it is a string it cannot parse, and
    // the mark silently goes black or vanishes. So the component resolves the
    // tokens through `getComputedStyle` and passes literals.
    //
    // The TOOLTIP is the stated exception and is excluded here rather than
    // rewritten: echarts renders it as real DOM inside the document, so `var()`
    // resolves there and a rebrand reaches it.
    const option = graph().graphOptions as Record<string, unknown>;
    const { tooltip: _tooltip, ...canvasBound } = option;
    const leaked = strings(canvasBound)
      .filter((entry) => entry.value.includes('var('))
      .map((entry) => `${entry.path} = ${entry.value}`);
    expect(leaked).toEqual([]);
  });

  it('draws nodes, edges and labels from the palette', () => {
    const series = (graph().graphOptions as any).series[0];
    expect((graph().graphOptions as any).color)
      .withContext('the default mark palette is the categorical ramp')
      .toEqual(graphCategoryColors());
    expect(series.lineStyle.color).toBe(readToken('--akg-graph-edge'));
    expect(series.label.color).toBe(readToken('--akg-graph-label'));
    expect(series.label.textBorderColor)
      .withContext('the label halo is cut out of the ground, or it is an outline')
      .toBe(readToken('--akg-graph-ground'));
    expect(series.itemStyle.borderColor).toBe(readToken('--akg-graph-ground'));
    expect(series.label.fontFamily).toBe(readToken('--akg-font-ui'));
  });

  it('leaves the labels somewhere to go', () => {
    const series = (graph().graphOptions as any).series[0];

    // TRUNCATION IS THE CLIPPED-LABEL FIX, and it is the only one available.
    // A name too long for its lane ends in an ellipsis rather than mid glyph;
    // the full name is in the tooltip.
    expect(series.label.overflow).toBe('truncate');
    expect(series.label.width).toBeGreaterThan(0);

    // NOT LAYOUT INSETS. `left` / `right` / `bottom` stood here claiming to
    // keep a node off the canvas edge so its label could not spill. echarts'
    // force layout takes the rect for the gravity centre and the initial
    // scatter and never clamps to it, so they held nothing back and only
    // narrowed the simulation.
    expect(series.left).toBeUndefined();
    expect(series.right).toBeUndefined();
    expect(series.bottom).toBeUndefined();

    // `zoom` scales the laid-out graph about its centre after the fact and is
    // the user's own control through roam. Spread belongs in the distance
    // params, not here.
    expect(series.zoom).toBe(1);
  });

  /**
   * One inspector, one mark size. The shape already distinguishes the two
   * graphs — a roundRect for an agent here, a circle for an entity there — and
   * drawing one at 15px and the other at 26px made them read as two different
   * applications a tab apart.
   */
  it('draws its nodes and captions at the knowledge graph\'s size', () => {
    const series = (graph().graphOptions as any).series[0];
    expect(series.symbolSize).toEqual([26, 26]);
    expect(series.label.fontSize).toBe(12.5);
    // The truncation cap is in pixels, so it moves with the font or it
    // truncates more at the larger size rather than the same.
    expect(series.label.width).toBe(120);
  });

  it('spreads the graph through the distance params, and runs the layout out', () => {
    const force = (graph().graphOptions as any).series[0].force;

    // `edgeLength` and `repulsion` are what echarts offers for "further
    // apart". Repulsion rises as the SQUARE of the distance wanted: it falls
    // off as `rep / d` where gravity rises as `gravity * d`.
    expect(force.edgeLength).toEqual([150, 350]);
    expect(force.repulsion).toBe(1125);

    // THE ONE THAT MUST NOT BE SET. In `forceHelper` friction scales every
    // displacement and decays 0.992 per step until `friction < 0.01` ends the
    // run, so lowering it truncates the simulation rather than damping it. At
    // 0.15 this layout stopped a long way short of relaxed.
    expect(force.friction).toBeUndefined();
  });

  it('pulls disconnected nodes back toward the middle', () => {
    // A force layout holds a graph together through its EDGES. A node with
    // none — every unused tool is one — feels only repulsion and drifts until
    // it hits the edge of the lane, which is why the user's screenshots have
    // tools in the corners and the agents crushed into the centre. Gravity is
    // the only term every node feels regardless of its edges; echarts defaults
    // it to 0.1, which is nothing against this repulsion.
    const force = (graph().graphOptions as any).series[0].force;
    expect(force.gravity).toBeGreaterThan(0.1);
  });

  it('names the full agent in the tooltip, since the label may be cut short', () => {
    const tooltip = (graph().graphOptions as any).tooltip;
    const named = tooltip.formatter({
      dataType: 'node',
      data: { actorName: '@KnowledgeGraphToolCard' },
    });
    expect(named).toContain('KnowledgeGraphToolCard');
    // An error still gets its own line underneath, and still escapes.
    const failed = tooltip.formatter({
      dataType: 'node',
      data: { actorName: '@Quant', errorMessage: '<script>boom</script>' },
    });
    expect(failed).toContain('&lt;script&gt;');
    expect(failed).not.toContain('<script>');
  });

  it('escapes the agent NAME too, not just the error beside it', () => {
    // echarts renders this tooltip as real DOM inside the document — that is
    // why `var()` resolves in it — so every interpolated value is an HTML sink.
    // `errorMessage` was escaped and `actorName` was not, which was survivable
    // only while the formatter returned '' for any node that had not errored.
    // Giving every node a tooltip made the unescaped one reachable by HOVER, on
    // every node of every team, from a name the backend/catalog controls.
    const tooltip = (graph().graphOptions as any).tooltip;
    const hostile = tooltip.formatter({
      dataType: 'node',
      data: { actorName: '<img src=x onerror=alert(1)>' },
    });
    expect(hostile).not.toContain('<img');
    expect(hostile).toContain('&lt;img');
  });
});
