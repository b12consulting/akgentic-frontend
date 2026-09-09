import { inject, Injectable } from '@angular/core';
import { distinctUntilChanged, map, Observable } from 'rxjs';

import {
  AkgenticMessage,
  isResourceAttached,
  isStopMessage,
  ResourceAttached,
} from '../../../protocol/message.types';
import { MessageLogService } from '../event/message-log.service';

/**
 * One discovered workspace in a team (Epic 23 / ADR-019 §Decision 1).
 *
 * `workspaceId` is the workspace's LEAF — the last segment of the path the
 * backend resolved, read off the orchestrator's `ResourceAttached` event
 * (ADR-022 §Decision 8). It is what reaches `?workspace_id=`, byte-identical.
 * `isDefault` marks the team-default workspace; `agentIds` records every agent
 * currently bound to this workspace (deterministically ordered for structural
 * equality); `label` is a deterministic UI string consumed by Story 23-3.
 */
export interface WorkspaceDescriptor {
  workspaceId: string;
  isDefault: boolean;
  agentIds: string[];
  label: string;
}

/**
 * The workspace LEAF an attach event announces, or `null` when the frame does
 * not carry a usable one.
 *
 * This is the ONE place a workspace id enters this package from the wire, and it
 * is read rather than derived: the client holds a leaf it was given and never
 * computes `<scope>/<leaf>`. An empty last segment (a trailing `/`, or an empty
 * path) is not an id, so it yields `null` rather than an empty tab.
 *
 * `workspace_path` is checked with `typeof … === 'string'` and not merely
 * trusted: the field's declared type is a promise this module cannot enforce
 * over a wire payload, and `.split` on a non-string THROWS. That matters more
 * than it did under a pure fold — `workspace-invalidation.selector.ts` reads
 * these same frames inside a LIVE subscription, and a throw there tears the
 * subscription down permanently with nothing to re-subscribe.
 */
export function attachedLeaf(msg: ResourceAttached): string | null {
  const path: unknown = msg.workspace_path;
  if (typeof path !== 'string') return null;
  const segments = path.split('/');
  const leaf = segments[segments.length - 1];
  return leaf === '' ? null : leaf;
}

/**
 * The BINDING agent an attach event announces, or `null` when it carries none.
 *
 * Read off the event's OWN top-level `agent_id`, never off `sender.agent_id`:
 * the orchestrator emits this frame, so the sender IS the orchestrator. Every
 * other fold in this package keys an agent off the sender, and copying that
 * pattern here silently attributes every workspace to the orchestrator —
 * `WorkspaceTabsComponent.resolveMembers` falls back to rendering a raw id it
 * cannot name, so the mistake ships as one plausible-looking wrong chip per
 * workspace instead of an error.
 */
export function attachedAgentId(msg: ResourceAttached): string | null {
  const agentId: unknown = msg.agent_id;
  if (typeof agentId !== 'string' || agentId === '') return null;
  return agentId;
}

/** Deterministic per-descriptor label (UI nicety, finalised in Story 23-3). */
function labelFor(workspaceId: string, isDefault: boolean): string {
  return isDefault ? 'Default workspace' : workspaceId;
}

/**
 * Build the descriptor list from the set of workspaces ever announced plus the
 * CURRENT per-workspace membership.
 *
 * There is NO always-present default: a workspace exists only because an attach
 * event announced its resolved path. A team whose orchestrator has attached
 * nothing yields an EMPTY list. (Supersedes ADR-019 §Decision 3 / FR6.)
 *
 * Workspaces are STICKY: once announced they remain listed even after their
 * members are fired (`seen` is monotonic) — the operator keeps browsing access.
 * `agentIds` reflects only the CURRENTLY-bound agents, so a workspace whose
 * members have all stopped renders with an empty member list.
 *
 * `members` is keyed by WORKSPACE (leaf → agent ids), which is the orientation
 * the attach event delivers directly: one frame names one workspace and one
 * agent. The previous card-shape fold arrived at the inverse (agent → leaves)
 * because it resolved a card's declarations per agent, and had to be transposed
 * here. Nothing about the emitted descriptor changed.
 */
