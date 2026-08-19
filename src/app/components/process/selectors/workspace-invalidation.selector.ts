import { inject, Injectable } from '@angular/core';
import { concatMap, map, Observable, scan } from 'rxjs';

import {
  AkgenticMessage,
  isEventMessage,
  isStartMessage,
  isStopMessage,
  isToolCallEvent,
  isToolReturnEvent,
  parseToolCallArguments,
  ToolCallEvent,
  WorkspaceToolArguments,
} from '../../../protocol/message.types';
import { MessageLogService } from '../event/message-log.service';
import { startContribution } from './workspace-registry.selector';

/**
 * The six workspace tools that CHANGE the tree (Epic 39 / ADR-031 §D2), written
 * out as literals.
 *
 * It is deliberately NOT derived — not from a `workspace_*` prefix, not from
 * `WorkspaceToolArguments`, and not as the complement of a read list:
 *
 * - `workspace_read` and `workspace_view` write `.`-prefixed sidecar cache files,
 *   so "read" does not mean "the tree is unchanged". A prefix match would refetch
 *   the tree on every file an agent reads — which is most of what agents do — and
 *   it would pass every other behaviour in this projection while failing only
 *   that one.
 * - A seventh mutating tool added upstream must fail LOUDLY (nothing invalidates
 *   until this list grows) rather than be silently covered by a pattern that
 *   nobody re-reads.
 */
export const MUTATING_WORKSPACE_TOOLS = [
  'workspace_write',
  'workspace_delete',
  'workspace_edit',
  'workspace_mkdir',
  'workspace_multi_edit',
  'workspace_patch',
] as const;

/** One of the six names in `MUTATING_WORKSPACE_TOOLS`. */
export type MutatingWorkspaceTool = (typeof MUTATING_WORKSPACE_TOOLS)[number];

/** Membership predicate for `MUTATING_WORKSPACE_TOOLS`. Every other tool name —
 *  the five workspace read tools included — is not a mutation here. */
export function isMutatingWorkspaceTool(
  toolName: string,
): toolName is MutatingWorkspaceTool {
  return (MUTATING_WORKSPACE_TOOLS as readonly string[]).includes(toolName);
}

/**
 * One instruction: what to re-read, and in which workspace (ADR-031 §D1/§D3).
 *
 * `directories` and `files` are deduplicated and in first-seen order; both are
 * empty when `wholeTree` is `true`.
 *
 * `deletions` is its OWN field rather than a flag on `files` because the two
 * carry opposite instructions: `files` means "changed, may need re-reading", and
 * re-reading a deleted path 404s. Dropping the path entirely would be worse
 * still — the preview pane would keep rendering a file that no longer exists.
 * A separate field cannot be misread as a re-read instruction. What the UI
 * *does* about a deleted open file is Story 39-4's routing decision; this
 * projection's job is to make sure the information survives to it intact.
 */
export interface WorkspaceInvalidation {
  workspaceId: string;
  wholeTree: boolean;
  directories: string[];
  files: string[];
  deletions: string[];
}

/**
 * The parent directory of a workspace-relative path: strip ONE trailing `/`,
 * then take everything before the last `/`, or `''` (the root listing) when
 * there is none.
 *
 * No normalisation, no joining, no `..` resolution: the path is re-used exactly
 * as the wire carried it, because the listing endpoint is addressed with the
 * same strings the backend emitted.
 */
function parentDirectory(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf('/');
  return cut === -1 ? '' : trimmed.slice(0, cut);
}

/** First-seen-order dedup. */
function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** The workspace-independent half of an instruction, derived from the parsed
 *  call arguments alone. */
type InvalidationTargets = Omit<WorkspaceInvalidation, 'workspaceId'>;

/**
 * Per-tool granularity (ADR-031 §D3).
 *
 * Directory rather than file granularity is deliberate: `workspace_write` and
 * `workspace_mkdir` create missing parents, so a listing *above* the named path
 * can go stale too.
 *
 * `workspace_patch` gets the blunt whole-tree treatment on purpose. Its paths
 * exist only inside the unified-diff text, and recovering them means
 * reproducing the backend's `--- a/<path>` scraping in TypeScript against a
 * format the backend is free to change. A duplicated diff parser that drifts
 * from the backend's is a worse artefact than a coarse refresh, so `patch_text`
 * is never read here.
 *
 * A fresh object (and fresh arrays) per call: one mutation by an agent mapping
 * to two workspaces yields two instructions that must not share array
 * references.
 */
