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
 * Compute pending notification state from classified chat messages.
 * Scans all messages in order. Rule 3 messages (to a non-@Human human) add
 * to the pending map. A reply from the human recipient to the original sender
 * clears the entire agent pair.
 *
 * @returns Map keyed by "senderName->recipientName" with list of unanswered messages.
 */
export function computePendingNotifications(
  messages: ChatMessage[],
): Map<string, ChatMessage[]> {
  const pending = new Map<string, ChatMessage[]>();

  for (const msg of messages) {
    // Rule 3 messages: requests to non-entry-point humans
    if (
      msg.recipient?.role === HUMAN_ROLE &&
      msg.recipient?.name !== ENTRY_POINT_NAME
    ) {
      const pairKey = `${msg.sender.name}->${msg.recipient.name}`;
      const existing = pending.get(pairKey) ?? [];
      existing.push(msg);
      pending.set(pairKey, existing);
    }

    // Reply from a non-entry-point human clears the reverse pair
    if (
      msg.sender?.role === HUMAN_ROLE &&
      msg.sender?.name !== ENTRY_POINT_NAME
    ) {
      const reversePairKey = `${msg.recipient.name}->${msg.sender.name}`;
      pending.delete(reversePairKey);
    }
  }

  return pending;
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

  /** Reactive map of pending notifications keyed by agent pair. */
  pendingNotifications$: Observable<Map<string, ChatMessage[]>> =
    this.messages$.pipe(map(computePendingNotifications));

  setReplyContext(message: ChatMessage | null): void {
    this.replyContext$.next(message);
  }

  clearReplyContext(): void {
    this.replyContext$.next(null);
  }
}
