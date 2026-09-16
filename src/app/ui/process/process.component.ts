import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  computed,
  ElementRef,
  EventEmitter,
  inject,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  Signal,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';

import { AkgentService } from '../../core/services/akgent.service';
import {
  inspectorPercentFromLeading,
  INSPECTOR_DEFAULT_PERCENT,
  leadingPercent as leadingPercentOf,
} from '../console/pane-layout';
import { PaneLayoutService } from '../console/pane-layout.service';
import { ViewService } from '../console/view.service';
import { TeamSessionService } from '../../core/services/process/session/team-session.service';
import { ConfigService } from '../../core/platform/config/config.service';
import { ContextService } from '../../core/platform/context/context.service';
import { IngestionService } from '../../core/services/process/event/ingestion.service';
import { ToolPresenceService } from '../../core/services/process/selectors/tool-presence.selector';
import { WorkspaceRegistryService } from '../../core/services/process/selectors/workspace-registry.selector';

import { AgentTabsComponent } from './agent-tabs/agent-tabs.component';
import { TeamTabsComponent } from './team-tabs/team-tabs.component';
import { KnowledgeGraphComponent } from './knowledge-graph/knowledge-graph.component';
import { MessageListComponent } from './message-list/message-list.component';
import { WorkspaceTabsComponent } from './workspace-tabs/workspace-tabs.component';

import { BehaviorSubject, combineLatest, Observable, Subscription } from 'rxjs';
import { distinctUntilChanged, map, take } from 'rxjs/operators';
import { ChatPanelComponent } from './chat/chat-panel.component';
import { GraphDataService } from '../../core/services/process/selectors/graph.selector';
import { SelectionService } from '../../core/services/process/ui-state/selection.service';

import { ConversationHeaderComponent } from '../console/conversation/conversation-header.component';
import { ConsoleInspectorComponent } from '../console/inspector/console-inspector.component';
import { InspectorTeamPanelComponent } from '../console/inspector/team-panel/inspector-team-panel.component';
import { VisualizationOption } from '../../components/console/inspector/inspector-tabs.component';
import { resolveInspectorTab, visibleInspectorTabs } from '../../core/services/console/inspector/inspector-tabs.registry';
import { SplitDividerComponent } from '../../components/common/split-divider/split-divider.component';

@Component({
  selector: 'app-process',
  imports: [
    CommonModule,
    MessageListComponent,
    AgentTabsComponent,
    TeamTabsComponent,
    KnowledgeGraphComponent,
    WorkspaceTabsComponent,
    ChatPanelComponent,
    // The conversation's title bar and the inspector frame. Both are pieces of
    // the console shell that have to be mounted from INSIDE this component:
    // they sit either side of, or read, the component-scoped providers below,
    // which resolve nowhere else.
    ConversationHeaderComponent,
    ConsoleInspectorComponent,
    InspectorTeamPanelComponent,
    // R3: the boundary between the two panes. Reused rather than reimplemented
    // — it already owns pointer capture, the `role="separator"` ARIA set, the
    // six-key grid, and the percentChange-vs-commit split that is exactly what
    // "drag continuously, persist once" needs.
    SplitDividerComponent,
    TranslatePipe,
  ],
  templateUrl: './process.component.html',
  styleUrl: './process.component.scss',
})
export class ProcessComponent implements OnChanges, AfterViewInit, OnDestroy {
  route: ActivatedRoute = inject(ActivatedRoute);
  router: Router = inject(Router);

  akgentService: AkgentService = inject(AkgentService);
  /** The team's open/close ritual, owned by the data layer so a second
   *  frontend inherits it instead of having to rediscover it. */
  private readonly session = inject(TeamSessionService);
  contextService: ContextService = inject(ContextService);
  ingestionService: IngestionService = inject(IngestionService);
  graphDataService: GraphDataService = inject(GraphDataService);
  private readonly selectionService = inject(SelectionService);
  toolPresenceService: ToolPresenceService = inject(ToolPresenceService);
  private readonly workspaceRegistry = inject(WorkspaceRegistryService);
  private readonly config: ConfigService = inject(ConfigService);

