import { Routes } from '@angular/router';
import { AuthGuard } from './core/auth/auth.guard';
import { HomeComponent } from './components/home/home.component';
import { LoginComponent } from './components/login/login.component';
import { ProcessComponent } from './components/process/process.component';
import { namespacePanelCanDeactivate } from './components/catalog/namespace-panel/namespace-panel.guard';
import { AsyncPipe } from '@angular/common';
import { ConnectionToast } from './features/process/event/connection-toast';
import { IngestionService } from './features/process/event/ingestion.service';
import { LoadingIndicator } from './features/process/event/loading-indicator';
import { LogFeeder } from './features/process/event/log-feeder';
import { MessageLogService } from './features/process/event/message-log.service';
import { NotificationToasts } from './features/process/event/notification-toasts';
import { PerAgentStoreRegistry } from './features/process/event/per-agent-store';
import { ProcessStores } from './features/process/event/process-stores';
import { ReplaySeeder } from './features/process/event/replay-seeder';
import { TeamSocket } from './features/process/event/team-socket';
import { TeamStatusReactor } from './features/process/event/team-status-reactor';
import { AgentsByIdService } from './features/process/selectors/agents-by-id.selector';
import { ChatService } from './features/process/selectors/chat.selector';
import { GraphDataService } from './features/process/selectors/graph.selector';
import { KGStateReducer } from './features/process/selectors/knowledge-graph.selector';
import { SystemPromptSelector } from './features/process/selectors/system-prompt.selector';
import { TokenUsageSelector } from './features/process/selectors/token-usage.selector';
import { ToolPresenceService } from './features/process/selectors/tool-presence.selector';
import { WorkspaceInvalidationService } from './features/process/selectors/workspace-invalidation.selector';
import { WorkspaceRegistryService } from './features/process/selectors/workspace-registry.selector';
import { FeedbackService } from './features/process/ui-state/feedback.service';
import { SelectionService } from './features/process/ui-state/selection.service';

/**
 * The app's routes. Epic 56 changed none of the paths: `''` stays
 * `HomeComponent` — that IS the management view the console rail deliberately
 * does not try to replace — and `login` still renders outside the chrome.
 *
 * The four `title` values are translation KEYS, not copy. A plain string here
 * would go straight to the browser tab untranslated, because the router sets
 * the title synchronously off this property with no binding and no pipe in the
 * way. `TranslatedTitleStrategy` (registered in `app.config.ts`) is what makes
 * a key work — including re-resolving the tab when the user switches language,
 * which is not a navigation and so would otherwise be missed.
 *
 * Consequence worth knowing before adding a route: a `title` whose key is not
 * in `en.json` renders as the key itself in the tab. The locale-parity spec
 * catches an en/fr mismatch; it cannot catch a key nobody defined.
 */
/**
 * THE TEAM'S SERVICES, SCOPED TO THE ROUTE RATHER THAN TO A COMPONENT.
 *
 * All twenty-three used to be `ProcessComponent.providers`, and every component
 * that wanted one injected it bare — which meant every one of them could only
 * ever be mounted inside that component. That is the coupling in the way of
 * reusing a panel anywhere else, and of anybody assembling a second UI out of
 * the same parts: a component that silently requires a particular ancestor is
 * not a component you can place.
 *
 * `Route.providers` gives them an ENVIRONMENT injector owned by the route.
 * Nothing about their lifetime changes — it is created when the route activates
 * and destroyed when it deactivates, which is the same window the component
 * had — but nothing has to be mounted under a specific component to reach them.
 *
 * WHAT IT DOES NOT CHANGE, and what the old comments here claimed it did. The
 * router REUSES this route when only `:id` changes, so neither the component
 * nor this injector is recreated on a team switch; `ProcessComponent.openTeam`
 * tears the previous team down by hand, and that is what actually isolates one
 * team from the next. The repeated "a team switch destroys this" reasoning was
 * true only of navigating away and back. Left in place, retargeted, because the
 * conclusion it defends — never `providedIn: 'root'` — is still right: root
 * scope would survive even that.
 *
 * ORDER IS NOT SIGNIFICANT. Several entries below say they must be provided
 * AFTER or BEFORE another. Angular resolves providers by token, not by
 * position, and always has; the order is a reading aid for the dependency
 * chain and nothing more. Kept as written rather than sorted, because the
 * chain it traces is genuinely useful.
 */
