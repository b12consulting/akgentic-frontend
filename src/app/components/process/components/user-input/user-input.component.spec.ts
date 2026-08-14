import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { MessageService } from 'primeng/api';
import { BehaviorSubject } from 'rxjs';

import { ProcessUserInputComponent } from './user-input.component';
import { ApiService } from '../../../../core/http/api.service';
import { HttpError } from '../../../../core/http/fetch.service';
import { ChatService } from '../../selectors/chat.selector';
import { ContextService } from '../../../../core/context/context.service';
import { GraphDataService } from '../../selectors/graph.selector';
import { IngestionService } from '../../event/ingestion.service';
import { ActorAddress, CommandDescriptor } from '../../../../protocol/message.types';
import { NodeInterface } from '../../models/types';
import { makeAgentNameUserFriendly } from '../../../../shared/util/util';

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
  // Story 33-1: the stub counts reads of `currentTeamRunning$` through a getter
  // so AC #8 ("run state consulted once") is directly assertable, and carries
  // the `restoreTeamAndAwait` double the restore-then-send path calls.
  let runningSubject: BehaviorSubject<boolean>;
  let runStateReads: number;
  let contextServiceStub: {
    readonly currentTeamRunning$: BehaviorSubject<boolean>;
    restoreTeamAndAwait: jasmine.Spy<
      (teamId: string, timeoutMs?: number) => Promise<void>
    >;
  };
  let messageServiceSpy: jasmine.SpyObj<MessageService>;
  let ingestionInitSpy: jasmine.Spy;
  let nodesSubject: BehaviorSubject<NodeInterface[]>;
  // Story 17-3: the service now exposes a `commands` PerAgentStore keyed by
  // agent_id. The stub holds a plain agent_id → descriptors map and a
  // `snapshot(id)` reader matching the real store's synchronous getter shape.
  let commandsById: Record<string, CommandDescriptor[]>;

  beforeEach(async () => {
    apiServiceSpy = jasmine.createSpyObj('ApiService', ['sendMessage', 'sendMessageFromTo']);
    apiServiceSpy.sendMessage.and.returnValue(Promise.resolve());
    apiServiceSpy.sendMessageFromTo.and.returnValue(Promise.resolve());

    chatServiceMock = {
      messages$: new BehaviorSubject<any[]>([]),
      loadingProcess$: new BehaviorSubject<boolean>(false),
      // Story 19-1 (ADR-016 §Decision 1): just-sent side channel.
      emitJustSent: jasmine.createSpy('emitJustSent'),
    };

    // sendMessage() reads currentTeamRunning$.value once to decide whether a
    // restore is needed (Story 33-1). Default to running=true so the restore
    // branch does not fire in the routing tests.
    runningSubject = new BehaviorSubject<boolean>(true);
    runStateReads = 0;
    contextServiceStub = {
      get currentTeamRunning$(): BehaviorSubject<boolean> {
        runStateReads++;
        return runningSubject;
      },
      restoreTeamAndAwait: jasmine
        .createSpy('restoreTeamAndAwait')
        .and.returnValue(Promise.resolve()),
    };

    messageServiceSpy = jasmine.createSpyObj('MessageService', ['add', 'clear']);

    nodesSubject = new BehaviorSubject<NodeInterface[]>([]);

    const graphDataService = {
      nodes$: nodesSubject,
    };

    commandsById = {};
    // Story 33-1 AC #11: `init` exists on the double purely so the spec can
    // prove the restore-then-send path never re-runs ingestion.
    ingestionInitSpy = jasmine.createSpy('init');
    const ingestionServiceStub = {
      init: ingestionInitSpy,
      commands: {
        snapshot: (id: string): CommandDescriptor[] | undefined =>
          commandsById[id],
      },
    };

    await TestBed.configureTestingModule({
      imports: [FormsModule, ProcessUserInputComponent],
      providers: [
        { provide: ApiService, useValue: apiServiceSpy },
        { provide: ChatService, useValue: chatServiceMock },
        { provide: ContextService, useValue: contextServiceStub },
        { provide: GraphDataService, useValue: graphDataService },
        { provide: IngestionService, useValue: ingestionServiceStub },
        { provide: MessageService, useValue: messageServiceSpy },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ProcessUserInputComponent);
    component = fixture.componentInstance;
    component.processId = 'test-team-id';
    fixture.detectChanges();
  });

  /** A restore double the spec releases by hand, so "before"/"after the
   *  restore resolves" is observable rather than inferred. */
  function deferredRestore(): { release: () => void } {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    contextServiceStub.restoreTeamAndAwait.and.returnValue(pending);
    return { release };
  }

  function timeoutError(): Error {
    // Shape of the rxjs `timeout(ms)` rejection: an Error named TimeoutError,
    // NOT an HttpError — so nothing else in the app has toasted it.
    const err = new Error('Timeout has occurred');
    err.name = 'TimeoutError';
    return err;
  }

  function submitButton() {
    return fixture.debugElement.query(By.css('p-button')).componentInstance;
  }

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('renders the send icon on the Submit button (parity with member chat)', () => {
    const submitBtn = fixture.debugElement.query(By.css('p-button'));
    expect(submitBtn).toBeTruthy();
    expect(submitBtn.componentInstance.icon).toBe('pi pi-send');
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

  describe('"Send as" dropdown population (Story 7-1)', () => {
    it('initializes humanAgents / humanAgentOptions / selectedSender to defaults', () => {
      expect(component.humanAgents).toEqual([]);
      expect(component.humanAgentOptions).toEqual([]);
      expect(component.selectedSender).toBeNull();
    });

    it('populates humanAgents with role === Human (Story 7-3)', () => {
      nodesSubject.next([
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
        makeNode({ name: 'ops-1', actorName: '@Operator', role: 'Human' }),
        makeNode({ name: 'human-1', actorName: '@Human', role: 'Human' }),
        makeNode({ name: 'mgr-1', actorName: '@Manager', role: 'Worker' }),
      ]);

      // Story 7-3: @Human is now INCLUDED alongside other human-role nodes.
      expect(component.humanAgents.length).toBe(3);
      expect(component.humanAgents.map((n) => n.actorName)).toEqual([
        '@Support',
        '@Operator',
        '@Human',
      ]);
      expect(component.humanAgentOptions.map((o) => o.value)).toEqual([
        '@Support',
        '@Operator',
        '@Human',
      ]);
      // Labels come from makeAgentNameUserFriendly (passes @Support through
      // as-is since there is no '-' role segment).
      expect(component.humanAgentOptions[0].label).toBe('@Support');
    });

    it('includes the entry-point @Human when role === Human (Story 7-3)', () => {
      nodesSubject.next([
        makeNode({ name: 'human-1', actorName: '@Human', role: 'Human' }),
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
      ]);

      // Story 7-3 (AC #1, AC #2): the @Human entry point is a first-class
      // selectable sender. The filter uses role === HUMAN_ROLE only.
      expect(component.humanAgents.length).toBe(2);
      expect(component.humanAgents.map((n) => n.actorName)).toContain('@Human');
      expect(component.humanAgents.map((n) => n.actorName)).toContain('@Support');
      expect(component.humanAgentOptions.map((o) => o.value)).toContain('@Human');
      // AC #2: label for @Human uses the friendly helper, not a hard-coded string.
      const humanOpt = component.humanAgentOptions.find((o) => o.value === '@Human');
      expect(humanOpt).toBeTruthy();
      expect(humanOpt!.label).toBe(makeAgentNameUserFriendly('@Human'));
    });

    it('excludes nodes whose role !== Human', () => {
      nodesSubject.next([
        makeNode({ name: 'mgr-1', actorName: '@Manager', role: 'Manager' }),
        makeNode({ name: 'dev-1', actorName: '@Developer', role: 'Worker' }),
      ]);

      expect(component.humanAgents.length).toBe(0);
      expect(component.humanAgentOptions.length).toBe(0);
    });
  });

  describe('"Send as" dropdown visibility (Story 7-1)', () => {
    it('is hidden when humanAgents.length === 0', () => {
      nodesSubject.next([
        makeNode({ name: 'mgr-1', actorName: '@Manager', role: 'Worker' }),
      ]);
      fixture.detectChanges();

      const dropdown = fixture.nativeElement.querySelector('p-dropdown');
      expect(dropdown).toBeNull();
    });

    it('is hidden when humanAgents.length === 1 (solo @Human) (Story 7-3)', () => {
      // Story 7-3: humans include @Human; solo-@Human still hides dropdown.
      nodesSubject.next([
        makeNode({ name: 'human-1', actorName: '@Human', role: 'Human' }),
      ]);
      fixture.detectChanges();

      const dropdown = fixture.nativeElement.querySelector('p-dropdown');
      expect(dropdown).toBeNull();
    });

    it('is visible when humanAgents.length === 2 (@Human + @Support) (Story 7-3)', () => {
      // Story 7-3: threshold fires at 2 humans INCLUDING @Human.
      nodesSubject.next([
        makeNode({ name: 'human-1', actorName: '@Human', role: 'Human' }),
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
      ]);
      fixture.detectChanges();

      const dropdown = fixture.nativeElement.querySelector('p-dropdown');
      expect(dropdown).not.toBeNull();
      expect(component.humanAgentOptions.length).toBe(2);
      expect(component.humanAgentOptions.map((o) => o.value)).toContain('@Human');
      expect(component.humanAgentOptions.map((o) => o.value)).toContain('@Support');
    });

    it('picking an option sets selectedSender to the option value', () => {
      nodesSubject.next([
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
        makeNode({ name: 'ops-1', actorName: '@Operator', role: 'Human' }),
      ]);
      fixture.detectChanges();

      component.selectedSender = '@Support';
      fixture.detectChanges();

      expect(component.selectedSender).toBe('@Support');
    });

  });

  describe('"Send as" routing (Story 7-2)', () => {
    beforeEach(() => {
      // 2 non-entry-point humans so the dropdown would be visible
      nodesSubject.next([
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
        makeNode({ name: 'ops-1', actorName: '@Operator', role: 'Human' }),
        makeNode({ name: 'mgr-1', actorName: '@Manager', role: 'Worker' }),
        makeNode({ name: 'dev-1', actorName: '@Developer', role: 'Worker' }),
      ]);
    });

    it('Priority 1: sender + recipients -> sendMessageFromTo per recipient (AC #1)', async () => {
      component.selectedSender = '@Support';
      component.selectedAgents = ['@Manager', '@Developer'];
      component.userInput = 'hello';

      await component.sendMessage();

      expect(apiServiceSpy.sendMessageFromTo).toHaveBeenCalledTimes(2);
      expect(apiServiceSpy.sendMessageFromTo).toHaveBeenCalledWith(
        'test-team-id', '@Support', '@Manager', 'hello',
      );
      expect(apiServiceSpy.sendMessageFromTo).toHaveBeenCalledWith(
        'test-team-id', '@Support', '@Developer', 'hello',
      );
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
      expect(component.userInput).toBe('');
    });

    it('Priority 2: sender, no recipient, non-empty dropdownAgents -> first dropdown agent (AC #2)', async () => {
      // Override the beforeEach roster with workers only so dropdownAgents[0]
      // is @Manager (the "typical supervisor" case from AC #2). The current
      // dropdown filter (Story 3-1) excludes only the entry-point @Human; any
      // other @-prefixed node — including humans like @Support — would
      // otherwise land in dropdownAgents and shadow the worker at index 0.
      nodesSubject.next([
        makeNode({ name: 'mgr-1', actorName: '@Manager', role: 'Worker' }),
        makeNode({ name: 'dev-1', actorName: '@Developer', role: 'Worker' }),
      ]);
      // selectedSender is set AFTER the emission, so the clear-on-count-drop
      // logic (which runs inside the nodes$ subscription) doesn't see it.
      component.selectedSender = '@Support';
      component.selectedAgents = [];
      component.userInput = 'first-agent auto-target';

      // sanity-check the expected first entry.
      expect(component.dropdownAgents[0].value).toBe('@Manager');

      await component.sendMessage();

      expect(apiServiceSpy.sendMessageFromTo).toHaveBeenCalledOnceWith(
        'test-team-id', '@Support', '@Manager', 'first-agent auto-target',
      );
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
      expect(component.userInput).toBe('');
    });

    it('Priority 2 edge case: sender, no recipient, empty dropdownAgents -> no send, input preserved (AC #3)', async () => {
      // Emit a roster with 2 humans but NO worker agents in the Send-to dropdown.
      nodesSubject.next([
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
        makeNode({ name: 'ops-1', actorName: '@Operator', role: 'Human' }),
        makeNode({ name: 'human-1', actorName: '@Human', role: 'Human' }),
      ]);
      // Force the edge case by emptying dropdownAgents directly:
      component.dropdownAgents = [];
      component.selectedSender = '@Support';
      component.selectedAgents = [];
      component.userInput = 'orphan sender';

      await component.sendMessage();

      expect(apiServiceSpy.sendMessageFromTo).not.toHaveBeenCalled();
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
      expect(component.userInput).toBe('orphan sender');
    });

    it('Priority 3: no sender + recipients -> sendMessage per recipient (AC #4, Story 3-1 preserved)', async () => {
      component.selectedSender = null;
      component.selectedAgents = ['@Manager', '@Developer'];
      component.userInput = 'hello team';

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledTimes(2);
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledWith(
        'test-team-id', 'hello team', '@Manager',
      );
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledWith(
        'test-team-id', 'hello team', '@Developer',
      );
      expect(apiServiceSpy.sendMessageFromTo).not.toHaveBeenCalled();
      expect(component.userInput).toBe('');
    });

    it('Priority 4: no sender + no recipient -> broadcast (AC #5, Story 3-1 preserved)', async () => {
      component.selectedSender = null;
      component.selectedAgents = [];
      component.userInput = 'broadcast hello';

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id', 'broadcast hello',
      );
      expect(apiServiceSpy.sendMessageFromTo).not.toHaveBeenCalled();
      expect(component.userInput).toBe('');
    });

    it('empty input guard runs first across all priorities (AC #6)', async () => {
      component.selectedSender = '@Support';
      component.selectedAgents = ['@Manager'];
      component.userInput = '   '; // whitespace only

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
      expect(apiServiceSpy.sendMessageFromTo).not.toHaveBeenCalled();
      expect(component.userInput).toBe('   ');
    });

    it('Priority 1: @Human as sender routes via sendMessageFromTo (Story 7-3)', async () => {
      component.selectedSender = '@Human';
      component.selectedAgents = ['@Manager'];
      component.userInput = 'hello from human';

      await component.sendMessage();

      expect(apiServiceSpy.sendMessageFromTo).toHaveBeenCalledOnceWith(
        'test-team-id', '@Human', '@Manager', 'hello from human',
      );
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
      expect(component.userInput).toBe('');
    });

    it('Priority 2: @Human as sender with no recipient auto-targets first dropdown agent (Story 7-3)', async () => {
      component.selectedSender = '@Human';
      component.selectedAgents = [];
      component.userInput = 'auto-target from @Human';

      await component.sendMessage();

      const firstDropdownAgent = component.dropdownAgents[0]?.value;
      expect(firstDropdownAgent).toBeTruthy();
      expect(apiServiceSpy.sendMessageFromTo).toHaveBeenCalledOnceWith(
        'test-team-id', '@Human', firstDropdownAgent!, 'auto-target from @Human',
      );
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
      expect(component.userInput).toBe('');
    });
  });

  describe('"Send as" dynamic state (Story 7-2)', () => {
    it('clears selectedSender when the selected sender is fired (AC #7)', () => {
      nodesSubject.next([
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
        makeNode({ name: 'ops-1', actorName: '@Operator', role: 'Human' }),
        makeNode({ name: 'thi-1', actorName: '@Third', role: 'Human' }),
      ]);
      component.selectedSender = '@Support';

      // Fire @Support by emitting a roster without it (count stays >= 2).
      nodesSubject.next([
        makeNode({ name: 'ops-1', actorName: '@Operator', role: 'Human' }),
        makeNode({ name: 'thi-1', actorName: '@Third', role: 'Human' }),
      ]);

      expect(component.selectedSender).toBeNull();
      expect(component.humanAgents.length).toBe(2);
    });

    it('clears selectedSender when human count drops below 2 (AC #8)', () => {
      nodesSubject.next([
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
        makeNode({ name: 'ops-1', actorName: '@Operator', role: 'Human' }),
      ]);
      component.selectedSender = '@Support';

      // Drop to 1 non-entry-point human.
      nodesSubject.next([
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
      ]);

      expect(component.selectedSender).toBeNull();
      expect(component.humanAgents.length).toBe(1);
    });

    it('preserves selectedSender when the selection still exists and count >= 2', () => {
      nodesSubject.next([
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
        makeNode({ name: 'ops-1', actorName: '@Operator', role: 'Human' }),
        makeNode({ name: 'thi-1', actorName: '@Third', role: 'Human' }),
      ]);
      component.selectedSender = '@Support';

      // Fire an unrelated human -> @Support stays selected.
      nodesSubject.next([
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
        makeNode({ name: 'ops-1', actorName: '@Operator', role: 'Human' }),
      ]);

      expect(component.selectedSender).toBe('@Support');
    });

    it('does not resurrect a cleared selectedSender when count recovers', () => {
      nodesSubject.next([
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
        makeNode({ name: 'ops-1', actorName: '@Operator', role: 'Human' }),
      ]);
      component.selectedSender = '@Support';

      // Drop below 2 -> selection cleared.
      nodesSubject.next([
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
      ]);
      expect(component.selectedSender).toBeNull();

      // Recover to 2 humans -> selection STAYS null (user must repick).
      nodesSubject.next([
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
        makeNode({ name: 'ops-1', actorName: '@Operator', role: 'Human' }),
      ]);
      expect(component.selectedSender).toBeNull();
    });

    it('clears selectedSender === "@Human" when @Human disappears from the roster (Story 7-3)', () => {
      // Initial: @Human + @Support both present, selectedSender = @Human
      nodesSubject.next([
        makeNode({ name: 'human-1', actorName: '@Human', role: 'Human' }),
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
      ]);
      component.selectedSender = '@Human';

      // Defensive case: @Human somehow removed (leaving only non-entry humans).
      // The clear-on-fire predicate fires because @Human is no longer in humanAgents.
      nodesSubject.next([
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
        makeNode({ name: 'ops-1', actorName: '@Operator', role: 'Human' }),
      ]);

      expect(component.selectedSender).toBeNull();
      expect(component.humanAgents.length).toBe(2);
    });
  });

  describe('"Send as" layout and panel positioning (Story 7-3)', () => {
    beforeEach(() => {
      nodesSubject.next([
        makeNode({ name: 'human-1', actorName: '@Human', role: 'Human' }),
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
      ]);
      fixture.detectChanges();
    });

    it('renders p-dropdown with appendTo="body" (AC #14)', () => {
      const dropdown = fixture.nativeElement.querySelector('p-dropdown');
      expect(dropdown).not.toBeNull();
      // In Angular dev-mode runtime, string inputs appear as DOM attributes.
      // `appendTo` is bound as a literal string on the template, so it
      // surfaces as an attribute on the <p-dropdown> element.
      expect(dropdown.getAttribute('appendTo')).toBe('body');
    });

    it('renders p-dropdown with the upward panel style class configured (AC #14)', () => {
      const dropdown = fixture.nativeElement.querySelector('p-dropdown');
      expect(dropdown).not.toBeNull();
      // [panelStyleClass] is an input binding — Angular reflects its current
      // value via `ng-reflect-panel-style-class` in dev mode. Accept any
      // deterministic channel that carries the class name.
      const panelClass =
        dropdown.getAttribute('ng-reflect-panel-style-class') ||
        dropdown.getAttribute('panelStyleClass');
      expect(panelClass).toContain('send-as-panel-up');
    });

    it('right-aligns the Send-as group inside .button-group (AC #15)', () => {
      const group = fixture.nativeElement.querySelector('.send-as-group');
      expect(group).not.toBeNull();
      // The implementation uses both `justify-content: flex-end` (intra-group
      // alignment) and `margin-left: auto` (pushes the group to the right
      // inside `.button-group`). Either is acceptable evidence that the
      // Send-as block is right-aligned.
      const style = window.getComputedStyle(group);
      expect(
        style.justifyContent === 'flex-end' || style.marginLeft === 'auto',
      ).toBeTrue();
    });
  });

  // -------------------------------------------------------------------------
  // Story 15-1 (ADR-013) — `/` slash-command mention
  // -------------------------------------------------------------------------

  function mkDescriptor(
    name: string,
    overrides: Partial<CommandDescriptor> = {},
  ): CommandDescriptor {
    return {
      name,
      description: `${name} description`,
      args: [],
      tool_card: 'TeamTool',
      ...overrides,
    };
  }

  describe('slash-command mention (Story 15-1)', () => {
    const HIRE = mkDescriptor('hire_member', {
      description: 'Hire a new team member',
      args: [
        { name: 'role', type: 'string', required: true },
        { name: 'name', type: 'string', required: false },
      ],
    });
    const ROSTER = mkDescriptor('roster', {
      description: 'List the current team roster',
    });

    it('AC-3: with exactly one Send-to recipient, commandItems are that agent\'s commands (keyed by agent_id)', () => {
      nodesSubject.next([
        makeNode({ name: 'mgr-1', actorName: '@Manager', role: 'Worker' }),
        makeNode({ name: 'dev-1', actorName: '@Developer', role: 'Worker' }),
      ]);
      // Seed under the node's agent_id (`name`), NOT the friendly actor name.
      commandsById['mgr-1'] = [HIRE, ROSTER];
      component.selectedAgents = ['@Manager'];

      expect(component.commandItems.map((c) => c.name)).toEqual([
        'hire_member',
        'roster',
      ]);
    });

    it('hides internal `_`-prefixed commands from the / list', () => {
      const INTERNAL = mkDescriptor('_expand_media_refs', {
        description: 'Expand glob tokens into binary image content',
        args: [{ name: 'prompt', type: 'string', required: true }],
      });
      nodesSubject.next([
        makeNode({ name: 'mgr-1', actorName: '@Manager', role: 'Worker' }),
      ]);
      commandsById['mgr-1'] = [INTERNAL, HIRE, ROSTER];
      component.selectedAgents = ['@Manager'];

      // `_expand_media_refs` is internal — only user commands remain.
      expect(component.commandItems.map((c) => c.name)).toEqual([
        'hire_member',
        'roster',
      ]);
    });

    it('AC-3: with zero recipients, defaults to the supervisor (child of @Human entry point)', () => {
      nodesSubject.next([
        makeNode({ name: 'human-1', actorName: '@Human', role: 'Human' }),
        makeNode({
          name: 'mgr-1',
          actorName: '@Manager',
          role: 'Worker',
          parentId: 'human-1',
        }),
        makeNode({
          name: 'dev-1',
          actorName: '@Developer',
          role: 'Worker',
          parentId: 'mgr-1',
        }),
      ]);
      commandsById['mgr-1'] = [HIRE];
      commandsById['dev-1'] = [ROSTER];
      component.selectedAgents = [];

      // Supervisor = the agent whose parent is @Human → @Manager (agent_id mgr-1).
      expect(component.commandItems.map((c) => c.name)).toEqual(['hire_member']);
    });

    it('AC-2: name-reuse non-bleed — same display name, different agent_ids resolve correctly', () => {
      // Two nodes have shared the display name '@Manager' history but the LIVE
      // roster carries the re-hired one (agent_id mgr-new). The list must be the
      // resolved node's agent_id list, never a stale name-keyed entry.
      nodesSubject.next([
        makeNode({ name: 'mgr-new', actorName: '@Manager', role: 'Worker' }),
      ]);
      // The fired agent (mgr-old) still has a seeded entry; the re-hired one a
      // different list. The resolved target's agent_id is mgr-new.
      commandsById['mgr-old'] = [HIRE];
      commandsById['mgr-new'] = [ROSTER];
      component.selectedAgents = ['@Manager'];

      // Correct agent's commands (mgr-new → roster), no bleed from mgr-old.
      expect(component.commandItems.map((c) => c.name)).toEqual(['roster']);
    });

    it('AC-4: with multiple Send-to recipients, the / list is empty', () => {
      nodesSubject.next([
        makeNode({ name: 'mgr-1', actorName: '@Manager', role: 'Worker' }),
        makeNode({ name: 'dev-1', actorName: '@Developer', role: 'Worker' }),
      ]);
      commandsById['mgr-1'] = [HIRE];
      commandsById['dev-1'] = [ROSTER];
      component.selectedAgents = ['@Manager', '@Developer'];

      expect(component.commandItems).toEqual([]);
    });

    it('AC-6: no CommandsAnnouncedEvent for the target → empty / list', () => {
      nodesSubject.next([
        makeNode({ name: 'mgr-1', actorName: '@Manager', role: 'Worker' }),
      ]);
      // commands store is empty (no event arrived yet).
      component.selectedAgents = ['@Manager'];

      expect(component.commandItems).toEqual([]);
    });

    it('selectCommand inserts `/${name} ` (leading slash, trailing space, no send)', () => {
      const text = component.selectCommand({ name: 'hire_member' });
      expect(text).toBe('/hire_member ');
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
    });

    it('AC-5: `/command args` text is sent verbatim via the existing send path', async () => {
      component.selectedAgents = ['@Manager'];
      component.userInput = '/hire_member Developer "Alice"';

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id',
        '/hire_member Developer "Alice"',
        '@Manager',
      );
    });

    it('commandArgsHint renders required in <> and optional in [] in order', () => {
      expect(component.commandArgsHint(HIRE.args)).toBe('<role> [name]');
      expect(component.commandArgsHint(ROSTER.args)).toBe('');
    });

    it('AC-7: mentionConfig still exposes the unchanged @ trigger alongside /', () => {
      const triggers = component.mentionConfig.mentions.map((m) => m.triggerChar);
      expect(triggers).toContain('@');
      expect(triggers).toContain('/');
      const at = component.mentionConfig.mentions.find((m) => m.triggerChar === '@');
      expect(at!.mentionSelect).toBe(component.selectAgent);
      expect(at!.allowSpace).toBeTrue();
    });

    it('AC-7: selectAgent behavior is unchanged (inserts friendly name + space)', () => {
      expect(component.selectAgent({ name: 'Manager [Manager]' })).toBe(
        'Manager [Manager] ',
      );
    });

    // Story 15-3 (AC-4) — tool-family ordering: commands order by `tool_card`
    // then `name`, so each tool family is contiguous and alphabetical within
    // it, and the `/` mentionConfig entry opts out of angular-mentions' own
    // label sort (`disableSort: true`) so the selector's order survives.
    it('AC-4: orders commandItems by tool_card then name (tool families contiguous)', () => {
      // Deliberately interleave two tool families AND list them out of order so
      // a naive global-name sort would NOT reproduce the grouped result.
      const PLAN_BREAKDOWN = mkDescriptor('breakdown', {
        tool_card: 'PlanningTool',
      });
      const PLAN_AUDIT = mkDescriptor('audit', { tool_card: 'PlanningTool' });
      const TEAM_HIRE = mkDescriptor('hire_member', { tool_card: 'TeamTool' });
      const TEAM_ROSTER = mkDescriptor('roster', { tool_card: 'TeamTool' });

      nodesSubject.next([
        makeNode({ name: 'mgr-1', actorName: '@Manager', role: 'Worker' }),
      ]);
      // Stored order: TeamTool first, PlanningTool names reversed — neither
      // tool-grouped nor globally alphabetical. Seeded under agent_id mgr-1.
      commandsById['mgr-1'] = [
        TEAM_ROSTER,
        PLAN_BREAKDOWN,
        TEAM_HIRE,
        PLAN_AUDIT,
      ];
      component.selectedAgents = ['@Manager'];

      // PlanningTool family (audit, breakdown) before TeamTool family
      // (hire_member, roster); alphabetical within each family.
      expect(component.commandItems.map((c) => c.name)).toEqual([
        'audit',
        'breakdown',
        'hire_member',
        'roster',
      ]);
    });

    it('AC-4: the `/` mentionConfig entry sets disableSort === true', () => {
      const slash = component.mentionConfig.mentions.find(
        (m) => m.triggerChar === '/',
      );
      expect(slash).toBeTruthy();
      expect((slash as any).disableSort).toBeTrue();
    });
  });

  // -------------------------------------------------------------------------
  // Story 19-1 (ADR-016 §Decision 1) — just-sent signal emission
  // -------------------------------------------------------------------------
  describe('just-sent signal (Story 19-1)', () => {
    beforeEach(() => {
      // Pin the send-origin key so assertions are deterministic.
      spyOn<any>(component, 'nextJustSentKey').and.returnValue('1700000000000');
      nodesSubject.next([
        makeNode({ name: 'sup-1', actorName: '@Support', role: 'Human' }),
        makeNode({ name: 'ops-1', actorName: '@Operator', role: 'Human' }),
        makeNode({ name: 'mgr-1', actorName: '@Manager', role: 'Worker' }),
        makeNode({ name: 'dev-1', actorName: '@Developer', role: 'Worker' }),
      ]);
    });

    it('emits once on Priority 1 (sender + recipients) with the send-origin key', async () => {
      component.selectedSender = '@Support';
      component.selectedAgents = ['@Manager', '@Developer'];
      component.userInput = 'hello';

      await component.sendMessage();

      expect(chatServiceMock.emitJustSent).toHaveBeenCalledOnceWith('1700000000000');
      // Routing is unchanged — one call per recipient.
      expect(apiServiceSpy.sendMessageFromTo).toHaveBeenCalledTimes(2);
    });

    it('emits once on Priority 2 (sender, no recipient -> first dropdown agent)', async () => {
      nodesSubject.next([
        makeNode({ name: 'mgr-1', actorName: '@Manager', role: 'Worker' }),
        makeNode({ name: 'dev-1', actorName: '@Developer', role: 'Worker' }),
      ]);
      component.selectedSender = '@Support';
      component.selectedAgents = [];
      component.userInput = 'auto-target';

      await component.sendMessage();

      expect(chatServiceMock.emitJustSent).toHaveBeenCalledOnceWith('1700000000000');
      expect(apiServiceSpy.sendMessageFromTo).toHaveBeenCalledTimes(1);
    });

    it('emits once on Priority 3 (default sender + recipients)', async () => {
      component.selectedSender = null;
      component.selectedAgents = ['@Manager', '@Developer'];
      component.userInput = 'hello team';

      await component.sendMessage();

      expect(chatServiceMock.emitJustSent).toHaveBeenCalledOnceWith('1700000000000');
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('emits once on Priority 4 (broadcast)', async () => {
      component.selectedSender = null;
      component.selectedAgents = [];
      component.userInput = 'broadcast';

      await component.sendMessage();

      expect(chatServiceMock.emitJustSent).toHaveBeenCalledOnceWith('1700000000000');
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id', 'broadcast',
      );
    });

    // Story 33-1 replaced the team-stopped early return with restore-then-send:
    // a stopped team now restarts and the key is emitted after the dispatch.
    it('emits once on a stopped team, after the restore resolves', async () => {
      runningSubject.next(false);
      component.selectedAgents = [];
      component.userInput = 'restore then send';

      await component.sendMessage();

      expect(contextServiceStub.restoreTeamAndAwait).toHaveBeenCalledOnceWith(
        'test-team-id',
      );
      expect(chatServiceMock.emitJustSent).toHaveBeenCalledOnceWith('1700000000000');
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id', 'restore then send',
      );
    });

    it('does NOT emit on the empty/whitespace input guard', async () => {
      component.selectedAgents = [];
      component.userInput = '   ';

      await component.sendMessage();

      expect(chatServiceMock.emitJustSent).not.toHaveBeenCalled();
    });

    it('does NOT emit on the no-candidate-recipient guard (Priority 2 edge)', async () => {
      component.dropdownAgents = [];
      component.selectedSender = '@Support';
      component.selectedAgents = [];
      component.userInput = 'orphan';

      await component.sendMessage();

      expect(chatServiceMock.emitJustSent).not.toHaveBeenCalled();
      expect(apiServiceSpy.sendMessageFromTo).not.toHaveBeenCalled();
      expect(component.userInput).toBe('orphan');
    });
  });

  // -------------------------------------------------------------------------
  // Story 33-1 (ADR-024 §2) — restore-then-send on a stopped team
  // -------------------------------------------------------------------------
  describe('restore-then-send (Story 33-1)', () => {
    // `deferredRestore`, `timeoutError` and `submitButton` are shared with the
    // Story 33-3 block below and live in the outer scope.

    // --- AC #5 — the submit gate no longer depends on run state -----------

    it('(AC5) submit control is ENABLED with a stopped team and non-empty text', () => {
      runningSubject.next(false);
      component.userInput = 'typed while stopped';
      fixture.detectChanges();

      expect(submitButton().disabled).toBeFalsy();
    });

    it('(AC5) submit control stays DISABLED with empty text, stopped or running', () => {
      runningSubject.next(false);
      component.userInput = '';
      fixture.detectChanges();
      expect(submitButton().disabled).toBeTruthy();

      runningSubject.next(true);
      fixture.detectChanges();
      expect(submitButton().disabled).toBeTruthy();
    });

    it('(AC5) sendMessage() still returns early on empty/whitespace text with a stopped team', async () => {
      runningSubject.next(false);
      component.userInput = '   ';

      await component.sendMessage();

      expect(contextServiceStub.restoreTeamAndAwait).not.toHaveBeenCalled();
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
      expect(component.userInput).toBe('   ');
    });

    // --- AC #6 — restore BEFORE send, once each ---------------------------

    it('(AC6) stopped team: restoreTeamAndAwait resolves BEFORE any send, once each', async () => {
      const { release } = deferredRestore();
      runningSubject.next(false);
      component.selectedAgents = [];
      component.userInput = 'hello stopped team';

      const pending = component.sendMessage();

      expect(contextServiceStub.restoreTeamAndAwait).toHaveBeenCalledOnceWith(
        'test-team-id',
      );
      // The dispatch has NOT happened while the restore is in flight.
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();

      release();
      await pending;

      expect(contextServiceStub.restoreTeamAndAwait).toHaveBeenCalledTimes(1);
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id', 'hello stopped team',
      );
      expect(component.userInput).toBe('');
    });

    // --- AC #7 — running team is untouched --------------------------------

    it('(AC7) running team: sends with NO restore call', async () => {
      runningSubject.next(true);
      component.selectedAgents = [];
      component.userInput = 'hello running team';

      await component.sendMessage();

      expect(contextServiceStub.restoreTeamAndAwait).not.toHaveBeenCalled();
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id', 'hello running team',
      );
    });

    // --- AC #8 — run state read once, never re-used as a send gate --------

    it('(AC8) run state is consulted exactly once per submit', async () => {
      runningSubject.next(false);
      component.selectedAgents = [];
      component.userInput = 'count the reads';

      runStateReads = 0;
      await component.sendMessage();

      expect(runStateReads).toBe(1);
    });

    it('(AC8) dispatches even when the restore resolves without the flag flipping', async () => {
      // The double resolves but leaves currentTeamRunning$ at false — the shape
      // a re-read of the captured/live value as a send gate would swallow.
      runningSubject.next(false);
      component.selectedAgents = [];
      component.userInput = 'no stale gate';

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id', 'no stale gate',
      );
      expect(runningSubject.value).toBeFalse();
    });

    // --- AC #9 — busy state and re-entry ----------------------------------

    it('(AC9) shows the "Restarting team…" busy state while restoring, then reverts', async () => {
      const { release } = deferredRestore();
      runningSubject.next(false);
      component.userInput = 'busy while restoring';

      const pending = component.sendMessage();
      fixture.detectChanges();

      expect(component.phase).toBe('restarting');
      expect(submitButton().label).toBe('Restarting team…');
      expect(submitButton().loading).toBeTrue();
      expect(submitButton().disabled).toBeTruthy();

      // The state is TRANSIENT, and only the rendered control proves it: release
      // the restore, drain the send, and the button must be Submit again with no
      // spinner. Leaving the restore un-released would also abandon a pending
      // promise for the rest of the run.
      release();
      await pending;
      fixture.detectChanges();

      expect(component.phase).toBe('idle');
      expect(submitButton().label).toBe('Submit');
      expect(submitButton().loading).toBeFalse();
    });

    it('(AC9) a second submit during an in-flight restore is rejected, not queued', async () => {
      const { release } = deferredRestore();
      runningSubject.next(false);
      component.selectedAgents = [];
      component.userInput = 'only once';

      const first = component.sendMessage();
      await component.sendMessage();

      expect(contextServiceStub.restoreTeamAndAwait).toHaveBeenCalledTimes(1);
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
      // userInput survives the whole restore window untouched.
      expect(component.userInput).toBe('only once');

      release();
      await first;

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledTimes(1);
      expect(contextServiceStub.restoreTeamAndAwait).toHaveBeenCalledTimes(1);
    });

    // Story 33-3 AC #8, success path: the phase returns to idle after a
    // restore-then-send that worked, and the next submit is accepted.
    it('(33-3 AC8) a successful restore-then-send ends idle and accepts the next submit', async () => {
      runningSubject.next(false);
      component.selectedAgents = [];
      component.userInput = 'clears busy';

      await component.sendMessage();

      expect(component.phase).toBe('idle');
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledTimes(1);

      component.userInput = 'and again';
      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledTimes(2);
      expect(component.phase).toBe('idle');
    });

    // --- AC #10 — failure and timeout -------------------------------------

    it('(AC10) a timed-out restore issues no send, preserves userInput, clears busy, and toasts', async () => {
      contextServiceStub.restoreTeamAndAwait.and.returnValue(
        Promise.reject(timeoutError()),
      );
      runningSubject.next(false);
      component.selectedAgents = [];
      component.userInput = 'kept verbatim';

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
      expect(apiServiceSpy.sendMessageFromTo).not.toHaveBeenCalled();
      expect(component.userInput).toBe('kept verbatim');
      expect(component.phase).toBe('idle');
      expect(messageServiceSpy.add).toHaveBeenCalledTimes(1);
      expect(messageServiceSpy.add.calls.mostRecent().args[0].severity).toBe(
        'error',
      );
      // Keyless: app.component.html mounts a single keyless <p-toast>, and
      // PrimeNG drops a message whose key does not match the mount's.
      expect(messageServiceSpy.add.calls.mostRecent().args[0].key).toBeUndefined();
    });

    it('(AC10) an HTTP failure issues no send and does NOT raise a second toast', async () => {
      contextServiceStub.restoreTeamAndAwait.and.returnValue(
        Promise.reject(new HttpError('Restore failed', 500, null)),
      );
      runningSubject.next(false);
      component.selectedAgents = [];
      component.userInput = 'http failed';

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
      expect(component.userInput).toBe('http failed');
      expect(component.phase).toBe('idle');
      // FetchService already toasted this one — a second toast would double up.
      expect(messageServiceSpy.add).not.toHaveBeenCalled();
    });

    it('(AC10) a retry after a failed restore is accepted', async () => {
      contextServiceStub.restoreTeamAndAwait.and.returnValue(
        Promise.reject(timeoutError()),
      );
      runningSubject.next(false);
      component.selectedAgents = [];
      component.userInput = 'retry me';

      await component.sendMessage();

      contextServiceStub.restoreTeamAndAwait.and.returnValue(Promise.resolve());
      await component.sendMessage();

      expect(contextServiceStub.restoreTeamAndAwait).toHaveBeenCalledTimes(2);
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id', 'retry me',
      );
    });

    // --- AC #11 — no ingestion re-init ------------------------------------

    it('(AC11) a stopped-team restore-then-send never invokes ingestionService.init', async () => {
      runningSubject.next(false);
      component.selectedAgents = [];
      component.userInput = 'no re-init';

      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledTimes(1);
      expect(ingestionInitSpy).not.toHaveBeenCalled();
    });

    // --- AC #12 — justSentKey captured after the restore ------------------

    it('(AC12) captures the send-origin key only AFTER the restore resolves', async () => {
      const keySpy = spyOn<any>(component, 'nextJustSentKey').and.returnValue(
        '1700000000000',
      );
      const { release } = deferredRestore();
      runningSubject.next(false);
      component.selectedAgents = [];
      component.userInput = 'fresh key';

      const pending = component.sendMessage();

      expect(keySpy).not.toHaveBeenCalled();

      release();
      await pending;

      expect(keySpy).toHaveBeenCalledTimes(1);
      expect(chatServiceMock.emitJustSent).toHaveBeenCalledOnceWith('1700000000000');
    });

    it('(AC12) emits nothing on the failed-restore path', async () => {
      spyOn<any>(component, 'nextJustSentKey').and.returnValue('1700000000000');
      contextServiceStub.restoreTeamAndAwait.and.returnValue(
        Promise.reject(timeoutError()),
      );
      runningSubject.next(false);
      component.selectedAgents = [];
      component.userInput = 'never emitted';

      await component.sendMessage();

      expect(chatServiceMock.emitJustSent).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Story 33-3 (FR10-FR13) — ONE submit-phase state closes the double-send
  // window. Story 33-1's `restoring` flag was cleared when the RESTORE settled,
  // not when the SUBMIT completed, so for the whole of the awaited POST loop the
  // guard was open and the input still populated: a second click or Enter press
  // re-sent the same message.
  // -------------------------------------------------------------------------
  describe('submit phase (Story 33-3)', () => {
    /** A dispatch double the spec releases by hand, so "during the dispatch" —
     *  the window this story closes — is observable rather than inferred. */
    function deferredSend(): { release: () => void } {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      apiServiceSpy.sendMessage.and.returnValue(pending);
      return { release };
    }

    /** One macrotask drains every pending microtask, so these specs never
     *  depend on counting the `await` ticks inside `sendMessage()`. */
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    function textareaEl() {
      return fixture.debugElement.query(By.css('textarea'));
    }

    // --- AC #5 — the decisive regression: the window is shut ---------------

    it('(AC5) a second submit while the dispatch is in flight sends nothing extra', async () => {
      const { release } = deferredSend();
      runningSubject.next(false);
      component.selectedAgents = [];
      component.userInput = 'exactly once';

      const first = component.sendMessage();
      await flush();

      // Restore done, dispatch pending — the window story 33-1 left open. The
      // phase says so, which `restoring` could not: it read false here.
      expect(apiServiceSpy.sendMessage).toHaveBeenCalledTimes(1);
      expect(component.phase).toBe('sending');

      // NEVER await the re-entrant submit: `and.returnValue` hands out the SAME
      // pending promise on every call, so a submit that slipped past the guard
      // would await it and hang the run instead of reddening the assertion.
      void component.sendMessage();
      await flush();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledTimes(1);
      // `emitJustSent` follows the awaited POST, so mid-window it has not fired
      // yet — with or without the guard. The discriminating count is after the
      // release: a re-entrant submit that got through emits a second time.
      expect(chatServiceMock.emitJustSent).not.toHaveBeenCalled();

      release();
      await first;

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledTimes(1);
      expect(chatServiceMock.emitJustSent).toHaveBeenCalledTimes(1);
      expect(component.phase).toBe('idle');
    });

    // --- AC #6 — the same assertion driven through the keyboard -----------

    it('(AC6) Enter while the dispatch is in flight sends nothing extra, and the control reads disabled', async () => {
      const { release } = deferredSend();
      runningSubject.next(false);
      component.selectedAgents = [];
      // The config default is false; the keyboard path only exists when on.
      component.userInputEnterKeySubmit = true;
      component.userInput = 'once via keyboard';

      const first = component.sendMessage();
      await flush();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledTimes(1);
      expect(component.phase).toBe('sending');

      // The DOM gate covers the click affordance...
      fixture.detectChanges();
      expect(submitButton().disabled).toBeTruthy();

      // ...and only the TS early return covers the key: `[disabled]` does not
      // gate `(keydown.enter)`, which invokes sendMessage() directly.
      textareaEl().triggerEventHandler('keydown.enter', {});
      await flush();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledTimes(1);

      release();
      await first;

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledTimes(1);
      expect(chatServiceMock.emitJustSent).toHaveBeenCalledTimes(1);
    });

    // --- AC #2 / #9 — ONE derived predicate, and only one state -----------

    it('(AC2) a non-idle phase rejects the submit outright: no restore, no send, no emit, input intact', async () => {
      runningSubject.next(false);
      component.selectedAgents = [];
      component.userInput = 'not this time';
      component.phase = 'sending';

      await component.sendMessage();

      expect(component.busy).toBeTrue();
      expect(contextServiceStub.restoreTeamAndAwait).not.toHaveBeenCalled();
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
      expect(apiServiceSpy.sendMessageFromTo).not.toHaveBeenCalled();
      expect(chatServiceMock.emitJustSent).not.toHaveBeenCalled();
      expect(component.userInput).toBe('not this time');
    });

    it('(AC9) the component carries no second busy flag beside the phase', () => {
      // `restoring` is gone, not kept alongside a new `sending`: two flags that
      // must never disagree is the invariant this story exists to delete, and
      // reintroducing either one turns this red.
      expect('restoring' in component).toBeFalse();
      expect('sending' in component).toBeFalse();
      // `busy` is derived, never stored.
      expect(Object.prototype.hasOwnProperty.call(component, 'busy')).toBeFalse();
      expect(component.phase).toBe('idle');
      expect(component.busy).toBeFalse();
    });

    // --- AC #3 — the two busy phases are distinguishable -------------------

    it('(AC3) the restarting phase renders the restart label, a spinner and a disabled control', async () => {
      const { release } = deferredRestore();
      runningSubject.next(false);
      component.selectedAgents = [];
      component.userInput = 'restarting look';

      const pending = component.sendMessage();
      fixture.detectChanges();

      expect(component.phase).toBe('restarting');
      expect(submitButton().label).toBe('Restarting team…');
      expect(submitButton().loading).toBeTrue();
      expect(submitButton().disabled).toBeTruthy();

      release();
      await pending;
    });

    it('(AC3) the sending phase renders the Submit label, a spinner and a disabled control', async () => {
      const { release } = deferredSend();
      runningSubject.next(true);
      component.selectedAgents = [];
      component.userInput = 'sending look';

      const pending = component.sendMessage();
      await flush();
      fixture.detectChanges();

      expect(component.phase).toBe('sending');
      expect(submitButton().label).toBe('Submit');
      expect(submitButton().loading).toBeTrue();
      expect(submitButton().disabled).toBeTruthy();

      release();
      await pending;
    });

    it('(AC3) the idle phase with text renders Submit, no spinner, enabled', () => {
      component.userInput = 'at rest';
      fixture.detectChanges();

      expect(component.phase).toBe('idle');
      expect(submitButton().label).toBe('Submit');
      expect(submitButton().loading).toBeFalse();
      expect(submitButton().disabled).toBeFalsy();
    });

    // --- AC #8 — every exit path ends idle, and the next submit is taken ---

    it('(AC8) the empty/whitespace guard never leaves idle and the next submit is accepted', async () => {
      runningSubject.next(false);
      component.selectedAgents = [];
      component.userInput = '   ';

      await component.sendMessage();

      expect(component.phase).toBe('idle');
      expect(contextServiceStub.restoreTeamAndAwait).not.toHaveBeenCalled();
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
      expect(component.userInput).toBe('   ');

      component.userInput = 'real text';
      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledTimes(1);
      expect(component.phase).toBe('idle');
    });

    it('(AC8) a rejected restore ends idle with the input preserved, and the retry is accepted', async () => {
      contextServiceStub.restoreTeamAndAwait.and.returnValue(
        Promise.reject(timeoutError()),
      );
      runningSubject.next(false);
      component.selectedAgents = [];
      component.userInput = 'survives the failure';

      await component.sendMessage();

      expect(component.phase).toBe('idle');
      expect(apiServiceSpy.sendMessage).not.toHaveBeenCalled();
      expect(component.userInput).toBe('survives the failure');

      contextServiceStub.restoreTeamAndAwait.and.returnValue(Promise.resolve());
      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledOnceWith(
        'test-team-id', 'survives the failure',
      );
      expect(component.phase).toBe('idle');
    });

    it('(AC8) a dispatch that finds no candidate recipient ends idle with the input preserved', async () => {
      // Priority-2 edge: a sender is chosen, nothing to send it to.
      runningSubject.next(true);
      component.dropdownAgents = [];
      component.selectedSender = '@Support';
      component.selectedAgents = [];
      component.userInput = 'orphan';

      await component.sendMessage();

      expect(component.phase).toBe('idle');
      expect(apiServiceSpy.sendMessageFromTo).not.toHaveBeenCalled();
      expect(chatServiceMock.emitJustSent).not.toHaveBeenCalled();
      expect(component.userInput).toBe('orphan');

      // A recipient appears: the very next submit goes through.
      component.dropdownAgents = [{ label: 'Worker', value: '@Worker' }];
      await component.sendMessage();

      expect(apiServiceSpy.sendMessageFromTo).toHaveBeenCalledOnceWith(
        'test-team-id', '@Support', '@Worker', 'orphan',
      );
      expect(component.phase).toBe('idle');
    });

    // The exit path only a `finally` covers: the POST REJECTS rather than
    // returning. AC #8's four paths all leave the try by `return`, so a
    // trailing `this.phase = 'idle'` on the success path would still satisfy
    // them for the throw — and would strand the control non-idle forever,
    // spinner up and input dead, until a page reload. Story 33-5 makes a
    // network failure throw here by default, so this is the shape that matters.
    it('(AC8) a rejected dispatch ends idle, and the retry is accepted', async () => {
      const failure = new Error('network down');
      apiServiceSpy.sendMessage.and.returnValue(Promise.reject(failure));
      runningSubject.next(true);
      component.selectedAgents = [];
      component.userInput = 'sent into a hole';

      await expectAsync(component.sendMessage()).toBeRejectedWith(failure);

      expect(component.phase).toBe('idle');
      expect(component.busy).toBeFalse();
      expect(chatServiceMock.emitJustSent).not.toHaveBeenCalled();
      // The text is NOT cleared: `this.userInput = ''` never ran.
      expect(component.userInput).toBe('sent into a hole');

      // The control is live again, and the retry actually dispatches.
      fixture.detectChanges();
      expect(submitButton().disabled).toBeFalsy();

      apiServiceSpy.sendMessage.and.returnValue(Promise.resolve());
      await component.sendMessage();

      expect(apiServiceSpy.sendMessage).toHaveBeenCalledTimes(2);
      expect(chatServiceMock.emitJustSent).toHaveBeenCalledTimes(1);
      expect(component.phase).toBe('idle');
    });
  });
});
