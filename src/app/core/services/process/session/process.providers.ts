import { AsyncPipe } from '@angular/common';
import { ConnectionToast } from '../event/connection-toast';
import { IngestionService } from '../event/ingestion.service';
import { TeamSessionService } from './team-session.service';
import { LoadingIndicator } from '../event/loading-indicator';
import { LogFeeder } from '../event/log-feeder';
import { MessageLogService } from '../event/message-log.service';
import { NotificationToasts } from '../event/notification-toasts';
import { PerAgentStoreRegistry } from '../event/per-agent-store';
import { ProcessStores } from '../event/process-stores';
import { ReplaySeeder } from '../event/replay-seeder';
import { TeamSocket } from '../event/team-socket';
import { TeamStatusReactor } from '../event/team-status-reactor';
import { AgentsByIdService } from '../selectors/agents-by-id.selector';
import { ChatService } from '../selectors/chat.selector';
import { GraphDataService } from '../selectors/graph.selector';
import { KGStateReducer } from '../selectors/knowledge-graph.selector';
import { SystemPromptSelector } from '../selectors/system-prompt.selector';
import { TokenUsageSelector } from '../selectors/token-usage.selector';
import { ToolPresenceService } from '../selectors/tool-presence.selector';
import { WorkspaceInvalidationService } from '../selectors/workspace-invalidation.selector';
import { WorkspaceRegistryService } from '../selectors/workspace-registry.selector';
import { FeedbackService } from '../ui-state/feedback.service';
import { SelectionService } from '../ui-state/selection.service';

/**
 * THE TEAM'S SERVICES, SCOPED TO THE ROUTE RATHER THAN TO A COMPONENT.
 *
 * TWO COUNTS RANGE OVER THIS ARRAY AND THEY ARE NOT THE SAME NUMBER. It holds
 * TWENTY-FOUR entries: TWENTY-THREE service classes — the team's stack — plus
 * Angular's `AsyncPipe`, which is a pipe and not one of the team's services.
 * Both numbers appear below; each says which set it counts.
 *
 * All twenty-three service classes used to be the `process/:id` route's
 * providers, and every component that wanted one injected it bare — which meant
 * every one of them could only ever be mounted inside that component. That is
 * the coupling in the way of reusing a panel anywhere else, and of anybody
 * assembling a second UI out of the same parts: a component that silently
 * requires a particular ancestor is not a component you can place.
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
/**
 * EXPORTED, and that is not incidental. A developer who clones this repo to
 * build a different console needs this array verbatim — it is the team's whole
 * service stack — and an unexported `const` left them copying twenty-four
 * entries by hand, in order, from the file they were about to replace.
 *
 * IT LIVES BESIDE `team-session.service.ts` RATHER THAN IN THE ROUTER, which is
 * the point of the move: `app.routes.ts` is the one file every UI variant
 * rewrites, and a developer who replaces it was replacing this array along with
 * it. Here the stack is a thing a second console IMPORTS instead of a thing it
 * has to carry across. `session/` is where it belongs because this array is the
 * composed pipeline and `svc-session` is the tier that composes it — the only
 * unit in the data layer whose job is to assemble the others.
 */
export const PROCESS_PROVIDERS = [
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
  // The open/close ritual itself. Provided AFTER IngestionService for the same
  // reading-order reason as everything else here; it injects it.
  TeamSessionService,
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
