import { inject, Injectable } from '@angular/core';
import {
  distinctUntilChanged,
  map,
  Observable,
  shareReplay,
  Subject,
} from 'rxjs';

import {
  buildClearMarker,
  buildCompactionMarker,
  buildPreview,
  ChatMessage,
  classifyMessage,
  ENTRY_POINT_NAME,
} from './chat-message.model';
import {
  AkgenticMessage,
  EventMessage,
  HandledMessage,
  isEventMessage,
  isHandledMessage,
  isLlmContextClearedEvent,
  isLlmContextCompactedEvent,
  isProcessedMessage,
  isReceivedMessage,
  isSentMessage,
  isWelcomeAnnouncement,
  ProcessedMessage,
  ReceivedMessage,
  SentMessage,
} from '../../../protocol/message.types';
import { MessageLogService } from '../event/message-log.service';

const HUMAN_ROLE = 'Human';
const ACTOR_SYSTEM_ROLE = 'ActorSystem';

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
 * Story 6.3 (FR7) reshaped the lifecycle as a pure fold over `log$`:
 *   ReceivedMessage             → appended (tools: [], final: false)
 *   EventMessage+ToolCallEvent  → pushes an entry into tools
 *   EventMessage+ToolReturnEvent → flips entry.done to true
 *   SentMessage                 → if tools empty: removed; else final = true
 *   ProcessedMessage            → if tools empty: removed; else final = true
 *
 * Story 44-1 (ADR-032 §D2) added one more transition:
 *   HandledMessage              → closes the live state (same rule as above)
 *                                 and opens a successor anchored on the
 *                                 absorbed message.
 */
export interface ThinkingState {
  /** Stable UUID of the receiving agent actor (from ReceivedMessage.sender). */
  agent_id: string;
  /** Display name — header label source (e.g. "@Researcher"). */
  agent_name: string;
  /** Timestamp of the message that opened this bubble — chronological anchor.
   *  The triggering ReceivedMessage, or the HandledMessage that split a
   *  predecessor open (ADR-032 §D4). */
  start_time: Date;
  /** Tool calls observed while the agent was "thinking". */
  tools: ThinkingToolEntry[];
  /** Inner BaseMessage id of the message this bubble is working on — stable
   *  trackBy key across ephemeral → persistent transitions.
   *
   *  Two producers, one id space (ADR-032 §D3): the triggering
   *  `ReceivedMessage.message_id` for a bubble opened on a turn of its own, and
   *  `HandledMessage.message_id` — the id of the message absorbed mid-run — for
   *  a successor bubble opened by the split. Both name the user message the
   *  bubble is answering, which is why the split needs no second identity
   *  field. */
  anchor_message_id: string;
  /** false while animation is active; true once finalised as chat history. */
  final: boolean;
}

/**
 * Story 6.3 (FR7) — pure chat state. `messages` holds the classified
 * `ChatMessage` list; `thinkingAgents` tracks the per-agent thinking-bubble
 * lifecycle. Both slices preserve reference equality across no-op transitions
 * (AC7).
 */
export interface ChatState {
  messages: ChatMessage[];
  thinkingAgents: ThinkingState[];
}

export const EMPTY_CHAT: ChatState = { messages: [], thinkingAgents: [] };

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
 * Pure: no side effects, no DOM, no service calls. Deterministic.
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

// ---------------------------------------------------------------------------
// Module-scope pure helpers (Task 3.2–3.5). Thinking-bubble lifecycle +
// message classification. Each helper preserves reference equality on
// unchanged slices (AC7); each is synchronous and deterministic given `log`.
// ---------------------------------------------------------------------------

/**
 * Convert a `SentMessage` envelope into a displayable `ChatMessage` — or
 * return `null` for messages that should not appear in the chat panel. Mirrors
 * the classification previously performed by `ChatPanelComponent.ngOnInit`.
 */
function messageFromSent(msg: SentMessage): ChatMessage | null {
  // ADR-011 Decision 3: the welcome announcement carries an `ActorSystem`
  // transport sender but must reach the chat panel — admit it via the
  // structural exception. `applySentToThinking` deliberately keeps the plain
  // `ACTOR_SYSTEM_ROLE` early-return so the welcome message spawns no
  // thinking bubble.
  if (msg.sender.role === ACTOR_SYSTEM_ROLE && !isWelcomeAnnouncement(msg))
    return null;
  if (msg.message.content == null || msg.message.content === '') return null;
  return classifyMessage(msg);
}

