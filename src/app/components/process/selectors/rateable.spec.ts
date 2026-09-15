import {
  ActorAddress,
  BaseMessage,
  EventMessage,
  LlmContextClearedEvent,
  LlmContextCompactedEvent,
  SentMessage,
} from '../../../protocol/message.types';
import {
  buildClearMarker,
  buildCompactionMarker,
  ChatMessage,
  classifyMessage,
} from './chat-message.model';
import { isRateable } from './rateable';

/**
 * Epic 57 NFR1 — one spec per rule.
 *
 * This predicate is a list of exclusions, and an untested exclusion is one that
 * is not really there: nothing else in the app would notice if a thumb quietly
 * appeared on the conversation-clear line. Each `describe` below names the
 * requirement it pins, so flipping a case means deleting a named test rather
 * than widening an array.
 *
 * Fixtures go through the real producers — `classifyMessage`,
 * `buildCompactionMarker`, `buildClearMarker` — wherever a message kind has
 * one. A hand-written `{ rule: 5 }` literal would keep passing after a
 * classification change that stopped producing rule 5 at all.
 */

function makeAddress(overrides: Partial<ActorAddress> = {}): ActorAddress {
  return {
    __actor_address__: true,
    name: '@Agent',
    role: 'Worker',
    agent_id: 'agent-1',
    squad_id: 'squad-1',
    user_message: false,
    ...overrides,
  };
}

function makeBaseMessage(overrides: Partial<BaseMessage> = {}): BaseMessage {
  return {
    id: 'msg-inner-1',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-08T10:00:00Z',
    sender: makeAddress(),
    display_type: 'other',
    content: 'Hello world',
    __model__: 'akgentic.core.messages.orchestrator.SentMessage',
    ...overrides,
  };
}

function makeSentMessage(overrides: Partial<SentMessage> = {}): SentMessage {
  const sender = overrides.sender ?? makeAddress();
  const recipient =
    overrides.recipient ?? makeAddress({ name: '@Manager', role: 'Manager' });
  return {
    id: 'msg-1',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-08T10:00:00Z',
    sender,
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.SentMessage',
    message: makeBaseMessage({ content: 'test content' }),
    recipient,
    ...overrides,
  };
}

/** Outer `ActorSystem` envelope wrapping an inner `WelcomeMessage` — the
 *  structural shape `isWelcomeAnnouncement` recognises (ADR-011). */
function makeWelcomeSent(): SentMessage {
  return makeSentMessage({
    id: 'welcome-outer-1',
    sender: makeAddress({ name: '@ActorSystem', role: 'ActorSystem' }),
    recipient: makeAddress({ name: '@Human', role: 'Human' }),
    message: makeBaseMessage({
      id: 'welcome-inner-1',
      sender: makeAddress({ name: '@Orchestrator', role: 'Orchestrator' }),
      content: 'Welcome to the agent team !',
      __model__: 'akgentic.team.messages.WelcomeMessage',
    }),
  });
}

function makeEventMessage(id: string): EventMessage {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-08T10:05:00Z',
    sender: makeAddress({ name: '@Researcher' }),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.EventMessage',
    event: {} as LlmContextCompactedEvent,
  } as unknown as EventMessage;
}

function compacted(
  summary: string,
  replaced = 9,
): LlmContextCompactedEvent {
  return {
    __model__: 'akgentic.core.llm.events.LlmContextCompactedEvent',
    replaced_message_count: replaced,
    summary,
  } as LlmContextCompactedEvent;
}

function cleared(count = 4): LlmContextClearedEvent {
  return {
    __model__: 'akgentic.core.llm.events.LlmContextClearedEvent',
    cleared_message_count: count,
  } as LlmContextClearedEvent;
}

const HUMAN = makeAddress({
  name: '@Human',
  role: 'Human',
  agent_id: 'human-1',
});
const AGENT = makeAddress({ name: '@Researcher', role: 'Worker' });
const OTHER_AGENT = makeAddress({
  name: '@Writer',
  role: 'Worker',
  agent_id: 'agent-2',
});
const HUMAN_PROXY = makeAddress({
  name: '@Approver',
  role: 'Human',
  agent_id: 'proxy-1',
});

function answerTo(recipient: ActorAddress, content = 'the answer'): ChatMessage {
  return classifyMessage(
    makeSentMessage({
      sender: AGENT,
      recipient,
      message: makeBaseMessage({ sender: AGENT, content }),
    }),
  );
}

