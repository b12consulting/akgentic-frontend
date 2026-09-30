import { AkgenticMessage } from '../../../protocol/message.types';
import {
  addr,
  ASSISTANT,
  compacted,
  envId,
  EXPERT,
  HUMAN,
  MANAGER,
  processed,
  received,
  sent,
  SUPPORT,
} from '../../../../../testing/run-log-builders';
import {
  CASE_2,
  CASE_3,
  CASE_5,
  CASE_5_PREFIX,
  CASE_7,
  CASE_7_QUEUED,
} from '../../../../../testing/run-log-cases';
import {
  agentReaderItems,
  ReaderItem,
  ReaderRunBlock,
  seatQuestionPending,
  trackReaderItem,
} from './agent-reader-items';
import { ChatMessage } from './chat-message.model';
import { chatFold } from './chat.selector';
import { RunGraph, runGraphFold, runKey } from './run-graph.selector';

// Fold one log through BOTH folds, as production does.
function fold(log: AkgenticMessage[]): { messages: ChatMessage[]; graph: RunGraph } {
  return { messages: chatFold(log).messages, graph: runGraphFold(log) };
}

function itemsFor(log: AkgenticMessage[], agentId: string): ReaderItem[] {
  const { messages, graph } = fold(log);
  return agentReaderItems(graph, messages, agentId);
}

function blocks(items: ReaderItem[]): ReaderRunBlock[] {
  return items.flatMap((i) => (i.kind === 'run' ? [i.data] : []));
}

/** The list as `run:<key>` / `msg:<inner id>` / `day:<day>`. */
function shape(items: ReaderItem[]): string[] {
  return items.map((i) => {
    switch (i.kind) {
      case 'run':
        return 'run:' + i.data.key;
      case 'message':
        return 'msg:' + i.data.message_id;
      case 'day':
        return 'day:' + i.data.day;
    }
  });
}

/** Every inner id a list renders, block contents included, in list order. */
function renderedInnerIds(items: ReaderItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (item.kind === 'message') ids.push(item.data.message_id);
    if (item.kind !== 'run') continue;
    if (item.data.trigger) ids.push(item.data.trigger.message_id);
    for (const step of item.data.steps) {
      if (step.kind === 'message' && step.message) ids.push(step.message.message_id);
    }
  }
  return ids;
}

function messageSteps(block: ReaderRunBlock): string[] {
  return block.steps.flatMap((s) =>
    s.kind === 'message' ? [`${s.step}:${s.message?.message_id ?? 'null'}`] : [],
  );
}

