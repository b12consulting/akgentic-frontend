import { inject, Injectable } from '@angular/core';
import { map, Observable, shareReplay } from 'rxjs';

import { HUMAN_ROLE } from './actor-kind';
import { ENTRY_POINT_NAME } from './chat-message.model';
import {
  ActorAddress,
  AkgenticMessage,
  EventMessage,
  HandledMessage,
  isEventMessage,
  isHandledMessage,
  isProcessedMessage,
  isReceivedMessage,
  isSentMessage,
  isToolCallEvent,
  isToolReturnEvent,
  ProcessedMessage,
  ReceivedMessage,
  SentMessage,
  ToolCallEvent,
  ToolReturnEvent,
} from '../../../protocol/message.types';
import { MessageLogService } from '../event/message-log.service';

/**
 * The run graph (Epic 55, ADR-037 §D1): the log folded into the runs it
 * describes, each keyed by `(message_id, agent_id)` and parented through
 * `parent_id`.
 *
 * The tree is already on the wire. `Message.init()` stamps `parent_id` with the
 * id of the message the emitting agent is handling, on every `SentMessage`,
 * `EventMessage` and `HandledMessage` it emits, and a run's id IS the id of the
 * message it handles. So every event names its run by key and nothing here
 * searches for "the agent's currently open run".
 *
 * Two id spaces meet on the log and only one of them is used: the INNER
 * `BaseMessage.id`. A `SentMessage` envelope's own `id` names nothing a run or a
 * `parent_id` ever refers to; keying on it leaves every child an orphan, which
 * renders as a flat list rather than failing (Trap 1).
 *
 * The message id alone is not a run key either: `Team.send` delivers one
 * message instance to every supervisor, so one id can open several runs.
 */

/** Opaque run key. Build it with `runKey`, never by hand. */
export type RunKey = string;

/** A UUID never contains `|`, so the pair cannot collide. */
export function runKey(messageId: string, agentId: string): RunKey {
  return `${messageId}|${agentId}`;
}

/** One thing a run did, in log order. */
export type RunStep =
  | { kind: 'received'; at: Date }
  | {
      kind: 'tool';
      at: Date;
      tool_call_id: string;
      tool_name: string;
      done: boolean;
      success: boolean | null;
    }
  | { kind: 'absorbed'; at: Date; message_id: string }
  | { kind: 'sent'; at: Date; message_id: string; recipient: ActorAddress }
  | { kind: 'processed'; at: Date };

export interface Run {
  key: RunKey;
  /** The trigger's inner id. */
  message_id: string;
  /** The agent handling it (`ReceivedMessage.sender`). */
  agent: ActorAddress;
  /** Always `=== message_id`; kept as the ADR names it. */
  trigger_id: string;
  /** `(trigger.parent_id, trigger.sender.agent_id)`; `null` when unresolvable.
   *  May name a key absent from `runs` — the helpers treat that as unresolved. */
  parent_key: RunKey | null;
  start: Date;
  end: Date | null;
  steps: readonly RunStep[];
  /** Stored lifecycle only. A human seat's `waiting | answered` is read through
   *  `runStatus`, because `answered` is decided by a `sent` step that lands
   *  after the seat's run has already closed. */
  status: 'running' | 'done';
}

export interface RunMessage {
  /** Inner `BaseMessage.id`. */
  id: string;
  /** `SentMessage.sender` (the outer one, as `classifyMessage` reads it). */
  sender: ActorAddress;
  recipient: ActorAddress;
  /** Inner `message.parent_id`. */
  parent_id: string | null;
  /** The envelope timestamp: send time. */
  timestamp: Date;
  content: string | null;
  absorbed_by: RunKey | null;
}

export interface RunGraph {
  messages: ReadonlyMap<string, RunMessage>;
  /** Insertion order is start order. */
  runs: ReadonlyMap<RunKey, Run>;
}

/** A fresh empty graph. The fold starts from its own, so a caller that casts
 *  `EMPTY_RUN_GRAPH` and writes into its maps cannot reach a later fold. */
export function emptyRunGraph(): RunGraph {
  return { messages: new Map(), runs: new Map() };
}

/** A placeholder for a view that has not received a graph yet. Never a fold's
 *  seed (see `emptyRunGraph`). */
export const EMPTY_RUN_GRAPH: RunGraph = Object.freeze(emptyRunGraph());

export type RunStatus = 'running' | 'done' | 'waiting' | 'answered';

export interface MessageChip {
  recipient: ActorAddress;
  count: number;
}

// ---------------------------------------------------------------------------
// Copy-on-write primitives. Only the touched map is copied.
// ---------------------------------------------------------------------------

function withRun(graph: RunGraph, run: Run): RunGraph {
  const runs = new Map(graph.runs);
  runs.set(run.key, run);
  return { ...graph, runs };
}