describe('isRateable', () => {
  describe('FR2 — an agent answer is rateable', () => {
    it('rates an answer addressed to the entry-point human (rule 2)', () => {
      const msg = answerTo(HUMAN);
      expect(msg.rule).toBe(2);
      expect(isRateable(msg)).toBe(true);
    });

    it('rates an answer addressed to a human proxy (rule 3)', () => {
      const msg = answerTo(HUMAN_PROXY);
      expect(msg.rule).toBe(3);
      expect(isRateable(msg)).toBe(true);
    });

    it('rates an agent-to-agent turn (rule 4)', () => {
      const msg = answerTo(OTHER_AGENT);
      expect(msg.rule).toBe(4);
      expect(isRateable(msg)).toBe(true);
    });
  });

  describe('FR3 — the user’s own turn is not rateable', () => {
    it('refuses a message the entry-point human sent (rule 1)', () => {
      const msg = classifyMessage(
        makeSentMessage({
          sender: HUMAN,
          recipient: AGENT,
          message: makeBaseMessage({
            sender: HUMAN,
            content: 'what is the status?',
          }),
        }),
      );
      expect(msg.rule).toBe(1);
      expect(isRateable(msg)).toBe(false);
    });

    it('refuses it however substantial the content is', () => {
      const msg = classifyMessage(
        makeSentMessage({
          sender: HUMAN,
          recipient: AGENT,
          message: makeBaseMessage({
            sender: HUMAN,
            content: '# A long, considered, markdown-formatted prompt',
          }),
        }),
      );
      expect(isRateable(msg)).toBe(false);
    });
  });

  describe('FR4 — a system announcement is not rateable', () => {
    it('refuses the welcome announcement (rule 5)', () => {
      const msg = classifyMessage(makeWelcomeSent());
      expect(msg.rule).toBe(5);
      expect(isRateable(msg)).toBe(false);
    });

    it('refuses it even though it is addressed to the user like an answer', () => {
      // The welcome envelope's OUTER recipient is @Human — the very thing that
      // would classify it as a rateable rule 2 without the first-match order.
      const welcome = makeWelcomeSent();
      expect(welcome.recipient.name).toBe('@Human');
      expect(isRateable(classifyMessage(welcome))).toBe(false);
    });
  });

  describe('FR5 — a context-management marker is not rateable', () => {
    it('refuses the compaction fold (rule 6)', () => {
      const marker = buildCompactionMarker(
        makeEventMessage('evt-1'),
        compacted('', 12),
      );
      expect(marker.rule).toBe(6);
      expect(isRateable(marker)).toBe(false);
    });

    it('refuses the conversation-clear line (rule 7)', () => {
      const marker = buildClearMarker(makeEventMessage('evt-2'), cleared());
      expect(marker.rule).toBe(7);
      expect(isRateable(marker)).toBe(false);
    });
  });

  describe('FR6 — a generated summary is not rateable as an answer', () => {
    it('refuses the compaction fold when it carries a summary body', () => {
      // What separates this from FR5: the marker is not an empty announcement.
      // Its `content` IS the generated summary, rendered as markdown when the
      // fold is expanded and visually indistinguishable from an agent's turn.
      const marker = buildCompactionMarker(
        makeEventMessage('evt-3'),
        compacted('The team agreed on the migration plan and split the work.'),
      );
      expect(marker.content).not.toBe('');
      expect(isRateable(marker)).toBe(false);
    });

    it('refuses it whether the fold is collapsed or expanded', () => {
      const marker = buildCompactionMarker(
        makeEventMessage('evt-4'),
        compacted('a recap', 3),
      );
      expect(marker.collapsed).toBe(true);
      expect(isRateable(marker)).toBe(false);
      expect(isRateable({ ...marker, collapsed: false })).toBe(false);
    });
  });

  describe('FR7 — an answer is rateable even when no human ever typed', () => {
    it('rates a proactive agent turn that replies to nothing', () => {
      const proactive = answerTo(
        HUMAN,
        'The nightly run finished with 3 failures.',
      );
      expect(proactive.parent_id).toBeNull();
      expect(isRateable(proactive)).toBe(true);
    });

    it('rates every turn of a conversation that contains no user turn', () => {
      const conversation = [
        answerTo(HUMAN, 'first'),
        answerTo(OTHER_AGENT, 'second'),
      ];
      expect(conversation.some((m) => m.rule === 1)).toBe(false);
      expect(conversation.map((m) => isRateable(m))).toEqual([true, true]);
    });
  });

  describe('T2 — the rule keys on what a message is, not how it is drawn', () => {
    it('ignores fill, alignment and collapse when deciding', () => {
      // Epic 50 left agent turns with no fill. A predicate keyed to
      // presentation would have flipped the day that landed.
      const answer = answerTo(HUMAN);
      expect(
        isRateable({
          ...answer,
          color: 'transparent',
          alignment: 'right',
          collapsed: true,
        }),
      ).toBe(true);

      const ownTurn = classifyMessage(
        makeSentMessage({
          sender: HUMAN,
          recipient: AGENT,
          message: makeBaseMessage({ sender: HUMAN, content: 'hi' }),
        }),
      );
      expect(
        isRateable({
          ...ownTurn,
          color: 'var(--akg-surface)',
          alignment: 'left',
          collapsed: false,
        }),
      ).toBe(false);
    });
  });

  describe('purity', () => {
    it('does not mutate the message it is given', () => {
      const msg = answerTo(HUMAN);
      const before = JSON.stringify(msg);
      isRateable(msg);
      expect(JSON.stringify(msg)).toBe(before);
    });

    it('is deterministic across repeated calls', () => {
      const msg = answerTo(HUMAN);
      expect([isRateable(msg), isRateable(msg), isRateable(msg)]).toEqual([
        true,
        true,
        true,
      ]);
    });
  });
});
