import { inject, Injectable } from '@angular/core';
import { map, Observable, shareReplay, Subject } from 'rxjs';

import {
  buildClearMarker,
  buildCompactionMarker,
  ChatMessage,
  classifyMessage,
} from './chat-message.model';
import {
  AkgenticMessage,
  EventMessage,
  isEventMessage,
  isLlmContextClearedEvent,
  isLlmContextCompactedEvent,
  isSentMessage,
  isWelcomeAnnouncement,
  SentMessage,
} from '../../../protocol/message.types';
import { MessageLogService } from '../event/message-log.service';

const ACTOR_SYSTEM_ROLE = 'ActorSystem';

/**
 * Story 6.3 (FR7) — pure chat state: the classified `ChatMessage` list. It
 * preserves reference equality across no-op transitions (AC7).
 */
export interface ChatState {
  messages: ChatMessage[];
}

export const EMPTY_CHAT: ChatState = { messages: [] };

// ---------------------------------------------------------------------------
// Module-scope pure helpers. Message classification and the context-management
// markers. Each helper preserves reference equality on unchanged state (AC7);
// each is synchronous and deterministic given `log`.
// ---------------------------------------------------------------------------

/**
 * Convert a `SentMessage` envelope into a displayable `ChatMessage` — or
 * return `null` for messages that should not appear in the chat.
 */
function messageFromSent(msg: SentMessage): ChatMessage | null {
  // ADR-011 Decision 3: the welcome announcement carries an `ActorSystem`
  // transport sender but must reach the chat — admit it via the structural
  // exception.
  if (msg.sender.role === ACTOR_SYSTEM_ROLE && !isWelcomeAnnouncement(msg))
    return null;
  if (msg.message.content == null || msg.message.content === '') return null;
  return classifyMessage(msg);
}

function applyMessageFromSent(state: ChatState, msg: SentMessage): ChatState {
  const chatMsg = messageFromSent(msg);
  if (chatMsg === null) return state;
  return { ...state, messages: [...state.messages, chatMsg] };
}

/** Append a synthetic context-management marker (Epic 29 / ADR-010) at the
 *  event's log position. A passthrough branch only — no new state service. */
function applyMarker(state: ChatState, marker: ChatMessage): ChatState {
  return { ...state, messages: [...state.messages, marker] };
}

/** Pure per-message transition (Task 3.4). Returns `state` unchanged for
 *  unhandled discriminants (FR11 passthrough — AC6). */
export function chatStep(state: ChatState, msg: AkgenticMessage): ChatState {
  if (!msg?.__model__) return state;
  if (isSentMessage(msg)) return applyMessageFromSent(state, msg);
  if (isEventMessage(msg)) {
    const inner = (msg as EventMessage).event;
    // Epic 29 / ADR-010: fold context-management events into synthetic markers,
    // positioned chronologically at the event's log index.
    if (isLlmContextCompactedEvent(inner)) {
      return applyMarker(state, buildCompactionMarker(msg as EventMessage, inner));
    }
    if (isLlmContextClearedEvent(inner)) {
      return applyMarker(state, buildClearMarker(msg as EventMessage, inner));
    }
  }
  return state;
}

/**
 * Pure fold over the full log (Task 3.5). `chatFold` is fully pure per
 * Task 3.6 purity assessment: no timers, no `Date.now()`, no DOM, no
 * out-of-order retroactive corrections.
 */
export function chatFold(log: AkgenticMessage[]): ChatState {
  return log.reduce(chatStep, EMPTY_CHAT);
}

/**
 * ChatService — Story 6.3 (ADR-005 §Decision 4).
 *
 * Exposes `chat$` as a pure selector over `MessageLogService.log$`: the
 * classified messages the run-tree transcript (`RunTreeService`) pairs with the
 * run graph. Its one imperative member is the `justSent$` side channel below.
 *
 * Epic 18 (ADR-015 §2): the imperative `loadingProcess$` spinner field moved
 * ONTO `IngestionService` (which drives the spinner-floor timing), leaving
 * `ChatService` a pure selector over `MessageLogService.log$`.
 */
@Injectable()
export class ChatService {
  private readonly log: MessageLogService = inject(MessageLogService);

  readonly chat$: Observable<ChatState> = this.log.log$.pipe(
    map(chatFold),
    shareReplay(1),
  );

  /**
   * Story 19-1 (ADR-016 §Decision 1) — imperative "just-sent" side channel.
   *
   * Emits a send-origin key (a send-time timestamp string) the moment the user
   * dispatches a message from the main chat input. The transcript subscribes to
   * latch the top-anchor for the turn. This is the ONLY imperative member on the
   * service; it deliberately bypasses the pure `chat$`/`chatFold` lifecycle so
   * the top-anchor trigger is derived from the send ORIGIN, never inferred from
   * message content (which would be brittle under ADR-005 frame-batching).
   */
  private readonly justSentSubject = new Subject<string>();
  readonly justSent$: Observable<string> = this.justSentSubject.asObservable();

  /** Surface a send as the "just-sent" signal, keyed by `key` (a send-time
   *  timestamp string). Called once per dispatching `sendMessage()`. */
  emitJustSent(key: string): void {
    this.justSentSubject.next(key);
  }
}
