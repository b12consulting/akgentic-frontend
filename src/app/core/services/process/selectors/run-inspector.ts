import {
  ActorAddress,
  AkgenticMessage,
  isEventMessage,
  isHandledMessage,
  isProcessedMessage,
  isReceivedMessage,
  isSentMessage,
  isToolCallEvent,
  isToolReturnEvent,
} from '../../../protocol/message.types';
import {
  ancestors,
  childKeys,
  isHumanSeat,
  Run,
  RunGraph,
  RunKey,
  runKey,
  RunMessage,
  runStatus,
  silent,
  traceRootOf,
} from './run-graph.selector';
import { describeStep } from './step-narration';
import { isEntryPointRun, traceDuration } from './trace-summary';
import { excerpt, isEntryPoint, tookInCount } from './trace-tree';

/**
 * The inspector's Run tab (Epic 55, ADR-037 §D9), as data.
 *
 * Pure: no i18n, no clock. The tab never ticks — only the transcript's tree
 * does — so a running run reads `running` with no elapsed time, and every
 * offset here is measured between two log timestamps.
 */

export type RunPill = 'running' | 'done' | 'doneSilent' | 'waiting' | 'answered';

export type RunStepRow =
  | { kind: 'received'; offset: string }
  | {
      kind: 'tool';
      offset: string;
      name: string;
      state: 'ok' | 'failed' | 'pending';
      /** What it was called with, one line; `''` for a call with no
       *  arguments. */
      summary: string;
    }
  | { kind: 'absorbed'; offset: string; from: ActorAddress | null; excerpt: string }
  | { kind: 'sent'; offset: string; to: ActorAddress }
  | { kind: 'processed'; offset: string };

/** A message the run took in while it was going (ADR-037 §D2): an input of
 *  the run beside its trigger, shown whole in the Handling section. */
export interface AbsorbedInput {
  message: RunMessage;
  /** When the run read it, offset from the run's start as a step is. */
  offset: string;
}

/** What a run did that is not a run of its own: a message still waiting for
 *  its recipient, one another run took in, or messages it took in itself. */
export type MiniLeaf =
  | { kind: 'queued'; recipient: ActorAddress }
  | { kind: 'absorbed'; recipient: ActorAddress; by: ActorAddress; byKey: RunKey }
  | { kind: 'tookIn'; count: number };

/** One run of the mini-tree, in pre-order, with its indentation. */
export interface MiniTreeRow {
  key: RunKey;
  run: Run;
  depth: number;
  /** `entry`: the entry point receiving a message — drawn, never selectable. */
  kind: 'agent' | 'seat' | 'entry';
  /** On the chain from the tree's top to the displayed run, both included. */
  onPath: boolean;
  displayed: boolean;
  childCount: number;
  /** The run's status mark: running, waiting, silent — or none. */
  pill: RunPill | null;
  /** The trigger's id, cut as the Event log cuts it. */
  shortId: string;
  leaves: MiniLeaf[];
  /** The subtree below this run, entry-point runs excluded: what a fold hides. */
  foldedRuns: number;
  /** That subtree's agents, distinct by `agent_id`, in start order. */
  foldedAgents: ActorAddress[];
  /** Something in that subtree is still running. */
  foldedLive: boolean;
}

/** The message the tree's top run handles: who sent it to whom, and its id. */
export interface MiniTreeRoot {
  from: ActorAddress;
  /** The sender is the entry point: drawn as "you". */
  fromYou: boolean;
  to: ActorAddress;
  shortId: string;
}

/** The 8-character id prefix the Event log shows. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

export type LedgerScope = 'run' | 'team';

/** One raw line of the log, language-neutral on purpose: it is the ledger. */
export interface LedgerLine {
  /** Log position — the `@for` key. */
  index: number;
  at: Date;
  kind: string;
  sender: string;
  detail: string;
  /** The line belongs to the displayed run. */
  own: boolean;
}

