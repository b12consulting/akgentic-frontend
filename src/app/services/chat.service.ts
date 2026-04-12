import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ChatMessage, ENTRY_POINT_NAME } from '../models/chat-message.model';

const HUMAN_ROLE = 'Human';

// [CUSTOM] Chat body and chat answer interfaces should be customized according to your API.
export interface ChatBody {
  message: string;
}

export interface ChatAnswer {
  messages: {
    kwargs: {
      content: string;
    };
  }[];
}

/**
 * One entry in a thinking bubble's tool list.
 *
 * Populated from ToolCallEvent (`done: false`) and flipped to `done: true`
 * by the matching ToolReturnEvent (same `tool_call_id`).
 */
export interface ThinkingToolEntry {
  tool_call_id: string;
  tool_name: string;
  arguments_preview: string;
  done: boolean;
}

/**
 * Per-agent thinking-bubble state (Story 4-8 / ADR-002 Decision 10).
 *
 * Lifecycle:
 *   beginThinking()    → appended (tools: [], final: false)
 *   appendToolCall()   → pushes an entry into tools
 *   markToolDone()     → flips entry.done to true
 *   finaliseOrDiscard() → if tools empty: removed; else flip final = true
 */
export interface ThinkingState {
  /** Stable UUID of the receiving agent actor (from ReceivedMessage.sender). */
  agent_id: string;
  /** Display name — header label source (e.g. "@Researcher"). */
  agent_name: string;
  /** Timestamp of the triggering ReceivedMessage — chronological anchor. */
  start_time: Date;
  /** Tool calls observed while the agent was "thinking". */
  tools: ThinkingToolEntry[];
  /** Inner BaseMessage id of the triggering ReceivedMessage — stable trackBy key
   *  across ephemeral → persistent transitions. */
  anchor_message_id: string;
  /** false while animation is active; true once finalised as chat history. */
  final: boolean;
}

/**
 * Compute pending notification state from classified chat messages (per-message).
 *
 * Scans all messages in order:
 *   - Rule 3 messages (recipient.role === 'Human' and recipient.name !== @Human)
 *     add their `message_id` (inner `BaseMessage.id`) to the unanswered set.
 *   - Any message whose `parent_id` is non-null removes that parent id from
 *     the unanswered set (a reply clears only the specific message it
 *     answers — identified by `parent_id === original.message_id`).
 *
 * This aligns the chat panel with `graph-data.service.ts#unSetHumanRequest`,
 * which performs per-request clearing on the graph-node side by matching
 * `reply.message.parent_id` against `humanRequests[*].message.id` (both INNER
 * ids). The previous implementation mistakenly keyed the unanswered set on
 * the outer `SentMessage.id` while comparing against the inner
 * `BaseMessage.parent_id` — a mismatch that caused every real-world reply to
 * silently fail to clear the chat bubble (even though the graph cleared
 * correctly). See ADR-002 Decision 4 (revision 2026-04-12).
 *
 * The clearing step runs for every message (any rule, any sender role) — the
 * reply contract is "message with `parent_id === original.message_id`", not
 * "reply whose sender role is Human".
 *
 * Pure: no side effects, no DOM, no service calls. Deterministic.
 *
 * @returns Set of inner `BaseMessage.id`s that are still unanswered.
 */
export function computePendingNotifications(
  messages: ChatMessage[],
): Set<string> {
  const unanswered = new Set<string>();

  for (const msg of messages) {
    if (
      msg.recipient.role === HUMAN_ROLE &&
      msg.recipient.name !== ENTRY_POINT_NAME
    ) {
      unanswered.add(msg.message_id);
    }
    if (msg.parent_id !== null) {
      unanswered.delete(msg.parent_id);
    }
  }

  return unanswered;
}

@Injectable()
export class ChatService {
  messages$: BehaviorSubject<ChatMessage[]> = new BehaviorSubject<ChatMessage[]>(
    []
  );
  loadingProcess$: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(
    false
  );
  replyContext$: BehaviorSubject<ChatMessage | null> =
    new BehaviorSubject<ChatMessage | null>(null);

