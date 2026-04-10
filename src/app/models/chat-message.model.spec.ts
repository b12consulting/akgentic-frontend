import {
  classifyRule,
  buildLabel,
  classifyMessage,
  ENTRY_POINT_NAME,
  ChatMessage,
} from './chat-message.model';
import { ActorAddress, SentMessage, BaseMessage } from './message.types';

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
  const recipient = overrides.recipient ?? makeAddress({ name: '@Manager', role: 'Manager' });
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

describe('ENTRY_POINT_NAME', () => {
  it('should be @Human', () => {
    expect(ENTRY_POINT_NAME).toBe('@Human');
  });
});

describe('classifyRule', () => {
  it('Rule 1: sender is @Human', () => {
    const msg = makeSentMessage({
      sender: makeAddress({ name: '@Human', role: 'Human' }),
      recipient: makeAddress({ name: '@Manager', role: 'Manager' }),
    });
    expect(classifyRule(msg)).toBe(1);
  });

  it('Rule 2: recipient is @Human', () => {
    const msg = makeSentMessage({
      sender: makeAddress({ name: '@Manager', role: 'Manager' }),
      recipient: makeAddress({ name: '@Human', role: 'Human' }),
    });
    expect(classifyRule(msg)).toBe(2);
  });

  it('Rule 3: recipient role is Human but name is not @Human', () => {
    const msg = makeSentMessage({
      sender: makeAddress({ name: '@Agent', role: 'Worker' }),
      recipient: makeAddress({ name: '@OtherHuman', role: 'Human' }),
    });
    expect(classifyRule(msg)).toBe(3);
  });

  it('Rule 4: AI-to-AI (no Human involved)', () => {
    const msg = makeSentMessage({
      sender: makeAddress({ name: '@Worker', role: 'Worker' }),
      recipient: makeAddress({ name: '@Manager', role: 'Manager' }),
    });
    expect(classifyRule(msg)).toBe(4);
  });

  it('first-match wins: sender @Human takes priority even if recipient is also @Human', () => {
    const msg = makeSentMessage({
      sender: makeAddress({ name: '@Human', role: 'Human' }),
      recipient: makeAddress({ name: '@Human', role: 'Human' }),
    });
    expect(classifyRule(msg)).toBe(1);
  });

  it('Rule 2 takes priority over Rule 3 when recipient name is @Human', () => {
    const msg = makeSentMessage({
      sender: makeAddress({ name: '@Worker', role: 'Worker' }),
      recipient: makeAddress({ name: '@Human', role: 'Human' }),
    });
    expect(classifyRule(msg)).toBe(2);
  });
});

describe('buildLabel', () => {
  it('Rule 1: "You -> {recipient}"', () => {
    const msg = makeSentMessage({
      sender: makeAddress({ name: '@Human', role: 'Human' }),
      recipient: makeAddress({ name: '@Manager-manager', role: 'Manager' }),
    });
    const label = buildLabel(msg, 1);
    expect(label).toContain('You ->');
    expect(label).toContain('Manager');
  });

  it('Rule 2: just sender name', () => {
    const msg = makeSentMessage({
      sender: makeAddress({ name: '@Manager-manager', role: 'Manager' }),
      recipient: makeAddress({ name: '@Human', role: 'Human' }),
    });
    const label = buildLabel(msg, 2);
    expect(label).not.toContain('->');
    expect(label).toContain('Manager');
  });

  it('Rule 3: "@{sender} -> @{recipient}"', () => {
    const msg = makeSentMessage({
      sender: makeAddress({ name: '@Agent-worker', role: 'Worker' }),
      recipient: makeAddress({ name: '@OtherHuman-human', role: 'Human' }),
    });
    const label = buildLabel(msg, 3);
    expect(label).toContain('->');
    expect(label).toContain('Agent');
    expect(label).toContain('OtherHuman');
  });

  it('Rule 4: "@{sender} -> @{recipient}"', () => {
    const msg = makeSentMessage({
      sender: makeAddress({ name: '@Worker-worker', role: 'Worker' }),
      recipient: makeAddress({ name: '@Manager-manager', role: 'Manager' }),
    });
    const label = buildLabel(msg, 4);
    expect(label).toContain('->');
    expect(label).toContain('Worker');
    expect(label).toContain('Manager');
  });
});

describe('classifyMessage', () => {
  it('should return a ChatMessage with correct fields for Rule 1', () => {
    const msg = makeSentMessage({
      sender: makeAddress({ name: '@Human', role: 'Human' }),
      recipient: makeAddress({ name: '@Manager', role: 'Manager' }),
    });
    const result: ChatMessage = classifyMessage(msg);

    expect(result.id).toBe('msg-1');
    expect(result.content).toBe('test content');
    expect(result.rule).toBe(1);
    expect(result.alignment).toBe('right');
    expect(result.color).toBe('#efeeee');
    expect(result.collapsed).toBe(false);
    expect(result.label).toContain('You ->');
  });

  it('should return a ChatMessage with correct fields for Rule 4 (collapsed)', () => {
    const msg = makeSentMessage({
      sender: makeAddress({ name: '@Worker', role: 'Worker' }),
      recipient: makeAddress({ name: '@Manager', role: 'Manager' }),
    });
    const result: ChatMessage = classifyMessage(msg);

    expect(result.rule).toBe(4);
    expect(result.alignment).toBe('left');
    expect(result.color).toBe('#9ebbcb');
    expect(result.collapsed).toBe(true);
  });

  it('should handle null content gracefully', () => {
    const msg = makeSentMessage({
      sender: makeAddress({ name: '@Human', role: 'Human' }),
      recipient: makeAddress({ name: '@Manager', role: 'Manager' }),
    });
    msg.message = makeBaseMessage({ content: null });
    const result = classifyMessage(msg);
    expect(result.content).toBe('');
  });

  it('should set timestamp as Date object', () => {
    const msg = makeSentMessage({
      sender: makeAddress({ name: '@Human', role: 'Human' }),
    });
    const result = classifyMessage(msg);
    expect(result.timestamp instanceof Date).toBe(true);
  });
});
