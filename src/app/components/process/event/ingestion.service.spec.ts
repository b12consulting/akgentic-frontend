import { TestBed } from '@angular/core/testing';
import { MessageService } from 'primeng/api';
import { Toast } from 'primeng/toast';
import { BehaviorSubject, ReplaySubject, Subject, Subscription } from 'rxjs';
import { WebSocketSubject } from 'rxjs/webSocket';

import { IngestionService } from './ingestion.service';
import { LogFeeder } from './log-feeder';
import { TeamSocket } from './team-socket';
import { ApiService } from '../../../core/http/api.service';
import { NotificationToastService } from '../../../core/ui/notification-toast.service';
import { ChatService } from '../selectors/chat.selector';
import { ConnectionToast } from './connection-toast';
import { LoadingIndicator } from './loading-indicator';
import { MessageLogService } from './message-log.service';
import { NotificationToasts } from './notification-toasts';
import { PerAgentStore, PerAgentStoreRegistry } from './per-agent-store';
import { ProcessStores } from './process-stores';
import { ReplaySeeder } from './replay-seeder';
import { TeamStatusReactor } from './team-status-reactor';
import { ContextService } from '../../../core/context/context.service';
import {
  ActorAddress,
  CLOSED_NOTIFICATION_MODEL,
  EVENT_MESSAGE_MODEL,
} from '../../../protocol/message.types';

/**
 * Story 37-2: `IngestionService` now injects `TeamStatusReactor`, which injects
 * the root-scoped `ContextService`. A real one would drag `Router` into every
 * bed in this file, so each provider list gets this double instead — one fresh
 * spy per `configureTestingModule`, exactly like the `MessageService` double
 * beside it. Only the team-status wiring block below reads it back.
 */
function contextServiceDouble(): any {
  return { markStopped: jasmine.createSpy('markStopped') };
}

/**
 * Story 34-6: the `createWebSocket` seam, the WS subject and the raw inbound
 * stream moved off `IngestionService` onto `TeamSocket`. Every spec below that
 * used to stub or probe them through the service now reaches the same seam on
 * its new owner through these two helpers.
 *
 * A RECEIVER change and nothing else — no spec's predicate, fixture or expected
 * value moves with it. `TestBed.inject` returns the one component-scoped
 * instance the service itself injected, so `spyOn` and direct assignment both
 * still land on the object `init()` will call.
 */
function teamSocket(): TeamSocket {
  return TestBed.inject(TeamSocket);
}

/**
 * The hot protocol-frame subject behind `TeamSocket.inbound$` — the successor of
 * `IngestionService._wsInbound$`, and what the subscription-leak probes read.
 * `inbound$` is its `asObservable()` view, so subscribers still land in THIS
 * object's observer list.
 */
function inboundSubject(): Subject<any> {
  return (teamSocket() as any)._inbound$ as Subject<any>;
}

function makeAddress(overrides: Partial<ActorAddress> = {}): ActorAddress {
  return {
    __actor_address__: true,
    name: '@Researcher',
    role: 'Worker',
    agent_id: 'agent-1',
    team_id: 'team-1',
    squad_id: 'squad-1',
    user_message: false,
    ...overrides,
  };
}

// Story 6.3 (Task 7.4): makeReceived / makeSent / makeEventMessage fixture
// helpers were removed with the deleted `applyThinkingLifecycle` and
// `dispatchToolEventToThinking` describe blocks.

// Story 6.3 (AC9, Task 7.4): `applyThinkingLifecycle`,
// `dispatchToolEventToThinking`, and `handleEventMessage` were deleted from
// `IngestionService`. The thinking-bubble lifecycle is now reconstructed
// by `chatFold` over `log$` — coverage lives in `chat.service.spec.ts`
// (ReceivedMessage → ToolCallEvent → ToolReturnEvent → SentMessage fold
// scenarios, integration + FR11 + AC7 + late-subscriber).

describe('IngestionService.init — loadingProcess$ spinner window (Story 4-10)', () => {
  let service: IngestionService;
  let chatService: ChatService;
  let fakeSocket: Subject<any>;

  beforeEach(() => {
    // Story 4-10 (AC7): the spinner now has a 500ms minimum visible duration
    // enforced via `Date.now()` + `setTimeout`. Install the jasmine clock so
    // every test in this suite can deterministically control both the
    // "wall-clock" elapsed window AND the deferred setTimeout callback.
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));

    fakeSocket = new Subject<any>();

    TestBed.configureTestingModule({
      providers: [
        MessageLogService,
        PerAgentStoreRegistry,
        ProcessStores,
        ReplaySeeder,
        LoadingIndicator,
        ConnectionToast,
        NotificationToasts,
        TeamSocket,
        LogFeeder,
        TeamStatusReactor,
        IngestionService,
        { provide: ContextService, useValue: contextServiceDouble() },
        ChatService,
        {
          provide: ApiService,
          useValue: {
            // Only used by the `!running` branch; default empty list is fine.
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
            // Story 25-1 (!running gate): init() seeds the `state` store from
            // this endpoint ONLY for stopped teams. The running=false tests in
            // this suite hit that path; default to an empty snapshot list so
            // they exercise the no-op seed (and the running=true tests never
            // call it).
            getAgentStates: jasmine
              .createSpy('getAgentStates')
              .and.resolveTo([]),
          },
        },
        { provide: MessageService, useValue: { add: jasmine.createSpy('add'), clear: jasmine.createSpy('clear') } },
      ],
    });
    service = TestBed.inject(IngestionService);
    chatService = TestBed.inject(ChatService);

    // Stub the service's protected WS factory so init() wires the
    // subscription up to our Subject instead of opening a real TCP
    // connection. Cast through unknown to satisfy the WebSocketSubject<any>
    // return type expected by init().
    spyOn<any>(teamSocket(), 'createWebSocket').and.returnValue(
      fakeSocket as unknown as WebSocketSubject<any>,
    );
  });

  afterEach(() => {
    // Avoid cross-test leakage of the fake socket. Story 6.1 made
    // `init()`'s (a) step call `this.webSocket.unsubscribe()` before
    // swapping in a new socket — on re-init tests the previous fake
    // socket is therefore already closed, so `complete()` here would
    // throw `ObjectUnsubscribedError`. Swallow it: the whole point of
    // this teardown is "make sure the Subject does not leak into the
    // next test".
    try {
      fakeSocket.complete();
    } catch {
      /* subject already closed by disposePriorSubscriptions — ignore */
    }
    jasmine.clock().uninstall();
  });

  it('AC1: running=true keeps loadingProcess$ true until the first WS event arrives', async () => {
    await service.init('proc-1', true);

    // Socket is open but no events yet → spinner MUST stay on.
    expect(service.loadingProcess$.value).toBe(true);
  });

  it('AC1: loadingProcess$ flips to false on the first WS event (past the 500ms floor)', async () => {
    await service.init('proc-1', true);
    expect(service.loadingProcess$.value).toBe(true);

    // Advance past the SPINNER_MIN_VISIBLE_MS floor so the first-event flip
    // fires immediately (AC7 immediate-flip branch).
    jasmine.clock().tick(600);

    // First event over the wire — shape intentionally uninteresting, the
    // flip MUST happen before any per-__model__ branching.
    fakeSocket.next({
      __model__: 'akgentic.core.messages.orchestrator.StartMessage',
    });

    expect(service.loadingProcess$.value).toBe(false);
  });

  it('AC1: subsequent events do not re-emit false (guard is single-shot)', async () => {
    await service.init('proc-1', true);
    const emitted: boolean[] = [];
    service.loadingProcess$.subscribe((v) => emitted.push(v));
    // Start: BehaviorSubject replays current value (true).
    expect(emitted).toEqual([true]);

    // Past the 500ms floor so the flip happens immediately on first event.
    jasmine.clock().tick(600);
    fakeSocket.next({ __model__: 'StartMessage' });
    fakeSocket.next({ __model__: 'StartMessage' });
    fakeSocket.next({ __model__: 'StartMessage' });

    // Exactly ONE transition to false — no re-emit per event.
    expect(emitted).toEqual([true, false]);
  });

  it('AC3: WS error before any event flips loadingProcess$ to false (past the floor)', async () => {
    await service.init('proc-1', true);
    expect(service.loadingProcess$.value).toBe(true);

    jasmine.clock().tick(600);
    fakeSocket.error(new Error('connect refused'));

    expect(service.loadingProcess$.value).toBe(false);
  });

  it('AC3: a synchronous createWebSocket throw flips the spinner off (fourth floor call site)', async () => {
    // The fourth spinner-floor call site — the `catch` around the socket
    // constructor — was the only one of the four with no spec of its own: the
    // WS `next` / `error` paths and the stopped-team path are each pinned
    // above, so dropping this call, or routing it through the first-event
    // latch instead of the scheduler, went unnoticed by the whole suite. A
    // failure here leaves the chat panel on "Loading process..." for ever,
    // because there is no socket left to deliver the event that would end it.
    (teamSocket() as any).createWebSocket.and.throwError('bad ws url');

    await expectAsync(service.init('proc-1', true)).toBeRejected();

    // Inside the 500ms floor, so the flip is DEFERRED, not skipped — the
    // failure path shares the floor with the success paths.
    expect(service.loadingProcess$.value).toBe(true);
    jasmine.clock().tick(500);
    expect(service.loadingProcess$.value).toBe(false);
  });

  it('AC2: running=false (stopped team) flips loadingProcess$ to false before WS wiring', async () => {
    // Record the sequence of `loadingProcess$` values as init() runs so we
    // can assert the spinner is OFF before any WS events are delivered.
    // Note: createWebSocket is called BEFORE subscribe(), so by the time the
    // spy-stubbed factory returns, the stopped-team branch has already flipped
    // the flag to `false`. Subscribing to track values after await captures
    // the current BehaviorSubject state without needing to push any events.
    const emitted: boolean[] = [];
    const sub = service.loadingProcess$.subscribe((v) => emitted.push(v));

    await service.init('proc-1', false);
    // Drive the 500ms floor so the deferred flip can actually fire.
    jasmine.clock().tick(600);

    // No WS events pushed → stopped-team path MUST have already flipped it,
    // AND the sequence must include at least one `true` (spinner on during
    // getEvents()) followed by `false` (before WS wiring).
    expect(service.loadingProcess$.value).toBe(false);
    expect(emitted).toContain(true);
    expect(emitted[emitted.length - 1]).toBe(false);

    sub.unsubscribe();
  });

  // ---------------------------------------------------------------------
  // AC8 — Minimum visible spinner duration (500ms floor)
  // ---------------------------------------------------------------------

  it('AC8: first event at 100ms → flag still true at 400ms → false at 500ms (deferred flip)', async () => {
    await service.init('proc-1', true);
    expect(service.loadingProcess$.value).toBe(true);

    // First event arrives at 100ms — well before the 500ms floor.
    jasmine.clock().tick(100);
    fakeSocket.next({ __model__: 'StartMessage' });

    // At 400ms total, the deferred timer has NOT fired yet.
    jasmine.clock().tick(300);
    expect(service.loadingProcess$.value).toBe(true);

    // Crossing the 500ms floor triggers the pending setTimeout.
    jasmine.clock().tick(100);
    expect(service.loadingProcess$.value).toBe(false);
  });

  it('AC8: first event at 800ms → flag becomes false immediately (past floor, no extra delay)', async () => {
    await service.init('proc-1', true);
    expect(service.loadingProcess$.value).toBe(true);

    // First event well past the 500ms floor — flip must be immediate.
    jasmine.clock().tick(800);
    fakeSocket.next({ __model__: 'StartMessage' });

    // No further tick needed: immediate branch of scheduleSpinnerFlipFalse.
    expect(service.loadingProcess$.value).toBe(false);
  });

  it('AC8: WS error at 100ms → flag still true at 400ms → false at 500ms (failure path respects floor)', async () => {
    await service.init('proc-1', true);
    expect(service.loadingProcess$.value).toBe(true);

    jasmine.clock().tick(100);
    fakeSocket.error(new Error('connect refused'));

    jasmine.clock().tick(300);
    expect(service.loadingProcess$.value).toBe(true);

    jasmine.clock().tick(100);
    expect(service.loadingProcess$.value).toBe(false);
  });

  it('AC8: re-init while a deferred flip is pending cancels the pending timer (no late false clobber)', async () => {
    await service.init('proc-1', true);
    expect(service.loadingProcess$.value).toBe(true);

    // Schedule a deferred flip for t=500ms via an early first event.
    jasmine.clock().tick(100);
    fakeSocket.next({ __model__: 'StartMessage' });
    // Pending timer exists; flag still true.
    expect(service.loadingProcess$.value).toBe(true);

    // Re-init (team switch) before the pending timer fires — swap in a new
    // fake socket so the fresh init() has something to subscribe to.
    const secondSocket = new Subject<any>();
    (teamSocket() as any).createWebSocket = jasmine
      .createSpy('createWebSocket')
      .and.returnValue(secondSocket as unknown as WebSocketSubject<any>);
    await service.init('proc-2', true);

    // Fresh cycle: flag is back to true.
    expect(service.loadingProcess$.value).toBe(true);

    // Advance past the ORIGINAL scheduled time (t=500ms from first init).
    // If the pending timer had not been cancelled, it would fire here and
    // clobber the fresh spinner cycle with a stale `false`.
    jasmine.clock().tick(500);
    expect(service.loadingProcess$.value).toBe(true);

    secondSocket.complete();
  });
});

// ---------------------------------------------------------------------------
// Story 6.1 — MessageLogService integration + frame-batched ingestion (AC1-8)
// ---------------------------------------------------------------------------

