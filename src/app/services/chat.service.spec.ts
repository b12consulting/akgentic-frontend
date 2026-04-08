import { ChatService } from './chat.service';
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
});
