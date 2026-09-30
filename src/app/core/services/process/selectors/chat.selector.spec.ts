import { TestBed } from '@angular/core/testing';
import { distinctUntilChanged, firstValueFrom, map } from 'rxjs';

import { ChatMessage } from './chat-message.model';
import {
  ActorAddress,
  AkgenticMessage,
  BaseMessage,
  EventMessage,
  ReceivedMessage,
  SentMessage,
  StartMessage,
  StateChangedMessage,
} from '../../../protocol/message.types';
import {
  chatFold,
  ChatService,
  ChatState,
  chatStep,
  EMPTY_CHAT,
} from './chat.selector';
import { MessageLogService } from '../event/message-log.service';

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

function makeInnerBase(overrides: Partial<BaseMessage> = {}): BaseMessage {
  return {
    id: 'inner-1',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-12T10:00:00Z',
    sender: makeAddress(),
    display_type: 'other',
    content: 'hello',
    __model__: 'akgentic.core.messages.orchestrator.SentMessage',
    ...overrides,
  };
}

function makeSent(overrides: Partial<SentMessage> = {}): SentMessage {
  return {
    id: 'outer-1',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-12T10:00:00Z',
    sender: makeAddress({ name: '@Manager', role: 'Manager', agent_id: 'manager-1' }),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.SentMessage',
    message: makeInnerBase(),
    recipient: makeAddress({ name: '@Human', role: 'Human', agent_id: 'human-1' }),
    ...overrides,
  };
}

function makeReceived(overrides: Partial<ReceivedMessage> = {}): ReceivedMessage {
  return {
    id: 'rcv-1',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-12T10:00:00Z',
    sender: makeAddress({ name: '@Researcher', agent_id: 'agent-1' }),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.ReceivedMessage',
    message_id: 'inner-rcv-1',
    ...overrides,
  };
}

function makeStart(overrides: Partial<StartMessage> = {}): StartMessage {
  return {
    id: 'start-1',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-12T10:00:00Z',
    sender: makeAddress({ name: '@Worker' }),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StartMessage',
    config: {} as any,
    parent: null,
    ...overrides,
  };
}

function makeStateChanged(): StateChangedMessage {
  return {
    id: 'sc-1',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-12T10:00:00Z',
    sender: makeAddress(),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StateChangedMessage',
    state: { phase: 'x' },
  };
}


function makeEvent(
  inner: any,
  overrides: Partial<EventMessage> = {},
): EventMessage {
  return {
    id: 'evt-1',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-12T10:00:00Z',
    sender: makeAddress({ name: '@Researcher', agent_id: 'agent-1' }),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.EventMessage',
    event: inner,
    ...overrides,
  };
}

/** A welcome `SentMessage`: outer `ActorSystem` sender, inner `WelcomeMessage`
 *  payload with `display_type === 'other'` (Story 2.6, ADR-011). */
function makeWelcomeSent(overrides: Partial<SentMessage> = {}): SentMessage {
  return {
    id: 'welcome-outer-1',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-05-18T10:00:00Z',
    sender: makeAddress({
      name: '@ActorSystem',
      role: 'ActorSystem',
      agent_id: 'sys-1',
    }),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.SentMessage',
    message: makeInnerBase({
      id: 'welcome-inner-1',
      sender: makeAddress({
        name: '@Orchestrator',
        role: 'Orchestrator',
        agent_id: 'orch-1',
      }),
      display_type: 'other',
      content: 'Welcome to the agent team !',
      __model__: 'akgentic.team.messages.WelcomeMessage',
    }),
    recipient: makeAddress({ name: '@Human', role: 'Human', agent_id: 'human-1' }),
    ...overrides,
  };
}

function makeUnknown(): AkgenticMessage {
  return {
    id: 'unk',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-12T10:00:00Z',
    sender: makeAddress(),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.future.UnknownFutureMessage',
  } as unknown as AkgenticMessage;
}

// ---------------------------------------------------------------------------
// chatFold (pure function) — direct coverage of FR7 + AC1/AC3/AC6/AC7
// ---------------------------------------------------------------------------

