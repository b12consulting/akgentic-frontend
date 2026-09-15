import { inject, Injectable } from '@angular/core';
import {
  concatMap,
  defer,
  filter,
  ignoreElements,
  merge,
  Observable,
  tap,
} from 'rxjs';

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
 * `directories` and `files` are deduplicated and in first-seen order; all three
 * lists — `deletions` included — are empty when `wholeTree` is `true`, so a
 * consumer never has to reconcile a whole-tree refresh against named targets.
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
 * Everything ONE subscription holds between messages, and the whole of this
 * unit's memory: no workspace cache, no "last invalidated at" stamp, no dirty
 * flag, no cursor and no announced-so-far count.
 *
 * - `contributions` — the effective workspace ids each agent's `WorkspaceTool`s
 *   resolve to. A `StartMessage` sets an agent's entry (last-wins), a
 *   `StopMessage` deletes it. Read at CALL time and never at return time, so a
 *   `StopMessage` landing between a call and its return cannot retroactively
 *   erase the instruction (ADR-031 §D4).
 * - `inFlight` — the mutating calls still awaiting a return, keyed by
 *   `tool_call_id`. The return frame names no path, so everything an
 *   instruction needs is captured here from the call frame.
 */
interface InvalidationState {
  contributions: Map<string, Set<string>>;
  inFlight: Map<string, InFlightCall>;
}

/**
 * Absorb messages into one subscription's state and return the instructions
 * they COMPLETED — none, one, or several, in the order the messages arrived.
 *
 * It walks only the messages it is handed. On the live path that is exactly
 * what `appended$` just delivered, so a message is absorbed once and a call's
 * `arguments` string is parsed once, for the life of the subscription. Nothing
 * re-reads a message the log already delivered.
 *
 * No field it reads can throw: `__model__` and `sender` are both reached
 * defensively (`messageListFold` reaches `sender?.role` the same way), the inner
 * guards accept `null`/`undefined`, and the argument parser returns `null`
 * rather than raising. Those reads matter MORE here than they did under a fold:
 * a fold that threw spoiled one emission's derivation, whereas a throw out of a
 * live subscription tears the subscription down for good and nothing
 * re-subscribes. The one frame that could still raise is a `StartMessage`
 * carrying no `config` at all, which `startContribution` dereferences — shared
 * with `workspaceRegistryReduce`, and carried as a deferred finding rather than
 * hardened here.
 */
function absorb(
  state: InvalidationState,
  messages: AkgenticMessage[],
): WorkspaceInvalidation[] {
  const instructions: WorkspaceInvalidation[] = [];

  for (const m of messages) {
    if (!m.__model__) continue;
    // `sender` is typed as required but arrives off the wire. A frame without
    // one keys the empty agent id, which no well-formed frame ever claims.
    const agentId = m.sender?.agent_id ?? '';
    if (isStartMessage(m)) {
      state.contributions.set(agentId, startContribution(m));
      continue;
    }
    if (isStopMessage(m)) {
      state.contributions.delete(agentId);
      continue;
    }
    if (!isEventMessage(m)) continue;
    // The guards key on the INNER `__model__`: an `EventMessage` envelope tag
    // contains neither 'ToolCallEvent' nor 'ToolReturnEvent'. Binding the
    // payload to the guards' loose parameter type keeps `EventMessage.event`'s
    // `any` from propagating into this module.
    const inner: { __model__?: string } | null | undefined = m.event;
    if (isToolCallEvent(inner)) {
      recordCall(state.inFlight, inner, state.contributions.get(agentId));
    } else if (isToolReturnEvent(inner)) {
      instructions.push(
        ...resolveReturn(state.inFlight, inner.tool_call_id, inner.success),
      );
    }
  }
  return instructions;
}

/**
 * Absorb the log as it already stands, announcing nothing — run ONCE, when a
 * subscriber arrives.
 *
 * It is not the whole-log derivation this unit used to run: that walked the
 * entire log on EVERY emission and re-parsed every historical call's arguments,
 * file bodies included, for the life of the session. This walks what was there
 * at subscribe time and then never again.
 *
 * It cannot be dropped in favour of reading `appended$` alone. `appended$` is a
 * plain `Subject` with no replay buffer, so every message that predates the
 * subscription is invisible to it — the `StartMessage`s that carry the
 * agent→workspace attribution above all. That is the PRODUCTION ordering, not
 * an artefact of tests: a workspace tab only exists once a `StartMessage` has
 * announced the `WorkspaceTool` that created it, and the explorer subscribes
 * from its constructor, so the attribution always predates the subscription.
 * Without this, every live instruction would resolve to no workspace at all and
 * nothing would ever refresh.
 *
 * Discarding what it returns is the old baseline, and for the same reason:
 * opening the panel on a stopped team must not fire one listing per historical
 * mutation in its REST replay. The explorer's own initial tree load IS that
 * baseline read.
 */
