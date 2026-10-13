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
  BaseMessage,
  isEventMessage,
  isHandledMessage,
  isProcessedMessage,
  isSentMessage,
  isStopMessage,
  isToolCallEvent,
  isToolReturnEvent,
  isWorkspaceAttached,
  parseToolCallArguments,
  SentMessage,
  ToolCallEvent,
  WorkspaceToolArguments,
} from '../../../protocol/message.types';
import { MessageLogService } from '../event/message-log.service';
import {
  attachedAgentId,
  attachedLeaf,
} from './workspace-registry.selector';

/**
 * The nine workspace tools that CHANGE the tree (Epic 39 / ADR-031 §D2), written
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
 * - A new mutating tool added upstream must fail LOUDLY (nothing invalidates
 *   until this list grows) rather than be silently covered by a pattern that
 *   nobody re-reads.
 *
 * `workspace_exec` / `workspace_exec_result` (Story 61-2) are the exec rule:
 * the paths a run changed are known only to the backend, so a successful return
 * refreshes the whole tree. A "still running" return refreshes too; telling it
 * apart would mean parsing the result text. Interim: the exec rule, and the
 * slash-command rule below, are to be deleted in favour of one backend
 * workspace-changed signal on the forgettable event class
 * (`_bmad-output/akgentic-infra/research/ephemeral-signals-and-event-stream-growth.md`).
 */
export const MUTATING_WORKSPACE_TOOLS = [
  'workspace_write',
  'workspace_delete',
  'workspace_edit',
  'workspace_mkdir',
  'workspace_rmdir',
  'workspace_multi_edit',
  'workspace_patch',
  'workspace_exec',
  'workspace_exec_result',
] as const;

/** One of the nine names in `MUTATING_WORKSPACE_TOOLS`. */
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
    case 'workspace_exec':
    case 'workspace_exec_result':
      return { ...none, wholeTree: true };
    case 'workspace_mkdir':
      return { ...none, directories: [parentDirectory(args.path)] };
    case 'workspace_delete':
    case 'workspace_rmdir':
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
  workspaceIds: Set<string>,
): void {
  if (!isMutatingWorkspaceTool(event.tool_name)) return;
  const args = parseToolCallArguments(event);
  if (args === null) return;
  inFlight.set(event.tool_call_id, { workspaceIds: [...workspaceIds], args });
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
 * (ADR-031 §D4): it is bound to a `Set` of leaves and every workspace exposes
 * identical `workspace_*` tool names, so the tool name cannot disambiguate.
 * Correct, merely coarser. An agent for which no attach envelope arrived yields
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

// ---------------------------------------------------------------------------
// The slash-command rule (Story 61-2).
//
// A human `/workspace_…` command is an ordinary message: the stream carries it
// as a `SentMessage` to the agent, the agent dispatches it inside its handler,
// and core then emits `ProcessedMessage{message_id}` from that agent on EVERY
// outcome — success, refusal, a command that returns nothing, an exception. So
// the command is remembered by its message id, and that `ProcessedMessage`
// refreshes the agent's whole tree. No argument is parsed: there is no
// shell-quoting parser in TypeScript (ADR-031 §D3 reasoning), and whether the
// command succeeded is not checked — a refused command refreshing is harmless.
//
// A command queued while its agent is busy can instead be absorbed into the
// running turn through the mailbox. akgentic-agent dispatches commands only from
// its `AgentMessage` handler, so an absorbed command is handed to the model as
// text and never executed: core closes it with `HandledMessage`, not
// `ProcessedMessage`, and the entry is dropped there without a refresh.
//
// Interim, inferred from a human message's text. To be deleted, not extended,
// once the backend emits a workspace-changed signal on the forgettable event
// class (`_bmad-output/akgentic-infra/research/ephemeral-signals-and-event-stream-growth.md`).
// ---------------------------------------------------------------------------

/** The six slash commands that change the tree, written out as literals. The
 *  read-side ones (`/workspace_read`, `list`, `glob`, `grep`, `rag_search`)
 *  change nothing and are deliberately absent. */
export const MUTATING_SLASH_COMMANDS = [
  '/workspace_write',
  '/workspace_delete',
  '/workspace_mkdir',
  '/workspace_rmdir',
  '/workspace_exec',
  '/workspace_exec_result',
] as const;

/**
 * Upper bound on remembered commands per subscription. A command whose
 * `ProcessedMessage` never arrives (an agent that dies mid-handler without a
 * `StopMessage`) must not grow the map forever; past the cap the oldest entry
 * is dropped, which at worst costs one missed refresh.
 */
export const MAX_PENDING_COMMANDS = 64;

/** True when `content`, leading whitespace trimmed, starts with a mutating
 *  command name followed by whitespace or the end of the string — so
 *  `/workspace_writer` does not match. Never throws on a non-string. */
export function isMutatingSlashCommand(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  const text = content.trimStart();
  return MUTATING_SLASH_COMMANDS.some(
    (name) =>
      text.startsWith(name) &&
      (text.length === name.length || /\s/.test(text.charAt(name.length))),
  );
}

/** A mutating command awaiting its `ProcessedMessage`. The workspaces are read
 *  at send time, as a tool call's are read at call time. */
interface PendingCommand {
  agentId: string;
  workspaceIds: string[];
}

/** Remember a mutating command sent to an agent bound to a workspace, or
 *  ignore the frame. Every field is reached defensively: it arrives off the
 *  wire inside a live subscription. */
function rememberCommand(
  pending: Map<string, PendingCommand>,
  sent: SentMessage,
  attribution: Map<string, Set<string>>,
): void {
  const inner: Partial<BaseMessage> | null | undefined = sent.message;
  const messageId = inner?.id;
  const agentId = sent.recipient?.agent_id;
  if (typeof messageId !== 'string' || typeof agentId !== 'string') return;
  if (!isMutatingSlashCommand(inner?.content)) return;
  const workspaceIds = attribution.get(agentId);
  if (workspaceIds === undefined || workspaceIds.size === 0) return;
  pending.set(messageId, { agentId, workspaceIds: [...workspaceIds] });
  if (pending.size > MAX_PENDING_COMMANDS) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }
}

