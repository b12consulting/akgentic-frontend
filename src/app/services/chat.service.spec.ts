import {
  ChatService,
  computePendingNotifications,
  ThinkingToolEntry,
} from './chat.service';
import { ChatMessage } from '../models/chat-message.model';
import { ActorAddress } from '../models/message.types';

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

function makeChatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  const id = overrides.id ?? 'msg-1';
  return {
    id,
    // Default inner id mirrors outer id so existing assertions keep working;
    // tests that need to exercise outer/inner divergence override explicitly.
    message_id: id,
    parent_id: null,
    content: 'Hello world',
    sender: makeAddress({ name: '@Manager', role: 'Manager' }),
    recipient: makeAddress({ name: '@Human', role: 'Human' }),
    timestamp: new Date('2026-04-08T10:00:00Z'),
    rule: 2,
    alignment: 'left',
    color: '#9ebbcb',
    collapsed: false,
    label: 'Manager [Manager]',
    ...overrides,
  };
}

describe('ChatService', () => {
  let service: ChatService;

  beforeEach(() => {
    service = new ChatService();
  });

  describe('replyContext$', () => {
    it('should initialize to null', () => {
      expect(service.replyContext$.value).toBeNull();
    });

    it('should set reply context via setReplyContext', () => {
      const msg = makeChatMessage();
      service.setReplyContext(msg);
      expect(service.replyContext$.value).toBe(msg);
    });

    it('should clear reply context via clearReplyContext', () => {
      const msg = makeChatMessage();
      service.setReplyContext(msg);
      expect(service.replyContext$.value).toBe(msg);

      service.clearReplyContext();
      expect(service.replyContext$.value).toBeNull();
    });

    it('should emit values to subscribers', () => {
      const emitted: (ChatMessage | null)[] = [];
      service.replyContext$.subscribe((val) => emitted.push(val));

      const msg = makeChatMessage({ id: 'msg-2' });
      service.setReplyContext(msg);
      service.clearReplyContext();

      expect(emitted).toEqual([null, msg, null]);
    });

    it('should replace previous reply context when setting a new one', () => {
      const msg1 = makeChatMessage({ id: 'msg-1' });
      const msg2 = makeChatMessage({ id: 'msg-2' });

      service.setReplyContext(msg1);
      expect(service.replyContext$.value).toBe(msg1);

      service.setReplyContext(msg2);
      expect(service.replyContext$.value).toBe(msg2);
    });

    it('should accept null via setReplyContext', () => {
      const msg = makeChatMessage();
      service.setReplyContext(msg);
      service.setReplyContext(null);
      expect(service.replyContext$.value).toBeNull();
    });
  });

  describe('thinkingAgents$ mutators (Story 4-8)', () => {
    function makeEntry(
      overrides: Partial<ThinkingToolEntry> = {},
    ): ThinkingToolEntry {
      return {
        tool_call_id: 'call-1',
        tool_name: 'search_web',
        arguments_preview: 'q=foo',
        done: false,
        ...overrides,
      };
    }

    it('initialises thinkingAgents$ to empty array', () => {
      expect(service.thinkingAgents$.value).toEqual([]);
    });

    it('beginThinking appends a new state (tools [], final false)', () => {
      const previous = service.thinkingAgents$.value;
      service.beginThinking({
        agent_id: 'a1',
        agent_name: '@Researcher',
        start_time: new Date('2026-04-12T00:00:00Z'),
        anchor_message_id: 'anchor-1',
      });
      const next = service.thinkingAgents$.value;
      expect(next.length).toBe(1);
      expect(next[0].agent_id).toBe('a1');
      expect(next[0].tools).toEqual([]);
      expect(next[0].final).toBe(false);
      expect(next[0].anchor_message_id).toBe('anchor-1');
      expect(next).not.toBe(previous);
    });

    it('beginThinking is a no-op for the same agent_id while non-final', () => {
      service.beginThinking({
        agent_id: 'a1',
        agent_name: '@Researcher',
        start_time: new Date('2026-04-12T00:00:00Z'),
        anchor_message_id: 'anchor-1',
      });
      const refAfterFirst = service.thinkingAgents$.value;
      service.beginThinking({
        agent_id: 'a1',
        agent_name: '@Researcher',
        start_time: new Date('2026-04-12T00:01:00Z'),
        anchor_message_id: 'anchor-2',
      });
      expect(service.thinkingAgents$.value).toBe(refAfterFirst);
      expect(service.thinkingAgents$.value.length).toBe(1);
      expect(service.thinkingAgents$.value[0].anchor_message_id).toBe(
        'anchor-1',
      );
    });

    it('appendToolCall appends onto the non-final state; emits fresh array', () => {
      service.beginThinking({
        agent_id: 'a1',
        agent_name: '@Researcher',
        start_time: new Date(),
        anchor_message_id: 'anchor-1',
      });
      const previous = service.thinkingAgents$.value;
      service.appendToolCall('a1', makeEntry());
      const next = service.thinkingAgents$.value;
      expect(next[0].tools.length).toBe(1);
      expect(next[0].tools[0].tool_call_id).toBe('call-1');
      expect(next).not.toBe(previous);
    });

    it('appendToolCall is a no-op (debug log) when no state exists', () => {
      const debugSpy = spyOn(console, 'debug');
      const before = service.thinkingAgents$.value;
      service.appendToolCall('missing', makeEntry());
      expect(service.thinkingAgents$.value).toBe(before);
      expect(debugSpy).toHaveBeenCalled();
    });

    it('markToolDone flips done; unknown tool_call_id is a no-op', () => {
      service.beginThinking({
        agent_id: 'a1',
        agent_name: '@Researcher',
        start_time: new Date(),
        anchor_message_id: 'anchor-1',
      });
      service.appendToolCall('a1', makeEntry({ tool_call_id: 'call-1' }));
      const previous = service.thinkingAgents$.value;
      service.markToolDone('a1', 'call-1');
      const next = service.thinkingAgents$.value;
      expect(next[0].tools[0].done).toBe(true);
      expect(next).not.toBe(previous);

      const ref = service.thinkingAgents$.value;
      service.markToolDone('a1', 'unknown');
      expect(service.thinkingAgents$.value).toBe(ref);
    });

    it('finaliseOrDiscard removes state when tools is empty (ephemeral exit)', () => {
      service.beginThinking({
        agent_id: 'a1',
        agent_name: '@Researcher',
        start_time: new Date(),
        anchor_message_id: 'anchor-1',
      });
      service.finaliseOrDiscard('a1');
      expect(service.thinkingAgents$.value).toEqual([]);
    });

    it('finaliseOrDiscard flips final=true when tools.length > 0 (persistent)', () => {
      service.beginThinking({
        agent_id: 'a1',
        agent_name: '@Researcher',
        start_time: new Date(),
        anchor_message_id: 'anchor-1',
      });
      service.appendToolCall('a1', makeEntry());
      const previous = service.thinkingAgents$.value;
      service.finaliseOrDiscard('a1');
      const next = service.thinkingAgents$.value;
      expect(next.length).toBe(1);
      expect(next[0].final).toBe(true);
      expect(next).not.toBe(previous);
    });

    it('finaliseOrDiscard is a no-op for unknown agent_id', () => {
      const before = service.thinkingAgents$.value;
      service.finaliseOrDiscard('missing');
      expect(service.thinkingAgents$.value).toBe(before);
    });

    it('each mutator emits a new array reference (OnPush safety)', () => {
      const refs: unknown[] = [];
      service.thinkingAgents$.subscribe((v) => refs.push(v));
      service.beginThinking({
        agent_id: 'a1',
        agent_name: '@Researcher',
        start_time: new Date(),
        anchor_message_id: 'anchor-1',
      });
      service.appendToolCall('a1', makeEntry());
      service.markToolDone('a1', 'call-1');
      service.finaliseOrDiscard('a1');
      // 1 initial + 4 mutations
      expect(refs.length).toBe(5);
      // All distinct array references
      const uniq = new Set(refs);
      expect(uniq.size).toBe(5);
    });
  });

  describe('pendingNotifications$', () => {
    it('should emit empty set initially', (done) => {
      service.pendingNotifications$.subscribe((pending) => {
        expect(pending.size).toBe(0);
        done();
      });
    });

    it('should emit pending notifications when Rule 3 messages arrive', (done) => {
      const rule3Msg = makeChatMessage({
        id: 'r3-1',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      });
      service.messages$.next([rule3Msg]);

      service.pendingNotifications$.subscribe((pending) => {
        expect(pending.size).toBe(1);
        expect(pending.has('r3-1')).toBe(true);
        done();
      });
    });

    it('should reactively update when messages$ changes', () => {
      const emitted: Set<string>[] = [];
      service.pendingNotifications$.subscribe((p) => emitted.push(p));

      // Initially empty
      expect(emitted[0].size).toBe(0);

      // Add a Rule 3 message
      const rule3Msg = makeChatMessage({
        id: 'r3-1',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      });
      service.messages$.next([rule3Msg]);

      expect(emitted[1].size).toBe(1);
      expect(emitted[1].has('r3-1')).toBe(true);
    });
  });
});