function seedFrom(
  state: InvalidationState,
  log: AkgenticMessage[],
): void {
  absorb(state, log);
}

/**
 * WorkspaceInvalidationService — Epic 42 (ADR-031 §D11).
 *
 * Publishes `invalidations$`: one `WorkspaceInvalidation` at a time, in log
 * order, for every mutating workspace tool call that has since completed
 * successfully. `WorkspaceExplorerComponent` consumes it, one explorer per
 * workspace tab (Story 39-4).
 *
 * It READS `MessageLogService.appended$` — the messages that just entered the
 * log, post id-dedup — and HOLDS its in-flight calls, instead of re-deriving
 * them by folding the whole log on every emission and diffing the result
 * against a cursor. What that removes is structural, not a measured speed-up:
 * the whole-log walk per emission, the re-parse of every historical call's
 * arguments, and the cursor-and-baseline machinery that existed only to answer
 * "which of these are new?". Because a call is now parsed exactly once, there is
 * nothing left for a parse cache to save, and none is kept.
 *
 * It reaches `MessageLogService` and nothing else: no HTTP, no
 * `WorkspaceService`, no `ContextService`, no toast surface. It writes to
 * nothing outside itself.
 *
 * The state lives inside `defer`, PER SUBSCRIPTION. `WorkspaceTabsComponent`
 * renders one explorer per workspace against a single component-scoped
 * instance, so a single shared map would need multicasting — without it the
 * first subscriber's `delete` consumes the entry and every workspace tab but
 * one silently stops refreshing. Per-subscription state gives each explorer the
 * complete stream with no multicast, and keeps the unit inert until subscribed
 * (nothing in this layer subscribes in a constructor).
 *
 * `log$` is still watched, but ONLY for `reset()` — an O(1) length check per
 * emission, not the derivation that was deleted. It is what empties the two maps
 * on a team switch: `IngestionService.init()` runs several times per component
 * lifetime, the `ProcessComponent` and this service survive it, `reset()` emits
 * on `log$` and deliberately NOT on `appended$`, and a subscriber that watched
 * only `appended$` would carry the previous team's entries and attribution into
 * the next one. The whole-log fold got that for free by folding an empty array.
 *
 * Deliberately NOT `shareReplay`ed: a late subscriber must not receive a
 * replayed burst of invalidations for state it never rendered — the same class
 * of bug `appended$`'s plain `Subject` exists to avoid.
 *
 * Scope: component-scoped (NOT `providedIn: 'root'`) because it injects the
 * component-scoped `MessageLogService`. A root-scoped instance would outlive the
 * team switch that is supposed to empty it.
 */
@Injectable()
export class WorkspaceInvalidationService {
  private readonly log: MessageLogService = inject(MessageLogService);

  readonly invalidations$: Observable<WorkspaceInvalidation> = defer(() => {
    const state: InvalidationState = {
      contributions: new Map<string, Set<string>>(),
      inFlight: new Map<string, InFlightCall>(),
    };
    seedFrom(state, this.log.snapshot());

    // `reset()` is the only shrink the log has, and it emits on `log$` alone.
    // `ignoreElements` keeps this watch out of the value stream.
    const cleared$ = this.log.log$.pipe(
      filter((log) => log.length === 0),
      tap(() => {
        state.contributions.clear();
        state.inFlight.clear();
      }),
      ignoreElements(),
    );

    // `concatMap` over a plain ARRAY emits synchronously and in order, so one
    // batch carrying N completed mutations pushes its N instructions out before
    // `appendAll` returns. The explorer's microtask coalescing depends on that
    // literally — an asynchronous scheduler here turns one coalesced listing per
    // directory back into one listing per event, with every spec still green.
    const emitted$ = this.log.appended$.pipe(
      concatMap((batch) => absorb(state, batch)),
    );

    // `cleared$` is subscribed first, so `log$`'s current value is consumed
    // before the first batch can arrive. It is a no-op on an empty log and
    // filtered out on a non-empty one, so it never disturbs the seed above.
    return merge(cleared$, emitted$);
  });
}