/** Resolve a `ProcessedMessage` into one whole-tree instruction per workspace
 *  of the command's agent, and consume the entry. An unknown id emits nothing. */
function resolveCommand(
  pending: Map<string, PendingCommand>,
  messageId: string,
): WorkspaceInvalidation[] {
  const entry = pending.get(messageId);
  if (entry === undefined) return [];
  pending.delete(messageId);
  return entry.workspaceIds.map((workspaceId) => ({
    workspaceId,
    wholeTree: true,
    directories: [],
    files: [],
    deletions: [],
  }));
}

/** Drop every command remembered for an agent that stopped. */
function forgetAgentCommands(
  pending: Map<string, PendingCommand>,
  agentId: string,
): void {
  for (const [messageId, entry] of pending) {
    if (entry.agentId === agentId) pending.delete(messageId);
  }
}

/**
 * Everything ONE subscription holds between messages, and the whole of this
 * unit's memory: no workspace cache, no "last invalidated at" stamp, no dirty
 * flag, no cursor and no announced-so-far count.
 *
 * - `attribution` — agent id → the workspace leaves that agent is bound to, the
 *   SAME resolution the picker's *Accessible by* chips render, taken from the
 *   same source rather than encoded a second time. A `WorkspaceAttached`
 *   payload inside an `EventMessage` ADDS a leaf under the PAYLOAD's own
 *   `agent_id`; a `StopMessage` deletes the agent's whole entry, keyed by
 *   `sender.agent_id`. Read at CALL time, never at return time, so a
 *   `StopMessage` landing between a call and its return cannot retroactively
 *   erase the instruction (ADR-031 §D4). Reading at call time is safe with no
 *   ordering care: the resource actor must exist before it can serve a call,
 *   and the orchestrator emits the attach envelope as it forwards the
 *   get-or-create, so the binding always precedes the call.
 * - `inFlight` — the mutating calls still awaiting a return, keyed by
 *   `tool_call_id`. The return frame names no path, so everything an
 *   instruction needs is captured here from the call frame.
 * - `pendingCommands` — the mutating slash commands still awaiting their
 *   `ProcessedMessage`, keyed by the command's message id (Story 61-2). An entry
 *   is dropped by its `HandledMessage`, bounded by `MAX_PENDING_COMMANDS`, and
 *   emptied per agent on its `StopMessage`.
 */
