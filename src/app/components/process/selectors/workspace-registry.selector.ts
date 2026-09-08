import { inject, Injectable } from '@angular/core';
import { distinctUntilChanged, map, Observable } from 'rxjs';

import {
  AkgenticMessage,
  isStartMessage,
  isStopMessage,
  isWorkspaceActorConfig,
  isWorkspaceTool,
  StartMessage,
} from '../../../protocol/message.types';
import { MessageLogService } from '../event/message-log.service';

/**
 * One discovered workspace in a team (Epic 23 / ADR-019 §Decision 1).
 *
 * `workspaceId` is the workspace's LEAF — the last segment of the path the
 * backend resolved, read off the `#Workspace` actor's own `StartMessage` for a
 * metadata workspace and named by the card itself for the other two layouts
 * (ADR-048 §Decision 8). It is what reaches `?workspace_id=`, byte-identical.
 * `isDefault` marks the team-default workspace; `agentIds` records every agent
 * whose `WorkspaceTool` currently joins this descriptor (deterministically
 * ordered for structural equality); `label` is a deterministic UI string
 * consumed by Story 23-3.
 */
export interface WorkspaceDescriptor {
  workspaceId: string;
  isDefault: boolean;
  agentIds: string[];
  label: string;
}

/**
 * A workspace as the BACKEND resolved it, read off the `#Workspace` actor's
 * `StartMessage` (ADR-048 §Decision 8).
 *
 * `leaf` is the last segment of `config.workspace_path`; `metadataKeys` are the
 * keys that produced it, in declaration order, and are `[]` on a named or
 * default workspace — and also on a metadata one until akgentic-tool 48-4 puts
 * `metadata_keys` on the wire, which is why an empty list must never join
 * anything.
 */
export interface WorkspaceIdentity {
  leaf: string;
  metadataKeys: string[];
}

/**
 * The identity a `#Workspace` actor's `StartMessage` announces, or `null` for
 * every other frame.
 *
 * This is the ONE place a workspace id enters this package from the wire, and
 * it is read rather than derived: the client holds a leaf it was given and
 * never computes `<scope>/<leaf>`. An empty last segment (a trailing `/`, or an
 * empty path) is not an id, so it yields `null` rather than an empty tab.
 *
 * `metadata_keys` is checked with `Array.isArray` and not merely `??`-defaulted:
 * the field is optional on the wire and its declared type is a promise this
 * module cannot enforce, and a non-array here would throw inside `listEquals` —
 * out of a live subscription, which tears that subscription down for good.
 */
export function workspaceIdentity(msg: StartMessage): WorkspaceIdentity | null {
  const config: unknown = msg.config;
  if (!isWorkspaceActorConfig(config)) return null;
  const segments = config.workspace_path.split('/');
  const leaf = segments[segments.length - 1];
  if (leaf === '') return null;
  const keys = config.metadata_keys;
  return { leaf, metadataKeys: Array.isArray(keys) ? keys : [] };
}

/**
 * What one `WorkspaceTool` card DECLARES, never a derived id (ADR-048
 * §Decision 2: three layouts, selected by two mutually exclusive card fields).
 *
 * A card cannot name a metadata workspace's leaf — only the backend knows the
 * encoding — so the card's declaration is carried as-is and resolved against
 * the identities discovered on the stream. `named` and `default` still name
 * their own leaf, and that is not the rule being deleted: for those two layouts
 * the card *is* the leaf.
 */
export type WorkspaceJoinKey =
  | { kind: 'named'; workspaceId: string }
  | { kind: 'default' }
  | { kind: 'metadata'; metadataKeys: string[] };

/** Deterministic per-descriptor label (UI nicety, finalised in Story 23-3). */
function labelFor(workspaceId: string, isDefault: boolean): string {
  return isDefault ? 'Default workspace' : workspaceId;
}

/**
 * Per-agent contribution: the join keys an agent's `WorkspaceTool`s declare
 * under its latest `StartMessage`. Keyed by `sender.agent_id`; a `StopMessage`
 * removes the agent's entry; a later `StartMessage` for the same agent replaces
 * it (last-wins).
 */