function applyReceivedToThinking(
  state: ChatState,
  msg: ReceivedMessage,
): ChatState {
  // HumanProxy agents wait for user input, not "thinking". Skip bubble.
  if (msg.sender.role === HUMAN_ROLE) return state;
  const hasNonFinal = state.thinkingAgents.some(
    (s) => s.agent_id === msg.sender.agent_id && !s.final,
  );
  if (hasNonFinal) return state;
  const next: ThinkingState = {
    agent_id: msg.sender.agent_id,
    agent_name: msg.sender.name,
    start_time: new Date(msg.timestamp),
    anchor_message_id: msg.message_id,
    tools: [],
    final: false,
  };
  return {
    ...state,
    thinkingAgents: [...state.thinkingAgents, next],
  };
}

/**
 * Split the agent's live thinking bubble on an absorbed message (ADR-032 §D2).
 *
 * A message pulled out of the inbox mid-run never gets a turn of its own, so it
 * emits neither `ReceivedMessage` nor `ProcessedMessage`; without this branch
 * one bubble stands for two conversations and sorts above the message it
 * answers. The predecessor is closed through the SAME `finaliseThinking` the
 * `Sent`/`Processed` branches use (§D2a) — one place decides what closing means,
 * and an empty predecessor (a `/stop` purged before any tool call) is removed
 * rather than left final and empty forever.
 *
 * The successor is opened eagerly and may stay empty; `finaliseThinking`'s
 * existing remove-if-no-tools rule deletes it at `Sent`/`Processed` (§D5). No
 * message CLASS is inspected here — a cancel purge is a `HandledMessage` like
 * any other.
 */
function applyHandledToThinking(
  state: ChatState,
  msg: HandledMessage,
): ChatState {
  const agentId = msg.sender.agent_id;
  const live = state.thinkingAgents.find(
    (s) => s.agent_id === agentId && !s.final,
  );
  // No live bubble to split — identity no-op (AC7 reference equality).
  if (!live) return state;
  const closed = finaliseThinking(state, agentId);
  const successor: ThinkingState = {
    agent_id: agentId,
    agent_name: live.agent_name,
    // The HandledMessage's own timestamp: this is what sorts the successor
    // BELOW the absorbed message's own SentMessage in `buildDisplayItems`.
    start_time: new Date(msg.timestamp),
    anchor_message_id: msg.message_id,
    tools: [],
    final: false,
  };
  return {
    ...closed,
    thinkingAgents: [...closed.thinkingAgents, successor],
  };
}

function applyToolCallToThinking(
  state: ChatState,
  msg: EventMessage,
): ChatState {
  const agentId = msg.sender?.agent_id;
  const inner = msg.event;
  if (!agentId || !inner) return state;
  const idx = state.thinkingAgents.findIndex(
    (s) => s.agent_id === agentId && !s.final,
  );
  if (idx === -1) {
    console.debug(
      `[ChatService.applyToolCallToThinking] no active thinking state for ${agentId}`,
    );
    return state;
  }
  const existing = state.thinkingAgents[idx];
  const entry: ThinkingToolEntry = {
    tool_call_id: inner.tool_call_id,
    tool_name: inner.tool_name,
    arguments_preview: buildPreview(inner.arguments, 60),
    done: false,
  };
  const updated: ThinkingState = {
    ...existing,
    tools: [...existing.tools, entry],
  };
  const nextThinking = [...state.thinkingAgents];
  nextThinking[idx] = updated;
  return { ...state, thinkingAgents: nextThinking };
}

/**
 * Flip the matching tool row to `done: true`, searching EVERY segment the agent
 * owns — newest first, with no `final` filter (ADR-032 §D6).
 *
 * A return routinely lands after its own segment was closed: a tool-return part
 * reaches the log only when the next `ModelRequest` is appended, which is after
 * the per-tool hook that absorbs a mailbox message and splits the bubble. A
 * lookup restricted to the live segment drops those rows and they stay
 * `done: false` for the rest of the session. `tool_call_id` is globally unique,
 * so at most one segment can hold it and the flip is unambiguous whichever way
 * the events interleave — the correctness does not depend on the emission order,
 * which this repository does not own. This also repairs the pre-existing case of
 * a return arriving after `Sent`/`Processed`.
 */
function applyToolReturnToThinking(
  state: ChatState,
  msg: EventMessage,
): ChatState {
  const agentId = msg.sender?.agent_id;
  const inner = msg.event;
  if (!agentId || !inner) return state;
  const toolCallId: string = inner.tool_call_id;
  for (let idx = state.thinkingAgents.length - 1; idx >= 0; idx--) {
    const existing = state.thinkingAgents[idx];
    if (existing.agent_id !== agentId) continue;
    const toolIdx = existing.tools.findIndex(
      (t) => t.tool_call_id === toolCallId,
    );
    if (toolIdx === -1) continue;
    const updatedTools = [...existing.tools];
    updatedTools[toolIdx] = { ...updatedTools[toolIdx], done: true };
    const updated: ThinkingState = { ...existing, tools: updatedTools };
    const nextThinking = [...state.thinkingAgents];
    nextThinking[idx] = updated;
    return { ...state, thinkingAgents: nextThinking };
  }
  // Nothing holds this tool_call_id — identity no-op (AC7 reference equality).
  return state;
}

