import {
  ActorAddress,
  BaseMessage,
  CLOSED_NOTIFICATION_MODEL,
  EVENT_MESSAGE_MODEL,
  isClosedNotification,
  isCommandsAnnouncedEvent,
  isErrorMessage,
  isEventMessage,
  isHandledMessage,
  isLlmContextClearedEvent,
  isLlmContextCompactedEvent,
  isLlmMessageEvent,
  isLlmSystemPromptEvent,
  isLlmUsageEvent,
  isNotificationMessage,
  isProcessedMessage,
  isReceivedMessage,
  isResultMessage,
  isSentMessage,
  isStartMessage,
  isStateChangedMessage,
  isStopMessage,
  isTeamStoppingEvent,
  isToolCallEvent,
  isToolReturnEvent,
  isUserMessage,
  isWarningMessage,
  isWelcomeAnnouncement,
  isWelcomeMessage,
  notificationSeverity,
  parseToolCallArguments,
  SentMessage,
  ToolCallEvent,
  ToolReturnEvent,
  WelcomeMessage,
} from './message.types';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeAddress(overrides: Partial<ActorAddress> = {}): ActorAddress {
  return {
    __actor_address__: true,
    name: '@Agent',
    role: 'Worker',
    agent_id: 'agent-1',
    squad_id: 'squad-1',
    user_message: false,
    ...overrides,
  };
}

function makeWelcome(overrides: Partial<WelcomeMessage> = {}): WelcomeMessage {
  return {
    id: 'welcome-inner-1',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-05-18T10:00:00Z',
    sender: makeAddress({ name: '@Orchestrator', role: 'Orchestrator' }),
    display_type: 'other',
    content: 'Welcome to the agent team !',
    __model__: 'akgentic.team.messages.WelcomeMessage',
    ...overrides,
  };
}

function makeOrdinaryInner(overrides: Partial<BaseMessage> = {}): BaseMessage {
  return {
    id: 'inner-1',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-05-18T10:00:00Z',
    sender: makeAddress(),
    display_type: 'ai',
    content: 'ordinary content',
    __model__: 'akgentic.core.messages.orchestrator.SentMessage',
    ...overrides,
  };
}

function makeSent(inner: BaseMessage, senderRole = 'ActorSystem'): SentMessage {
  return {
    id: 'outer-1',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-05-18T10:00:00Z',
    sender: makeAddress({ name: '@ActorSystem', role: senderRole }),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.SentMessage',
    message: inner,
    recipient: makeAddress({ name: '@Human', role: 'Human' }),
  };
}

// ---------------------------------------------------------------------------
// isWelcomeMessage — inner-payload check
// ---------------------------------------------------------------------------