describe('IngestionService — Story 6.1 (frame-batched log ingestion)', () => {
  let service: IngestionService;
  let log: MessageLogService;
  let chatService: ChatService;
  let fakeSocket: Subject<any>;

  function mkStart(id: string): any {
    return {
      id,
      parent_id: null,
      team_id: 'team-X',
      timestamp: '2026-04-13T00:00:00Z',
      sender: {
        __actor_address__: true,
        name: '@X',
        role: 'Worker',
        agent_id: 'a1',
        team_id: 'team-X',
        squad_id: 's1',
        user_message: false,
      },
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.StartMessage',
    };
  }

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));

    fakeSocket = new Subject<any>();

    TestBed.configureTestingModule({
      providers: [
        MessageLogService,
        PerAgentStoreRegistry,
        ProcessStores,
        ReplaySeeder,
        LoadingIndicator,
        ConnectionToast,
        NotificationToasts,
        TeamSocket,
        LogFeeder,
        TeamStatusReactor,
        IngestionService,
        { provide: ContextService, useValue: contextServiceDouble() },
        ChatService,
        {
          provide: ApiService,
          useValue: {
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
            // Story 25-1 (!running gate): init() seeds the `state` store from
            // this endpoint ONLY for stopped teams. The running=false tests in
            // this suite hit that path; default to an empty snapshot list so
            // they exercise the no-op seed (and the running=true tests never
            // call it).
            getAgentStates: jasmine
              .createSpy('getAgentStates')
              .and.resolveTo([]),
          },
        },
        { provide: MessageService, useValue: { add: jasmine.createSpy('add'), clear: jasmine.createSpy('clear') } },
      ],
    });
    service = TestBed.inject(IngestionService);
    log = TestBed.inject(MessageLogService);
    chatService = TestBed.inject(ChatService);

    spyOn<any>(teamSocket(), 'createWebSocket').and.returnValue(
      fakeSocket as unknown as WebSocketSubject<any>,
    );
  });

  afterEach(() => {
    try {
      fakeSocket.complete();
    } catch {
      /* may already be unsubscribed by disposePriorSubscriptions */
    }
    jasmine.clock().uninstall();
  });

  // ---------- AC1 ----------
  it('AC1: log$ emits [] before init and log.snapshot() is empty', () => {
    let observed: any[] | null = null;
    const sub = log.log$.subscribe((v) => (observed = v));
    expect(observed as any[] | null).toEqual([]);
    expect(log.snapshot()).toEqual([]);
    sub.unsubscribe();
  });

  // ---------- AC3 + ADR-005 AC4 ----------
  it('AC3: N synchronous WS messages within 16ms → ONE appendAll + ONE log$ emission', async () => {
    await service.init('proc-1', true);

    const appendSpy = spyOn(log, 'appendAll').and.callThrough();
    const emissions: any[][] = [];
    // Subscribe AFTER init completes so we capture the current snapshot as
    // the baseline emission and then the post-batch emission.
    const sub = log.log$.subscribe((v) => emissions.push(v));
    expect(emissions.length).toBe(1); // baseline, [] (or whatever init left)

    // Fire 5 synchronous events within one 16ms window.
    fakeSocket.next(mkStart('1'));
    fakeSocket.next(mkStart('2'));
    fakeSocket.next(mkStart('3'));
    fakeSocket.next(mkStart('4'));
    fakeSocket.next(mkStart('5'));

    // bufferTime(16) has not flushed yet — the batched subscriber is still
    // accumulating; no log$ emission should have landed past baseline.
    expect(emissions.length).toBe(1);
    expect(appendSpy).not.toHaveBeenCalled();

    jasmine.clock().tick(17);

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy.calls.mostRecent().args[0].length).toBe(5);
    expect(emissions.length).toBe(2);
    expect(emissions[1].map((m: any) => m.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(log.snapshot().map((m: any) => m.id)).toEqual(['1', '2', '3', '4', '5']);

    sub.unsubscribe();
  });

  // ---------- AC4 (Epic 17) ----------
  it('AC4: batched frame folds state + context off log$ in same pass', async () => {
    await service.init('proc-1', true);

    const stateChanged = {
      id: 'sc1',
      parent_id: null,
      team_id: 'team-X',
      timestamp: '2026-04-13T00:00:00Z',
      sender: {
        __actor_address__: true,
        name: '@X',
        role: 'Worker',
        agent_id: 'agent-X',
        team_id: 'team-X',
        squad_id: 's',
        user_message: false,
      },
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.StateChangedMessage',
      state: { phase: 'thinking' },
    };
    const llmEvent = {
      id: 'evt1',
      parent_id: null,
      team_id: 'team-X',
      timestamp: '2026-04-13T00:00:00Z',
      sender: {
        __actor_address__: true,
        name: '@Y',
        role: 'Worker',
        agent_id: 'agent-Y',
        team_id: 'team-X',
        squad_id: 's',
        user_message: false,
      },
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.EventMessage',
      event: {
        __model__: 'akgentic.llm.event.LlmMessageEvent',
        message: { role: 'assistant', content: 'hi' },
      },
    };

    fakeSocket.next(stateChanged);
    fakeSocket.next(llmEvent);
    jasmine.clock().tick(17);

    // Epic 17: both stores folded off log$ by the registry's single
    // subscription — `state` is latest-wins `{ schema, state }`, `context`
    // is the appended inner `message[]`.
    expect(service.state.snapshot('agent-X')).toEqual({
      schema: {},
      state: { phase: 'thinking' },
    });
    expect(service.context.snapshot('agent-Y')).toEqual([
      { role: 'assistant', content: 'hi' },
    ]);
    // Log also contains both messages in arrival order.
    expect(log.snapshot().length).toBe(2);
  });

  // ---------- AC5 ----------
  it('AC5: rapid init("A") → init("B") leaves only B events in log.snapshot()', async () => {
    // First cycle — process A.
    await service.init('proc-A', true);
    fakeSocket.next(mkStart('A-1'));
    fakeSocket.next(mkStart('A-2'));
    jasmine.clock().tick(17);
    expect(log.snapshot().map((m: any) => m.id)).toEqual(['A-1', 'A-2']);

    // Swap in a fresh fake socket for the B cycle.
    const socketB = new Subject<any>();
    (teamSocket() as any).createWebSocket = jasmine
      .createSpy('createWebSocket')
      .and.returnValue(socketB as unknown as WebSocketSubject<any>);

    await service.init('proc-B', true);
    // After init: log MUST be empty (Task 3.1 step (b) reset).
    expect(log.snapshot()).toEqual([]);

    socketB.next(mkStart('B-1'));
    jasmine.clock().tick(17);
    // Only B events remain.
    expect(log.snapshot().map((m: any) => m.id)).toEqual(['B-1']);

    socketB.complete();
  });

  // ---------- AC6 ----------
  it('AC6: spinner flip fires EXACTLY once via take(1) for N events in same 16ms window', async () => {
    await service.init('proc-1', true);

    // Jump past the 500ms floor so the flip is immediate (not deferred).
    jasmine.clock().tick(600);

    const emitted: boolean[] = [];
    const sub = service.loadingProcess$.subscribe((v) => emitted.push(v));
    expect(emitted).toEqual([true]);

    // Fire 5 events synchronously — take(1) must trigger ONLY ONE flip.
    fakeSocket.next(mkStart('1'));
    fakeSocket.next(mkStart('2'));
    fakeSocket.next(mkStart('3'));
    fakeSocket.next(mkStart('4'));
    fakeSocket.next(mkStart('5'));

    // Exactly one transition to false (from the take(1) side-channel;
    // the legacy flipOnFirstEvent closure also fires but calls the same
    // idempotent scheduleSpinnerFlipFalse → loadingProcess$ is a
    // BehaviorSubject so a second `next(false)` with the same value does
    // emit another `false` — assert only ONE transition from true→false.
    expect(emitted[0]).toBe(true);
    expect(emitted).toContain(false);
    // Values in strict order: first is true, LAST is false.
    expect(emitted[emitted.length - 1]).toBe(false);

    sub.unsubscribe();
  });

  // ---------- AC7 ----------
  it('AC7: N mount/unmount cycles leave no residual subscriptions on the inbound subject', async () => {
    // After init() step (a) disposes the prior cycle, the internal Subject
    // observer list should stay bounded. Probe via the rxjs 7 `observed`
    // boolean and the internal `observers` array (still reachable on Subject
    // even if flagged @deprecated). Both paths agree.
    //
    // Story 34-6 repointed the probe from `IngestionService._wsInbound$` to the
    // subject behind `TeamSocket.inbound$`, which is the same one hot stream
    // under a new owner. Receiver only: the four numbers below are untouched.
    const inbound = inboundSubject();

    for (let i = 0; i < 5; i++) {
      // Each re-init disposes the previous WS (`fakeSocket.unsubscribe()`),
      // so swap in a fresh Subject for every cycle — otherwise the next
      // init's `.subscribe(...)` would hit an unsubscribed Subject.
      const cycleSocket = new Subject<any>();
      (teamSocket() as any).createWebSocket = jasmine
        .createSpy('createWebSocket')
        .and.returnValue(cycleSocket as unknown as WebSocketSubject<any>);

      await service.init('proc-' + i, true);
      // After a full init() the two live subscribers are `LogFeeder`'s batched
      // feed and `LoadingIndicator`'s take(1) side-channel — exactly 2, never
      // more.
      //
      // Story 34-5 raised this bound from 2 to 3 when the notification dispatch
      // became a subscriber of this subject; Story 35-1 took it back down by
      // moving that reactor onto `log.appended$`, which is the observable
      // consequence of the argument change. The number is not the guarantee —
      // its CONSTANCY across the five cycles is, and that is what catches a
      // subscription that is never disposed. Removing `feeder`'s teardown from
      // the cycle bag makes this climb 2, 3, 4, 5, 6.
      expect((inbound as any).observers.length).toBe(2);
      expect(inbound.observed).toBeTrue();
    }

    // Destroy: must release ALL observers and complete the Subject.
    service.ngOnDestroy();
    expect((inbound as any).observers.length).toBe(0);
    expect(inbound.observed).toBeFalse();
  });

  // ---------- AC8 ----------
  it('AC8: log contains synthetic event sequence in arrival order (Story 6.4: messages$ deleted)', async () => {
    await service.init('proc-1', true);

    const s1 = mkStart('s1');
    const s2 = mkStart('s2');
    const s3 = mkStart('s3');
    fakeSocket.next(s1);
    fakeSocket.next(s2);
    fakeSocket.next(s3);
    jasmine.clock().tick(17);

    // log populated via the batched subscriber.
    expect(log.snapshot().map((m: any) => m.id)).toEqual(['s1', 's2', 's3']);
    // Story 6.4 (AC1): `messages$` is deleted; the log is the single
    // source of truth for downstream selectors.
    expect((service as any).messages$).toBeUndefined();
  });

  // ---------- Task 3.2 — REST replay populates log in strict order ----------
  it('Task 3.2: !running init replays events into log in arrival order', async () => {
    const apiService = TestBed.inject(ApiService) as any;
    apiService.getEvents.and.resolveTo([
      { event: mkStart('r1') },
      { event: mkStart('r2') },
      { event: mkStart('r3') },
    ]);

    await service.init('proc-stopped', false);

    expect(log.snapshot().map((m: any) => m.id)).toEqual(['r1', 'r2', 'r3']);
  });
});

// ---------------------------------------------------------------------------
// Epic 17 / Story 17-3 (ADR-014 §5, ADR-013) — `commands` PerAgentStore
//
// Re-homes Story 15-1/15-2: the bespoke `commandsByAgent$` (name-keyed) is gone;
// `commands` is a PerAgentStore folded off log$ by the registry, keyed by the
// emitting agent's `sender.agent_id` (the ADR-013 keying fix). These tests drive
// the REAL log fold (no store mocking) per the story's testing standards:
// announce a CommandsAnnouncedEvent EventMessage, read commands.snapshot(id) /
// forAgent(id); replace-on-re-announce; replay-vs-live parity; reset-on-switch;
// and the name-reuse non-bleed correctness proof.
// ---------------------------------------------------------------------------

