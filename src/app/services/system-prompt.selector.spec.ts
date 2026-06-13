import { TestBed } from '@angular/core/testing';

import { AkgenticMessage } from '../models/message.types';
import { MessageLogService } from './message-log.service';
import {
  latestSystemPromptFold,
  SystemPromptRow,
  SystemPromptSelector,
  systemPromptLabel,
} from './system-prompt.selector';

// ---------------------------------------------------------------------
// Fixtures
//
// These mirror the ADR-004 §5a wire JSON for `EventMessage(LlmSystemPromptEvent)`
// and the existing `EventMessage(LlmMessageEvent)` envelope (the fallback path).
// The backend emitter (akgentic-llm) need NOT be merged/released: the event
// contract is frozen, so fixtures are a sufficient and authoritative source.
// ---------------------------------------------------------------------

interface PartSnapshot {
  __model__?: string;
  dynamic_ref: string | null;
  content: string;
}

function sender(agentId: string) {
  return {
    __actor_address__: true as const,
    agent_id: agentId,
    name: '@' + agentId,
    role: 'Agent',
    squad_id: 's1',
    user_message: false,
  };
}

let envCounter = 0;

/** EventMessage envelope carrying a LlmSystemPromptEvent (primary path). */
function makeSystemPromptEnvelope(
  agentId: string,
  parts: PartSnapshot[],
  content_hash = 'h-' + envCounter,
): AkgenticMessage {
  return {
    id: 'sp-' + agentId + '-' + envCounter++,
    parent_id: null,
    team_id: 'team-1',
    timestamp: new Date().toISOString(),
    sender: sender(agentId),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.EventMessage',
    event: {
      __model__: 'akgentic.llm.event.LlmSystemPromptEvent',
      run_id: 'run-' + content_hash,
      content_hash,
      // `parts` may be deliberately undefined (malformed-event fixture, AC6) —
      // guard the eager map so the malformation reaches the fold, not the builder.
      parts: parts?.map((p) => ({
        __model__: 'akgentic.llm.event.SystemPromptPartSnapshot',
        ...p,
      })),
    },
  } as unknown as AkgenticMessage;
}

/**
 * EventMessage envelope carrying a LlmMessageEvent whose inner ModelRequest
 * `message.parts` include `part_kind === 'system-prompt'` parts (fallback path).
 */
function makeLlmMessageEnvelope(
  agentId: string,
  systemParts: Array<{ dynamic_ref: string | null; content: string }>,
): AkgenticMessage {
  return {
    id: 'llm-' + agentId + '-' + envCounter++,
    parent_id: null,
    team_id: 'team-1',
    timestamp: new Date().toISOString(),
    sender: sender(agentId),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.EventMessage',
    event: {
      __model__: 'akgentic.llm.event.LlmMessageEvent',
      message: {
        parts: [
          ...systemParts.map((p) => ({ part_kind: 'system-prompt', ...p })),
          { part_kind: 'user-prompt', content: 'hi' },
        ],
      },
    },
  } as unknown as AkgenticMessage;
}

function makeUnknownEnvelope(id: string): AkgenticMessage {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: new Date().toISOString(),
    sender: sender('whoever'),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.EventMessage',
    event: { __model__: 'akgentic.llm.event.ToolStateEvent' },
  } as unknown as AkgenticMessage;
}

// ---------------------------------------------------------------------
// Tests — pure fold export
// ---------------------------------------------------------------------

