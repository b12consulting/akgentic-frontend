import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { BehaviorSubject, of } from 'rxjs';

import { ProcessUserInputComponent } from './user-input.component';
import { ApiService } from '../../services/api.service';
import { ChatService } from '../../services/chat.service';
import { GraphDataService } from '../../services/graph-data.service';
import { ActorMessageService } from '../../services/message.service';
import { ChatMessage } from '../../models/chat-message.model';
import { ActorAddress } from '../../models/message.types';
import { NodeInterface } from '../../models/types';

function makeAddress(overrides: Partial<ActorAddress> = {}): ActorAddress {
  return {
    __actor_address__: true,
    name: '@Agent',
    role: 'Worker',
    agent_id: 'agent-1',
    squad_id: 'squad-1',
    user_message: false,
    ...overrides,
  };
}

function makeChatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  const id = overrides.id ?? 'msg-1';
  return {
    id,
    message_id: id,
    parent_id: null,
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

function makeNode(overrides: Partial<NodeInterface> = {}): NodeInterface {
  return {
    name: 'agent-uuid-1',
    role: 'Worker',
    actorName: '@Worker',
    parentId: 'parent-1',
    squadId: 'squad-1',
    symbol: 'circle',
    category: 0,
    userMessage: true,
    ...overrides,
  };
}

describe('ProcessUserInputComponent', () => {
  let component: ProcessUserInputComponent;
  let fixture: ComponentFixture<ProcessUserInputComponent>;
  let apiServiceSpy: jasmine.SpyObj<ApiService>;
  let chatServiceMock: any;
  let nodesSubject: BehaviorSubject<NodeInterface[]>;

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

    nodesSubject = new BehaviorSubject<NodeInterface[]>([]);

    const graphDataService = {
      nodes$: nodesSubject,
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

  describe('dropdown population from nodes$', () => {
    it('should populate dropdown with @-named agents minus @Human', () => {
      nodesSubject.next([
        makeNode({ name: 'mgr-1', actorName: '@Manager', role: 'Manager' }),
        makeNode({ name: 'dev-1', actorName: '@Developer', role: 'Developer' }),
        makeNode({ name: 'human-1', actorName: '@Human', role: 'Human' }),
      ]);

      expect(component.dropdownAgents.length).toBe(2);
      expect(component.dropdownAgents.map(a => a.value)).toEqual(['@Manager', '@Developer']);
      expect(component.dropdownAgents.map(a => a.value)).not.toContain('@Human');
    });

    it('should populate mentionItems with same filter as dropdown', () => {
      nodesSubject.next([
        makeNode({ name: 'mgr-1', actorName: '@Manager', role: 'Manager' }),
        makeNode({ name: 'human-1', actorName: '@Human', role: 'Human' }),
      ]);

      expect(component.mentionItems.length).toBe(1);
      expect(component.mentionItems[0].actorName).toBe('@Manager');
    });

    it('should remove fired agent from selectedAgents when nodes$ emits updated list', () => {
      nodesSubject.next([
        makeNode({ name: 'mgr-1', actorName: '@Manager' }),
        makeNode({ name: 'dev-1', actorName: '@Developer' }),
      ]);

      component.selectedAgents = ['@Manager', '@Developer'];

      // Fire @Developer by emitting nodes without it
      nodesSubject.next([
        makeNode({ name: 'mgr-1', actorName: '@Manager' }),
      ]);

      expect(component.selectedAgents).toEqual(['@Manager']);
    });

    it('should exclude nodes without @ prefix from dropdown', () => {
      nodesSubject.next([
        makeNode({ name: 'mgr-1', actorName: '@Manager' }),
        makeNode({ name: 'sys-1', actorName: 'system-process' }),
      ]);

      expect(component.dropdownAgents.length).toBe(1);
      expect(component.dropdownAgents[0].value).toBe('@Manager');
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

    it('should broadcast when no agents selected (default)', async () => {
      component.userInput = 'hello everyone';
      component.selectedAgents = [];

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'hello everyone',
      );
    });

    it('should send to single selected agent via dropdown', async () => {
      component.selectedAgents = ['@Manager'];
      component.userInput = 'hello manager';

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'hello manager',
        '@Manager',
      );
    });

    it('should send to multiple selected agents via dropdown', async () => {
      component.selectedAgents = ['@Manager', '@Developer'];
      component.userInput = 'hello team';

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledTimes(2);
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledWith(
        'test-team-id',
        'hello team',
        '@Manager',
      );
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledWith(
        'test-team-id',
        'hello team',
        '@Developer',
      );
    });

    it('should clear userInput after sending', async () => {
      component.userInput = 'will be cleared';
      component.selectedAgents = [];
      await component.sendMessage();
      expect(component.userInput).toBe('');
    });

    it('should persist dropdown selection across multiple sends', async () => {
      component.selectedAgents = ['@Manager'];
      component.userInput = 'first message';

      await component.sendMessage();

      expect(component.selectedAgents).toEqual(['@Manager']);

      component.userInput = 'second message';
      apiServiceSpy.sendMessage.calls.reset();
      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'second message',
        '@Manager',
      );
      expect(component.selectedAgents).toEqual(['@Manager']);
    });

    it('@mention text in input should NOT affect API call target', async () => {
      // Populate mentionItems so there IS an agent name in the text
      component.mentionItems = [
        { name: 'Manager [Manager]', actorName: '@Manager', agentId: 'mgr-1' },
      ];
      // No dropdown selection
      component.selectedAgents = [];
      component.userInput = 'hey Manager [Manager] do this';

      await component.sendMessage();

      // Should broadcast, NOT route to @Manager -- text matching is removed
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'hey Manager [Manager] do this',
      );
    });
  });

  describe('reply context', () => {
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

    it('reply context should take priority over dropdown selection', async () => {
      const msg = makeChatMessage({
        sender: makeAddress({ name: '@Developer' }),
      });
      chatServiceMock.replyContext$.next(msg);
      fixture.detectChanges();

      component.selectedAgents = ['@Manager'];
      component.userInput = 'hey do this';
      await component.sendMessage();

      // Should use reply context sender, not the dropdown selection
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'hey do this',
        '@Developer',
      );
    });

    it('reply context clearing should restore dropdown routing', async () => {
      const msg = makeChatMessage({
        sender: makeAddress({ name: '@Developer' }),
      });
      chatServiceMock.replyContext$.next(msg);
      fixture.detectChanges();

      component.selectedAgents = ['@Manager'];
      component.userInput = 'reply to dev';
      await component.sendMessage();

      // First send uses reply context
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledWith(
        'test-team-id',
        'reply to dev',
        '@Developer',
      );

      // Reply context was cleared, now dropdown should take over
      apiServiceSpy.sendMessage.calls.reset();
      component.userInput = 'now to manager';
      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'now to manager',
        '@Manager',
      );
    });

    it('should NOT clear dropdown selection when reply context is used', async () => {
      const msg = makeChatMessage({
        sender: makeAddress({ name: '@Developer' }),
      });
      chatServiceMock.replyContext$.next(msg);
      fixture.detectChanges();

      component.selectedAgents = ['@Manager'];
      component.userInput = 'reply message';
      await component.sendMessage();

      expect(component.selectedAgents).toEqual(['@Manager']);
    });

    it('should broadcast when no reply context and no dropdown selection', async () => {
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