interface InvalidationState {
  attribution: Map<string, Set<string>>;
  inFlight: Map<string, InFlightCall>;
  pendingCommands: Map<string, PendingCommand>;
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
 * guards — `isWorkspaceAttached` included — accept `null`/`undefined`,
 * `attachedLeaf` type-checks the attach payload's `workspace_path` before
 * splitting it, and the argument parser returns `null` rather than raising.
 * Those reads matter MORE here than they did under a fold: a fold that threw
 * spoiled one emission's derivation, whereas a throw out of a live
 * subscription tears the subscription down for good and nothing re-subscribes.
 * Nothing dereferences `StartMessage.config` any more, so the one
 * frame that could previously still raise — a `StartMessage` carrying no
 * `config` at all — no longer reaches a dereference on this path.
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
    if (isStopMessage(m)) {
      state.attribution.delete(agentId);
      forgetAgentCommands(state.pendingCommands, agentId);
      continue;
    }
    if (isSentMessage(m)) {
      rememberCommand(state.pendingCommands, m, state.attribution);
      continue;
    }
    if (isProcessedMessage(m)) {
      instructions.push(...resolveCommand(state.pendingCommands, m.message_id));
      continue;
    }
    if (isHandledMessage(m)) {
      // Absorbed mid-run, so never executed as a command: forget, no refresh.
      state.pendingCommands.delete(m.message_id);
      continue;
    }
    if (!isEventMessage(m)) continue;
    // The guards key on the INNER `__model__`: an `EventMessage` envelope tag
    // contains none of 'WorkspaceAttached', 'ToolCallEvent' or
    // 'ToolReturnEvent'. Binding the payload to the guards' loose parameter
    // type keeps `EventMessage.event`'s `any` from propagating into this
    // module. Each envelope is handled by exactly ONE branch.
    const inner: { __model__?: string } | null | undefined = m.event;
    if (isWorkspaceAttached(inner)) {
      // The BINDING agent is the payload's `agent_id`. `agentId` above is the
      // envelope sender — the ORCHESTRATOR here — and this payload is the one
      // exception to the sender-keyed rule every other branch follows: using
      // it would attribute every mutation to the orchestrator.
      const leaf = attachedLeaf(inner);
      const boundAgentId = attachedAgentId(inner);
      if (leaf !== null && boundAgentId !== null) {
        const bucket = state.attribution.get(boundAgentId) ?? new Set<string>();
        bucket.add(leaf);
        state.attribution.set(boundAgentId, bucket);
      }
      continue;
    }
    if (isToolCallEvent(inner)) {
      recordCall(
        state.inFlight,
        inner,
        state.attribution.get(agentId) ?? new Set<string>(),
      );
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
 * subscription is invisible to it — the `WorkspaceAttached` envelopes that
 * carry the agent→workspace attribution above all. That is the PRODUCTION
 * ordering, not an artefact of tests: a workspace tab only exists once an
 * attach envelope has announced it, and the explorer subscribes from its
 * constructor, so the attribution always predates the subscription. Without
 * this, every live instruction would resolve to no workspace at all and
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
 * successfully, and for every mutating slash command its agent has since
 * processed (Story 61-2). `WorkspaceExplorerComponent` consumes it, one explorer per
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
 * emission, not the derivation that was deleted. It is what empties both maps
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
 * route-scoped `MessageLogService`. A root-scoped instance would outlive the
 * team switch that is supposed to empty it.
 */
@Injectable()
export class WorkspaceInvalidationService {
  private readonly log: MessageLogService = inject(MessageLogService);

  readonly invalidations$: Observable<WorkspaceInvalidation> = defer(() => {
    const state: InvalidationState = {
      attribution: new Map<string, Set<string>>(),
      inFlight: new Map<string, InFlightCall>(),
      pendingCommands: new Map<string, PendingCommand>(),
    };
    seedFrom(state, this.log.snapshot());

    // `reset()` is the only shrink the log has, and it emits on `log$` alone.
    // `ignoreElements` keeps this watch out of the value stream.
    const cleared$ = this.log.log$.pipe(
      filter((log) => log.length === 0),
      tap(() => {
        state.attribution.clear();
        state.inFlight.clear();
        state.pendingCommands.clear();
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