const PROCESS_PROVIDERS = [
  AsyncPipe,
  MessageLogService,
  // Epic 23 (ADR-019): route-scoped registry that folds the message log
  // into the set of WorkspaceDescriptors driving the workspace sub-tabs. Must
  // be provided AFTER MessageLogService (which it injects). Never
  // `providedIn: 'root'` — it shares the team-scoped log lifecycle, so a team
  // switch destroys it and never leaks workspaces across teams.
  WorkspaceRegistryService,
  // Epic 39 (ADR-031): route-scoped unit turning the message log into
  // workspace re-read instructions, one per completed mutating workspace tool
  // call. Provided AFTER MessageLogService (which it injects) and next to the
  // registry it shares a lifecycle with. Never `providedIn: 'root'` — it HOLDS
  // the team's in-flight calls and their agent→workspace attribution, and
  // empties both on the log reset that opens a team switch; a root instance
  // would carry one team's held calls into the next.
  WorkspaceInvalidationService,
  // Epic 23 (ADR-020): route-scoped identity map that folds the message
  // log into `agent_id -> { name, role }`, combined in WorkspaceTabsComponent
  // with the workspace registry to render each workspace's member chips.
  // Provided AFTER MessageLogService (which it injects); never
  // `providedIn: 'root'` — it shares the team-scoped log lifecycle.
  AgentsByIdService,
  ToolPresenceService,
  KGStateReducer,
  SystemPromptSelector,
  // Epic 17 (ADR-014): route-scoped registry that derives per-agent
  // `state` / `context` from `log$`. Must be provided BEFORE
  // IngestionService (which injects it). Never `providedIn: 'root'` —
  // a team switch destroys this component, destroying the registry and its
  // single `log$` subscription (same lifecycle guarantee as MessageLogService).
  PerAgentStoreRegistry,
  // Epic 34 (ADR-025 §1): the projection unit declaring the five per-agent
  // stores. Provided BETWEEN the registry (which it injects) and
  // IngestionService (which injects it and re-exports its stores). Never
  // `providedIn: 'root'` — it wraps the route-scoped registry, and root
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
  // Epic 26 (ADR-022): route-scoped read surface over the `tokenUsage`
  // PerAgentStore. Provided AFTER IngestionService (which it injects); never
  // `providedIn: 'root'` — it shares the team-scoped log lifecycle, so a team
  // switch destroys it and the usage pill always reads THIS team's totals.
  TokenUsageSelector,
  GraphDataService,
  ChatService,
  SelectionService,
  FeedbackService,
];

export const routes: Routes = [
  {
    path: '',
    component: HomeComponent,
    title: 'title.home',
    canActivate: [AuthGuard],
  },
  {
    path: 'process/:id',
    component: ProcessComponent,
    title: 'title.process',
    canActivate: [AuthGuard],
    providers: PROCESS_PROVIDERS,
  },
  {
    // Story 11.6 — deep-link route for the catalog namespace panel.
    // `loadComponent` keeps the panel (and its Monaco bundle) out of the
    // initial home-page chunk (NFR8). The functional `CanDeactivate` guard
    // prompts before losing an operator's unsaved edit buffer.
    path: 'admin/catalog/namespace/:namespace',
    loadComponent: () =>
      import(
        './components/catalog/namespace-panel/namespace-panel-route.component'
      ).then((m) => m.NamespacePanelRouteComponent),
    title: 'title.catalogNamespace',
    canActivate: [AuthGuard],
    canDeactivate: [namespacePanelCanDeactivate],
  },
  { path: 'login', component: LoginComponent, title: 'title.login' },
];
