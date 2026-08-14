import { TestBed } from '@angular/core/testing';

import { AkgenticMessage } from '../../../protocol/message.types';
import { MessageLogService } from './message-log.service';
import { PerAgentStore, PerAgentStoreRegistry } from './per-agent-store';
import { ProcessStores } from './process-stores';

// ---------------------------------------------------------------------
// Fixtures — the two keying paths the five stores use between them:
//   - OUTER-message keying  (StateChangedMessage → `state`)
//   - INNER-event keying    (EventMessage(LlmUsageEvent) → `tokenUsage`)
// Shapes mirror `ingestion.service.spec.ts` / `per-agent-specs.spec.ts`
// verbatim; the real fold is driven through MessageLogService (no mocking).
// ---------------------------------------------------------------------

function sender(agentId: string) {
  return {
    __actor_address__: true as const,
    agent_id: agentId,
    name: '@' + agentId,
    role: 'Worker',
    squad_id: 's1',
    user_message: false,
  };
}

let fixtureCounter = 0;

/** A StateChangedMessage for `agentId` (outer-message keying → `state`). */
function makeStateChanged(agentId: string, state: unknown): AkgenticMessage {
  return {
    id: 'state-' + agentId + '-' + fixtureCounter++,
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-08-14T00:00:00Z',
    sender: sender(agentId),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StateChangedMessage',
    state,
  } as unknown as AkgenticMessage;
}

/** An EventMessage(LlmUsageEvent) for `agentId` (inner-event keying →
 *  `tokenUsage`). */
function makeUsageEnvelope(
  agentId: string,
  input_tokens: number,
  output_tokens: number,
): AkgenticMessage {
  return {
    id: 'usage-' + agentId + '-' + fixtureCounter++,
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-08-14T00:00:00Z',
    sender: sender(agentId),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.EventMessage',
    event: {
      __model__: 'akgentic.llm.event.LlmUsageEvent',
      run_id: 'run-1',
      model_name: 'claude-sonnet',
      provider_name: 'anthropic',
      input_tokens,
      output_tokens,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      requests: 1,
    },
  } as unknown as AkgenticMessage;
}

/**
 * The MINIMAL provider set is itself an assertion (Epic 34 / ADR-025 §1):
 * `ProcessStores` depends on the registry and on nothing else. No
 * `WebSocketSubject`, no `ApiService`, no PrimeNG `MessageService`, no
 * `ConfigService` — if `ProcessStores` ever grows a transport or UI
 * dependency, every test in this file fails at construction with
 * `NullInjectorError`. Do not "fix" such a failure by widening this array.
 */
function setup(): { log: MessageLogService; stores: ProcessStores } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [MessageLogService, PerAgentStoreRegistry, ProcessStores],
  });
  return {
    log: TestBed.inject(MessageLogService),
    stores: TestBed.inject(ProcessStores),
  };
}

describe('ProcessStores — declaration surface (Epic 34, ADR-025 §1)', () => {
  it('exposes the five stores, each a PerAgentStore, from the registry alone', () => {
    const { stores } = setup();

    expect(stores.state).toBeInstanceOf(PerAgentStore);
    expect(stores.context).toBeInstanceOf(PerAgentStore);
    expect(stores.commands).toBeInstanceOf(PerAgentStore);
    expect(stores.systemPrompt).toBeInstanceOf(PerAgentStore);
    expect(stores.tokenUsage).toBeInstanceOf(PerAgentStore);
  });

  it('the five are five DISTINCT instances (no spec aliased onto another bucket)', () => {
    const { stores } = setup();

    const all = [
      stores.state,
      stores.context,
      stores.commands,
      stores.systemPrompt,
      stores.tokenUsage,
    ];
    expect(new Set(all).size).toBe(5);
  });
});

describe('ProcessStores — folds without any start()/init() (Epic 34, ADR-025 §1)', () => {
  it('folds an outer-keyed StateChangedMessage into `state` at construction time', () => {
    const { log, stores } = setup();

    // No start(), no init(), no wiring call of any kind — registration happened
    // in the field initializers, which is exactly what consumers rely on when
    // they read `state.forAgent(id)` before anything else runs.
    log.append(makeStateChanged('agent-A', { mood: 'curious' }));

    expect(stores.state.snapshot('agent-A')).toEqual({
      schema: {},
      state: { mood: 'curious' },
    });

    let seen: unknown = 'unset';
    const sub = stores.state.forAgent('agent-A').subscribe((v) => (seen = v));
    expect(seen).toEqual({ schema: {}, state: { mood: 'curious' } });
    sub.unsubscribe();

    // An agent that never emitted stays absent.
    expect(stores.state.snapshot('agent-Z')).toBeUndefined();
  });

  it('folds an inner-keyed EventMessage(LlmUsageEvent) into `tokenUsage`', () => {
    const { log, stores } = setup();

    log.appendAll([
      makeUsageEnvelope('agent-A', 100, 20),
      makeUsageEnvelope('agent-A', 50, 5),
    ]);

    const usage = stores.tokenUsage.snapshot('agent-A');
    expect(usage?.totalSent).toBe(150);
    expect(usage?.totalReceived).toBe(25);
    // Overwritten (not summed) by the newest event — the TRUE context window.
    expect(usage?.lastContextWindow).toBe(50);
  });

  it('MessageLogService.reset() clears the stores (registry shrink-detect still works)', () => {
    const { log, stores } = setup();

    log.appendAll([
      makeStateChanged('agent-A', { mood: 'curious' }),
      makeUsageEnvelope('agent-A', 100, 20),
    ]);
    expect(stores.state.snapshot('agent-A')).toBeDefined();
    expect(stores.tokenUsage.snapshot('agent-A')).toBeDefined();

    log.reset();

    expect(stores.state.snapshot('agent-A')).toBeUndefined();
    expect(stores.tokenUsage.snapshot('agent-A')).toBeUndefined();

    // And it re-folds a fresh (smaller) log from the start — reset == replay.
    log.append(makeStateChanged('agent-A', { mood: 'calm' }));
    expect(stores.state.snapshot('agent-A')).toEqual({
      schema: {},
      state: { mood: 'calm' },
    });
  });
});

describe('ProcessStores — projection, so no lifecycle surface (ADR-025 §2)', () => {
  it('exposes no start / stop / init / ngOnDestroy entry point', () => {
    const { stores } = setup();

    // A projection declares folds; it does not participate in the
    // dispose → reset → seed → open ordering. Growing any of these would mean
    // the unit had acquired a lifecycle, at which point the orchestrator — not
    // DI construction order — has to sequence it.
    const probe = stores as unknown as Record<string, unknown>;
    expect(probe['start']).toBeUndefined();
    expect(probe['stop']).toBeUndefined();
    expect(probe['init']).toBeUndefined();
    expect(probe['ngOnDestroy']).toBeUndefined();
  });
});