// ---------------------------------------------------------------------------
// The run on display
// ---------------------------------------------------------------------------

/** The latest-started run passing `accept`, entry-point runs never included.
 *  `runs` insertion order is start order, so the last match is the latest. */
function latestRun(graph: RunGraph, accept: (run: Run) => boolean): Run | null {
  let latest: Run | null = null;
  for (const run of graph.runs.values()) {
    if (!isEntryPointRun(run) && accept(run)) latest = run;
  }
  return latest;
}

/** The selected run; with none selected, the latest running run, else the
 *  latest run. Never writes a selection — the fallback is only displayed. */
export function displayedRun(graph: RunGraph, selected: RunKey | null): Run | null {
  const chosen = selected === null ? undefined : graph.runs.get(selected);
  if (chosen !== undefined) return chosen;
  return latestRun(graph, (run) => run.status === 'running') ?? latestRun(graph, () => true);
}

/** A seat reads `waiting` / `answered`; every other run `running`, `done`, or
 *  `doneSilent` when it ended having sent nothing. `null` for an unknown key. */
export function runPill(graph: RunGraph, key: RunKey): RunPill | null {
  const status = runStatus(graph, key);
  switch (status) {
    case null:
      return null;
    case 'waiting':
    case 'answered':
    case 'running':
      return status;
    case 'done':
      return silent(graph, key) ? 'doneSilent' : 'done';
  }
}

/** A step's offset from its run's start, as the Steps timeline prints it —
 *  the one format, so an absorbed input's offset reads as its step's does. */
function stepOffset(run: Run, step: { at: Date }): string {
  return `+${traceDuration(run.start, step.at) ?? ''}`;
}

/** The run's steps in step order, each offset from the run's start. A tool
 *  with no verdict yet is `pending`; a verdict of `null` is not a failure. */
export function runSteps(graph: RunGraph, run: Run): RunStepRow[] {
  return run.steps.map((step): RunStepRow => {
    const offset = stepOffset(run, step);
    switch (step.kind) {
      case 'received':
      case 'processed':
        return { kind: step.kind, offset };
      case 'tool':
        return {
          kind: 'tool',
          offset,
          name: step.tool_name,
          state: step.success === false ? 'failed' : step.done ? 'ok' : 'pending',
          // The step narration's summary of the call, so a step reads the same
          // wherever it is described.
          summary: describeStep({
            tool_name: step.tool_name,
            arguments_preview: step.arguments_preview,
            kind: 'tool',
          }).detail,
        };
      case 'absorbed': {
        const message = graph.messages.get(step.message_id);
        return {
          kind: 'absorbed',
          offset,
          from: message?.sender ?? null,
          excerpt: excerpt(message?.content),
        };
      }
      case 'sent':
        return { kind: 'sent', offset, to: step.recipient };
    }
  });
}

/** The messages the run took in, in step order, each at the offset the run
 *  read it. The fold records an `absorbed` step only for a message it holds
 *  (a `HandledMessage` for one it never saw is dropped there), so the lookup
 *  cannot miss; the guard narrows the type, it is not a case of its own. */
export function absorbedInputs(graph: RunGraph, run: Run): AbsorbedInput[] {
  const out: AbsorbedInput[] = [];
  for (const step of run.steps) {
    if (step.kind !== 'absorbed') continue;
    const message = graph.messages.get(step.message_id);
    if (message === undefined) continue;
    out.push({ message, offset: stepOffset(run, step) });
  }
  return out;
}

/** The ancestors of `key` within its trace, root included, plus `key`: what a
 *  selection expands in the transcript (ADR-037 §D6). `[key]` when unknown. */
export function revealKeysFor(graph: RunGraph, key: RunKey): RunKey[] {
  const root = traceRootOf(graph, key);
  const chain = ancestors(graph, key);
  const at = chain.indexOf(root);
  return [...(at < 0 ? [] : chain.slice(0, at + 1)), key];
}

