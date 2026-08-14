import { TestBed } from '@angular/core/testing';

import { ApiService } from '../../../core/http/api.service';
import { AgentStateResponse } from '../../../core/context/team.interface';
import {
  AkgenticMessage,
  StateChangedMessage,
} from '../../../protocol/message.types';
import { MessageLogService } from './message-log.service';
import { ReplaySeeder } from './replay-seeder';

// ---------------------------------------------------------------------
// Fixtures. Realistic agent UUIDs (team Epic 23) kept distinct from the
// display names, so a UUID-keying assertion is meaningful.
// ---------------------------------------------------------------------

const UUID_A = '7f3c1e90-2a4b-4c6d-8e10-1234567890ab';
const UUID_B = '0a0a0a0a-bbbb-cccc-dddd-eeeeeeeeeeee';

function snapshot(
  agentId: string,
  state: Record<string, unknown>,
  name: string | null = '@Researcher',
  updatedAt = '2026-06-18T00:00:00Z',
): AgentStateResponse {
  return { agent_id: agentId, name, state, updated_at: updatedAt };
}

/** A well-formed durable event, as `getEvents` returns it. */
function eventResponse(id: string, model: string): any {
  return {
    team_id: 'team-1',
    sequence: 1,
    timestamp: '2026-06-18T00:00:00Z',
    event: {
      id,
      parent_id: null,
      team_id: 'team-1',
      timestamp: '2026-06-18T00:00:00Z',
      sender: null,
      display_type: 'ai',
      content: 'hello',
      __model__: model,
    },
  };
}

interface ApiStub {
  getEvents: jasmine.Spy;
  getAgentStates: jasmine.Spy;
}

/**
 * The MINIMAL provider set is itself an assertion (Epic 34 / ADR-025 §1):
 * `ReplaySeeder` depends on `ApiService` and on NOTHING else. No
 * `WebSocketSubject`, no `ConfigService`, no PrimeNG `MessageService`, no
 * `PerAgentStoreRegistry`, no `IngestionService` — and, load-bearing for this
 * story, no `MessageLogService`: the unit returns messages and appends none, so
 * the whole REST replay path specs with no transport and no log harness. If
 * `ReplaySeeder` ever grows a dependency, every test in this file fails at
 * construction with `NullInjectorError`. Do NOT "fix" such a failure by
 * widening this array.
 */
function setup(): { seeder: ReplaySeeder; api: ApiStub } {
  const api: ApiStub = {
    getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
    getAgentStates: jasmine.createSpy('getAgentStates').and.resolveTo([]),
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [ReplaySeeder, { provide: ApiService, useValue: api }],
  });

  return { seeder: TestBed.inject(ReplaySeeder), api };
}

