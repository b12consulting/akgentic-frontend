import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { BehaviorSubject, of } from 'rxjs';
import { map } from 'rxjs/operators';
import { provideMarkdown } from 'ngx-markdown';

import { ChatPanelComponent } from './chat-panel.component';
import { ChatService, computePendingNotifications } from '../services/chat.service';
import { ActorMessageService } from '../services/message.service';
import { SelectionService } from '../services/selection.service';
import { ActorAddress, SentMessage, BaseMessage, AkgenticMessage, StartMessage } from '../models/message.types';
import { ChatMessage } from '../models/chat-message.model';
import { ApiService } from '../services/api.service';
import { AkgentService } from '../services/akgent.service';
import { GraphDataService } from '../services/graph-data.service';

function makeAddress(overrides: Partial<ActorAddress> = {}): ActorAddress {
  return {
    __actor_address__: true,
    address: 'addr',
    name: '@Agent',
    role: 'Worker',
    agent_id: 'agent-1',
    squad_id: 'squad-1',
    user_message: false,
    ...overrides,
  };
}

function makeSentMessage(
  sender: Partial<ActorAddress>,
  recipient: Partial<ActorAddress>,
  content: string = 'test',
  id: string = 'msg-1',
): SentMessage {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-08T10:00:00Z',
    sender: makeAddress(sender),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.SentMessage',
    message: {
      id: 'inner-1',
      parent_id: null,
      team_id: 'team-1',
      timestamp: '2026-04-08T10:00:00Z',
      sender: makeAddress(sender),
      display_type: 'other',
      content,
      __model__: 'akgentic.core.messages.orchestrator.SentMessage',
    },
    recipient: makeAddress(recipient),
  };
}

