import { ChatService, computePendingNotifications } from './chat.service';
import { ChatMessage } from '../models/chat-message.model';
import { ActorAddress } from '../models/message.types';

function makeAddress(overrides: Partial<ActorAddress> = {}): ActorAddress {
  return {
    __actor_address__: true,
    address: 'addr',
    name: '@Agent',
    role: 'Worker',
    agent_id: 'agent-1',
    squad_id: 'squad-1',
    user_message: false,
    ...overrides,
  };
}

function makeChatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
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

  describe('pendingNotifications$', () => {
    it('should emit empty map initially', (done) => {
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
        expect(pending.get('@Manager->@QATester')?.length).toBe(1);
        done();
      });
    });

    it('should reactively update when messages$ changes', () => {
      const emitted: Map<string, ChatMessage[]>[] = [];
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
    });
  });
});

describe('computePendingNotifications', () => {
  it('should return empty map for empty messages', () => {
    const result = computePendingNotifications([]);
    expect(result.size).toBe(0);
  });

  it('should track Rule 3 messages as pending', () => {
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
    expect(result.get('@Manager->@QATester')?.length).toBe(1);
  });

  it('should accumulate multiple messages for same agent pair', () => {
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
    expect(result.get('@Manager->@QATester')?.length).toBe(3);
  });

  it('should clear all pending when human replies (AC #2, #3)', () => {
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
      // QATester replies to Manager
      makeChatMessage({
        id: 'reply-1',
        rule: 1,
        sender: makeAddress({ name: '@QATester', role: 'Human' }),
        recipient: makeAddress({ name: '@Manager', role: 'Manager' }),
      }),
    ];
    const result = computePendingNotifications(msgs);
    expect(result.has('@Manager->@QATester')).toBe(false);
    expect(result.size).toBe(0);
  });

  it('should re-add notifications after reply if new messages arrive (AC #2)', () => {
    const msgs: ChatMessage[] = [
      makeChatMessage({
        id: 'r3-1',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
      // QATester replies
      makeChatMessage({
        id: 'reply-1',
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
    expect(result.get('@Manager->@QATester')?.length).toBe(1);
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
    expect(result.get('@Manager->@QATester')?.length).toBe(1);
    expect(result.get('@Worker->@QATester')?.length).toBe(1);
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

  it('should NOT clear when @Human entry point replies', () => {
    const msgs: ChatMessage[] = [
      makeChatMessage({
        id: 'r3-1',
        rule: 3,
        sender: makeAddress({ name: '@Manager', role: 'Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
      }),
      // @Human sends a message (entry point user) - should NOT clear QATester notifications
      makeChatMessage({
        id: 'user-1',
        rule: 1,
        sender: makeAddress({ name: '@Human', role: 'Human' }),
        recipient: makeAddress({ name: '@Manager', role: 'Manager' }),
      }),
    ];
    const result = computePendingNotifications(msgs);
    expect(result.size).toBe(1);
    expect(result.get('@Manager->@QATester')?.length).toBe(1);
  });

  it('reply clears only the specific agent pair, not others', () => {
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
      // QATester replies to Manager only
      makeChatMessage({
        id: 'reply-1',
        rule: 1,
        sender: makeAddress({ name: '@QATester', role: 'Human' }),
        recipient: makeAddress({ name: '@Manager', role: 'Manager' }),
      }),
    ];
    const result = computePendingNotifications(msgs);
    expect(result.has('@Manager->@QATester')).toBe(false);
    expect(result.has('@Worker->@QATester')).toBe(true);
    expect(result.get('@Worker->@QATester')?.length).toBe(1);
  });
});
