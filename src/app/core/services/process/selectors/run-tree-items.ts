import { inject, Injectable } from '@angular/core';
import { map, Observable, shareReplay, zip } from 'rxjs';

import { ActorAddress } from '../../../protocol/message.types';
import { HUMAN_ROLE } from './actor-kind';
import { ChatMessage } from './chat-message.model';
import { ChatService } from './chat.selector';
import { DaySeparator, daySeparatorsFor } from './day-separator';
import {
  ancestors,
  isHumanSeat,
  pickedUpAt,
  Run,
  RunGraph,
  RunGraphService,
  RunKey,
  runKey,
  traceRootOf,
} from './run-graph.selector';
import { isEntryPointRun, traceRuns } from './trace-summary';

/**
 * The run-tree transcript's display list (Epic 55, ADR-037 §D3, §D10).
 *
 * Three parts, built from one `ChatMessage[]` and one `RunGraph` of the SAME
 * log emission:
 *
 * - the **timeline**, sorted by position time: pick-up time for your messages,
 *   send time for everything else, with one `trace` item after each message of
 *   yours per run it opened, and day separators spliced in;
 * - the **tail**: your messages no agent has taken up yet, in send order. Not
 *   part of the sort, and given no day separator.
 *
 * Rules 3 and 4 (agent → another seat, agent ↔ agent) are not rows here; they
 * live only in the tree (§D4). The one exception is a Send-as message, which
 * the legacy fold calls rule 4 but which opens a trace, so it is yours.
 */

/** Why an agent → you bubble exists: the run that sent it, and where that run
 *  sits in its trace (§D8). */
export interface Provenance {
  run: RunKey;
  root: RunKey;
  /** The agent whose run sent the message. */
  agent: ActorAddress;
  /** `yourMessage` when the run opened the trace from a message of yours,
   *  `answer` when its trigger came from a human seat, `reply` otherwise. */
  trigger: 'yourMessage' | 'answer' | 'reply';
  /** The trigger's sender; unused for `yourMessage`. */
  from: ActorAddress;
  /** 1 + the ancestors of `run` up to and including `root`. */
  depth: number;
  runsInTrace: number;
}

/** The sibling notes a bubble carries. All optional. */
export interface MessageNotes {
  /** Your message answers a question this actor put to you. */
  replyingTo?: ActorAddress;
  /** Your message was written by a Human-role seat other than the entry point. */
  sendAs?: ActorAddress;
  /** Your message was taken into a run that was already going (case 6). */
  absorbedBy?: { run: RunKey; agent: ActorAddress };
  provenance?: Provenance;
}

export type RunTreeItem =
  | { kind: 'message'; data: ChatMessage; position: Date; notes: MessageNotes }
  | {
      kind: 'trace';
      rootKey: RunKey;
      position: Date;
      /** The asker, when this trace continues where an agent asked you. */
      continuesFrom: ActorAddress | null;
    }
  | { kind: 'day'; data: DaySeparator };

export interface RunTreeView {
  timeline: RunTreeItem[];
  tail: ChatMessage[];
  /** The notes a queued message of yours carries ("replying to", "as"), by
   *  envelope id. A message keeps them while it waits in the tail. */
  tailNotes: ReadonlyMap<string, MessageNotes>;
}

type TraceItem = Extract<RunTreeItem, { kind: 'trace' }>;
type PlacedItem = Exclude<RunTreeItem, { kind: 'day' }>;

/** The fill behind your turn. Mirrors rule 1's in `chat-message.model.ts`,
 *  which that frozen file does not export. */
const YOUR_FILL = 'var(--akg-surface)';

/**
 * Whether `m` is a message YOU wrote: a Human-ROLE sender (never the `@Human`
 * name — Send-as and multi-human teams, Trap 3) that is not a seat answering a
 * question put to it. This is `opensTrace` from the fold, seen from the bubble,
 * so a message is yours exactly when its runs are trace roots.
 */
export function isYourMessage(m: ChatMessage, graph: RunGraph): boolean {
  if (m.rule === 5 || m.rule === 6 || m.rule === 7) return false;
  if (m.sender?.role !== HUMAN_ROLE) return false;
  if (m.parent_id === null) return true;
  const parent = graph.runs.get(runKey(m.parent_id, m.sender.agent_id));
  return parent === undefined || !isHumanSeat(parent);
}

/** Where `m` sits in the timeline: pick-up time for yours (`null` while no
 *  agent has taken it up), send time for everything else. */
