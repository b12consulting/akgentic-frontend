import {
  ActorAddress,
  BaseMessage,
  EventMessage,
  HandledMessage,
  ProcessedMessage,
  ReceivedMessage,
  SentMessage,
} from '../app/core/protocol/message.types';

/**
 * Log builders for the run-tree specs (Epic 55): real wire shapes from
 * `message.types.ts`, so a spec folds them through BOTH `chatFold` and
 * `runGraphFold` exactly as production does.
 *
 * Timestamps are whole seconds from a fixed origin, so `at(n)` is both the
 * wire string and the `Date`. The inner id is the one a run and a `parent_id`
 * name; the envelope id is `env-<inner>-<recipient>` — a different id space
 * (Trap 1), which is what makes a spec catch a join on the wrong one.
 */

export const ORIGIN = Date.UTC(2026, 8, 30, 10, 0, 0);
const ORCH = 'akgentic.core.messages.orchestrator';

export function ts(n: number): string {
  return new Date(ORIGIN + n * 1000).toISOString();
}

export function at(n: number): Date {
  return new Date(ts(n));
}

export function addr(name: string, role: string, agentId: string): ActorAddress {
  return {
    __actor_address__: true,
    name,
    role,
    agent_id: agentId,
    squad_id: 'squad-1',
    user_message: false,
  };
}

export const HUMAN = addr('@Human', 'Human', 'human-id');
export const MANAGER = addr('@Manager', 'Manager', 'manager-id');
export const EXPERT = addr('@Expert', 'Expert', 'expert-id');
export const ASSISTANT = addr('@Assistant', 'Assistant', 'assistant-id');
/** A human seat: Human role, not the entry point. */
export const SUPPORT = addr('@Support', 'Human', 'support-id');
const SYSTEM = addr('@ActorSystem', 'ActorSystem', 'system-id');
const ORCHESTRATOR = addr('@Orchestrator', 'Orchestrator', 'orchestrator-id');

function envelope(
  id: string,
  sender: ActorAddress,
  parentId: string | null,
  t: number,
): Omit<BaseMessage, '__model__'> {
  return {
    id,
    parent_id: parentId,
    team_id: 'team-1',
    timestamp: ts(t),
    sender,
    display_type: 'other',
    content: null,
  };
}

/** The envelope id `sent(id, …, to)` produces. */
export function envId(id: string, to: ActorAddress): string {
  return `env-${id}-${to.agent_id}`;
}

export function sent(
  id: string,
  from: ActorAddress,
  to: ActorAddress,
  parentId: string | null,
  t: number,
): SentMessage {
  return {
    ...envelope(envId(id, to), from, parentId, t),
    __model__: `${ORCH}.SentMessage`,
    message: {
      ...envelope(id, from, parentId, t),
      display_type: 'ai',
      content: `content of ${id}`,
      __model__: `${ORCH}.UserMessage`,
    },
    recipient: to,
  };
}

/** `parent_id === message_id`: `on_receive` sets the current message first. */
export function received(id: string, agent: ActorAddress, t: number): ReceivedMessage {
  return {
    ...envelope(`rcv-${id}-${agent.agent_id}`, agent, id, t),
    __model__: `${ORCH}.ReceivedMessage`,
    message_id: id,
  };
}

export function processed(id: string, agent: ActorAddress, t: number): ProcessedMessage {
  return {
    ...envelope(`proc-${id}-${agent.agent_id}`, agent, id, t),
    __model__: `${ORCH}.ProcessedMessage`,
    message_id: id,
  };
}

export function handled(
  id: string,
  agent: ActorAddress,
  parentId: string,
  t: number,
): HandledMessage {
  return {
    ...envelope(`hdl-${id}-${agent.agent_id}`, agent, parentId, t),
    __model__: `${ORCH}.HandledMessage`,
    message_id: id,
  };
}

export function toolCall(
  callId: string,
  toolName: string,
  agent: ActorAddress,
  parentId: string,
  t: number,
): EventMessage {
  return {
    ...envelope(`evt-call-${callId}`, agent, parentId, t),
    __model__: `${ORCH}.EventMessage`,
    event: {
      __model__: 'akgentic.llm.event.ToolCallEvent',
      run_id: 'llm-run',
      tool_name: toolName,
      tool_call_id: callId,
      arguments: '{}',
    },
  };
}

export function toolReturn(
  callId: string,
  toolName: string,
  agent: ActorAddress,
  parentId: string,
  t: number,
): EventMessage {
  return {
    ...envelope(`evt-ret-${callId}`, agent, parentId, t),
    __model__: `${ORCH}.EventMessage`,
    event: {
      __model__: 'akgentic.llm.event.ToolReturnEvent',
      run_id: 'llm-run',
      tool_name: toolName,
      tool_call_id: callId,
      success: true,
    },
  };
}

/** The rule-5 welcome: an `@ActorSystem` envelope around a `WelcomeMessage`. */
export function welcome(id: string, t: number): SentMessage {
  return {
    ...envelope(`env-${id}`, SYSTEM, null, t),
    __model__: `${ORCH}.SentMessage`,
    message: {
      ...envelope(id, ORCHESTRATOR, null, t),
      content: 'Welcome to the team',
      __model__: 'akgentic.team.messages.WelcomeMessage',
    },
    recipient: HUMAN,
  };
}

/** A rule-6 compaction marker source. */
export function compacted(id: string, agent: ActorAddress, t: number): EventMessage {
  return {
    ...envelope(id, agent, null, t),
    __model__: `${ORCH}.EventMessage`,
    event: {
      __model__: 'akgentic.llm.event.LlmContextCompactedEvent',
      run_id: null,
      strategy_id: 'summary',
      summary: 'the summary',
      replaced_message_count: 3,
      summarizer_prompt_version: 'v1',
      tokens_before: null,
      tokens_after: null,
    },
  };
}

/** A rule-7 clear marker source. */
export function cleared(id: string, agent: ActorAddress, t: number): EventMessage {
  return {
    ...envelope(id, agent, null, t),
    __model__: `${ORCH}.EventMessage`,
    event: {
      __model__: 'akgentic.llm.event.LlmContextClearedEvent',
      run_id: null,
      cleared_message_count: 4,
    },
  };
}
