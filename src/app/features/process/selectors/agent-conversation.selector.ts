import { ChatMessage } from './chat-message.model';

/**
 * The turns one agent SENT OR RECEIVED.
 *
 * A sub-agent's dialogue is two-sided. Filtering on the sender alone produces a
 * monologue — the agent's half of an exchange whose other half is the reason it
 * said any of it — so both ends of the envelope are matched.
 *
 * THIS IS A RENDERING RULE OVER THE LOG THE CLIENT ALREADY HOLDS, and nothing
 * more. It is deliberately NOT "every turn this agent could see": an agent's
 * inbox includes traffic it absorbed mid-run, and what an agent was shown is a
 * backend concept that no filter over `SentMessage` envelopes can answer. Read
 * as "who was on this envelope", it is exactly true; read as visibility, it
 * would be a claim this layer cannot make.
 *
 * Matching is on `agent_id`, not on the actor name: `agent_id` is the identity
 * the graph nodes and `AkgentService` selection are keyed by, and two agents can
 * share a display name.
 *
 * The synthetic context-management markers (rules 6 and 7) carry the emitting
 * agent as BOTH sender and recipient, so they land in that agent's reader and
 * nobody else's — which is where a compaction or a clear belongs.
 *
 * Pure: no mutation of the input, no service calls, no DOM.
 */
export function agentConversation(
  messages: readonly ChatMessage[],
  agentId: string | null | undefined,
): ChatMessage[] {
  if (!agentId) return [];
  return messages.filter(
    (m) => m.sender.agent_id === agentId || m.recipient.agent_id === agentId,
  );
}
