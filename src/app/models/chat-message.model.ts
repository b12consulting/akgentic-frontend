import { ActorAddress, SentMessage } from './message.types';
import { makeAgentNameUserFriendly } from '../lib/util';

export const ENTRY_POINT_NAME = '@Human';

export type MessageRule = 1 | 2 | 3 | 4;

export interface ChatMessage {
  id: string;
  content: string;
  sender: ActorAddress;
  recipient: ActorAddress;
  timestamp: Date;
  rule: MessageRule;
  alignment: 'left' | 'right';
  color: string;
  collapsed: boolean;
  label: string;
}

/**
 * Classify a SentMessage into one of 4 rules (first-match wins):
 *   Rule 1: sender is @Human -> right-aligned, persona color
 *   Rule 2: recipient is @Human -> left-aligned, blue
 *   Rule 3: recipient role is Human but not @Human -> left-aligned, blue, notification
 *   Rule 4: everything else (AI-to-AI) -> left-aligned, blue, collapsed
 */
export function classifyRule(msg: SentMessage): MessageRule {
  if (msg.sender.name === ENTRY_POINT_NAME) return 1;
  if (msg.recipient.name === ENTRY_POINT_NAME) return 2;
  if (msg.recipient.role === 'Human' && msg.recipient.name !== ENTRY_POINT_NAME) return 3;
  return 4;
}

/**
 * Build a display label per ADR-002 Decision 6:
 *   Rule 1: "You -> @{recipient}" (using makeAgentNameUserFriendly)
 *   Rule 2: "@{sender}" (recipient is implicit)
 *   Rule 3: "@{sender} -> @{recipient}"
 *   Rule 4: "@{sender} -> @{recipient}"
 */
export function buildLabel(msg: SentMessage, rule: MessageRule): string {
  const senderName = makeAgentNameUserFriendly(msg.sender.name);
  const recipientName = makeAgentNameUserFriendly(msg.recipient.name);

  switch (rule) {
    case 1:
      return `You -> ${recipientName}`;
    case 2:
      return senderName;
    case 3:
    case 4:
      return `${senderName} -> ${recipientName}`;
  }
}

const RULE_COLORS: Record<MessageRule, string> = {
  1: '#efeeee',
  2: '#9ebbcb',
  3: '#9ebbcb',
  4: '#9ebbcb',
};

/**
 * Convert a SentMessage into a ChatMessage with full classification.
 */
export function classifyMessage(msg: SentMessage): ChatMessage {
  const rule = classifyRule(msg);
  return {
    id: msg.id,
    content: msg.message.content ?? '',
    sender: msg.sender,
    recipient: msg.recipient,
    timestamp: new Date(msg.timestamp),
    rule,
    alignment: rule === 1 ? 'right' : 'left',
    color: RULE_COLORS[rule],
    collapsed: rule === 3 || rule === 4,
    label: buildLabel(msg, rule),
  };
}
