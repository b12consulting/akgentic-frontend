import { AsyncPipe, CommonModule } from '@angular/common';
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

import { isRunning } from '../../core/context/team.interface';
import { AkgentService } from '../../core/ui/akgent.service';
import {
  inspectorPercentFromLeading,
  INSPECTOR_DEFAULT_PERCENT,
  leadingPercent as leadingPercentOf,
} from '../../core/ui/pane-layout';
import { PaneLayoutService } from '../../core/ui/pane-layout.service';
import { ViewService } from '../../core/ui/view.service';
import { ContextService } from '../../core/context/context.service';
import { KGStateReducer } from './selectors/knowledge-graph.selector';
import { ConnectionToast } from './event/connection-toast';
import { NotificationToasts } from './event/notification-toasts';
import { LoadingIndicator } from './event/loading-indicator';
import { LogFeeder } from './event/log-feeder';
import { MessageLogService } from './event/message-log.service';
import { IngestionService } from './event/ingestion.service';
import { PerAgentStoreRegistry } from './event/per-agent-store';
import { ProcessStores } from './event/process-stores';
import { ReplaySeeder } from './event/replay-seeder';
import { SystemPromptSelector } from './selectors/system-prompt.selector';
import { TeamSocket } from './event/team-socket';
import { TeamStatusReactor } from './event/team-status-reactor';
import { TokenUsageSelector } from './selectors/token-usage.selector';
import { ToolPresenceService } from './selectors/tool-presence.selector';
import { WorkspaceInvalidationService } from './selectors/workspace-invalidation.selector';
import { WorkspaceRegistryService } from './selectors/workspace-registry.selector';
import { AgentsByIdService } from './selectors/agents-by-id.selector';

import { AgentTabsComponent } from './components/agent-tabs/agent-tabs.component';
import { TeamTabsComponent } from './components/team-tabs/team-tabs.component';
import { KnowledgeGraphComponent } from './components/knowledge-graph/knowledge-graph.component';
import { MessageListComponent } from './components/message-list/message-list.component';
import { WorkspaceTabsComponent } from './components/workspace-tabs/workspace-tabs.component';

import { BehaviorSubject, combineLatest, Observable, Subscription } from 'rxjs';
import { distinctUntilChanged, map, take } from 'rxjs/operators';
import { ChatPanelComponent } from './components/chat/chat-panel.component';
import { ChatService } from './selectors/chat.selector';
import { FeedbackService } from './ui-state/feedback.service';
import { GraphDataService } from './selectors/graph.selector';
import { SelectionService } from './ui-state/selection.service';