describe('ChatPanelComponent', () => {
  let component: ChatPanelComponent;
  let fixture: ComponentFixture<ChatPanelComponent>;
  let messagesSubject: BehaviorSubject<AkgenticMessage[]>;

  beforeEach(async () => {
    messagesSubject = new BehaviorSubject<AkgenticMessage[]>([]);

    const messagesSubj = new BehaviorSubject<any[]>([]);
    const chatService = {
      messages$: messagesSubj,
      loadingProcess$: new BehaviorSubject<boolean>(false),
      replyContext$: new BehaviorSubject<any>(null),
      pendingNotifications$: messagesSubj.pipe(map(computePendingNotifications)),
      setReplyContext: jasmine.createSpy('setReplyContext').and.callFake(
        function(this: any, msg: any) { this.replyContext$.next(msg); }
      ),
      clearReplyContext: jasmine.createSpy('clearReplyContext').and.callFake(
        function(this: any) { this.replyContext$.next(null); }
      ),
    };

    const messageService = {
      messages$: messagesSubject.asObservable(),
    };

    const selectionService = jasmine.createSpyObj('SelectionService', [
      'handleSelection',
    ]);

    const apiService = jasmine.createSpyObj('ApiService', ['sendMessage', 'processHumanInput']);
    apiService.sendMessage.and.returnValue(Promise.resolve());
    apiService.processHumanInput.and.returnValue(Promise.resolve());

    const akgentService = {
      selectedAkgent$: new BehaviorSubject<any>(null),
    };

    const graphDataService = {
      nodes$: of([]),
    };

    await TestBed.configureTestingModule({
      imports: [ChatPanelComponent, NoopAnimationsModule],
      providers: [
        provideMarkdown(),
        { provide: ChatService, useValue: chatService },
        { provide: ActorMessageService, useValue: messageService },
        { provide: SelectionService, useValue: selectionService },
        { provide: ApiService, useValue: apiService },
        { provide: AkgentService, useValue: akgentService },
        { provide: GraphDataService, useValue: graphDataService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatPanelComponent);
    component = fixture.componentInstance;
    component.processId = 'test-team';
    component.loading$ = new BehaviorSubject<boolean>(false);
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should classify messages from messageService.messages$', () => {
    const sent = makeSentMessage(
      { name: '@Human', role: 'Human' },
      { name: '@Manager', role: 'Manager' },
      'hello',
    );
    messagesSubject.next([sent]);
    fixture.detectChanges();

    expect(component.chatMessages.length).toBe(1);
    expect(component.chatMessages[0].rule).toBe(1);
    expect(component.chatMessages[0].alignment).toBe('right');
  });

  it('should filter out ActorSystem messages', () => {
    const systemMsg = makeSentMessage(
      { name: '@System', role: 'ActorSystem' },
      { name: '@Manager', role: 'Manager' },
      'system msg',
    );
    messagesSubject.next([systemMsg]);
    fixture.detectChanges();

    expect(component.chatMessages.length).toBe(0);
  });

  it('should filter out messages with empty content', () => {
    const emptyMsg = makeSentMessage(
      { name: '@Human', role: 'Human' },
      { name: '@Manager', role: 'Manager' },
      '',
    );
    messagesSubject.next([emptyMsg]);
    fixture.detectChanges();

    expect(component.chatMessages.length).toBe(0);
  });

  it('should filter out non-SentMessage types', () => {
    const startMsg: StartMessage = {
      id: 'start-1',
      parent_id: null,
      team_id: 'team-1',
      timestamp: '2026-04-08T10:00:00Z',
      sender: makeAddress(),
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.StartMessage',
      config: {} as any,
      parent: makeAddress(),
    };
    messagesSubject.next([startMsg]);
    fixture.detectChanges();

    expect(component.chatMessages.length).toBe(0);
  });

  it('should handle multiple messages with different rules', () => {
    const msg1 = makeSentMessage(
      { name: '@Human', role: 'Human' },
      { name: '@Manager', role: 'Manager' },
      'from human',
      'msg-1',
    );
    const msg2 = makeSentMessage(
      { name: '@Manager', role: 'Manager' },
      { name: '@Human', role: 'Human' },
      'reply to human',
      'msg-2',
    );
    const msg3 = makeSentMessage(
      { name: '@Worker', role: 'Worker' },
      { name: '@Manager', role: 'Manager' },
      'ai to ai',
      'msg-3',
    );
    messagesSubject.next([msg1, msg2, msg3]);
    fixture.detectChanges();

    expect(component.chatMessages.length).toBe(3);
    expect(component.chatMessages[0].rule).toBe(1);
    expect(component.chatMessages[1].rule).toBe(2);
    expect(component.chatMessages[2].rule).toBe(4);
  });

  it('onMessageSelected should call selectionService.handleSelection', () => {
    const chatMsg: ChatMessage = {
      id: 'msg-1',
      content: 'test',
      sender: makeAddress({ name: '@Manager', agent_id: 'mgr-1' }),
      recipient: makeAddress({ name: '@Human' }),
      timestamp: new Date(),
      rule: 2,
      alignment: 'left',
      color: '#9ebbcb',
      collapsed: false,
      label: 'Manager',
    };
    component.onMessageSelected(chatMsg);
    const selSvc = TestBed.inject(SelectionService);
    expect(selSvc.handleSelection).toHaveBeenCalledWith({
      type: 'message',
      data: {
        name: 'mgr-1',
        actorName: '@Manager',
      },
    });
  });

  it('trackById should return message id', () => {
    const chatMsg = { id: 'abc-123' } as ChatMessage;
    expect(component.trackById(0, chatMsg)).toBe('abc-123');
  });

  it('should push classified messages to chatService.messages$', () => {
    const chatService = TestBed.inject(ChatService);
    const sent = makeSentMessage(
      { name: '@Human', role: 'Human' },
      { name: '@Manager', role: 'Manager' },
      'hello',
    );
    messagesSubject.next([sent]);
    fixture.detectChanges();

    expect(chatService.messages$.value.length).toBe(1);
    expect(chatService.messages$.value[0].rule).toBe(1);
  });

  describe('reply context (bubble selection)', () => {
    it('onBubbleClicked should call chatService.setReplyContext', () => {
      const chatMsg: ChatMessage = {
        id: 'msg-reply',
        content: 'test',
        sender: makeAddress({ name: '@Manager', agent_id: 'mgr-1' }),
        recipient: makeAddress({ name: '@Human' }),
        timestamp: new Date(),
        rule: 2,
        alignment: 'left',
        color: '#9ebbcb',
        collapsed: false,
        label: 'Manager',
      };
      component.onBubbleClicked(chatMsg);
      const svc = TestBed.inject(ChatService) as any;
      expect(svc.setReplyContext).toHaveBeenCalledWith(chatMsg);
    });

    it('onBackgroundClick should call chatService.clearReplyContext', () => {
      component.onBackgroundClick();
      const svc = TestBed.inject(ChatService) as any;
      expect(svc.clearReplyContext).toHaveBeenCalled();
    });

    it('onEscapePress should call chatService.clearReplyContext', () => {
      component.onEscapePress();
      const svc = TestBed.inject(ChatService) as any;
      expect(svc.clearReplyContext).toHaveBeenCalled();
    });

    it('selectedMessageId should track replyContext$ value', () => {
      const svc = TestBed.inject(ChatService) as any;
      expect(component.selectedMessageId).toBeNull();

      svc.replyContext$.next({
        id: 'msg-selected',
        content: 'test',
        sender: makeAddress({ name: '@Manager' }),
        recipient: makeAddress({ name: '@Human' }),
        timestamp: new Date(),
        rule: 2,
        alignment: 'left',
        color: '#9ebbcb',
        collapsed: false,
        label: 'Manager',
      });
      fixture.detectChanges();

      expect(component.selectedMessageId).toBe('msg-selected');

      svc.replyContext$.next(null);
      fixture.detectChanges();
      expect(component.selectedMessageId).toBeNull();
    });

    it('clicking different bubble should switch reply context', () => {
      const msg1: ChatMessage = {
        id: 'msg-1',
        content: 'first',
        sender: makeAddress({ name: '@Agent1' }),
        recipient: makeAddress({ name: '@Human' }),
        timestamp: new Date(),
        rule: 2,
        alignment: 'left',
        color: '#9ebbcb',
        collapsed: false,
        label: 'Agent1',
      };
      const msg2: ChatMessage = {
        id: 'msg-2',
        content: 'second',
        sender: makeAddress({ name: '@Agent2' }),
        recipient: makeAddress({ name: '@Human' }),
        timestamp: new Date(),
        rule: 2,
        alignment: 'left',
        color: '#9ebbcb',
        collapsed: false,
        label: 'Agent2',
      };

      component.onBubbleClicked(msg1);
      expect(component.selectedMessageId).toBe('msg-1');

      component.onBubbleClicked(msg2);
      expect(component.selectedMessageId).toBe('msg-2');
    });

    it('onRule3Clicked should open modal with pending messages', () => {
      // Set up a Rule 3 message
      const rule3Msg = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'need approval',
        'r3-modal',
      );
      messagesSubject.next([rule3Msg]);
      fixture.detectChanges();

      const chatMsg = component.chatMessages[0];
      expect(chatMsg.rule).toBe(3);

      component.onRule3Clicked(chatMsg);

      expect(component.modalVisible).toBe(true);
      expect(component.modalAgentPair?.sender.name).toBe('@Manager');
      expect(component.modalAgentPair?.recipient.name).toBe('@QATester');
      expect(component.modalPendingMessages.length).toBe(1);
    });

    it('onRule3Clicked should not open modal when no pending notifications', () => {
      // A Rule 3 message that has been replied to
      const rule3Msg = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'need approval',
        'r3-1',
      );
      const replyMsg = makeSentMessage(
        { name: '@QATester', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'approved',
        'reply-1',
      );
      messagesSubject.next([rule3Msg, replyMsg]);
      fixture.detectChanges();

      const chatMsg = component.chatMessages.find(m => m.id === 'r3-1')!;
      component.onRule3Clicked(chatMsg);

      expect(component.modalVisible).toBe(false);
    });

    it('onModalReply should call processHumanInput, close modal, and clear state', () => {
      component.processId = 'team-42';
      component.modalVisible = true;
      component.modalAgentPair = {
        sender: makeAddress({ name: '@Manager' }),
        recipient: makeAddress({ name: '@QATester' }),
      };
      const dummyMsg: ChatMessage = {
        id: 'msg-123', content: 'test', sender: makeAddress({ name: '@Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
        timestamp: new Date(), rule: 3, alignment: 'left', color: '#9ebbcb',
        collapsed: false, label: 'Manager ⇒ QATester',
      };
      component.modalPendingMessages = [dummyMsg];

      component.onModalReply({ content: 'approved', messageId: 'msg-123' });

      const api = TestBed.inject(ApiService) as any;
      expect(api.processHumanInput).toHaveBeenCalledWith('team-42', 'approved', 'msg-123');
      expect(component.modalVisible).toBe(false);
      expect(component.modalAgentPair).toBeNull();
      expect(component.modalPendingMessages).toEqual([]);
    });

    it('onModalVisibleChange should update modalVisible and clear state when closed', () => {
      component.modalVisible = true;
      component.modalAgentPair = {
        sender: makeAddress({ name: '@Manager' }),
        recipient: makeAddress({ name: '@QATester' }),
      };
      const dummyMsg: ChatMessage = {
        id: 'msg-1', content: 'test', sender: makeAddress({ name: '@Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
        timestamp: new Date(), rule: 3, alignment: 'left', color: '#9ebbcb',
        collapsed: false, label: 'Manager ⇒ QATester',
      };
      component.modalPendingMessages = [dummyMsg];
      component.onModalVisibleChange(false);
      expect(component.modalVisible).toBe(false);
      expect(component.modalAgentPair).toBeNull();
      expect(component.modalPendingMessages).toEqual([]);
    });
  });

  describe('notification wiring (Task 2)', () => {
    it('hasNotification should return true for Rule 3 messages with pending notifications', () => {
      const rule3Msg = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'need approval',
        'r3-1',
      );
      messagesSubject.next([rule3Msg]);
      fixture.detectChanges();

      const chatMsg = component.chatMessages[0];
      expect(chatMsg.rule).toBe(3);
      expect(component.hasNotification(chatMsg)).toBe(true);
    });

    it('hasNotification should return false for Rule 3 messages after reply clears notification', () => {
      const rule3Msg = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'need approval',
        'r3-1',
      );
      const replyMsg = makeSentMessage(
        { name: '@QATester', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'approved',
        'reply-1',
      );
      messagesSubject.next([rule3Msg, replyMsg]);
      fixture.detectChanges();

      const chatMsgR3 = component.chatMessages.find(m => m.id === 'r3-1')!;
      expect(component.hasNotification(chatMsgR3)).toBe(false);
    });

    it('hasNotification should return false for non-Rule-3 messages', () => {
      const msg = makeSentMessage(
        { name: '@Human', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'hello',
      );
      messagesSubject.next([msg]);
      fixture.detectChanges();

      expect(component.chatMessages[0].rule).toBe(1);
      expect(component.hasNotification(component.chatMessages[0])).toBe(false);
    });
  });

  describe('notification clears on reply (Task 5)', () => {
    it('notification disappears when reply message arrives via messages$', () => {
      // 1. Rule 3 message pending
      const rule3Msg = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'need approval',
        'r3-clear-1',
      );
      messagesSubject.next([rule3Msg]);
      fixture.detectChanges();

      const chatMsg = component.chatMessages[0];
      expect(component.hasNotification(chatMsg)).toBe(true);

      // 2. Reply arrives (simulating WebSocket message)
      const replyMsg = makeSentMessage(
        { name: '@QATester', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'approved',
        'reply-clear-1',
      );
      messagesSubject.next([rule3Msg, replyMsg]);
      fixture.detectChanges();

      // 3. Notification should be gone
      const chatMsgAfter = component.chatMessages.find(m => m.id === 'r3-clear-1')!;
      expect(component.hasNotification(chatMsgAfter)).toBe(false);
    });

    it('notification reappears if sender sends again after reply', () => {
      const rule3First = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'first request',
        'r3-reappear-1',
      );
      const reply = makeSentMessage(
        { name: '@QATester', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'done',
        'reply-reappear-1',
      );
      const rule3Second = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'second request',
        'r3-reappear-2',
      );
      messagesSubject.next([rule3First, reply, rule3Second]);
      fixture.detectChanges();

      const secondMsg = component.chatMessages.find(m => m.id === 'r3-reappear-2')!;
      expect(component.hasNotification(secondMsg)).toBe(true);
    });
  });

  describe('Rule 3 collapse (Story 4.1)', () => {
    it('Rule 3 messages arrive collapsed by default', () => {
      const rule3 = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'need approval',
        'r3-collapsed',
      );
      messagesSubject.next([rule3]);
      fixture.detectChanges();

      expect(component.chatMessages[0].rule).toBe(3);
      expect(component.chatMessages[0].collapsed).toBe(true);
    });

    it('onToggleCollapse on Rule 3 toggles state and preserves across re-emission', () => {
      const rule3 = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'need approval',
        'r3-preserve',
      );
      messagesSubject.next([rule3]);
      fixture.detectChanges();

      expect(component.chatMessages[0].collapsed).toBe(true);

      component.onToggleCollapse(component.chatMessages[0]);
      expect(component.chatMessages[0].collapsed).toBe(false);

      // Re-emit messages — Rule 3 expanded state should be preserved
      messagesSubject.next([rule3]);
      fixture.detectChanges();

      expect(component.chatMessages[0].rule).toBe(3);
      expect(component.chatMessages[0].collapsed).toBe(false);
    });

    it('onToggleCollapse should ignore non Rule-3/4 messages', () => {
      const msg: ChatMessage = {
        id: 'r1',
        content: 'x',
        sender: makeAddress({ name: '@Human' }),
        recipient: makeAddress({ name: '@Manager' }),
        timestamp: new Date(),
        rule: 1,
        alignment: 'right',
        color: '#efeeee',
        collapsed: false,
        label: 'You ⇒ Manager',
      };
      component.onToggleCollapse(msg);
      expect(msg.collapsed).toBe(false);
    });

    it('Open button click path: onRule3Clicked still opens modal (regression)', () => {
      const rule3Msg = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'need approval',
        'r3-open',
      );
      messagesSubject.next([rule3Msg]);
      fixture.detectChanges();

      const chatMsg = component.chatMessages[0];
      component.onRule3Clicked(chatMsg);

      expect(component.modalVisible).toBe(true);
      component.onModalReply({ content: 'ok', messageId: chatMsg.id });
      const api = TestBed.inject(ApiService) as any;
      expect(api.processHumanInput).toHaveBeenCalledWith('test-team', 'ok', chatMsg.id);
    });
  });

  it('onToggleCollapse should toggle collapsed state and preserve across re-classification', () => {
    const msg4 = makeSentMessage(
      { name: '@Worker', role: 'Worker' },
      { name: '@Manager', role: 'Manager' },
      'ai msg',
      'msg-r4',
    );
    messagesSubject.next([msg4]);
    fixture.detectChanges();

    expect(component.chatMessages[0].collapsed).toBe(true);

    // Expand it
    component.onToggleCollapse(component.chatMessages[0]);
    expect(component.chatMessages[0].collapsed).toBe(false);

    // Re-emit messages (simulating new message arrival)
    messagesSubject.next([msg4]);
    fixture.detectChanges();

    // Collapsed state should be preserved
    expect(component.chatMessages[0].collapsed).toBe(false);
  });
});
