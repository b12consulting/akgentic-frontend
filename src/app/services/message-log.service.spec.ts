import { TestBed } from '@angular/core/testing';

import { AkgenticMessage } from '../models/message.types';
import { MessageLogService } from './message-log.service';

function msg(id: string, model: string = 'StartMessage'): AkgenticMessage {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-13T00:00:00Z',
    sender: {
      __actor_address__: true,
      name: '@X',
      role: 'Worker',
      agent_id: 'a',
      team_id: 'team-1',
      squad_id: 's',
      user_message: false,
    },
    display_type: 'other',
    content: null,
    __model__: `akgentic.core.messages.orchestrator.${model}`,
  } as AkgenticMessage;
}

describe('MessageLogService (Story 6.1)', () => {
  let service: MessageLogService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [MessageLogService] });
    service = TestBed.inject(MessageLogService);
  });

  it('AC1: log$ emits [] on subscribe and snapshot() returns []', () => {
    let observed: AkgenticMessage[] | null = null;
    const sub = service.log$.subscribe((v) => (observed = v));
    expect(observed as AkgenticMessage[] | null).toEqual([]);
    expect(service.snapshot()).toEqual([]);
    sub.unsubscribe();
  });

  it('append: single message produces one new emission and preserves order', () => {
    const emissions: AkgenticMessage[][] = [];
    const sub = service.log$.subscribe((v) => emissions.push(v));
    service.append(msg('1'));
    service.append(msg('2'));
    // Initial [] + two appends = 3 emissions.
    expect(emissions.length).toBe(3);
    expect(emissions[0]).toEqual([]);
    expect(emissions[1].map((m) => m.id)).toEqual(['1']);
    expect(emissions[2].map((m) => m.id)).toEqual(['1', '2']);
    sub.unsubscribe();
  });

  it('appendAll: batch of N produces ONE emission with N messages in arrival order', () => {
    const emissions: AkgenticMessage[][] = [];
    const sub = service.log$.subscribe((v) => emissions.push(v));
    service.appendAll([msg('a'), msg('b'), msg('c')]);
    // Initial [] + one batch append = 2 emissions.
    expect(emissions.length).toBe(2);
    expect(emissions[1].map((m) => m.id)).toEqual(['a', 'b', 'c']);
    sub.unsubscribe();
  });

  it('appendAll: empty batch is a no-op (no emission, no snapshot change)', () => {
    const emissions: AkgenticMessage[][] = [];
    const sub = service.log$.subscribe((v) => emissions.push(v));
    service.appendAll([]);
    expect(emissions.length).toBe(1); // only the initial []
    expect(service.snapshot()).toEqual([]);
    sub.unsubscribe();
  });

  it('appendAll emits a NEW array reference (OnPush-safe, NFR3)', () => {
    const before = service.snapshot();
    service.appendAll([msg('1')]);
    const after = service.snapshot();
    expect(after).not.toBe(before);
  });

  it('reset() empties the log to [] and emits', () => {
    service.appendAll([msg('1'), msg('2')]);
    expect(service.snapshot().length).toBe(2);

    const emissions: AkgenticMessage[][] = [];
    const sub = service.log$.subscribe((v) => emissions.push(v));
    service.reset();
    // Initial ([1,2]) + post-reset ([]) = 2 emissions.
    expect(emissions.length).toBe(2);
    expect(emissions[1]).toEqual([]);
    expect(service.snapshot()).toEqual([]);
    sub.unsubscribe();
  });

  it('snapshot() returns the synchronous current value after appends', () => {
    service.append(msg('1'));
    service.appendAll([msg('2'), msg('3')]);
    expect(service.snapshot().map((m) => m.id)).toEqual(['1', '2', '3']);
  });
});