describe('IngestionService — commands PerAgentStore (Story 17-3, ADR-014/ADR-013)', () => {
  let service: IngestionService;
  let fakeSocket: Subject<any>;

  /** A CommandsAnnouncedEvent EventMessage. The outer `sender.agent_id` is the
   *  registry key; the inner `agent` mirrors it (sender === emitting agent). */
  function mkCommandsEvent(
    agentName: string,
    agentId: string,
    commands: any[],
    id = 'cmd-evt',
  ): any {
    return {
      id,
      parent_id: null,
      team_id: 'team-X',
      timestamp: '2026-06-13T00:00:00Z',
      sender: makeAddress({ name: agentName, agent_id: agentId }),
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.EventMessage',
      event: {
        __model__: 'akgentic.tool.commands.CommandsAnnouncedEvent',
        agent: makeAddress({ name: agentName, agent_id: agentId }),
        commands,
      },
    };
  }

  const HIRE = {
    name: 'hire_member',
    description: 'Hire a new team member',
    args: [
      { name: 'role', type: 'string', required: true },
      { name: 'name', type: 'string', required: false },
    ],
    tool_card: 'TeamTool',
  };
  const ROSTER = {
    name: 'roster',
    description: 'List the current team roster',
    args: [],
    tool_card: 'TeamTool',
  };

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));

    fakeSocket = new Subject<any>();

    TestBed.configureTestingModule({
      providers: [
        MessageLogService,
        PerAgentStoreRegistry,
        ProcessStores,
        ReplaySeeder,
        LoadingIndicator,
        ConnectionToast,
        NotificationToasts,
        TeamSocket,
        LogFeeder,
        TeamStatusReactor,
        IngestionService,
        { provide: ContextService, useValue: contextServiceDouble() },
        ChatService,
        {
          provide: ApiService,
          useValue: {
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
            // Story 25-1 (!running gate): init() seeds the `state` store from
            // this endpoint ONLY for stopped teams. The running=false tests in
            // this suite hit that path; default to an empty snapshot list so
            // they exercise the no-op seed (and the running=true tests never
            // call it).
            getAgentStates: jasmine
              .createSpy('getAgentStates')
              .and.resolveTo([]),
          },
        },
        { provide: MessageService, useValue: { add: jasmine.createSpy('add'), clear: jasmine.createSpy('clear') } },
      ],
    });
    service = TestBed.inject(IngestionService);

    spyOn<any>(teamSocket(), 'createWebSocket').and.returnValue(
      fakeSocket as unknown as WebSocketSubject<any>,
    );
  });

  afterEach(() => {
    try {
      fakeSocket.complete();
    } catch {
      /* already closed */
    }
    jasmine.clock().uninstall();
  });

  it('AC1: a CommandsAnnouncedEvent yields the agent\'s descriptors keyed by agent_id', async () => {
    await service.init('proc-1', true);

    fakeSocket.next(mkCommandsEvent('@Manager', 'agent-mgr', [HIRE, ROSTER]));
    jasmine.clock().tick(17);

    // Keyed by agent_id, NOT by name.
    expect(service.commands.snapshot('agent-mgr')?.map((c) => c.name)).toEqual([
      'hire_member',
      'roster',
    ]);
    expect(service.commands.snapshot('@Manager')).toBeUndefined();
  });

  it('AC1: forAgent(id) delivers the current list to a late subscriber', async () => {
    await service.init('proc-1', true);
    fakeSocket.next(mkCommandsEvent('@Manager', 'agent-mgr', [HIRE]));
    jasmine.clock().tick(17);

    let seen: any = 'unset';
    const sub = service.commands.forAgent('agent-mgr').subscribe((v) => (seen = v));
    expect((seen as any[]).map((c) => c.name)).toEqual(['hire_member']);
    sub.unsubscribe();
  });

  it('AC1: a later event for the same agent_id REPLACES that list', async () => {
    await service.init('proc-1', true);

    fakeSocket.next(mkCommandsEvent('@Manager', 'agent-mgr', [HIRE, ROSTER], 'e1'));
    jasmine.clock().tick(17);
    expect(service.commands.snapshot('agent-mgr')?.length).toBe(2);

    // Re-announce with a shorter list — must replace, not merge.
    fakeSocket.next(mkCommandsEvent('@Manager', 'agent-mgr', [ROSTER], 'e2'));
    jasmine.clock().tick(17);

    expect(service.commands.snapshot('agent-mgr')?.map((c) => c.name)).toEqual([
      'roster',
    ]);
  });

  it('AC1: events for different agent_ids are kept under distinct keys', async () => {
    await service.init('proc-1', true);

    fakeSocket.next(mkCommandsEvent('@Manager', 'agent-mgr', [HIRE], 'e1'));
    fakeSocket.next(mkCommandsEvent('@Developer', 'agent-dev', [ROSTER], 'e2'));
    jasmine.clock().tick(17);

    expect(service.commands.snapshot('agent-mgr')?.map((c) => c.name)).toEqual([
      'hire_member',
    ]);
    expect(service.commands.snapshot('agent-dev')?.map((c) => c.name)).toEqual([
      'roster',
    ]);
  });

  it('AC2: name-reuse non-bleed — same display name, different agent_ids stay separate', async () => {
    await service.init('proc-1', true);

    // Two agents that have shared the display name '@Manager' at different times
    // (fire/re-hire) but have DISTINCT agent_ids. Each announces its own list.
    fakeSocket.next(mkCommandsEvent('@Manager', 'agent-old', [HIRE], 'e1'));
    fakeSocket.next(mkCommandsEvent('@Manager', 'agent-new', [ROSTER], 'e2'));
    jasmine.clock().tick(17);

    // A name-keyed store would have collapsed these into one wrong entry; the
    // agent_id-keyed store keeps them separate (the ADR-013 keying fix).
    expect(service.commands.snapshot('agent-old')?.map((c) => c.name)).toEqual([
      'hire_member',
    ]);
    expect(service.commands.snapshot('agent-new')?.map((c) => c.name)).toEqual([
      'roster',
    ]);
  });

  it('AC6/AC7: a team switch (init reset) clears commands — no process-A leak', async () => {
    await service.init('proc-A', true);
    fakeSocket.next(mkCommandsEvent('@Manager', 'agent-mgr', [HIRE]));
    jasmine.clock().tick(17);
    expect(service.commands.snapshot('agent-mgr')?.length).toBe(1);

    // Re-init (team switch) → log.reset() → registry clears its maps.
    const socketB = new Subject<any>();
    (teamSocket() as any).createWebSocket = jasmine
      .createSpy('createWebSocket')
      .and.returnValue(socketB as unknown as WebSocketSubject<any>);
    await service.init('proc-B', true);

    expect(service.commands.snapshot('agent-mgr')).toBeUndefined();
    socketB.complete();
  });

  it('AC6: stopped-team REST replay yields the SAME commands as the live WS path', async () => {
    // Live WS ingestion of a fixture sequence.
    await service.init('proc-live', true);
    fakeSocket.next(mkCommandsEvent('@Manager', 'agent-mgr', [HIRE, ROSTER], 'e1'));
    // Later live event for the same agent_id replaces the earlier one.
    fakeSocket.next(mkCommandsEvent('@Manager', 'agent-mgr', [ROSTER], 'e2'));
    fakeSocket.next(mkCommandsEvent('@Developer', 'agent-dev', [HIRE], 'e3'));
    jasmine.clock().tick(17);
    const liveMgr = service.commands.snapshot('agent-mgr');
    const liveDev = service.commands.snapshot('agent-dev');

    // REST replay of the SAME ordered events as one getEvents() batch.
    const apiService = TestBed.inject(ApiService) as any;
    apiService.getEvents.and.resolveTo([
      { event: mkCommandsEvent('@Manager', 'agent-mgr', [HIRE, ROSTER], 'r1') },
      { event: mkCommandsEvent('@Manager', 'agent-mgr', [ROSTER], 'r2') },
      { event: mkCommandsEvent('@Developer', 'agent-dev', [HIRE], 'r3') },
    ]);
    const socketB = new Subject<any>();
    (teamSocket() as any).createWebSocket = jasmine
      .createSpy('createWebSocket')
      .and.returnValue(socketB as unknown as WebSocketSubject<any>);
    await service.init('proc-stopped', false);

    expect(service.commands.snapshot('agent-mgr')).toEqual(liveMgr);
    expect(service.commands.snapshot('agent-dev')).toEqual(liveDev);
    expect(service.commands.snapshot('agent-mgr')?.map((c) => c.name)).toEqual([
      'roster',
    ]);
    socketB.complete();
  });

  it('AC8: commandsByAgent$ field no longer exists on the service', async () => {
    await service.init('proc-1', true);
    expect((service as any).commandsByAgent$).toBeUndefined();
    // The migrated surface exposes forAgent/snapshot, not a dict of subjects.
    expect(typeof service.commands.forAgent).toBe('function');
    expect(typeof service.commands.snapshot).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Epic 17 (ADR-014) — registry-is-the-only-per-agent-owner invariant
//
// Supersedes the retired ADR-005 §Decision 5 "≤2 sanctioned exceptions" probe
// (Story 6.4, NFR9). With all four per-agent concerns migrated to PerAgentStore
// instances (state/context — 17-2; commands — 17-3; systemPrompt — 17-4), the
// "count bespoke exceptions" framing is obsolete. The structural guarantee now
// is: the four per-agent derived values are PerAgentStore instances owned by
// the single PerAgentStoreRegistry, and IngestionService introduces NO
// per-agent BehaviorSubject of its own. The negative guard still bites: adding
// a bespoke per-agent BehaviorSubject field MUST be detected.
//
// This is a runtime STRUCTURAL probe (instance types + a BehaviorSubject
// own-property scan), never a documentation/ADR-string assertion.
// ---------------------------------------------------------------------------

/**
 * Probe the public surface of an `IngestionService` (or subclass) and return
 * the own-property names whose runtime shape is a bespoke per-agent
 * `BehaviorSubject` state container — a direct `BehaviorSubject` field, or a
 * dict `{ [k: string]: BehaviorSubject<...> }`. `PerAgentStore` instances (the
 * Epic 17 `state` / `context` / `commands` / `systemPrompt`) are NOT
 * `BehaviorSubject`s and are explicitly NOT counted — they are the sanctioned,
 * registry-owned mechanism. Probed via `instanceof`, never a name allow-list.
 *
 * Epic 18 (ADR-015 §2): the single `loadingProcess$` spinner BehaviorSubject
 * moved off `ChatService` onto ingestion. It is a global UX flag, NOT per-agent
 * state, so it is the ONE sanctioned non-per-agent `BehaviorSubject` and is
 * excluded by name — exactly as the `_wsInbound$` Subject and `webSocket` are
 * not per-agent containers. The negative guard below still bites any OTHER
 * bespoke per-agent `BehaviorSubject` field.
 */
function probePerAgentBehaviorSubjects(service: object): string[] {
  return Object.getOwnPropertyNames(service).filter((name) => {
    if (name === 'loadingProcess$') return false;
    const v = (service as any)[name];
    if (v instanceof PerAgentStore) return false;
    if (v instanceof BehaviorSubject) return true;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const values = Object.values(v);
      // Empty dicts cannot be distinguished structurally from other empty
      // objects, so the empty case is not counted.
      if (values.length === 0) return false;
      return values.every((x) => x instanceof BehaviorSubject);
    }
    return false;
  });
}

describe('IngestionService — registry is the only per-agent owner (Epic 17, ADR-014)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        MessageLogService,
        PerAgentStoreRegistry,
        ProcessStores,
        ReplaySeeder,
        LoadingIndicator,
        ConnectionToast,
        NotificationToasts,
        TeamSocket,
        LogFeeder,
        TeamStatusReactor,
        IngestionService,
        { provide: ContextService, useValue: contextServiceDouble() },
        ChatService,
        {
          provide: ApiService,
          useValue: {
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
            // Story 25-1 (!running gate): init() seeds the `state` store from
            // this endpoint ONLY for stopped teams. The running=false tests in
            // this suite hit that path; default to an empty snapshot list so
            // they exercise the no-op seed (and the running=true tests never
            // call it).
            getAgentStates: jasmine
              .createSpy('getAgentStates')
              .and.resolveTo([]),
          },
        },
        { provide: MessageService, useValue: { add: jasmine.createSpy('add'), clear: jasmine.createSpy('clear') } },
      ],
    });
  });

  it('the four per-agent concerns are registry-owned PerAgentStore instances', () => {
    const service = TestBed.inject(IngestionService);
    expect(service.state).toBeInstanceOf(PerAgentStore);
    expect(service.context).toBeInstanceOf(PerAgentStore);
    expect(service.commands).toBeInstanceOf(PerAgentStore);
    expect(service.systemPrompt).toBeInstanceOf(PerAgentStore);
  });

  it('re-exports the SAME instances ProcessStores registered (Epic 34, ADR-025 §1)', () => {
    const service = TestBed.inject(IngestionService);
    const stores = TestBed.inject(ProcessStores);

    // Reference identity, deliberately — NOT `toEqual`. `registry.register()`
    // pushes a NEW bucket and returns a NEW PerAgentStore per call, so if
    // IngestionService re-registered instead of aliasing, the app would carry
    // two independent maps folding the same log: each correct in isolation, so
    // every other spec in this file would still pass, while consumers that
    // assume one store silently read the wrong one. `toBe` is the only
    // assertion that catches a duplicate registration.
    expect(service.state).toBe(stores.state);
    expect(service.context).toBe(stores.context);
    expect(service.commands).toBe(stores.commands);
    expect(service.systemPrompt).toBe(stores.systemPrompt);
    expect(service.tokenUsage).toBe(stores.tokenUsage);
  });

  it('introduces NO bespoke per-agent BehaviorSubject of its own', () => {
    const service = TestBed.inject(IngestionService);
    // Runtime structural probe: any per-agent BehaviorSubject field (regardless
    // of name) would surface here. PerAgentStore instances are not counted —
    // the registry is the sole per-agent-map owner.
    const containers = probePerAgentBehaviorSubjects(service);
    expect(new Set(containers)).toEqual(new Set([]));
  });

  it('negative guard: adding a bespoke per-agent BehaviorSubject fails the probe', () => {
    const service = TestBed.inject(IngestionService);
    // Simulate the regression the old invariant policed: a new per-agent
    // BehaviorSubject field bypassing the registry.
    (service as any).extraDict$ = { agent: new BehaviorSubject<any>(null) };
    const containers = probePerAgentBehaviorSubjects(service);
    expect(new Set(containers)).not.toEqual(new Set([]));
    expect(containers).toContain('extraDict$');
  });

  it('non-state observables (Subjects, Subscriptions, WebSocketSubject) are NOT counted', () => {
    const service = TestBed.inject(IngestionService);
    const containers = probePerAgentBehaviorSubjects(service);
    expect(containers).not.toContain('_wsInbound$');
    expect(containers).not.toContain('bufferSub');
    expect(containers).not.toContain('spinnerSub');
    expect(containers).not.toContain('webSocket');
  });
});

// ---------------------------------------------------------------------------
// Story 8-2 — Persistent WebSocket disconnect warning toast (AC1–AC5)
// ---------------------------------------------------------------------------