import { ConversationHeaderComponent } from '../console/conversation/conversation-header.component';
import { ConsoleInspectorComponent } from '../console/inspector/console-inspector.component';
import { InspectorTeamPanelComponent } from '../console/inspector/team-panel/inspector-team-panel.component';
import { VisualizationOption } from '../console/inspector/inspector-tabs.component';
import { SplitDividerComponent } from '../../shared/components/split-divider/split-divider.component';

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
  providers: [
    AsyncPipe,
    MessageLogService,
    // Epic 23 (ADR-019): component-scoped registry that folds the message log
    // into the set of WorkspaceDescriptors driving the workspace sub-tabs. Must
    // be provided AFTER MessageLogService (which it injects). Never
    // `providedIn: 'root'` — it shares the team-scoped log lifecycle, so a team
    // switch destroys it and never leaks workspaces across teams.
    WorkspaceRegistryService,
    // Epic 39 (ADR-031): component-scoped unit turning the message log into
    // workspace re-read instructions, one per completed mutating workspace tool
    // call. Provided AFTER MessageLogService (which it injects) and next to the
    // registry it shares a lifecycle with. Never `providedIn: 'root'` — it HOLDS
    // the team's in-flight calls and their agent→workspace attribution, and
    // empties both on the log reset that opens a team switch; a root instance
    // would carry one team's held calls into the next.
    WorkspaceInvalidationService,
    // Epic 23 (ADR-020): component-scoped identity map that folds the message
    // log into `agent_id -> { name, role }`, combined in WorkspaceTabsComponent
    // with the workspace registry to render each workspace's member chips.
    // Provided AFTER MessageLogService (which it injects); never
    // `providedIn: 'root'` — it shares the team-scoped log lifecycle.
    AgentsByIdService,
    ToolPresenceService,
    KGStateReducer,
    SystemPromptSelector,
    // Epic 17 (ADR-014): component-scoped registry that derives per-agent
    // `state` / `context` from `log$`. Must be provided BEFORE
    // IngestionService (which injects it). Never `providedIn: 'root'` —
    // a team switch destroys this component, destroying the registry and its
    // single `log$` subscription (same lifecycle guarantee as MessageLogService).
    PerAgentStoreRegistry,
    // Epic 34 (ADR-025 §1): the projection unit declaring the five per-agent
    // stores. Provided BETWEEN the registry (which it injects) and
    // IngestionService (which injects it and re-exports its stores). Never
    // `providedIn: 'root'` — it wraps the component-scoped registry, and root
    // scope would leak per-agent state across team switches.
    ProcessStores,
    // Epic 34 (ADR-025 §1): the REST replay source, provided BEFORE
    // IngestionService (which injects it). Never `providedIn: 'root'` — it is
    // stateless, so root scope would leak nothing today, but the folder's
    // uniform component scoping keeps this list readable and keeps a future
    // stateful mistake contained to one team's lifetime.
    ReplaySeeder,
    // Epic 34 (ADR-025 §0-§1): the spinner-floor reactor, provided BEFORE
    // IngestionService (which injects it and re-exports its `loadingProcess$`).
    // Never `providedIn: 'root'` — a root instance would outlive this view and
    // carry a prior team's spinner state, and its `| async`-bound subject, into
    // the next one.
    LoadingIndicator,
    // Epic 34 (ADR-025 §0-§1): the WS-disconnect toast reactor, provided BEFORE
    // IngestionService (which injects it and drives its start/show/stop). A
    // separate class from the notification toast on purpose — the two carry
    // opposite `closable` semantics and their old adjacency had already caused
    // one copy-paste defect. Never `providedIn: 'root'` — its dedup flag is
    // per-team-cycle, and a root instance would outlive the team switch that
    // `start()` resets it for.
    ConnectionToast,
    // Epic 34 (ADR-025 §0-§1): the notification-toast reactor (stories 31-3 /
    // 31-4 / 31-5 / 31-6), provided BEFORE IngestionService, which injects it and
    // drives its start/stop. Never `providedIn: 'root'` — it caches per-team
    // dismissal state, and a root instance would carry one team's closed ids into
    // the next, silently suppressing toasts that should have been raised.
    NotificationToasts,
    // Story 37-2: the team-stopping reactor, provided BEFORE IngestionService,
    // which injects it and drives its start/stop. Never `providedIn: 'root'` —
    // it belongs to the process view's log lifecycle like every other unit in
    // that folder, and a root instance would keep reading a destroyed team's
    // log. It writes to the root-scoped `ContextService`, which is the point:
    // that service outlives this view and owns team status.
    TeamStatusReactor,
    // Epic 34 (ADR-025 §1): the WS transport source, provided BEFORE
    // IngestionService (which injects it and opens it LAST in `init()`). Never
    // `providedIn: 'root'` — a root instance would share ONE socket across every
    // team switch, which is the transport half of the race ADR-005 §Decision 6
    // closes.
    TeamSocket,
    // Epic 34 (ADR-025 §1): the frame-batched log feed, provided BEFORE
    // IngestionService (which injects it and hands it the socket's inbound
    // stream). Never `providedIn: 'root'` — a root instance would feed one
    // team's frames into the next team's log.
    LogFeeder,
    IngestionService,
    // Epic 26 (ADR-022): component-scoped read surface over the `tokenUsage`
    // PerAgentStore. Provided AFTER IngestionService (which it injects); never
    // `providedIn: 'root'` — it shares the team-scoped log lifecycle, so a team
    // switch destroys it and the usage pill always reads THIS team's totals.
    TokenUsageSelector,
    GraphDataService,
    ChatService,
    SelectionService,
    FeedbackService,
  ],
  templateUrl: './process.component.html',
  styleUrl: './process.component.scss',
})
export class ProcessComponent implements OnChanges, AfterViewInit, OnDestroy {
  route: ActivatedRoute = inject(ActivatedRoute);
  router: Router = inject(Router);