export function positionTime(m: ChatMessage, graph: RunGraph): Date | null {
  return isYourMessage(m, graph) ? pickedUpAt(graph, m.message_id) : m.timestamp;
}

/** The asker whose question a trace root answers, from its parent run's
 *  trigger (case 4: the parent is `(Q, @Human)`, Q's sender is the asker). */
function continuesFromOf(graph: RunGraph, run: Run): ActorAddress | null {
  const parent = run.parent_key === null ? undefined : graph.runs.get(run.parent_key);
  if (parent === undefined) return null;
  return graph.messages.get(parent.message_id)?.sender ?? null;
}

/** One `trace` item per run your message opened, in start order. An absorbed
 *  message has no run, so no item (case 6). Entry-point runs never become
 *  cards. */
export function traceItemsFor(
  m: ChatMessage,
  graph: RunGraph,
  position: Date,
): TraceItem[] {
  return [...graph.runs.values()]
    .filter(
      (run) =>
        run.message_id === m.message_id &&
        !isEntryPointRun(run) &&
        traceRootOf(graph, run.key) === run.key,
    )
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .map((run) => ({
      kind: 'trace' as const,
      rootKey: run.key,
      position,
      continuesFrom: continuesFromOf(graph, run),
    }));
}

/** The sender of the message `m` replies to, when that message is known. */
export function replyTarget(m: ChatMessage, graph: RunGraph): ActorAddress | null {
  if (m.parent_id === null) return null;
  return graph.messages.get(m.parent_id)?.sender ?? null;
}

function triggerKind(
  key: RunKey,
  root: RunKey,
  trigger: ActorAddress,
): Provenance['trigger'] {
  if (trigger.role !== HUMAN_ROLE) return 'reply';
  // A Human-role trigger either opened the trace (yours) or is a seat's
  // answer, which continues the asker's trace (ADR-037 §D3).
  return key === root ? 'yourMessage' : 'answer';
}

/**
 * The provenance of an agent → you message: the run `(parent_id, sender)` that
 * sent it. `null` when `parent_id` is null, the run is unknown, or its trigger
 * is unknown (a replay that starts mid-conversation) — fail-open: the bubble
 * still renders, without the link.
 */
export function provenanceOf(m: ChatMessage, graph: RunGraph): Provenance | null {
  if (m.parent_id === null || !m.sender?.agent_id) return null;
  const key = runKey(m.parent_id, m.sender.agent_id);
  const run = graph.runs.get(key);
  const from = run ? graph.messages.get(run.message_id)?.sender : undefined;
  if (run === undefined || from === undefined) return null;
  const root = traceRootOf(graph, key);
  // `ancestors` continues past the root (case 4), so count up to it only.
  const chain = ancestors(graph, key);
  const at = chain.indexOf(root);
  return {
    run: key,
    root,
    agent: run.agent,
    trigger: triggerKind(key, root, from),
    from,
    depth: key === root ? 1 : at < 0 ? chain.length + 1 : at + 2,
    runsInTrace: traceRuns(graph, root).length,
  };
}

/** Your message as the view draws it. A Send-as message arrives as rule 4, so
 *  it is drawn from a rule-1 copy — never mutated, `chat$` is shared with the
 *  legacy panel. Its label is kept. */
function asYours(m: ChatMessage): ChatMessage {
  if (m.rule === 1) return m;
  return { ...m, rule: 1, alignment: 'right', color: YOUR_FILL, collapsed: false };
}

function yourNotes(m: ChatMessage, graph: RunGraph, cards: number): MessageNotes {
  const notes: MessageNotes = {};
  const replyingTo = replyTarget(m, graph);
  if (replyingTo !== null) notes.replyingTo = replyingTo;
  if (m.rule !== 1) notes.sendAs = m.sender;
  const absorbing = graph.messages.get(m.message_id)?.absorbed_by;
  const run = absorbing ? graph.runs.get(absorbing) : undefined;
  if (cards === 0 && run !== undefined) {
    notes.absorbedBy = { run: run.key, agent: run.agent };
  }
  return notes;
}

/** A group sorts as one unit: a message, then its own trace items. */
interface Group {
  time: number;
  items: PlacedItem[];
}

function yourGroup(m: ChatMessage, graph: RunGraph, position: Date): Group {
  const traces = traceItemsFor(m, graph, position);
  const message: PlacedItem = {
    kind: 'message',
    data: asYours(m),
    position,
    notes: yourNotes(m, graph, traces.length),
  };
  return { time: position.getTime(), items: [message, ...traces] };
}