function withMessage(graph: RunGraph, message: RunMessage): RunGraph {
  const messages = new Map(graph.messages);
  messages.set(message.id, message);
  return { ...graph, messages };
}

function appendStep(run: Run, step: RunStep): Run {
  return { ...run, steps: [...run.steps, step] };
}

function runOf(
  graph: RunGraph,
  messageId: string | null | undefined,
  agentId: string | undefined,
): Run | undefined {
  if (!messageId || !agentId) return undefined;
  return graph.runs.get(runKey(messageId, agentId));
}

/** The run's parent key, read from its RECORDED trigger — never from the
 *  `ReceivedMessage`'s own `parent_id`, which is the run's own trigger id
 *  (`on_receive` sets `_current_message` before it notifies). `null` for an
 *  unknown trigger (a replay that starts mid-conversation) or a root send. */
function parentKeyOf(graph: RunGraph, messageId: string): RunKey | null {
  const trigger = graph.messages.get(messageId);
  if (!trigger?.parent_id || !trigger.sender?.agent_id) return null;
  return runKey(trigger.parent_id, trigger.sender.agent_id);
}

// ---------------------------------------------------------------------------
// Transitions. Each returns `graph` itself when its target is unknown.
// ---------------------------------------------------------------------------

/** Record the inner message (first record wins: one inner id can be sent to
 *  several supervisors) and append a `sent` step to the sending run. */
function applySent(graph: RunGraph, msg: SentMessage): RunGraph {
  const inner = msg.message;
  const senderId = msg.sender?.agent_id;
  if (!inner?.id || !senderId || !msg.recipient) return graph;
  const at = new Date(msg.timestamp);
  let next = graph;
  if (!graph.messages.has(inner.id)) {
    next = withMessage(graph, {
      id: inner.id,
      sender: msg.sender,
      recipient: msg.recipient,
      parent_id: inner.parent_id ?? null,
      timestamp: at,
      content: inner.content ?? null,
      absorbed_by: null,
    });
  }
  const run = runOf(next, inner.parent_id, senderId);
  if (run === undefined) return next;
  return withRun(
    next,
    appendStep(run, {
      kind: 'sent',
      at,
      message_id: inner.id,
      recipient: msg.recipient,
    }),
  );
}

/** Open run `(message_id, sender)`. A duplicate for an open key never resets
 *  the run. */
function applyReceived(graph: RunGraph, msg: ReceivedMessage): RunGraph {
  const agent = msg.sender;
  if (!agent?.agent_id || !msg.message_id) return graph;
  const key = runKey(msg.message_id, agent.agent_id);
  if (graph.runs.has(key)) return graph;
  const at = new Date(msg.timestamp);
  return withRun(graph, {
    key,
    message_id: msg.message_id,
    agent,
    trigger_id: msg.message_id,
    parent_key: parentKeyOf(graph, msg.message_id),
    start: at,
    end: null,
    steps: [{ kind: 'received', at }],
    status: 'running',
  });
}

/** Close run `(message_id, sender)`. The error path emits the same event, so a
 *  failed run closes like any other. */
function applyProcessed(graph: RunGraph, msg: ProcessedMessage): RunGraph {
  const run = runOf(graph, msg.message_id, msg.sender?.agent_id);
  if (run === undefined || run.status === 'done') return graph;
  const at = new Date(msg.timestamp);
  return withRun(graph, {
    ...appendStep(run, { kind: 'processed', at }),
    status: 'done',
    end: at,
  });
}

/** A message pulled into a running run (`consume_mailbox`). A join, not a
 *  re-parent: the message keeps its place and the absorbing run gains a step.
 *  The inner message's class is never read, so a cancel is ordinary (Trap 4). */
function applyHandled(graph: RunGraph, msg: HandledMessage): RunGraph {
  const run = runOf(graph, msg.parent_id, msg.sender?.agent_id);
  const absorbed = msg.message_id
    ? graph.messages.get(msg.message_id)
    : undefined;
  if (run === undefined || absorbed === undefined) return graph;
  const next = withMessage(graph, { ...absorbed, absorbed_by: run.key });
  return withRun(
    next,
    appendStep(run, {
      kind: 'absorbed',
      at: new Date(msg.timestamp),
      message_id: absorbed.id,
    }),
  );
}

function applyToolCall(
  graph: RunGraph,
  msg: EventMessage,
  event: ToolCallEvent,
): RunGraph {
  const run = runOf(graph, msg.parent_id, msg.sender?.agent_id);
  if (run === undefined) return graph;
  return withRun(
    graph,
    appendStep(run, {
      kind: 'tool',
      at: new Date(msg.timestamp),
      tool_call_id: event.tool_call_id,
      tool_name: event.tool_name,
      done: false,
      success: null,
    }),
  );
}

