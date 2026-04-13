import { TestBed } from '@angular/core/testing';
import { MessageService } from 'primeng/api';
import { Subject } from 'rxjs';
import { WebSocketSubject } from 'rxjs/webSocket';

import { ActorMessageService } from './message.service';
import { ApiService } from './api.service';
import { ChatService } from './chat.service';
import { ActorAddress } from '../models/message.types';

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

function makeReceived(overrides: Partial<any> = {}): any {
  // Matches the Python contract: ReceivedMessage carries only `message_id`
  // (UUID of the inner message), NOT a nested `message: BaseMessage`.
  return {
    id: 'outer-1',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-12T10:00:00Z',
    sender: makeAddress(),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.ReceivedMessage',
    message_id: 'inner-1',
    ...overrides,
  };
}

function makeSent(overrides: Partial<any> = {}): any {
  return {
    id: 'outer-2',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-12T10:00:01Z',
    sender: makeAddress(),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.SentMessage',
    message: {
      id: 'inner-2',
      parent_id: null,
      team_id: 'team-1',
      timestamp: '2026-04-12T10:00:01Z',
      sender: makeAddress(),
      display_type: 'other',
      content: 'reply',
      __model__: 'akgentic.core.messages.orchestrator.SentMessage',
    },
    recipient: makeAddress({ name: '@Manager' }),
    ...overrides,
  };
}

function makeEventMessage(inner: any, overrides: Partial<any> = {}): any {
  return {
    id: 'outer-evt',
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-12T10:00:00Z',
    sender: makeAddress(),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.EventMessage',
    event: inner,
    ...overrides,
  };
}