describe('chatFold / chatStep (pure)', () => {
  it('empty log → EMPTY_CHAT', () => {
    expect(chatFold([])).toEqual(EMPTY_CHAT);
  });

  it('SentMessage appends a classified ChatMessage', () => {
    const msg = makeSent();
    const state = chatFold([msg]);
    expect(state.messages.length).toBe(1);
    expect(state.messages[0].id).toBe('outer-1');
  });

  it('SentMessage from ActorSystem is skipped (no message appended)', () => {
    const msg = makeSent({
      sender: makeAddress({ role: 'ActorSystem', name: '@System' }),
    });
    const state = chatFold([msg]);
    expect(state.messages.length).toBe(0);
  });

  it('SentMessage with empty content is skipped', () => {
    const msg = makeSent({
      message: makeInnerBase({ content: '' }),
    });
    const state = chatFold([msg]);
    expect(state.messages.length).toBe(0);
  });

  it('a message to another agent is still a classified message', () => {
    const contact = makeSent({
      id: 'contact-1',
      sender: makeAddress({ name: '@Manager', role: 'Manager', agent_id: 'manager-1' }),
      recipient: makeAddress({ name: '@Expert', role: 'Expert', agent_id: 'expert-1' }),
      message: makeInnerBase({ id: 'inner-c1', content: 'can you help' }),
    });
    const state = chatFold([contact]);

    // The fold records every addressed send; whether it is drawn is the
    // transcript's business (rules 3 and 4 live in the run tree).
    expect(state.messages.some((m) => m.id === 'contact-1')).toBeTrue();
  });

  it('(AC6 / FR11) UnknownFutureMessage interleaved is a pure no-op', () => {
    const rcv = makeReceived();
    const unk = makeUnknown();
    const sent = makeSent({
      sender: makeAddress({ name: '@Researcher', agent_id: 'agent-1', role: 'Worker' }),
    });
    const withUnk = chatFold([rcv, unk, sent]);
    const withoutUnk = chatFold([rcv, sent]);
    expect(withUnk).toEqual(withoutUnk);
  });

  // Story 52-2 (AC #9) — the orchestrator's `WorkspaceAttached` payload rides
  // the same `EventMessage` envelope as the tool and context events this fold
  // DOES read. It must fall through: no bubble, no marker, no tool row. The
  // baseline is asserted non-empty first, so the equality is not vacuous.
  it('(Story 52-2) a WorkspaceAttached envelope from the orchestrator is a pure no-op', () => {
    const rcv = makeReceived();
    const sent = makeSent({
      sender: makeAddress({ name: '@Researcher', agent_id: 'agent-1', role: 'Worker' }),
    });
    // The module segment is a placeholder: the tool slice that declares the
    // dataclass is unwritten, and the guard never reads it.
    const attach = makeEvent(
      {
        __model__: 'akgentic.tool.workspace.event.WorkspaceAttached',
        agent_id: 'agent-1',
        workspace_path: 'users/u1/notes',
      },
      {
        id: 'attach-1',
        sender: makeAddress({
          name: '@Orchestrator',
          role: 'Orchestrator',
          agent_id: 'orch-1',
        }),
      },
    );

    const baseline = chatFold([rcv, sent]);
    expect(baseline.messages.length).toBeGreaterThan(0);

    expect(chatFold([attach, rcv, sent])).toEqual(baseline);
    expect(chatFold([rcv, attach, sent])).toEqual(baseline);
    expect(chatFold([rcv, sent, attach])).toEqual(baseline);

    // And at the step level it is the same state REFERENCE, like every other
    // neutral frame — no fresh object, so OnPush consumers see nothing.
    const mid = chatFold([rcv]);
    expect(chatStep(mid, attach)).toBe(mid);
  });

  it('(AC7) neutral event (StartMessage) returns same state reference', () => {
    const before = chatFold([]);
    const after = chatStep(before, makeStart());
    expect(after).toBe(before);
  });

  it('(AC7) neutral event (StateChangedMessage) returns same state reference', () => {
    const before = chatFold([]);
    const after = chatStep(before, makeStateChanged());
    expect(after).toBe(before);
  });

  // Story 2.6 (AC3) — welcome announcement reaches the chat panel
  it('welcome announcement is admitted into messages despite ActorSystem outer sender', () => {
    const state = chatFold([makeWelcomeSent()]);
    expect(state.messages.length).toBe(1);
    expect(state.messages[0].id).toBe('welcome-outer-1');
    expect(state.messages[0].rule).toBe(5);
  });

  it('welcome announcement with empty content is still dropped (empty-content guard)', () => {
    const msg = makeWelcomeSent({
      message: makeInnerBase({
        content: '',
        display_type: 'other',
        __model__: 'akgentic.team.messages.WelcomeMessage',
      }),
    });
    expect(chatFold([msg]).messages.length).toBe(0);
  });

  it('ordinary ActorSystem SentMessage is still dropped from messages', () => {
    const msg = makeSent({
      sender: makeAddress({ role: 'ActorSystem', name: '@ActorSystem' }),
    });
    expect(chatFold([msg]).messages.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// chatStep — context-management markers (Epic 29 / ADR-010 §3/§8)
// ---------------------------------------------------------------------------

describe('chatStep — context-management markers (Epic 29 / ADR-010)', () => {
  function makeCompactionEvent(
    overrides: Record<string, unknown> = {},
    msgOverrides: Partial<EventMessage> = {},
  ): EventMessage {
    return makeEvent(
      {
        __model__: 'akgentic.llm.event.LlmContextCompactedEvent',
        run_id: 'run-1',
        strategy_id: 'summarize',
        summary: 'condensed earlier history',
        replaced_message_count: 6,
        summarizer_prompt_version: 'v1',
        tokens_before: 9000,
        tokens_after: 1200,
        ...overrides,
      },
      msgOverrides,
    );
  }

  function makeClearEvent(
    overrides: Record<string, unknown> = {},
    msgOverrides: Partial<EventMessage> = {},
  ): EventMessage {
    return makeEvent(
      {
        __model__: 'akgentic.llm.event.LlmContextClearedEvent',
        run_id: 'run-2',
        cleared_message_count: 3,
        ...overrides,
      },
      msgOverrides,
    );
  }

  it('compaction EventMessage → a Rule 6 marker carrying count + expandable summary', () => {
    const state = chatFold([makeCompactionEvent()]);
    expect(state.messages.length).toBe(1);
    expect(state.messages[0].rule).toBe(6);
    expect(state.messages[0].label).toBe('Summarized 6 messages');
    expect(state.messages[0].content).toBe('condensed earlier history');
    expect(state.messages[0].collapsed).toBe(true);
  });

  it('clear EventMessage → a Rule 7 marker (non-collapsible, no summary)', () => {
    const state = chatFold([makeClearEvent()]);
    expect(state.messages.length).toBe(1);
    expect(state.messages[0].rule).toBe(7);
    expect(state.messages[0].label).toBe('Conversation cleared (3 messages)');
    expect(state.messages[0].collapsed).toBe(false);
  });

  it('marker sits CHRONOLOGICALLY at the event log index, between surrounding messages', () => {
    const before = makeSent({
      id: 'before-1',
      sender: makeAddress({ name: '@Worker', role: 'Worker', agent_id: 'w-1' }),
      message: makeInnerBase({ content: 'first' }),
    });
    const after = makeSent({
      id: 'after-1',
      sender: makeAddress({ name: '@Worker', role: 'Worker', agent_id: 'w-1' }),
      message: makeInnerBase({ content: 'second' }),
    });
    const state = chatFold([before, makeCompactionEvent(), after]);
    expect(state.messages.map((m) => m.id)).toEqual(['before-1', 'evt-1', 'after-1']);
    expect(state.messages[1].rule).toBe(6);
  });

  it('two sequential context events emit two markers in order (guard exclusivity)', () => {
    const state = chatFold([
      makeCompactionEvent(),
      makeClearEvent({}, { id: 'evt-2' }),
    ]);
    expect(state.messages.map((m) => m.rule)).toEqual([6, 7]);
    expect(state.messages.map((m) => m.id)).toEqual(['evt-1', 'evt-2']);
  });

  it('(AC5) markers are pure/incremental — a log shrink yields no stale marker', () => {
    expect(chatFold([makeCompactionEvent()]).messages.length).toBe(1);
    // Fold-from-scratch over a shorter log (the event gone) → no marker.
    expect(chatFold([]).messages.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ChatService (selector over MessageLogService.log$)
// ---------------------------------------------------------------------------

describe('ChatService (selector over log$)', () => {
  let log: MessageLogService;
  let service: ChatService;

  /** The message slice of `chat$`, as the transcript reads it. */
  function messages(): Promise<ChatMessage[]> {
    return firstValueFrom(service.chat$.pipe(map((s) => s.messages)));
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [MessageLogService, ChatService],
    });
    log = TestBed.inject(MessageLogService);
    service = TestBed.inject(ChatService);
  });

  it('retired imperative mutators are not exposed', () => {
    expect((service as any).beginThinking).toBeUndefined();
    expect((service as any).appendToolCall).toBeUndefined();
    expect((service as any).markToolDone).toBeUndefined();
    expect((service as any).finaliseOrDiscard).toBeUndefined();
  });

  it('initial chat$ messages emit []', async () => {
    expect(await messages()).toEqual([]);
  });

  it('SentMessage appended → chat$ emits classified list', async () => {
    log.append(makeSent());
    const msgs = await messages();
    expect(msgs.length).toBe(1);
    expect(msgs[0].id).toBe('outer-1');
  });

  it('(AC4 late-subscriber) messages appended BEFORE subscribe → first emission has them', async () => {
    log.append(makeReceived());
    log.append(makeSent({
      sender: makeAddress({ name: '@Researcher', agent_id: 'agent-1', role: 'Worker' }),
    }));

    let received: ChatState | undefined;
    const sub = service.chat$.subscribe((v) => (received = v));
    expect(received).toBeDefined();
    expect(received!.messages.length).toBe(1);
    expect(received!.messages[0].id).toBe('outer-1');
    sub.unsubscribe();
  });

  it('(AC7) StartMessage (non-chat-relevant) does NOT re-emit the messages', async () => {
    const emissions: ChatMessage[][] = [];
    const sub = service.chat$
      .pipe(
        map((s) => s.messages),
        distinctUntilChanged(),
      )
      .subscribe((v) => emissions.push(v));
    log.append(makeStart());
    log.append(makeStart({ id: 'start-2' }));
    // Only the initial baseline emission should be present: a neutral frame
    // leaves the slice's reference untouched, so `distinctUntilChanged()`
    // deduplicates it.
    expect(emissions.length).toBe(1);
    sub.unsubscribe();
  });

  it('(AC6) UnknownFutureMessage interleaved → state identical to without', async () => {
    log.append(makeReceived());
    log.append(makeUnknown());
    log.append(makeSent({
      sender: makeAddress({ name: '@Researcher', agent_id: 'agent-1', role: 'Worker' }),
    }));
    const msgs = await messages();
    expect(msgs.length).toBe(1);
    expect(msgs[0].id).toBe('outer-1');
  });

  it('log.reset() clears derived chat state', async () => {
    log.append(makeSent());
    expect((await messages()).length).toBe(1);
    log.reset();
    expect((await messages()).length).toBe(0);
  });

  it('(Story 2.6, AC3) welcome announcement reaches chat$', async () => {
    log.append(makeWelcomeSent());
    const msgs = await messages();
    expect(msgs.length).toBe(1);
    expect(msgs[0].rule).toBe(5);
  });

  it('(Epic 29) a compaction EventMessage reaches chat$ as a Rule 6 marker', async () => {
    log.append(
      makeEvent({
        __model__: 'akgentic.llm.event.LlmContextCompactedEvent',
        run_id: 'run-1',
        strategy_id: 'summarize',
        summary: 'condensed',
        replaced_message_count: 4,
        summarizer_prompt_version: 'v1',
        tokens_before: 8000,
        tokens_after: 1000,
      }),
    );
    const msgs = await messages();
    expect(msgs.length).toBe(1);
    expect(msgs[0].rule).toBe(6);
    expect(msgs[0].label).toBe('Summarized 4 messages');
  });
});