describe('isWelcomeMessage', () => {
  it('returns true for a WelcomeMessage inner payload', () => {
    expect(isWelcomeMessage(makeWelcome())).toBe(true);
  });

  it('returns false for an ordinary BaseMessage', () => {
    expect(isWelcomeMessage(makeOrdinaryInner())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isWelcomeAnnouncement — envelope check (BOTH signals required, ADR-011 D1)
// ---------------------------------------------------------------------------

describe('isWelcomeAnnouncement', () => {
  it('returns true when inner is a WelcomeMessage AND inner display_type is "other"', () => {
    const msg = makeSent(makeWelcome({ display_type: 'other' }));
    expect(isWelcomeAnnouncement(msg)).toBe(true);
  });

  it('returns false when the inner payload is not a WelcomeMessage (missing __model__ signal)', () => {
    const msg = makeSent(makeOrdinaryInner({ display_type: 'other' }));
    expect(isWelcomeAnnouncement(msg)).toBe(false);
  });

  it('returns false when the inner WelcomeMessage display_type is not "other"', () => {
    const msg = makeSent(makeWelcome({ display_type: 'ai' }));
    expect(isWelcomeAnnouncement(msg)).toBe(false);
  });

  it('returns false for a non-SentMessage envelope', () => {
    const notSent = makeWelcome({
      __model__:
        'akgentic.core.messages.orchestrator.StartMessage' as unknown as WelcomeMessage['__model__'],
    });
    expect(isWelcomeAnnouncement(notSent)).toBe(false);
  });

  it('returns false when the SentMessage has no inner message', () => {
    const msg = makeSent(makeWelcome());
    (msg as { message?: BaseMessage }).message = undefined;
    expect(isWelcomeAnnouncement(msg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isLlmUsageEvent — inner-event check (ADR-022 §Decision 1)
// ---------------------------------------------------------------------------

describe('isLlmUsageEvent', () => {
  it('returns true for an inner event whose __model__ includes "LlmUsageEvent"', () => {
    expect(
      isLlmUsageEvent({ __model__: 'akgentic.llm.event.LlmUsageEvent' }),
    ).toBe(true);
  });

  it('returns false for null / undefined / missing __model__', () => {
    expect(isLlmUsageEvent(null)).toBe(false);
    expect(isLlmUsageEvent(undefined)).toBe(false);
    expect(isLlmUsageEvent({})).toBe(false);
  });

  it('returns false for a different inner event', () => {
    expect(
      isLlmUsageEvent({ __model__: 'akgentic.llm.event.LlmSystemPromptEvent' }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC #3 — the three Llm*Event guards are mutually exclusive.
// For any one inner event, AT MOST ONE of (usage / system-prompt) guards fires,
// and the message-event check never co-fires with either. The discriminators
// must never overlap for the same event.
// ---------------------------------------------------------------------------

describe('Llm*Event guard mutual exclusion (AC #3)', () => {
  const usage = { __model__: 'akgentic.llm.event.LlmUsageEvent' };
  const systemPrompt = { __model__: 'akgentic.llm.event.LlmSystemPromptEvent' };
  const message = { __model__: 'akgentic.llm.event.LlmMessageEvent' };

  it('for an LlmUsageEvent, only isLlmUsageEvent fires', () => {
    expect(isLlmUsageEvent(usage)).toBe(true);
    expect(isLlmSystemPromptEvent(usage)).toBe(false);
    expect(isLlmMessageEvent(usage)).toBe(false);
  });

  it('for an LlmSystemPromptEvent, only isLlmSystemPromptEvent fires', () => {
    expect(isLlmSystemPromptEvent(systemPrompt)).toBe(true);
    expect(isLlmUsageEvent(systemPrompt)).toBe(false);
    expect(isLlmMessageEvent(systemPrompt)).toBe(false);
  });

  it('for an LlmMessageEvent, neither usage nor system-prompt guard fires', () => {
    expect(isLlmMessageEvent(message)).toBe(true);
    expect(isLlmUsageEvent(message)).toBe(false);
    expect(isLlmSystemPromptEvent(message)).toBe(false);
  });

  it('the three guards never co-fire for the same event', () => {
    for (const evt of [usage, systemPrompt, message]) {
      const fired = [
        isLlmUsageEvent(evt),
        isLlmSystemPromptEvent(evt),
        isLlmMessageEvent(evt),
      ].filter(Boolean);
      expect(fired.length).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// isLlmContextCompactedEvent — inner-event check (ADR-010 §3, AC #2)
// ---------------------------------------------------------------------------

describe('isLlmContextCompactedEvent', () => {
  it('returns true for an inner event whose __model__ includes "LlmContextCompactedEvent"', () => {
    expect(
      isLlmContextCompactedEvent({
        __model__: 'akgentic.llm.event.LlmContextCompactedEvent',
      }),
    ).toBe(true);
  });

  it('returns false for null / undefined / missing __model__', () => {
    expect(isLlmContextCompactedEvent(null)).toBe(false);
    expect(isLlmContextCompactedEvent(undefined)).toBe(false);
    expect(isLlmContextCompactedEvent({})).toBe(false);
  });

  it('returns false for the sibling clear event (no substring collision)', () => {
    expect(
      isLlmContextCompactedEvent({
        __model__: 'akgentic.llm.event.LlmContextClearedEvent',
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isLlmContextClearedEvent — inner-event check (ADR-010 §8, AC #2)
// ---------------------------------------------------------------------------

describe('isLlmContextClearedEvent', () => {
  it('returns true for an inner event whose __model__ includes "LlmContextClearedEvent"', () => {
    expect(
      isLlmContextClearedEvent({
        __model__: 'akgentic.llm.event.LlmContextClearedEvent',
      }),
    ).toBe(true);
  });

  it('returns false for null / undefined / missing __model__', () => {
    expect(isLlmContextClearedEvent(null)).toBe(false);
    expect(isLlmContextClearedEvent(undefined)).toBe(false);
    expect(isLlmContextClearedEvent({})).toBe(false);
  });

  it('returns false for the sibling compaction event (no substring collision)', () => {
    expect(
      isLlmContextClearedEvent({
        __model__: 'akgentic.llm.event.LlmContextCompactedEvent',
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC #2 — the FIVE Llm*Event / context guards are mutually exclusive.
// For any single inner event exactly ONE of the five guards fires. Crucially
// this protects the two new substrings against collision IN EITHER DIRECTION:
// 'LlmContextCompactedEvent' vs 'LlmContextClearedEvent' (shared 'LlmContext'
// prefix) and against 'LlmMessageEvent' / 'LlmUsageEvent' /
// 'LlmSystemPromptEvent'.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Story 31-2 (AC #1, #2) — the notification-family guards.
//
// Upstream (core Epic 24) `ErrorMessage` and `WarningMessage` are subclasses of
// `NotificationMessage`, but the frontend renders each on its own branch, so the
// three guards must partition the family rather than nest. `isNotificationMessage`
// matching ONLY the bare base is the load-bearing assertion here.
// ---------------------------------------------------------------------------

const ERROR_MODEL = 'akgentic.core.messages.orchestrator.ErrorMessage';
const WARNING_MODEL = 'akgentic.core.messages.orchestrator.WarningMessage';
const NOTIFICATION_MODEL =
  'akgentic.core.messages.orchestrator.NotificationMessage';

function makeNotification(model: string): BaseMessage {
  return makeOrdinaryInner({ __model__: model });
}

describe('isWarningMessage (Story 31-2, AC #1)', () => {
  it('returns true for a WarningMessage', () => {
    expect(isWarningMessage(makeNotification(WARNING_MODEL))).toBe(true);
  });

  it('returns false for an ErrorMessage', () => {
    expect(isWarningMessage(makeNotification(ERROR_MODEL))).toBe(false);
  });

  it('returns false for the bare NotificationMessage base', () => {
    expect(isWarningMessage(makeNotification(NOTIFICATION_MODEL))).toBe(false);
  });
});

describe('isNotificationMessage (Story 31-2, AC #2)', () => {
  it('returns true for the bare NotificationMessage base', () => {
    expect(isNotificationMessage(makeNotification(NOTIFICATION_MODEL))).toBe(
      true,
    );
  });

  // The exclusivity pair: without these two, FR9 is unproven. A `.includes()`
  // implementation would fire for neither, but a naive `.includes('Notification')`
  // one would fire for a hypothetical sibling — the leading dot in
  // `.endsWith('.NotificationMessage')` is what keeps the guard honest.
  it('returns false for an ErrorMessage', () => {
    expect(isNotificationMessage(makeNotification(ERROR_MODEL))).toBe(false);
  });

  it('returns false for a WarningMessage', () => {
    expect(isNotificationMessage(makeNotification(WARNING_MODEL))).toBe(false);
  });

  it('returns false for a suffix-colliding class name (leading dot required)', () => {
    expect(
      isNotificationMessage(
        makeNotification('akgentic.core.messages.orchestrator.FooNotificationMessage'),
      ),
    ).toBe(false);
  });
});

describe('notification-family guards partition the family (Story 31-2, AC #2)', () => {
  const guards = [
    isErrorMessage,
    isWarningMessage,
    isNotificationMessage,
  ] as const;

  it('exactly one guard fires for each of the three models', () => {
    for (const model of [ERROR_MODEL, WARNING_MODEL, NOTIFICATION_MODEL]) {
      const fired = guards
        .map((g) => g(makeNotification(model)))
        .filter(Boolean);
      expect(fired.length).toBe(1);
    }
  });
});

describe('Llm*Event five-guard mutual exclusion (AC #2)', () => {
  const compacted = { __model__: 'akgentic.llm.event.LlmContextCompactedEvent' };
  const cleared = { __model__: 'akgentic.llm.event.LlmContextClearedEvent' };
  const usage = { __model__: 'akgentic.llm.event.LlmUsageEvent' };
  const systemPrompt = { __model__: 'akgentic.llm.event.LlmSystemPromptEvent' };
  const message = { __model__: 'akgentic.llm.event.LlmMessageEvent' };

  const guards = [
    isLlmContextCompactedEvent,
    isLlmContextClearedEvent,
    isLlmUsageEvent,
    isLlmSystemPromptEvent,
    isLlmMessageEvent,
  ] as const;

  it('for a compaction event, ONLY isLlmContextCompactedEvent fires', () => {
    expect(isLlmContextCompactedEvent(compacted)).toBe(true);
    expect(isLlmContextClearedEvent(compacted)).toBe(false);
    expect(isLlmUsageEvent(compacted)).toBe(false);
    expect(isLlmSystemPromptEvent(compacted)).toBe(false);
    expect(isLlmMessageEvent(compacted)).toBe(false);
  });

  it('for a clear event, ONLY isLlmContextClearedEvent fires', () => {
    expect(isLlmContextClearedEvent(cleared)).toBe(true);
    expect(isLlmContextCompactedEvent(cleared)).toBe(false);
    expect(isLlmUsageEvent(cleared)).toBe(false);
    expect(isLlmSystemPromptEvent(cleared)).toBe(false);
    expect(isLlmMessageEvent(cleared)).toBe(false);
  });

  it('the five guards never co-fire for the same event', () => {
    for (const evt of [compacted, cleared, usage, systemPrompt, message]) {
      const fired = guards.map((g) => g(evt)).filter(Boolean);
      expect(fired.length).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Story 31-4 (AC #1, #2) — the ClosedNotification inner-event guard.
//
// This payload is the only one the frontend both READS and WRITES, so the two
// wire tags are pinned as literals here: a silent drift in either one turns the
// dismissal POST into a server-side 400 that no other spec would catch.
// ---------------------------------------------------------------------------

describe('isClosedNotification (Story 31-4, AC #1)', () => {
  it('returns true for a ClosedNotification inner event', () => {
    expect(
      isClosedNotification({ __model__: CLOSED_NOTIFICATION_MODEL }),
    ).toBe(true);
  });

  it('narrows to the payload so message_id is readable', () => {
    const event: { __model__?: string } = {
      __model__: CLOSED_NOTIFICATION_MODEL,
      message_id: 'w-1',
    } as { __model__?: string };
    expect(isClosedNotification(event) && event.message_id).toBe('w-1');
  });

  // AC #2 — negative for every OTHER inner event already on the wire.
  it('returns false for every other inner event on the wire', () => {
    for (const model of [
      'akgentic.llm.event.LlmUsageEvent',
      'akgentic.llm.event.LlmSystemPromptEvent',
      'akgentic.llm.event.LlmContextCompactedEvent',
      'akgentic.llm.event.LlmContextClearedEvent',
      'akgentic.tool.command.CommandsAnnouncedEvent',
    ]) {
      expect(isClosedNotification({ __model__: model })).toBe(false);
    }
  });

  it('returns false for null, undefined and a __model__-less object', () => {
    expect(isClosedNotification(null)).toBe(false);
    expect(isClosedNotification(undefined)).toBe(false);
    expect(isClosedNotification({})).toBe(false);
  });

  // The inverse direction: none of the five existing inner-event guards may
  // fire for a ClosedNotification either.
  it('no Llm*Event / CommandsAnnounced guard fires for a ClosedNotification', () => {
    const closed = { __model__: CLOSED_NOTIFICATION_MODEL };
    expect(isLlmUsageEvent(closed)).toBe(false);
    expect(isLlmSystemPromptEvent(closed)).toBe(false);
    expect(isLlmContextCompactedEvent(closed)).toBe(false);
    expect(isLlmContextClearedEvent(closed)).toBe(false);
    expect(isLlmMessageEvent(closed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTeamStoppingEvent — inner-event check (Story 37-2, AC1)
//
// The tag is written INLINE rather than imported: this payload is read-only, so
// it has no exported constant on purpose (only the one envelope the frontend
// CONSTRUCTS needs a byte-exact literal). The `Llm*Event` blocks above do the
// same for the same reason.
// ---------------------------------------------------------------------------

const TEAM_STOPPING_MODEL =
  'akgentic.core.messages.orchestrator.TeamStoppingEvent';

describe('isTeamStoppingEvent (Story 37-2, AC1)', () => {
  it('returns true for a TeamStoppingEvent inner event', () => {
    expect(isTeamStoppingEvent({ __model__: TEAM_STOPPING_MODEL })).toBe(true);
  });

  it('returns false for null, undefined and a __model__-less object', () => {
    expect(isTeamStoppingEvent(null)).toBe(false);
    expect(isTeamStoppingEvent(undefined)).toBe(false);
    expect(isTeamStoppingEvent({})).toBe(false);
  });

  it('returns false for every other inner event on the wire', () => {
    for (const model of [
      CLOSED_NOTIFICATION_MODEL,
      'akgentic.llm.event.LlmUsageEvent',
      'akgentic.llm.event.LlmSystemPromptEvent',
      'akgentic.llm.event.LlmContextCompactedEvent',
      'akgentic.llm.event.LlmContextClearedEvent',
      'akgentic.tool.command.CommandsAnnouncedEvent',
    ]) {
      expect(isTeamStoppingEvent({ __model__: model })).toBe(false);
    }
  });

  // The trap the guard exists to avoid: it takes the INNER payload, never the
  // envelope. A guard that fired on the envelope would fire for EVERY
  // EventMessage, and the reactor built on it would mark healthy teams dead.
  it('returns false for the EventMessage envelope tag', () => {
    expect(isTeamStoppingEvent({ __model__: EVENT_MESSAGE_MODEL })).toBe(false);
  });

  // Mutual exclusion with `isClosedNotification`, in BOTH directions. That pair
  // is the one that matters: `ClosedNotification` is a real payload the app
  // already depends on, so a collision here would break dismissed-notification
  // replay rather than something hypothetical.
  it('is mutually exclusive with isClosedNotification in both directions', () => {
    const stopping = { __model__: TEAM_STOPPING_MODEL };
    const closed = { __model__: CLOSED_NOTIFICATION_MODEL };
    expect(isClosedNotification(stopping)).toBe(false);
    expect(isTeamStoppingEvent(closed)).toBe(false);
  });

  it('no other inner-event guard fires for a TeamStoppingEvent', () => {
    const stopping = { __model__: TEAM_STOPPING_MODEL };
    expect(isLlmUsageEvent(stopping)).toBe(false);
    expect(isLlmSystemPromptEvent(stopping)).toBe(false);
    expect(isLlmContextCompactedEvent(stopping)).toBe(false);
    expect(isLlmContextClearedEvent(stopping)).toBe(false);
    expect(isLlmMessageEvent(stopping)).toBe(false);
  });
});

describe('wire-tag constants (Story 31-4, AC #3)', () => {
  // The exact Python import paths. `decode_message` resolves both by import
  // path server-side, so a typo here is a 400 at runtime, not a type error.
  it('name the akgentic-core orchestrator module paths verbatim', () => {
    expect(EVENT_MESSAGE_MODEL).toBe(
      'akgentic.core.messages.orchestrator.EventMessage',
    );
    expect(CLOSED_NOTIFICATION_MODEL).toBe(
      'akgentic.core.messages.orchestrator.ClosedNotification',
    );
  });

  it('the envelope tag is recognised by isEventMessage', () => {
    expect(
      isEventMessage(makeOrdinaryInner({ __model__: EVENT_MESSAGE_MODEL })),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Story 31-6 (AC #6) — the shared severity classifier
//
// Moved here from `MessageListComponent`, where it was the Messages tab's
// private predicate while `IngestionService` carried a second, two-way encoding
// of the same partition inline. These specs cover the function itself; the
// component keeps its own delegation specs, and `ingestion.service.spec.ts`
// covers the toast severities the service now derives from it.
// ---------------------------------------------------------------------------

describe('notificationSeverity (Story 31-6, AC #6)', () => {
  const ORCHESTRATOR = 'akgentic.core.messages.orchestrator.';

  function frame(model: string): BaseMessage {
    return makeOrdinaryInner({ __model__: ORCHESTRATOR + model });
  }

  it('maps each member of the notification family to its severity', () => {
    expect(notificationSeverity(frame('ErrorMessage'))).toBe('error');
    expect(notificationSeverity(frame('WarningMessage'))).toBe('warn');
    expect(notificationSeverity(frame('NotificationMessage'))).toBe('info');
  });

  it('returns null for every non-notification frame on the wire', () => {
    for (const model of [
      'SentMessage',
      'ReceivedMessage',
      'ProcessedMessage',
      'StartMessage',
      'StopMessage',
      'StateChangedMessage',
      'EventMessage',
      'UserMessage',
      'ResultMessage',
    ]) {
      expect(notificationSeverity(frame(model)))
        .withContext(model)
        .toBeNull();
    }
  });

  // Guard ORDER, not just guard membership. `ErrorMessage` and `WarningMessage`
  // are `NotificationMessage` subclasses upstream; reordering the body so the
  // bare-base check ran first would still return a severity for all three, just
  // the wrong one for two of them. Only asserting the specific severities — as
  // the first spec does — catches that, and this spec states the reason.
  it('claims errors and warnings BEFORE the bare notification base', () => {
    expect(notificationSeverity(frame('ErrorMessage'))).not.toBe('info');
    expect(notificationSeverity(frame('WarningMessage'))).not.toBe('info');
  });

  // The `endsWith('.NotificationMessage')` half of `isNotificationMessage`: a
  // suffix-colliding sibling is classifiable by nothing, and `messageListFold`
  // relies on this to keep it out of the Messages tab entirely.
  it('returns null for a suffix-colliding sibling', () => {
    expect(notificationSeverity(frame('FooNotificationMessage'))).toBeNull();
  });

  it('agrees with the three guards it is built from', () => {
    const error = frame('ErrorMessage');
    const warning = frame('WarningMessage');
    const bare = frame('NotificationMessage');

    expect(isErrorMessage(error)).toBe(true);
    expect(isWarningMessage(warning)).toBe(true);
    expect(isNotificationMessage(bare)).toBe(true);
    expect(isNotificationMessage(error)).toBe(false);
    expect(isNotificationMessage(warning)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Story 39-1 — the two tool-event types, their guards, and the arguments parse.
//
// Both tags are written INLINE for the same reason the `TeamStoppingEvent` block
// above does it: these payloads are read-only, so neither gets an exported
// wire-tag constant (only the one envelope the frontend CONSTRUCTS needs a
// byte-exact literal).
// ---------------------------------------------------------------------------

const TOOL_CALL_MODEL = 'akgentic.llm.event.ToolCallEvent';
const TOOL_RETURN_MODEL = 'akgentic.llm.event.ToolReturnEvent';

/** Every OTHER inner-event tag already on the wire — the negative sweep. */
const OTHER_INNER_EVENT_MODELS = [
  CLOSED_NOTIFICATION_MODEL,
  TEAM_STOPPING_MODEL,
  'akgentic.llm.event.LlmUsageEvent',
  'akgentic.llm.event.LlmSystemPromptEvent',
  'akgentic.llm.event.LlmContextCompactedEvent',
  'akgentic.llm.event.LlmContextClearedEvent',
  'akgentic.llm.event.LlmMessageEvent',
  'akgentic.tool.command.CommandsAnnouncedEvent',
];

/** Every pre-existing inner-event guard, for the inverse-direction sweep. */
const EXISTING_INNER_EVENT_GUARDS = [
  isClosedNotification,
  isTeamStoppingEvent,
  isLlmUsageEvent,
  isLlmSystemPromptEvent,
  isLlmContextCompactedEvent,
  isLlmContextClearedEvent,
  isLlmMessageEvent,
  isCommandsAnnouncedEvent,
] as const;

function makeToolCall(toolName: string, argsJson: string): ToolCallEvent {
  return {
    __model__: TOOL_CALL_MODEL,
    run_id: 'run-1',
    tool_name: toolName,
    tool_call_id: 'call-1',
    arguments: argsJson,
  };
}

describe('isToolCallEvent (Story 39-1, AC #3, #4, #5)', () => {
  it('returns true for a ToolCallEvent inner event', () => {
    expect(isToolCallEvent({ __model__: TOOL_CALL_MODEL })).toBe(true);
  });

  it('returns false for null, undefined and a __model__-less object', () => {
    expect(isToolCallEvent(null)).toBe(false);
    expect(isToolCallEvent(undefined)).toBe(false);
    expect(isToolCallEvent({})).toBe(false);
  });

  // The trap the guard exists to avoid: it takes the INNER payload, never the
  // envelope. A guard keyed on the envelope fires for EVERY EventMessage, and
  // the fold built on it would invalidate the workspace on every LLM message —
  // with every other spec in this file still green.
  it('returns false for the EventMessage envelope tag', () => {
    expect(isToolCallEvent({ __model__: EVENT_MESSAGE_MODEL })).toBe(false);
  });

  it('returns false for every other inner event on the wire', () => {
    for (const model of [...OTHER_INNER_EVENT_MODELS, TOOL_RETURN_MODEL]) {
      expect(isToolCallEvent({ __model__: model }))
        .withContext(model)
        .toBe(false);
    }
  });

  it('narrows to the payload so the call fields are readable', () => {
    const event: { __model__?: string } = makeToolCall(
      'workspace_write',
      '{"path":"a.md"}',
    );
    expect(isToolCallEvent(event) && event.tool_name).toBe('workspace_write');
    expect(isToolCallEvent(event) && event.tool_call_id).toBe('call-1');
    expect(isToolCallEvent(event) && event.run_id).toBe('run-1');
    // `arguments` stays a STRING on the wire — not an object, not `any`.
    expect(isToolCallEvent(event) && typeof event.arguments).toBe('string');
  });
});

describe('isToolReturnEvent (Story 39-1, AC #3, #4, #5)', () => {
  it('returns true for a ToolReturnEvent inner event', () => {
    expect(isToolReturnEvent({ __model__: TOOL_RETURN_MODEL })).toBe(true);
  });

  it('returns false for null, undefined and a __model__-less object', () => {
    expect(isToolReturnEvent(null)).toBe(false);
    expect(isToolReturnEvent(undefined)).toBe(false);
    expect(isToolReturnEvent({})).toBe(false);
  });

  it('returns false for the EventMessage envelope tag', () => {
    expect(isToolReturnEvent({ __model__: EVENT_MESSAGE_MODEL })).toBe(false);
  });

  it('returns false for every other inner event on the wire', () => {
    for (const model of [...OTHER_INNER_EVENT_MODELS, TOOL_CALL_MODEL]) {
      expect(isToolReturnEvent({ __model__: model }))
        .withContext(model)
        .toBe(false);
    }
  });

  // AC #2 — the return event carries NO path and NO arguments. The object
  // literal below is typed `ToolReturnEvent`, so excess-property checking makes
  // adding either one a compile error; the runtime key check states the same
  // fact for a reader, and pins that the verdict rides `success`.
  it('carries exactly the five wire fields — no arguments, no path', () => {
    const event: ToolReturnEvent = {
      __model__: TOOL_RETURN_MODEL,
      run_id: 'run-1',
      tool_name: 'workspace_write',
      tool_call_id: 'call-1',
      success: true,
    };
    expect(Object.keys(event).sort()).toEqual([
      '__model__',
      'run_id',
      'success',
      'tool_call_id',
      'tool_name',
    ]);
  });
});

describe('tool-event guards vs every pre-existing inner-event guard (AC #5)', () => {
  it('no pre-existing guard fires for either new tag', () => {
    for (const model of [TOOL_CALL_MODEL, TOOL_RETURN_MODEL]) {
      for (const guard of EXISTING_INNER_EVENT_GUARDS) {
        expect(guard({ __model__: model }))
          .withContext(model + ' / ' + guard.name)
          .toBe(false);
      }
    }
  });

  it('neither new guard fires for any pre-existing inner event', () => {
    for (const model of OTHER_INNER_EVENT_MODELS) {
      expect(isToolCallEvent({ __model__: model }))
        .withContext(model)
        .toBe(false);
      expect(isToolReturnEvent({ __model__: model }))
        .withContext(model)
        .toBe(false);
    }
  });

  it('the two new guards are mutually exclusive in both directions', () => {
    expect(isToolCallEvent({ __model__: TOOL_RETURN_MODEL })).toBe(false);
    expect(isToolReturnEvent({ __model__: TOOL_CALL_MODEL })).toBe(false);
    expect(isToolCallEvent({ __model__: TOOL_CALL_MODEL })).toBe(true);
    expect(isToolReturnEvent({ __model__: TOOL_RETURN_MODEL })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseToolCallArguments (AC #6 — #12)
//
// The helper is called from inside a fold over `log$`, so the binding property
// is that it NEVER throws: one throw on one bad frame stops the fold for the
// rest of the session, with nothing visible anywhere. Every malformed input
// below therefore asserts `null` AND `not.toThrow()`.
// ---------------------------------------------------------------------------

describe('parseToolCallArguments — malformed input never throws (AC #7, #8)', () => {
  const malformed = ['{', '', 'not json', '[1,2,3]', 'null'];

  it('returns null for malformed JSON and non-object roots', () => {
    for (const args of malformed) {
      expect(parseToolCallArguments(makeToolCall('workspace_write', args)))
        .withContext(JSON.stringify(args))
        .toBeNull();
    }
  });

  it('does not raise for any of them, under any tool name', () => {
    const toolNames = [
      'workspace_write',
      'workspace_delete',
      'workspace_edit',
      'workspace_mkdir',
      'workspace_multi_edit',
      'workspace_patch',
      'workspace_read',
      'totally_unknown_tool',
    ];
    for (const toolName of toolNames) {
      for (const args of malformed) {
        expect(() => parseToolCallArguments(makeToolCall(toolName, args)))
          .withContext(toolName + ' / ' + JSON.stringify(args))
          .not.toThrow();
      }
    }
  });

  it('returns null for a JSON string or number root', () => {
    expect(
      parseToolCallArguments(makeToolCall('workspace_write', '"a.md"')),
    ).toBeNull();
    expect(
      parseToolCallArguments(makeToolCall('workspace_write', '42')),
    ).toBeNull();
  });
});

describe('parseToolCallArguments — workspace_write (AC #6, #9, #12)', () => {
  it('parses a well-formed call', () => {
    const parsed = parseToolCallArguments(
      makeToolCall('workspace_write', '{"path":"docs/a.md","content":"hello"}'),
    );
    expect(parsed).toEqual({
      tool_name: 'workspace_write',
      path: 'docs/a.md',
      content: 'hello',
    });
  });

  // `content` is declared but NOT validated: requiring it would make a write of
  // an EMPTY file yield null and silently drop a real mutation.
  it('parses a write with empty or absent content', () => {
    expect(
      parseToolCallArguments(
        makeToolCall('workspace_write', '{"path":"a.md","content":""}'),
      ),
    ).not.toBeNull();
    expect(
      parseToolCallArguments(makeToolCall('workspace_write', '{"path":"a.md"}')),
    ).not.toBeNull();
  });

  it('returns null when path is missing or not a string', () => {
    for (const body of [
      '{}',
      '{"content":"hello"}',
      '{"path":42}',
      '{"path":null}',
      '{"path":{"nested":"a.md"}}',
      '{"path":["a.md"]}',
    ]) {
      expect(parseToolCallArguments(makeToolCall('workspace_write', body)))
        .withContext(body)
        .toBeNull();
    }
  });

  // The empty path is the mirror image of the empty content above, and it goes
  // the other way: an empty content is a real write, an empty path names
  // nothing. Accepting it yields a member that looks valid while the directory
  // derivation built on it resolves to the workspace root — a refresh of the
  // wrong listing rather than no refresh at all.
  it('returns null for an empty path', () => {
    expect(
      parseToolCallArguments(
        makeToolCall('workspace_write', '{"path":"","content":"hello"}'),
      ),
    ).toBeNull();
  });

  // The declared-but-not-validated fields are exactly that: a wrongly-typed one
  // is dropped, never allowed to veto the mutation and never copied through
  // with the wrong type.
  it('drops a wrongly-typed optional field instead of rejecting the call', () => {
    expect(
      parseToolCallArguments(
        makeToolCall('workspace_write', '{"path":"a.md","content":42}'),
      ),
    ).toEqual({ tool_name: 'workspace_write', path: 'a.md' });
    expect(
      parseToolCallArguments(
        makeToolCall(
          'workspace_edit',
          '{"path":"a.md","old_string":7,"replace_all":"yes"}',
        ),
      ),
    ).toEqual({ tool_name: 'workspace_edit', path: 'a.md' });
  });

  // AC #12 — an upstream field addition must not turn a valid mutation into
  // null. The path is returned exactly as the wire carried it (no derivation,
  // no normalisation — that is story 39-2's job).
  it('still parses when unknown keys ride along', () => {
    const parsed = parseToolCallArguments(
      makeToolCall(
        'workspace_write',
        '{"path":"a.md","workspace_id":"w-1","future_field":42}',
      ),
    );
    expect(parsed?.tool_name).toBe('workspace_write');
    expect(parsed && 'path' in parsed && parsed.path).toBe('a.md');
  });
});

describe('parseToolCallArguments — the other single-path tools (AC #6, #9)', () => {
  for (const toolName of ['workspace_delete', 'workspace_mkdir'] as const) {
    it('parses a well-formed ' + toolName, () => {
      const parsed = parseToolCallArguments(
        makeToolCall(toolName, '{"path":"docs/notes"}'),
      );
      expect(parsed?.tool_name).toBe(toolName);
      expect(parsed && 'path' in parsed && parsed.path).toBe('docs/notes');
    });

    it('returns null for a ' + toolName + ' with no usable path', () => {
      expect(parseToolCallArguments(makeToolCall(toolName, '{}'))).toBeNull();
      expect(
        parseToolCallArguments(makeToolCall(toolName, '{"path":7}')),
      ).toBeNull();
    });
  }

  it('parses a workspace_edit with its content fields', () => {
    const parsed = parseToolCallArguments(
      makeToolCall(
        'workspace_edit',
        '{"path":"a.md","old_string":"x","new_string":"y","replace_all":true}',
      ),
    );
    expect(parsed).toEqual({
      tool_name: 'workspace_edit',
      path: 'a.md',
      old_string: 'x',
      new_string: 'y',
      replace_all: true,
    });
  });

  it('parses a workspace_edit that carries only the path', () => {
    expect(
      parseToolCallArguments(makeToolCall('workspace_edit', '{"path":"a.md"}')),
    ).not.toBeNull();
  });

  it('returns null for a workspace_edit with no usable path', () => {
    expect(
      parseToolCallArguments(
        makeToolCall('workspace_edit', '{"old_string":"x","new_string":"y"}'),
      ),
    ).toBeNull();
  });
});

describe('parseToolCallArguments — workspace_multi_edit (AC #6, #9)', () => {
  it('parses N edits and keeps every path', () => {
    const parsed = parseToolCallArguments(
      makeToolCall(
        'workspace_multi_edit',
        '{"edits":[{"path":"a.md","old_string":"x","new_string":"y"},{"path":"b/c.md","replace_all":true}]}',
      ),
    );
    expect(parsed?.tool_name).toBe('workspace_multi_edit');
    const edits =
      parsed && parsed.tool_name === 'workspace_multi_edit' ? parsed.edits : [];
    expect(edits.map((e) => e.path)).toEqual(['a.md', 'b/c.md']);
    expect(edits[0].old_string).toBe('x');
    expect(edits[1].replace_all).toBe(true);
  });

  it('returns null when edits is missing, not an array, or empty', () => {
    for (const body of [
      '{}',
      '{"edits":"a.md"}',
      '{"edits":{"path":"a.md"}}',
      '{"edits":[]}',
    ]) {
      expect(parseToolCallArguments(makeToolCall('workspace_multi_edit', body)))
        .withContext(body)
        .toBeNull();
    }
  });

  // Partial acceptance is the failure this rules out: one bad element must not
  // yield a half-populated edit list that the fold then treats as complete.
  it('returns null when ANY element has no usable path', () => {
    for (const body of [
      '{"edits":[{"path":"a.md"},{"old_string":"x"}]}',
      '{"edits":[{"path":"a.md"},{"path":42}]}',
      '{"edits":[{"path":"a.md"},{"path":""}]}',
      '{"edits":[{"path":"a.md"},null]}',
      '{"edits":[{"path":"a.md"},"b.md"]}',
      '{"edits":[{"path":"a.md"},["b.md"]]}',
    ]) {
      expect(parseToolCallArguments(makeToolCall('workspace_multi_edit', body)))
        .withContext(body)
        .toBeNull();
    }
  });

  it('still parses when unknown keys ride along on an edit', () => {
    expect(
      parseToolCallArguments(
        makeToolCall(
          'workspace_multi_edit',
          '{"edits":[{"path":"a.md","future_field":1}],"future_top":2}',
        ),
      ),
    ).not.toBeNull();
  });
});

describe('parseToolCallArguments — workspace_patch (AC #11)', () => {
  it('parses any well-formed object body', () => {
    expect(
      parseToolCallArguments(
        makeToolCall('workspace_patch', '{"patch_text":"--- a/x.md\\n+++ b/x.md"}'),
      ),
    ).toEqual({
      tool_name: 'workspace_patch',
      patch_text: '--- a/x.md\n+++ b/x.md',
    });
  });

  it('parses an empty body — this tool has no path argument at all', () => {
    expect(
      parseToolCallArguments(makeToolCall('workspace_patch', '{}')),
    ).toEqual({ tool_name: 'workspace_patch' });
  });

  // The diff text is NOT scraped for paths (a second implementation of a
  // backend format, free to drift). 39-2 reloads the whole tree instead.
  it('does not mine a path out of the diff text', () => {
    const parsed = parseToolCallArguments(
      makeToolCall('workspace_patch', '{"patch_text":"--- a/x.md\\n+++ b/x.md"}'),
    );
    expect(parsed && 'path' in parsed).toBe(false);
  });

  it('still returns null for a malformed body', () => {
    expect(
      parseToolCallArguments(makeToolCall('workspace_patch', 'not json')),
    ).toBeNull();
  });
});

describe('parseToolCallArguments — unrecognised tool names (AC #10)', () => {
  it('returns null for the read tools and for a name it has never heard of', () => {
    for (const toolName of [
      'workspace_read',
      'workspace_view',
      'workspace_ls',
      'sandbox_exec_command',
      'totally_unknown_tool',
      '',
    ]) {
      expect(parseToolCallArguments(makeToolCall(toolName, '{"path":"a.md"}')))
        .withContext(toolName)
        .toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Story 44-1 (AC #1, #2) — `isHandledMessage` and the outer-guard partition.
//
// `isHandledMessage` is a bare `.includes('HandledMessage')` like its three
// telemetry siblings, so the load-bearing property is that the substring
// collides with nothing IN EITHER DIRECTION: no existing outer guard may fire
// for a `HandledMessage` `__model__`, and `isHandledMessage` may fire for no
// existing outer `__model__`. Without both directions the guard's placement in
// `chatStep` would be silently order-dependent.
// ---------------------------------------------------------------------------

const HANDLED_MODEL = 'akgentic.core.messages.orchestrator.HandledMessage';

/** Every outer `__model__` on the wire today, excluding `HandledMessage`. */
const OTHER_OUTER_MODELS = [
  'akgentic.core.messages.orchestrator.SentMessage',
  'akgentic.core.messages.orchestrator.ReceivedMessage',
  'akgentic.core.messages.orchestrator.ProcessedMessage',
  'akgentic.core.messages.orchestrator.StartMessage',
  'akgentic.core.messages.orchestrator.StopMessage',
  'akgentic.core.messages.orchestrator.ErrorMessage',
  'akgentic.core.messages.orchestrator.WarningMessage',
  'akgentic.core.messages.orchestrator.NotificationMessage',
  'akgentic.core.messages.orchestrator.StateChangedMessage',
  'akgentic.core.messages.orchestrator.EventMessage',
  'akgentic.core.messages.orchestrator.UserMessage',
  'akgentic.core.messages.orchestrator.ResultMessage',
] as const;

/** The outer guards those twelve models belong to, in the same spirit. */
const OTHER_OUTER_GUARDS = [
  isSentMessage,
  isReceivedMessage,
  isProcessedMessage,
  isStartMessage,
  isStopMessage,
  isErrorMessage,
  isWarningMessage,
  isNotificationMessage,
  isStateChangedMessage,
  isEventMessage,
  isUserMessage,
  isResultMessage,
] as const;

describe('isHandledMessage (Story 44-1, AC #1)', () => {
  it('returns true for the HandledMessage envelope', () => {
    expect(isHandledMessage(makeNotification(HANDLED_MODEL))).toBe(true);
  });

  it('returns false for a message with no __model__ signal at all', () => {
    expect(
      isHandledMessage(makeNotification('akgentic.future.UnknownFutureMessage')),
    ).toBe(false);
  });
});

describe('HandledMessage vs every pre-existing outer guard (Story 44-1, AC #2)', () => {
  it('no pre-existing outer guard fires for a HandledMessage', () => {
    for (const guard of OTHER_OUTER_GUARDS) {
      expect(guard(makeNotification(HANDLED_MODEL)))
        .withContext(guard.name)
        .toBe(false);
    }
  });

  it('isHandledMessage fires for no pre-existing outer model', () => {
    for (const model of OTHER_OUTER_MODELS) {
      expect(isHandledMessage(makeNotification(model)))
        .withContext(model)
        .toBe(false);
    }
  });

  it('exactly one guard fires for the HandledMessage envelope', () => {
    const fired = [...OTHER_OUTER_GUARDS, isHandledMessage]
      .map((g) => g(makeNotification(HANDLED_MODEL)))
      .filter(Boolean);
    expect(fired.length).toBe(1);
  });
});