type Contributions = Map<string, WorkspaceJoinKey[]>;

/** The join keys declared by one `StartMessage`, in card order.
 *
 * The metadata branch comes FIRST because a metadata card carries
 * `workspace_id = null`: read the other way round it falls through to
 * `default`, which is exactly the bug this story exists to remove — every
 * metadata workspace collapsing into the team default. The two fields are
 * mutually exclusive on the card by a backend `model_validator`, so the order
 * only decides malformed input.
 *
 * NOT deduped: `resolveJoinKeys` returns a `Set`, so two identical cards on one
 * agent collapse there and a second dedupe step would be dead weight.
 *
 * Exported (Story 39-2) so `workspace-invalidation.selector.ts` attributes a
 * mutation to the same workspaces the *Accessible by* chips render, instead of
 * encoding the resolution a second time and drifting. It is the RULE that is
 * shared; the invalidation unit deliberately does not call
 * `workspaceRegistryReduce`, whose `agentIds` reflect only currently-active
 * contributors. (That unit no longer folds the log at all — it calls this per
 * `StartMessage` as the message arrives, Epic 42 / ADR-031 §D11 — which changes
 * nothing about why the two are kept apart.) */
export function startContribution(msg: StartMessage): WorkspaceJoinKey[] {
  const keys: WorkspaceJoinKey[] = [];
  for (const tool of msg.config.tools ?? []) {
    if (!isWorkspaceTool(tool)) continue;
    const metadataKeys = tool.workspace_metadata_keys;
    if (metadataKeys !== undefined && metadataKeys.length > 0) {
      keys.push({ kind: 'metadata', metadataKeys });
    } else if (tool.workspace_id !== null && tool.workspace_id !== undefined) {
      keys.push({ kind: 'named', workspaceId: tool.workspace_id });
    } else {
      keys.push({ kind: 'default' });
    }
  }
  return keys;
}

/** Plain element-wise list equality — NO `.sort()` on either side, ever.
 *
 * ADR-048 §Decision 3: the key list is an ordered refinement path, not a set.
 * `["customer_id","case_id"]` and `["case_id","customer_id"]` declare two
 * different scopes and address two different trees, so normalising them here
 * would join a card to a workspace it does not belong to — and sorting is the
 * kind of "helpful" step that has to be added on BOTH sides identically forever
 * or the join silently misses. Not sorting is what leaves nothing to drift. */