function otherGroup(m: ChatMessage, graph: RunGraph): Group {
  const provenance = m.rule === 2 ? provenanceOf(m, graph) : null;
  const notes: MessageNotes = provenance ? { provenance } : {};
  return {
    time: m.timestamp.getTime(),
    items: [{ kind: 'message', data: m, position: m.timestamp, notes }],
  };
}

/**
 * Orphan traces (§D3 fail-open): a run that is its own trace root, whose
 * trigger is not one of your messages, and whose agent is not Human-role. A
 * REST replay that starts mid-conversation produces them. Placed at the run's
 * start with no bubble above it.
 */
function orphanGroups(graph: RunGraph, yours: ReadonlySet<string>): Group[] {
  const out: Group[] = [];
  for (const run of graph.runs.values()) {
    if (yours.has(run.message_id) || run.agent.role === HUMAN_ROLE) continue;
    if (traceRootOf(graph, run.key) !== run.key) continue;
    const item: TraceItem = {
      kind: 'trace',
      rootKey: run.key,
      position: run.start,
      continuesFrom: continuesFromOf(graph, run),
    };
    out.push({ time: run.start.getTime(), items: [item] });
  }
  return out;
}

function withDaySeparators(items: PlacedItem[]): RunTreeItem[] {
  const separators = daySeparatorsFor(items.map((item) => item.position));
  const out: RunTreeItem[] = [];
  items.forEach((item, i) => {
    const separator = separators[i];
    if (separator !== null) out.push({ kind: 'day', data: separator });
    out.push(item);
  });
  return out;
}

/** The display list of §D10. Pure: no clock, no DOM. */
export function buildRunTreeView(
  messages: readonly ChatMessage[],
  graph: RunGraph,
): RunTreeView {
  const yours = new Set<string>();
  const groups: Group[] = [];
  const tail: ChatMessage[] = [];
  const tailNotes = new Map<string, MessageNotes>();
  for (const m of messages) {
    if (isYourMessage(m, graph)) {
      // One bubble per inner message: a send to several supervisors echoes
      // once per recipient, and its trace items are keyed by run anyway.
      if (yours.has(m.message_id)) continue;
      yours.add(m.message_id);
      const position = pickedUpAt(graph, m.message_id);
      if (position === null) {
        tail.push(asYours(m));
        tailNotes.set(m.id, yourNotes(m, graph, 0));
      } else groups.push(yourGroup(m, graph, position));
    } else if (m.rule !== 3 && m.rule !== 4) {
      groups.push(otherGroup(m, graph));
    }
  }
  groups.push(...orphanGroups(graph, yours));
  // Stable: equal times keep log order, and a message's traces ride with it.
  groups.sort((a, b) => a.time - b.time);
  return { timeline: withDaySeparators(groups.flatMap((g) => g.items)), tail, tailNotes };
}

/** Stable `@for` key. A trace is keyed by its root run (Trap 7), a day by its
 *  calendar day, a message by its envelope id. */
export function trackRunTreeItem(_: number, item: RunTreeItem): string {
  switch (item.kind) {
    case 'message':
      return 'message:' + item.data.id;
    case 'trace':
      return 'trace:' + item.rootKey;
    case 'day':
      return 'day:' + item.data.day;
  }
}

export interface RunTreeState {
  view: RunTreeView;
  graph: RunGraph;
}

/**
 * RunTreeService — the run-tree transcript's one source (Epic 55).
 *
 * `zip`, never `combineLatest`: `chat$` and `graph$` each fold `log$` and emit
 * once per log emission, so `combineLatest` would emit twice per change and the
 * first emission would pair the new messages with the OLD graph. A message
 * picked up in the same frame it was echoed would then render in the tail for
 * one pass and jump, breaking the pin. Both are `log$.pipe(map, shareReplay(1))`,
 * so `zip` pairs the two folds of one emission.
 */
@Injectable()
export class RunTreeService {
  private readonly chat: ChatService = inject(ChatService);
  private readonly runGraph: RunGraphService = inject(RunGraphService);

  readonly state$: Observable<RunTreeState> = zip(
    this.chat.chat$,
    this.runGraph.graph$,
  ).pipe(
    map(([chat, graph]) => ({ graph, view: buildRunTreeView(chat.messages, graph) })),
    shareReplay(1),
  );
}
