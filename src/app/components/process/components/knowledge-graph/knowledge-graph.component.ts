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
 * The layout box the force simulation is confined to, as ECharts insets.
 *
 * THIS IS THE LABEL-CLIPPING FIX. Node labels are drawn BELOW their node and
 * are wider than it, so a simulation allowed to place a node against the
 * container edge draws half its label outside the canvas — which is how
 * `#KnowledgeGraphToo` and `#VectorSt` lost their tails. ECharts has no
 * "keep the label inside" option; the only lever is to stop the NODE from
 * reaching the edge, which is what these insets do. The top inset also clears
 * the legend rather than letting nodes drift under it.
 */
const LAYOUT_INSETS = { left: 56, right: 56, top: 44, bottom: 34 } as const;

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
      // Keeping the simulation off the container edge is what stops the
      // labels being clipped — see LAYOUT_INSETS.
      left: LAYOUT_INSETS.left,
      right: LAYOUT_INSETS.right,
      top: LAYOUT_INSETS.top,
      bottom: LAYOUT_INSETS.bottom,
      force: {
        // WHY THESE THREE MOVED. `repulsion: 500` with `gravity: 0.1` is a
        // simulation with almost no centre: a node with no edge feels only
        // repulsion, so every DISCONNECTED entity is pushed to a corner and
        // the connected part — the part with the information in it — is
        // squeezed into the middle. Raising gravity gives the unconnected
        // nodes somewhere to fall back to; lowering repulsion stops the
        // connected cluster from exploding once they are no longer in the
        // corners.
        repulsion: 220,
        edgeLength: [60, 140],
        gravity: 0.28,
        // Settle rather than jitter: the default keeps nudging nodes long
        // after the layout is readable, which in a narrow pane reads as the
        // panel being unable to make up its mind.
        friction: 0.3,
      },
      label: {
        show: true,
        position: 'bottom',
        distance: 6,
        fontSize: 10,
        color: chrome.label,
        // A label crossing an edge or another label is unreadable at 10px.
        // The chip ground gives it something to sit on; truncation caps how
        // far a long entity name can reach toward the insets above.
        backgroundColor: chrome.labelGround,
        padding: [2, 4],
        borderRadius: 4,
        width: 96,
        overflow: 'truncate',
      },
      labelLayout: { hideOverlap: true },
      edgeLabel: {
        show: true,
        fontSize: 9,
        color: chrome.edgeLabel,
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
          // The hovered label has to win against whatever it overlaps, and
          // `hideOverlap` may have hidden it entirely.
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
        // A hairline of the pane's own ground around each node: at 26px two
        // same-category nodes that touch otherwise read as one blob.
        borderColor: chrome.nodeBorder,
        borderWidth: 1.5,
      },
      // Add description as additional data for tooltips
      description: entity.description,
      observations: entity.observations,
    }));

    // Transform relations into ECharts links format
    const links = (data.edges || []).map((relation, index) => ({
      id: `relation-${index}`,
      source: relation.from_entity || '',
      target: relation.to_entity || '',
      name: relation.relation_type || 'relation',
      label: {
        show: true,
        formatter: relation.relation_type || '',
      },
    }));

    const categories = entityTypes.map((type) => ({
      name: type,
      itemStyle: {
        color: this.getNodeColor(entityTypes, type),
      },
    }));

    return { nodes, links, categories, entityTypes };
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