describe('ActorMessageService.applyThinkingLifecycle + dispatch (Story 4-8)', () => {
  let service: ActorMessageService;
  let chatService: ChatService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ActorMessageService,
        ChatService,
        { provide: ApiService, useValue: {} },
        { provide: MessageService, useValue: { add: jasmine.createSpy('add') } },
      ],
    });
    service = TestBed.inject(ActorMessageService);
    chatService = TestBed.inject(ChatService);
  });

  describe('applyThinkingLifecycle', () => {
    it('ReceivedMessage -> beginThinking with expected payload', () => {
      const spy = spyOn(chatService, 'beginThinking').and.callThrough();
      const msg = makeReceived();
      (service as any).applyThinkingLifecycle(msg);
      expect(spy).toHaveBeenCalledWith({
        agent_id: 'agent-1',
        agent_name: '@Researcher',
        start_time: jasmine.any(Date),
        anchor_message_id: 'inner-1',
      });
    });

    it('SentMessage -> finaliseOrDiscard with sender agent_id', () => {
      const spy = spyOn(chatService, 'finaliseOrDiscard').and.callThrough();
      const msg = makeSent();
      (service as any).applyThinkingLifecycle(msg);
      expect(spy).toHaveBeenCalledWith('agent-1');
    });

    it('SentMessage from ActorSystem is filtered out', () => {
      const spy = spyOn(chatService, 'finaliseOrDiscard').and.callThrough();
      const msg = makeSent({
        sender: makeAddress({ role: 'ActorSystem' }),
      });
      (service as any).applyThinkingLifecycle(msg);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('dispatchToolEventToThinking', () => {
    it('ToolCallEvent -> appendToolCall with buildPreview(arguments, 60)', () => {
      chatService.beginThinking({
        agent_id: 'agent-1',
        agent_name: '@Researcher',
        start_time: new Date(),
        anchor_message_id: 'anchor-1',
      });
      const appendSpy = spyOn(chatService, 'appendToolCall').and.callThrough();
      const event = makeEventMessage({
        __model__: 'akgentic.llm.event.ToolCallEvent',
        run_id: 'run-1',
        tool_name: 'search_web',
        tool_call_id: 'call-1',
        arguments: '{"query": "competitor pricing enterprise tier"}',
      });
      (service as any).dispatchToolEventToThinking(event);
      expect(appendSpy).toHaveBeenCalledWith(
        'agent-1',
        jasmine.objectContaining({
          tool_call_id: 'call-1',
          tool_name: 'search_web',
          done: false,
        }),
      );
      // arguments_preview should be a non-empty, markdown-stripped string.
      const call = appendSpy.calls.mostRecent();
      const entry = call.args[1];
      expect(entry.arguments_preview.length).toBeGreaterThan(0);
    });

    it('ToolReturnEvent -> markToolDone with the tool_call_id', () => {
      const spy = spyOn(chatService, 'markToolDone').and.callThrough();
      const event = makeEventMessage({
        __model__: 'akgentic.llm.event.ToolReturnEvent',
        run_id: 'run-1',
        tool_name: 'search_web',
        tool_call_id: 'call-1',
        success: true,
      });
      (service as any).dispatchToolEventToThinking(event);
      expect(spy).toHaveBeenCalledWith('agent-1', 'call-1');
    });

    it('unknown inner __model__ is silently ignored (no throw, no dispatch)', () => {
      const appendSpy = spyOn(chatService, 'appendToolCall').and.callThrough();
      const markSpy = spyOn(chatService, 'markToolDone').and.callThrough();
      const event = makeEventMessage({
        __model__: 'akgentic.llm.event.LlmUsageEvent',
        tool_call_id: 'x',
      });
      expect(() =>
        (service as any).dispatchToolEventToThinking(event),
      ).not.toThrow();
      expect(appendSpy).not.toHaveBeenCalled();
      expect(markSpy).not.toHaveBeenCalled();
    });
  });

  describe('integration: ReceivedMessage → ToolCallEvent → ToolReturnEvent → SentMessage', () => {
    it('produces a finalised thinking state with one done tool entry', () => {
      (service as any).applyThinkingLifecycle(makeReceived());
      (service as any).dispatchToolEventToThinking(
        makeEventMessage({
          __model__: 'akgentic.llm.event.ToolCallEvent',
          tool_name: 'search_web',
          tool_call_id: 'call-1',
          arguments: '{"q": "x"}',
        }),
      );
      (service as any).dispatchToolEventToThinking(
        makeEventMessage({
          __model__: 'akgentic.llm.event.ToolReturnEvent',
          tool_name: 'search_web',
          tool_call_id: 'call-1',
          success: true,
        }),
      );
      (service as any).applyThinkingLifecycle(makeSent());

      const states = chatService.thinkingAgents$.value;
      expect(states.length).toBe(1);
      expect(states[0].final).toBe(true);
      expect(states[0].tools.length).toBe(1);
      expect(states[0].tools[0].done).toBe(true);
    });

    it('ReceivedMessage without tools then SentMessage -> ephemeral removal', () => {
      (service as any).applyThinkingLifecycle(makeReceived());
      expect(chatService.thinkingAgents$.value.length).toBe(1);
      (service as any).applyThinkingLifecycle(makeSent());
      expect(chatService.thinkingAgents$.value.length).toBe(0);
    });
  });
});

describe('ActorMessageService.init — loadingProcess$ spinner window (Story 4-10)', () => {
  let service: ActorMessageService;
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
        ActorMessageService,
        ChatService,
        {
          provide: ApiService,
          useValue: {
            // Only used by the `!running` branch; default empty list is fine.
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
          },
        },
        { provide: MessageService, useValue: { add: jasmine.createSpy('add') } },
      ],
    });
    service = TestBed.inject(ActorMessageService);
    chatService = TestBed.inject(ChatService);

    // Stub the service's protected WS factory so init() wires the
    // subscription up to our Subject instead of opening a real TCP
    // connection. Cast through unknown to satisfy the WebSocketSubject<any>
    // return type expected by init().
    spyOn<any>(service, 'createWebSocket').and.returnValue(
      fakeSocket as unknown as WebSocketSubject<any>,
    );
  });

  afterEach(() => {
    // Avoid cross-test leakage of the fake socket.
    fakeSocket.complete();
    jasmine.clock().uninstall();
  });

  it('AC1: running=true keeps loadingProcess$ true until the first WS event arrives', async () => {
    await service.init('proc-1', true);

    // Socket is open but no events yet → spinner MUST stay on.
    expect(chatService.loadingProcess$.value).toBe(true);
  });

  it('AC1: loadingProcess$ flips to false on the first WS event (past the 500ms floor)', async () => {
    await service.init('proc-1', true);
    expect(chatService.loadingProcess$.value).toBe(true);

    // Advance past the SPINNER_MIN_VISIBLE_MS floor so the first-event flip
    // fires immediately (AC7 immediate-flip branch).
    jasmine.clock().tick(600);

    // First event over the wire — shape intentionally uninteresting, the
    // flip MUST happen before any per-__model__ branching.
    fakeSocket.next({
      __model__: 'akgentic.core.messages.orchestrator.StartMessage',
    });

    expect(chatService.loadingProcess$.value).toBe(false);
  });

  it('AC1: subsequent events do not re-emit false (guard is single-shot)', async () => {
    await service.init('proc-1', true);
    const emitted: boolean[] = [];
    chatService.loadingProcess$.subscribe((v) => emitted.push(v));
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
    expect(chatService.loadingProcess$.value).toBe(true);

    jasmine.clock().tick(600);
    fakeSocket.error(new Error('connect refused'));

    expect(chatService.loadingProcess$.value).toBe(false);
  });

  it('AC2: running=false (stopped team) flips loadingProcess$ to false before WS wiring', async () => {
    // Record the sequence of `loadingProcess$` values as init() runs so we
    // can assert the spinner is OFF before any WS events are delivered.
    // Note: createWebSocket is called BEFORE subscribe(), so by the time the
    // spy-stubbed factory returns, the stopped-team branch has already flipped
    // the flag to `false`. Subscribing to track values after await captures
    // the current BehaviorSubject state without needing to push any events.
    const emitted: boolean[] = [];
    const sub = chatService.loadingProcess$.subscribe((v) => emitted.push(v));

    await service.init('proc-1', false);
    // Drive the 500ms floor so the deferred flip can actually fire.
    jasmine.clock().tick(600);

    // No WS events pushed → stopped-team path MUST have already flipped it,
    // AND the sequence must include at least one `true` (spinner on during
    // getEvents()) followed by `false` (before WS wiring).
    expect(chatService.loadingProcess$.value).toBe(false);
    expect(emitted).toContain(true);
    expect(emitted[emitted.length - 1]).toBe(false);

    sub.unsubscribe();
  });

  // ---------------------------------------------------------------------
  // AC8 — Minimum visible spinner duration (500ms floor)
  // ---------------------------------------------------------------------

  it('AC8: first event at 100ms → flag still true at 400ms → false at 500ms (deferred flip)', async () => {
    await service.init('proc-1', true);
    expect(chatService.loadingProcess$.value).toBe(true);

    // First event arrives at 100ms — well before the 500ms floor.
    jasmine.clock().tick(100);
    fakeSocket.next({ __model__: 'StartMessage' });

    // At 400ms total, the deferred timer has NOT fired yet.
    jasmine.clock().tick(300);
    expect(chatService.loadingProcess$.value).toBe(true);

    // Crossing the 500ms floor triggers the pending setTimeout.
    jasmine.clock().tick(100);
    expect(chatService.loadingProcess$.value).toBe(false);
  });

  it('AC8: first event at 800ms → flag becomes false immediately (past floor, no extra delay)', async () => {
    await service.init('proc-1', true);
    expect(chatService.loadingProcess$.value).toBe(true);

    // First event well past the 500ms floor — flip must be immediate.
    jasmine.clock().tick(800);
    fakeSocket.next({ __model__: 'StartMessage' });

    // No further tick needed: immediate branch of scheduleSpinnerFlipFalse.
    expect(chatService.loadingProcess$.value).toBe(false);
  });

  it('AC8: WS error at 100ms → flag still true at 400ms → false at 500ms (failure path respects floor)', async () => {
    await service.init('proc-1', true);
    expect(chatService.loadingProcess$.value).toBe(true);

    jasmine.clock().tick(100);
    fakeSocket.error(new Error('connect refused'));

    jasmine.clock().tick(300);
    expect(chatService.loadingProcess$.value).toBe(true);

    jasmine.clock().tick(100);
    expect(chatService.loadingProcess$.value).toBe(false);
  });

  it('AC8: re-init while a deferred flip is pending cancels the pending timer (no late false clobber)', async () => {
    await service.init('proc-1', true);
    expect(chatService.loadingProcess$.value).toBe(true);

    // Schedule a deferred flip for t=500ms via an early first event.
    jasmine.clock().tick(100);
    fakeSocket.next({ __model__: 'StartMessage' });
    // Pending timer exists; flag still true.
    expect(chatService.loadingProcess$.value).toBe(true);

    // Re-init (team switch) before the pending timer fires — swap in a new
    // fake socket so the fresh init() has something to subscribe to.
    const secondSocket = new Subject<any>();
    (service as any).createWebSocket = jasmine
      .createSpy('createWebSocket')
      .and.returnValue(secondSocket as unknown as WebSocketSubject<any>);
    await service.init('proc-2', true);

    // Fresh cycle: flag is back to true.
    expect(chatService.loadingProcess$.value).toBe(true);

    // Advance past the ORIGINAL scheduled time (t=500ms from first init).
    // If the pending timer had not been cancelled, it would fire here and
    // clobber the fresh spinner cycle with a stale `false`.
    jasmine.clock().tick(500);
    expect(chatService.loadingProcess$.value).toBe(true);

    secondSocket.complete();
  });
});