  /**
   * How the two panes are arranged (R3): which side the inspector is on, and
   * how much of the row it takes.
   *
   * ROOT-SCOPED, and injected rather than provided here. This component is
   * destroyed and rebuilt on every team switch — that is what its ordered
   * `providers` array is for — so an arrangement scoped to it would be re-read
   * from storage each time the user changed team, and a width dragged a moment
   * ago would snap back. The arrangement belongs to the window, not to whichever
   * team is open.
   */
  private readonly paneLayout = inject(PaneLayoutService);

  /**
   * Whether the inspector is shut. Read here only to decide whether the
   * BOUNDARY between the panes exists — the pane's own collapse is its
   * business, and this view does not toggle it.
   */
  private readonly viewService = inject(ViewService);

  /**
   * Story 52-1 (FR1): the team this view should show, supplied by whoever
   * HOSTS it.
   *
   * NOTHING HOSTS IT TODAY. R1 removed the in-page split, so every route into
   * this view is `/process/:id` and this input is never bound. The hosted mode
   * is KEPT rather than deleted: it is a handful of lines, its ~10 specs cost
   * nothing to keep green, and the arrangement work (R3) makes a second host
   * plausible again. Read the paragraphs below as "what a host WOULD get",
   * not as a description of a caller that exists.
   *
   * `null` is "nobody told me", NOT "no team" — the route parameter answers
   * instead, which is the whole of NFR1: `/process/:id` has no host and binds
   * nothing, so it lands on exactly the behaviour it had before this input
   * existed. That is now the only path taken.
   *
   * It is an input and never written from inside. `processId` below is the
   * resolved answer, and the two are deliberately different fields: an input
   * the component also assigns to cannot be told apart from one the host set,
   * and `resolveTeamId()` would then have no way to know which source is live.
   */
  @Input() teamId: string | null = null;

  /**
   * Story 52-1: the team that was asked for does not exist.
   *
   * Paired with `teamId`, and dormant for the same reason: with no host bound,
   * this never fires and the standalone answer (`navigateHome`) is the one
   * always taken. A host cannot discover a dangling selection any other way —
   * the fetch happens in here — so the output stays for whichever host comes
   * back. See `openTeam`.
   */
  @Output() teamUnavailable = new EventEmitter<string>();

  /**
   * The team that is OPEN: the id every child is bound to and the id the
   * ingestion pipeline is running for.
   *
   * Written by `openTeam()` and by nothing else, so it cannot drift from the
   * pipeline. It is NOT read from `route.snapshot` any more (trap T1): a
   * snapshot is read once, and this view now outlives the selection.
   */
  processId: string = '';

  /**
   * The route's `:id`, kept current by a subscription rather than a snapshot.
   *
   * Only meaningful in route mode; in host mode nothing subscribes and this
   * stays `''`, which is correct because `teamId` is then the answer.
   */
  private routeTeamId: string = '';
  private routeSub: Subscription | null = null;

  /**
   * Whether `openTeam()` has run at all. Distinguishes "not opened yet" from
   * "opened, and the id has not changed", which the plain `id === processId`
   * test cannot do while `processId` is still `''`.
   */
  private opened = false;

  /**
   * The generation of the current open.
   *
   * `openTeam()` awaits `getCurrentTeam` before it touches the ingestion
   * layer. Two selections in quick succession therefore have two awaits in
   * flight, and the SLOWER one must not be allowed to finish the job: it would
   * initialise the pipeline for a team the user has already moved off, leaving
   * the previous team's conversation under the current team's name.
   */
  private openEpoch = 0;

