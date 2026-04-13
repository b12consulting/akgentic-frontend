import { TestBed } from '@angular/core/testing';
import { MessageService } from 'primeng/api';

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