  /** Reactive set of unanswered Rule 3 message ids (per-message tracking). */
  pendingNotifications$: Observable<Set<string>> =
    this.messages$.pipe(map(computePendingNotifications));

  /**
   * Per-agent thinking-bubble state array (Story 4-8 / ADR-002 Decision 10).
   * Each mutator below emits a fresh array reference so consumers using
   * OnPush change detection re-render reliably.
   */
  thinkingAgents$: BehaviorSubject<ThinkingState[]> = new BehaviorSubject<
    ThinkingState[]
  >([]);

  setReplyContext(message: ChatMessage | null): void {
    this.replyContext$.next(message);
  }

  clearReplyContext(): void {
    this.replyContext$.next(null);
  }

  /**
   * Append a new thinking state for an agent. Idempotent: if a non-final
   * state already exists for the same `agent_id`, this is a no-op (replay
   * safety — first ReceivedMessage wins until finalised or discarded).
   */
  beginThinking(state: Omit<ThinkingState, 'tools' | 'final'>): void {
    const current = this.thinkingAgents$.value;
    const hasNonFinal = current.some(
      (s) => s.agent_id === state.agent_id && !s.final,
    );
    if (hasNonFinal) return;
    const next: ThinkingState = {
      agent_id: state.agent_id,
      agent_name: state.agent_name,
      start_time: state.start_time,
      anchor_message_id: state.anchor_message_id,
      tools: [],
      final: false,
    };
    this.thinkingAgents$.next([...current, next]);
  }

  /**
   * Append a tool-call entry onto the non-final thinking state for `agent_id`.
   * No-op (with `console.debug`) if no such state exists — defensive against
   * tool events without a preceding ReceivedMessage.
   */
  appendToolCall(agent_id: string, entry: ThinkingToolEntry): void {
    const current = this.thinkingAgents$.value;
    const idx = current.findIndex((s) => s.agent_id === agent_id && !s.final);
    if (idx === -1) {
      console.debug(
        `[ChatService.appendToolCall] no active thinking state for ${agent_id}`,
      );
      return;
    }
    const existing = current[idx];
    const updated: ThinkingState = {
      ...existing,
      tools: [...existing.tools, entry],
    };
    const next = [...current];
    next[idx] = updated;
    this.thinkingAgents$.next(next);
  }

  /**
   * Flip the `done` flag on the matching tool entry. No-op if not found.
   */
  markToolDone(agent_id: string, tool_call_id: string): void {
    const current = this.thinkingAgents$.value;
    const idx = current.findIndex((s) => s.agent_id === agent_id && !s.final);
    if (idx === -1) return;
    const existing = current[idx];
    const toolIdx = existing.tools.findIndex(
      (t) => t.tool_call_id === tool_call_id,
    );
    if (toolIdx === -1) return;
    const updatedTools = [...existing.tools];
    updatedTools[toolIdx] = { ...updatedTools[toolIdx], done: true };
    const updated: ThinkingState = { ...existing, tools: updatedTools };
    const next = [...current];
    next[idx] = updated;
    this.thinkingAgents$.next(next);
  }

  /**
   * Resolve the thinking state for `agent_id`:
   *   - If the non-final state has no tools: REMOVE it (ephemeral exit).
   *   - Otherwise: flip `final = true` (persistent chat history).
   */
  finaliseOrDiscard(agent_id: string): void {
    const current = this.thinkingAgents$.value;
    const idx = current.findIndex((s) => s.agent_id === agent_id && !s.final);
    if (idx === -1) return;
    const existing = current[idx];
    if (existing.tools.length === 0) {
      const next = current.filter((_, i) => i !== idx);
      this.thinkingAgents$.next(next);
      return;
    }
    const updated: ThinkingState = { ...existing, final: true };
    const next = [...current];
    next[idx] = updated;
    this.thinkingAgents$.next(next);
  }
}