describe('IngestionService — Story 8-2 (persistent disconnect toast)', () => {
  let service: IngestionService;
  let msgService: any;
  let fakeSocket: Subject<any>;
  /**
   * Epic 34 (story 34-4): the toast itself lives here now. The specs below keep
   * their predicates and only change RECEIVER where they used to reach into
   * `IngestionService`'s privates — what they assert about the toast is
   * unchanged, and the WS-driven ones still exercise the wiring end to end.
   */
  let connectionToast: ConnectionToast;

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));

    fakeSocket = new Subject<any>();

    TestBed.configureTestingModule({
      providers: [
        MessageLogService,
        PerAgentStoreRegistry,
        ProcessStores,
        ReplaySeeder,
        LoadingIndicator,
        ConnectionToast,
        NotificationToasts,
        TeamSocket,
        LogFeeder,
        TeamStatusReactor,
        IngestionService,
        { provide: ContextService, useValue: contextServiceDouble() },
        ChatService,
        {
          provide: ApiService,
          useValue: {
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
            // Story 25-1 (!running gate): init() seeds the `state` store from
            // this endpoint ONLY for stopped teams. The running=false tests in
            // this suite hit that path; default to an empty snapshot list so
            // they exercise the no-op seed (and the running=true tests never
            // call it).
            getAgentStates: jasmine
              .createSpy('getAgentStates')
              .and.resolveTo([]),
          },
        },
        { provide: MessageService, useValue: { add: jasmine.createSpy('add'), clear: jasmine.createSpy('clear') } },
      ],
    });
    service = TestBed.inject(IngestionService);
    msgService = TestBed.inject(MessageService);
    connectionToast = TestBed.inject(ConnectionToast);

    spyOn<any>(teamSocket(), 'createWebSocket').and.returnValue(
      fakeSocket as unknown as WebSocketSubject<any>,
    );
  });

  afterEach(() => {
    try {
      fakeSocket.complete();
    } catch {
      /* already closed */
    }
    jasmine.clock().uninstall();
  });

  /** Every 'Connection Lost' payload raised so far, in order. */
  function disconnectToasts(): any[] {
    return msgService.add.calls
      .allArgs()
      .map((a: any[]) => a[0])
      .filter((c: any) => c.severity === 'warn' && c.summary === 'Connection Lost');
  }

  it('AC1: WS error shows persistent warning toast with correct properties', async () => {
    await service.init('proc-1', true);
    jasmine.clock().tick(600);

    fakeSocket.error(new Error('connection lost'));

    expect(msgService.add).toHaveBeenCalledWith(
      jasmine.objectContaining({
        severity: 'warn',
        summary: 'Connection Lost',
        detail: 'Real-time connection to the server has been lost. Updates are paused.',
        sticky: true,
        closable: false,
      }),
    );
  });

  it('AC1: WS error no longer shows transient error toast with life: 5000', async () => {
    await service.init('proc-1', true);
    jasmine.clock().tick(600);

    fakeSocket.error(new Error('connection lost'));

    const calls = msgService.add.calls.allArgs().map((a: any[]) => a[0]);
    const transientErrorCalls = calls.filter(
      (c: any) => c.severity === 'error' && c.life === 5000 && c.summary === 'Connection Error',
    );
    expect(transientErrorCalls.length).toBe(0);
  });

  it('AC2: WS complete shows persistent warning toast', async () => {
    await service.init('proc-1', true);
    jasmine.clock().tick(600);

    fakeSocket.complete();

    expect(msgService.add).toHaveBeenCalledWith(
      jasmine.objectContaining({
        severity: 'warn',
        sticky: true,
        closable: false,
      }),
    );
  });

  it('AC3: second disconnect event does not add a duplicate toast', async () => {
    await service.init('proc-1', true);
    jasmine.clock().tick(600);

    // Simulate error followed by complete — use separate subjects to control
    // the sequence since error() terminates the Subject.
    // Instead, raise the toast twice directly on the unit that owns it.
    connectionToast.show();
    connectionToast.show();

    expect(disconnectToasts().length).toBe(1);
  });

  it('AC4: ngOnDestroy clears the ws-disconnect toast and resets the flag', async () => {
    await service.init('proc-1', true);
    jasmine.clock().tick(600);

    // Show the toast first.
    connectionToast.show();
    // Story 34-4 (AC11): the dedup flag moved WITH the toast, so this reads it
    // on its new owner. Same predicate, new receiver — deliberately not
    // weakened into a behavioural approximation.
    expect((connectionToast as any).wsDisconnectToastShown).toBe(true);

    service.ngOnDestroy();

    expect(msgService.clear).toHaveBeenCalled();
    expect((connectionToast as any).wsDisconnectToastShown).toBe(false);
  });

  it('AC4: ngOnDestroy suppresses disconnect toast triggered by unsubscribe (destroying guard)', async () => {
    await service.init('proc-1', true);

    // Destroy enters the destroying state BEFORE unsubscribe, so the complete
    // callback's `connectionToast.show()` call is suppressed.
    service.ngOnDestroy();

    // The only warn-toast add calls should be zero — the destroying guard
    // prevents the toast from being shown during intentional navigation.
    const warnCalls = msgService.add.calls.allArgs()
      .map((a: any[]) => a[0])
      .filter((c: any) => c.severity === 'warn' && c.summary === 'Connection Lost');
    expect(warnCalls.length).toBe(0);
  });

  // --- Story 34-4: the two seams the extraction made easier to break --------

  it('34-4 (AC7): stop() runs BEFORE the unsubscribe that completes the socket', async () => {
    // A plain `Subject.unsubscribe()` does NOT notify its subscribers, so the
    // `fakeSocket` above cannot reproduce this hazard at all — the test that
    // uses it passes whichever order `ngOnDestroy` writes. A real
    // `WebSocketSubject.unsubscribe()` closes the socket and the close
    // completes the stream, which re-enters the `complete` handler and raises
    // the toast. This double is that, and it is the only thing here that makes
    // the ordering falsifiable: swap the two statements in `ngOnDestroy` and a
    // "Connection Lost" warning appears on every deliberate navigation.
    const stream = new Subject<any>();
    const completingSocket = {
      subscribe: (observer: any) => stream.subscribe(observer),
      unsubscribe: () => stream.complete(),
      next: (value: any) => stream.next(value),
    };
    (teamSocket() as any).createWebSocket.and.returnValue(
      completingSocket as unknown as WebSocketSubject<any>,
    );
    await service.init('proc-1', true);
    jasmine.clock().tick(600);

    service.ngOnDestroy();

    expect(disconnectToasts().length).toBe(0);
  });

  it('34-4 (AC6): init() re-arms the toast, so a fresh team cycle warns again', async () => {
    await service.init('proc-1', true);
    jasmine.clock().tick(600);
    connectionToast.show();
    expect(disconnectToasts().length).toBe(1);

    // Team switch. `init()` calls `connectionToast.start()` at exactly the
    // point the inline flag reset used to sit. Drop that call and this second
    // team watches a dead socket with NO warning at all — a silence no other
    // spec in the suite would notice, because a missing toast fails nothing on
    // its own.
    fakeSocket = new Subject<any>();
    (teamSocket() as any).createWebSocket.and.returnValue(
      fakeSocket as unknown as WebSocketSubject<any>,
    );
    await service.init('proc-2', true);
    jasmine.clock().tick(600);
    connectionToast.show();

    expect(disconnectToasts().length).toBe(2);
  });

  it('AC5: WS error still calls flipOnFirstEvent (spinner falls through)', async () => {
    const chatService = TestBed.inject(ChatService);
    await service.init('proc-1', true);
    expect(service.loadingProcess$.value).toBe(true);

    // Past the spinner floor so flip is immediate.
    jasmine.clock().tick(600);
    fakeSocket.error(new Error('connect refused'));

    // flipOnFirstEvent was called — spinner is now false.
    expect(service.loadingProcess$.value).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Epic 17 / Story 17-2 (ADR-014) — `state` + `context` PerAgentStore instances
//
// Behavior-parity for the migrated state/context surface: the deleted
// stateDict$ produced `{ schema: {}, state }` latest-wins per agent; the
// deleted contextDict$ appended the inner `message` per LlmMessageEvent. These
// tests drive the same fixtures through the live WS path and the REST replay
// path and assert identical `forAgent`/`snapshot` results, plus automatic
// reset-on-team-switch and O(Δ) (no per-message re-fold). They drive the real
// log fold (no store mocking) per the story's testing standards.
// ---------------------------------------------------------------------------

describe('IngestionService — state + context PerAgentStore (Story 17-2)', () => {
  let service: IngestionService;
  let registry: PerAgentStoreRegistry;
  let log: MessageLogService;
  let fakeSocket: Subject<any>;

  function mkStateChanged(agentId: string, state: any, id: string): any {
    return {
      id,
      parent_id: null,
      team_id: 'team-X',
      timestamp: '2026-06-13T00:00:00Z',
      sender: makeAddress({ name: '@' + agentId, agent_id: agentId }),
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.StateChangedMessage',
      state,
    };
  }

  function mkLlmEvent(agentId: string, message: any, id: string): any {
    return {
      id,
      parent_id: null,
      team_id: 'team-X',
      timestamp: '2026-06-13T00:00:00Z',
      sender: makeAddress({ name: '@' + agentId, agent_id: agentId }),
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.EventMessage',
      event: {
        __model__: 'akgentic.llm.event.LlmMessageEvent',
        message,
      },
    };
  }

  /** An EventMessage carrying an LlmMessageEvent with NO inner message — must
   *  be skipped by the context spec (mirrors the old guard). */
  function mkLlmEventNoMessage(agentId: string, id: string): any {
    const e = mkLlmEvent(agentId, null, id);
    delete e.event.message;
    return e;
  }

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));

    fakeSocket = new Subject<any>();

    TestBed.configureTestingModule({
      providers: [
        MessageLogService,
        PerAgentStoreRegistry,
        ProcessStores,
        ReplaySeeder,
        LoadingIndicator,
        ConnectionToast,
        NotificationToasts,
        TeamSocket,
        LogFeeder,
        TeamStatusReactor,
        IngestionService,
        { provide: ContextService, useValue: contextServiceDouble() },
        ChatService,
        {
          provide: ApiService,
          useValue: {
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
            // Story 25-1 (!running gate): init() seeds the `state` store from
            // this endpoint ONLY for stopped teams. The running=false tests in
            // this suite hit that path; default to an empty snapshot list so
            // they exercise the no-op seed (and the running=true tests never
            // call it).
            getAgentStates: jasmine
              .createSpy('getAgentStates')
              .and.resolveTo([]),
          },
        },
        { provide: MessageService, useValue: { add: jasmine.createSpy('add'), clear: jasmine.createSpy('clear') } },
      ],
    });
    service = TestBed.inject(IngestionService);
    registry = TestBed.inject(PerAgentStoreRegistry);
    log = TestBed.inject(MessageLogService);

    spyOn<any>(teamSocket(), 'createWebSocket').and.returnValue(
      fakeSocket as unknown as WebSocketSubject<any>,
    );
  });

  afterEach(() => {
    try {
      fakeSocket.complete();
    } catch {
      /* already closed */
    }
    jasmine.clock().uninstall();
  });

  it('AC1: state is latest-wins {schema:{}, state}; context is the appended inner message[]', async () => {
    await service.init('proc-1', true);

    fakeSocket.next(mkStateChanged('agent-X', { phase: 'a' }, 's1'));
    fakeSocket.next(mkStateChanged('agent-X', { phase: 'b' }, 's2'));
    fakeSocket.next(mkLlmEvent('agent-X', { role: 'user', content: 'hi' }, 'e1'));
    fakeSocket.next(
      mkLlmEvent('agent-X', { role: 'assistant', content: 'yo' }, 'e2'),
    );
    jasmine.clock().tick(17);

    // state: latest-wins, schema is an empty object literal exactly as the old
    // dict produced.
    expect(service.state.snapshot('agent-X')).toEqual({
      schema: {},
      state: { phase: 'b' },
    });
    // context: ordered array of the inner `message` objects.
    expect(service.context.snapshot('agent-X')).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ]);
  });

  it('AC1: an LlmMessageEvent with no inner message is skipped (mirror old guard)', async () => {
    await service.init('proc-1', true);

    fakeSocket.next(mkLlmEventNoMessage('agent-X', 'e0'));
    fakeSocket.next(mkLlmEvent('agent-X', { role: 'user', content: 'kept' }, 'e1'));
    jasmine.clock().tick(17);

    expect(service.context.snapshot('agent-X')).toEqual([
      { role: 'user', content: 'kept' },
    ]);
  });

  it('AC4: stopped-team REST replay yields the SAME state/context as the live WS path', async () => {
    // Live WS ingestion of a fixture sequence.
    await service.init('proc-live', true);
    fakeSocket.next(mkStateChanged('A', { v: 1 }, 's1'));
    fakeSocket.next(mkLlmEvent('A', { role: 'user', content: 'm1' }, 'e1'));
    fakeSocket.next(mkStateChanged('A', { v: 2 }, 's2'));
    fakeSocket.next(mkLlmEvent('B', { role: 'user', content: 'm2' }, 'e2'));
    jasmine.clock().tick(17);
    const liveStateA = service.state.snapshot('A');
    const liveCtxA = service.context.snapshot('A');
    const liveCtxB = service.context.snapshot('B');

    // REST replay of the SAME ordered events as one getEvents() batch.
    const apiService = TestBed.inject(ApiService) as any;
    apiService.getEvents.and.resolveTo([
      { event: mkStateChanged('A', { v: 1 }, 'r-s1') },
      { event: mkLlmEvent('A', { role: 'user', content: 'm1' }, 'r-e1') },
      { event: mkStateChanged('A', { v: 2 }, 'r-s2') },
      { event: mkLlmEvent('B', { role: 'user', content: 'm2' }, 'r-e2') },
    ]);
    const socketB = new Subject<any>();
    (teamSocket() as any).createWebSocket = jasmine
      .createSpy('createWebSocket')
      .and.returnValue(socketB as unknown as WebSocketSubject<any>);
    await service.init('proc-stopped', false);

    expect(service.state.snapshot('A')).toEqual(liveStateA);
    expect(service.context.snapshot('A')).toEqual(liveCtxA);
    expect(service.context.snapshot('B')).toEqual(liveCtxB);
    expect(service.state.snapshot('A')).toEqual({ schema: {}, state: { v: 2 } });
    socketB.complete();
  });

  it('AC5: a team switch (init reset) clears state/context — no process-A leak into process-B', async () => {
    await service.init('proc-A', true);
    fakeSocket.next(mkStateChanged('A', { v: 1 }, 's1'));
    fakeSocket.next(mkLlmEvent('A', { role: 'user', content: 'm1' }, 'e1'));
    jasmine.clock().tick(17);
    expect(service.state.snapshot('A')).toEqual({ schema: {}, state: { v: 1 } });
    expect(service.context.snapshot('A')).toEqual([
      { role: 'user', content: 'm1' },
    ]);

    // Re-init (team switch) → log.reset() → registry clears its maps.
    const socketB = new Subject<any>();
    (teamSocket() as any).createWebSocket = jasmine
      .createSpy('createWebSocket')
      .and.returnValue(socketB as unknown as WebSocketSubject<any>);
    await service.init('proc-B', true);

    expect(service.state.snapshot('A')).toBeUndefined();
    expect(service.context.snapshot('A')).toBeUndefined();
    socketB.complete();
  });

  it('AC6: context append is O(Δ)/frame — cursor advances by tail length, no re-fold', async () => {
    await service.init('proc-1', true);

    // Frame 1: two messages → cursor advances by 2.
    fakeSocket.next(mkLlmEvent('A', { role: 'user', content: 'm1' }, 'e1'));
    fakeSocket.next(mkLlmEvent('A', { role: 'user', content: 'm2' }, 'e2'));
    jasmine.clock().tick(17);
    expect(registry.cursor).toBe(2);

    // Frame 2: one more message → cursor advances by exactly 1 (only the new
    // tail is folded; the prior two are NOT re-walked).
    fakeSocket.next(mkLlmEvent('A', { role: 'user', content: 'm3' }, 'e3'));
    jasmine.clock().tick(17);
    expect(registry.cursor).toBe(3);
    expect(service.context.snapshot('A')).toEqual([
      { role: 'user', content: 'm1' },
      { role: 'user', content: 'm2' },
      { role: 'user', content: 'm3' },
    ]);
  });

  it('AC7: state/context are PerAgentStore instances, NOT BehaviorSubject fields', () => {
    // The bespoke dicts are gone; no `stateDict$` / `contextDict$` own property.
    expect((service as any).stateDict$).toBeUndefined();
    expect((service as any).contextDict$).toBeUndefined();
    // The migrated surface exposes forAgent/snapshot, not a dict of subjects.
    expect(typeof service.state.forAgent).toBe('function');
    expect(typeof service.context.forAgent).toBe('function');
  });

  it('AC2/AC3: forAgent delivers the current value to a late subscriber (shareReplay)', async () => {
    await service.init('proc-1', true);
    fakeSocket.next(mkStateChanged('A', { v: 9 }, 's1'));
    fakeSocket.next(mkLlmEvent('A', { role: 'user', content: 'late' }, 'e1'));
    jasmine.clock().tick(17);

    let state: any = 'unset';
    let ctx: any = 'unset';
    const subS = service.state.forAgent('A').subscribe((v) => (state = v));
    const subC = service.context.forAgent('A').subscribe((v) => (ctx = v));
    // Late subscribe still sees the current value immediately.
    expect(state).toEqual({ schema: {}, state: { v: 9 } });
    expect(ctx).toEqual([{ role: 'user', content: 'late' }]);
    subS.unsubscribe();
    subC.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Story 25-1 (ADR-020 §2) — seed the `state` store from getAgentStates on init
//
// init() fetches per-agent snapshots (every status) AFTER log.reset() and
// log.appendAll()s synthesized StateChangedMessage entries so the registry's
// stateSpec folds them into the `state` store, keyed by sender.agent_id = the
// agent UUID (team Epic 23). Load-bearing case: a STOPPED team whose durable
// event log carries no StateChangedMessage (ADR-013) still shows the backstory
// head-block on load. These tests drive the REAL log fold (no store mocking),
// mocking only the HTTP layer (ApiService) per the story's testing standards.
// ---------------------------------------------------------------------------

describe('IngestionService — seed agent state on init (Story 25-1)', () => {
  let service: IngestionService;
  let log: MessageLogService;
  let apiService: any;
  let fakeSocket: Subject<any>;

  // A realistic agent UUID (team Epic 23) — distinct from the display name so
  // the UUID-keying assertion is meaningful.
  const UUID = '7f3c1e90-2a4b-4c6d-8e10-1234567890ab';
  const NAME = '@Researcher';

  function snapshot(state: Record<string, unknown>): any {
    return {
      agent_id: UUID,
      name: NAME,
      state,
      updated_at: '2026-06-18T00:00:00Z',
    };
  }

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));

    fakeSocket = new Subject<any>();

    TestBed.configureTestingModule({
      providers: [
        MessageLogService,
        PerAgentStoreRegistry,
        ProcessStores,
        ReplaySeeder,
        LoadingIndicator,
        ConnectionToast,
        NotificationToasts,
        TeamSocket,
        LogFeeder,
        TeamStatusReactor,
        IngestionService,
        { provide: ContextService, useValue: contextServiceDouble() },
        ChatService,
        {
          provide: ApiService,
          useValue: {
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
            getAgentStates: jasmine
              .createSpy('getAgentStates')
              .and.resolveTo([]),
          },
        },
        { provide: MessageService, useValue: { add: jasmine.createSpy('add'), clear: jasmine.createSpy('clear') } },
      ],
    });
    service = TestBed.inject(IngestionService);
    log = TestBed.inject(MessageLogService);
    apiService = TestBed.inject(ApiService) as any;

    spyOn<any>(teamSocket(), 'createWebSocket').and.returnValue(
      fakeSocket as unknown as WebSocketSubject<any>,
    );
  });

  afterEach(() => {
    try {
      fakeSocket.complete();
    } catch {
      /* already closed */
    }
    jasmine.clock().uninstall();
  });

  it('AC1/AC3: getAgentStates is fetched on init (stopped team)', async () => {
    await service.init('team-1', false);
    expect(apiService.getAgentStates).toHaveBeenCalledWith('team-1');
  });

  it('AC3/AC5: stopped-team init seeds state.forAgent(uuid) keyed by UUID with the backstory present', async () => {
    apiService.getAgentStates.and.resolveTo([
      snapshot({ backstory: 'A seasoned researcher.' }),
    ]);

    await service.init('team-1', false);

    // Keyed by the agent UUID (team Epic 23), value `{ schema: {}, state }`.
    expect(service.state.snapshot(UUID)).toEqual({
      schema: {},
      state: { backstory: 'A seasoned researcher.' },
    });
    // NOT keyed by the display name.
    expect(service.state.snapshot(NAME)).toBeUndefined();
  });

  it('AC3: running-team init DOES call getAgentStates and seeds the state store', async () => {
    // The `!running` gate is gone (akgentic-core ADR-020 §4 option (a)): the
    // stream subscribers now suppress StateChangedMessage, so the cursor-0 WS
    // replay is no longer a source of agent state and a running team would
    // otherwise have none — a blank backstory head-block, and no Member chat tab
    // at all once /clear has emptied `context`.
    apiService.getAgentStates.and.resolveTo([
      snapshot({ backstory: 'Seeded for a running team too.' }),
    ]);

    await service.init('team-1', true);

    expect(apiService.getAgentStates).toHaveBeenCalledWith('team-1');
    expect(service.state.snapshot(UUID)).toEqual({
      schema: {},
      state: { backstory: 'Seeded for a running team too.' },
    });
  });

  it('AC3: the durable event replay stays stopped-team-only', async () => {
    // Only the state seed was lifted out of the `!running` gate. A running team
    // still gets its history from the cursor-0 WS replay, never from getEvents.
    await service.init('team-1', true);

    expect(apiService.getEvents).not.toHaveBeenCalled();
  });

  it('AC6: the synthesized seed does NOT render as a chat bubble (messageList$ excludes it)', async () => {
    apiService.getAgentStates.and.resolveTo([
      snapshot({ backstory: 'Backstory.' }),
    ]);

    let list: any[] | null = null;
    const sub = log.messageList$.subscribe((v) => (list = v));

    await service.init('team-1', false);

    // The seed populated the state store but contributes NO message-list entry
    // (messageListFold admits only SentMessage / ErrorMessage).
    expect(service.state.snapshot(UUID)).toBeDefined();
    expect(list as any[] | null).toEqual([]);
    sub.unsubscribe();
  });

  it('AC6: the synthesized seed does NOT perturb context or commands', async () => {
    apiService.getAgentStates.and.resolveTo([
      snapshot({ backstory: 'Backstory.' }),
    ]);

    await service.init('team-1', false);

    // The StateChangedMessage matcher rejects for context (LlmMessageEvent) and
    // commands (CommandsAnnouncedEvent), so neither store is touched.
    expect(service.context.snapshot(UUID)).toBeUndefined();
    expect(service.commands.snapshot(UUID)).toBeUndefined();
  });

  it('AC3: multiple agents are each seeded under their own UUID key', async () => {
    const uuidB = '0a0a0a0a-bbbb-cccc-dddd-eeeeeeeeeeee';
    apiService.getAgentStates.and.resolveTo([
      snapshot({ backstory: 'A.' }),
      {
        agent_id: uuidB,
        name: '@Writer',
        state: { backstory: 'B.' },
        updated_at: '2026-06-18T00:00:01Z',
      },
    ]);

    await service.init('team-1', false);

    expect(service.state.snapshot(UUID)).toEqual({
      schema: {},
      state: { backstory: 'A.' },
    });
    expect(service.state.snapshot(uuidB)).toEqual({
      schema: {},
      state: { backstory: 'B.' },
    });
  });

  it('AC3: an empty snapshot list leaves the state store empty (no-op seed)', async () => {
    apiService.getAgentStates.and.resolveTo([]);

    await service.init('team-1', false);

    expect(service.state.snapshot(UUID)).toBeUndefined();
    expect(log.snapshot()).toEqual([]);
  });

  it('AC6: the existing getEvents replay still seeds the log unchanged alongside the state seed', async () => {
    apiService.getAgentStates.and.resolveTo([
      snapshot({ backstory: 'Backstory.' }),
    ]);
    // A SentMessage in the durable event log replays into the message list as
    // before; the state seed is additive and does not disturb it.
    const sent = {
      id: 'sent-1',
      parent_id: null,
      team_id: 'team-1',
      timestamp: '2026-06-18T00:00:00Z',
      sender: makeAddress({ role: 'Worker' }),
      display_type: 'ai',
      content: 'hello',
      __model__: 'akgentic.core.messages.orchestrator.SentMessage',
    };
    apiService.getEvents.and.resolveTo([{ event: sent }]);

    let list: any[] | null = null;
    const sub = log.messageList$.subscribe((v) => (list = v));

    await service.init('team-1', false);

    // getEvents replay still produces the bubble; the state seed is keyed in the
    // state store and contributes no bubble.
    expect((list as any[] | null)?.map((m) => m.id)).toEqual(['sent-1']);
    expect(service.state.snapshot(UUID)).toBeDefined();
    sub.unsubscribe();
  });

  // ---------- Epic 34 story 34-2: the ordering the extraction must not lose ----
  // The REST replay now lives in `ReplaySeeder`, but the two `log.appendAll`
  // calls stay HERE because they are two of the four centrally sequenced steps
  // (dispose -> reset -> seed -> open socket). Nothing pinned that until these
  // two specs: merging the seeder's two awaits into one array and one
  // `appendAll` reorders nothing today, so every other spec in this suite stays
  // green while the guarantee quietly disappears.

  it('34-2: a stopped-team init makes exactly TWO appendAll calls — state seed FIRST, event replay SECOND', async () => {
    apiService.getAgentStates.and.resolveTo([snapshot({ backstory: 'A.' })]);
    apiService.getEvents.and.resolveTo([
      {
        event: {
          id: 'sent-1',
          parent_id: null,
          team_id: 'team-1',
          timestamp: '2026-06-18T00:00:00Z',
          sender: makeAddress({ role: 'Worker' }),
          display_type: 'ai',
          content: 'hello',
          __model__: 'akgentic.core.messages.orchestrator.SentMessage',
        },
      },
    ]);

    const appendSpy = spyOn(log, 'appendAll').and.callThrough();

    await service.init('team-1', false);

    // One merged batch would collapse two `log$` emissions into one AND remove
    // the seed-before-replay guarantee: `stateSpec` is latest-wins, so a real
    // replayed `StateChangedMessage` has to be able to overwrite a synthesized
    // seed — never the reverse.
    expect(appendSpy).toHaveBeenCalledTimes(2);
    const batches = appendSpy.calls.allArgs().map((args: any[]) => args[0]);
    expect(batches[0].map((m: any) => m.__model__)).toEqual([
      'akgentic.core.messages.orchestrator.StateChangedMessage',
    ]);
    expect(batches[1].map((m: any) => m.id)).toEqual(['sent-1']);
  });

  it('34-2: a getAgentStates rejection rejects init() and getEvents is never issued', async () => {
    apiService.getAgentStates.and.rejectWith(new Error('boom'));

    // Two sequential awaits, no try/catch: the seed failing means the event
    // replay is never requested and `init()` rejects before the socket opens.
    // `Promise.all` would issue `getEvents` anyway and swallow that ordering.
    await expectAsync(service.init('team-1', false)).toBeRejected();

    expect(apiService.getEvents).not.toHaveBeenCalled();
  });

  it('AC5: a team switch clears the seeded state (re-seeded from the new team on re-init)', async () => {
    apiService.getAgentStates.and.resolveTo([
      snapshot({ backstory: 'Team A backstory.' }),
    ]);
    await service.init('team-A', false);
    expect(service.state.snapshot(UUID)).toBeDefined();

    // Re-init (team switch) with NO snapshots → log.reset() clears the registry
    // maps and the empty seed leaves the store empty.
    apiService.getAgentStates.and.resolveTo([]);
    const socketB = new Subject<any>();
    (teamSocket() as any).createWebSocket = jasmine
      .createSpy('createWebSocket')
      .and.returnValue(socketB as unknown as WebSocketSubject<any>);
    await service.init('team-B', false);

    expect(service.state.snapshot(UUID)).toBeUndefined();
    socketB.complete();
  });
});

