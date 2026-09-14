import { CommonModule } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
import {
  Component,
  inject,
  NgZone,
  OnDestroy,
  OnInit,
  Input,
  HostBinding,
} from '@angular/core';
import { trigger, style, transition, animate } from '@angular/animations';
import { ActivatedRoute } from '@angular/router';
import { BehaviorSubject, Subscription } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';

import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { FieldsetModule } from 'primeng/fieldset';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { MarkdownModule } from 'ngx-markdown';

import { GraphChart } from 'echarts/charts';
import {
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { EChartsCoreOption } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { NgxEchartsDirective, provideEchartsCore } from 'ngx-echarts';

import { KGStateReducer } from '../../selectors/knowledge-graph.selector';
import { graphCategoryColors, readToken } from '../../../../core/ui/category.service';
import { InspectorEmptyStateComponent } from '../../../console/inspector/inspector-empty-state.component';

echarts.use([
  CanvasRenderer,
  TitleComponent,
  TooltipComponent,
  GraphChart,
  LegendComponent,
]);

interface KnowledgeGraphEntity {
  // V2 wire: uuid string, required. The projection from `KGStateReducer`
  // always carries `id`; component keeps it optional only to tolerate any
  // legacy fixture/test that builds entities manually without an id.
  id?: string;
  // V2 wire: optional flag (backend only sends it when `True`).
  is_root?: boolean;
  name?: string;
  entity_type?: string;
  description?: string;
  observations?: any[];
}

interface KnowledgeGraphRelation {
  // V2 wire: uuid string, required (see note above on id optionality).
  id?: string;
  from_entity?: string;
  to_entity?: string;
  relation_type?: string;
  // V2 wire: optional, defaults to "" on the wire.
  description?: string;
}

interface KnowledgeGraphData {
  nodes: KnowledgeGraphEntity[];
  edges: KnowledgeGraphRelation[];
}

/**
 * The two readings of one graph.
 *
 * NOT A TAB STRIP ANY MORE, and the distinction matters. The hierarchy tab shed
 * its inner `<p-tabs>` because that strip held ONE tab whose caption repeated
 * what the picker beside it already said — a control that could not be
 * operated. This strip held two, both operable, showing genuinely different
 * things: a force layout you can read SHAPE off but not text, and the entity /
 * relation prose (descriptions are markdown, observations are sentences) that
 * has nowhere to live on a 30px node. So the SPLIT earns its place.
 *
 * What did not earn its place is `<p-tabView>`. It is deprecated PrimeNG whose
 * Aura nav — a white bar, a blue ink line, 1rem labels — was the loudest thing
 * in a 310px pane, kept presentable only by ~60 lines of `::ng-deep` fighting a
 * library we are asking to look like something it is not; and the Expand
 * control had to be absolutely positioned ON TOP of that nav because the strip
 * owned the whole row. Two buttons and a `role="tablist"` are the same
 * affordance, in the console's own language, with room beside them.
 */
type KnowledgeGraphView = 'graph' | 'raw';

/**
 * Graph chrome that is not a category: ink, edges, legend, node outline.
 *
 * `--akg-graph-label` and `--akg-graph-edge` are the SHARED graph tokens the
 * hierarchy tab also paints with — one palette for both graphs, so a deployment
 * that re-points the ramp does not end up with two differently-coloured graphs
 * in the same inspector. The remaining three are ordinary console tokens,
 * because a legend caption, a relation caption and a node's halo are pane
 * furniture rather than graph ink.
 */
const CHROME_TOKENS = {
  label: '--akg-graph-label',
  edgeLabel: '--akg-text-muted',
  edge: '--akg-graph-edge',
  legend: '--akg-text-muted',
  nodeBorder: '--akg-overlay-bg',
  labelGround: '--akg-overlay-bg',
} as const;

/**
 * The one inset the force layout has any business carrying: legend clearance.
 *
 * THIS IS NOT A CLIPPING GUARD, and it never was. The four-sided version that
 * stood here claimed the insets "stop the NODE from reaching the edge" so its
 * wider label could not spill off the canvas. ECharts does no such thing:
 * `forceLayout` hands the coordinate system's rect to the stepper, and
 * `forceHelper` uses it for exactly two purposes —
 *
 *     center = [rect.x + width / 2, rect.y + height / 2];   // the gravity target
 *     n.p = width * (Math.random() - 0.5) + center[0], ...  // the initial scatter
 *
 * — with no clamping anywhere in the loop. Nodes leave the rect freely, and
 * roam moves the viewport independently of it. So `left` / `right` / `bottom`
 * bought nothing and cost a great deal: 112px of width out of a ~310px
 * inspector pane left the simulation a tall narrow column and dragged the
 * gravity centre into it, which is most of why the layout stopped looking
 * evenly spread.
 *
 * `top` survives because the two things the rect DOES control — where nodes
 * start and where gravity pulls them — are both better off below the legend.
 */
const LAYOUT_TOP_INSET = 44;

/** Joins the two ends of a directed pair into one map key. See `buildLinks`. */
const PAIR_SEPARATOR = '\u0000';

@Component({
  selector: 'app-knowledge-graph',
  imports: [
    CommonModule,
    TranslatePipe,
    NgxEchartsDirective,
    ButtonModule,
    FieldsetModule,
    CardModule,
    TagModule,
    DialogModule,
    MarkdownModule,
    InspectorEmptyStateComponent,
  ],
  templateUrl: './knowledge-graph.component.html',
  styleUrl: './knowledge-graph.component.scss',
  providers: [provideEchartsCore({ echarts })],
  animations: [
    trigger('slideIn', [
      transition(':enter', [
        style({ transform: 'translateX(100%)', opacity: 0 }),
        animate(
          '300ms ease-in-out',
          style({ transform: 'translateX(0)', opacity: 1 })
        ),
      ]),
      transition(':leave', [
        animate(
          '300ms ease-in-out',
          style({ transform: 'translateX(100%)', opacity: 0 })
        ),
      ]),
    ]),
  ],
})
export class KnowledgeGraphComponent implements OnInit, OnDestroy {
  @Input() isModal = false;
  @Input() processId?: string; // Allow process ID to be passed as input for modal mode

  @HostBinding('class.modal-mode') get modalMode() {
    return this.isModal;
  }

  isModalView = false;
  showKGModal = false;

  openKGModal(): void {
    this.showKGModal = true;
  }

  zone: NgZone = inject(NgZone);
  route: ActivatedRoute = inject(ActivatedRoute);
  // Story 6.2 (ADR-005 §Decision 4): subscribe to the pure selector instead
  // of the former ingestion knowledgeGraph$ passthrough (deleted).
  private readonly kgReducer: KGStateReducer = inject(KGStateReducer);

  currentProcessId: string = '';
  graphData$ = new BehaviorSubject<KnowledgeGraphData | null>(null);
  error$ = new BehaviorSubject<string | null>(null);

  echartsInstance: any;
  graphOptions: EChartsCoreOption = {};

  /**
   * The data slices of `graphOptions`, HELD BY REFERENCE.
   *
   * There is a window — from `ngOnInit` until ngx-echarts creates the canvas a
   * macrotask later — in which there is no chart to merge into, and the feed is
   * a `BehaviorSubject` that fires on subscribe, so for an already-populated
   * graph that window contains everything. Writing INTO these objects fills the
   * option the directive is about to apply without replacing `graphOptions`
   * itself, and not replacing it is the whole point: a new reference on that
   * input is answered with a notMerge replace.
   */
  private seededSeries: {
    data: unknown[];
    links: unknown[];
    categories: unknown[];
  } | null = null;
  private seededLegend: { data: string[]; show: boolean } | null = null;
  selectedNode$ = new BehaviorSubject<KnowledgeGraphEntity | null>(null);

  /**
   * Which reading is on screen. A typed union rather than the old numeric
   * `activeTabIndex`: an index is only meaningful to whoever wrote the tab
   * order down, and it silently survives a reorder that changes what it means.
   */
  activeView: KnowledgeGraphView = 'graph';

  /**
   * The resolved categorical ramp, computed ONCE per component.
   *
   * `getComputedStyle` forces a style recalculation, and the old per-node call
   * site ran it once per node per redraw. The palette cannot change without a
   * stylesheet swap, so a graph of forty entities has no business asking the
   * browser forty times what green is.
   */
  private categoryPalette: readonly string[] | null = null;

  /** Resolved chrome colours, same reasoning as `categoryPalette`. */
  private chromePalette: Record<keyof typeof CHROME_TOKENS, string> | null =
    null;

  setView(view: KnowledgeGraphView): void {
    this.activeView = view;
  }

  // Node properties sidebar visibility
  showNodeProperties = false;

  private subscriptions: Subscription[] = [];

  ngOnInit(): void {
    // Get process ID either from input (modal mode) or route (normal mode)
    this.currentProcessId = this.processId || this.route.snapshot.params['id'];

    // Initialize with empty data to ensure chart is always created
    this.graphData$.next({ nodes: [], edges: [] });

    this.subscriptions.push(
      this.kgReducer.knowledgeGraph$.subscribe((data) => {
        this.graphData$.next(data || { nodes: [], edges: [] });
        this.error$.next(null);
      })
    );

    // BUILT ONCE, BEFORE THE CHART EXISTS, AND NEVER REASSIGNED. The option
    // object the template binds used to be assigned only from inside
    // `(chartInit)` — so the directive's first render was handed `{}` and the
    // real options existed only after a callback the empty state may keep from
    // firing — and then, after that was fixed, was reassigned per emission,
    // which armed `[options]`' notMerge channel. See `buildChartOptions`.
    this.graphOptions = this.buildChartOptions();

    // ONE render path, driven by the data.
    //
    // DEDUPED, because the source is not what its name suggests:
    // `knowledgeGraph$` is `log$.pipe(map(kgFold))`, so it emits once per
    // message appended to the log — every ordinary chat turn — and `kgFold`
    // returns a fresh object each time, so nothing upstream collapses the runs.
    // Re-pushing identical data restarts the force simulation, which the user
    // sees as the whole graph shuffling itself mid-sentence for no reason.
    this.subscriptions.push(
      this.graphData$
        .pipe(
          distinctUntilChanged(
            (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {}),
          ),
        )
        .subscribe((data) => {
          this.pushData(data || { nodes: [], edges: [] });
        })
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
  }

  onChartInit(ec: any): void {
    this.echartsInstance = ec;
    this.echartsInstance.resize();

    // The instance arrived after the options did; push what we already have.
    const currentData = this.graphData$.value;
    this.pushData(currentData || { nodes: [], edges: [] });

    // Handle click events - open/close sidebar
    this.echartsInstance.on('click', (params: any) => {
      this.zone.run(() => {
        if (params.dataType === 'node') {
          // Open sidebar and set the selected node
          this.showNodeProperties = true;
          this.selectedNode$.next({
            name: params.data.name,
            entity_type: params.data.category,
            description: params.data.description,
            observations: params.data.observations,
          });
        } else if (params.dataType === 'edge') {
          // Close sidebar when clicking on edge
          this.showNodeProperties = false;
          this.selectedNode$.next(null);
        } else {
          // Close sidebar when clicking on empty space
          this.showNodeProperties = false;
          this.selectedNode$.next(null);
        }
      });
    });

    // Handle hover events - update content if sidebar is open
    this.echartsInstance.on('mouseover', (params: any) => {
      if (params.dataType === 'node' && this.showNodeProperties) {
        // Update the selected node content on hover if sidebar is open using Angular zone
        this.zone.run(() => {
          this.selectedNode$.next({
            name: params.data.name,
            entity_type: params.data.category,
            description: params.data.description,
            observations: params.data.observations,
          });
        });
      }
    });
  }

  /**
   * Everything about the chart that is NOT data. BUILT ONCE, NEVER REASSIGNED.
   *
   * Two separate defects made this one method rather than a builder called per
   * emission.
   *
   * THE USER'S PLACE. `knowledgeGraph$` is `log$.pipe(map(kgFold))` — it fires
   * once per message appended to the log, not once per knowledge-graph change.
   * The previous shape answered each of those with
   * `setOption(wholeOption, true)`, a notMerge replace carrying `zoom: 1`, so a
   * roamed graph snapped back to the top of the world on the next chat turn and
   * the force layout restarted under the cursor. `zoom` lives here now: applied
   * once, never re-sent, and roam is left alone.
   *
   * THE SECOND CHANNEL. `[options]` is a non-merging input — ngx-echarts skips
   * the FIRST change and answers every later one with `setOption(options,
   * true)`. Assigning `graphOptions` a fresh object per emission therefore
   * fired a full replace per message on top of the component's own call. One
   * object, built before the canvas exists, filled in place by `pushData`.
   */
  private buildChartOptions(): EChartsCoreOption {
    const chrome = this.chrome();

    // Held by reference — see `seededSeries`. `pushData` writes INTO these when
    // there is no canvas yet, so the option the directive is about to apply is
    // already current without its identity changing.
    const series = {
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      // Legend clearance, and nothing else — see LAYOUT_TOP_INSET for why the
      // other three sides came off.
      top: LAYOUT_TOP_INSET,
      force: {
        // REPULSION IS WHAT MAKES THE SPACING LOOK DELIBERATE. It is the only
        // force acting between every pair of nodes, so it is the one that
        // spreads them evenly; `edgeLength` speaks only for pairs that share
        // an edge and `gravity` only toward the centre. Dropping it to 220 let
        // those two dominate and the result read as arbitrary. 500 and
        // [50, 200] are the values the panel shipped with before the redesign,
        // restored.
        // THE DISTANCE PARAMS THEMSELVES, half again. `edgeLength` is the
        // target length of an edge in pixels; `repulsion` sets how far apart
        // nodes with no edge between them settle. Between them they are what
        // "spread the graph out" means to echarts, and nothing else grows: a
        // node, an arrowhead and a stroke are read at the size they are drawn,
        // whatever the distances around them.
        //
        // `repulsion` goes up by the SQUARE, and that is arithmetic rather
        // than taste. In `forceHelper` the repulsive displacement is
        // `(n1.rep + n2.rep) / d / d` applied along the UN-normalised
        // separation, so it falls off as `rep / d` while gravity rises as
        // `gravity * d`. Equilibrium at 1.5x the distance therefore needs
        // 2.25x the repulsion — 1125, not 750.
        repulsion: 1125,
        edgeLength: [75, 300],
        // Half-way, on purpose. The redesign raised this to 0.28 for a real
        // reason — an entity with no relation feels repulsion only, so at 0.1
        // it drifts into a corner and the part of the graph carrying the
        // information is squeezed into the middle — but 0.28 against a full
        // width rect collapses the connected cluster instead. 0.15 keeps the
        // unconnected node a way back without flattening the rest.
        gravity: 0.15,
        // NO `friction` OVERRIDE. It reads like a damping knob and is not one:
        // in `forceHelper` it scales every displacement AND decays 0.992 per
        // step until `friction < 0.01` ENDS the simulation. Setting 0.3 halved
        // the step size and cut ~90 steps off the run, so the layout was
        // frozen roughly half-relaxed — nodes left wherever the initial random
        // scatter put them. That is not settling; it is stopping early, and it
        // is what "the force is no longer uniform" looked like. The default
        // 0.6 runs the simulation to completion.
      },
      label: {
        show: true,
        position: 'bottom',
        distance: 8,
        fontSize: 12.5,
        color: chrome.label,
        // A label crossing an edge or another label is unreadable at this
        // size. The chip ground gives it something to sit on; truncation caps
        // how far a long entity name can reach. These two ARE the
        // de-cluttering — see below for the option that used to claim the job.
        backgroundColor: chrome.labelGround,
        padding: [2, 4],
        borderRadius: 4,
        width: 120,
        overflow: 'truncate',
      },
      // NO `labelLayout`. `labelLayout: { hideOverlap: true }` stood here and
      // it cannot be used on a `graph` series without detaching every EDGE
      // label from its edge.
      //
      // The option is series-wide and there is no way to scope it. ECharts
      // registers labels for layout the moment the option is a function or a
      // non-empty object, and only treemap opts out:
      //
      //     if (!(isFunction(layoutOption) || keys(layoutOption).length)) return;
      //     if (textEl && !textEl.disableLabelLayout) this._addLabel(...);
      //
      // Every registered label then goes through `updateLayoutConfig`, which
      // forces it out of its host's local space and restores the position
      // captured at FIRST render:
      //
      //     hostEl.setTextConfig({ local: false, ... });
      //     label.x = defaultLabelAttr.x;  label.y = defaultLabelAttr.y;
      //
      // An edge label is positioned by `Line.setLinePoints`, which writes
      // `label.x/y/rotation` in the LINE'S OWN coordinate space from its
      // endpoints. Overwriting those with stale global values severs the two.
      // Zoom makes it obvious rather than causing it: `GraphView` recomputes
      // the correct local positions via `_lineDraw.updateLayout()` and then
      // calls `api.updateLabelLayout()`, which overwrites them again.
      //
      // A callback form is not an escape hatch — a function is "non-empty" by
      // the test above, so edge labels are still registered and still moved.
      edgeLabel: {
        show: true,
        fontSize: 11.25,
        color: chrome.edgeLabel,
        // Two relations between the same pair arrive here as ONE caption with
        // a newline in it — see `processGraphData`. Pinning the line height
        // keeps that stack tight enough to read as one label rather than two
        // that happen to be near each other.
        lineHeight: 13.5,
      },
      symbol: 'circle',
      symbolSize: 26,
      edgeSymbol: ['none', 'arrow'],
      edgeSymbolSize: 8,
      lineStyle: {
        color: chrome.edge,
        opacity: 0.55,
        width: 1.5,
        curveness: 0.1,
      },
      emphasis: {
        focus: 'adjacency',
        lineStyle: {
          width: 2.5,
          opacity: 1,
        },
        label: {
          // The hovered label has to win against whatever it overlaps.
          show: true,
        },
      },
      data: [] as unknown[],
      links: [] as unknown[],
      categories: [] as unknown[],
      // The STARTING zoom, and the only time it is ever set. See above.
      zoom: 1,
    };

    const legend = {
      data: [] as string[],
      show: false,
      top: '8px',
      // The legend is a KEY, not a heading: same muted step the inspector's
      // section labels use, at the size the console sets elsewhere.
      textStyle: {
        color: chrome.legend,
        fontSize: 11,
      },
      itemWidth: 10,
      itemHeight: 10,
    };

    this.seededSeries = series;
    this.seededLegend = legend;

    return {
      title: {
        text: null, // empty state rendered as an HTML placeholder overlay
        top: '50%',
        left: 'center',
      },
      legend,
      series: [series],
    };
  }

  /**
   * The DATA, and only the data, onto an option that already exists.
   *
   * MERGING, deliberately. What merge does not do is leave stale marks behind:
   * echarts REPLACES an array-valued key outright rather than concatenating, so
   * handing it an empty `data` empties the canvas. That is asserted rather than
   * assumed (`knowledge-graph.component.spec.ts`), because the alternative — a
   * chart keeping its last drawing under an empty-state overlay that says there
   * is nothing there — is exactly how the hierarchy pane hid a bug for a
   * release.
   *
   * `categories` is sent as `[]` rather than `undefined` for the same reason:
   * a merge cannot clear a key it is not given.
   */
  private pushData(data: KnowledgeGraphData): void {
    const { nodes, links, categories } = this.processGraphData(data);
    const names = categories.map((c) => c.name);

    if (!this.echartsInstance) {
      // No canvas yet. Written in place so the option's identity does not
      // change; a new `[options]` reference would be answered with a notMerge
      // replace the moment change detection next ran.
      if (this.seededSeries && this.seededLegend) {
        this.seededSeries.data = nodes;
        this.seededSeries.links = links;
        this.seededSeries.categories = categories;
        this.seededLegend.data = names;
        this.seededLegend.show = names.length > 0;
      }
      return;
    }

    this.echartsInstance.setOption({
      legend: [{ data: names, show: names.length > 0 }],
      series: [{ data: nodes, links, categories }],
    });
    this.echartsInstance.resize();
  }

  /**
   * Process graph data and transform it into ECharts format
   * @param data The raw knowledge graph data
   * @returns Processed nodes, links, categories, and entity types
   */
  private processGraphData(data: KnowledgeGraphData): {
    nodes: any[];
    links: any[];
    categories: any[];
    entityTypes: string[];
  } {
    // Create categories for legend - include all entity types (even undefined/null)
    const allEntityTypes = (data.nodes || []).map(
      (n) => n.entity_type || 'unknown'
    );
    const entityTypes = [...new Set(allEntityTypes)];
    const chrome = this.chrome();

    // Transform entities into ECharts nodes format
    const nodes = (data.nodes || []).map((entity, index) => ({
      id: entity.name || `entity-${index}`,
      name: entity.name || `Entity ${index}`,
      category: entity.entity_type || 'unknown',
      itemStyle: {
        color: this.getNodeColor(entityTypes, entity.entity_type || 'unknown'),
        // A hairline of the pane's own ground around each node: two
        // same-category nodes that touch otherwise read as one blob.
        borderColor: chrome.nodeBorder,
        borderWidth: 1.5,
      },
      // Add description as additional data for tooltips
      description: entity.description,
      observations: entity.observations,
    }));

    const links = this.buildLinks(data.edges || []);

    const categories = entityTypes.map((type) => ({
      name: type,
      itemStyle: {
        color: this.getNodeColor(entityTypes, type),
      },
    }));

    return { nodes, links, categories, entityTypes };
  }

  /**
   * One drawn edge per DIRECTED PAIR, carrying every relation that runs along
   * it, stacked one caption per line.
   *
   * Two relations between the same two entities were two links with the same
   * endpoints and the same `curveness`, so ECharts drew them as the same
   * stroke — and their captions at the same point, one printed over the other.
   * `earned_degree_from` and `invited_lecturer_at` between the same pair came
   * out as a single illegible smear. Merging them into one caption with a
   * newline is what makes both readable, and it is honest about the drawing:
   * there was only ever one line there to label.
   *
   * DIRECTED, so the key is the ORDERED pair. A→B and B→A stay two edges:
   * they carry an arrowhead each and `curveness: 0.1` bows them apart, so they
   * are genuinely two strokes with room for two captions. Folding them
   * together would put a caption on an arrow that does not mean it.
   *
   * Nothing is hidden by this. The Raw data view lists every relation
   * individually, which is where the full set is read.
   */
  private buildLinks(edges: KnowledgeGraphRelation[]): any[] {
    const byPair = new Map<
      string,
      { source: string; target: string; types: string[] }
    >();

    for (const relation of edges) {
      const source = relation.from_entity || '';
      const target = relation.to_entity || '';
      // A separator no entity name can contain, so `"A|B" -> "C"` cannot
      // collide with `"A" -> "B|C"` the way it would under any printable one.
      const key = `${source}${PAIR_SEPARATOR}${target}`;
      const type = relation.relation_type || 'relation';
      const pair = byPair.get(key);

      if (!pair) {
        byPair.set(key, { source, target, types: [type] });
      } else if (!pair.types.includes(type)) {
        // The same relation twice over the same pair is one fact reported
        // twice; printing it twice would only make the stack taller.
        pair.types.push(type);
      }
    }

    return [...byPair.values()].map((pair, index) => ({
      id: `relation-${index}`,
      source: pair.source,
      target: pair.target,
      name: pair.types.join(', '),
      label: {
        show: true,
        formatter: pair.types.join('\n'),
      },
    }));
  }

  /**
   * THE SAME RAMP THE HIERARCHY GRAPH USES, resolved once.
   *
   * This replaced ten literal hexes — ECharts' own cool default set, against a
   * warm neutral console, which is most of why this panel read as a screenshot
   * of a different application. Sharing `graphCategoryColors()` rather than
   * declaring a second list is the point: two graphs in one inspector, painted
   * from two palettes, is the same bug one step later.
   *
   * THE CANVAS CANNOT READ CSS — see `readToken`. Everything handed to ECharts
   * has to be a resolved literal, which is why this is a JavaScript lookup and
   * not a `var()` in a stylesheet.
   */
  private palette(): readonly string[] {
    this.categoryPalette ??= graphCategoryColors();
    return this.categoryPalette;
  }

  /** The non-categorical graph colours, resolved once. */
  private chrome(): Record<keyof typeof CHROME_TOKENS, string> {
    this.chromePalette ??= Object.fromEntries(
      Object.entries(CHROME_TOKENS).map(([role, name]) => [
        role,
        readToken(name),
      ])
    ) as Record<keyof typeof CHROME_TOKENS, string>;
    return this.chromePalette;
  }

  /**
   * The colour for one entity type, by its position in `entityTypes`.
   *
   * Position, not hash: the ramp has to look deliberate on a graph with three
   * categories, and a hash would pick three arbitrary slots out of eight. The
   * wraparound past the end of the ramp is the old behaviour, unchanged.
   */
  private getNodeColor(entityTypes: string[], type: string): string {
    const ramp = this.palette();
    const index = entityTypes.indexOf(type);
    return ramp[(index >= 0 ? index : 0) % ramp.length];
  }
}