describe('latestSystemPromptFold (pure function)', () => {
  it('AC1 latest-wins: last LlmSystemPromptEvent for the agent yields its parts as rows', () => {
    const log: AkgenticMessage[] = [
      makeSystemPromptEnvelope('A', [
        { dynamic_ref: 'team.roster', content: 'roster v1' },
      ]),
      makeSystemPromptEnvelope('A', [
        { dynamic_ref: 'team.roster', content: 'roster v2' },
        { dynamic_ref: null, content: 'backstory' },
      ]),
    ];
    const rows = latestSystemPromptFold(log, 'A');
    expect(rows).toEqual([
      { type: 'system', name: 'roster', content: 'roster v2' },
      { type: 'system', name: 'System', content: 'backstory' },
    ]);
  });

  it('AC1 label: dynamic_ref takes its trailing segment, null → "System"', () => {
    const rows = latestSystemPromptFold(
      [
        makeSystemPromptEnvelope('A', [
          { dynamic_ref: 'current_date', content: 'today' },
          { dynamic_ref: 'a.b.c', content: 'deep' },
          { dynamic_ref: null, content: 'static' },
        ]),
      ],
      'A',
    );
    expect(rows.map((r) => r.name)).toEqual(['current_date', 'c', 'System']);
  });

  it('AC2 per-agent isolation: A reflects only A, B only B', () => {
    const log: AkgenticMessage[] = [
      makeSystemPromptEnvelope('A', [{ dynamic_ref: null, content: 'A-prompt' }]),
      makeSystemPromptEnvelope('B', [{ dynamic_ref: null, content: 'B-prompt' }]),
    ];
    expect(latestSystemPromptFold(log, 'A')).toEqual([
      { type: 'system', name: 'System', content: 'A-prompt' },
    ]);
    expect(latestSystemPromptFold(log, 'B')).toEqual([
      { type: 'system', name: 'System', content: 'B-prompt' },
    ]);
  });

  it('AC3 fallback: no LlmSystemPromptEvent → first LlmMessageEvent system parts', () => {
    const log: AkgenticMessage[] = [
      makeLlmMessageEnvelope('A', [
        { dynamic_ref: 'team.roster', content: 'legacy roster' },
      ]),
      makeLlmMessageEnvelope('A', [
        { dynamic_ref: 'team.roster', content: 'second message roster' },
      ]),
    ];
    // First such message wins for the fallback.
    expect(latestSystemPromptFold(log, 'A')).toEqual([
      { type: 'system', name: 'roster', content: 'legacy roster' },
    ]);
  });

  it('AC4 precedence: LlmSystemPromptEvent wins over LlmMessageEvent fallback', () => {
    const log: AkgenticMessage[] = [
      makeLlmMessageEnvelope('A', [
        { dynamic_ref: 'team.roster', content: 'legacy roster' },
      ]),
      makeSystemPromptEnvelope('A', [
        { dynamic_ref: 'team.roster', content: 'event roster' },
      ]),
    ];
    expect(latestSystemPromptFold(log, 'A')).toEqual([
      { type: 'system', name: 'roster', content: 'event roster' },
    ]);
  });

  it('AC6 passthrough: malformed/empty latest event yields [] (latest-wins still applies)', () => {
    // Missing parts entirely.
    expect(
      latestSystemPromptFold(
        [makeSystemPromptEnvelope('A', undefined as unknown as PartSnapshot[])],
        'A',
      ),
    ).toEqual([]);
    // Empty parts array.
    expect(
      latestSystemPromptFold([makeSystemPromptEnvelope('A', [])], 'A'),
    ).toEqual([]);
    // A malformed LATEST event above an earlier well-formed one → [] (latest-wins).
    const log: AkgenticMessage[] = [
      makeSystemPromptEnvelope('A', [{ dynamic_ref: null, content: 'good' }]),
      makeSystemPromptEnvelope('A', []),
    ];
    expect(latestSystemPromptFold(log, 'A')).toEqual([]);
  });

  it('AC6 passthrough: a part missing content maps to empty string, no throw', () => {
    const rows = latestSystemPromptFold(
      [
        makeSystemPromptEnvelope('A', [
          { dynamic_ref: 'current_date' } as unknown as PartSnapshot,
        ]),
      ],
      'A',
    );
    expect(rows).toEqual([
      { type: 'system', name: 'current_date', content: '' },
    ]);
  });

  it('AC6 passthrough: a log of only unrelated __model__s yields []', () => {
    const log: AkgenticMessage[] = [
      makeUnknownEnvelope('u1'),
      makeUnknownEnvelope('u2'),
    ];
    expect(latestSystemPromptFold(log, 'A')).toEqual([]);
  });

  it('AC7 absent agent: empty log and no-match log both yield []', () => {
    expect(latestSystemPromptFold([], 'A')).toEqual([]);
    const log: AkgenticMessage[] = [
      makeSystemPromptEnvelope('B', [{ dynamic_ref: null, content: 'B' }]),
    ];
    expect(latestSystemPromptFold(log, 'A')).toEqual([]);
  });

  it('AC9 fresh reference + no input mutation: two folds give distinct arrays, log untouched', () => {
    const log: AkgenticMessage[] = [
      makeSystemPromptEnvelope('A', [{ dynamic_ref: null, content: 'same' }]),
    ];
    const snapshot = JSON.stringify(log);
    const r1 = latestSystemPromptFold(log, 'A');
    const r2 = latestSystemPromptFold(log, 'A');
    expect(r1).toEqual(r2);
    expect(r1).not.toBe(r2);
    expect(JSON.stringify(log)).toBe(snapshot); // input not mutated
  });
});

describe('systemPromptLabel (pure helper)', () => {
  it('returns trailing segment for dotted refs, the ref itself when undotted', () => {
    expect(systemPromptLabel('team.roster')).toBe('roster');
    expect(systemPromptLabel('current_date')).toBe('current_date');
  });

  it('returns "System" for null/undefined/empty', () => {
    expect(systemPromptLabel(null)).toBe('System');
    expect(systemPromptLabel(undefined)).toBe('System');
    expect(systemPromptLabel('')).toBe('System');
  });
});

