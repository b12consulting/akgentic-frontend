/**
 * TypeScript definitions for Akgentic message types
 * Based on orchestrator.py and message.py Python classes
 */

export interface ActorAddress {
  __actor_address__: true;
  /** Fully qualified class name for deserialization (Python
   *  `ActorAddressDict.__actor_type__`). */
  __actor_type__?: string;
  agent_id: string;
  name: string;
  role: string;
  team_id?: string;
  squad_id: string;
  user_message: boolean;
}

/**
 * Lightweight projection of a backend `ToolCard` as it arrives on the wire
 * inside `StartMessage.config.tools` (Epic 23 / ADR-019). The config is
 * serialised in full (`msg.model_dump(mode="json")`, no projection), so each
 * tool carries at least its recursive `__model__` discriminator (e.g.
 * `"akgentic.tool.workspace.tool.WorkspaceTool"`) and, for a `WorkspaceTool`,
 * an optional `workspace_id`. We only type the fields the registry fold reads;
 * every other tool field is intentionally ignored.
 */
export interface ToolCardLite {
  __model__: string;
  workspace_id?: string | null;
}

export interface BaseConfig {
  name: string;
  role: string;
  user_id: string;
  user_email: string;
  squad_id: string;
  orchestrator: ActorAddress;
  /** Tools bound to this agent, serialised in full on the start config
   *  (Epic 23 / ADR-019). Optional: older payloads / agents without tools
   *  omit it. The WorkspaceRegistry fold reads `WorkspaceTool` entries here. */
  tools?: ToolCardLite[];
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

export interface SentMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.SentMessage';
  message: BaseMessage;
  recipient: ActorAddress;
}

export interface ReceivedMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.ReceivedMessage';
  /** UUID of the inner message being received. Python class only carries
   *  the id (lightweight telemetry) — the full inner message is NOT
   *  serialised into this envelope. See
   *  `akgentic.core.messages.orchestrator.ReceivedMessage`. */
  message_id: string;
}

export interface ProcessedMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.ProcessedMessage';
  message_id: string;
}

export interface StartMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.StartMessage';
  config: BaseConfig;
  parent: ActorAddress | null;
}

export interface StopMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.StopMessage';
}

export interface ErrorMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.ErrorMessage';
  /** Inherited from `NotificationMessage` upstream (core Epic 24, story 24-5):
   *  the error's own former field pair was consolidated onto the shared
   *  notification base. `content_type` is genuinely nullable (upstream default
   *  `None`); `content` narrows `BaseMessage.content` to a non-null string
   *  (upstream default `""`). */
  content_type: string | null;
  content: string;
  current_message?: BaseMessage | null;
}

/**
 * Handled-warning telemetry (core Epic 24, story 24-4) — the `ErrorMessage`
 * sibling under the shared `NotificationMessage` base, carrying the identical
 * `content_type`/`content` pair. `content_type` is structurally nullable and is
 * in practice always `null`: nothing upstream yet gives a warning a "kind" the
 * way an exception class name does, so the Messages tab supplies the legend.
 *
 * Declared as a FLAT SIBLING of `ErrorMessage`, deliberately not
 * `extends NotificationMessage`: the base would have to declare `__model__` as
 * its own literal, and neither subtype's literal is assignable to it. The
 * `AkgenticMessage` union discriminates on the `__model__` literals, so a TS
 * inheritance chain would buy nothing and break narrowing.
 */
export interface WarningMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.WarningMessage';
  content_type: string | null;
  content: string;
  current_message?: BaseMessage | null;
}

/**
 * The bare notification base (core Epic 24) — same field set as its
 * `ErrorMessage` / `WarningMessage` subclasses. Nothing upstream constructs one
 * today; the type and its render branch exist so the path lights up the moment a
 * producer appears. Flat sibling for the same reason as `WarningMessage`.
 */
export interface NotificationMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.NotificationMessage';
  content_type: string | null;
  content: string;
  current_message?: BaseMessage | null;
}

export interface StateChangedMessage extends BaseMessage {
  __model__: 'akgentic.core.messages.orchestrator.StateChangedMessage';
  state: BaseState | Record<string, any>;
}