describe('ReplaySeeder.seedMessages — agent-state snapshots (Story 25-1, Epic 34)', () => {
  it('maps each snapshot to the four fields the state fold reads, plus the discriminator', async () => {
    const { seeder, api } = setup();
    api.getAgentStates.and.resolveTo([
      snapshot(UUID_A, { backstory: 'A seasoned researcher.' }),
    ]);

    const msgs = await seeder.seedMessages('team-1');

    expect(api.getAgentStates).toHaveBeenCalledWith('team-1');
    expect(msgs.length).toBe(1);

    const seeded = msgs[0] as StateChangedMessage;
    // Keyed by the agent UUID (team Epic 23) — NOT the display name.
    expect(seeded.sender?.agent_id).toBe(UUID_A);
    expect(seeded.state).toEqual({ backstory: 'A seasoned researcher.' });
    expect(seeded.timestamp).toBe('2026-06-18T00:00:00Z');
    // The discriminator is what admits the synthesized entry to the fold.
    expect(seeded.__model__).toBe(
      'akgentic.core.messages.orchestrator.StateChangedMessage',
    );
  });

  it('gives every synthesized entry an EMPTY id', async () => {
    const { seeder, api } = setup();
    api.getAgentStates.and.resolveTo([
      snapshot(UUID_A, { backstory: 'A.' }),
      snapshot(UUID_B, { backstory: 'B.' }, '@Writer', '2026-06-18T00:00:01Z'),
    ]);

    const msgs = await seeder.seedMessages('team-1');

    expect(msgs.map((m) => m.id)).toEqual(['', '']);
  });

  it('maps a null snapshot name to an empty sender name (the fold reads neither)', async () => {
    const { seeder, api } = setup();
    api.getAgentStates.and.resolveTo([snapshot(UUID_A, { k: 'v' }, null)]);

    const msgs = await seeder.seedMessages('team-1');

    expect((msgs[0] as StateChangedMessage).sender?.name).toBe('');
  });

  it('returns [] for an empty snapshot list (no throw, no synthesized entry)', async () => {
    const { seeder, api } = setup();
    api.getAgentStates.and.resolveTo([]);

    // The old `if (states.length === 0) return;` early return is deliberately
    // NOT re-added as a guard: returning [] and letting the caller's
    // `appendAll([])` no-op is exactly equivalent.
    await expectAsync(seeder.seedMessages('team-1')).toBeResolvedTo([]);
  });

  it('holds nothing between calls — two identical calls yield identical results', async () => {
    const { seeder, api } = setup();
    api.getAgentStates.and.resolveTo([snapshot(UUID_A, { backstory: 'A.' })]);

    // A source that remembers is a source with a bug (ADR-025 §0): no cache, no
    // cursor, no already-seeded flag may creep in here.
    const first = await seeder.seedMessages('team-1');
    const second = await seeder.seedMessages('team-1');

    expect(second).toEqual(first);
  });
});

describe('ReplaySeeder — synthesized entries survive log dedup (Story 25-1, Epic 34)', () => {
  /**
   * The only tests in this file that need a log, and they get their own TestBed
   * so the minimal provider set above still stands as the dependency assertion.
   */
  function setupWithLog(): {
    seeder: ReplaySeeder;
    log: MessageLogService;
    api: ApiStub;
  } {
    const api: ApiStub = {
      getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
      getAgentStates: jasmine.createSpy('getAgentStates').and.resolveTo([
        snapshot(UUID_A, { backstory: 'A.' }),
        snapshot(UUID_B, { backstory: 'B.' }, '@Writer', '2026-06-18T00:00:01Z'),
      ]),
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ReplaySeeder,
        MessageLogService,
        { provide: ApiService, useValue: api },
      ],
    });

    return {
      seeder: TestBed.inject(ReplaySeeder),
      log: TestBed.inject(MessageLogService),
      api,
    };
  }

  it('appends N seeded entries as N log entries through the REAL appendAll', async () => {
    const { seeder, log } = setupWithLog();

    log.appendAll(await seeder.seedMessages('team-1'));

    const stored = log.snapshot() as StateChangedMessage[];
    expect(stored.length).toBe(2);
    expect(stored.map((m) => m.sender?.agent_id)).toEqual([UUID_A, UUID_B]);
  });

  it('never dedups a seeded entry against one ALREADY on the log', async () => {
    const { seeder, log } = setupWithLog();

    // THIS is the assertion that pins the empty `id`, and it has to append
    // twice to do it. `appendAll` builds `existingIds` from the CURRENT log
    // only (`message-log.service.ts`), so dedup never applies WITHIN one batch:
    // a single batch of two colliding ids survives intact no matter what the
    // ids are, which makes the one-batch count above unfalsifiable on its own.
    //
    // Across two calls the rule bites, and `!m.id ||` is what exempts seeds
    // from it. Give the synthesized entries any constant id and this second
    // batch is dropped whole — which on a log that was not reset first is a
    // stopped team silently losing its re-seeded agent state.
    log.appendAll(await seeder.seedMessages('team-1'));
    log.appendAll(await seeder.seedMessages('team-1'));

    const stored = log.snapshot() as StateChangedMessage[];
    expect(stored.length).toBe(4);
    expect(stored.map((m) => m.sender?.agent_id)).toEqual([
      UUID_A,
      UUID_B,
      UUID_A,
      UUID_B,
    ]);
  });
});

