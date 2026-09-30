import { ActorAddress } from '../../../protocol/message.types';
import { HUMAN_ROLE } from './actor-kind';
import { agentConversation } from './agent-conversation.selector';
import { ChatMessage } from './chat-message.model';
import { DaySeparator, daySeparatorsFor } from './day-separator';
import {
  isHumanSeat,
  Run,
  RunGraph,
  RunKey,
  runKey,
  RunMessage,
  RunStep,
  runStatus,
} from './run-graph.selector';
import { RunPill, runPill, RunStepRow, runSteps } from './run-inspector';
import { isEntryPointRun, traceDuration } from './trace-summary';

/**
 * The sub-agent reader's list in the run-tree view (Epic 55, ADR-037 §D10), as
 * data: the open agent's runs, each with the message that triggered it, and
 * the agent's messages that none of those runs renders.
 *
 * Pure: no i18n, no clock, no DOM. The legacy reader's list is
 * `buildDisplayItems` over `agentRuns`; this one replaces its exclusion set by
 * construction. A message is left out of the loose rows only because a block
 * built by THIS call renders it, so a message can neither vanish (the
 * `display-items.ts` trap) nor show twice.
 */

type ReaderMessageRow = Extract<RunStepRow, { kind: 'sent' | 'absorbed' }>;

export type ReaderStep =
  | {
      kind: 'message';
      step: 'sent' | 'absorbed';
      row: ReaderMessageRow;
      message: ChatMessage | null;
    }
  | { kind: 'activity'; row: RunStepRow };

export interface ReaderRunBlock {
  key: RunKey;
  run: Run;
  /** The trigger's sender; `null` when the trigger is not in the graph. */
  askedBy: ActorAddress | null;
  /** The trigger is a message you wrote (a seat's answer is not). */
  askedByYou: boolean;
  /** Matched by INNER id; `null` on a replay gap or a dropped message. */
  trigger: ChatMessage | null;
  pill: RunPill;
  /** `traceDuration(start, end)`; `null` while running. */
  duration: string | null;
  steps: ReaderStep[];
  activityCount: number;
}

export type ReaderItem =
  | { kind: 'run'; data: ReaderRunBlock }
  | { kind: 'message'; data: ChatMessage }
  | { kind: 'day'; data: DaySeparator };

type TurnItem = Exclude<ReaderItem, { kind: 'day' }>;

/** A `ChatMessage` by inner id, preferring the envelope addressed to
 *  `recipientId`: one inner id sent to two supervisors has two envelopes. */
type MessageLookup = (innerId: string, recipientId: string) => ChatMessage | null;

function messageLookup(messages: readonly ChatMessage[]): MessageLookup {
  const byInnerId = new Map<string, ChatMessage[]>();
  for (const m of messages) {
    const list = byInnerId.get(m.message_id);
    if (list) list.push(m);
    else byInnerId.set(m.message_id, [m]);
  }
  return (innerId, recipientId) => {
    const list = byInnerId.get(innerId);
    if (list === undefined) return null;
    return list.find((m) => m.recipient.agent_id === recipientId) ?? list[0];
  };
}

/** `isYourMessage` read from the graph's record of the trigger: a Human-role
 *  sender that is not a seat answering the question put to it. */
function writtenByYou(graph: RunGraph, trigger: RunMessage): boolean {
  if (trigger.sender?.role !== HUMAN_ROLE) return false;
  if (trigger.parent_id === null) return true;
  const parent = graph.runs.get(runKey(trigger.parent_id, trigger.sender.agent_id));
  return parent === undefined || !isHumanSeat(parent);
}

function readerStep(
  step: RunStep,
  row: RunStepRow,
  agentId: string,
  lookup: MessageLookup,
): ReaderStep {
  if (step.kind === 'sent' && row.kind === 'sent') {
    const message = lookup(step.message_id, step.recipient.agent_id);
    return { kind: 'message', step: 'sent', row, message };
  }
  if (step.kind === 'absorbed' && row.kind === 'absorbed') {
    return { kind: 'message', step: 'absorbed', row, message: lookup(step.message_id, agentId) };
  }
  return { kind: 'activity', row };
}