export interface EventMessage extends BaseMessage {
  __model__: string; // contains 'EventMessage'
  event: any;
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

/**
 * Synthetic team startup greeting announced by the orchestrator on the team
 * event stream (akgentic-team ADR-17). On the chat path it only ever appears
 * as the inner `SentMessage.message` payload — see `isWelcomeAnnouncement`.
 * See ADR-011 (Welcome Message Chat Rendering) Decision 1.
 */
export interface WelcomeMessage extends BaseMessage {
  __model__: 'akgentic.team.messages.WelcomeMessage';
  content: string;
}

/**
 * One argument of a slash-command, mirroring akgentic-tool `CommandArg`
 * (ADR-028 §Decision 3). Ordered position in `CommandDescriptor.args` drives
 * both the backend positional parsing and the frontend args hint.
 */
export interface CommandArg {
  name: string;
  /** JSON-schema type name: "string", "integer", "boolean", … */
  type: string;
  required: boolean;
  description?: string | null;
}

/**
 * Metadata for one slash-command supported by an agent, mirroring
 * akgentic-tool `CommandDescriptor` (ADR-028 §Decision 3). Sourced from
 * `CommandsAnnouncedEvent` and rendered in the `/` mention dropdown.
 */
export interface CommandDescriptor {
  /** Canonical command name, e.g. "hire_member". */
  name: string;
  /** Human-readable description (from the callable docstring). */
  description: string;
  /** Ordered argument list — drives the dropdown args hint. */
  args: CommandArg[];
  /** Provenance, e.g. "TeamTool". */
  tool_card: string;
}

/**
 * Inner event payload announcing the full command set for one agent
 * (akgentic-tool `CommandsAnnouncedEvent`, ADR-028 §Decision 3). It rides the
 * existing `EventMessage` passthrough; the frontend discriminates it by the
 * inner `__model__` (ADR-013). A later event for the same agent replaces the
 * previous set.
 */
export interface CommandsAnnouncedEvent {
  __model__: string; // contains 'CommandsAnnouncedEvent'
  /** The agent that executes these commands. */
  agent: ActorAddress;
  commands: CommandDescriptor[];
}

/**
 * Immutable snapshot of one rendered system-prompt part, mirroring the
 * akgentic-llm `SystemPromptPartSnapshot` frozen dataclass (ADR-004 §Decision 1).
 * `dynamic_ref` is the pydantic-ai dynamic-prompt function name (e.g.
 * `current_date`) or `null` for static parts; `content` is the rendered text
 * actually sent to the model. `__model__` is the serializer-injected tag
 * (`akgentic.llm.event.SystemPromptPartSnapshot`) and is optional on read.
 */
export interface SystemPromptPartSnapshot {
  __model__?: string;
  dynamic_ref: string | null;
  content: string;
}

/**
 * Inner event payload announcing the effective system-prompt rendering for one
 * run, mirroring the akgentic-llm `LlmSystemPromptEvent` frozen dataclass
 * (ADR-004 §Decision 1). It rides the standard `EventMessage` envelope (outer
 * `sender.agent_id` identifies the agent) and is discriminated frontend-side by
 * the inner `__model__` — exactly like `LlmMessageEvent` / `ToolStateEvent` /
 * `CommandsAnnouncedEvent`. A later event for the same agent supersedes the
 * previous rendering (latest-wins). See ADR-004 §5a for the wire JSON.
 */
export interface LlmSystemPromptEvent {
  __model__: string; // contains 'LlmSystemPromptEvent'
  run_id: string;
  content_hash: string;
  parts: SystemPromptPartSnapshot[];
}

/**
 * Inner event payload announcing per-`ModelResponse` token usage for one run,
 * mirroring the akgentic-llm `LlmUsageEvent` frozen dataclass (ADR-022 §Decision
 * 1). It rides the standard `EventMessage` envelope (outer `sender.agent_id`
 * identifies the agent that ran the model) and is discriminated frontend-side by
 * the inner `__model__` — exactly like `LlmSystemPromptEvent` / `LlmMessageEvent`
 * / `CommandsAnnouncedEvent`. The serializer tags the dataclass with the
 * fully-qualified `__model__` and preserves integer token counts (no
 * stringification). Terminology (ADR-022 §Decision 4): `input_tokens` is "sent",
 * `output_tokens` is "received". `cache_read_tokens` / `cache_write_tokens` fold
 * into the true context-window figure (ADR-024 §Decision 2); `requests` still
 * rides the wire unused.
 */
export interface LlmUsageEvent {
  __model__: string; // contains 'LlmUsageEvent'
  run_id: string;
  model_name: string;
  provider_name: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  requests: number;
}

/**
 * Inner event payload announcing that a summary replaced a leading prefix of an
 * agent's conversation, mirroring the akgentic-llm `LlmContextCompactedEvent`
 * frozen dataclass (ADR-010 §3). It rides the standard `EventMessage` envelope
 * (outer `sender.agent_id` identifies the agent that compacted) and is
 * discriminated frontend-side by the inner `__model__` — exactly like
 * `LlmUsageEvent` / `LlmSystemPromptEvent`. The serializer tags the dataclass
 * with the fully-qualified `__model__` and preserves the primitive field values
 * (integer counts, string summary — no `repr` stringification). `run_id` is
 * `null` for a manual `/compact` between runs; `tokens_before` / `tokens_after`
 * are observability-only and may be `null`.
 */
export interface LlmContextCompactedEvent {
  __model__: string; // contains 'LlmContextCompactedEvent'
  run_id: string | null;
  strategy_id: string;
  summary: string;
  replaced_message_count: number;
  summarizer_prompt_version: string;
  tokens_before: number | null;
  tokens_after: number | null;
}

/**
 * Inner event payload announcing that an agent's conversation was wiped to empty
 * (system prompt re-injects on the next run), mirroring the akgentic-llm
 * `LlmContextClearedEvent` frozen dataclass (ADR-010 §8). Same native
 * `EventMessage` passthrough + inner `__model__` discrimination as
 * `LlmContextCompactedEvent`. `run_id` is `null` for a manual `/clear` between
 * runs; `cleared_message_count` is the number of messages removed.
 */
export interface LlmContextClearedEvent {
  __model__: string; // contains 'LlmContextClearedEvent'
  run_id: string | null;
  cleared_message_count: number;
}

/**
 * Wire tag of the `EventMessage` envelope. Named as a constant because Story
 * 31-4 makes the frontend a WRITER of that envelope (`ApiService.
 * emitClosedNotification`), and the tag has to match the Python import path
 * byte-for-byte or the server's `decode_message` answers 400. Read paths keep
 * using the `.includes()` guards — an envelope is recognised by substring, only
 * the one place that CONSTRUCTS one needs the exact literal.
 */
export const EVENT_MESSAGE_MODEL =
  'akgentic.core.messages.orchestrator.EventMessage';

/**
 * Wire tag of the `ClosedNotification` dataclass carried inside
 * `EventMessage.event`. Same reasoning as `EVENT_MESSAGE_MODEL`: the outgoing
 * payload carries TWO nested tags (envelope, then dataclass) and both are
 * resolved server-side by import path.
 */
export const CLOSED_NOTIFICATION_MODEL =
  'akgentic.core.messages.orchestrator.ClosedNotification';

/**
 * Inner event payload recording that a notification was dismissed by the user,
 * mirroring the akgentic-core `ClosedNotification` frozen dataclass (core Epic
 * 24). Carried by `EventMessage.event` like every other domain-event payload,
 * and discriminated frontend-side by the inner `__model__` — exactly like
 * `LlmUsageEvent` / `CommandsAnnouncedEvent`.
 *
 * Unlike its siblings this payload is also WRITTEN by the frontend: closing a
 * toast POSTs it to `/teams/{id}/notification`, the orchestrator persists and
 * streams it, and it arrives back on the WS stream (and in a later `getEvents`
 * replay) where `closedNotificationIdsFold` collects it.
 *
 * `message_id` is the `id` of the dismissed `NotificationMessage`. It is a
 * `uuid.UUID` upstream and a plain string on the wire — the server's
 * deserializer coerces it back.
 */
export interface ClosedNotification {
  __model__: string; // contains 'ClosedNotification'
  message_id: string;
}

/**
 * Inner event payload announcing that the orchestrator has begun tearing the
 * team down, mirroring the akgentic-core `TeamStoppingEvent` frozen dataclass
 * (core ADR-018 §1). Carried by `EventMessage.event` like every other domain
 * event and discriminated by the inner `__model__`.
 *
 * It carries NO fields beyond the wire tag, and that is the upstream design
 * rather than an omission here: the envelope already supplies everything a
 * consumer needs — `team_id`, `timestamp` and `sender`. Do not invent a
 * `reason` or a `cause`; a defaulted field may be added upstream later, and
 * until one exists anything read off this payload is fiction.
 *
 * Read-only on this side, so — unlike `ClosedNotification`, which the frontend
 * also WRITES — it gets no exported wire-tag constant. See
 * `CLOSED_NOTIFICATION_MODEL` for why that constant is the exception.
 */
export interface TeamStoppingEvent {
  __model__: string; // contains 'TeamStoppingEvent'
}

/**
 * Inner event payload announcing that the model asked for one tool call,
 * mirroring the akgentic-llm `ToolCallEvent` frozen dataclass (ADR-031
 * §Context). Carried by `EventMessage.event` like every other domain event and
 * discriminated by the inner `__model__`.
 *
 * This is the half of the pair that carries WHAT was touched. `arguments` is the
 * call's argument object serialised as a JSON **string** — always, on every
 * frame, by design upstream — so it is typed `string` here and not as an object.
 * Read it with `parseToolCallArguments`, which yields `null` rather than
 * throwing on a payload it cannot make sense of.
 *
 * `arguments` is a reserved identifier in strict-mode modules: read it as a
 * property (`event.arguments`) or rename it on destructure
 * (`const { arguments: argsJson } = event`) — a bare `const { arguments }` is a
 * syntax error.
 *
 * Read-only on this side, so — like `TeamStoppingEvent` — it gets no exported
 * wire-tag constant. See `CLOSED_NOTIFICATION_MODEL` for why that is the
 * exception rather than the rule.
 */
export interface ToolCallEvent {
  __model__: string; // contains 'ToolCallEvent'
  run_id: string;
  tool_name: string;
  tool_call_id: string;
  /** The call's arguments, as a JSON string. Parse with
   *  `parseToolCallArguments`; never `JSON.parse` it inline. */
  arguments: string;
}

/**
 * Inner event payload announcing the verdict of one tool call, mirroring the
 * akgentic-llm `ToolReturnEvent` frozen dataclass (ADR-031 §Context). Same
 * `EventMessage` passthrough and inner-`__model__` discrimination as its
 * `ToolCallEvent` sibling.
 *
 * It carries NO `arguments` and NO path, and that is upstream's design rather
 * than an omission here: what was touched lives on the CALL, and the only thing
 * tying the two together is `tool_call_id`. A consumer that wants "a mutation
 * succeeded, at this path" must therefore hold the call until the matching
 * return arrives — do not invent a path field on this payload.
 *
 * `success: false` is a retry prompt, not a mutation.
 */
export interface ToolReturnEvent {
  __model__: string; // contains 'ToolReturnEvent'
  run_id: string;
  tool_name: string;
  tool_call_id: string;
  success: boolean;
}

// ---------------------------------------------------------------------------
// Per-tool argument shapes for the six mutating workspace tools (ADR-031 §D6).
//
// These model `parseToolCallArguments`'s OUTPUT, not the wire payload. The
// output is the payload PLUS a `tool_name` discriminant lifted from the event
// envelope: the parser reads `event.tool_name` and writes it into the object it
// returns — the JSON body in `event.arguments` never carries it, and no parse
// of that body could produce it. Each interface declares it as a string literal
// so the union below is discriminated at the consumer.
//
// That is why `WorkspaceEditOperation` correctly has none: it is an element of
// `workspace_multi_edit`'s `edits` array, read straight out of the payload,
// and no envelope field is lifted onto it.
//
// Only the fields an invalidation actually consumes — `path`, and
// `edits[i].path` for the multi-edit — are validated; `content`, `old_string`,
// `new_string`, `replace_all` and `patch_text` are declared as documentation of
// the wire shape and are copied through when present. A field nobody reads must
// not be able to veto a real mutation: requiring `content` would turn a write
// of an EMPTY file into `null` and silently drop it.
// ---------------------------------------------------------------------------

export interface WorkspaceWriteArguments {
  tool_name: 'workspace_write';
  path: string;
  content?: string;
}

export interface WorkspaceDeleteArguments {
  tool_name: 'workspace_delete';
  path: string;
}

export interface WorkspaceEditArguments {
  tool_name: 'workspace_edit';
  path: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
}

export interface WorkspaceMkdirArguments {
  tool_name: 'workspace_mkdir';
  path: string;
}

/** One element of `workspace_multi_edit`'s `edits` — N paths in one call. */
export interface WorkspaceEditOperation {
  path: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
}

export interface WorkspaceMultiEditArguments {
  tool_name: 'workspace_multi_edit';
  edits: WorkspaceEditOperation[];
}

/**
 * `workspace_patch` has NO path argument at all: its paths exist only inside the
 * unified-diff text. That text is deliberately not parsed, scraped or inspected
 * here — a second implementation of a backend format, free to drift, is a worse
 * artefact than a coarse refresh (ADR-031 §D3).
 */
export interface WorkspacePatchArguments {
  tool_name: 'workspace_patch';
  patch_text?: string;
}

/** The six mutating-tool argument shapes, discriminated by `tool_name`. */
export type WorkspaceToolArguments =
  | WorkspaceWriteArguments
  | WorkspaceDeleteArguments
  | WorkspaceEditArguments
  | WorkspaceMkdirArguments
  | WorkspaceMultiEditArguments
  | WorkspacePatchArguments;

// Union type for all possible messages
export type AkgenticMessage =
  | SentMessage
  | ReceivedMessage
  | ProcessedMessage
  | StartMessage
  | StopMessage
  | ErrorMessage
  | WarningMessage
  | NotificationMessage
  | StateChangedMessage
  | EventMessage
  | UserMessage
  | ResultMessage;

// Type guards for message discrimination

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

export function isWarningMessage(msg: BaseMessage): msg is WarningMessage {
  return msg.__model__.includes('WarningMessage');
}

/**
 * True ONLY for the bare `NotificationMessage` base. Deliberately stricter than
 * the `.includes()` siblings (same precedent as `isWorkspaceTool` above):
 * `ErrorMessage` and `WarningMessage` ARE `NotificationMessage` subclasses
 * upstream, but each takes its own render branch here, so a guard that admitted
 * them would make the three branches ambiguous. The leading dot also rejects a
 * hypothetical `FooNotificationMessage`.
 */
export function isNotificationMessage(
  msg: BaseMessage,
): msg is NotificationMessage {
  return msg.__model__.endsWith('.NotificationMessage');
}

/** The three notification severities, in escalation order (Story 31-2). */
export type NotificationSeverity = 'error' | 'warn' | 'info';

/**
 * The ONE encoding of the error/warn/info partition (Story 31-6, FR20). `null`
 * means "not a notification".
 *
 * It lives here, next to the three guards it is built from, because it had been
 * written twice: once as `MessageListComponent.notificationSeverity` (the full
 * three-way) and once inline in `IngestionService.showNotificationToast` as
 * `isWarningMessage(event) ? 'warn' : 'info'` — a two-way that was only correct
 * while its caller excluded errors, and that silently rendered an error as a
 * blue info toast the moment errors were admitted. A single exported function
 * is what makes that class of drift unrepresentable.
 *
 * `message-log.service.ts`'s `MESSAGE_LIST_MODELS` allowlist is the third party
 * to this coupling: it must admit exactly what this function can classify.
 *
 * Guard order is load-bearing. `ErrorMessage` and `WarningMessage` ARE
 * `NotificationMessage` subclasses upstream, so errors and warnings must be
 * claimed before the bare-base check — which is itself an `endsWith` for the
 * same reason (see `isNotificationMessage`).
 *
 * Pure string checks, no allocation: it is called once per row from the
 * Messages-tab template and once per frame on the WS hot path.
 */
export function notificationSeverity(
  message: BaseMessage,
): NotificationSeverity | null {
  if (isErrorMessage(message)) return 'error';
  if (isWarningMessage(message)) return 'warn';
  if (isNotificationMessage(message)) return 'info';
  return null;
}

export function isStateChangedMessage(
  msg: BaseMessage,
): msg is StateChangedMessage {
  return msg.__model__.includes('StateChangedMessage');
}

export function isEventMessage(msg: BaseMessage): msg is EventMessage {
  return msg.__model__.includes('EventMessage');
}

export function isUserMessage(msg: BaseMessage): msg is UserMessage {
  return msg.__model__.includes('UserMessage');
}

export function isResultMessage(msg: BaseMessage): msg is ResultMessage {
  return msg.__model__.includes('ResultMessage');
}

/**
 * ToolCard discriminator check (Epic 23 / ADR-019): true when `t` is a
 * `WorkspaceTool`. Matches on the recursive `__model__` *ending in*
 * `WorkspaceTool` (so `"akgentic.tool.workspace.tool.WorkspaceTool"` matches),
 * deliberately stricter than the `.includes()` used by the message guards: a
 * `__model__` that merely contains `WorkspaceTool` mid-string (or a different
 * tool such as `...KnowledgeGraphTool`, or the empty string) is rejected.
 */
export function isWorkspaceTool(t: ToolCardLite): t is ToolCardLite {
  return t.__model__.endsWith('WorkspaceTool');
}

/**
 * Inner-payload check: true when the message itself is a `WelcomeMessage`.
 * Consistent with the other `is*` guards — matches on `__model__`.
 */
export function isWelcomeMessage(msg: BaseMessage): msg is WelcomeMessage {
  return msg.__model__.includes('WelcomeMessage');
}

/**
 * Inner-event check (ADR-013): true when the inner event carried by an
 * `EventMessage` is a `CommandsAnnouncedEvent`. Matches on the inner
 * `__model__`, the same discrimination already used for `LlmMessageEvent` /
 * `ToolCallEvent` / `ToolStateEvent`. `event` is the `EventMessage.event`
 * payload (loosely typed on the wire); the guard narrows it to
 * `CommandsAnnouncedEvent`.
 */
export function isCommandsAnnouncedEvent(
  event: { __model__?: string } | null | undefined,
): event is CommandsAnnouncedEvent {
  return !!event?.__model__?.includes('CommandsAnnouncedEvent');
}

/**
 * Inner-event check (ADR-004 §5a): true when the inner event carried by an
 * `EventMessage` is a `LlmSystemPromptEvent`. Matches on the inner `__model__`,
 * the same discrimination used for `LlmMessageEvent` / `ToolStateEvent` /
 * `CommandsAnnouncedEvent`. `event` is the `EventMessage.event` payload (loosely
 * typed on the wire); the guard narrows it to `LlmSystemPromptEvent`.
 */
export function isLlmSystemPromptEvent(
  event: { __model__?: string } | null | undefined,
): event is LlmSystemPromptEvent {
  return !!event?.__model__?.includes('LlmSystemPromptEvent');
}

/**
 * Inner-event check (ADR-022 §Decision 1): true when the inner event carried by
 * an `EventMessage` is a `LlmUsageEvent`. Matches on the inner `__model__`, the
 * same discrimination used for `LlmSystemPromptEvent` / `LlmMessageEvent` /
 * `CommandsAnnouncedEvent`. `event` is the `EventMessage.event` payload (loosely
 * typed on the wire); the guard narrows it to `LlmUsageEvent`.
 */
export function isLlmUsageEvent(
  event: { __model__?: string } | null | undefined,
): event is LlmUsageEvent {
  return !!event?.__model__?.includes('LlmUsageEvent');
}

/**
 * Inner-event check (ADR-010 §3): true when the inner event carried by an
 * `EventMessage` is a `LlmContextCompactedEvent`. Matches on the inner
 * `__model__`, the same discrimination used for `LlmUsageEvent` /
 * `LlmSystemPromptEvent`. Mutually exclusive with every other `Llm*Event` guard:
 * `'LlmContextCompactedEvent'` neither contains nor is contained by
 * `'LlmContextClearedEvent'`, `'LlmUsageEvent'`, `'LlmSystemPromptEvent'`, or
 * `'LlmMessageEvent'` (no substring collision in either direction).
 */
export function isLlmContextCompactedEvent(
  event: { __model__?: string } | null | undefined,
): event is LlmContextCompactedEvent {
  return !!event?.__model__?.includes('LlmContextCompactedEvent');
}

/**
 * Inner-event check (ADR-010 §8): true when the inner event carried by an
 * `EventMessage` is a `LlmContextClearedEvent`. Matches on the inner
 * `__model__`; mutually exclusive with `isLlmContextCompactedEvent` and the
 * other `Llm*Event` guards (no substring collision in either direction).
 */
export function isLlmContextClearedEvent(
  event: { __model__?: string } | null | undefined,
): event is LlmContextClearedEvent {
  return !!event?.__model__?.includes('LlmContextClearedEvent');
}

/**
 * Inner-event check (Story 31-4): true when the inner event carried by an
 * `EventMessage` is a `ClosedNotification`. Matches on the inner `__model__`,
 * the same discrimination used for `LlmUsageEvent` / `CommandsAnnouncedEvent`.
 * No substring collision with any other inner event on the wire.
 */
export function isClosedNotification(
  event: { __model__?: string } | null | undefined,
): event is ClosedNotification {
  return !!event?.__model__?.includes('ClosedNotification');
}

/**
 * Inner-event check (Story 37-2): true when the inner event carried by an
 * `EventMessage` is a `TeamStoppingEvent`. Matches on the inner `__model__`, the
 * same discrimination used for `ClosedNotification` / `LlmUsageEvent`.
 *
 * The argument is `EventMessage.event`, NEVER the envelope. Applied to the
 * envelope this never matches — `'EventMessage'` does not contain
 * `'TeamStoppingEvent'` — and the caller is then silently dead with every other
 * spec still green.
 *
 * No substring collision in either direction with any tag on the wire:
 * `'TeamStoppingEvent'` contains neither `'StopMessage'` nor `'EventMessage'`
 * (it contains `'Event'`, which is not the same string), and no existing tag
 * contains it.
 */
export function isTeamStoppingEvent(
  event: { __model__?: string } | null | undefined,
): event is TeamStoppingEvent {
  return !!event?.__model__?.includes('TeamStoppingEvent');
}

/**
 * Inner-event check: true when the inner event carried by an `EventMessage` is a
 * `LlmMessageEvent`. Named here for symmetry with `isLlmUsageEvent` /
 * `isLlmSystemPromptEvent` (ADR-022 §Decision 1, Open Question 1) so the
 * mutual-exclusion regression reads cleanly across the three `Llm*Event` guards.
 * The `per-agent-specs.ts` fold helpers keep their existing inline
 * `__model__.includes('LlmMessageEvent')` checks; this guard is additive.
 */
export function isLlmMessageEvent(
  event: { __model__?: string } | null | undefined,
): boolean {
  return !!event?.__model__?.includes('LlmMessageEvent');
}

/**
 * Envelope check (ADR-011 Decision 1): true only when `msg` is a `SentMessage`
 * whose inner `message` is a `WelcomeMessage` AND that inner payload carries
 * `display_type === 'other'`. Both signals are required (belt-and-suspenders):
 * `__model__` is the precise type identity, `display_type === 'other'`
 * confirms the render category.
 */
export function isWelcomeAnnouncement(msg: BaseMessage): boolean {
  if (!isSentMessage(msg)) return false;
  const inner = (msg as SentMessage).message;
  return (
    !!inner && isWelcomeMessage(inner) && inner.display_type === 'other'
  );
}

/**
 * Inner-event check (ADR-031 §D6): true when the inner event carried by an
 * `EventMessage` is a `ToolCallEvent`. Matches on the inner `__model__`, the
 * same discrimination used for `TeamStoppingEvent` / `ClosedNotification`.
 *
 * The argument is `EventMessage.event`, NEVER the envelope. Applied to the
 * envelope this never matches — `'EventMessage'` does not contain
 * `'ToolCallEvent'` — and the caller is then silently dead with every other spec
 * still green. The mirror failure is worse: a guard that DID fire on the
 * envelope would fire for every `EventMessage` on the log, and the workspace
 * fold built on it would invalidate on every LLM message.
 *
 * No substring collision in either direction with any tag on the wire:
 * `'ToolCallEvent'` neither contains nor is contained by `'ToolReturnEvent'`,
 * `'ToolStateEvent'`, `'LlmMessageEvent'` or `'EventMessage'` (all of them share
 * the trailing `'Event'`, which is not the same string).
 */
export function isToolCallEvent(
  event: { __model__?: string } | null | undefined,
): event is ToolCallEvent {
  return !!event?.__model__?.includes('ToolCallEvent');
}

/**
 * Inner-event check (ADR-031 §D6): true when the inner event carried by an
 * `EventMessage` is a `ToolReturnEvent`. Same inner-vs-envelope rule as
 * `isToolCallEvent` above — the argument is `EventMessage.event`, never the
 * envelope — and the same absence of substring collision in either direction:
 * `'ToolReturnEvent'` neither contains nor is contained by `'ToolCallEvent'`,
 * `'ToolStateEvent'`, `'LlmMessageEvent'` or `'EventMessage'`.
 *
 * A return narrowed by this guard tells you a call FINISHED; it does not tell
 * you what it touched. That is on the call, joined by `tool_call_id`.
 */
export function isToolReturnEvent(
  event: { __model__?: string } | null | undefined,
): event is ToolReturnEvent {
  return !!event?.__model__?.includes('ToolReturnEvent');
}

// ---------------------------------------------------------------------------
// parseToolCallArguments and its structural narrowing helpers (ADR-031 §D6).
//
// `JSON.parse`'s result is taken as `unknown` and narrowed by explicit
// predicates — no `any` reaches any signature or body here, which is the whole
// point of typing these two events at last.
// ---------------------------------------------------------------------------

/** True for a JSON value that is a plain object — not an array, not `null`. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `path` field when present, a string, AND non-empty; `null` otherwise.
 *
 * The empty string is rejected on purpose, and it is not the same call as the
 * one made for `content`: an empty `content` is a real mutation (a write of an
 * empty file), whereas an empty `path` names nothing a consumer can act on. Let
 * it through and the parsed member looks valid while the directory derivation
 * built on it resolves to the workspace root — a refresh of the wrong listing,
 * which is precisely the guess this helper exists to refuse.
 */
function readPath(body: Record<string, unknown>): string | null {
  const path = body['path'];
  return typeof path === 'string' && path !== '' ? path : null;
}

function readOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function readOptionalBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = body[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * The three edit-content fields shared by `workspace_edit` and every element of
 * `workspace_multi_edit`. None of them is validated — a wrongly-typed one is
 * simply omitted rather than vetoing the mutation — and an absent one produces
 * no key at all, so a parsed member never carries `undefined` values.
 */
function readEditContentFields(
  body: Record<string, unknown>,
): Omit<WorkspaceEditOperation, 'path'> {
  const oldString = readOptionalString(body, 'old_string');
  const newString = readOptionalString(body, 'new_string');
  const replaceAll = readOptionalBoolean(body, 'replace_all');
  return {
    ...(oldString !== undefined ? { old_string: oldString } : {}),
    ...(newString !== undefined ? { new_string: newString } : {}),
    ...(replaceAll !== undefined ? { replace_all: replaceAll } : {}),
  };
}

/**
 * The `edits` list, or `null` when it is missing, is not an array, is empty, or
 * holds a single element without a usable `path`. All-or-nothing on purpose: a
 * partially-populated list would be indistinguishable from a complete one at the
 * consumer, which would then invalidate some of what changed and none of the
 * rest.
 */
function readEdits(
  body: Record<string, unknown>,
): WorkspaceEditOperation[] | null {
  const raw = body['edits'];
  if (!Array.isArray(raw)) return null;
  // `Array.isArray` narrows `unknown` to `any[]`; re-binding as `unknown[]`
  // keeps every element opaque until a predicate has looked at it.
  const elements: unknown[] = raw;
  if (elements.length === 0) return null;

  const edits: WorkspaceEditOperation[] = [];
  for (const element of elements) {
    if (!isJsonObject(element)) return null;
    const path = readPath(element);
    if (path === null) return null;
    edits.push({ path, ...readEditContentFields(element) });
  }
  return edits;
}

/** The four tools whose whole path argument is a single top-level `path`. */
function parseSinglePathArguments(
  toolName:
    | 'workspace_write'
    | 'workspace_delete'
    | 'workspace_edit'
    | 'workspace_mkdir',
  body: Record<string, unknown>,
): WorkspaceToolArguments | null {
  const path = readPath(body);
  if (path === null) return null;

  switch (toolName) {
    case 'workspace_write': {
      const content = readOptionalString(body, 'content');
      return {
        tool_name: 'workspace_write',
        path,
        ...(content !== undefined ? { content } : {}),
      };
    }
    case 'workspace_delete':
      return { tool_name: 'workspace_delete', path };
    case 'workspace_mkdir':
      return { tool_name: 'workspace_mkdir', path };
    case 'workspace_edit':
      return { tool_name: 'workspace_edit', path, ...readEditContentFields(body) };
  }
}

/**
 * Parse a tool call's `arguments` JSON string into the typed shape for its
 * `tool_name`, or `null` (ADR-031 §D6).
 *
 * **It never throws, for any input.** That is a requirement, not defensive
 * style, and it got STRONGER when its caller stopped folding the log (Epic 42 /
 * ADR-031 §D11): `workspace-invalidation.selector.ts` now calls this from a live
 * subscription on `MessageLogService.appended$`. A throw out of a subscriber
 * tears that subscription down for good and nothing re-subscribes — the log
 * keeps growing, the workspace panel stops refreshing for the rest of the
 * session, and nothing surfaces anywhere. Under the old fold a bad frame merely
 * spoiled one emission's derivation.
 *
 * It returns `null` — never a partially-populated object — for malformed JSON, a
 * JSON root that is not an object, a `tool_name` it does not know (the read
 * tools included: they write `.`-prefixed sidecar caches, so admitting them
 * would refetch the tree on every file an agent reads), and a body that does not
 * carry the fields that tool's invalidation consumes. Extra unknown keys are
 * ignored rather than rejected, so a field added upstream cannot turn a valid
 * mutation into `null`.
 *
 * The path is returned exactly as the wire carried it: no parent derivation, no
 * normalisation, no joining.
 */
export function parseToolCallArguments(
  event: ToolCallEvent,
): WorkspaceToolArguments | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.arguments) as unknown;
  } catch {
    return null;
  }
  if (!isJsonObject(parsed)) return null;

  switch (event.tool_name) {
    case 'workspace_write':
    case 'workspace_delete':
    case 'workspace_edit':
    case 'workspace_mkdir':
      return parseSinglePathArguments(event.tool_name, parsed);
    case 'workspace_multi_edit': {
      const edits = readEdits(parsed);
      return edits === null
        ? null
        : { tool_name: 'workspace_multi_edit', edits };
    }
    case 'workspace_patch': {
      const patchText = readOptionalString(parsed, 'patch_text');
      return {
        tool_name: 'workspace_patch',
        ...(patchText !== undefined ? { patch_text: patchText } : {}),
      };
    }
    default:
      return null;
  }
}