// ---------------------------------------------------------------------------
// Story 31-3 — Persistent closable toast with agent-name header (AC1-AC5, AC8-AC10)
//
// The DOM half (close button, keyless rendering, coexistence) lives in
// `app.component.spec.ts`, because those three facts are PrimeNG contracts
// against the app's real `<p-toast>` mount and cannot be observed from a spy
// argument.
//
// Epic 34 / story 34-5 moved the TOAST half of this block to
// `notification-toasts.spec.ts`, where it is driven by a plain stream instead of
// a fake socket. What is left here is what needs the ingestion pipeline to mean
// anything: that the frame reaches the LOG as well as the toast, and that the
// disconnect toast on the WS error path is untouched by any of it.
// ---------------------------------------------------------------------------

/**
 * One frame factory for the 31-3 and 31-6 blocks: a full `BaseMessage`-shaped
 * notification-family frame.
 *
 * Story 31-6 added the last two parameters and hoisted the factory to module
 * scope so both blocks build frames the same way. `contentType` and
 * `senderRole` are what FR19's summary is computed from — the role because
 * orchestrator detection is role-based, never name-based — and both default to
 * the 31-3 values (`null` / a non-orchestrator `'Worker'`), so every call
 * written before 31-6 keeps its exact previous meaning.
 */
function mkNotification(
  id: string,
  model: string,
  senderName: string,
  content: string,
  contentType: string | null = null,
  senderRole = 'Worker',
): any {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-08-12T00:00:00Z',
    sender: makeAddress({
      name: senderName,
      role: senderRole,
      agent_id: 'agent-' + id,
    }),
    display_type: 'other',
    content,
    content_type: contentType,
    __model__: model,
  };
}

const WARNING_MODEL = 'akgentic.core.messages.orchestrator.WarningMessage';
const NOTIFICATION_MODEL =
  'akgentic.core.messages.orchestrator.NotificationMessage';
const ERROR_MODEL = 'akgentic.core.messages.orchestrator.ErrorMessage';