  /**
   * Reactive presence observable for the `#KnowledgeGraphTool` actor.
   * Sourced from `ToolPresenceService.hasKnowledgeGraph$` (Story 5-2).
   * Drives the `<app-knowledge-graph>` `*ngIf` binding via `| async`.
   */
  hasKnowledgeGraph$: Observable<boolean> =
    this.toolPresenceService.hasKnowledgeGraph$;

  /**
   * Reactive workspace presence (ADR-020): the team has at least one workspace
   * iff the registry holds at least one descriptor (i.e. some agent declared a
   * `WorkspaceTool`). Drives both the `Workspaces` tab option and the
   * `<app-workspace-tabs>` `*ngIf` — the whole tab disappears when no workspace
   * exists, mirroring the Knowledge graph tab.
   */
  hasWorkspace$: Observable<boolean> = this.workspaceRegistry.workspaces$.pipe(
    map((ws) => ws.length > 0),
    distinctUntilChanged(),
  );

  visualizationMode$ = new BehaviorSubject<string>('team');

  /**
   * The tabs this deployment, for this team, offers.
   *
   * The set itself moved to `inspector-tabs.registry.ts` (W18a): a tab is one
   * declarative entry there, and both filters that can remove it live beside
   * it — the team's capabilities, which change while the user watches, and the
   * deployment's `hiddenInspectorTabs`, which is fixed for the page. Keeping
   * the array here meant the caption, the capability rule and the narrow-pane
   * rule were stated in three places that could disagree.
   */
  visualizationOptions$: Observable<VisualizationOption[]> = combineLatest([
    this.toolPresenceService.hasKnowledgeGraph$,
    this.hasWorkspace$,
  ]).pipe(
    map(([knowledgeGraph, workspace]) =>
      visibleInspectorTabs(
        { knowledgeGraph, workspace },
        this.config.hiddenInspectorTabs,
      ),
    ),
  );

  /**
   * Gates the inspector's collapse transition, which must not run on the first
   * paint: arriving from the home page with details already hidden would
   * otherwise show the panel sliding shut, as if the user had just closed it.
   * Turned on one macrotask after the view exists, so the initial state paints
   * with no transition at all and every later toggle animates.
   *
   * It stays HERE, and reaches the inspector as a plain class binding, rather
   * than moving into the inspector as a second copy of the same timer. The
   * collapsed STATE is root-scoped (two controls toggle it), but "has this view
   * finished its first paint" is a fact about this view, and the pane must not
   * have its own opinion about when that was.
   */
  animateRightColumn = false;

  /**
   * A drag is in progress: the divider is emitting live widths.
   *
   * It suppresses the pane's width TRANSITION, and that is not a polish detail.
   * A 180ms ease restarts on every one of the dozens of width changes a drag
   * emits per second, so the pane trails the pointer by a fifth of a second and
   * never quite arrives — the boundary and the pane visibly come apart. The
   * collapse still animates, because that is one large deliberate step.
   *
   * Set on the live output and cleared on the settled one, which is the same
   * seam that keeps one drag from writing storage sixty times. A keystroke
   * fires both synchronously, so a keyboard resize never sees the class and
   * DOES animate — a 1% jump with no transition is invisible, which is the
   * wrong answer for the one path a screen-reader user has.
   */
  paneResizing = false;

  /** Which side the inspector is on; drives the swap control and the order. */
  readonly inspectorSide = this.paneLayout.inspectorSide;

  /**
   * There is no boundary to drag when there are not two panes.
   *
   * A divider left standing over a collapsed inspector is worse than useless:
   * `:host(.collapsed)` pins the pane at zero, so the drag moves nothing on
   * screen — and still rewrites the stored width, so the user finds the pane at
   * a size they never chose the next time they open it. Withdrawing the control
   * is the honest answer; reopening the pane brings it straight back at the
   * width it had.
   */
  readonly inspectorCollapsed = toSignal(
    this.viewService.isRightColumnCollapsed$,
    { initialValue: false },
  );