// ---------------------------------------------------------------------
// Tests — Observable-level (SystemPromptSelector over MessageLogService.log$)
// ---------------------------------------------------------------------

describe('SystemPromptSelector (log-driven selector)', () => {
  let log: MessageLogService;
  let selector: SystemPromptSelector;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [MessageLogService, SystemPromptSelector],
    });
    log = TestBed.inject(MessageLogService);
    selector = TestBed.inject(SystemPromptSelector);
  });

  it('AC8 late-subscriber: shareReplay(1) delivers the current block synchronously', () => {
    log.appendAll([
      makeSystemPromptEnvelope('A', [{ dynamic_ref: null, content: 'v1' }]),
      makeSystemPromptEnvelope('A', [{ dynamic_ref: null, content: 'v2' }]),
    ]);

    let received: SystemPromptRow[] | undefined;
    const sub = selector
      .latestSystemPrompt$('A')
      .subscribe((r) => (received = r));
    expect(received).toEqual([{ type: 'system', name: 'System', content: 'v2' }]);
    sub.unsubscribe();
  });

  it('AC9 distinctUntilChanged: identical head block across a no-op log tick does not re-emit', () => {
    const emissions: SystemPromptRow[][] = [];
    const sub = selector
      .latestSystemPrompt$('A')
      .subscribe((r) => emissions.push(r));

    log.append(
      makeSystemPromptEnvelope('A', [{ dynamic_ref: null, content: 'v1' }]),
    );
    // A log tick that does NOT change A's head block (an unrelated message).
    log.append(makeUnknownEnvelope('u1'));

    // Initial [] + the v1 block. The unrelated tick yields the same [] -> no.
    // Actually: subscribe emits [] (empty log), then v1 block. The unknown
    // envelope leaves the v1 block identical, so it must NOT re-emit.
    expect(emissions.length).toBe(2);
    expect(emissions[0]).toEqual([]);
    expect(emissions[1]).toEqual([
      { type: 'system', name: 'System', content: 'v1' },
    ]);
    sub.unsubscribe();
  });

  it('AC9 fresh reference on real change: distinct array objects across changes', () => {
    const emissions: SystemPromptRow[][] = [];
    const sub = selector
      .latestSystemPrompt$('A')
      .subscribe((r) => emissions.push(r));

    log.append(
      makeSystemPromptEnvelope('A', [{ dynamic_ref: null, content: 'v1' }]),
    );
    log.append(
      makeSystemPromptEnvelope('A', [{ dynamic_ref: null, content: 'v2' }]),
    );

    expect(emissions.length).toBe(3); // [], v1, v2
    expect(emissions[1]).not.toBe(emissions[2]);
    sub.unsubscribe();
  });
});

// ---------------------------------------------------------------------
// Tests — REST/WS parity (AC5)
// ---------------------------------------------------------------------

describe('SystemPromptSelector parity — REST batch vs WS per-message (AC5)', () => {
  function buildFixture(): AkgenticMessage[] {
    return [
      makeLlmMessageEnvelope('A', [
        { dynamic_ref: 'team.roster', content: 'legacy' },
      ]),
      makeSystemPromptEnvelope('A', [
        { dynamic_ref: 'team.roster', content: 'roster v1' },
        { dynamic_ref: 'current_date', content: 'day 1' },
      ]),
      makeSystemPromptEnvelope('A', [
        { dynamic_ref: 'team.roster', content: 'roster v2' },
        { dynamic_ref: 'current_date', content: 'day 2' },
      ]),
    ];
  }

  function head(mode: 'rest' | 'ws'): SystemPromptRow[] {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [MessageLogService, SystemPromptSelector],
    });
    const log = TestBed.inject(MessageLogService);
    const selector = TestBed.inject(SystemPromptSelector);

    const emissions: SystemPromptRow[][] = [];
    const sub = selector
      .latestSystemPrompt$('A')
      .subscribe((r) => emissions.push(r));

    // Distinct envelopes per run so REST dedupe-by-id and WS yield same set.
    const fixture = buildFixture();
    if (mode === 'rest') {
      log.appendAll(fixture);
    } else {
      for (const msg of fixture) log.append(msg);
    }

    const result = emissions[emissions.length - 1];
    sub.unsubscribe();
    return result;
  }

  it('REST batch and WS sequence produce identical head blocks (AC5)', () => {
    const rest = head('rest');
    const ws = head('ws');
    expect(JSON.stringify(rest)).toBe(JSON.stringify(ws));
    // Latest-wins: roster v2 / day 2.
    expect(rest).toEqual([
      { type: 'system', name: 'roster', content: 'roster v2' },
      { type: 'system', name: 'current_date', content: 'day 2' },
    ]);
  });
});