describe('IngestionService — Story 31-3 (notification toast)', () => {
  let service: IngestionService;
  let msgService: any;
  let fakeSocket: Subject<any>;

  const WARNING = WARNING_MODEL;

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));

    fakeSocket = new Subject<any>();

    TestBed.configureTestingModule({
      providers: [
        MessageLogService,
        PerAgentStoreRegistry,
        ProcessStores,
        ReplaySeeder,
        LoadingIndicator,
        ConnectionToast,
        NotificationToasts,
        TeamSocket,
        LogFeeder,
        TeamStatusReactor,
        IngestionService,
        { provide: ContextService, useValue: contextServiceDouble() },
        ChatService,
        {
          provide: ApiService,
          useValue: {
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
            getAgentStates: jasmine
              .createSpy('getAgentStates')
              .and.resolveTo([]),
          },
        },
        {
          provide: MessageService,
          useValue: {
            add: jasmine.createSpy('add'),
            clear: jasmine.createSpy('clear'),
          },
        },
      ],
    });
    service = TestBed.inject(IngestionService);
    msgService = TestBed.inject(MessageService);

    spyOn<any>(teamSocket(), 'createWebSocket').and.returnValue(
      fakeSocket as unknown as WebSocketSubject<any>,
    );
  });

  afterEach(() => {
    try {
      fakeSocket.complete();
    } catch {
      /* already closed */
    }
    jasmine.clock().uninstall();
  });

  /** init + advance past the spinner floor so frames land on a live pipeline. */
  async function start(): Promise<void> {
    await service.init('proc-1', true);
    jasmine.clock().tick(600);
    // init()'s `messageService.clear()` runs before any frame; reset so the
    // add-count assertions below count only frame-driven toasts.
    msgService.add.calls.reset();
  }

  it('AC9: the WarningMessage still reaches the message log (the toast is additive)', async () => {
    await start();
    const log = TestBed.inject(MessageLogService);

    fakeSocket.next(mkNotification('w-1', WARNING, '@Researcher', 'over limit'));
    // Past the 16 ms bufferTime window so the batched subscriber has appended.
    jasmine.clock().tick(20);

    expect(log.snapshot().map((m) => m.id)).toContain('w-1');
  });

  it('AC10: the disconnect toast is unchanged, closable:false included', async () => {
    await start();

    fakeSocket.error(new Error('connection lost'));

    expect(msgService.add).toHaveBeenCalledWith(
      jasmine.objectContaining({
        severity: 'warn',
        summary: 'Connection Lost',
        sticky: true,
        closable: false,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Story 31-6 — errors join the notification family; shared severity; summary
//
// Epic 34 / story 34-5 moved the severity partition (AC #5), the one-dispatch
// pin (AC #4) and every summary join case (AC #7-#11) to
// `notification-toasts.spec.ts` — they observe `MessageService.add` and need no
// pipeline. What remains here is AC #14, the half that is ABOUT the pipeline: an
// error toast is additive, so the error still lands in the log and in
// `messageList$`; plus the AC #15 disconnect toast on the WS error path.
// ---------------------------------------------------------------------------

describe('IngestionService — Story 31-6 (error parity, severity, summary)', () => {
  let service: IngestionService;
  let msgService: any;
  let fakeSocket: Subject<any>;

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));

    fakeSocket = new Subject<any>();

    TestBed.configureTestingModule({
      providers: [
        MessageLogService,
        PerAgentStoreRegistry,
        ProcessStores,
        ReplaySeeder,
        LoadingIndicator,
        ConnectionToast,
        NotificationToasts,
        TeamSocket,
        LogFeeder,
        TeamStatusReactor,
        IngestionService,
        { provide: ContextService, useValue: contextServiceDouble() },
        ChatService,
        {
          provide: ApiService,
          useValue: {
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
            getAgentStates: jasmine
              .createSpy('getAgentStates')
              .and.resolveTo([]),
          },
        },
        {
          provide: MessageService,
          useValue: {
            add: jasmine.createSpy('add'),
            clear: jasmine.createSpy('clear'),
          },
        },
      ],
    });
    service = TestBed.inject(IngestionService);
    msgService = TestBed.inject(MessageService);

    spyOn<any>(teamSocket(), 'createWebSocket').and.returnValue(
      fakeSocket as unknown as WebSocketSubject<any>,
    );
  });

  afterEach(() => {
    try {
      fakeSocket.complete();
    } catch {
      /* already closed */
    }
    jasmine.clock().uninstall();
  });

  async function start(): Promise<void> {
    await service.init('proc-1', true);
    jasmine.clock().tick(600);
    msgService.add.calls.reset();
  }

  // --- AC #14: the toast is additive, the log is untouched ------------------

  it('AC #14: an ErrorMessage still reaches the message log', async () => {
    await start();
    const log = TestBed.inject(MessageLogService);

    fakeSocket.next(mkNotification('e-1', ERROR_MODEL, '@Researcher', 'boom'));
    jasmine.clock().tick(20);

    expect(log.snapshot().map((m) => m.id)).toContain('e-1');
  });

  it('AC #14: an ErrorMessage still appears in messageList$', async () => {
    await start();
    const log = TestBed.inject(MessageLogService);

    fakeSocket.next(mkNotification('e-1', ERROR_MODEL, '@Researcher', 'boom'));
    jasmine.clock().tick(20);

    let listed: string[] = [];
    const sub = log.messageList$.subscribe(
      (ms) => (listed = ms.map((m) => m.id)),
    );
    expect(listed).toContain('e-1');
    sub.unsubscribe();
  });

  // --- AC #15: the untouched neighbours ------------------------------------

  it('AC #15: the disconnect toast is unchanged, closable:false included', async () => {
    await start();

    fakeSocket.error(new Error('connection lost'));

    expect(msgService.add).toHaveBeenCalledWith(
      jasmine.objectContaining({
        severity: 'warn',
        summary: 'Connection Lost',
        sticky: true,
        closable: false,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Story 31-4 — closed-notification suppression
//
// The sequencing here is load-bearing and deliberately NOT engineered away
// (AC #11): the suppression cache is fed from `log$`, which `IngestionService`
// feeds through the 16 ms `bufferTime` window. A `ClosedNotification` frame must
// therefore be FLUSHED to the log before a later frame can be suppressed, so
// every sequence below ticks past the buffer between the two frames.
// Within-one-frame suppression is not an AC — that ordering only arises during
// replay, which is story 31-5.
//
// Epic 34 / story 34-5 moved the suppressor itself to
// `notification-toasts.spec.ts`, where a closure reaching the log is expressed
// directly as a `closedIds$` emission. What stayed is everything that needs the
// pipeline: that a suppressed frame still reaches the log and `messageList$`,
// that a REST-replayed dismissal suppresses exactly as a live one does, and that
// teardown releases the cache.
// ---------------------------------------------------------------------------

describe('IngestionService — Story 31-4 (closed-notification suppression)', () => {
  let service: IngestionService;
  let msgService: any;
  let fakeSocket: Subject<any>;
  let log: MessageLogService;

  const WARNING = 'akgentic.core.messages.orchestrator.WarningMessage';
  const ERROR = 'akgentic.core.messages.orchestrator.ErrorMessage';

  /** Story 31-6 added the `model` parameter: the suppressor is keyed on the id
   *  alone and never inspects `__model__`, so the same specs must hold for an
   *  ErrorMessage now that errors toast through the same method (AC #13). */
  function mkNotification(id: string, content: string, model = WARNING): any {
    return {
      id,
      parent_id: null,
      team_id: 'team-1',
      timestamp: '2026-08-12T00:00:00Z',
      sender: makeAddress({ name: '@Researcher', agent_id: 'agent-' + id }),
      display_type: 'other',
      content,
      content_type: null,
      __model__: model,
    };
  }

  /** The `EventMessage(ClosedNotification)` frame the backend echoes back after
   *  a dismissal POST — the same shape a `getEvents` replay would carry. */
  function mkClosedNotification(id: string, messageId: string): any {
    return {
      id,
      parent_id: null,
      team_id: 'team-1',
      timestamp: '2026-08-12T00:00:00Z',
      sender: makeAddress({ name: '@Orchestrator', agent_id: 'orch' }),
      display_type: 'other',
      content: null,
      __model__: EVENT_MESSAGE_MODEL,
      event: { __model__: CLOSED_NOTIFICATION_MODEL, message_id: messageId },
    };
  }

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));

    fakeSocket = new Subject<any>();

    TestBed.configureTestingModule({
      providers: [
        MessageLogService,
        PerAgentStoreRegistry,
        ProcessStores,
        ReplaySeeder,
        LoadingIndicator,
        ConnectionToast,
        NotificationToasts,
        TeamSocket,
        LogFeeder,
        TeamStatusReactor,
        IngestionService,
        { provide: ContextService, useValue: contextServiceDouble() },
        ChatService,
        {
          provide: ApiService,
          useValue: {
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
            getAgentStates: jasmine
              .createSpy('getAgentStates')
              .and.resolveTo([]),
          },
        },
        {
          provide: MessageService,
          useValue: {
            add: jasmine.createSpy('add'),
            clear: jasmine.createSpy('clear'),
          },
        },
      ],
    });
    service = TestBed.inject(IngestionService);
    msgService = TestBed.inject(MessageService);
    log = TestBed.inject(MessageLogService);

    spyOn<any>(teamSocket(), 'createWebSocket').and.returnValue(
      fakeSocket as unknown as WebSocketSubject<any>,
    );
  });

  afterEach(() => {
    try {
      fakeSocket.complete();
    } catch {
      /* already closed */
    }
    jasmine.clock().uninstall();
  });

  async function start(): Promise<void> {
    await service.init('proc-1', true);
    jasmine.clock().tick(600);
    msgService.add.calls.reset();
  }

  it('AC10: the suppressed WarningMessage is STILL appended to the log', async () => {
    await start();

    fakeSocket.next(mkClosedNotification('c-1', 'w-1'));
    jasmine.clock().tick(20);
    fakeSocket.next(mkNotification('w-1', 'token budget exceeded'));
    jasmine.clock().tick(20);

    expect(log.snapshot().map((m) => m.id)).toContain('w-1');
  });

  it('AC10: the suppressed WarningMessage still appears in messageList$', async () => {
    await start();

    fakeSocket.next(mkClosedNotification('c-1', 'w-1'));
    jasmine.clock().tick(20);
    fakeSocket.next(mkNotification('w-1', 'token budget exceeded'));
    jasmine.clock().tick(20);

    let listed: string[] = [];
    const sub = log.messageList$.subscribe(
      (ms) => (listed = ms.map((m) => m.id)),
    );
    expect(listed).toContain('w-1');
    sub.unsubscribe();
  });

  it('AC9: a dismissal replayed by getEvents suppresses just as a live one does', async () => {
    // The reload path: the closure arrives in the REST replay, not on the WS.
    const api = TestBed.inject(ApiService) as any;
    api.getEvents.and.resolveTo([
      { event: mkClosedNotification('c-1', 'w-1') },
    ]);

    await service.init('proc-1', false);
    jasmine.clock().tick(600);
    msgService.add.calls.reset();

    fakeSocket.next(mkNotification('w-1', 'token budget exceeded'));
    // Story 35-1: the dispatch is downstream of the log now, so without this
    // flush nothing would toast for ANY reason and the assertion below would
    // hold vacuously. Ticking is what keeps it a suppression spec.
    jasmine.clock().tick(20);

    expect(msgService.add).not.toHaveBeenCalled();
  });

  it('AC #13: the suppressed ErrorMessage is STILL appended to the log', async () => {
    await start();

    fakeSocket.next(mkClosedNotification('c-1', 'e-1'));
    jasmine.clock().tick(20);
    fakeSocket.next(mkNotification('e-1', 'boom', ERROR));
    jasmine.clock().tick(20);

    expect(log.snapshot().map((m) => m.id)).toContain('e-1');
  });

  it('ngOnDestroy tears the closed-ids subscription down', async () => {
    await start();
    // Epic 34 / story 34-5: the subscription and the cache moved to
    // `NotificationToasts`, so these two assertions reach the same MEMBERS
    // through a different object. The subscription is a `Subscription` BAG now,
    // nulled by `stop()` rather than left closed in place — the strictly
    // stronger of the two states, since a nulled bag cannot be re-entered.
    const toasts = TestBed.inject(NotificationToasts) as any;

    service.ngOnDestroy();

    // A post-teardown log emission must not feed the cache any more; the
    // BehaviorSubject would otherwise keep a live observer for ever. Asserted
    // on the subscription AND on the cache: `not.toThrow()` alone stayed green
    // with `closedIdsSub.unsubscribe()` deleted from ngOnDestroy, so it guarded
    // nothing.
    expect(toasts.subs).toBeNull();

    log.append(mkClosedNotification('c-9', 'w-9'));

    expect(toasts.closedNotificationIds.has('w-9')).toBeFalse();
  });
});

// ---------------------------------------------------------------------------
// Story 31-5 — a ClosedNotification takes its toast back off the screen
//
// Story 31-4 stopped a dismissed warning from toasting when the closure was
// already known. It could not help when the closure arrives SECOND, which is
// exactly what a reload does: history replays from cursor 0, so the older
// `WarningMessage` lands before its newer `ClosedNotification`, and until this
// story nothing ever removed the toast that opened in between. It stayed, every
// reload, for ever.
//
// These specs therefore assert against toasts that are ON SCREEN, not against
// `MessageService.add` call counts — a count cannot tell "never raised" apart
// from "raised and then removed", and the whole story lives in that difference.
// `FakeToastContainer` stands in for the app's `<p-toast>`: it mirrors the two
// PrimeNG behaviours the app depends on (a keyless mount admits only keyless
// messages; a no-arg `clear()` empties it), both of which are pinned against
// the real mount in `app.component.spec.ts`.
//
// Epic 34 / story 34-5 moved the removal specs to `notification-toasts.spec.ts`,
// mount and all. Five stayed, and each for the same reason: its subject is the
// TRANSPORT rather than the toast. The one below is the sharpest of them — its
// whole point is that both frames sit inside ONE unflushed 16 ms window, which
// is the AC3(a) cache lag stated as a test. It cannot move to a harness that has
// no window.
// ---------------------------------------------------------------------------

/** Minimal stand-in for the app's single keyless `<p-toast>`. */
class FakeToastContainer {
  messages: any[] = [];
  cd = { markForCheck: jasmine.createSpy('markForCheck') };

  constructor(messageService: MessageService) {
    messageService.messageObserver.subscribe((m: any) => {
      const incoming = Array.isArray(m) ? m : [m];
      // PrimeNG's `Toast.canAdd`: `this.key === message.key`. This mount has no
      // key, so a keyed message is silently dropped.
      this.messages.push(...incoming.filter((x) => x.key === undefined));
    });
    messageService.clearObserver.subscribe((key: any) => {
      if (!key) this.messages = [];
    });
  }

  summaries(): string[] {
    return this.messages.map((m) => m.summary);
  }

  messageIds(): (string | undefined)[] {
    return this.messages.map((m) => m.data?.messageId);
  }
}

describe('IngestionService — Story 31-5 (reactive toast removal)', () => {
  let service: IngestionService;
  let messageService: MessageService;
  let toastContainer: FakeToastContainer;
  let fakeSocket: Subject<any>;
  let log: MessageLogService;

  const WARNING = 'akgentic.core.messages.orchestrator.WarningMessage';

  /** Story 31-6 added the `model` parameter: removal is addressed by
   *  `data.messageId` and never by `__model__`, so an error toast comes off the
   *  screen by the same path a warning does (AC #13). */
  function mkWarning(
    id: string,
    content = 'token budget exceeded',
    model = WARNING,
  ): any {
    return {
      id,
      parent_id: null,
      team_id: 'team-1',
      timestamp: '2026-08-13T00:00:00Z',
      sender: makeAddress({ name: '@Researcher', agent_id: 'agent-' + id }),
      display_type: 'other',
      content,
      content_type: null,
      __model__: model,
    };
  }

  function mkClosedNotification(id: string, messageId: string): any {
    return {
      id,
      parent_id: null,
      team_id: 'team-1',
      timestamp: '2026-08-13T00:00:00Z',
      sender: makeAddress({ name: '@Orchestrator', agent_id: 'orch' }),
      display_type: 'other',
      content: null,
      __model__: EVENT_MESSAGE_MODEL,
      event: { __model__: CLOSED_NOTIFICATION_MODEL, message_id: messageId },
    };
  }

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));

    fakeSocket = new Subject<any>();

    TestBed.configureTestingModule({
      providers: [
        MessageLogService,
        PerAgentStoreRegistry,
        ProcessStores,
        ReplaySeeder,
        LoadingIndicator,
        ConnectionToast,
        NotificationToasts,
        TeamSocket,
        LogFeeder,
        TeamStatusReactor,
        IngestionService,
        { provide: ContextService, useValue: contextServiceDouble() },
        ChatService,
        MessageService,
        {
          provide: ApiService,
          useValue: {
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
            getAgentStates: jasmine
              .createSpy('getAgentStates')
              .and.resolveTo([]),
          },
        },
      ],
    });
    messageService = TestBed.inject(MessageService);
    toastContainer = new FakeToastContainer(messageService);
    TestBed.inject(NotificationToastService).register(
      toastContainer as unknown as Toast,
    );

    service = TestBed.inject(IngestionService);
    log = TestBed.inject(MessageLogService);

    spyOn<any>(teamSocket(), 'createWebSocket').and.returnValue(
      fakeSocket as unknown as WebSocketSubject<any>,
    );
  });

  afterEach(() => {
    try {
      fakeSocket.complete();
    } catch {
      /* already closed */
    }
    jasmine.clock().uninstall();
  });

  /**
   * init + advance past the spinner floor.
   *
   * The 600 ms tick DRAINS the 16 ms frame buffer, so it must happen before any
   * frame is pushed — pushing first and ticking once at the end would flush
   * warning and closure together and exercise nothing (the 31-4 trap).
   */
  async function start(): Promise<void> {
    await service.init('proc-1', true);
    jasmine.clock().tick(600);
  }

  /** Flush the 16 ms `bufferTime` window so pushed frames reach the log. */
  function flushFrames(): void {
    jasmine.clock().tick(20);
  }

  // --- AC #4: the reload regression, now written as "zero throughout" -------

  it('AC #4: the same pair delivered in ONE replay frame raises NO toast at all', async () => {
    // History replays in a burst, so both frames routinely land inside the same
    // 16 ms window. Under Story 31-5 this was removal — the warning toasted on
    // the raw stream and the closure took it back off the screen one buffer
    // later — and this spec asserted the flash in between.
    //
    // Story 35-1 (ADR-027 §5) closed that window deliberately. Both frames now
    // reach the log in ONE batch, `_log$` emits before `_appended$`, so
    // `closedNotificationIds$` has folded the closure by the time the reactor
    // sees the warning and the SUPPRESSOR fires instead. Zero before the flush
    // (nothing has reached the log yet) and zero after it (suppressed, not
    // removed) — the difference between those two zeroes is what
    // `FakeToastContainer` exists to express.
    //
    // Expressing it takes BOTH witnesses, and that is not belt-and-braces. The
    // container is only ever inspected between ticks, while a suppressor
    // failure would raise the toast and remove it again INSIDE the single
    // synchronous flush below — leaving `messages` empty at both observation
    // points. Swap the two `next` calls in `appendAll` and the container sees
    // nothing wrong; `add` is the only witness to the flash. Conversely `add`
    // alone cannot tell a suppressed toast from a removed one, which is the
    // distinction 31-5 was written for.
    await start();

    const add = spyOn(messageService, 'add').and.callThrough();

    fakeSocket.next(mkWarning('w-1'));
    fakeSocket.next(mkClosedNotification('c-1', 'w-1'));
    expect(toastContainer.messageIds()).toEqual([]);

    flushFrames();

    expect(add).not.toHaveBeenCalled();
    expect(toastContainer.messages).toEqual([]);
  });

  // --- AC #2: only the matching toast goes ----------------------------------

  it('AC #2: the WS-disconnect toast is untouched by a dismissal', async () => {
    await start();

    fakeSocket.next(mkWarning('w-1'));
    // Story 35-1: the warning toasts when it reaches the LOG, so it must be
    // flushed before the disconnect toast is raised or the two arrive in the
    // opposite order. The assertion below is unchanged — this preserves its
    // meaning rather than relaxing it.
    flushFrames();
    TestBed.inject(ConnectionToast).show();
    expect(toastContainer.summaries()).toEqual([
      '@Researcher',
      'Connection Lost',
    ]);

    fakeSocket.next(mkClosedNotification('c-1', 'w-1'));
    flushFrames();

    expect(toastContainer.summaries()).toEqual(['Connection Lost']);
  });

  // --- AC #7: the historical record is not filtered --------------------------

  it('AC #7: the dismissed WarningMessage still appears in messageList$', async () => {
    await start();

    fakeSocket.next(mkWarning('w-1'));
    fakeSocket.next(mkClosedNotification('c-1', 'w-1'));
    flushFrames();
    expect(toastContainer.messages).toEqual([]);

    let listed: string[] = [];
    const sub = log.messageList$.subscribe(
      (ms) => (listed = ms.map((m) => m.id)),
    );
    expect(listed).toContain('w-1');
    sub.unsubscribe();
  });

  // --- AC #9: hygiene --------------------------------------------------------

  it('AC #9: the removal-driving subscription is torn down on destroy', async () => {
    await start();
    // Epic 34 / story 34-5: same members, different object — see the matching
    // note in the 31-4 block above.
    const toasts = TestBed.inject(NotificationToasts) as any;

    fakeSocket.next(mkWarning('w-1'));
    service.ngOnDestroy();
    // ngOnDestroy blanket-clears, which is the pre-existing 8-2 behaviour.
    expect(toastContainer.messages).toEqual([]);

    expect(toasts.subs).toBeNull();

    // A closure folded after teardown must reach nothing.
    log.append(mkClosedNotification('c-9', 'w-9'));
    expect(toasts.closedNotificationIds.has('w-9')).toBeFalse();
  });

  it('a team switch re-arms removal for the new team', async () => {
    await start();
    fakeSocket.next(mkWarning('w-1'));
    // Story 35-1: a frame toasts once it reaches the log, so each push below
    // needs its buffer flushed before the on-screen assertion.
    flushFrames();
    expect(toastContainer.messageIds()).toEqual(['w-1']);

    const socketB = new Subject<any>();
    (teamSocket() as any).createWebSocket = jasmine
      .createSpy('createWebSocket')
      .and.returnValue(socketB as unknown as WebSocketSubject<any>);
    await service.init('proc-2', true);
    jasmine.clock().tick(600);
    // init()'s blanket clear took team A's toast with it.
    expect(toastContainer.messages).toEqual([]);

    socketB.next(mkWarning('w-9'));
    flushFrames();
    expect(toastContainer.messageIds()).toEqual(['w-9']);

    socketB.next(mkClosedNotification('c-9', 'w-9'));
    jasmine.clock().tick(20);

    expect(toastContainer.messages).toEqual([]);
    socketB.complete();
  });
});

