import { CommonModule } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  inject,
  NgZone,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { TabViewModule } from 'primeng/tabview';
import { TextareaModule } from 'primeng/textarea';

import { Subscription, combineLatest } from 'rxjs';

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

import { AkgentService } from '../../../../../core/ui/akgent.service';
import { ApiService } from '../../../../../core/http/api.service';
import {
  CategoryService,
  graphCategoryColors,
  readToken,
} from '../../../../../core/ui/category.service';

// Import the shared GraphDataService
import { isToolNode } from '../../../../../features/process/selectors/actor-kind';
import { agentColours } from '../../../../../features/process/selectors/agent-colour';
import { makeAgentNameUserFriendly } from '../../../../../shared/util/util';
import { GraphDataService } from '../../../../../features/process/selectors/graph.selector';
import {
  Selectable,
  SelectionService,
} from '../../../../../features/process/ui-state/selection.service';
import { HumanRequestComponent } from '../../human-request/human-request.component';
import { InspectorEmptyStateComponent } from '../../../../console/inspector/inspector-empty-state.component';

echarts.use([
  CanvasRenderer,
  TitleComponent,
  TooltipComponent,
  GraphChart,
  LegendComponent,
]);

/**
 * HTML-escape a value on its way into the echarts tooltip.
 *
 * The tooltip is the one place this component emits markup: echarts renders it
 * as real DOM in the document rather than painting it on the canvas. Every
 * value interpolated into it is therefore attacker-reachable if it is
 * attacker-controlled, and both of the two — the agent's name and its error
 * message — come off the wire. One helper rather than a `replace` chain per
 * call site, because the chain was applied to one of them and not the other.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@Component({
  selector: 'app-graph',
  imports: [
    CommonModule,
    FormsModule,
    DialogModule,
    ButtonModule,
    TabViewModule,
    TextareaModule,
    NgxEchartsDirective,
    HumanRequestComponent,
    InspectorEmptyStateComponent,
  ],
  templateUrl: './graph.component.html',
  styleUrls: ['./graph.component.scss'],
  providers: [provideEchartsCore({ echarts })],
})
export class GraphComponent {
  zone: NgZone = inject(NgZone);
  private readonly cdr: ChangeDetectorRef = inject(ChangeDetectorRef);
  apiService: ApiService = inject(ApiService);
  akgentService: AkgentService = inject(AkgentService);
  categoryService: CategoryService = inject(CategoryService);
  graphDataService: GraphDataService = inject(GraphDataService);
  selectionService: SelectionService = inject(SelectionService);

  echartsInstance: any;
  graphOptions: EChartsCoreOption = {};

  nodes: any[] = [];
  edges: any[] = [];
  categories: any[] = [];

  /**
   * The data slices of `graphOptions`, HELD BY REFERENCE.
   *
   * There is a window — from `ngOnInit` until ngx-echarts creates the canvas a
   * macrotask later — in which there is no chart to merge into, and for a team
   * that is already running that window contains the ENTIRE roster: the feed is
   * a `BehaviorSubject` chain and fires on subscribe. Writing INTO these
   * objects fills the option the directive is about to apply, without replacing
   * `graphOptions` itself — and not replacing it is the whole point, because a
   * new reference on that input is answered with a notMerge replace.
   */
  private seededSeries: {
    data: unknown[];
    links: unknown[];
    categories: unknown[];
  } | null = null;
  private seededLegend: { data: string[] } | null = null;

  private dataSub: Subscription = new Subscription();

  ngOnInit() {
    // BUILT ONCE, BEFORE THE CHART EXISTS, AND NEVER REASSIGNED.
    //
    // `[options]` is a SECOND, non-merging channel into the same chart, and the
    // two channels were fighting. ngx-echarts skips only the FIRST change on
    // that input and answers every later one with `setOption(options, true)` —
    // `notMerge`, a full replace. This option object used to be built in
    // `onChartInit`, i.e. assigned a second time, carrying a SNAPSHOT of
    // `nodes` as it stood the instant the canvas appeared: empty. So any
    // change-detection pass after that point replayed an empty chart over a
    // populated one, and the graph went blank while `nodes.length` said
    // otherwise and the empty-state overlay stayed down.
    //
    // That was dormant only because the pane sits under an OnPush wrapper that
    // nothing marked dirty (the overlay bug below), so the binding never
    // updated at all. Fixing the overlay would have armed it.
    //
    // The option built here is therefore pure CONFIGURATION — no nodes, no
    // edges, no categories. DATA arrives on one channel only: the merging
    // `setOption` in `updateChart()`.
    this.graphOptions = this.buildChartOptions();

    this.dataSub = combineLatest([
      this.graphDataService.nodes$,
      this.graphDataService.edges$,
      this.graphDataService.categories$,
    ]).subscribe(([updatedNodes, updatedEdges, updatedCats]) => {
      // INSIDE THE ZONE, and this is load-bearing rather than defensive.
      //
      // The chart is driven IMPERATIVELY — `updateChart()` hands echarts a new
      // option object — so for most of this component's life nothing in the
      // template depended on `nodes` and a missed change-detection pass was
      // invisible: the canvas redrew itself either way.
      //
      // The `@if (nodes.length === 0)` empty-state overlay changed that. It is
      // an ordinary template binding and only re-evaluates when Angular runs a
      // tick, and these emissions originate on the websocket feed, outside the
      // Angular zone. `onChartInit`'s legend handler already reaches for
      // `zone.run` for the same underlying reason.
      //
      // The whole assignment goes inside, not just the flag: `edges` and
      // `categories` feed `<app-human-request [nodes]>` and the legend, and a
      // half-zoned update is the version that works until someone binds the
      // next field.
      this.zone.run(() => {
        this.nodes = updatedNodes;
        this.edges = updatedEdges;
        this.categories = updatedCats;
        this.updateChart();
        // AND THE TICK HAS TO BE ALLOWED IN. `zone.run` schedules a pass;
        // `markForCheck` is what lets it reach this template. The only parent
        // this component has is `TeamTabsComponent`, which is OnPush with an
        // empty class body — no inputs, no outputs, no bindings — so after its
        // first check nothing could ever mark it dirty again, and Angular
        // skipped it and everything under it on every subsequent pass. The
        // overlay froze on the value it had at mount ("No agents available",
        // true) while the canvas, which does not ask Angular for anything,
        // filled up underneath it. `markForCheck` walks UP the view tree, so
        // it dirties that wrapper too.
        this.cdr.markForCheck();
      });
    });
  }

  ngOnDestroy() {
    this.dataSub.unsubscribe();
  }

  onChartInit(ec: any) {
    this.echartsInstance = ec;
    this.echartsInstance.resize();

    // NOTHING IS PUSHED HERE. ngx-echarts emits `chartInit` BEFORE it applies
    // `[options]`, so a `setOption` from this handler lands on a chart that has
    // no series yet ("Unknown series undefined") and is then replaced by the
    // directive's own notMerge call a line later. Whatever arrived before the
    // canvas existed is already in the option object, seeded by `updateChart`.
    this.echartsInstance.on('click', (params: any) => {
      if (params.dataType === 'node') {
        const selectable: Selectable = {
          type: 'graph-node',
          data: params.data,
        };

        this.selectionService.handleSelection(selectable);
      }
    });

    this.echartsInstance.on('legendselectchanged', (params: any) => {
      const selectedCategories: boolean[] = this.categories.map(
        (cat) => !!params.selected[cat.name]
      );
      this.categoryService.setSelectedCategory(selectedCategories);
      this.zone.run(() => {});
    });
  }

  /**
   * Everything about the chart that is NOT data.
   *
   * ALL COLOURS ARE RESOLVED, NOT `var()`. echarts paints this with the canvas
   * renderer, and a canvas has no cascade: `"var(--akg-graph-label)"` is not a
   * colour it fails to find, it is a string it cannot parse. `readToken` does
   * the lookup here so the values that reach the canvas are literals. The
   * TOOLTIP is the stated exception — echarts renders that as real DOM inside
   * the document, so `var()` resolves there and a rebrand reaches it.
   */
  private buildChartOptions(): EChartsCoreOption {
    const ramp = graphCategoryColors();
    const ground = readToken('--akg-graph-ground');
    const edgeColor = readToken('--akg-graph-edge');
    const labelColor = readToken('--akg-graph-label');
    const legendColor = readToken('--akg-text-muted');
    const quiet = readToken('--akg-glyph-quiet');
    const fontFamily = readToken('--akg-font-ui');

    const labelFormatter = (params: any) => {
      const name = makeAgentNameUserFriendly(params.data.actorName);
      return params.data.humanRequests?.length ? `${name} 🙋 ` : name;
    };

    const legend = {
      data: [] as string[],
      top: '8px',
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: legendColor, fontFamily, fontSize: 11 },
      // A NEUTRAL MARK, because the nodes are no longer coloured by squad.
      //
      // Each entry used to carry its squad's colour, and that was honest while
      // the nodes wore it too. Now a node's fill is its AGENT's — one identity
      // shared with the transcript and the member list — so a coloured legend
      // would be pointing at a scheme nothing on the canvas uses, and the
      // obvious reading ("blue means this squad") would be wrong.
      //
      // The entry stays: it is still the control that shows and hides a squad,
      // and that is what it is for. `itemStyle` here overrides the per-category
      // colour echarts would otherwise take from the series.
      itemStyle: { color: quiet, borderColor: quiet },
      // A squad the user has switched OFF still has to be readable enough to
      // switch back on, which is what makes this a meaningful mark rather than
      // a disabled one.
      inactiveColor: quiet,
    };

    const series = {
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      // LEGEND CLEARANCE ONLY. `left` / `right` / `bottom` stood here too, as
      // a clipped-label fix, and echarts' force layout has no such fix to
      // offer: `forceHelper` takes the rect for the gravity centre and the
      // initial scatter and never clamps to it, so a node reaches the canvas
      // edge whatever the insets say. What they did do was narrow the
      // simulation by 104px of a pane that has few to spare. Labels are kept
      // legible by `width` + `truncate` and the text halo below, which is
      // where that job actually belongs.
      top: 40,
      force: {
        // THE DISTANCE PARAMS THEMSELVES — 2.5x the 60 / 140 this started
        // from. `edgeLength` is the target length of an edge in pixels and
        // `repulsion` the strength that sets how far apart unrelated nodes
        // settle; between them they are what "spread the graph out" means to
        // echarts. Nothing else follows them: a node, an arrowhead and a
        // stroke are read at the size they are drawn whatever the distances
        // around them, and `zoom` is the user's.
        //
        // `repulsion` rises as the SQUARE of the distance wanted, which is
        // arithmetic rather than taste: in `forceHelper` the repulsive
        // displacement is `(n1.rep + n2.rep) / d / d` applied along the
        // UN-normalised separation, so it falls off as `rep / d` while gravity
        // rises as `gravity * d`. 2.5x the distance therefore needs 6.25x the
        // repulsion — 180 to 1125, the same figure the knowledge graph
        // arrives at from its own starting point.
        repulsion: 1125,
        edgeLength: [150, 350],
        // GRAVITY IS THE SCATTER FIX. A force layout only holds a graph
        // together through its EDGES; a node with none feels nothing but
        // repulsion and drifts until it hits the edge of the lane — tools
        // pinned in the corners, agents crushed into the middle. Gravity is a
        // pull toward the centre that every node feels, connected or not, so
        // an isolated node settles at a readable distance instead of at
        // infinity. echarts' default is 0.1, too weak to matter here.
        gravity: 0.25,
        // NO `friction`. It is not a damping knob: in `forceHelper` it scales
        // every displacement AND decays 0.992 per step until `friction < 0.01`
        // ENDS the run. At 0.15 the simulation moved a quarter as far as the
        // 0.6 default over ~340 steps instead of ~510 — it stopped a long way
        // short of relaxed, which is why the layout looked arbitrary rather
        // than settled.
      },
      label: {
        show: true,
        position: 'top',
        distance: 8,
        formatter: labelFormatter,
        color: labelColor,
        fontFamily,
        // 12.5 AND 120, the knowledge graph's figures. Two graphs one tab
        // apart captioning their nodes at different sizes reads as two
        // applications, the same reason the mark is 26 in both.
        //
        // `width` moves with the font rather than staying at 96: it is a cap
        // in PIXELS on how much of a name survives, so holding it still at a
        // larger size would truncate more, not the same.
        fontSize: 12.5,
        // Capped and ellipsised rather than allowed to run. `truncate` ends the
        // name with an ellipsis, which READS as shortened; the canvas edge
        // cutting it mid-glyph reads as broken. Full name in the tooltip.
        width: 120,
        overflow: 'truncate',
        // A halo in the ground colour, so a name that crosses an edge or
        // another node stays legible without the labels needing their own
        // collision avoidance.
        textBorderColor: ground,
        textBorderWidth: 3,
      },
      symbol: 'roundRect',
      // 26, THE SAME MARK THE KNOWLEDGE GRAPH DRAWS. Two graphs an inspector
      // tab apart, drawing an entity at 26px and an agent at 15px, read as two
      // applications; the shape already says which is which (a roundRect here,
      // a circle there) and it does not need the size saying it a second time.
      symbolSize: [26, 26],
      itemStyle: {
        // A cut-out ring, not an outline: matching the ground is what makes two
        // overlapping nodes read as two.
        borderColor: ground,
        borderWidth: 1.5,
      },
      edgeSymbol: ['none', 'arrow'],
      edgeSymbolSize: 8,
      lineStyle: {
        color: edgeColor,
        curveness: 0.1,
        width: 1.5,
        type: 'solid',
        opacity: 0.9,
      },
      emphasis: {
        focus: 'adjacency',
        label: { fontWeight: 'bold' },
        lineStyle: { width: 3 },
      },
      data: [] as unknown[],
      links: [] as unknown[],
      categories: [] as unknown[],
      // STILL 1, and the graph is still twice as spread out — the distance
      // params above did that. `zoom` scales the laid-out graph about its
      // centre AFTER the fact, and it is the USER'S control through roam: a
      // larger number here would be undone by their first scroll, and on the
      // way it would magnify the nodes and the strokes too, which is not what
      // was asked for.
      zoom: 1,
    };

    this.seededSeries = series;
    this.seededLegend = legend;

    return {
      // The default palette for any mark that arrives without an explicit
      // fill. Nodes normally take their colour from their category, but a node
      // with no squad never gets one, and echarts' own default palette is the
      // cool blue-grey this ramp exists to replace.
      color: ramp,
      textStyle: { fontFamily },
      tooltip: {
        trigger: 'item',
        confine: true,
        backgroundColor: 'var(--akg-overlay-bg)',
        borderColor: 'var(--akg-surface-border)',
        textStyle: { color: 'var(--akg-text)', fontFamily, fontSize: 12 },
        extraCssText:
          'max-width: 300px; white-space: normal; word-wrap: break-word;',
        formatter: (params: any) => {
          if (params.dataType !== 'node') return '';
          // ESCAPED, BOTH OF THEM. echarts renders this tooltip as real DOM
          // (which is why `var()` resolves in it), so everything interpolated
          // below is an HTML sink. The name is no safer than the error message
          // beside it: it comes off `NodeInterface.actorName`, i.e. from the
          // backend's actor address, and `makeAgentNameUserFriendly` only
          // reshapes it. While the formatter returned '' for every node without
          // an error the sink needed an errored agent to reach; now that every
          // node has a tooltip, hovering is enough.
          const name = escapeHtml(
            makeAgentNameUserFriendly(params.data.actorName),
          );
          // THE TOOLTIP IS WHERE THE FULL NAME LIVES NOW. Labels on the canvas
          // are capped and ellipsised (`label.width`, above) because an
          // uncapped one ran off the edge of a 310px pane and was CUT — the
          // user's screenshot shows `#KnowledgeGraphToo` and `#VectorSt`. A
          // truncation the user can un-truncate is a different thing from a
          // clip; this is the un-truncating. It used to return `''` for every
          // node without an error, so there was nowhere to read the rest.
          const escaped = escapeHtml(params.data.errorMessage ?? '');
          return escaped
            ? `<b>${name}</b><br/><span style="color:var(--akg-danger-fg); font-size:11px">${escaped}</span>`
            : `<b>${name}</b>`;
        },
      },
      legend: [legend],
      series: [series],
    };
  }

  /**
   * THE ONLY CHANNEL DATA TAKES INTO THE CHART.
   *
   * MERGING, deliberately — a `notMerge` replace would rebuild the whole
   * option, which restarts the force layout and throws away the user's pan and
   * zoom on every single message. What merge does NOT do is leave stale marks
   * behind: echarts replaces an array-valued key outright rather than
   * concatenating, so handing it an empty `data` clears the canvas. That is
   * asserted rather than assumed (`graph-canvas.spec.ts`), because the
   * alternative — a chart that keeps its last drawing after the team goes away
   * — is invisible next to an empty-state overlay saying there is nothing
   * there, which is exactly how this pane hid a bug for a release.
   */
  private updateChart() {
    // FILTERED FOR THE CANVAS ONLY, by the SHARED predicate — this pane used
    // to restate the '#'-prefix rule inline, which made three copies of it in
    // a codebase whose `actor-kind.ts` opens by warning that a rule written
    // twice is a rule that drifts. `this.nodes` keeps every actor, because it
    // is also what `<app-human-request [nodes]>` reads and what the empty-state
    // overlay counts — a team of one agent and six tools is not an empty team,
    // and a human request raised by an agent must still be findable.
    const nodes = (this.nodes || []).filter((n) => !isToolNode(n));

    // Edges are keyed on `name` (the agent_id), not on `actorName`. An edge to
    // a node that is no longer in `data` is not ignored by echarts — it warns
    // and drops it — so the ends are filtered with the nodes rather than left
    // to be cleaned up downstream.
    const drawn = new Set(nodes.map((n) => n.name));
    const edges = (this.edges || []).filter(
      (e) => drawn.has(e.source) && drawn.has(e.target)
    );

    /*
     * ONE COLOUR PER AGENT, and it is the SAME colour the transcript's speaker
     * mark and the inspector's member tile draw — see `agent-colour.ts`. The
     * canvas used to take its fill from the node's `category`, i.e. from its
     * SQUAD, which in a single-squad deployment painted the whole team one
     * colour and tied the drawing to nothing else in the console.
     *
     * BUILT FROM THE UNFILTERED ROSTER (`this.nodes`), not from `nodes` above.
     * The lookup skips tools itself, and handing it a list the tools had
     * already been removed from would make this pane's stop assignment depend
     * on a filter no other surface applies — the two would agree today and
     * drift the first time one of them changed.
     *
     * ON THE NODE, NOT ON THE CATEGORY. A node-level `itemStyle` wins over the
     * category's in echarts, which is exactly the precedence wanted: the
     * category still exists, because the legend still filters on it.
     *
     * AN ERROR STILL WINS. `applyErrorMessage` writes `itemStyle.color` to
     * mark a failed or thinking actor and clears the key again on recovery, so
     * a colour already present is that signal and must not be painted over —
     * "this agent is @Manager" is never worth more than "this agent failed".
     */
    const colours = agentColours(this.nodes || [], this.categoryService.COLORS);
    const painted = nodes.map((n) => {
      const signal = n.itemStyle?.color;
      const own = colours.of(n.actorName);
      if (signal || !own) return n;
      return { ...n, itemStyle: { ...(n.itemStyle || {}), color: own } };
    });

    const categories = this.categories || [];
    const names = categories.map((c) => c.name);

    if (!this.echartsInstance) {
      // No canvas yet — see `seededSeries`. Written in place so the option's
      // identity does not change; a new `[options]` reference would be answered
      // with a notMerge replace the moment change detection next ran.
      if (this.seededSeries && this.seededLegend) {
        this.seededSeries.data = painted;
        this.seededSeries.links = edges;
        this.seededSeries.categories = categories;
        this.seededLegend.data = names;
      }
      return;
    }

    this.echartsInstance.setOption({
      legend: [{ data: names }],
      series: [
        {
          data: painted,
          links: edges,
          categories: categories,
        },
      ],
    });
  }
}
