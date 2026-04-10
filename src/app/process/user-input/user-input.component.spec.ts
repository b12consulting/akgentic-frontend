import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { BehaviorSubject, of, Subject } from 'rxjs';

import { ProcessUserInputComponent } from './user-input.component';
import { ApiService } from '../../services/api.service';
import { ChatService } from '../../services/chat.service';
import { GraphDataService } from '../../services/graph-data.service';
import { ActorMessageService } from '../../services/message.service';
import { ChatMessage } from '../../models/chat-message.model';
import { ActorAddress } from '../../models/message.types';

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

function makeChatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    content: 'Hello world',
    sender: makeAddress({ name: '@Manager', role: 'Manager' }),
    recipient: makeAddress({ name: '@Human', role: 'Human' }),
    timestamp: new Date('2026-04-08T10:00:00Z'),
    rule: 2,
    alignment: 'left',
    color: '#9ebbcb',
    collapsed: false,
    label: 'Manager [Manager]',
    ...overrides,
  };
}

function makeNode(overrides: any = {}): any {
  return {
    name: 'node-1',
    actorName: '@Agent',
    parentId: null,
    userMessage: true,
    ...overrides,
  };
}

describe('ProcessUserInputComponent', () => {
  let component: ProcessUserInputComponent;
  let fixture: ComponentFixture<ProcessUserInputComponent>;
  let apiServiceSpy: jasmine.SpyObj<ApiService>;
  let chatServiceMock: any;
  let nodesSubject: Subject<any[]>;

  beforeEach(async () => {
    apiServiceSpy = jasmine.createSpyObj('ApiService', [
      'sendMessage',
    ]);
    apiServiceSpy.sendMessage.and.returnValue(Promise.resolve());

    chatServiceMock = {
      messages$: new BehaviorSubject<any[]>([]),
      loadingProcess$: new BehaviorSubject<boolean>(false),
      replyContext$: new BehaviorSubject<ChatMessage | null>(null),
      setReplyContext: jasmine.createSpy('setReplyContext').and.callFake(
        function(this: any, msg: any) { this.replyContext$.next(msg); }
      ),
      clearReplyContext: jasmine.createSpy('clearReplyContext').and.callFake(
        function(this: any) { this.replyContext$.next(null); }
      ),
    };

    nodesSubject = new Subject<any[]>();

    const graphDataService = {
      nodes$: nodesSubject.asObservable(),
    };

    const messageService = {
      messages$: of([]),
      pauseClicked: () => {},
      playClicked: () => {},
      backClicked: () => {},
      backwardClicked: () => {},
      nextClicked: () => {},
      forwardClicked: () => {},
      controlStatus: () => [0, 0],
    };

    await TestBed.configureTestingModule({
      imports: [FormsModule, ProcessUserInputComponent],
      providers: [
        { provide: ApiService, useValue: apiServiceSpy },
        { provide: ChatService, useValue: chatServiceMock },
        { provide: GraphDataService, useValue: graphDataService },
        { provide: ActorMessageService, useValue: messageService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ProcessUserInputComponent);
    component = fixture.componentInstance;
    component.processId = 'test-team-id';
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('dropdown population (AC #2, #8)', () => {
    it('should populate dropdownAgents from nodes, filtering @-prefixed and excluding @Human', () => {
      nodesSubject.next([
        makeNode({ name: 'n1', actorName: '@Manager', userMessage: true }),
        makeNode({ name: 'n2', actorName: '@Expert', userMessage: true }),
        makeNode({ name: 'n3', actorName: '@Human', userMessage: false }),
        makeNode({ name: 'n4', actorName: 'InternalAgent', userMessage: false }),
      ]);

      expect(component.dropdownAgents.length).toBe(2);
      expect(component.dropdownAgents.map(d => d.value)).toEqual(['@Manager', '@Expert']);
      // Labels should be user-friendly (formatted via makeAgentNameUserFriendly)
      expect(component.dropdownAgents[0].label).toBeTruthy();
      expect(component.dropdownAgents[1].label).toBeTruthy();
    });

    it('should continue populating mentionItems alongside dropdownAgents', () => {
      nodesSubject.next([
        makeNode({ name: 'n1', actorName: '@Manager', userMessage: true }),
        makeNode({ name: 'n2', actorName: '@Expert', userMessage: true }),
      ]);

      // mentionItems populated for angular-mentions autocomplete
      expect(component.mentionItems.length).toBeGreaterThan(0);
      // dropdownAgents populated for multi-select
      expect(component.dropdownAgents.length).toBe(2);
    });
  });

  describe('fired agent pruning (AC #3)', () => {
    it('should remove fired agent from selectedAgents when nodes update', () => {
      // Initial nodes with 2 agents
      nodesSubject.next([
        makeNode({ name: 'n1', actorName: '@Manager', userMessage: true }),
        makeNode({ name: 'n2', actorName: '@Expert', userMessage: true }),
      ]);

      // User selects both agents
      component.selectedAgents = ['@Manager', '@Expert'];

      // Expert gets fired -- new nodes without Expert
      nodesSubject.next([
        makeNode({ name: 'n1', actorName: '@Manager', userMessage: true }),
      ]);

      expect(component.selectedAgents).toEqual(['@Manager']);
    });
  });

  describe('sendMessage()', () => {
    it('should not send when input is empty', async () => {
      component.userInput = '';
      await component.sendMessage();
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
    });

    it('should not send when input is whitespace only', async () => {
      component.userInput = '   ';
      await component.sendMessage();
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
    });

    it('should broadcast when no agents selected (AC #4)', async () => {
      component.userInput = 'hello everyone';
      component.selectedAgents = [];

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'hello everyone',
      );
    });

    it('should send to single selected agent (AC #5)', async () => {
      component.userInput = 'hello expert';
      component.selectedAgents = ['@Expert'];

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'hello expert',
        '@Expert',
      );
    });

    it('should send to each selected agent when multiple selected (AC #5)', async () => {
      component.userInput = 'hello team';
      component.selectedAgents = ['@Expert', '@Assistant'];

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledTimes(2);
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledWith(
        'test-team-id',
        'hello team',
        '@Expert',
      );
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledWith(
        'test-team-id',
        'hello team',
        '@Assistant',
      );
    });

    it('should persist selectedAgents across multiple sendMessage calls (AC #5)', async () => {
      component.userInput = 'first message';
      component.selectedAgents = ['@Expert'];
      await component.sendMessage();

      expect(component.selectedAgents).toEqual(['@Expert']);

      apiServiceSpy.sendMessage.calls.reset();
      component.userInput = 'second message';
      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'second message',
        '@Expert',
      );
    });

    it('should clear userInput after sending', async () => {
      component.userInput = 'will be cleared';
      component.selectedAgents = [];
      await component.sendMessage();
      expect(component.userInput).toBe('');
    });

    it('@mention text in userInput should NOT affect API call target (AC #7)', async () => {
      component.mentionItems = [
        { name: 'Manager [Manager]', actorName: '@Manager', agentId: 'mgr-1' },
      ];
      component.userInput = 'hey Manager [Manager] do this';
      component.selectedAgents = [];

      await component.sendMessage();

      // Should broadcast, NOT route to @Manager via text matching
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'hey Manager [Manager] do this',
      );
    });
  });

  describe('reply context (AC #6)', () => {
    it('should show reply context display name when replyContext is set', () => {
      const msg = makeChatMessage({
        sender: makeAddress({ name: '@Manager-Manager_agent' }),
      });
      chatServiceMock.replyContext$.next(msg);
      fixture.detectChanges();

      expect(component.replyContext).toBe(msg);
      expect(component.replyContextDisplayName).toBeTruthy();
    });

    it('should clear display name when replyContext is null', () => {
      chatServiceMock.replyContext$.next(null);
      fixture.detectChanges();

      expect(component.replyContext).toBeNull();
      expect(component.replyContextDisplayName).toBe('');
    });

    it('should show reply indicator in template when replyContext is set', () => {
      const msg = makeChatMessage();
      chatServiceMock.replyContext$.next(msg);
      fixture.detectChanges();

      const indicator = fixture.nativeElement.querySelector('.reply-indicator');
      expect(indicator).toBeTruthy();
    });

    it('should NOT show reply indicator when replyContext is null', () => {
      chatServiceMock.replyContext$.next(null);
      fixture.detectChanges();

      const indicator = fixture.nativeElement.querySelector('.reply-indicator');
      expect(indicator).toBeNull();
    });

    it('should send to reply context sender when replyContext is active', async () => {
      const msg = makeChatMessage({
        sender: makeAddress({ name: '@Manager' }),
      });
      chatServiceMock.replyContext$.next(msg);
      fixture.detectChanges();

      component.userInput = 'reply message';
      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'reply message',
        '@Manager',
      );
    });

    it('should clear reply context after sending with reply context', async () => {
      const msg = makeChatMessage({
        sender: makeAddress({ name: '@Manager' }),
      });
      chatServiceMock.replyContext$.next(msg);
      fixture.detectChanges();

      component.userInput = 'reply message';
      await component.sendMessage();

      expect(chatServiceMock.clearReplyContext).toHaveBeenCalled();
    });

    it('reply context should take priority over dropdown selection (AC #6)', async () => {
      const msg = makeChatMessage({
        sender: makeAddress({ name: '@Developer' }),
      });
      chatServiceMock.replyContext$.next(msg);
      fixture.detectChanges();

      component.selectedAgents = ['@Manager', '@Expert'];
      component.userInput = 'hey do this';
      await component.sendMessage();

      // Should use reply context sender, not dropdown selection
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'hey do this',
        '@Developer',
      );
    });

    it('after reply context cleared, dropdown selection resumes routing (AC #6)', async () => {
      // Set up dropdown selection
      component.selectedAgents = ['@Expert'];

      // Send with reply context active
      const msg = makeChatMessage({
        sender: makeAddress({ name: '@Developer' }),
      });
      chatServiceMock.replyContext$.next(msg);
      fixture.detectChanges();

      component.userInput = 'reply message';
      await component.sendMessage();

      // Reply context was used and cleared
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledWith(
        'test-team-id',
        'reply message',
        '@Developer',
      );
      expect(chatServiceMock.clearReplyContext).toHaveBeenCalled();

      // Now send again -- reply context is cleared, dropdown should resume
      apiServiceSpy.sendMessage.calls.reset();
      component.userInput = 'follow-up message';
      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'follow-up message',
        '@Expert',
      );
    });

    it('should broadcast when no reply context and no selection', async () => {
      chatServiceMock.replyContext$.next(null);
      fixture.detectChanges();

      component.userInput = 'hello everyone';
      component.selectedAgents = [];
      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'hello everyone',
      );
    });

    it('clearReplyContext should call chatService.clearReplyContext', () => {
      component.clearReplyContext();
      expect(chatServiceMock.clearReplyContext).toHaveBeenCalled();
    });
  });
});