  akgentService: AkgentService = inject(AkgentService);
  contextService: ContextService = inject(ContextService);
  ingestionService: IngestionService = inject(IngestionService);
  graphDataService: GraphDataService = inject(GraphDataService);
  private readonly selectionService = inject(SelectionService);
  toolPresenceService: ToolPresenceService = inject(ToolPresenceService);
  private readonly workspaceRegistry = inject(WorkspaceRegistryService);

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

  private readonly allVisualizationOptions: VisualizationOption[] = [
    { labelKey: 'visualization.team', value: 'team', icon: 'pi pi-users' },
    // Epic 56 / H2. The redesign gave `team` a new panel — roster, tools,
    // spend — and that panel deliberately does NOT carry the team tree or the
    // echarts graph. Those two are a real capability, so they get a tab of
    // their own rather than being folded in behind the Member tab: `member` is
    // "one agent, in detail", and hiding a team-wide tree under it would make
    // the tab strip lie about what each entry shows. It is the only arrangement
    // where every pre-Epic-56 view keeps a name.
    //
    // A CORRECTION, because the note that stood here was wrong and load-bearing
    // in the wrong direction: it said a sixth entry "costs nothing — the strip
    // scrolls". It did not. The captioned strip overflowed its lane at this tab
    // count in English and comfortably before it in French, and the overflow
    // was a horizontal scroll that hid the last tab rather than a layout that
    // absorbed it. The strip is icon-only now and fits in one row at any width
    // the divider can be dragged to; see `inspector-tabs.component.scss`. Adding
    // a SEVENTH entry is still a decision to take against that arithmetic, not
    // a free one.
    {
      labelKey: 'visualization.hierarchy',
      value: 'hierarchy',
      icon: 'pi pi-share-alt',
    },
    // `pi-id-card`, NOT `pi-user`. Beside `pi-users` on the Team tab the two
    // were one head against two at 13px — a difference a reader has to hunt
    // for, on a strip where the glyph is the primary way five of the six tabs
    // are told apart. A card silhouette differs in OUTLINE rather than in
    // count, which is what survives at this size.
    { labelKey: 'visualization.member', value: 'member', icon: 'pi pi-id-card' },
    {
      labelKey: 'visualization.knowledgeGraph',
      value: 'knowledge-graph',
      icon: 'pi pi-sitemap',
    },
    { labelKey: 'visualization.workspaces', value: 'workspace', icon: 'pi pi-folder-open' },
    { labelKey: 'visualization.messages', value: 'messages', icon: 'pi pi-envelope' },
  ];

