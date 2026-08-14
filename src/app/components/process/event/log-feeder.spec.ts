import { TestBed } from '@angular/core/testing';

import { Subject } from 'rxjs';

import { AkgenticMessage } from '../../../protocol/message.types';
import { LogFeeder } from './log-feeder';
import { MessageLogService } from './message-log.service';

// ---------------------------------------------------------------------------
// Story 34-6 (FR2, FR10) — `LogFeeder`, the frame-batched log source.
//
// Driven from a plain `Subject` with NO socket at all: the batching policy has
// nothing to do with the transport, and proving that is half the point of the
// split. The MINIMAL provider set is the other half (ADR-025 §1) — this unit
// depends on `MessageLogService` and nothing else, so a future `ConfigService`,
// `TeamSocket` or PrimeNG `MessageService` dependency fails every test here with
// `NullInjectorError` rather than passing quietly.
// ---------------------------------------------------------------------------

let fixtureCounter = 0;

function mkFrame(id: string): AkgenticMessage {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-08-14T00:00:0' + (fixtureCounter++ % 10) + 'Z',
    sender: {
      __actor_address__: true,
      name: '@X',
      role: 'Worker',
      agent_id: 'a1',
      squad_id: 's1',
      user_message: false,
    },
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StartMessage',
  } as unknown as AkgenticMessage;
}

function setup(): {
  feeder: LogFeeder;
  log: MessageLogService;
  inbound$: Subject<AkgenticMessage>;
} {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [MessageLogService, LogFeeder],
  });
  return {
    feeder: TestBed.inject(LogFeeder),
    log: TestBed.inject(MessageLogService),
    inbound$: new Subject<AkgenticMessage>(),
  };
}

describe('LogFeeder — frame batching (Story 34-6, AC3)', () => {
  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));
  });

  afterEach(() => jasmine.clock().uninstall());

  it('coalesces every frame in one 16ms window into ONE appendAll', () => {
    const { feeder, log, inbound$ } = setup();
    const appendAll = spyOn(log, 'appendAll').and.callThrough();

    feeder.start(inbound$);
    inbound$.next(mkFrame('1'));
    inbound$.next(mkFrame('2'));
    inbound$.next(mkFrame('3'));

    // Still inside the window: nothing has reached the log yet.
    expect(appendAll).not.toHaveBeenCalled();

    jasmine.clock().tick(17);

    expect(appendAll).toHaveBeenCalledTimes(1);
    expect(log.snapshot().map((m: any) => m.id)).toEqual(['1', '2', '3']);
  });

  it('preserves arrival order within a batch and across batches', () => {
    const { feeder, log, inbound$ } = setup();

    feeder.start(inbound$);
    inbound$.next(mkFrame('1'));
    inbound$.next(mkFrame('2'));
    jasmine.clock().tick(17);
    inbound$.next(mkFrame('3'));
    jasmine.clock().tick(17);

    expect(log.snapshot().map((m: any) => m.id)).toEqual(['1', '2', '3']);
  });

  it('emits nothing for an idle window (the empty-batch filter)', () => {
    const { feeder, log, inbound$ } = setup();
    const appendAll = spyOn(log, 'appendAll').and.callThrough();

    feeder.start(inbound$);
    // `bufferTime` ticks whether or not anything arrived; without the filter the
    // log would emit ~60 times a second for the whole life of the team.
    jasmine.clock().tick(200);

    expect(appendAll).not.toHaveBeenCalled();
  });
});

describe('LogFeeder — lifecycle (Story 34-6, AC4, FR9)', () => {
  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));
  });

  afterEach(() => jasmine.clock().uninstall());

  it('does NOTHING in its constructor — nothing subscribed, nothing appended', () => {
    const { log, inbound$ } = setup();
    const appendAll = spyOn(log, 'appendAll').and.callThrough();

    inbound$.next(mkFrame('1'));
    jasmine.clock().tick(17);

    // The unit exists (it was injected in `setup()`), and yet the stream has no
    // subscriber. Self-wiring here would put the log feed's start time in DI's
    // hands rather than the orchestrator's.
    expect((inbound$ as any).observers.length).toBe(0);
    expect(appendAll).not.toHaveBeenCalled();
  });

  it('start() RETURNS the handle, so the orchestrator can bag it', () => {
    const { feeder, log, inbound$ } = setup();

    const handle = feeder.start(inbound$);
    handle.unsubscribe();

    inbound$.next(mkFrame('1'));
    jasmine.clock().tick(17);

    // Disposing the returned handle alone stops the feed — that is what makes
    // the orchestrator's per-cycle `Subscription` bag a real mechanism rather
    // than bookkeeping.
    expect(log.snapshot()).toEqual([]);
    expect((inbound$ as any).observers.length).toBe(0);
  });

  it('start() does NOT dispose a previous feed of its own', () => {
    const { feeder, inbound$ } = setup();

    feeder.start(inbound$);
    feeder.start(inbound$);

    // Deliberate: the orchestrator's bag is the disposal mechanism. A `start()`
    // that self-disposed would make deleting that bag harmless, and the re-init
    // leak spec would stop being able to fail.
    expect((inbound$ as any).observers.length).toBe(2);
  });

  it('stop() disposes the feed and is safe before start() and twice over', () => {
    const { feeder, log, inbound$ } = setup();

    expect(() => feeder.stop()).not.toThrow();

    feeder.start(inbound$);
    feeder.stop();
    feeder.stop();

    inbound$.next(mkFrame('1'));
    jasmine.clock().tick(17);

    expect(log.snapshot()).toEqual([]);
  });
});

describe('LogFeeder — component-scoped, never root-provided (Story 34-6)', () => {
  it('is NOT reachable from an injector that does not provide it', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      // The log it depends on IS provided, so a failure to inject can only mean
      // `LogFeeder` itself is unreachable. Give it `providedIn: 'root'` and this
      // injection SUCCEEDS instead — one feeder pushing a prior team's frames
      // into the next team's log.
      providers: [MessageLogService],
    });

    expect(() => TestBed.inject(LogFeeder)).toThrowError(/No provider/);
  });
});