function applySentToThinking(state: ChatState, msg: SentMessage): ChatState {
  if (msg.sender.role === ACTOR_SYSTEM_ROLE) return state;
  return finaliseThinking(state, msg.sender.agent_id);
}

function applyProcessedToThinking(
  state: ChatState,
  msg: ProcessedMessage,
): ChatState {
  return finaliseThinking(state, msg.sender.agent_id);
}

/**
 * Shared finalisation logic for thinking bubbles.
 * If the bubble has no tools: remove it. Otherwise: set `final: true`.
 */
function finaliseThinking(state: ChatState, agentId: string): ChatState {
  const idx = state.thinkingAgents.findIndex(
    (s) => s.agent_id === agentId && !s.final,
  );
  if (idx === -1) return state;
  const existing = state.thinkingAgents[idx];
  if (existing.tools.length === 0) {
    const nextThinking = [
      ...state.thinkingAgents.slice(0, idx),
      ...state.thinkingAgents.slice(idx + 1),
    ];
    return { ...state, thinkingAgents: nextThinking };
  }
  const updated: ThinkingState = { ...existing, final: true };
  const nextThinking = [...state.thinkingAgents];
  nextThinking[idx] = updated;
  return { ...state, thinkingAgents: nextThinking };
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
  if (isSentMessage(msg)) {
    const afterMsg = applyMessageFromSent(state, msg);
    return applySentToThinking(afterMsg, msg);
  }
  if (isProcessedMessage(msg)) {
    return applyProcessedToThinking(state, msg);
  }
  if (isReceivedMessage(msg)) {
    return applyReceivedToThinking(state, msg);
  }
  if (isHandledMessage(msg)) {
    return applyHandledToThinking(state, msg);
  }
  if (isEventMessage(msg)) {
    const inner = (msg as EventMessage).event;
    // Epic 29 / ADR-010: fold context-management events into synthetic markers,
    // positioned chronologically at the event's log index. Guards are mutually
    // exclusive, so the order relative to the tool branches below is immaterial.
    if (isLlmContextCompactedEvent(inner)) {
      return applyMarker(state, buildCompactionMarker(msg as EventMessage, inner));
    }
    if (isLlmContextClearedEvent(inner)) {
      return applyMarker(state, buildClearMarker(msg as EventMessage, inner));
    }
    const kind: string | undefined = inner?.__model__;
    if (kind?.includes('ToolCallEvent')) {
      return applyToolCallToThinking(state, msg as EventMessage);
    }
    if (kind?.includes('ToolReturnEvent')) {
      return applyToolReturnToThinking(state, msg as EventMessage);
    }
  }
  return state;
}

/**
 * Pure fold over the full log (Task 3.5). `chatFold` is fully pure per
 * Task 3.6 purity assessment: no timers, no `Date.now()`, no DOM, no
 * out-of-order retroactive corrections. `new Date(msg.timestamp)` is
 * deterministic given the log.
 */
export function chatFold(log: AkgenticMessage[]): ChatState {
  return log.reduce(chatStep, EMPTY_CHAT);
}

/**
 * ChatService — Story 6.3 (ADR-005 §Decision 4).
 *
 * Exposes `chat$` as a pure selector over `MessageLogService.log$`. The
 * legacy observables `messages$` / `thinkingAgents$` / `pendingNotifications$`
 * are re-derived as sliced projections for downstream compatibility. The four
 * imperative mutators (`beginThinking`, `appendToolCall`, `markToolDone`,
 * `finaliseOrDiscard`) are deleted — the fold owns the lifecycle from this
 * story forward (FR7).
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

  readonly messages$: Observable<ChatMessage[]> = this.chat$.pipe(
    map((s) => s.messages),
    distinctUntilChanged(),
  );

  readonly thinkingAgents$: Observable<ThinkingState[]> = this.chat$.pipe(
    map((s) => s.thinkingAgents),
    distinctUntilChanged(),
  );

  /** Reactive set of unanswered Rule 3 message ids (per-message tracking).
   *  Pipes off the derived `messages$` — API-compatible with the pre-refactor
   *  contract (same `Observable<Set<string>>` shape). */
  readonly pendingNotifications$: Observable<Set<string>> = this.messages$.pipe(
    map(computePendingNotifications),
  );

  /**
   * Story 19-1 (ADR-016 §Decision 1) — imperative "just-sent" side channel.
   *
   * Emits a send-origin key (a send-time timestamp string) the moment the user
   * dispatches a message from the main chat input. The chat panel subscribes to
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
