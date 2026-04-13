import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { BehaviorSubject } from 'rxjs';

import { ProcessUserInputComponent } from './user-input.component';
import { ApiService } from '../../services/api.service';
import { ChatService } from '../../services/chat.service';
import { GraphDataService } from '../../services/graph-data.service';
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
    };

    nodesSubject = new BehaviorSubject<NodeInterface[]>([]);

    const graphDataService = {
      nodes$: nodesSubject,
    };

    await TestBed.configureTestingModule({
      imports: [FormsModule, ProcessUserInputComponent],
      providers: [
        { provide: ApiService, useValue: apiServiceSpy },
        { provide: ChatService, useValue: chatServiceMock },
        { provide: GraphDataService, useValue: graphDataService },
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

  describe('Send-to echo indicator (Story 4-11)', () => {
    it('should hide the indicator when no agent is selected (broadcast case)', () => {
      component.selectedAgents = [];
      fixture.detectChanges();

      const indicator = fixture.nativeElement.querySelector('.reply-indicator');
      expect(indicator).toBeNull();
    });

    it('should render the indicator with a single-agent label when one is selected', () => {
      component.selectedAgents = ['@Manager'];
      fixture.detectChanges();

      const indicator = fixture.nativeElement.querySelector('.reply-indicator');
      expect(indicator).toBeTruthy();
      expect(indicator.textContent).toContain('Send to');
      expect(indicator.textContent).toContain('Manager');
    });

    it('should render the indicator with a comma-joined label when multiple are selected', () => {
      component.selectedAgents = ['@Manager', '@Developer'];
      fixture.detectChanges();

      expect(component.selectedAgentsDisplay).toContain('Manager');
      expect(component.selectedAgentsDisplay).toContain('Developer');
      expect(component.selectedAgentsDisplay).toContain(',');

      const indicator = fixture.nativeElement.querySelector('.reply-indicator');
      expect(indicator).toBeTruthy();
      expect(indicator.textContent).toContain('Send to');
    });

    it('clearSendTo() should empty selectedAgents', () => {
      component.selectedAgents = ['@Manager', '@Developer'];
      component.clearSendTo();
      expect(component.selectedAgents).toEqual([]);
    });

    it('the `×` button in the indicator should clear selectedAgents', () => {
      component.selectedAgents = ['@Manager'];
      fixture.detectChanges();

      const closeBtn = fixture.nativeElement.querySelector(
        '.reply-indicator .reply-indicator-close',
      );
      expect(closeBtn).toBeTruthy();
      closeBtn.click();
      fixture.detectChanges();

      expect(component.selectedAgents).toEqual([]);
      const indicatorAfter = fixture.nativeElement.querySelector('.reply-indicator');
      expect(indicatorAfter).toBeNull();
    });

    it('component should NOT expose legacy reply-context API', () => {
      // Retired by Story 4-11 — these fields/methods are gone.
      expect((component as any).replyContext).toBeUndefined();
      expect((component as any).replyContextDisplayName).toBeUndefined();
      expect((component as any).clearReplyContext).toBeUndefined();
    });
  });
});
