/**
 * TypeScript definitions for Akgentic message types
 * Based on orchestrator.py and message.py Python classes
 */

export interface ActorAddress {
  __actor_address__: true;
  address: string;
  name: string;
  role: string;
  agent_id: string;
  squad_id: string;
  user_message: boolean;
}

export interface BaseConfig {
  name: string;
  role: string;
  user_id: string;
  user_email: string;
  squad_id: string;
  team_id: string;
  parent?: ActorAddress;
  orchestrator: ActorAddress;
}

export interface BaseState {
  [key: string]: any;
}

export interface BaseMessage {
  id: string;
  parent_id: string | null;
  team_id: string;
  timestamp: string;
  sender: ActorAddress;
  display_type: 'human' | 'ai' | 'other';
  content: string | null;
  __model__: string;
}

// Core message types from orchestrator.py

export interface NotificationMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.NotificationMessage';
  subject: string;
  content: string;
}

export interface SentMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.SentMessage';
  message: BaseMessage;
  recipient: ActorAddress;
}

export interface ReceivedMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.ReceivedMessage';
  message: BaseMessage;
}

export interface ProcessedMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.ProcessedMessage';
  message_id: string;
}

export interface StartMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.StartMessage';
  config: BaseConfig;
  parent: ActorAddress;
}

export interface StopMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.StopMessage';
}

export interface ErrorMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.ErrorMessage';
  exception_type: string;
  exception_value: string;
  current_aktion?: string;
  current_message?: BaseMessage;
}

export interface ContextChangedMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.ContextChangedMessage';
  messages: any[]; // LangChain AnyMessage type
  err?: Error;
}

export interface StateChangedMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.StateChangedMessage';
  state: BaseState | Record<string, any>;
  err?: Error;
}

export interface ToolUpdateMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.ToolUpdateMessage';
  tool: string;
  data: any;
  metadata?: { [key: string]: any };
}

// Additional message types that might be used

export interface UserMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.UserMessage';
  content: string;
}

export interface ResultMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.ResultMessage';
  content: string;
}

// Union type for all possible messages
export type AkgenticMessage =
  | NotificationMessage
  | SentMessage
  | ReceivedMessage
  | ProcessedMessage
  | StartMessage
  | StopMessage
  | ErrorMessage
  | ContextChangedMessage
  | StateChangedMessage
  | ToolUpdateMessage
  | UserMessage
  | ResultMessage;

// Type guards for message discrimination
export function isNotificationMessage(
  msg: BaseMessage,
): msg is NotificationMessage {
  return msg.__model__.includes('NotificationMessage');
}

export function isSentMessage(msg: BaseMessage): msg is SentMessage {
  return msg.__model__.includes('SentMessage');
}

export function isReceivedMessage(msg: BaseMessage): msg is ReceivedMessage {
  return msg.__model__.includes('ReceivedMessage');
}

export function isProcessedMessage(msg: BaseMessage): msg is ProcessedMessage {
  return msg.__model__.includes('ProcessedMessage');
}

export function isStartMessage(msg: BaseMessage): msg is StartMessage {
  return msg.__model__.includes('StartMessage');
}

export function isStopMessage(msg: BaseMessage): msg is StopMessage {
  return msg.__model__.includes('StopMessage');
}

export function isErrorMessage(msg: BaseMessage): msg is ErrorMessage {
  return msg.__model__.includes('ErrorMessage');
}

export function isContextChangedMessage(
  msg: BaseMessage,
): msg is ContextChangedMessage {
  return msg.__model__.includes('ContextChangedMessage');
}

export function isStateChangedMessage(
  msg: BaseMessage,
): msg is StateChangedMessage {
  return msg.__model__.includes('StateChangedMessage');
}

export function isToolUpdateMessage(
  msg: BaseMessage,
): msg is ToolUpdateMessage {
  return msg.__model__.includes('ToolUpdateMessage');
}

export function isUserMessage(msg: BaseMessage): msg is UserMessage {
  return msg.__model__.includes('UserMessage');
}

export function isResultMessage(msg: BaseMessage): msg is ResultMessage {
  return msg.__model__.includes('ResultMessage');
}