  /**
   * Reactive, filtered list of visualization options. Recomputed whenever
   * `hasKnowledgeGraph$` or `hasWorkspace$` emits — the Knowledge graph and
   * Workspaces tabs each appear only when their tool is present.
   */
  visualizationOptions$: Observable<VisualizationOption[]> = combineLatest([
    this.toolPresenceService.hasKnowledgeGraph$,
    this.hasWorkspace$,
  ]).pipe(
    map(([hasKG, hasWS]) =>
      this.allVisualizationOptions.filter(
        (option) =>
          (option.value !== 'knowledge-graph' || hasKG) &&
          (option.value !== 'workspace' || hasWS),
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
  private workspaceSub: Subscription | null = null;
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
    // Active-mode reset guard (AC3 last clause, AC8): if the user is viewing
    // the KG tab when presence flips to `false`, snap back to 'team' so we
    // never leave the user on a hidden-mode blank panel.
    this.presenceSub = this.toolPresenceService.hasKnowledgeGraph$.subscribe(
      (hasKG) => {
        if (!hasKG && this.currentVisualizationMode === 'knowledge-graph') {
          this.visualizationMode$.next('team');
        }
      },
    );

    // Same guard for the Workspaces tab: if it disappears (last workspace tool
    // removed) while the user is viewing it, snap back to 'team'.
    this.workspaceSub = this.hasWorkspace$.subscribe((hasWS) => {
      if (!hasWS && this.currentVisualizationMode === 'workspace') {
        this.visualizationMode$.next('team');
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
   * Close whatever is open and open the team the current id names.
   *
   * The teardown happens HERE and up front, not inside the next
   * `ingestionService.init()`: `getCurrentTeam` is awaited below, and across
   * that await the previous team's socket would otherwise still be writing
   * into the log the new team is about to inherit (FR2, trap T2).
   */
  private async openTeam(): Promise<void> {
    const teamId = this.resolveTeamId();
    if (this.opened && teamId === this.processId) {
      return;
    }
    this.opened = true;
    const epoch = ++this.openEpoch;

    this.closeOpenTeam();

    this.processId = teamId;
    // Trap T3: this view is the ONLY writer of a team id on the global
    // subject. The host selects by binding `teamId` and reads the id back from
    // here — a host that also wrote here would make the agent tabs and the
    // workspace follow whichever of the two wrote last.
    this.contextService.currentProcessId$.next(teamId);

    if (teamId === '') {
      return;
    }

    const useCache = false;
    const currentProcess = await this.contextService.getCurrentTeam(
      teamId,
      useCache
    );

    // A newer selection won the race while this fetch was in flight. It has
    // already published its own id and torn this one down; finishing here
    // would initialise the pipeline for a team nobody is looking at.
    if (epoch !== this.openEpoch) {
      return;
    }

    // Ensure we always have a visualization mode selected
    if (!this.visualizationMode$.value) {
      this.visualizationMode$.next('team');
    }

    if (currentProcess === null) {
      // The team is gone. Two answers, and after R1 only the second one is ever
      // given: a HOST (if one is ever bound again) owns the selection and has
      // to be told it is dangling, while the route mode this view now always
      // runs in has nobody to tell and navigates home instead. The emit is
      // unconditional because a dangling team is a fact about the team, not
      // about who asked; with no subscriber it costs nothing.
      this.teamUnavailable.emit(teamId);
      if (this.teamId === null) {
        void this.contextService.navigateHome();
      }
      return;
    }

    // KG presence is reactive (Story 5-3 / ADR-004 §Decision 4): the
    // `hasKnowledgeGraph$` observable flips based on `#KnowledgeGraphTool`
    // `StartMessage` / `StopMessage` on the replay + live streams. Workspace
    // presence remains static until a future story reactivates it.

    await this.ingestionService.init(teamId, isRunning(currentProcess));
  }

  /**
   * Release everything that belongs to the team currently open.
   *
   * Two things outlive a team switch and so have to be named here. The
   * ingestion pipeline is one — `close()` disposes the cycle AND empties the
   * log, which is what unmounts the knowledge-graph and workspace panels,
   * because their presence is a fold over that log. `AkgentService` is the
   * other: it is root-scoped, so the previous team's selected agent survives
   * a switch that destroys nothing.
   *
   * The visualization mode is deliberately NOT reset. It is a view preference,
   * not team state, and the presence guards in the constructor already snap it
   * back to `team` when the tab it names does not exist for the new team.
   */
  private closeOpenTeam(): void {
    if (this.processId === '') {
      return;
    }
    this.akgentService.unselect();
    this.ingestionService.close();
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
    this.akgentService.unselect();
    this.presenceSub?.unsubscribe();
    this.presenceSub = null;
    this.workspaceSub?.unsubscribe();
    this.workspaceSub = null;
    this.routeSub?.unsubscribe();
    this.routeSub = null;
    // Story 52-1 (trap T3): the single writer retracts its own value. Nothing
    // is open once this view is gone, and the header's team name, its Clear
    // action and its details toggle all read that subject. Before the split it
    // was `AppComponent`'s navigation handlers that cleared it, which worked
    // only because leaving the view was always a navigation.
    this.contextService.currentProcessId$.next('');
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
