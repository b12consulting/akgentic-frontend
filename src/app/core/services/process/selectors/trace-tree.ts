import { ActorAddress } from '../../../protocol/message.types';
import { HUMAN_ROLE } from './actor-kind';
import { ENTRY_POINT_NAME } from './chat-message.model';
import {
  ancestors,
  childKeys,
  isHumanSeat,
  MessageChip,
  messageChips,
  Run,
  RunGraph,
  RunKey,
  runKey,
  RunMessage,
  RunStatus,
  runStatus,
  RunStep,
  silent,
  traceRootOf,
} from './run-graph.selector';
import { isEntryPointRun, waitingSeats } from './trace-summary';

/**
 * The run tree an open trace card draws (Epic 55, ADR-037 §D2, §D5, §D7), as
 * data.
 *
 * A run's children are produced by its OWN steps, in step order: each `sent`
 * step becomes the run it triggered, a leaf for a message nobody has taken up
 * (`queued`) or that a running run took in (`absorbed`), or the `@Human` row for
 * a message to you; each `absorbed` step becomes a dashed join row. So a join
 * shows on both sides (§D2): a leaf under the sender, a row in the absorber.
 *
 * Pure: no i18n, no clock. Durations that tick are the component's.
 */

export type JoinPhrase = 'yours' | 'answer' | 'reply';

export interface ToolChip {
  name: string;
  count: number;
  /** A separate chip per name for the calls that failed (`success === false`). */
  failed: boolean;
}

export interface TraceRunNode {
  kind: 'run';
  key: RunKey;
  run: Run;
  /** `undefined` on a replay that starts mid-conversation. */
  trigger: RunMessage | undefined;
  status: RunStatus;
  seat: boolean;
  silent: boolean;
  toolChips: ToolChip[];
  tookIn: number;
  liveTool: string | null;
  messageChips: MessageChip[];
  answeredAfterMs: number | null;
  children: TraceTreeChild[];
}

/** A message to you: drawn, never descended into (case 4). */
export interface TraceHumanRow {
  kind: 'human';
  messageId: string;
  from: ActorAddress;
  /** The entry point. */
  to: ActorAddress;
  excerpt: string;
}

export interface TraceQueuedLeaf {
  kind: 'queued';
  messageId: string;
  recipient: ActorAddress;
}

export interface TraceAbsorbedLeaf {
  kind: 'absorbed';
  messageId: string;
  recipient: ActorAddress;
  by: ActorAddress;
}

export interface TraceJoinRow {
  kind: 'join';
  messageId: string;
  /** The run that took the message in. */
  into: RunKey;
  from: ActorAddress;
  phrase: JoinPhrase;
}

export type TraceTreeChild =
  | TraceRunNode
  | TraceHumanRow
  | TraceQueuedLeaf
  | TraceAbsorbedLeaf
  | TraceJoinRow;

/** The `@for` key: a run by its key, anything else by kind and message id —
 *  never by index (Trap 7). One message id can go to several recipients and be
 *  taken in by several runs, and the rows are flattened over the whole tree, so
 *  a leaf also names its recipient and a join its absorbing run. */
export function trackTraceChild(child: TraceTreeChild): string {
  switch (child.kind) {
    case 'run':
      return child.key;
    case 'queued':
    case 'absorbed':
      return `${child.kind}:${child.messageId}:${child.recipient.agent_id}`;
    case 'join':
      return `join:${child.messageId}:${child.into}`;
    case 'human':
      return `human:${child.messageId}`;
  }
}

// ---------------------------------------------------------------------------
// Per-run helpers
// ---------------------------------------------------------------------------

/** Tool calls grouped by name in first-appearance order; a failed call goes
 *  into its own group for that name. */
export function toolChips(run: Run): ToolChip[] {
  const chips = new Map<string, ToolChip>();
  for (const step of run.steps) {
    if (step.kind !== 'tool') continue;
    const failed = step.success === false;
    const id = `${failed ? '✕' : ''}${step.tool_name}`;
    const chip = chips.get(id);
    chips.set(
      id,
      chip ? { ...chip, count: chip.count + 1 } : { name: step.tool_name, count: 1, failed },
    );
  }
  return [...chips.values()];
}

/** How many messages the run took in while it was going. */
export function tookInCount(run: Run): number {
  return run.steps.filter((s) => s.kind === 'absorbed').length;
}

/** While the run is `running` and its last step is a tool call, that tool's
 *  name; otherwise `null` (the view says "thinking…"). */
export function liveTool(run: Run): string | null {
  if (run.status !== 'running') return null;
  const last: RunStep | undefined = run.steps[run.steps.length - 1];
  return last?.kind === 'tool' ? last.tool_name : null;
}

/** Whitespace collapsed, trimmed, cut at 140 characters — code points, so an
 *  emoji at the cut is never split in half. CSS draws the visual ellipsis. */
export function excerpt(content: string | null | undefined): string {
  return Array.from((content ?? '').replace(/\s+/g, ' ').trim())
    .slice(0, 140)
    .join('');
}