function buildDescriptors(
  seen: Set<string>,
  members: Map<string, Set<string>>,
  teamId: string,
): WorkspaceDescriptor[] {
  const membersById = new Map<string, Set<string>>();
  for (const id of seen) membersById.set(id, new Set<string>());
  for (const [workspaceId, agents] of members) {
    const bucket = membersById.get(workspaceId) ?? new Set<string>();
    for (const agentId of agents) bucket.add(agentId);
    membersById.set(workspaceId, bucket);
  }
  return [...membersById.entries()]
    .map(([workspaceId, agents]) => {
      const isDefault = workspaceId === teamId;
      return {
        workspaceId,
        isDefault,
        agentIds: [...agents].sort(),
        label: labelFor(workspaceId, isDefault),
      };
    })
    // Deterministic order: the default workspace first, then named workspaces
    // alphabetically by label (stable across re-folds → OnPush-safe).
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
}

/**
 * Pure ordered fold over the message log → the deduped set of workspaces in a
 * team (ADR-019 §Decision 1/2, mirror of `presenceReduce`).
 *
 * Two pieces of state, down from three:
 * - `seen` — every leaf a `ResourceAttached` announced. MONOTONIC: a
 *   `StopMessage` never removes a workspace, so a discovered workspace stays
 *   browsable after its members are fired.
 * - `members` — leaf → the agents CURRENTLY bound to it. An attach event ADDS
 *   its own `agent_id`; a `StopMessage` removes its `sender.agent_id` from
 *   EVERY workspace.
 *
 * The asymmetry is deliberate and is a property of the protocol, not an
 * oversight: the add is keyed by a TOP-LEVEL field on the attach event (whose
 * sender is the orchestrator), the remove by `sender.agent_id` on a different
 * message. ADR-022 §Decision 8 states there is no detach event, and this package
 * must not invent one.
 *
 * No ordering care is needed between the two sources. Core emits one attach
 * event per successful forward INCLUDING a cache hit, so two agents binding one
 * workspace produce two events and one descriptor, and an event that arrives
 * before the binding agent's own `StartMessage` still lands its membership —
 * `resolveMembers` renders the raw id until the identity map catches up.
 *
 * Exported at module scope so tests assert it directly without a `TestBed`.
 */
export function workspaceRegistryReduce(
  log: AkgenticMessage[],
  teamId: string,
): WorkspaceDescriptor[] {
  const seen = new Set<string>();
  const members = new Map<string, Set<string>>();
  for (const m of log) {
    if (isResourceAttached(m)) {
      const leaf = attachedLeaf(m);
      if (leaf === null) continue;
      seen.add(leaf);
      const agentId = attachedAgentId(m);
      if (agentId === null) continue;
      const bucket = members.get(leaf) ?? new Set<string>();
      bucket.add(agentId);
      members.set(leaf, bucket);
    } else if (isStopMessage(m)) {
      // Drop the agent's membership everywhere but KEEP every workspace.
      const agentId = m.sender?.agent_id;
      if (agentId === undefined) continue;
      for (const agents of members.values()) agents.delete(agentId);
    }
  }
  return buildDescriptors(seen, members, teamId);
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
 * the deduped set of `WorkspaceDescriptor`s discovered by folding the
 * orchestrator's `ResourceAttached` events. Set-valued sibling of
 * `ToolPresenceService`.
 *
 * Scope: component-scoped (NOT `providedIn: 'root'`) because it injects
 * `MessageLogService`, which is component-scoped on `ProcessComponent`. A team
 * switch destroys the component (and the log), so the registry shares that
 * lifecycle and never leaks workspaces across teams.
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