/** A return names its run by key, so one landing after `ProcessedMessage`
 *  still marks its step on the closed run (Trap 2). */
function applyToolReturn(
  graph: RunGraph,
  msg: EventMessage,
  event: ToolReturnEvent,
): RunGraph {
  const run = runOf(graph, msg.parent_id, msg.sender?.agent_id);
  if (run === undefined) return graph;
  const idx = run.steps.findIndex(
    (s) => s.kind === 'tool' && s.tool_call_id === event.tool_call_id,
  );
  if (idx < 0) return graph;
  const step = run.steps[idx];
  if (step.kind !== 'tool') return graph;
  const steps = [...run.steps];
  // A frame without `success` is "not reported", never `undefined`.
  steps[idx] = { ...step, done: true, success: event.success ?? null };
  return withRun(graph, { ...run, steps });
}

function applyEvent(graph: RunGraph, msg: EventMessage): RunGraph {
  const inner: { __model__?: string } | null | undefined = msg.event;
  if (isToolCallEvent(inner)) return applyToolCall(graph, msg, inner);
  if (isToolReturnEvent(inner)) return applyToolReturn(graph, msg, inner);
  return graph;
}

/** Pure per-message transition. Returns `graph` itself for every other
 *  message type and for every transition whose target is unknown. Never
 *  throws: a throw inside `map(runGraphFold)` would end `graph$` for the rest
 *  of the session. */
export function runGraphStep(graph: RunGraph, msg: AkgenticMessage): RunGraph {
  if (!msg?.__model__) return graph;
  if (isSentMessage(msg)) return applySent(graph, msg);
  if (isProcessedMessage(msg)) return applyProcessed(graph, msg);
  if (isReceivedMessage(msg)) return applyReceived(graph, msg);
  if (isHandledMessage(msg)) return applyHandled(graph, msg);
  if (isEventMessage(msg)) return applyEvent(graph, msg);
  return graph;
}

/** Pure fold over the full log: no timers, no `Date.now()`, no DOM.
 *  `new Date(msg.timestamp)` is deterministic given the log. */
export function runGraphFold(log: AkgenticMessage[]): RunGraph {
  return log.reduce(runGraphStep, emptyRunGraph());
}

// ---------------------------------------------------------------------------
// The per-graph index. A graph is never written after it is built (every
// transition copies), so an index cached on the graph object cannot go stale,
// and each emission pays for it once rather than once per message or link.
// ---------------------------------------------------------------------------

interface RunIndex {
  byMessage: ReadonlyMap<string, readonly Run[]>;
  children: ReadonlyMap<RunKey, readonly RunKey[]>;
}

const INDEX = new WeakMap<RunGraph, RunIndex>();

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function runIndex(graph: RunGraph): RunIndex {
  const cached = INDEX.get(graph);
  if (cached !== undefined) return cached;
  const byMessage = new Map<string, Run[]>();
  const children = new Map<RunKey, RunKey[]>();
  for (const run of graph.runs.values()) {
    push(byMessage, run.message_id, run);
    if (run.parent_key !== null && graph.runs.has(run.parent_key)) {
      push(children, run.parent_key, run.key);
    }
  }
  const index = { byMessage, children };
  INDEX.set(graph, index);
  return index;
}

/** Every run `messageId` triggered, one per recipient, in start order. */
export function runsOf(graph: RunGraph, messageId: string): readonly Run[] {
  return runIndex(graph).byMessage.get(messageId) ?? [];
}

/** The runs whose resolved parent is `key`, in start order. */
export function childKeys(graph: RunGraph, key: RunKey): readonly RunKey[] {
  return runIndex(graph).children.get(key) ?? [];
}

// ---------------------------------------------------------------------------
// Derived helpers. All pure; all take the graph explicitly.
// ---------------------------------------------------------------------------

function resolvedParent(graph: RunGraph, run: Run): Run | undefined {
  return run.parent_key === null ? undefined : graph.runs.get(run.parent_key);
}

/** Parent first, root last, excluding `key`. Stops at a `null` or unresolved
 *  parent; a visited set guards against a cycle. */
export function ancestors(graph: RunGraph, key: RunKey): RunKey[] {
  const out: RunKey[] = [];
  const visited = new Set<RunKey>([key]);
  let run = graph.runs.get(key);
  while (run !== undefined) {
    const parent = resolvedParent(graph, run);
    if (parent === undefined || visited.has(parent.key)) break;
    visited.add(parent.key);
    out.push(parent.key);
    run = parent;
  }
  return out;
}

/** Every run whose ancestor chain contains `key`, in `runs` insertion order,
 *  excluding `key`. The child index is the graph's, built once, so a view
 *  calling this per card or per link stays linear in the subtree. */