describe('computePendingNotifications', () => {
  it('should return empty set for empty messages', () => {
    const result = computePendingNotifications([]);
    expect(result.size).toBe(0);
  });

  it('should track Rule 3 message ids as pending', () => {
    const msgs: ChatMessage[] = [
      makeChatMessage({
        id: 'r3-1',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
    ];
    const result = computePendingNotifications(msgs);
    expect(result.size).toBe(1);
    expect(result.has('r3-1')).toBe(true);
  });

  it('should accumulate multiple messages for same agent pair (per-message)', () => {
    const msgs: ChatMessage[] = [
      makeChatMessage({
        id: 'r3-1',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
      makeChatMessage({
        id: 'r3-2',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
      makeChatMessage({
        id: 'r3-3',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
    ];
    const result = computePendingNotifications(msgs);
    expect(result.size).toBe(3);
    expect(result.has('r3-1')).toBe(true);
    expect(result.has('r3-2')).toBe(true);
    expect(result.has('r3-3')).toBe(true);
  });

  it('should clear only the specific message whose id matches reply.parent_id', () => {
    const msgs: ChatMessage[] = [
      makeChatMessage({
        id: 'r3-1',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
      makeChatMessage({
        id: 'r3-2',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
      // QATester replies to r3-1 only
      makeChatMessage({
        id: 'reply-1',
        parent_id: 'r3-1',
        rule: 1,
        sender: makeAddress({ name: '@QATester', role: 'Human' }),
        recipient: makeAddress({ name: '@Manager', role: 'Manager' }),
      }),
    ];
    const result = computePendingNotifications(msgs);
    expect(result.size).toBe(1);
    expect(result.has('r3-1')).toBe(false);
    expect(result.has('r3-2')).toBe(true);
  });

  it('should re-add notifications after reply if new messages arrive', () => {
    const msgs: ChatMessage[] = [
      makeChatMessage({
        id: 'r3-1',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
      // QATester replies to r3-1
      makeChatMessage({
        id: 'reply-1',
        parent_id: 'r3-1',
        rule: 1,
        sender: makeAddress({ name: '@QATester', role: 'Human' }),
        recipient: makeAddress({ name: '@Manager', role: 'Manager' }),
      }),
      // Manager sends again
      makeChatMessage({
        id: 'r3-new',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
    ];
    const result = computePendingNotifications(msgs);
    expect(result.size).toBe(1);
    expect(result.has('r3-new')).toBe(true);
    expect(result.has('r3-1')).toBe(false);
  });

  it('should handle multiple agent pairs independently', () => {
    const msgs: ChatMessage[] = [
      makeChatMessage({
        id: 'r3-a',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
      makeChatMessage({
        id: 'r3-b',
        rule: 3,
        sender: makeAddress({ name: '@Worker', role: 'Worker' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
    ];
    const result = computePendingNotifications(msgs);
    expect(result.size).toBe(2);
    expect(result.has('r3-a')).toBe(true);
    expect(result.has('r3-b')).toBe(true);
  });

  it('should NOT track messages to @Human entry point', () => {
    const msgs: ChatMessage[] = [
      makeChatMessage({
        id: 'r2-1',
        rule: 2,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@Human', role: 'Human' }),
      }),
    ];
    const result = computePendingNotifications(msgs);
    expect(result.size).toBe(0);
  });

  it('should NOT clear when @Human entry point sends a message without parent_id', () => {
    const msgs: ChatMessage[] = [
      makeChatMessage({
        id: 'r3-1',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
      // @Human sends a message with no parent_id — should NOT clear anything
      makeChatMessage({
        id: 'user-1',
        parent_id: null,
        rule: 1,
        sender: makeAddress({ name: '@Human', role: 'Human' }),
        recipient: makeAddress({ name: '@Manager', role: 'Manager' }),
      }),
    ];
    const result = computePendingNotifications(msgs);
    expect(result.size).toBe(1);
    expect(result.has('r3-1')).toBe(true);
  });

  it('reply clears only the specific message, not others in the same pair', () => {
    const msgs: ChatMessage[] = [
      makeChatMessage({
        id: 'r3-a',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
      makeChatMessage({
        id: 'r3-b',
        rule: 3,
        sender: makeAddress({ name: '@Worker', role: 'Worker' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
      // QATester replies to r3-a specifically
      makeChatMessage({
        id: 'reply-1',
        parent_id: 'r3-a',
        rule: 1,
        sender: makeAddress({ name: '@QATester', role: 'Human' }),
        recipient: makeAddress({ name: '@Manager', role: 'Manager' }),
      }),
    ];
    const result = computePendingNotifications(msgs);
    expect(result.size).toBe(1);
    expect(result.has('r3-a')).toBe(false);
    expect(result.has('r3-b')).toBe(true);
  });

  it('multiple unanswered messages in the same pair are all flagged independently', () => {
    const msgs: ChatMessage[] = [
      makeChatMessage({
        id: 'r3-1',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
      makeChatMessage({
        id: 'r3-2',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
      makeChatMessage({
        id: 'r3-3',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
    ];
    const result = computePendingNotifications(msgs);
    expect(result.size).toBe(3);
    expect(result.has('r3-1')).toBe(true);
    expect(result.has('r3-2')).toBe(true);
    expect(result.has('r3-3')).toBe(true);
  });

  it('tracks by inner message_id, not outer envelope id (regression: Story 4.6 outer/inner mismatch)', () => {
    // In production the outer SentMessage.id and inner BaseMessage.id are
    // distinct, and reply.parent_id references the INNER id. If the pending
    // set is keyed on the outer id, the reply's inner parent_id never
    // matches and the hand icon never clears in the chat. This test
    // deliberately makes id !== message_id to exercise the divergence.
    const msgs: ChatMessage[] = [
      makeChatMessage({
        id: 'r3-outer-1',
        message_id: 'r3-inner-1',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
      makeChatMessage({
        id: 'reply-outer-1',
        message_id: 'reply-inner-1',
        // Reply's parent_id references the INNER id of the request.
        parent_id: 'r3-inner-1',
        rule: 1,
        sender: makeAddress({ name: '@QATester', role: 'Human' }),
        recipient: makeAddress({ name: '@Manager', role: 'Manager' }),
      }),
    ];
    const result = computePendingNotifications(msgs);
    expect(result.size).toBe(0);
    // Must NOT still contain the outer id (that would be the old buggy key).
    expect(result.has('r3-outer-1')).toBe(false);
    expect(result.has('r3-inner-1')).toBe(false);
  });

  it('a reply with an unknown parent_id clears nothing', () => {
    const msgs: ChatMessage[] = [
      makeChatMessage({
        id: 'r3-1',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
      makeChatMessage({
        id: 'stray-reply',
        parent_id: 'does-not-exist',
        rule: 1,
        sender: makeAddress({ name: '@QATester', role: 'Human' }),
        recipient: makeAddress({ name: '@Manager', role: 'Manager' }),
      }),
    ];
    const result = computePendingNotifications(msgs);
    expect(result.size).toBe(1);
    expect(result.has('r3-1')).toBe(true);
  });
});
