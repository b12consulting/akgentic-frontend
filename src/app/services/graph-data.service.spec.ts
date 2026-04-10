import { GraphBuilder, HUMAN_ROLE } from './graph-data.service';
import { ENTRY_POINT_NAME } from '../models/chat-message.model';
import {
  ActorAddress,
  AkgenticMessage,
  SentMessage,
  BaseMessage,
} from '../models/message.types';
import { NodeInterface } from '../models/types';

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

function makeBaseMessage(
  overrides: Partial<BaseMessage> = {}
): BaseMessage {
  return {
    id: 'msg-inner-1',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-08T10:00:00Z',
    sender: makeAddress(),
    display_type: 'other',
    content: 'test',
    __model__: 'akgentic.core.messages.orchestrator.BaseMessage',
    ...overrides,
  };
}

function makeSentMessage(
  overrides: Partial<SentMessage> = {}
): SentMessage {
  return {
    id: 'msg-1',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-08T10:00:00Z',
    sender: makeAddress({ name: '@Manager', role: 'Manager', agent_id: 'manager-1' }),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.SentMessage',
    message: makeBaseMessage(),
    recipient: makeAddress({ name: '@QATester', role: 'Human', agent_id: 'qa-1' }),
    ...overrides,
  };
}

function makeNode(overrides: Partial<NodeInterface> = {}): NodeInterface {
  return {
    name: 'manager-1',
    role: 'Manager',
    actorName: '@Manager',
    parentId: 'parent-1',
    squadId: 'squad-1',
    symbol: 'roundRect',
    category: 0,
    userMessage: false,
    ...overrides,
  };
}

describe('ENTRY_POINT_NAME constant', () => {
  it('should be defined as @Human', () => {
    expect(ENTRY_POINT_NAME).toBe('@Human');
  });

  it('should differ from HUMAN_ROLE (no @ prefix)', () => {
    expect(HUMAN_ROLE).toBe('Human');
    expect(ENTRY_POINT_NAME).not.toBe(HUMAN_ROLE);
  });
});

describe('GraphBuilder.setHumanRequest', () => {
  it('should add notification for non-entry-point human recipient', () => {
    const msg = makeSentMessage({
      recipient: makeAddress({ name: '@QATester', role: 'Human', agent_id: 'qa-1' }),
      message: makeBaseMessage({ display_type: 'other' }),
    });
    const builder = new GraphBuilder(msg);
    const nodes = [makeNode({ name: 'manager-1', actorName: '@Manager' })];

    builder.setHumanRequest(nodes);

    expect(nodes[0].humanRequests).toBeDefined();
    expect(nodes[0].humanRequests!.length).toBe(1);
    expect(nodes[0].humanRequests![0]).toBe(msg);
  });

  it('should skip notification when recipient is @Human entry point (AC #1)', () => {
    const msg = makeSentMessage({
      recipient: makeAddress({ name: '@Human', role: 'Human', agent_id: 'human-1' }),
      message: makeBaseMessage({ display_type: 'other' }),
    });
    const builder = new GraphBuilder(msg);
    const nodes = [makeNode({ name: 'manager-1', actorName: '@Manager' })];

    builder.setHumanRequest(nodes);

    expect(nodes[0].humanRequests).toBeUndefined();
  });

  it('should skip when recipient role does not include Human', () => {
    const msg = makeSentMessage({
      recipient: makeAddress({ name: '@Worker', role: 'Worker', agent_id: 'worker-1' }),
      message: makeBaseMessage({ display_type: 'other' }),
    });
    const builder = new GraphBuilder(msg);
    const nodes = [makeNode({ name: 'manager-1', actorName: '@Manager' })];

    builder.setHumanRequest(nodes);

    expect(nodes[0].humanRequests).toBeUndefined();
  });

  it('should skip when display_type is not other', () => {
    const msg = makeSentMessage({
      recipient: makeAddress({ name: '@QATester', role: 'Human', agent_id: 'qa-1' }),
      message: makeBaseMessage({ display_type: 'human' }),
    });
    const builder = new GraphBuilder(msg);
    const nodes = [makeNode({ name: 'manager-1', actorName: '@Manager' })];

    builder.setHumanRequest(nodes);

    expect(nodes[0].humanRequests).toBeUndefined();
  });

  it('should skip when message is not a SentMessage', () => {
    const msg = makeBaseMessage({
      __model__: 'akgentic.core.messages.orchestrator.ReceivedMessage',
    }) as unknown as AkgenticMessage;
    const builder = new GraphBuilder(msg);
    const nodes = [makeNode({ name: 'manager-1', actorName: '@Manager' })];

    builder.setHumanRequest(nodes);

    expect(nodes[0].humanRequests).toBeUndefined();
  });

  it('should not fail when sender node is not in the nodes array', () => {
    const msg = makeSentMessage({
      sender: makeAddress({ name: '@Unknown', role: 'Worker', agent_id: 'unknown-1' }),
      recipient: makeAddress({ name: '@QATester', role: 'Human', agent_id: 'qa-1' }),
      message: makeBaseMessage({ display_type: 'other' }),
    });
    const builder = new GraphBuilder(msg);
    const nodes = [makeNode({ name: 'manager-1', actorName: '@Manager' })];

    builder.setHumanRequest(nodes);

    // No node matched the sender, so no humanRequests should be set
    expect(nodes[0].humanRequests).toBeUndefined();
  });
});

describe('GraphBuilder.unSetHumanRequest', () => {
  it('should clear notification by parent_id for non-entry-point human (AC #3)', () => {
    const originalMsg = makeSentMessage({
      id: 'sent-1',
      message: makeBaseMessage({ id: 'inner-1', display_type: 'other' }),
      recipient: makeAddress({ name: '@QATester', role: 'Human', agent_id: 'qa-1' }),
    });
    const replyMsg = makeSentMessage({
      id: 'reply-1',
      sender: makeAddress({ name: '@QATester', role: 'Human', agent_id: 'qa-1' }),
      recipient: makeAddress({ name: '@Manager', role: 'Manager', agent_id: 'manager-1' }),
      message: makeBaseMessage({ parent_id: 'inner-1' }),
    });

    const nodes = [
      makeNode({
        name: 'manager-1',
        actorName: '@Manager',
        humanRequests: [originalMsg],
      }),
    ];

    const builder = new GraphBuilder(replyMsg);
    builder.unSetHumanRequest(nodes);

    expect(nodes[0].humanRequests!.length).toBe(0);
  });

  it('should not affect nodes when @Human entry point never had notifications set', () => {
    // Since @Human messages are guarded from setHumanRequest, unSetHumanRequest
    // should gracefully handle the case where no matching request exists
    const replyMsg = makeSentMessage({
      id: 'reply-1',
      sender: makeAddress({ name: '@Human', role: 'Human', agent_id: 'human-1' }),
      recipient: makeAddress({ name: '@Manager', role: 'Manager', agent_id: 'manager-1' }),
      message: makeBaseMessage({ parent_id: 'some-id' }),
    });

    const nodes = [makeNode({ name: 'manager-1', actorName: '@Manager' })];

    const builder = new GraphBuilder(replyMsg);
    builder.unSetHumanRequest(nodes);

    // No humanRequests should exist since none were set
    expect(nodes[0].humanRequests).toBeUndefined();
  });
});