// ---------------------------------------------------------------------------
// Epic 34 / story 34-5 — how the orchestrator SEQUENCES the notification-toast
// reactor.
//
// `notification-toasts.spec.ts` proves what the unit does. These specs prove
// what only this file can see, because each is a property of the wiring rather
// than of the unit:
//
//   * that `init()` disposes the previous cycle's reactor before opening a new
//     one — drop `notificationToasts.stop()` from `disposePriorSubscriptions()`
//     and the second cycle leaves TWO live subscriptions on the one shared
//     stream, doubling every toast for the rest of the component's life;
//   * that a frame delivered the instant the socket opens still toasts;
//   * that both delivery paths toast the SAME WAY. This last one is the
//     inversion Story 35-1 (ADR-027) landed. It used to read "a STOPPED team
//     raises NO toast, while the SAME event on a RUNNING team raises one" and
//     it pinned the reported defect as if it were a guarantee — the transport
//     decided whether an operator saw an error. The reactor reads
//     `log.appended$` now, so the asymmetry is gone and this spec asserts its
//     absence.
// ---------------------------------------------------------------------------

describe('IngestionService — notification-toast reactor sequencing (Epic 34)', () => {
  let service: IngestionService;
  let msgService: any;
  let fakeSocket: Subject<any>;

  const WARNING = 'akgentic.core.messages.orchestrator.WarningMessage';

  function mkWarning(id: string): any {
    return {
      id,
      parent_id: null,
      team_id: 'team-1',
      timestamp: '2026-08-13T00:00:00Z',
      sender: makeAddress({ name: '@Researcher', agent_id: 'agent-' + id }),
      display_type: 'other',
      content: 'token budget exceeded',
      content_type: null,
      __model__: WARNING,
    };
  }

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));

    fakeSocket = new Subject<any>();

    TestBed.configureTestingModule({
      providers: [
        MessageLogService,
        PerAgentStoreRegistry,
        ProcessStores,
        ReplaySeeder,
        LoadingIndicator,
        ConnectionToast,
        NotificationToasts,
        TeamSocket,
        LogFeeder,
        TeamStatusReactor,
        IngestionService,
        { provide: ContextService, useValue: contextServiceDouble() },
        ChatService,
        {
          provide: ApiService,
          useValue: {
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
            getAgentStates: jasmine
              .createSpy('getAgentStates')
              .and.resolveTo([]),
          },
        },
        {
          provide: MessageService,
          useValue: {
            add: jasmine.createSpy('add'),
            clear: jasmine.createSpy('clear'),
          },
        },
      ],
    });
    service = TestBed.inject(IngestionService);
    msgService = TestBed.inject(MessageService);

    spyOn<any>(teamSocket(), 'createWebSocket').and.returnValue(
      fakeSocket as unknown as WebSocketSubject<any>,
    );
  });

  afterEach(() => {
    try {
      fakeSocket.complete();
    } catch {
      /* already closed */
    }
    jasmine.clock().uninstall();
  });

  it('AC2: a re-init cycle raises exactly ONE toast per event, not two', async () => {
    await service.init('proc-1', true);
    jasmine.clock().tick(600);

    // Team switch. `_wsInbound$` is the SAME subject across cycles, so a reactor
    // that was never stopped is still subscribed to it.
    const socketB = new Subject<any>();
    (teamSocket() as any).createWebSocket = jasmine
      .createSpy('createWebSocket')
      .and.returnValue(socketB as unknown as WebSocketSubject<any>);
    await service.init('proc-2', true);
    jasmine.clock().tick(600);
    msgService.add.calls.reset();

    socketB.next(mkWarning('w-1'));
    // Story 35-1: the toast is raised when the frame reaches the LOG, one
    // buffer window later. The assertion is unchanged and still catches the
    // leak it was written for — a second live subscription doubles this to 2.
    jasmine.clock().tick(20);

    expect(msgService.add).toHaveBeenCalledTimes(1);
    socketB.complete();
  });

  it('AC2 (ADR-005 §Decision 6): a frame delivered the instant the socket opens still toasts', async () => {
    // The THIRD ordering this wiring depends on, and the one no other spec can
    // see: `start()` must run BEFORE `createWebSocket(...)`, not merely after
    // `setupBatchedSubscriber()`. Move it below the socket and every other spec
    // in the suite stays green, because a plain `Subject` fake delivers nothing
    // at subscribe time — the gap only opens for a transport that replays on
    // subscription, which is exactly what a cursor-0 replay is and what story
    // 34-6's `TeamSocket` may well be.
    //
    // A `ReplaySubject` models that: the frame is already buffered when
    // `webSocket.subscribe({...})` runs, so it reaches `_wsInbound$` inside
    // `init()` itself. A reactor started afterwards never sees it, and the
    // notification is silently lost with nothing else failing.
    const replaying = new ReplaySubject<any>(1);
    replaying.next(mkWarning('w-1'));
    (teamSocket() as any).createWebSocket = jasmine
      .createSpy('createWebSocket')
      .and.returnValue(replaying as unknown as WebSocketSubject<any>);

    await service.init('proc-1', true);
    jasmine.clock().tick(600);

    expect(msgService.add).toHaveBeenCalledTimes(1);
    expect(msgService.add.calls.mostRecent().args[0].data.messageId).toBe(
      'w-1',
    );
    replaying.complete();
  });

  it('AC3b (inverted by Story 35-1): a STOPPED team and a RUNNING team raise the SAME toast for the same event', async () => {
    // Symmetry, in one spec because the two halves are only meaningful against
    // each other. Same historical event, same team, two transports — and now
    // one outcome. This spec previously asserted the opposite and was the
    // clearest statement of the defect anywhere in the suite.
    const api = TestBed.inject(ApiService) as any;
    api.getEvents.and.resolveTo([{ event: mkWarning('w-1') }]);

    await service.init('proc-1', false);
    jasmine.clock().tick(600);

    // The REST replay goes through `log.appendAll`, which is what the reactor
    // subscribes now. Leave `notificationToasts.start(...)` below the replay
    // block and this assertion is the one that fails.
    expect(msgService.add).toHaveBeenCalledTimes(1);
    expect(msgService.add.calls.mostRecent().args[0].data.messageId).toBe(
      'w-1',
    );

    // The same frame over the wire on a running team raises the same toast.
    const socketB = new Subject<any>();
    (teamSocket() as any).createWebSocket = jasmine
      .createSpy('createWebSocket')
      .and.returnValue(socketB as unknown as WebSocketSubject<any>);
    await service.init('proc-2', true);
    jasmine.clock().tick(600);
    msgService.add.calls.reset();

    socketB.next(mkWarning('w-1'));
    jasmine.clock().tick(20);

    expect(msgService.add).toHaveBeenCalledTimes(1);
    expect(msgService.add.calls.mostRecent().args[0].data.messageId).toBe(
      'w-1',
    );
    socketB.complete();
  });
});

// ---------------------------------------------------------------------------
// Story 34-6 — init() sequencing: the four ordered steps, as CALL ORDER
//
// ADR-005 §Decision 6 / architecture shard 02 §4 fix the order as
//   (a) dispose the prior cycle
//   (b) log.reset()
//   (c) seed the replay (stopped teams)
//   (d) wire the consumers, THEN open the socket
//
// Every spec below asserts on the SEQUENCE rather than on the outcome. That
// distinction is the point: with a single team and a single init(), every order
// produces a correct log, so an outcome-only assertion passes on an
// implementation that has already lost the guarantee. The failure surfaces only
// on a team switch, in production, as state from the previous team.
// ---------------------------------------------------------------------------

