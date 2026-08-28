import { AsyncPipe, CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  EventEmitter,
  inject,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { isRunning } from '../../core/context/team.interface';
import { AkgentService } from '../../core/ui/akgent.service';
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

import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TabsModule } from 'primeng/tabs';
import { BehaviorSubject, combineLatest, Observable, Subscription } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';
import { ChatPanelComponent } from './components/chat/chat-panel.component';
import { ChatService } from './selectors/chat.selector';
import { FeedbackService } from './ui-state/feedback.service';
import { GraphDataService } from './selectors/graph.selector';
import { SelectionService } from './ui-state/selection.service';
import { ViewService } from '../../core/ui/view.service';
import { TranslatePipe } from '@ngx-translate/core';

interface VisualizationOption {
  /**
   * A translation KEY, not a caption.
   *
   * The switcher's template resolves it. Held as copy it would be an English
   * string travelling through a `[options]` binding into PrimeNG, where nothing
   * downstream knows a translation layer exists — and `value` below is the
   * identity every rule keys off, so the caption never has to be matched on.
   */
  labelKey: string;
  value: string;
  icon: string;
}

@Component({
  selector: 'app-process',
  imports: [
    CommonModule,
    MessageListComponent,
    AgentTabsComponent,
    TeamTabsComponent,
    KnowledgeGraphComponent,
    WorkspaceTabsComponent,
    TabsModule,
    ButtonModule,
    ChatPanelComponent,
    SelectButtonModule,
    FormsModule,
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
  viewService: ViewService = inject(ViewService);
  toolPresenceService: ToolPresenceService = inject(ToolPresenceService);
  private readonly workspaceRegistry = inject(WorkspaceRegistryService);

  /**
   * Story 52-1 (FR1): the team this view should show, supplied by whoever
   * HOSTS it.
   *
   * `null` is "nobody told me", NOT "no team" — the route parameter answers
   * instead, which is the whole of NFR1: `/process/:id` has no host and binds
   * nothing, so it lands on exactly the behaviour it had before this input
   * existed.
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
   * A host cannot discover this any other way — the fetch happens in here — and
   * it must, because it is holding a selection that points at nothing. On the
   * standalone route there is no host to tell, so that path keeps its own
   * answer (`navigateHome`); see `openTeam`.
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
    { labelKey: 'visualization.member', value: 'member', icon: 'pi pi-user' },
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

  isRightColumnCollapsed$ =
    this.viewService.isRightColumnCollapsed$.asObservable();

  /**
   * Gates the right column's collapse transition, which must not run on the
   * first paint: arriving from the home page with details already hidden would
   * otherwise show the panel sliding shut, as if the user had just closed it.
   * Turned on one macrotask after the view exists, so the initial state paints
   * with `transition-duration: 0` and every later toggle animates.
   */
  animateRightColumn = false;

  isLoading$ = this.graphDataService.isLoading$;

  private presenceSub: Subscription | null = null;
  private workspaceSub: Subscription | null = null;
  private animationTimer: ReturnType<typeof setTimeout> | null = null;

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
      // Hosted, the host owns the selection and has to be told it is dangling.
      // Standalone, there is no host: leave as the user left it — see
      // ContextService.navigateHome.
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
  }

  ngOnDestroy() {
    if (this.animationTimer !== null) {
      clearTimeout(this.animationTimer);
      this.animationTimer = null;
    }
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
}
