import { inject, Injectable } from '@angular/core';
import { distinctUntilChanged, map, Observable } from 'rxjs';

import {
  AkgenticMessage,
  isStartMessage,
  isStopMessage,
  isWorkspaceTool,
  StartMessage,
  ToolCardLite,
} from '../../../protocol/message.types';
import { MessageLogService } from '../event/message-log.service';

/**
 * One discovered workspace in a team (Epic 23 / ADR-019 §Decision 1).
 *
 * `workspaceId` is the *effective* id the backend resolves to (see
 * `effectiveWorkspaceId`); `isDefault` marks the always-present team-default
 * workspace; `agentIds` records every agent whose `WorkspaceTool` contributed
 * to this descriptor (deterministically ordered for structural equality);
 * `label` is a deterministic UI string consumed by Story 23-3.
 */
export interface WorkspaceDescriptor {
  workspaceId: string;
  isDefault: boolean;
  agentIds: string[];
  label: string;
}

/**
 * Effective workspace id for a `WorkspaceTool` entry (ADR-019 FR4 / NFR5).
 * Mirrors the backend `ws_name = self.workspace_id or str(observer.team_id)`
 * so the UI and backend agree on workspace identity. Encoded ONCE here.
 *
 * JS `??` falls back only on `null`/`undefined` (matching the wire type
 * `workspace_id?: string | null`); an empty `workspace_id` is not a
 * real-world case, so `??` is the correct, simplest encoding.
 */
function effectiveWorkspaceId(tool: ToolCardLite, teamId: string): string {
  return tool.workspace_id ?? teamId;
}

/** Deterministic per-descriptor label (UI nicety, finalised in Story 23-3). */
function labelFor(workspaceId: string, isDefault: boolean): string {
  return isDefault ? 'Default workspace' : workspaceId;
}

/**
 * Per-agent contribution: the set of effective workspace ids an agent's
 * `WorkspaceTool`s resolve to under its latest `StartMessage`. Keyed by
 * `sender.agent_id`; a `StopMessage` removes the agent's entry; a later
 * `StartMessage` for the same agent replaces it (last-wins).
 */
type Contributions = Map<string, Set<string>>;

/** Effective ids contributed by one `StartMessage` (deduped within the agent). */
function startContribution(msg: StartMessage): Set<string> {
  const teamId = msg.config.team_id;
  const ids = new Set<string>();
  for (const tool of msg.config.tools ?? []) {
    if (isWorkspaceTool(tool)) ids.add(effectiveWorkspaceId(tool, teamId));
  }
  return ids;
}

/**
 * Build the descriptor list from the resolved per-agent contributions plus the
 * always-present default descriptor (ADR-019 §Decision 3). The default
 * (`workspaceId === teamId`) is emitted first and absorbs any agent whose
 * effective id equals the team id rather than creating a second default.
 */
function buildDescriptors(
  contributions: Contributions,
  teamId: string,
): WorkspaceDescriptor[] {
  const byId = new Map<string, Set<string>>([[teamId, new Set<string>()]]);
  for (const [agentId, ids] of contributions) {
    for (const id of ids) {
      const agents = byId.get(id) ?? new Set<string>();
      agents.add(agentId);
      byId.set(id, agents);
    }
  }
  return [...byId.entries()].map(([workspaceId, agents]) => {
    const isDefault = workspaceId === teamId;
    return {
      workspaceId,
      isDefault,
      agentIds: [...agents].sort(),
      label: labelFor(workspaceId, isDefault),
    };
  });
}

/**
 * Pure ordered fold over the message log → the deduped set of workspaces in a
 * team (ADR-019 §Decision 1/2/3, mirror of `presenceReduce`).
 *
 * Ordered-reduce semantics are LOAD-BEARING: a `Start → Stop → Start` restart
 * for one agent must resolve to *present* (last Start wins) — a
 * `some(isStart) && !some(isStop)` shortcut would be wrong. We track each
 * agent's latest contribution and rebuild descriptors, so a `StopMessage`
 * drops only that agent (a descriptor backed by another agent survives; the
 * default descriptor is never removed).
 *
 * Exported at module scope so tests assert it directly without a `TestBed`.
 */
export function workspaceRegistryReduce(
  log: AkgenticMessage[],
  teamId: string,
): WorkspaceDescriptor[] {
  const contributions: Contributions = new Map();
  for (const m of log) {
    if (isStartMessage(m)) {
      contributions.set(m.sender.agent_id, startContribution(m));
    } else if (isStopMessage(m)) {
      contributions.delete(m.sender.agent_id);
    }
  }
  return buildDescriptors(contributions, teamId);
}

/** Deep structural equality of two descriptor arrays (NFR3). `agentIds` is
 *  kept sorted by the fold, so element-wise comparison is order-stable. */
function descriptorsEqual(
  a: WorkspaceDescriptor[],
  b: WorkspaceDescriptor[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((d, i) => {
    const o = b[i];
    return (
      d.workspaceId === o.workspaceId &&
      d.isDefault === o.isDefault &&
      d.label === o.label &&
      d.agentIds.length === o.agentIds.length &&
      d.agentIds.every((id, j) => id === o.agentIds[j])
    );
  });
}

/**
 * Effective team id for the default descriptor, derived from the log itself so
 * the fold stays a pure function of `log$` (restart- and REST-replay-safe, no
 * external team-id input). Uses the first message's `team_id`; before any
 * message arrives there is none, so a stable placeholder `''` is used and the
 * real team id lands on the first emission — the panel is non-empty by
 * construction at all times.
 */
function teamIdFromLog(log: AkgenticMessage[]): string {
  return log.length > 0 ? log[0].team_id : '';
}

/**
 * WorkspaceRegistryService — Story 23-1 (ADR-019 §Decision 1).
 *
 * Publishes `workspaces$` as a pure selector over `MessageLogService.log$`:
 * the deduped set of `WorkspaceDescriptor`s discovered by folding every
 * agent's `StartMessage.config.tools`. Set-valued sibling of
 * `ToolPresenceService`.
 *
 * Scope: component-scoped (NOT `providedIn: 'root'`) because it injects
 * `MessageLogService`, which is component-scoped on `ProcessComponent`. A team
 * switch destroys the component (and the log), so the registry shares that
 * lifecycle and never leaks workspaces across teams. NOT yet provided in
 * `process.component` — that wiring is Story 23-3.
 *
 * `distinctUntilChanged` uses a STRUCTURAL comparator (`descriptorsEqual`):
 * the fold emits a NEW array reference per `log$` emission, so the default
 * reference comparator would never suppress no-op re-emissions (NFR3).
 */
@Injectable()
export class WorkspaceRegistryService {
  private readonly log: MessageLogService = inject(MessageLogService);

  readonly workspaces$: Observable<WorkspaceDescriptor[]> = this.log.log$.pipe(
    map((log) => workspaceRegistryReduce(log, teamIdFromLog(log))),
    distinctUntilChanged(descriptorsEqual),
  );
}
