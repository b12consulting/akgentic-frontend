import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { BehaviorSubject, of } from 'rxjs';

import { ProcessUserInputComponent } from './user-input.component';
import { ApiService } from '../../services/api.service';
import { AkgentService, Akgent } from '../../services/akgent.service';
import { ChatService } from '../../services/chat.service';
import { GraphDataService } from '../../services/graph-data.service';
import { ActorMessageService } from '../../services/message.service';

function makeNode(actorName: string, userMessage = true) {
  return {
    name: `id-${actorName}`,
    role: 'Worker',
    actorName,
    parentId: '',
    squadId: '',
    symbol: '',
    category: 0,
    userMessage,
  };
}

describe('ProcessUserInputComponent', () => {
  let component: ProcessUserInputComponent;
  let fixture: ComponentFixture<ProcessUserInputComponent>;
  let apiServiceSpy: jasmine.SpyObj<ApiService>;
  let akgentService: { selectedAkgent$: BehaviorSubject<Akgent | null> };
  let nodesSubject: BehaviorSubject<any[]>;

  beforeEach(async () => {
    apiServiceSpy = jasmine.createSpyObj('ApiService', [
      'sendMessage',
      'sendMessageFromTo',
    ]);
    apiServiceSpy.sendMessage.and.returnValue(Promise.resolve());
    apiServiceSpy.sendMessageFromTo.and.returnValue(Promise.resolve());

    akgentService = {
      selectedAkgent$: new BehaviorSubject<Akgent | null>(null),
    };

    const chatService = {
      messages$: new BehaviorSubject<any[]>([]),
    };

    nodesSubject = new BehaviorSubject<any[]>([]);

    const graphDataService = {
      nodes$: nodesSubject.asObservable(),
    };

    const messageService = {
      messages$: of([]),
    };

    await TestBed.configureTestingModule({
      imports: [FormsModule, ProcessUserInputComponent],
      providers: [
        { provide: ApiService, useValue: apiServiceSpy },
        { provide: AkgentService, useValue: akgentService },
        { provide: ChatService, useValue: chatService },
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

  describe('dropdownAgents population', () => {
    it('should populate dropdownAgents from nodes$ with correct filter', () => {
      nodesSubject.next([
        makeNode('@Manager'),
        makeNode('@Expert'),
        makeNode('@Human'),
        makeNode('non-at-agent'),
      ]);

      // @Human and non-at-agent should be excluded
      expect(component.dropdownAgents.length).toBe(2);
      expect(component.dropdownAgents.map(a => a.value)).toEqual(['@Manager', '@Expert']);
    });

    it('should use makeAgentNameUserFriendly for dropdown labels', () => {
      nodesSubject.next([makeNode('@Manager')]);

      expect(component.dropdownAgents.length).toBe(1);
      // makeAgentNameUserFriendly transforms @Manager -> Manager [Manager] or similar
      expect(component.dropdownAgents[0].label).toBeTruthy();
      expect(component.dropdownAgents[0].value).toBe('@Manager');
    });

    it('should reset selectedAgent to null when fired agent is no longer in nodes', () => {
      nodesSubject.next([makeNode('@Manager'), makeNode('@Expert')]);
      component.selectedAgent = '@Expert';

      // Emit new nodes without @Expert (agent was fired)
      nodesSubject.next([makeNode('@Manager')]);

      expect(component.selectedAgent).toBeNull();
    });

    it('should keep selectedAgent when agent is still in the list', () => {
      nodesSubject.next([makeNode('@Manager'), makeNode('@Expert')]);
      component.selectedAgent = '@Expert';

      // Emit same nodes again
      nodesSubject.next([makeNode('@Manager'), makeNode('@Expert')]);

      expect(component.selectedAgent).toBe('@Expert');
    });

    it('should update dropdown reactively when nodes change', () => {
      nodesSubject.next([makeNode('@Manager')]);
      expect(component.dropdownAgents.length).toBe(1);

      nodesSubject.next([makeNode('@Manager'), makeNode('@Expert'), makeNode('@Researcher')]);
      expect(component.dropdownAgents.length).toBe(3);
    });
  });

  describe('sendMessage()', () => {
    it('should not send when input is empty', async () => {
      component.userInput = '';
      await component.sendMessage();
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
      expect(apiServiceSpy.sendMessageFromTo).not.toHaveBeenCalled();
    });

    it('should not send when input is whitespace only', async () => {
      component.userInput = '   ';
      await component.sendMessage();
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
    });

    it('should broadcast when no dropdown selection and no speak-as', async () => {
      component.userInput = 'hello everyone';
      component.selectedAgent = null;
      akgentService.selectedAkgent$.next(null);

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'hello everyone',
      );
      expect(apiServiceSpy.sendMessageFromTo).not.toHaveBeenCalled();
    });

    it('should route to selected agent via sendMessage when dropdown has selection', async () => {
      component.userInput = 'do this task';
      component.selectedAgent = '@Manager';
      akgentService.selectedAkgent$.next(null);

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'do this task',
        '@Manager',
      );
      expect(apiServiceSpy.sendMessageFromTo).not.toHaveBeenCalled();
    });

    it('should use sendMessageFromTo when speak-as is set and dropdown has selection', async () => {
      component.userInput = 'do this task';
      component.selectedAgent = '@Manager';
      akgentService.selectedAkgent$.next({ name: '@Developer', agentId: 'dev-1' });

      await component.sendMessage();

      expect(apiServiceSpy.sendMessageFromTo).toHaveBeenCalledOnceWith(
        'test-team-id',
        '@Developer',
        '@Manager',
        'do this task',
      );
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
    });

    it('should broadcast when no dropdown selection even if speak-as is set', async () => {
      component.userInput = 'broadcast msg';
      component.selectedAgent = null;
      akgentService.selectedAkgent$.next({ name: '@Developer', agentId: 'dev-1' });

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'broadcast msg',
      );
      expect(apiServiceSpy.sendMessageFromTo).not.toHaveBeenCalled();
    });

    it('should clear userInput after sending', async () => {
      component.userInput = 'will be cleared';
      component.selectedAgent = null;
      await component.sendMessage();
      expect(component.userInput).toBe('');
    });

    it('should persist dropdown selection across multiple sends', async () => {
      component.selectedAgent = '@Manager';
      akgentService.selectedAkgent$.next(null);

      component.userInput = 'first message';
      await component.sendMessage();

      component.userInput = 'second message';
      await component.sendMessage();

      // selectedAgent should still be @Manager after both sends
      expect(component.selectedAgent).toBe('@Manager');
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledTimes(2);
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledWith(
        'test-team-id',
        'first message',
        '@Manager',
      );
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledWith(
        'test-team-id',
        'second message',
        '@Manager',
      );
    });

    it('@mention text in input should NOT affect routing when no dropdown selection', async () => {
      // Populate mention items like a real scenario
      component.mentionItems = [
        { name: 'Manager [Manager]', actorName: '@Manager', agentId: 'mgr-1' },
      ];
      component.selectedAgent = null;
      component.userInput = 'hey Manager [Manager] do this';
      akgentService.selectedAkgent$.next(null);

      await component.sendMessage();

      // Should broadcast, NOT route to @Manager based on text content
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'hey Manager [Manager] do this',
      );
    });

    it('@mention text in input should NOT affect routing when dropdown has selection', async () => {
      component.mentionItems = [
        { name: 'Manager [Manager]', actorName: '@Manager', agentId: 'mgr-1' },
        { name: 'Expert [Expert]', actorName: '@Expert', agentId: 'exp-1' },
      ];
      component.selectedAgent = '@Expert';
      component.userInput = 'hey Manager [Manager] do this';
      akgentService.selectedAkgent$.next(null);

      await component.sendMessage();

      // Should route to @Expert (dropdown), NOT @Manager (mention text)
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'hey Manager [Manager] do this',
        '@Expert',
      );
    });
  });
});