export function descendants(graph: RunGraph, key: RunKey): RunKey[] {
  // The visited set is the cycle guard; the queue only ever grows.
  const found = new Set<RunKey>([key]);
  const queue = [key];
  for (let i = 0; i < queue.length; i++) {
    for (const child of childKeys(graph, queue[i])) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  if (found.size === 1) return [];
  return [...graph.runs.keys()].filter((k) => k !== key && found.has(k));
}

export function isHumanSeat(run: Run): boolean {
  return run.agent.role === HUMAN_ROLE && run.agent.name !== ENTRY_POINT_NAME;
}

/**
 * Whether `run` opens a trace: its trigger was written by a Human-ROLE sender
 * (never the `@Human` name — Send-as and multi-human teams, Trap 3), UNLESS it
 * is a human seat answering the question put to it. A seat is answered inside
 * the tree (ADR-037 §D4), so its reply continues the asker's trace rather than
 * starting one; the entry point's reply to a question (case 4) is not a seat
 * run and does open its own.
 */
function opensTrace(graph: RunGraph, run: Run, parent: Run | undefined): boolean {
  const trigger = graph.messages.get(run.message_id);
  if (trigger?.sender?.role !== HUMAN_ROLE) return false;
  return parent === undefined || !isHumanSeat(parent);
}

/** Walk up from `key` to the run that opens its trace. Fail-open: a run whose
 *  parent is `null` or unresolved is its own root (ADR-037 §D3). */
export function traceRootOf(graph: RunGraph, key: RunKey): RunKey {
  const visited = new Set<RunKey>();
  let current = key;
  let run = graph.runs.get(key);
  while (run !== undefined && !visited.has(run.key)) {
    visited.add(run.key);
    current = run.key;
    const parent = resolvedParent(graph, run);
    if (parent === undefined || opensTrace(graph, run, parent)) return current;
    run = parent;
  }
  return current;
}

function absorbedAt(graph: RunGraph, messageId: string): Date | null {
  const key = graph.messages.get(messageId)?.absorbed_by;
  const run = key ? graph.runs.get(key) : undefined;
  const step = run?.steps.find(
    (s) => s.kind === 'absorbed' && s.message_id === messageId,
  );
  return step?.at ?? null;
}

/** When a recipient first took the message up: the earliest start among its
 *  runs, else the moment a running run absorbed it, else `null`. */
export function pickedUpAt(graph: RunGraph, messageId: string): Date | null {
  let earliest: Date | null = null;
  for (const run of runsOf(graph, messageId)) {
    if (earliest === null || run.start.getTime() < earliest.getTime()) {
      earliest = run.start;
    }
  }
  return earliest ?? absorbedAt(graph, messageId);
}

/** The run's `sent` steps grouped by recipient, in first-send order. */
export function messageChips(graph: RunGraph, key: RunKey): MessageChip[] {
  const chips = new Map<string, MessageChip>();
  for (const step of graph.runs.get(key)?.steps ?? []) {
    if (step.kind !== 'sent') continue;
    const id = step.recipient.agent_id;
    const chip = chips.get(id);
    chips.set(
      id,
      chip ? { ...chip, count: chip.count + 1 } : { recipient: step.recipient, count: 1 },
    );
  }
  return [...chips.values()];
}

/** Done having sent nothing. Human-role runs (the entry point, a seat) are
 *  never silent: a seat that has not answered yet is `waiting`. */
export function silent(graph: RunGraph, key: RunKey): boolean {
  const run = graph.runs.get(key);
  if (run === undefined || run.status !== 'done') return false;
  if (run.agent.role === HUMAN_ROLE) return false;
  return !run.steps.some((s) => s.kind === 'sent');
}

/** A seat's run closes at once, so its status is read from its steps: it is
 *  `answered` once the seat has sent a reply parented on it. Every other run
 *  reports its stored status. `null` for an unknown key. */
export function runStatus(graph: RunGraph, key: RunKey): RunStatus | null {
  const run = graph.runs.get(key);
  if (run === undefined) return null;
  if (!isHumanSeat(run)) return run.status;
  return run.steps.some((s) => s.kind === 'sent') ? 'answered' : 'waiting';
}

/**
 * RunGraphService — Epic 55 (ADR-037 §D10). A projection over
 * `MessageLogService.log$`, in the shape of `ChatService.chat$`: it re-folds
 * the whole log on each emission and holds no state of its own.
 */
@Injectable()
export class RunGraphService {
  private readonly log: MessageLogService = inject(MessageLogService);

  readonly graph$: Observable<RunGraph> = this.log.log$.pipe(
    map(runGraphFold),
    shareReplay(1),
  );
}
