import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { of } from 'rxjs';

import { ProcessUserInputComponent } from './user-input.component';
import { ApiService } from '../../services/api.service';
import { GraphDataService } from '../../services/graph-data.service';
import { ActorMessageService } from '../../services/message.service';

describe('ProcessUserInputComponent', () => {
  let component: ProcessUserInputComponent;
  let fixture: ComponentFixture<ProcessUserInputComponent>;
  let apiServiceSpy: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    apiServiceSpy = jasmine.createSpyObj('ApiService', [
      'sendMessage',
    ]);
    apiServiceSpy.sendMessage.and.returnValue(Promise.resolve());

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
});