describe('ReplaySeeder.replayMessages — durable event replay (Epic 34)', () => {
  it('unwraps er.event and drops null, undefined and __model__-less payloads', async () => {
    const { seeder, api } = setup();
    const good = eventResponse(
      'sent-1',
      'akgentic.core.messages.orchestrator.SentMessage',
    );
    const alsoGood = eventResponse(
      'sent-2',
      'akgentic.core.messages.orchestrator.SentMessage',
    );
    api.getEvents.and.resolveTo([
      { team_id: 't', sequence: 1, timestamp: 'ts', event: null },
      good,
      { team_id: 't', sequence: 2, timestamp: 'ts', event: undefined },
      // Structurally an event, but carrying no discriminator: nothing
      // downstream could classify it.
      {
        team_id: 't',
        sequence: 3,
        timestamp: 'ts',
        event: { id: 'x', content: 'no model' },
      },
      alsoGood,
    ]);

    const msgs = await seeder.replayMessages('team-1');

    expect(api.getEvents).toHaveBeenCalledWith('team-1');
    // Only the well-formed pair survives, in arrival order.
    expect(msgs.map((m: AkgenticMessage) => m.id)).toEqual(['sent-1', 'sent-2']);
  });

  it('returns [] for an empty event list', async () => {
    const { seeder, api } = setup();
    api.getEvents.and.resolveTo([]);

    await expectAsync(seeder.replayMessages('team-1')).toBeResolvedTo([]);
  });

  it('propagates a rejection rather than swallowing it', async () => {
    const { seeder, api } = setup();
    api.getEvents.and.rejectWith(new Error('boom'));

    // No try/catch here or in the caller: a failed REST call must reject
    // `init()` before the socket opens, exactly as it does today.
    await expectAsync(seeder.replayMessages('team-1')).toBeRejected();
  });
});

describe('ReplaySeeder — the two REST calls stay separable (Epic 34)', () => {
  it('seedMessages leaves getEvents uncalled, and vice versa', async () => {
    const { seeder, api } = setup();

    await seeder.seedMessages('team-1');
    expect(api.getAgentStates).toHaveBeenCalledTimes(1);
    expect(api.getEvents).not.toHaveBeenCalled();

    await seeder.replayMessages('team-1');
    expect(api.getEvents).toHaveBeenCalledTimes(1);
    expect(api.getAgentStates).toHaveBeenCalledTimes(1);
  });
});

describe('ReplaySeeder — a source with nothing to wire (ADR-025 §2)', () => {
  it('exposes no start / stop / init / ngOnDestroy entry point', () => {
    const { seeder } = setup();

    // The two methods ARE the explicit invocation points: they open no
    // subscription, so there is no "when does this start" for DI to decide.
    // What the rule forbids is a constructor that fires either REST call —
    // which is what the next assertion covers.
    const probe = seeder as unknown as Record<string, unknown>;
    expect(probe['start']).toBeUndefined();
    expect(probe['stop']).toBeUndefined();
    expect(probe['init']).toBeUndefined();
    expect(probe['ngOnDestroy']).toBeUndefined();
  });

  it('issues no REST call at construction time', () => {
    const { api } = setup();

    // TestBed.inject() above constructed the unit. Nothing may have been
    // fetched yet: the orchestrator decides when, inside its sequenced
    // dispose -> reset -> seed -> open block.
    expect(api.getAgentStates).not.toHaveBeenCalled();
    expect(api.getEvents).not.toHaveBeenCalled();
  });
});

describe('ReplaySeeder — component-scoped, never root-provided (Epic 34)', () => {
  it('is NOT reachable from an injector that does not provide it', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      // Its dependency IS provided here, so a failure to inject can only mean
      // `ReplaySeeder` itself is unreachable. Give the class
      // `providedIn: 'root'` and this injection SUCCEEDS instead.
      providers: [{ provide: ApiService, useValue: {} }],
    });

    expect(() => TestBed.inject(ReplaySeeder)).toThrowError(/No provider/);
  });
});