function targetsFor(args: WorkspaceToolArguments): InvalidationTargets {
  const none = { wholeTree: false, directories: [], files: [], deletions: [] };
  switch (args.tool_name) {
    case 'workspace_patch':
      return { ...none, wholeTree: true };
    case 'workspace_mkdir':
      return { ...none, directories: [parentDirectory(args.path)] };
    case 'workspace_delete':
      return {
        ...none,
        directories: [parentDirectory(args.path)],
        deletions: [args.path],
      };
    case 'workspace_write':
    case 'workspace_edit':
      return {
        ...none,
        directories: [parentDirectory(args.path)],
        files: [args.path],
      };
    case 'workspace_multi_edit': {
      const paths = args.edits.map((edit) => edit.path);
      return {
        ...none,
        directories: dedupe(paths.map(parentDirectory)),
        files: dedupe(paths),
      };
    }
  }
}

/**
 * A mutating call awaiting its return. The RETURN event carries no path — only
 * `tool_call_id` and `success` — so everything the instruction needs is captured
 * here, at call time, from the frame that names both the agent and the paths.
 */
interface InFlightCall {
  workspaceIds: string[];
  args: WorkspaceToolArguments;
}

/** Record a mutating call, or ignore the frame. A non-mutating tool name and an
 *  unparseable body are both "no entry", so the later return finds nothing and
 *  emits nothing. `parseToolCallArguments` is the ONLY parser — it never throws,
 *  and no `JSON.parse` appears in this module. */
function recordCall(
  inFlight: Map<string, InFlightCall>,
  event: ToolCallEvent,
  workspaceIds: Set<string> | undefined,
): void {
  if (!isMutatingWorkspaceTool(event.tool_name)) return;
  const args = parseToolCallArguments(event);
  if (args === null) return;
  inFlight.set(event.tool_call_id, {
    workspaceIds: [...(workspaceIds ?? [])],
    args,
  });
}

/**
 * Resolve a finished call into zero or more instructions, and consume its entry
 * (ADR-031 §D8).
 *
 * The entry is dropped on ANY matching return, whatever the verdict: a replay of
 * the same frame therefore cannot re-fire, and a `false`-then-`true` pair fires
 * nothing — `success: false` is a retry prompt, not a mutation.
 *
 * An agent mapping to two workspaces yields two instructions, one per workspace
 * (ADR-031 §D4): `startContribution` returns a `Set` and both cards expose
 * identical `workspace_*` tool names, so the tool name cannot disambiguate.
 * Correct, merely coarser. An agent with no `WorkspaceTool` contribution yields
 * none, and no phantom workspace id is invented for it.
 */
function resolveReturn(
  inFlight: Map<string, InFlightCall>,
  toolCallId: string,
  success: boolean,
): WorkspaceInvalidation[] {
  const entry = inFlight.get(toolCallId);
  if (entry === undefined) return [];
  inFlight.delete(toolCallId);
  if (success !== true) return [];
  return entry.workspaceIds.map((workspaceId) => ({
    workspaceId,
    ...targetsFor(entry.args),
  }));
}

/**
 * Pure ordered fold over the message log → the cumulative list of workspace
 * invalidation instructions (Epic 39 / ADR-031 §D1).
 *
 * A projection, not a reactor, by ADR-025's test: it has to REMEMBER something.
 * The return event names no path, so a mutating call is held until its matching
 * return arrives.
 *
 * Three pieces of state, all derived from the log itself:
 * - the per-agent workspace contributions (a `StartMessage` sets, a `StopMessage`
 *   deletes) — read at CALL time, never at return time;
 * - the in-flight `tool_call_id → call` map, the ONLY memory this unit holds:
 *   no workspace cache, no "last invalidated at" stamp, no dirty flag;
 * - the ordered output list.
 *
 * The attribution is resolved at call time on purpose. Resolving it at the end
 * instead would make the fold prefix-UNSTABLE — a later `StopMessage` would
 * retroactively erase an already-emitted instruction — and the delta in
 * `WorkspaceInvalidationService` depends on the prefix never changing.
 *
 * Folding `log$` (and not `appended$`) is what makes the lifecycle free:
 * `reset()` re-emits `[]`, a fold over `[]` starts with an empty in-flight map,
 * and no per-store reset code exists anywhere.
 *
 * Nothing it touches can throw: the envelope is guarded before `event` is read,
 * the inner guards accept `null`/`undefined`, and the argument parser returns
 * `null` rather than raising. A fold that throws on one bad frame stops folding
 * for the rest of the session.
 *
 * Exported at module scope so specs assert it directly without a `TestBed`, the
 * same way `workspaceRegistryReduce` is exercised.
 */