// ---------------------------------------------------------------------------
// Where this run sits
// ---------------------------------------------------------------------------

function kindOf(run: Run): MiniTreeRow['kind'] {
  if (isEntryPointRun(run)) return 'entry';
  return isHumanSeat(run) ? 'seat' : 'agent';
}

/** Pre-order walk from `top` through resolved children, in start order. It
 *  crosses entry-point runs, so a trace continued from your reply stays in the
 *  tree that asked you (case 4). A visited set guards against a cycle. */
function walk(
  graph: RunGraph,
  top: RunKey,
  path: ReadonlySet<RunKey>,
  key: RunKey,
): MiniTreeRow[] {
  const rows: MiniTreeRow[] = [];
  const seen = new Set<RunKey>();
  const stack: { key: RunKey; depth: number }[] = [{ key: top, depth: 0 }];
  while (stack.length > 0) {
    const next = stack.pop()!;
    const run = graph.runs.get(next.key);
    if (run === undefined || seen.has(next.key)) continue;
    seen.add(next.key);
    const children = childKeys(graph, next.key).filter((k) => !seen.has(k));
    rows.push({
      key: next.key,
      run,
      depth: next.depth,
      kind: kindOf(run),
      onPath: path.has(next.key),
      displayed: next.key === key,
      childCount: children.length,
      pill: runPill(graph, next.key),
      shortId: shortId(run.message_id),
      leaves: leavesOf(graph, run),
      foldedRuns: 0,
      foldedAgents: [],
      foldedLive: false,
    });
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ key: children[i], depth: next.depth + 1 });
    }
  }
  return rows;
}

/** Fill each row's fold summary from the rows below it, in one reverse pass. */
function withFoldSummaries(rows: MiniTreeRow[]): MiniTreeRow[] {
  const below = rows.map((): Run[] => []);
  // In pre-order a row's parent is the latest row open one level up.
  const open: number[] = [];
  const parentOf = rows.map((row, i) => {
    const parent = row.depth > 0 ? open[row.depth - 1] : -1;
    open.length = row.depth;
    open.push(i);
    return parent;
  });
  for (let i = rows.length - 1; i > 0; i--) {
    const p = parentOf[i];
    if (p < 0) continue;
    if (rows[i].kind !== 'entry') below[p].push(rows[i].run);
    below[p].push(...below[i]);
  }
  return rows.map((row, i) => {
    const runs = [...below[i]].sort((a, b) => a.start.getTime() - b.start.getTime());
    const agents = new Map<string, ActorAddress>();
    for (const run of runs) {
      if (!agents.has(run.agent.agent_id)) agents.set(run.agent.agent_id, run.agent);
    }
    return {
      ...row,
      foldedRuns: runs.length,
      foldedAgents: [...agents.values()],
      foldedLive: runs.some((run) => run.status === 'running'),
    };
  });
}

/** A run's leaves: each message it sent that opened no run — still queued,
 *  or taken in by another run — then how many it took in. Messages to the
 *  entry point are not leaves: their runs, when they exist, are rows. */
function leavesOf(graph: RunGraph, run: Run): MiniLeaf[] {
  const leaves: MiniLeaf[] = [];
  for (const step of run.steps) {
    if (step.kind !== 'sent' || isEntryPoint(step.recipient)) continue;
    if (graph.runs.has(runKey(step.message_id, step.recipient.agent_id))) continue;
    const absorbedBy = graph.messages.get(step.message_id)?.absorbed_by;
    const by = absorbedBy ? graph.runs.get(absorbedBy) : undefined;
    leaves.push(
      by === undefined
        ? { kind: 'queued', recipient: step.recipient }
        : { kind: 'absorbed', recipient: step.recipient, by: by.agent, byKey: by.key },
    );
  }
  const count = tookInCount(run);
  if (count > 0) leaves.push({ kind: 'tookIn', count });
  return leaves;
}

