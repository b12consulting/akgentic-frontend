import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { BehaviorSubject, of } from 'rxjs';

import { ProcessUserInputComponent } from './user-input.component';
import { ApiService } from '../../services/api.service';
import { AkgentService, Akgent } from '../../services/akgent.service';
import { ChatService } from '../../services/chat.service';
import { GraphDataService } from '../../services/graph-data.service';
import { ActorMessageService } from '../../services/message.service';

describe('ProcessUserInputComponent', () => {
  let component: ProcessUserInputComponent;
  let fixture: ComponentFixture<ProcessUserInputComponent>;
  let apiServiceSpy: jasmine.SpyObj<ApiService>;
  let akgentService: { selectedAkgent$: BehaviorSubject<Akgent | null> };

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

    const graphDataService = {
      nodes$: of([]),
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

    it('should broadcast via sendMessage when no targets and no speak-as', async () => {
      component.userInput = 'hello everyone';
      component.selectedAgents = [];
      akgentService.selectedAkgent$.next(null);

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'hello everyone',
      );
      expect(apiServiceSpy.sendMessageFromTo).not.toHaveBeenCalled();
    });

    it('should broadcast via sendMessage when no targets even if speak-as is set', async () => {
      component.userInput = 'broadcast msg';
      component.selectedAgents = [];
      akgentService.selectedAkgent$.next({ name: '@Developer', agentId: 'dev-1' });

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'broadcast msg',
      );
      expect(apiServiceSpy.sendMessageFromTo).not.toHaveBeenCalled();
    });

    it('should call sendMessageFromTo when speak-as is set and targets exist', async () => {
      component.userInput = 'do this task';
      component.selectedAgents = [
        { name: 'Manager', actorName: '@Manager', agentId: 'mgr-1' },
      ];
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

    it('should call sendMessageFromTo for each target when speak-as is set', async () => {
      component.userInput = 'multi-target';
      component.selectedAgents = [
        { name: 'Manager', actorName: '@Manager', agentId: 'mgr-1' },
        { name: 'Designer', actorName: '@Designer', agentId: 'des-1' },
      ];
      akgentService.selectedAkgent$.next({ name: '@Developer', agentId: 'dev-1' });

      await component.sendMessage();

      expect(apiServiceSpy.sendMessageFromTo).toHaveBeenCalledTimes(2);
      expect(apiServiceSpy.sendMessageFromTo).toHaveBeenCalledWith(
        'test-team-id',
        '@Developer',
        '@Manager',
        'multi-target',
      );
      expect(apiServiceSpy.sendMessageFromTo).toHaveBeenCalledWith(
        'test-team-id',
        '@Developer',
        '@Designer',
        'multi-target',
      );
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
    });

    it('should call sendMessage per target when no speak-as and targets exist', async () => {
      component.userInput = 'no impersonation';
      component.selectedAgents = [
        { name: 'Manager', actorName: '@Manager', agentId: 'mgr-1' },
      ];
      akgentService.selectedAkgent$.next(null);

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        'no impersonation',
        '@Manager',
      );
      expect(apiServiceSpy.sendMessageFromTo).not.toHaveBeenCalled();
    });

    it('should clear userInput after sending', async () => {
      component.userInput = 'will be cleared';
      component.selectedAgents = [];
      await component.sendMessage();
      expect(component.userInput).toBe('');
    });
  });
});