export function workspaceInvalidationReduce(
  log: AkgenticMessage[],
): WorkspaceInvalidation[] {
  const contributions = new Map<string, Set<string>>();
  const inFlight = new Map<string, InFlightCall>();
  const instructions: WorkspaceInvalidation[] = [];

  for (const m of log) {
    if (!m.__model__) continue;
    if (isStartMessage(m)) {
      contributions.set(m.sender.agent_id, startContribution(m));
      continue;
    }
    if (isStopMessage(m)) {
      contributions.delete(m.sender.agent_id);
      continue;
    }
    if (!isEventMessage(m)) continue;
    // The guards key on the INNER `__model__`: an `EventMessage` envelope tag
    // contains neither 'ToolCallEvent' nor 'ToolReturnEvent'. Binding the
    // payload to the guards' loose parameter type keeps `EventMessage.event`'s
    // `any` from propagating into this module.
    const inner: { __model__?: string } | null | undefined = m.event;
    if (isToolCallEvent(inner)) {
      recordCall(inFlight, inner, contributions.get(m.sender.agent_id));
    } else if (isToolReturnEvent(inner)) {
      instructions.push(
        ...resolveReturn(inFlight, inner.tool_call_id, inner.success),
      );
    }
  }
  return instructions;
}

/** Rebasing state for the delta: how much of the cumulative fold has already
 *  been announced, whether a baseline has been taken, and the tail to emit. */
interface InvalidationDelta {
  cursor: number;
  seeded: boolean;
  delta: WorkspaceInvalidation[];
}

const INITIAL_DELTA: InvalidationDelta = {
  cursor: 0,
  seeded: false,
  delta: [],
};

/**
 * Emit only what was appended since the previous emission.
 *
 * Sound because the log is append-or-reset only and the fold is prefix-stable,
 * so a longer cumulative list always shares its prefix with the previous one.
 * A SHORTER list means `reset()` — rebase the cursor to zero and announce
 * nothing.
 *
 * The FIRST emission a subscriber receives establishes the baseline and
 * announces nothing. For a live team the explorer mounts against an empty log,
 * so nothing is lost — and the explorer's own initial tree load IS that
 * baseline read. Without it, opening the panel on a stopped team would fire one
 * listing per historical mutation in its REST replay.
 */
function rebase(
  state: InvalidationDelta,
  all: WorkspaceInvalidation[],
): InvalidationDelta {
  const grew = state.seeded && all.length > state.cursor;
  return {
    cursor: all.length,
    seeded: true,
    delta: grew ? all.slice(state.cursor) : [],
  };
}

/**
 * WorkspaceInvalidationService — Story 39-2 (ADR-031 §D1).
 *
 * Publishes `invalidations$`: one `WorkspaceInvalidation` at a time, in log
 * order, for every mutating workspace tool call that has since completed
 * successfully. Nothing subscribes to it yet — the explorer wiring is Story
 * 39-4, exactly as `WorkspaceRegistryService` deferred its own wiring to Story
 * 23-3.
 *
 * It is a PROJECTION over `MessageLogService.log$` and nothing else: no HTTP, no
 * `WorkspaceService`, no `ContextService`, no toast surface. It writes to
 * nothing outside itself.
 *
 * Scope: component-scoped (NOT `providedIn: 'root'`) because it injects the
 * component-scoped `MessageLogService`. A root-scoped projection would outlive
 * the team switch that is supposed to empty it.
 *
 * Deliberately NOT `shareReplay`ed: a late subscriber must not receive a
 * replayed burst of invalidations for state it never rendered — the same class
 * of bug `appended$`'s plain `Subject` exists to avoid. The rebasing state lives
 * inside the operator chain, per subscription, so there is no cursor field on
 * this class.
 */
@Injectable()
export class WorkspaceInvalidationService {
  private readonly log: MessageLogService = inject(MessageLogService);

  readonly invalidations$: Observable<WorkspaceInvalidation> =
    this.log.log$.pipe(
      map(workspaceInvalidationReduce),
      scan(rebase, INITIAL_DELTA),
      concatMap((state) => state.delta),
    );
}
