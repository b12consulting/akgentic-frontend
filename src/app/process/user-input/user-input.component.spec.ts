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

describe('ProcessUserInputComponent', () => {
  let component: ProcessUserInputComponent;
  let fixture: ComponentFixture<ProcessUserInputComponent>;
  let apiServiceSpy: jasmine.SpyObj<ApiService>;
  let chatServiceMock: any;

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

    const graphDataService = {
      nodes$: of([]),
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

    it('should broadcast when no @mention matches', async () => {
      component.userInput = 'hello everyone';
      component.mentionItems = [];

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'hello everyone',
      );
    });

    it('should send to mentioned agent when @mention matches', async () => {
      component.mentionItems = [
        { name: 'Manager [Manager]', actorName: '@Manager', agentId: 'mgr-1' },
      ];
      component.userInput = 'hey Manager [Manager] do this';

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'hey Manager [Manager] do this',
        '@Manager',
      );
    });

    it('should broadcast when text does not match any mention item', async () => {
      component.mentionItems = [
        { name: 'Manager [Manager]', actorName: '@Manager', agentId: 'mgr-1' },
      ];
      component.userInput = 'hello world no mention';

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'hello world no mention',
      );
    });

    it('should clear userInput after sending', async () => {
      component.userInput = 'will be cleared';
      component.mentionItems = [];
      await component.sendMessage();
      expect(component.userInput).toBe('');
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

    it('reply context should take priority over @mention', async () => {
      const msg = makeChatMessage({
        sender: makeAddress({ name: '@Developer' }),
      });
      chatServiceMock.replyContext$.next(msg);
      fixture.detectChanges();

      component.mentionItems = [
        { name: 'Manager [Manager]', actorName: '@Manager', agentId: 'mgr-1' },
      ];
      component.userInput = 'hey Manager [Manager] do this';
      await component.sendMessage();

      // Should use reply context sender, not the @mention
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'hey Manager [Manager] do this',
        '@Developer',
      );
    });

    it('should broadcast when no reply context and no @mention', async () => {
      chatServiceMock.replyContext$.next(null);
      fixture.detectChanges();

      component.userInput = 'hello everyone';
      component.mentionItems = [];
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
