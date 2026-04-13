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

  setReplyContext(message: ChatMessage | null): void {
    this.replyContext$.next(message);
  }

  clearReplyContext(): void {
    this.replyContext$.next(null);
  }
}
