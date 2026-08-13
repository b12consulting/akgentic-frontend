import {
  ActorAddress,
  BaseMessage,
  CLOSED_NOTIFICATION_MODEL,
  EVENT_MESSAGE_MODEL,
  isClosedNotification,
  isErrorMessage,
  isEventMessage,
  isLlmContextClearedEvent,
  isLlmContextCompactedEvent,
  isLlmMessageEvent,
  isLlmSystemPromptEvent,
  isLlmUsageEvent,
  isNotificationMessage,
  isWarningMessage,
  isWelcomeAnnouncement,
  isWelcomeMessage,
  notificationSeverity,
  SentMessage,
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