function listEquals(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * Resolve a card's declarations into workspace leaves, against the identities
 * discovered on the stream.
 *
 * `named` and `default` name their leaf directly. `metadata` joins by plain list
 * equality against `WorkspaceIdentity.metadataKeys` — every matching identity,
 * so two key sets in one team resolve to two workspaces with no
 * cross-contamination. A metadata card that matches no identity resolves to
 * NOTHING: no phantom id is invented for it, and in particular it never falls
 * back to the team id.
 *
 * An EMPTY key list is not a scope and joins nothing. It cannot arrive from
 * `startContribution`, which only emits `metadata` for a non-empty declaration
 * — but this function is exported, and `listEquals([], [])` is TRUE, so the
 * invariant is enforced HERE, where it is relied on, rather than one function
 * away. Without it an empty list joins every identity carrying no keys: every
 * named and default workspace (whose identities always carry `[]`), and every
 * metadata workspace until akgentic-tool 48-4 puts `metadata_keys` on the wire.
 */
export function resolveJoinKeys(
  keys: WorkspaceJoinKey[],
  identities: Map<string, WorkspaceIdentity>,
  teamId: string,
): Set<string> {
  const ids = new Set<string>();
  for (const key of keys) {
    if (key.kind === 'named') {
      ids.add(key.workspaceId);
    } else if (key.kind === 'default') {
      ids.add(teamId);
    } else if (key.metadataKeys.length > 0) {
      for (const identity of identities.values()) {
        if (listEquals(identity.metadataKeys, key.metadataKeys)) {
          ids.add(identity.leaf);
        }
      }
    }
  }
  return ids;
}

/**
 * Build the descriptor list from the set of workspaces ever discovered plus the
 * CURRENT per-agent membership (already resolved to leaves).
 *
 * There is NO always-present default: a workspace exists only because a card
 * named it (no `workspace_id` → team id, marked `isDefault`; a `workspace_id` →
 * that name) or because a `#Workspace` actor announced its resolved path. A
 * team with no `WorkspaceTool` at all yields an EMPTY list. (Supersedes
 * ADR-019 §Decision 3 / FR6.)
 *
 * Workspaces are STICKY: once discovered they remain listed even after their
 * members are fired (`seen` is monotonic) — the operator keeps browsing access.
 * `agentIds` reflects only the CURRENTLY-active contributors, so a workspace
 * whose members have all stopped renders with an empty member list — and so
 * does a metadata workspace whose cards cannot be joined yet.
 */
function buildDescriptors(
  seen: Set<string>,
  contributions: Map<string, Set<string>>,
  teamId: string,
): WorkspaceDescriptor[] {
  const membersById = new Map<string, Set<string>>();
  for (const id of seen) membersById.set(id, new Set<string>());
  for (const [agentId, ids] of contributions) {
    for (const id of ids) {
      (membersById.get(id) ?? new Set<string>()).add(agentId);
      membersById.set(id, membersById.get(id) as Set<string>);
    }
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
 * Three pieces of state:
 * - `identities` — every workspace a `#Workspace` actor announced, keyed by
 *   leaf. MONOTONIC, and the ONLY source of a metadata workspace's id.
 * - `seen` — every workspace ever discovered, from BOTH sources: the leaves
 *   `named`/`default` keys name directly, and every identity. MONOTONIC: a
 *   `StopMessage` never removes a workspace, so a discovered workspace stays
 *   browsable after its members are fired.
 * - `contributions` — each agent's CURRENT join keys (Start sets, Stop removes).
 *   Drives the per-workspace member list.
 *
 * `seen` deliberately reads BOTH sources rather than identities alone, which
 * would be the cleaner rule. ADR-048 §Decision 7b accepts that pre-rename
 * `WorkspaceConfig` events are skipped as corrupted on load, so a legacy team
 * announces no identity at all — and an identity-only `seen` would empty the
 * picker for named and default workspaces that render fine today.
 *
 * Join keys resolve against the FINAL identity map, after the fold, not
 * incrementally: a metadata card's agent `StartMessage` can arrive BEFORE the
 * `#Workspace` actor's, because the actor is created during the agent's
 * `on_start` bind while the agent's own `StartMessage` is emitted at the end of
 * its `__init__`.
 *
 * Ordered-reduce semantics are LOAD-BEARING for membership: a
 * `Start → Stop → Start` restart for one agent must resolve to *present* (last
 * Start wins) — so we track each agent's latest contribution and rebuild.
 *
 * Exported at module scope so tests assert it directly without a `TestBed`.
 */
export function workspaceRegistryReduce(
  log: AkgenticMessage[],
  teamId: string,
): WorkspaceDescriptor[] {
  const identities = new Map<string, WorkspaceIdentity>();
  const contributions: Contributions = new Map();
  const seen = new Set<string>();
  for (const m of log) {
    if (isStartMessage(m)) {
      const identity = workspaceIdentity(m);
      if (identity !== null) identities.set(identity.leaf, identity);
      const keys = startContribution(m);
      contributions.set(m.sender.agent_id, keys);
      for (const key of keys) {
        if (key.kind === 'named') seen.add(key.workspaceId);
        else if (key.kind === 'default') seen.add(teamId);
      }
    } else if (isStopMessage(m)) {
      // Drop the agent's membership but KEEP the workspace(s) in `seen`.
      contributions.delete(m.sender.agent_id);
    }
  }
  for (const leaf of identities.keys()) seen.add(leaf);
  const members = new Map<string, Set<string>>();
  for (const [agentId, keys] of contributions) {
    members.set(agentId, resolveJoinKeys(keys, identities, teamId));
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