  /**
   * The inspector's width as a CSS length, for `[style.--akg-inspector-basis]`.
   *
   * A custom property and not a bound `flex-basis`, deliberately (R3 trap 1).
   * An inline `flex-basis` outranks every rule in the inspector's stylesheet
   * including `:host(.collapsed)`, so the Details toggle and the pane's own
   * close X would stop working — with no failing spec, because nothing else in
   * the suite measures a rendered width. Read through a `var()` the value is an
   * ordinary custom property and the cascade still wins.
   */
  readonly inspectorBasis: Signal<string> = computed(
    () => `${this.paneLayout.inspectorPercent()}%`,
  );

  /**
   * The same width restated in the DIVIDER's frame — the leftmost pane's share.
   *
   * These two frames are the whole subtlety of R3. Everything persisted and
   * reasoned about is the INSPECTOR's share, because that is the quantity that
   * still means the same thing after a swap; the divider measures the leftmost
   * pane, whichever one that currently is. The conversion happens at the
   * binding, here, and nowhere else.
   */
  readonly leadingPercent = this.paneLayout.leadingPercent;

  /** The inspector's bounds, mirrored for whichever pane currently leads. */
  readonly leadingBounds = this.paneLayout.leadingBounds;

  /** What double-click restores, in the divider's frame. */
  readonly leadingDefaultPercent: Signal<number> = computed(() =>
    leadingPercentOf({
      inspectorSide: this.inspectorSide(),
      inspectorPercent: INSPECTOR_DEFAULT_PERCENT,
    }),
  );


  private presenceSub: Subscription | null = null;
  private animationTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The element the divider measures against — and now the element WE measure
   * too.
   *
   * It was a bare template reference until R3's narrow-end fix: the divider's
   * floor is the higher of a percentage preference and the pane's 240px CSS
   * minimum, and deciding which of the two wins needs the row's width in
   * pixels. `{ static: false }` because the row sits under the `@if` that hides
   * the whole view while no team is open.
   */
  @ViewChild('paneTrack') private paneTrackRef?: ElementRef<HTMLElement>;

  /**
   * Watches the pane row so the floor follows the window.
   *
   * A ResizeObserver and not a `window:resize` listener: the row changes width
   * for reasons the window does not know about — the rail collapsing, the
   * inspector closing — and each of those moves the floor exactly as a window
   * resize does. Missing them would leave the divider bounded against a row
   * width that stopped being true two interactions ago.
   */
  private paneTrackObserver: ResizeObserver | null = null;

  constructor() {
    // Active-mode reset guard (AC3 last clause, AC8), generalised: ONE rule for
    // "the tab the user is on stopped existing", whatever removed it — a tool
    // that stopped, or a deployment that hid it. The two hand-written guards
    // this replaces both snapped back to a hard-coded 'team', which is the
    // wrong answer on a deployment whose `hiddenInspectorTabs` hides 'team'.
    // `resolveInspectorTab` falls back to the first VISIBLE tab instead, which
    // is still 'team' everywhere that has not hidden it.
    this.presenceSub = this.visualizationOptions$.subscribe((options) => {
      const resolved = resolveInspectorTab(
        this.currentVisualizationMode,
        options,
      );
      if (resolved !== this.currentVisualizationMode) {
        this.visualizationMode$.next(resolved);
      }
    });
  }

  /**
   * Story 52-1 (FR2): the host moved the selection.
   *
   * The FIRST change is deliberately ignored. Angular runs `ngOnChanges`
   * before `ngOnInit`, and `ngOnInit` is what the standalone route depends on;
   * acting on both would open the same team twice, and the second open would
   * tear down the first's socket mid-replay.
   */
  ngOnChanges(changes: SimpleChanges): void {
    const change = changes['teamId'];
    if (change === undefined || change.isFirstChange()) {
      return;
    }
    void this.openTeam();
  }