/** The trigger of the tree's top run, or `null` when it is not in the log. */
export function miniTreeRoot(graph: RunGraph, rows: readonly MiniTreeRow[]): MiniTreeRoot | null {
  const top = rows[0];
  const trigger = top === undefined ? undefined : graph.messages.get(top.run.message_id);
  if (top === undefined || trigger === undefined) return null;
  return {
    from: trigger.sender,
    fromYou: isEntryPoint(trigger.sender),
    to: top.run.agent,
    shortId: shortId(top.run.message_id),
  };
}

/**
 * The connected tree that holds `key`, from its topmost ancestor reachable
 * through `parent_key` — not a forest of every trace. The path is the FULL
 * chain, not cut at the trace root. `[]` for an unknown key.
 */
export function buildMiniTree(graph: RunGraph, key: RunKey): MiniTreeRow[] {
  if (!graph.runs.has(key)) return [];
  const chain = ancestors(graph, key);
  const top = chain.length > 0 ? chain[chain.length - 1] : key;
  return withFoldSummaries(walk(graph, top, new Set([...chain, key]), key));
}

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

/**
 * Whether a log line is the run's own. Keyed on the INNER id and the agent
 * together (Trap 1): one message delivered to two supervisors opens two runs,
 * and they must not share lines.
 */
export function belongsToRun(msg: AkgenticMessage, run: Run): boolean {
  const mid = run.message_id;
  const aid = run.agent.agent_id;
  if (isSentMessage(msg)) {
    const sentByRun = msg.sender?.agent_id === aid && msg.message?.parent_id === mid;
    const trigger = msg.message?.id === mid && msg.recipient?.agent_id === aid;
    return sentByRun || trigger;
  }
  if (isReceivedMessage(msg) || isProcessedMessage(msg)) {
    return msg.message_id === mid && msg.sender?.agent_id === aid;
  }
  return msg.parent_id === mid && msg.sender?.agent_id === aid;
}

function modelName(model: string | undefined): string {
  const name = model ?? '';
  return name.slice(name.lastIndexOf('.') + 1);
}

function eventDetail(event: { __model__?: string } | null | undefined): string {
  if (isToolCallEvent(event)) return event.tool_name;
  if (isToolReturnEvent(event)) return `${event.tool_name} ${event.success === false ? '✕' : '✓'}`;
  return '';
}

function ledgerLine(msg: AkgenticMessage, index: number, own: boolean): LedgerLine {
  const line = { index, at: new Date(msg.timestamp), sender: msg.sender?.name ?? '', own };
  if (isSentMessage(msg)) {
    const text = Array.from(excerpt(msg.message?.content)).slice(0, 80).join('');
    return { ...line, kind: 'SentMessage', detail: `→ ${msg.recipient?.name ?? ''} · ${text}` };
  }
  if (isReceivedMessage(msg) || isProcessedMessage(msg)) {
    return { ...line, kind: modelName(msg.__model__), detail: msg.message_id.slice(0, 8) };
  }
  if (isHandledMessage(msg)) {
    return { ...line, kind: 'HandledMessage', detail: `took in ${msg.message_id.slice(0, 8)}` };
  }
  if (isEventMessage(msg)) {
    const event: { __model__?: string } | null | undefined = msg.event;
    return { ...line, kind: modelName(event?.__model__), detail: eventDetail(event) };
  }
  return { ...line, kind: modelName(msg.__model__), detail: '' };
}

/** `run`: the run's own lines. `team`: every line, the run's own marked. */
export function ledgerLines(
  log: readonly AkgenticMessage[],
  run: Run,
  scope: LedgerScope,
): LedgerLine[] {
  const out: LedgerLine[] = [];
  log.forEach((msg, index) => {
    const own = belongsToRun(msg, run);
    if (own || scope === 'team') out.push(ledgerLine(msg, index, own));
  });
  return out;
}