/** A seat's reply time: its first `sent` step, less its start, in ms. */
export function answeredAfter(run: Run): number | null {
  const first = run.steps.find((s) => s.kind === 'sent');
  return first === undefined ? null : first.at.getTime() - run.start.getTime();
}

/** The runs to expand so every waiting seat of the trace is visible: the
 *  ancestors of each seat up to and including `root`, the seat excluded. */
export function seatRevealKeys(graph: RunGraph, root: RunKey): RunKey[] {
  const out = new Set<RunKey>();
  for (const seat of waitingSeats(graph, root)) {
    const chain = ancestors(graph, seat.key);
    const at = chain.indexOf(root);
    if (at < 0) continue;
    for (const key of chain.slice(0, at + 1)) out.add(key);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

function isEntryPoint(address: ActorAddress): boolean {
  return address.role === HUMAN_ROLE && address.name === ENTRY_POINT_NAME;
}

/** `yours` for a message you wrote, `answer` for a seat's answer, `reply`
 *  otherwise — `isYourMessage`'s rule, read from the graph. */
function joinPhrase(graph: RunGraph, message: RunMessage): JoinPhrase {
  if (message.sender.role !== HUMAN_ROLE) return 'reply';
  if (message.parent_id === null) return 'yours';
  const parent = graph.runs.get(runKey(message.parent_id, message.sender.agent_id));
  return parent !== undefined && isHumanSeat(parent) ? 'answer' : 'yours';
}

interface Walk {
  graph: RunGraph;
  root: RunKey;
  /** Runs already drawn: the cycle guard, and what the defensive pass skips. */
  drawn: Set<RunKey>;
}

function sentChild(
  walk: Walk,
  run: Run,
  step: Extract<RunStep, { kind: 'sent' }>,
): TraceTreeChild | null {
  const { graph, root } = walk;
  const message = graph.messages.get(step.message_id);
  if (isEntryPoint(step.recipient)) {
    return {
      kind: 'human',
      messageId: step.message_id,
      from: run.agent,
      to: step.recipient,
      excerpt: excerpt(message?.content),
    };
  }
  const key = runKey(step.message_id, step.recipient.agent_id);
  const child = graph.runs.get(key);
  if (child !== undefined) {
    // A run that opens a trace of its own is drawn in that trace's card.
    if (walk.drawn.has(key) || traceRootOf(graph, key) !== root) return null;
    return nodeOf(walk, child);
  }
  const absorber = message?.absorbed_by ? graph.runs.get(message.absorbed_by) : undefined;
  if (absorber !== undefined) {
    return {
      kind: 'absorbed',
      messageId: step.message_id,
      recipient: step.recipient,
      by: absorber.agent,
    };
  }
  return { kind: 'queued', messageId: step.message_id, recipient: step.recipient };
}

function joinChild(walk: Walk, run: Run, messageId: string): TraceJoinRow | null {
  const message = walk.graph.messages.get(messageId);
  if (message === undefined) return null;
  return {
    kind: 'join',
    messageId,
    into: run.key,
    from: message.sender,
    phrase: joinPhrase(walk.graph, message),
  };
}

/** Fail-open: a child run no `sent` step produced (a missing frame) still
 *  hangs under its parent, after the step-produced children. */
function strayChildren(walk: Walk, run: Run): TraceRunNode[] {
  const out: TraceRunNode[] = [];
  for (const key of childKeys(walk.graph, run.key)) {
    const child = walk.graph.runs.get(key);
    if (child === undefined || walk.drawn.has(key) || isEntryPointRun(child)) continue;
    if (traceRootOf(walk.graph, key) !== walk.root) continue;
    out.push(nodeOf(walk, child));
  }
  return out;
}

function childrenOf(walk: Walk, run: Run): TraceTreeChild[] {
  const out: TraceTreeChild[] = [];
  for (const step of run.steps) {
    const child =
      step.kind === 'sent'
        ? sentChild(walk, run, step)
        : step.kind === 'absorbed'
          ? joinChild(walk, run, step.message_id)
          : null;
    if (child !== null) out.push(child);
  }
  return [...out, ...strayChildren(walk, run)];
}

function nodeOf(walk: Walk, run: Run): TraceRunNode {
  walk.drawn.add(run.key);
  const { graph } = walk;
  const seat = isHumanSeat(run);
  return {
    kind: 'run',
    key: run.key,
    run,
    trigger: graph.messages.get(run.message_id),
    status: runStatus(graph, run.key) ?? run.status,
    seat,
    silent: silent(graph, run.key),
    toolChips: toolChips(run),
    tookIn: tookInCount(run),
    liveTool: liveTool(run),
    messageChips: messageChips(graph, run.key),
    answeredAfterMs: seat ? answeredAfter(run) : null,
    children: childrenOf(walk, run),
  };
}

/** The tree of the trace rooted at `root`, or `null` for an unknown root or
 *  an entry-point run (never a node). */
export function buildTraceTree(graph: RunGraph, root: RunKey): TraceRunNode | null {
  const run = graph.runs.get(root);
  if (run === undefined || isEntryPointRun(run)) return null;
  return nodeOf({ graph, root, drawn: new Set() }, run);
}