describe('agentReaderItems', () => {
  describe('case 2 — fan-out, replies queued', () => {
    it('gives @Expert one block, asked by @Manager, trigger De and sent step Re', () => {
      const items = itemsFor(CASE_2, EXPERT.agent_id);
      expect(shape(items)).toEqual(['run:' + runKey('De', EXPERT.agent_id)]);
      const [block] = blocks(items);
      expect(block.askedBy).toEqual(MANAGER);
      expect(block.askedByYou).toBe(false);
      expect(block.trigger?.message_id).toBe('De');
      // The envelope addressed to @Expert, not another id space (Trap 1).
      expect(block.trigger?.id).toBe(envId('De', EXPERT));
      expect(messageSteps(block)).toEqual(['sent:Re']);
      expect(block.pill).toBe('done');
      expect(block.duration).toBe('3s');
    });

    it('gives @Manager its three runs in start order', () => {
      const items = itemsFor(CASE_2, MANAGER.agent_id);
      expect(blocks(items).map((b) => b.key)).toEqual([
        runKey('U1', MANAGER.agent_id),
        runKey('Re', MANAGER.agent_id),
        runKey('Ra', MANAGER.agent_id),
      ]);
      const [u1, re, ra] = blocks(items);
      expect(u1.askedByYou).toBe(true);
      expect(messageSteps(u1)).toEqual(['sent:De', 'sent:Da']);
      expect(re.pill).toBe('doneSilent');
      expect(ra.askedBy).toEqual(ASSISTANT);
      expect(messageSteps(ra)).toEqual(['sent:A']);
    });

    it('never shows a trigger or a sent step again as a loose row', () => {
      for (const agent of [MANAGER, EXPERT, ASSISTANT]) {
        const ids = renderedInnerIds(itemsFor(CASE_2, agent.agent_id));
        expect(new Set(ids).size).withContext(agent.name).toBe(ids.length);
      }
      const manager = itemsFor(CASE_2, MANAGER.agent_id);
      expect(manager.some((i) => i.kind === 'message')).toBe(false);
    });

    it('keeps activity steps apart from message steps, and counts them', () => {
      const [block] = blocks(itemsFor(CASE_2, EXPERT.agent_id));
      expect(block.steps.map((s) => s.row.kind)).toEqual(['received', 'sent', 'processed']);
      expect(block.activityCount).toBe(2);
    });
  });

  describe('case 3 — fan-in', () => {
    it('shows Re as @Expert’s sent step and as @Manager’s absorbed step, loose in neither', () => {
      const expert = itemsFor(CASE_3, EXPERT.agent_id);
      const manager = itemsFor(CASE_3, MANAGER.agent_id);
      expect(messageSteps(blocks(expert)[0])).toEqual(['sent:Re']);
      const ra = blocks(manager).find((b) => b.key === runKey('Ra', MANAGER.agent_id))!;
      expect(messageSteps(ra)).toEqual(['absorbed:Re', 'sent:A']);
      for (const items of [expert, manager]) {
        expect(renderedInnerIds(items).filter((id) => id === 'Re')).toEqual(['Re']);
        expect(shape(items).some((s) => s === 'msg:Re')).toBe(false);
      }
    });

    it('marks failed and pending tools the way the Run tab does', () => {
      const [block] = blocks(itemsFor(CASE_3.slice(0, 11), MANAGER.agent_id)).slice(-1);
      const tool = block.steps.find((s) => s.row.kind === 'tool');
      expect(tool?.row).toEqual(jasmine.objectContaining({ name: 'search', state: 'pending' }));
      expect(block.pill).toBe('running');
      expect(block.duration).toBeNull();

      const [d2] = blocks(itemsFor(CASE_5, ASSISTANT.agent_id));
      const tools = d2.steps.flatMap((s) => (s.row.kind === 'tool' ? [s.row.state] : []));
      expect(tools).toEqual(['failed', 'ok', 'ok']);
    });
  });

  describe('case 5 — a question to a seat', () => {
    function question(log: AkgenticMessage[]): { graph: RunGraph; q: ChatMessage } {
      const { messages, graph } = fold(log);
      const items = agentReaderItems(graph, messages, MANAGER.agent_id);
      const u1 = blocks(items)[0];
      const step = u1.steps.find((s) => s.kind === 'message' && s.message?.message_id === 'S');
      if (step?.kind !== 'message' || step.message === null) throw new Error('no question');
      return { graph, q: step.message };
    }

    it('is pending while the seat waits', () => {
      const { graph, q } = question(CASE_5_PREFIX);
      expect(q.rule).toBe(3);
      expect(seatQuestionPending(graph, q)).toBe(true);
    });

    it('is answered once the seat replies', () => {
      const { graph, q } = question(CASE_5);
      expect(seatQuestionPending(graph, q)).toBe(false);
    });

    it('is pending when the seat has not received it yet, answered once a reply shows', () => {
      const asked = [
        sent('U1', HUMAN, MANAGER, null, 1),
        received('U1', MANAGER, 2),
        sent('S', MANAGER, SUPPORT, 'U1', 3),
      ];
      expect(seatQuestionPending(fold(asked).graph, question(asked).q)).toBe(true);
      // A replay gap: the seat's run is not in the log, its reply is.
      const replied = [...asked, sent('Sa', SUPPORT, MANAGER, 'S', 9)];
      expect(seatQuestionPending(fold(replied).graph, question(asked).q)).toBe(false);
    });

    it('is never pending for a message that is not a question to a seat', () => {
      const { messages, graph } = fold(CASE_2);
      expect(messages.every((m) => !seatQuestionPending(graph, m))).toBe(true);
    });

    it('names a seat’s answer as asked by the seat, not by you', () => {
      const sa = blocks(itemsFor(CASE_5, MANAGER.agent_id)).find(
        (b) => b.key === runKey('Sa', MANAGER.agent_id),
      )!;
      expect(sa.askedBy).toEqual(SUPPORT);
      expect(sa.askedByYou).toBe(false);
    });
  });

  it('keeps two supervisors’ runs of one message apart', () => {
    const LEAD = addr('@Lead', 'Lead', 'lead-id');
    const log = [
      sent('M', HUMAN, MANAGER, null, 1),
      sent('M', HUMAN, LEAD, null, 1),
      received('M', MANAGER, 2),
      received('M', LEAD, 3),
      sent('D1', MANAGER, EXPERT, 'M', 4),
      sent('D2', LEAD, EXPERT, 'M', 5),
    ];
    const lead = itemsFor(log, LEAD.agent_id);
    expect(shape(lead)).toEqual(['run:' + runKey('M', LEAD.agent_id)]);
    const [block] = blocks(lead);
    expect(block.trigger?.id).toBe(envId('M', LEAD));
    expect(messageSteps(block)).toEqual(['sent:D2']);
    expect(shape(itemsFor(log, MANAGER.agent_id))).toEqual(['run:' + runKey('M', MANAGER.agent_id)]);
  });

  describe('loose messages', () => {
    it('keeps a compaction marker of the open agent', () => {
      const items = itemsFor([...CASE_2, compacted('K', EXPERT, 20)], EXPERT.agent_id);
      expect(shape(items)).toEqual(['run:' + runKey('De', EXPERT.agent_id), 'msg:K']);
      expect(items[1].kind === 'message' && items[1].data.rule).toBe(6);
    });

    it('keeps a message queued for the open agent that no run took up', () => {
      expect(shape(itemsFor(CASE_7_QUEUED, EXPERT.agent_id))).toEqual(['msg:D']);
      // Picked up, it is the run's trigger instead.
      expect(shape(itemsFor(CASE_7, EXPERT.agent_id))).toEqual([
        'run:' + runKey('D', EXPERT.agent_id),
      ]);
    });

    it('survives a replay that starts mid-conversation', () => {
      const log = [
        received('De', EXPERT, 6),
        processed('De', EXPERT, 7),
        // Sent by a run the log does not hold.
        sent('Re', EXPERT, MANAGER, 'Dx', 8),
      ];
      const items = itemsFor(log, EXPERT.agent_id);
      expect(shape(items)).toEqual(['run:' + runKey('De', EXPERT.agent_id), 'msg:Re']);
      const [block] = blocks(items);
      expect(block.trigger).toBeNull();
      expect(block.askedBy).toBeNull();
      expect(block.askedByYou).toBe(false);
    });

    it('falls back to a row when a message step has no ChatMessage', () => {
      const { graph } = fold(CASE_2);
      const [block] = blocks(agentReaderItems(graph, [], EXPERT.agent_id));
      expect(block.trigger).toBeNull();
      expect(messageSteps(block)).toEqual(['sent:null']);
      expect(block.askedBy).toEqual(MANAGER);
    });
  });

  it('sorts a message before a block on a tie', () => {
    const log = [
      sent('D', MANAGER, EXPERT, null, 5),
      received('X', EXPERT, 5),
    ];
    // `X` is not in the log as a message: a block with no trigger, at t=5.
    expect(shape(itemsFor(log, EXPERT.agent_id))).toEqual([
      'msg:D',
      'run:' + runKey('X', EXPERT.agent_id),
    ]);
  });

  it('marks a day boundary between two blocks once', () => {
    const DAY = 24 * 3600;
    const log = [
      sent('D1', MANAGER, EXPERT, null, 1),
      received('D1', EXPERT, 2),
      processed('D1', EXPERT, 3),
      sent('D2', MANAGER, EXPERT, null, DAY + 1),
      received('D2', EXPERT, DAY + 2),
      processed('D2', EXPERT, DAY + 3),
    ];
    const kinds = itemsFor(log, EXPERT.agent_id).map((i) => i.kind);
    expect(kinds).toEqual(['run', 'day', 'run']);
  });

  it('keeps tracking keys stable across a re-fold of a longer log', () => {
    const before = itemsFor(CASE_7_QUEUED, MANAGER.agent_id).map((i, n) => trackReaderItem(n, i));
    const after = itemsFor(CASE_7, MANAGER.agent_id).map((i, n) => trackReaderItem(n, i));
    expect(before).toEqual(['run:' + runKey('U1', MANAGER.agent_id)]);
    expect(after.slice(0, 1)).toEqual(before);
    expect(after).toEqual([
      'run:' + runKey('U1', MANAGER.agent_id),
      'run:' + runKey('Re', MANAGER.agent_id),
    ]);
  });

  it('tracks a loose message by its envelope id', () => {
    const [item] = itemsFor(CASE_7_QUEUED, EXPERT.agent_id);
    expect(trackReaderItem(0, item)).toBe('message:' + envId('D', EXPERT));
  });

  it('is empty with no agent open', () => {
    expect(itemsFor(CASE_2, '')).toEqual([]);
    const { graph, messages } = fold(CASE_2);
    expect(agentReaderItems(graph, messages, null)).toEqual([]);
  });

  it('never opens an entry-point run as a block', () => {
    expect(blocks(itemsFor(CASE_2, HUMAN.agent_id))).toEqual([]);
  });
});