  ngOnInit(): void {
    if (this.teamId !== null) {
      // Hosted: the input is the source and `ngOnChanges` carries every later
      // change. Nothing here may touch the route — the host's URL is its own.
      void this.openTeam();
      return;
    }

    // Route mode. A SUBSCRIPTION rather than `route.snapshot.params['id']`,
    // which is trap T1: the router REUSES this component when only `:id`
    // changes, so a snapshot read serves the first team for ever and shows it
    // under the second team's URL. `params` replays its current value
    // synchronously, so this both opens the team and keeps it current.
    this.routeSub = this.route.params.subscribe((params) => {
      this.routeTeamId = (params['id'] as string | undefined) ?? '';
      void this.openTeam();
    });
  }

  /** The id in force: the host's answer, or the route's when there is no host. */
  private resolveTeamId(): string {
    return this.teamId ?? this.routeTeamId;
  }

  /**
   * Open the team the current id names, then apply this console's policy to
   * what came back.
   *
   * THE MECHANISM MOVED to `TeamSessionService` — teardown-before-await, the
   * epoch guard, publishing `currentProcessId$`, starting the pipeline. It was
   * the one thing a second frontend could not discover by reading the layers it
   * reuses, because it lived in the file such a frontend deletes.
   *
   * What is left here is policy: which tab to default to, and what to do about
   * a team that is gone.
   */
  private async openTeam(): Promise<void> {
    const teamId = this.resolveTeamId();
    const outcome = await this.session.open(teamId);
    this.processId = this.session.openTeamId;

    // 'superseded' — a newer selection won the race and has already published
    // its own id and torn this one down. Doing anything here would act on a
    // team nobody is looking at.
    if (outcome === 'superseded' || outcome === 'cleared') {
      return;
    }

    // Ensure we always have a visualization mode selected. A VIEW preference:
    // it stays here because the session layer has no tabs.
    if (!this.visualizationMode$.value) {
      this.visualizationMode$.next('team');
    }

    if (outcome === 'missing') {
      // The team is gone. Two answers, and after R1 only the second one is ever
      // given: a HOST (if one is ever bound again) owns the selection and has
      // to be told it is dangling, while the route mode this view now always
      // runs in has nobody to tell and navigates home instead. The emit is
      // unconditional because a dangling team is a fact about the team, not
      // about who asked; with no subscriber it costs nothing.
      //
      // POLICY, which is why it did not move: "gone, so go home" is this
      // console's answer, not the only one.
      this.teamUnavailable.emit(teamId);
      if (this.teamId === null) {
        void this.contextService.navigateHome();
      }
    }
  }

  ngAfterViewInit(): void {
    this.animationTimer = setTimeout(() => {
      this.animateRightColumn = true;
    });
    this.watchPaneTrack();
  }