function readerBlock(graph: RunGraph, run: Run, lookup: MessageLookup): ReaderRunBlock {
  const agentId = run.agent.agent_id;
  const recorded = graph.messages.get(run.message_id);
  // `runSteps` maps `run.steps` one to one, so the two zip by index.
  const rows = runSteps(graph, run);
  const steps = run.steps.map((step, i) => readerStep(step, rows[i], agentId, lookup));
  return {
    key: run.key,
    run,
    askedBy: recorded?.sender ?? null,
    askedByYou: recorded !== undefined && writtenByYou(graph, recorded),
    trigger: lookup(run.message_id, agentId),
    pill: runPill(graph, run.key) ?? run.status,
    duration: traceDuration(run.start, run.end),
    steps,
    activityCount: steps.filter((s) => s.kind === 'activity').length,
  };
}

/** The inner ids the blocks render, as trigger or message step. */
function renderedInnerIds(blocks: readonly ReaderRunBlock[]): Set<string> {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.trigger !== null) ids.add(block.trigger.message_id);
    for (const step of block.steps) {
      if (step.kind === 'message' && step.message !== null) ids.add(step.message.message_id);
    }
  }
  return ids;
}

/** `NaN` for an unusable time, which the sort leaves in place. */
function turnDate(item: TurnItem): Date {
  return item.kind === 'run' ? item.data.run.start : item.data.timestamp;
}

/** Sort by time, a message before a block on a tie (`buildDisplayItems`'
 *  tie-break), then splice in the day separators. */
function sortedWithDays(items: TurnItem[]): ReaderItem[] {
  items.sort((a, b) => {
    const ta = turnDate(a).getTime();
    const tb = turnDate(b).getTime();
    if (ta !== tb) return ta - tb;
    if (a.kind === b.kind) return 0;
    return a.kind === 'message' ? -1 : 1;
  });
  const separators = daySeparatorsFor(items.map(turnDate));
  const out: ReaderItem[] = [];
  items.forEach((item, i) => {
    const separator = separators[i];
    if (separator !== null) out.push({ kind: 'day', data: separator });
    out.push(item);
  });
  return out;
}

/**
 * The reader's list for `agentId`: one block per run of the agent, in start
 * order (entry-point runs never qualify), and every message of the agent's
 * conversation that no block renders, sorted together with day separators.
 * Two runs of one message id (two supervisors) are two blocks, each in its own
 * agent's reader.
 */
export function agentReaderItems(
  graph: RunGraph,
  messages: readonly ChatMessage[],
  agentId: string | null | undefined,
): ReaderItem[] {
  if (!agentId) return [];
  const lookup = messageLookup(messages);
  const blocks = [...graph.runs.values()]
    .filter((run) => run.agent.agent_id === agentId && !isEntryPointRun(run))
    .map((run) => readerBlock(graph, run, lookup));
  const consumed = renderedInnerIds(blocks);
  const loose = agentConversation(messages, agentId).filter((m) => !consumed.has(m.message_id));
  return sortedWithDays([
    ...blocks.map((data): TurnItem => ({ kind: 'run', data })),
    ...loose.map((data): TurnItem => ({ kind: 'message', data })),
  ]);
}

/** `run:<key>`, `message:<envelope id>`, `day:<day>`: stable across emissions. */
export function trackReaderItem(_: number, item: ReaderItem): string {
  switch (item.kind) {
    case 'run':
      return 'run:' + item.data.key;
    case 'message':
      return 'message:' + item.data.id;
    case 'day':
      return 'day:' + item.data.day;
  }
}

/**
 * Whether a rule-3 question to a seat is still owed an answer, read from the
 * graph (ADR-037 §D4): the seat run `(question, seat)` is `waiting`. When that
 * run is not in the graph (not received yet, or a replay gap), the question is
 * answered iff the graph holds a reply from the seat parented on it.
 */
export function seatQuestionPending(graph: RunGraph, m: ChatMessage): boolean {
  if (m.rule !== 3) return false;
  const status = runStatus(graph, runKey(m.message_id, m.recipient.agent_id));
  if (status !== null) return status === 'waiting';
  for (const reply of graph.messages.values()) {
    if (reply.parent_id === m.message_id && reply.sender?.agent_id === m.recipient.agent_id) {
      return false;
    }
  }
  return true;
}
