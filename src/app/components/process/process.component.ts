import { AsyncPipe, CommonModule } from '@angular/common';
import { AfterViewInit, Component, inject, OnDestroy } from '@angular/core';
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

interface VisualizationOption {
  label: string;
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
export class ProcessComponent implements AfterViewInit, OnDestroy {
  route: ActivatedRoute = inject(ActivatedRoute);
  router: Router = inject(Router);

  akgentService: AkgentService = inject(AkgentService);
  contextService: ContextService = inject(ContextService);
  ingestionService: IngestionService = inject(IngestionService);
  graphDataService: GraphDataService = inject(GraphDataService);
  viewService: ViewService = inject(ViewService);
  toolPresenceService: ToolPresenceService = inject(ToolPresenceService);
  private readonly workspaceRegistry = inject(WorkspaceRegistryService);

  processId: string = '';

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
    { label: 'Team', value: 'team', icon: 'pi pi-users' },
    { label: 'Member', value: 'member', icon: 'pi pi-user' },
    {
      label: 'Knowledge graph',
      value: 'knowledge-graph',
      icon: 'pi pi-sitemap',
    },
    { label: 'Workspaces', value: 'workspace', icon: 'pi pi-folder-open' },
    { label: 'Messages', value: 'messages', icon: 'pi pi-envelope' },
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

  async ngOnInit(): Promise<void> {
    this.processId = this.route.snapshot.params['id'];
    this.contextService.currentProcessId$.next(this.processId);

    const useCache = false;
    const currentProcess = await this.contextService.getCurrentTeam(
      this.processId,
      useCache
    );

    // Ensure we always have a visualization mode selected
    if (!this.visualizationMode$.value) {
      this.visualizationMode$.next('team');
    }

    if (currentProcess === null) {
      this.router.navigate(['/']);
      return;
    }

    // KG presence is reactive (Story 5-3 / ADR-004 §Decision 4): the
    // `hasKnowledgeGraph$` observable flips based on `#KnowledgeGraphTool`
    // `StartMessage` / `StopMessage` on the replay + live streams. Workspace
    // presence remains static until a future story reactivates it.

    await this.ingestionService.init(this.processId, isRunning(currentProcess));
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