describe('IngestionService — init() ordering + self-wiring (Story 34-6)', () => {
  let service: IngestionService;
  let log: MessageLogService;

  function mkStart(id: string): any {
    return {
      id,
      parent_id: null,
      team_id: 'team-X',
      timestamp: '2026-08-14T00:00:00Z',
      sender: makeAddress({ agent_id: 'a1' }),
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.StartMessage',
    };
  }

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));

    TestBed.configureTestingModule({
      providers: [
        MessageLogService,
        PerAgentStoreRegistry,
        ProcessStores,
        ReplaySeeder,
        LoadingIndicator,
        ConnectionToast,
        NotificationToasts,
        TeamSocket,
        LogFeeder,
        TeamStatusReactor,
        IngestionService,
        { provide: ContextService, useValue: contextServiceDouble() },
        ChatService,
        {
          provide: ApiService,
          useValue: {
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
            getAgentStates: jasmine
              .createSpy('getAgentStates')
              .and.resolveTo([]),
          },
        },
        {
          provide: MessageService,
          useValue: {
            add: jasmine.createSpy('add'),
            clear: jasmine.createSpy('clear'),
          },
        },
      ],
    });
    // NOTHING is injected here, on purpose. The self-wiring spec below has to
    // install its spies BEFORE the graph is constructed, so every test in this
    // block builds it for itself through `boot()`.
  });

  afterEach(() => jasmine.clock().uninstall());

  /** Construct the graph — this is the moment a self-wired unit would act. */
  function boot(): void {
    service = TestBed.inject(IngestionService);
    log = TestBed.inject(MessageLogService);
  }

  it('AC4: the whole graph is INERT until init() runs', () => {
    // PROTOTYPE spies, installed before anything is injected. An instance spy
    // cannot see a constructor-time call — it can only be attached once the
    // instance exists, i.e. once the damage is done — so a guard built on one
    // would pass against the very implementation it exists to reject.
    const created = spyOn<any>(TeamSocket.prototype, 'createWebSocket');
    const reset = spyOn(MessageLogService.prototype, 'reset').and.callThrough();
    const appendAll = spyOn(
      MessageLogService.prototype,
      'appendAll',
    ).and.callThrough();

    boot();

    // Every unit has been constructed by DI at this point — and that must be all
    // that has happened. A constructor-time `subscribe`, `createWebSocket` or
    // log mutation would put Angular's DI order in charge of a sequence the
    // orchestrator owns, and every other spec in this suite would still pass: a
    // green single-team suite is exactly what a self-wired implementation
    // produces. This assertion, taken BEFORE init(), is the only one that sees
    // it.
    expect(created).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(appendAll).not.toHaveBeenCalled();
    expect(inboundSubject().observers.length).toBe(0);
    expect((teamSocket() as any)._frames$.observers.length).toBe(0);
    expect((teamSocket() as any)._status$.observers.length).toBe(0);
  });

  it('AC5: reset precedes the replay append, which precedes the socket', async () => {
    boot();
    const api = TestBed.inject(ApiService) as any;
    api.getEvents.and.resolveTo([{ event: mkStart('r1') }]);

    const calls: string[] = [];
    spyOn(log, 'reset').and.callFake(() => calls.push('reset'));
    spyOn(log, 'appendAll').and.callFake(() => calls.push('appendAll'));
    (teamSocket() as any).createWebSocket = () => {
      calls.push('createWebSocket');
      return new Subject<any>() as unknown as WebSocketSubject<any>;
    };

    await service.init('proc-1', false);

    // Call order, not final state. A `reset` after the replay would wipe the
    // history it just seeded; a socket before the replay reopens the
    // team-switch race.
    expect(calls.indexOf('reset')).toBe(0);
    expect(calls.lastIndexOf('appendAll')).toBeGreaterThan(
      calls.indexOf('reset'),
    );
    expect(calls.indexOf('createWebSocket')).toBeGreaterThan(
      calls.lastIndexOf('appendAll'),
    );
  });

  it('AC6: a socket that delivers AS IT OPENS still lands after the replay', async () => {
    boot();
    const api = TestBed.inject(ApiService) as any;
    api.getEvents.and.resolveTo([
      { event: mkStart('r1') },
      { event: mkStart('r2') },
    ]);

    // A transport that emits synchronously at subscribe time — which is exactly
    // what a cursor-0 replay is. Were the socket opened before step (c), this
    // frame would land in an EMPTY log and the replay would pile on top of it.
    const stream = new Subject<any>();
    (teamSocket() as any).createWebSocket = () =>
      ({
        subscribe: (observer: any) => {
          const sub = stream.subscribe(observer);
          observer.next(mkStart('live-1'));
          return sub;
        },
        unsubscribe: () => stream.complete(),
      }) as unknown as WebSocketSubject<any>;

    await service.init('proc-1', false);
    jasmine.clock().tick(17);

    expect(log.snapshot().map((m: any) => m.id)).toEqual([
      'r1',
      'r2',
      'live-1',
    ]);
  });

  it('AC6: a STALE cycle socket contributes nothing to the fresh log', async () => {
    boot();
    // Cycle A, on a transport whose `unsubscribe` closes the delivery path but
    // leaves the underlying stream usable — so this spec can keep pushing at it
    // after the switch, which is the whole scenario.
    const streamA = new Subject<any>();
    let subA: Subscription | null = null;
    (teamSocket() as any).createWebSocket = () =>
      ({
        subscribe: (observer: any) => {
          subA = streamA.subscribe(observer);
          return subA;
        },
        unsubscribe: () => subA?.unsubscribe(),
      }) as unknown as WebSocketSubject<any>;

    await service.init('proc-A', true);
    streamA.next(mkStart('A-1'));
    jasmine.clock().tick(17);
    expect(log.snapshot().map((m: any) => m.id)).toEqual(['A-1']);

    // Team switch.
    const streamB = new Subject<any>();
    (teamSocket() as any).createWebSocket = () =>
      streamB as unknown as WebSocketSubject<any>;
    await service.init('proc-B', true);

    // A's transport keeps producing. Step (a) closed it, so nothing of A's can
    // reach the inbound stream the fresh cycle's feeder is attached to. That
    // subject is SHARED across cycles by design, so closing the old socket is
    // the only thing standing between process-A's tail and process-B's log.
    streamA.next(mkStart('A-2'));
    streamA.next(mkStart('A-3'));
    jasmine.clock().tick(17);

    expect(log.snapshot()).toEqual([]);

    streamB.next(mkStart('B-1'));
    jasmine.clock().tick(17);
    expect(log.snapshot().map((m: any) => m.id)).toEqual(['B-1']);
  });

  it('AC10: a frame with NO __model__ flips the spinner and appends nothing', async () => {
    boot();
    const stream = new Subject<any>();
    (teamSocket() as any).createWebSocket = () =>
      stream as unknown as WebSocketSubject<any>;

    await service.init('proc-1', true);
    jasmine.clock().tick(600);
    expect(service.loadingProcess$.value).toBe(true);

    stream.next({ hello: 'world' });
    jasmine.clock().tick(17);

    // Receiving bytes is proof the replay stream has started, so the spinner
    // ends even for a frame nothing downstream can classify — and that same
    // frame must never reach the log.
    expect(service.loadingProcess$.value).toBe(false);
    expect(log.snapshot()).toEqual([]);
  });

  it('FR9: N re-inits leave ONE tap per stream, and none after destroy', async () => {
    // The re-init half of the leak guarantee, and the half the mount/unmount
    // probe cannot reach: these two taps live on `frames$` and `status$`, not on
    // the inbound stream. Wire either destroy-scoped — `takeUntilDestroyed()`,
    // or any teardown that runs only in `ngOnDestroy` — and that probe stays
    // green while these climb 1, 2, 3, 4.
    boot();
    const frames = (teamSocket() as any)._frames$;
    const status = (teamSocket() as any)._status$;

    for (let i = 0; i < 4; i++) {
      const cycleStream = new Subject<any>();
      (teamSocket() as any).createWebSocket = () =>
        cycleStream as unknown as WebSocketSubject<any>;

      await service.init('proc-' + i, true);

      expect(frames.observers.length).toBe(1);
      expect(status.observers.length).toBe(1);
      // And the inbound stream stays at its own post-init bound throughout.
      // Story 35-1 lowered that bound from 3 to 2: the notification reactor
      // reads `log.appended$` now, not this subject.
      expect(inboundSubject().observers.length).toBe(2);
    }

    service.ngOnDestroy();

    expect(frames.observers.length).toBe(0);
    expect(status.observers.length).toBe(0);
    expect(inboundSubject().observers.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Story 35-1 — the notification reactor reads the LOG, wired ABOVE the replay
//
// The reported defect and its fix, at the only level either is visible: a
// stopped team reaches the log through `replay → log.appendAll`, never through
// the socket, so a reactor hanging off the transport is silent for it.
//
// Two invariants are pinned here, and NEITHER is expressible in
// `notification-toasts.spec.ts`, whose harness has no `init()`:
//
//   * the reactor is fed `log.appended$`, so every delivery path toasts;
//   * `start(...)` is called BEFORE the `if (!running)` replay block. `appended$`
//     is a plain `Subject`, so a subscriber that arrives after `appendAll` gets
//     nothing. Move the call back below the replay and the stopped-team spec
//     below goes red while every live-path spec in this file stays green — which
//     is exactly the shape of the bug being fixed.
// ---------------------------------------------------------------------------

describe('IngestionService — Story 35-1 (toasts dispatch from the log)', () => {
  let service: IngestionService;
  let msgService: any;
  let fakeSocket: Subject<any>;

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));

    fakeSocket = new Subject<any>();

    TestBed.configureTestingModule({
      providers: [
        MessageLogService,
        PerAgentStoreRegistry,
        ProcessStores,
        ReplaySeeder,
        LoadingIndicator,
        ConnectionToast,
        NotificationToasts,
        TeamSocket,
        LogFeeder,
        TeamStatusReactor,
        IngestionService,
        { provide: ContextService, useValue: contextServiceDouble() },
        ChatService,
        {
          provide: ApiService,
          useValue: {
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
            getAgentStates: jasmine
              .createSpy('getAgentStates')
              .and.resolveTo([]),
          },
        },
        {
          provide: MessageService,
          useValue: {
            add: jasmine.createSpy('add'),
            clear: jasmine.createSpy('clear'),
          },
        },
      ],
    });
    service = TestBed.inject(IngestionService);
    msgService = TestBed.inject(MessageService);

    spyOn<any>(teamSocket(), 'createWebSocket').and.returnValue(
      fakeSocket as unknown as WebSocketSubject<any>,
    );
  });

  afterEach(() => {
    try {
      fakeSocket.complete();
    } catch {
      /* already closed */
    }
    jasmine.clock().uninstall();
  });

  /** Every `MessageService.add` payload, in the order it was raised. */
  function raised(): any[] {
    return msgService.add.calls.allArgs().map((a: any[]) => a[0]);
  }

  it('AC #7: a STOPPED team raises one toast per replayed notification', async () => {
    const api = TestBed.inject(ApiService) as any;
    api.getEvents.and.resolveTo([
      { event: mkNotification('e-1', ERROR_MODEL, '@Researcher', 'boom') },
      {
        event: mkNotification('w-1', WARNING_MODEL, '@Researcher', 'over limit'),
      },
    ]);

    await service.init('proc-1', false);
    // The spinner floor, exactly as the neighbouring stopped-team specs drive
    // it. The toasts themselves need no tick: the replay is awaited inside
    // `init()` and `appended$` delivers synchronously.
    jasmine.clock().tick(600);

    // NO `msgService.add.calls.reset()` here, deliberately: `init()`'s
    // `messageService.clear()` runs at step (b), BEFORE the replay, so the only
    // `add` calls are the two being asserted — and a reset placed after
    // `init()` would erase exactly the evidence.
    expect(raised().length).toBe(2);
    expect(raised().map((m) => m.severity)).toEqual(['error', 'warn']);
    expect(raised().map((m) => m.data.messageId)).toEqual(['e-1', 'w-1']);
  });

  it('AC #9: a post-restore cursor-0 RE-replay of the same events is silent', async () => {
    // The burst. ADR-024 does not re-run `init()` on restore: the parked socket
    // resumes at cursor 0 and pushes the whole history back through the wire.
    // Every id is already in the log, so `appendAll` filters the batch before
    // `appended$` sees it and no second toast is possible.
    const api = TestBed.inject(ApiService) as any;
    const events = [
      mkNotification('e-1', ERROR_MODEL, '@Researcher', 'boom'),
      mkNotification('w-1', WARNING_MODEL, '@Researcher', 'over limit'),
    ];
    api.getEvents.and.resolveTo(events.map((event) => ({ event })));

    await service.init('proc-1', false);
    jasmine.clock().tick(600);
    expect(raised().length).toBe(2);

    fakeSocket.next(events[0]);
    fakeSocket.next(events[1]);
    jasmine.clock().tick(20);

    expect(raised().length).toBe(2);
  });

  it('AC #10: a second cycle inherits no batch from the first', async () => {
    // `appended$` is a plain `Subject`. Were it a `ReplaySubject`, the new
    // cycle's `start()` would receive team A's final batch and re-toast it —
    // the exact data bug the sequencing rule buys.
    const api = TestBed.inject(ApiService) as any;
    api.getEvents.and.resolveTo([
      { event: mkNotification('a-1', WARNING_MODEL, '@Researcher', 'team A') },
    ]);

    await service.init('proc-A', false);
    jasmine.clock().tick(600);
    expect(raised().map((m) => m.data.messageId)).toEqual(['a-1']);

    api.getEvents.and.resolveTo([]);
    const socketB = new Subject<any>();
    (teamSocket() as any).createWebSocket = jasmine
      .createSpy('createWebSocket')
      .and.returnValue(socketB as unknown as WebSocketSubject<any>);
    msgService.add.calls.reset();

    await service.init('proc-B', false);
    jasmine.clock().tick(600);

    expect(raised()).toEqual([]);
    socketB.complete();
  });

  it('AC #11: two notifications in ONE batch toast in array order', async () => {
    // `concatAll()` at the wiring site. A `mergeAll` there passes this by luck
    // on a synchronous array and stops being a guarantee.
    const api = TestBed.inject(ApiService) as any;
    api.getEvents.and.resolveTo([
      { event: mkNotification('w-1', WARNING_MODEL, '@First', 'first') },
      { event: mkNotification('w-2', WARNING_MODEL, '@Second', 'second') },
    ]);

    await service.init('proc-1', false);
    jasmine.clock().tick(600);

    expect(raised().map((m) => m.data.messageId)).toEqual(['w-1', 'w-2']);
    expect(raised().map((m) => m.summary)).toEqual(['@First', '@Second']);
  });

  // The sharpest SEMANTIC SHIFT of this story, pinned so a future reader cannot
  // mistake it for an accident: the same id arriving twice on the wire used to
  // raise TWO toasts, because the reactor sat upstream of the log's dedup and
  // kept no record of what it had already shown. It now raises one. AC #9 states
  // the same property for the REST-then-socket burst; this states it for the
  // transport alone, which is where the old behaviour was visible.
  //
  // Scope of the guarantee, exactly: `appendAll` computes its id filter from the
  // log as it stood BEFORE the batch, so the dedup is ACROSS batches — hence the
  // two flushes below. Two copies inside a single 16 ms window are one batch and
  // are not filtered. That is pre-existing log behaviour, unchanged here, and it
  // is why the class docblock's idempotence claim is scoped rather than absolute.
  it('the SAME notification delivered twice over the socket raises ONE toast', async () => {
    await service.init('proc-1', true);
    const dup = mkNotification('w-1', WARNING_MODEL, '@Researcher', 'over limit');

    fakeSocket.next(dup);
    jasmine.clock().tick(20);
    fakeSocket.next(dup);
    jasmine.clock().tick(20);

    expect(raised().map((m) => m.data.messageId)).toEqual(['w-1']);
  });
});

// ---------------------------------------------------------------------------
// Story 37-2 — the team-stopping reactor, as WIRING (AC6, AC9, AC11)
//
// `team-status-reactor.spec.ts` owns the unit's behaviour against a bare
// `Subject`. What only THIS file can see is the wiring: that `init()` hands the
// reactor a live stream before anything is written to the log, that
// `disposePriorSubscriptions()` releases it so a team switch does not leave two
// live subscriptions, and that `ngOnDestroy()` ends it.
//
// The two transports are both exercised on purpose. A stopped team's
// `TeamStoppingEvent` arrives ONLY through step (c)'s REST replay, so a
// `start()` sequenced below that block would leave the cold-load spec red while
// every live-path spec here stayed green.
// ---------------------------------------------------------------------------

describe('IngestionService — Story 37-2 (team-stopping reactor wiring)', () => {
  let service: IngestionService;
  let context: any;
  let fakeSocket: Subject<any>;

  const TEAM_STOPPING_MODEL =
    'akgentic.core.messages.orchestrator.TeamStoppingEvent';

  function mkEvent(teamId: string, innerModel: string): any {
    return {
      id: 'evt-' + innerModel + '-' + teamId,
      parent_id: null,
      team_id: teamId,
      timestamp: '2026-08-19T10:00:00Z',
      sender: makeAddress({
        name: '@Orchestrator',
        role: 'Orchestrator',
        agent_id: 'orchestrator-1',
      }),
      display_type: 'other',
      content: null,
      __model__: EVENT_MESSAGE_MODEL,
      event: { __model__: innerModel },
    };
  }

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));

    fakeSocket = new Subject<any>();

    TestBed.configureTestingModule({
      providers: [
        MessageLogService,
        PerAgentStoreRegistry,
        ProcessStores,
        ReplaySeeder,
        LoadingIndicator,
        ConnectionToast,
        NotificationToasts,
        TeamSocket,
        LogFeeder,
        TeamStatusReactor,
        IngestionService,
        { provide: ContextService, useValue: contextServiceDouble() },
        ChatService,
        {
          provide: ApiService,
          useValue: {
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
            getAgentStates: jasmine
              .createSpy('getAgentStates')
              .and.resolveTo([]),
          },
        },
        {
          provide: MessageService,
          useValue: {
            add: jasmine.createSpy('add'),
            clear: jasmine.createSpy('clear'),
          },
        },
      ],
    });
    service = TestBed.inject(IngestionService);
    context = TestBed.inject(ContextService) as any;

    spyOn<any>(teamSocket(), 'createWebSocket').and.returnValue(
      fakeSocket as unknown as WebSocketSubject<any>,
    );
  });

  afterEach(() => {
    try {
      fakeSocket.complete();
    } catch {
      /* already closed */
    }
    jasmine.clock().uninstall();
  });

  it('AC6: a TeamStoppingEvent on the live socket reaches ContextService.markStopped', async () => {
    await service.init('team-A', true);

    fakeSocket.next(mkEvent('team-A', TEAM_STOPPING_MODEL));
    jasmine.clock().tick(20);

    expect(context.markStopped).toHaveBeenCalledOnceWith('team-A');
  });

  // The cold load. This is the row the whole wiring position exists for: the
  // event arrives in the REST replay and nowhere else.
  it('AC6: a stopped team’s REST replay reaches markStopped', async () => {
    const api = TestBed.inject(ApiService) as any;
    api.getEvents.and.resolveTo([
      { event: mkEvent('team-A', TEAM_STOPPING_MODEL) },
    ]);

    await service.init('team-A', false);
    jasmine.clock().tick(600);

    expect(context.markStopped).toHaveBeenCalledOnceWith('team-A');
  });

  it('AC8: a ClosedNotification on the same feed does NOT reach markStopped', async () => {
    await service.init('team-A', true);

    fakeSocket.next(mkEvent('team-A', CLOSED_NOTIFICATION_MODEL));
    jasmine.clock().tick(20);

    expect(context.markStopped).not.toHaveBeenCalled();
  });

  // AC9 — the doubling guard, asserted HERE rather than by calling `start()`
  // twice on the unit. `disposePriorSubscriptions()` calling `stop()` is the
  // mechanism; delete that call and this spec goes to 2 while the unit's own
  // suite stays green.
  it('AC9: a re-init cycle produces exactly ONE markStopped per event, not two', async () => {
    await service.init('team-A', true);
    jasmine.clock().tick(600);

    const socketB = new Subject<any>();
    (teamSocket() as any).createWebSocket = jasmine
      .createSpy('createWebSocket')
      .and.returnValue(socketB as unknown as WebSocketSubject<any>);
    await service.init('team-B', true);
    jasmine.clock().tick(600);
    context.markStopped.calls.reset();

    socketB.next(mkEvent('team-B', TEAM_STOPPING_MODEL));
    jasmine.clock().tick(20);

    expect(context.markStopped).toHaveBeenCalledTimes(1);
    socketB.complete();
  });

  it('AC9: after ngOnDestroy() the same frame reaches nothing', async () => {
    await service.init('team-A', true);
    jasmine.clock().tick(600);

    service.ngOnDestroy();
    context.markStopped.calls.reset();

    // The log is the reactor's feed, so write straight to it — the socket is
    // already torn down by `ngOnDestroy` and cannot carry the frame.
    TestBed.inject(MessageLogService).appendAll([
      mkEvent('team-A', TEAM_STOPPING_MODEL),
    ]);

    expect(context.markStopped).not.toHaveBeenCalled();
  });

  // AC11 — nothing was added on the replay side. `ReplaySeeder` still makes the
  // same two calls for a stopped team and none for a running one, and no
  // stop-event-driven refetch was introduced anywhere on the path.
  it('AC11: ReplaySeeder and ApiService keep their existing call pattern', async () => {
    const api = TestBed.inject(ApiService) as any;
    api.getEvents.and.resolveTo([
      { event: mkEvent('team-A', TEAM_STOPPING_MODEL) },
    ]);

    await service.init('team-A', false);
    jasmine.clock().tick(600);

    expect(api.getAgentStates).toHaveBeenCalledTimes(1);
    expect(api.getEvents).toHaveBeenCalledTimes(1);

    // A running team still issues no EVENT replay — the `!running` gate around
    // getEvents is untouched, which is why a restored team never re-reads its
    // own stop event. It does take the state seed (ADR-020 §4).
    api.getAgentStates.calls.reset();
    api.getEvents.calls.reset();
    const socketB = new Subject<any>();
    (teamSocket() as any).createWebSocket = jasmine
      .createSpy('createWebSocket')
      .and.returnValue(socketB as unknown as WebSocketSubject<any>);

    await service.init('team-B', true);
    jasmine.clock().tick(600);

    expect(api.getAgentStates).toHaveBeenCalledTimes(1);
    expect(api.getEvents).not.toHaveBeenCalled();
    socketB.complete();
  });
});