  /**
   * Report the row's width to the layout service, now and whenever it changes.
   *
   * The FIRST report is taken here rather than left to the observer's initial
   * callback, which lands a frame later: the divider is bound on this same
   * pass, and one frame of the pre-R3 bounds is one frame in which a fast drag
   * can commit a width the pane will not adopt.
   *
   * `ResizeObserver` is guarded rather than assumed. Every browser this app
   * supports has it, but a JSDOM-style test host may not, and the correct
   * behaviour without it is the width-free fallback — a slightly wrong floor —
   * not a view that throws on mount.
   */
  private watchPaneTrack(): void {
    const track = this.paneTrackRef?.nativeElement;
    if (track === undefined) {
      return;
    }
    this.paneLayout.setTrackWidth(track.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    this.paneTrackObserver = new ResizeObserver(() => {
      this.paneLayout.setTrackWidth(track.getBoundingClientRect().width);
    });
    this.paneTrackObserver.observe(track);
  }

  ngOnDestroy() {
    if (this.animationTimer !== null) {
      clearTimeout(this.animationTimer);
      this.animationTimer = null;
    }
    this.paneTrackObserver?.disconnect();
    this.paneTrackObserver = null;
    // The measurement is RETRACTED, not left behind. `PaneLayoutService` is
    // root-scoped and this view is recreated on every team switch, so a width
    // that outlived its element would bound the next divider against the last
    // team's row — most visibly when the rail collapsed in between.
    this.paneLayout.setTrackWidth(null);
    this.presenceSub?.unsubscribe();
    this.presenceSub = null;
    this.routeSub?.unsubscribe();
    this.routeSub = null;
    // Story 52-1 (trap T3): the single writer retracts its own value. Nothing
    // is open once this view is gone, and the header's team name, its Clear
    // action and its details toggle all read that subject. Before the split it
    // was `AppComponent`'s navigation handlers that cleared it, which worked
    // only because leaving the view was always a navigation.
    //
    // The retraction, and dropping the root-scoped agent selection with it,
    // belong to the session rather than to this view: they are what "no team is
    // open" MEANS, not what this particular console does about it.
    this.session.dispose();
  }

  setVisualizationMode(mode: string): void {
    this.visualizationMode$.next(mode);
  }

  get currentVisualizationMode(): string {
    return this.visualizationMode$.value || 'team';
  }

  isHidden(mode: string): boolean {
    const currentMode = this.currentVisualizationMode;
    return currentMode !== mode;
  }

  /**
   * `(percentChange)` from the divider: the pointer moved. Lay out, persist
   * nothing.
   *
   * The number arriving is the LEADING pane's share and the number stored is
   * the inspector's, so the conversion is done on the way in. Doing it in the
   * service instead would put a "which side am I on" question inside a class
   * whose whole job is to have one unambiguous answer.
   */
  onPanePercent(leading: number): void {
    this.paneResizing = true;
    this.paneLayout.setPercent(
      inspectorPercentFromLeading(this.inspectorSide(), leading),
    );
  }

  /** `(commit)`: the drag ended, or a key was pressed. THIS is what persists. */
  onPaneCommit(leading: number): void {
    this.paneResizing = false;
    this.paneLayout.commitPercent(
      inspectorPercentFromLeading(this.inspectorSide(), leading),
    );
  }

  /**
   * The inspector's swap control was pressed: put it on the other side.
   *
   * The pane reports the intent and this view calls the service, rather than
   * the pane writing the preference itself — same shape as `modeChange`. A pane
   * that wrote root state directly would be doing something its host could
   * neither intercept nor decline, and this is the host that knows the panes
   * are two and not one.
   */
  onSwapPanes(): void {
    this.paneLayout.swap();
  }

  /**
   * A member card in the inspector's Team panel was activated.
   *
   * The panel reports an agent_id and nothing else, on purpose — it has no
   * business knowing which tab strip it is sitting in. Resolving that id to a
   * node and deciding what "select" means is this component's job, and it is
   * the SAME job the graph's node click does: it builds the identical
   * `Selectable` and hands it to the identical service. Two surfaces that
   * select a member must select it the same way, or the Member tab shows one
   * agent while the graph highlights another.
   *
   * (This used to name `TreeComponent.onNodeClick`. That component was deleted
   * when the hierarchy tab became the graph alone — the graph is the other
   * surface now.)
   *
   * Switching to `member` afterwards is the half the mock leaves out: without
   * it the click updates a pane the user is not looking at, which reads as the
   * card being inert.
   *
   * `take(1)` over `nodes$` rather than a held array: `graph$` is
   * `shareReplay(1)`, so this resolves synchronously off the latest fold, and
   * keeping a mirrored copy on this component would be a second source of
   * truth for who is on the team.
   */
  onMemberSelected(agentId: string): void {
    this.graphDataService.nodes$.pipe(take(1)).subscribe((nodes) => {
      const node = nodes.find((n) => n.name === agentId);
      // No node means the agent was stopped between the paint and the click.
      // Switching tabs anyway would show the previous member's chat under the
      // impression it was the one just clicked, so the click is dropped.
      if (!node) {
        return;
      }
      this.selectionService.handleSelection({ type: 'tree-node', data: node });
      this.setVisualizationMode('member');
    });
  }
}
