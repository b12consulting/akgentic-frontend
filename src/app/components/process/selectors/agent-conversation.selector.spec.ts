import { agentConversation } from './agent-conversation.selector';
import { ChatMessage } from './chat-message.model';
import { ActorAddress } from '../../../protocol/message.types';

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
    message_id: id,
    parent_id: null,
    content: 'Hello world',
    sender: makeAddress({ name: '@Manager', agent_id: 'manager' }),
    recipient: makeAddress({ name: '@Worker', agent_id: 'worker' }),
    timestamp: new Date('2026-04-08T10:00:00Z'),
    rule: 4,
    alignment: 'left',
    color: 'transparent',
    collapsed: true,
    label: '@Manager ⇒ @Worker',
    ...overrides,
  };
}

describe('agentConversation', () => {
  const managerToWorker = makeChatMessage({ id: 'm1' });
  const workerToManager = makeChatMessage({
    id: 'm2',
    sender: makeAddress({ name: '@Worker', agent_id: 'worker' }),
    recipient: makeAddress({ name: '@Manager', agent_id: 'manager' }),
  });
  const managerToResearcher = makeChatMessage({
    id: 'm3',
    recipient: makeAddress({ name: '@Researcher', agent_id: 'researcher' }),
  });

  it('keeps the turns the agent SENT', () => {
    const out = agentConversation(
      [managerToWorker, workerToManager, managerToResearcher],
      'manager',
    );
    expect(out.map((m) => m.id)).toContain('m1');
    expect(out.map((m) => m.id)).toContain('m3');
  });

  it('keeps the turns the agent RECEIVED', () => {
    // A dialogue is two-sided. The half the agent was answering is the reason
    // it said anything at all, so a sender-only filter reads as a monologue.
    const out = agentConversation([managerToWorker, workerToManager], 'worker');
    expect(out.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('drops the turns the agent was not on either end of', () => {
    const out = agentConversation(
      [managerToWorker, workerToManager, managerToResearcher],
      'worker',
    );
    expect(out.map((m) => m.id)).not.toContain('m3');
  });

  it('preserves the log order', () => {
    const out = agentConversation(
      [managerToResearcher, managerToWorker, workerToManager],
      'manager',
    );
    expect(out.map((m) => m.id)).toEqual(['m3', 'm1', 'm2']);
  });

  it('matches on agent_id, not on the display name', () => {
    // Two agents can carry the same actor name; only `agent_id` is the identity
    // the graph nodes and the app's selection are keyed by.
    const twin = makeChatMessage({
      id: 'twin',
      sender: makeAddress({ name: '@Manager', agent_id: 'manager-2' }),
    });
    const out = agentConversation([managerToWorker, twin], 'manager');
    expect(out.map((m) => m.id)).toEqual(['m1']);
  });

  it('returns the context markers of that agent only', () => {
    // Rules 6/7 carry the emitting agent as both ends of the envelope.
    const marker = makeChatMessage({
      id: 'marker',
      rule: 6,
      sender: makeAddress({ agent_id: 'worker' }),
      recipient: makeAddress({ agent_id: 'worker' }),
    });
    expect(agentConversation([marker], 'worker').map((m) => m.id)).toEqual([
      'marker',
    ]);
    expect(agentConversation([marker], 'manager')).toEqual([]);
  });

  it('returns nothing for an agent that never ran', () => {
    // Not an error state: a team lists agents that have not spoken.
    expect(agentConversation([managerToWorker], 'silent-agent')).toEqual([]);
  });

  it('returns nothing when no agent is selected', () => {
    expect(agentConversation([managerToWorker], null)).toEqual([]);
    expect(agentConversation([managerToWorker], '')).toEqual([]);
  });

  it('does not mutate or reorder the input', () => {
    const input = [managerToWorker, workerToManager];
    const snapshot = [...input];
    agentConversation(input, 'manager');
    expect(input).toEqual(snapshot);
  });
});
