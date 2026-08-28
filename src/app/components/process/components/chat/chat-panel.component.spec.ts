import {
  ComponentFixture,
  fakeAsync,
  flush,
  flushMicrotasks,
  TestBed,
  tick,
} from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { BehaviorSubject, of, Subject } from 'rxjs';
import { map } from 'rxjs/operators';
import { MessageService } from 'primeng/api';
import { provideMarkdown } from 'ngx-markdown';

import { ChatPanelComponent } from './chat-panel.component';
import {
  chatFold,
  ChatService,
  computePendingNotifications,
  ThinkingState,
} from '../../selectors/chat.selector';
import { SelectionService } from '../../ui-state/selection.service';
import { ActorAddress, EventMessage, HandledMessage, ReceivedMessage, SentMessage, AkgenticMessage, StartMessage, isSentMessage } from '../../../../protocol/message.types';
import { ChatMessage, classifyMessage } from '../../selectors/chat-message.model';
import { ApiService } from '../../../../core/http/api.service';
import { AkgentService } from '../../../../core/ui/akgent.service';
import { GraphDataService } from '../../selectors/graph.selector';
import { NodeInterface } from '../../models/types';
import { ContextService } from '../../../../core/context/context.service';
import { IngestionService } from '../../event/ingestion.service';

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

function makeSentMessage(
  sender: Partial<ActorAddress>,
  recipient: Partial<ActorAddress>,
  content: string = 'test',
  id: string = 'msg-1',
  parentId: string | null = null,
): SentMessage {
  // Mirror the real backend contract: `parent_id` on the INNER BaseMessage
  // references the INNER id of the parent (`inner-<parentId>`), not the
  // outer envelope id. This is what `HumanProxy` produces on real replies
  // (see team_service.py#process_human_input → HumanProxy sets
  // `_current_message = event.message` before send()).
  const innerParentId = parentId === null ? null : 'inner-' + parentId;
  return {
    id,
    parent_id: parentId,
    team_id: 'team-1',
    timestamp: '2026-04-08T10:00:00Z',
    sender: makeAddress(sender),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.SentMessage',
    message: {
      id: 'inner-' + id,
      parent_id: innerParentId,
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
  // Story 19-1 (ADR-016): just-sent side channel feed.
  let justSentSubject: Subject<string>;
  /** Graph nodes feed — the reader's agent list is this list (Epic 51). */
  let nodesSubject: BehaviorSubject<NodeInterface[]>;
  /** The app-wide selected agent, which the reader follows (Epic 51). */
  let selectedAkgentSubject: BehaviorSubject<any>;

  beforeEach(async () => {
    messagesSubject = new BehaviorSubject<AkgenticMessage[]>([]);
    justSentSubject = new Subject<string>();
    nodesSubject = new BehaviorSubject<NodeInterface[]>([]);
    selectedAkgentSubject = new BehaviorSubject<any>(null);

    // Story 6.4 (AC3): `ChatPanelComponent` no longer injects
    // `IngestionService`. The spec feeds SentMessages via
    // `messagesSubject` and projects them through the same classification
    // `chatFold` performs in production — the component now reads the
    // derived `chatService.messages$` directly.
    const classifiedMessages$ = messagesSubject.pipe(
      map((msgs: AkgenticMessage[]) =>
        msgs
          .filter(isSentMessage)
          .filter((m) => m.sender.role !== 'ActorSystem')
          .filter((m) => m.message.content != null && m.message.content !== '')
          .map((m) => classifyMessage(m)),
      ),
    );
    const thinkingAgentsSubj = new BehaviorSubject<ThinkingState[]>([]);
    const chatService = {
      messages$: classifiedMessages$,
      pendingNotifications$: classifiedMessages$.pipe(
        map(computePendingNotifications),
      ),
      thinkingAgents$: thinkingAgentsSubj,
      justSent$: justSentSubject.asObservable(),
      emitJustSent: (key: string) => justSentSubject.next(key),
    };

    const selectionService = jasmine.createSpyObj('SelectionService', [
      'handleSelection',
    ]);

    const apiService = jasmine.createSpyObj('ApiService', ['sendMessage', 'processHumanInput']);
    apiService.sendMessage.and.returnValue(Promise.resolve());
    apiService.processHumanInput.and.returnValue(Promise.resolve());

    const akgentService = {
      selectedAkgent$: selectedAkgentSubject,
    };

    const graphDataService = {
      nodes$: nodesSubject,
    };

    // Story 15-1 (ADR-013) / Epic 17 (ADR-014): the embedded <app-user-input>
    // injects IngestionService for its `commands` PerAgentStore (the `/`
    // mention store). Story 17-3 removed the bespoke `commandsByAgent$`; this
    // stub mirrors the current surface — a `commands`-shaped object exposing
    // `snapshot(id)` (returns `[]` here: the empty-selection scenarios in this
    // spec short-circuit before any command lookup).
    const ingestionService = {
      commands: { snapshot: (_id: string) => [] as any[] },
      // Epic 18 (ADR-015 §2): the spinner state moved off ChatService onto
      // IngestionService; the component now reads `loadingProcess$` from here.
      loadingProcess$: new BehaviorSubject<boolean>(false),
    };

    await TestBed.configureTestingModule({
      imports: [ChatPanelComponent, NoopAnimationsModule],
      providers: [
        provideMarkdown(),
        { provide: ChatService, useValue: chatService },
        { provide: SelectionService, useValue: selectionService },
        { provide: ApiService, useValue: apiService },
        { provide: AkgentService, useValue: akgentService },
        { provide: GraphDataService, useValue: graphDataService },
        { provide: IngestionService, useValue: ingestionService },
        // The nested <app-user-input> raises its own restore-failure toast
        // (Story 33-1), so the child needs the PrimeNG toast service present.
        MessageService,
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatPanelComponent);
    component = fixture.componentInstance;
    component.processId = 'test-team';
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should pass chatService.messages$ through to this.chatMessages', () => {
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
      message_id: 'msg-1',
      parent_id: null,
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

  // --- the sub-agent conversation reader (Epic 51) ---------------------------
  //
  // The panel is the reader's HOST, not its implementation: it opens it, feeds
  // it the log and the team it already has, and routes every agent choice
  // through the app's one selection path.
  describe('sub-agent conversation reader', () => {
    function makeAgentTurn(): ChatMessage {
      return {
        id: 'msg-1',
        message_id: 'msg-1',
        parent_id: null,
        content: 'test',
        sender: makeAddress({ name: '@Manager', agent_id: 'mgr-1' }),
        recipient: makeAddress({ name: '@Human' }),
        timestamp: new Date(),
        rule: 2,
        alignment: 'left',
        color: 'transparent',
        collapsed: false,
        label: 'Manager ⇒ You',
      };
    }

    it('opens on the agent whose identity badge was clicked', () => {
      expect(component.readerVisible).toBe(false);
      component.onMessageSelected(makeAgentTurn());
      expect(component.readerVisible).toBe(true);
    });

    it('takes its agent list from the graph nodes, not a list of its own', () => {
      const nodes: NodeInterface[] = [
        {
          name: 'mgr-1',
          role: 'Manager',
          actorName: '@Manager',
          parentId: '',
          squadId: 'squad-1',
          symbol: 'roundRect',
          category: 0,
          userMessage: false,
        },
      ];
      nodesSubject.next(nodes);
      expect(component.readerAgents).toBe(nodes);
    });

    it('follows the app selection rather than keeping its own', () => {
      // T3: `SelectionService` already drives the agent tabs. A reader with a
      // second notion of "selected" would leave the two disagreeing the moment
      // it closes.
      selectedAkgentSubject.next({ agentId: 'worker-1', name: '@Worker' });
      expect(component.readerSelectedAgentId).toBe('worker-1');
      selectedAkgentSubject.next(null);
      expect(component.readerSelectedAgentId).toBeNull();
    });

    it('routes a pick from the reader through the ONE selection path', () => {
      component.onReaderAgentSelected({
        agentId: 'worker-1',
        actorName: '@Worker',
      });
      const selSvc = TestBed.inject(SelectionService);
      expect(selSvc.handleSelection).toHaveBeenCalledWith({
        type: 'message',
        data: { name: 'worker-1', actorName: '@Worker' },
      });
    });

    it('carries no graph node into the selection, so no reply box can open', () => {
      // NFR1: `SelectionService` opens the human-input dialog for a selectable
      // that carries `humanRequests`. Reading an agent must never be a write.
      component.onReaderAgentSelected({
        agentId: 'worker-1',
        actorName: '@Worker',
      });
      const selSvc = TestBed.inject(SelectionService);
      const arg = (selSvc.handleSelection as jasmine.Spy).calls.mostRecent()
        .args[0];
      expect(arg.data.humanRequests).toBeUndefined();
    });

    it('leaves the conversation untouched when it closes', () => {
      const sent = makeSentMessage(
        { name: '@Manager', role: 'Manager', agent_id: 'mgr-1' },
        { name: '@Worker', role: 'Worker', agent_id: 'worker-1' },
        'agent to agent',
        'm-1',
      );
      messagesSubject.next([sent]);
      fixture.detectChanges();
      const before = component.chatMessages.map((m) => ({
        id: m.id,
        collapsed: m.collapsed,
      }));

      component.onMessageSelected(makeAgentTurn());
      component.onReaderVisibleChange(false);
      fixture.detectChanges();

      expect(component.readerVisible).toBe(false);
      expect(
        component.chatMessages.map((m) => ({ id: m.id, collapsed: m.collapsed })),
      ).toEqual(before);
    });
  });

  it('trackById should return message id', () => {
    const chatMsg = { id: 'abc-123' } as ChatMessage;
    expect(component.trackById(0, chatMsg)).toBe('abc-123');
  });

  // Story 6.3 (Task 6.1 / AC2): the test that asserted
  // `chatService.messages$.value` after the component pushed classified
  // messages is retired. `chatService.messages$` is now a read-only derived
  // observable over `MessageLogService.log$`; `chatFold` owns the
  // classification. Coverage moved to `chat.service.spec.ts`.

  describe('bubble selection (Story 4-11 — routing retired)', () => {
    it('onBubbleClicked should update selectedMessageId only (no chatService call)', () => {
      const chatMsg: ChatMessage = {
        id: 'msg-reply',
        message_id: 'msg-reply',
        parent_id: null,
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
      const svc = TestBed.inject(ChatService) as any;
      // The retired API must not be present on the service mock.
      expect(svc.setReplyContext).toBeUndefined();
      expect(svc.replyContext$).toBeUndefined();

      component.onBubbleClicked(chatMsg);
      expect(component.selectedMessageId).toBe('msg-reply');
    });

    it('onBackgroundClick should clear selectedMessageId locally', () => {
      component.selectedMessageId = 'msg-abc';
      component.onBackgroundClick();
      expect(component.selectedMessageId).toBeNull();
    });

    it('onEscapePress should clear selectedMessageId locally', () => {
      component.selectedMessageId = 'msg-abc';
      component.onEscapePress();
      expect(component.selectedMessageId).toBeNull();
    });

    it('clicking different bubble should switch selectedMessageId', () => {
      const msg1: ChatMessage = {
        id: 'msg-1',
        message_id: 'msg-1',
        parent_id: null,
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
        message_id: 'msg-2',
        parent_id: null,
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

    it('onRule3Clicked opens modal with answered-only history (no pending)', () => {
      // A Rule 3 message that has been replied to — now opens modal in
      // read-only mode (Story 4-7 AC6 early-return change).
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
        'r3-1',
      );
      messagesSubject.next([rule3Msg, replyMsg]);
      fixture.detectChanges();

      const chatMsg = component.chatMessages.find(m => m.id === 'r3-1')!;
      component.onRule3Clicked(chatMsg);

      expect(component.modalVisible).toBe(true);
      expect(component.modalPendingMessages.length).toBe(0);
      expect(component.modalAnsweredMessages.length).toBe(1);
      expect(component.modalAnsweredMessages[0].request.id).toBe('r3-1');
    });

    it('onRule3Clicked with two pending in the same pair opens modal with both (AC #8)', () => {
      const r3a = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'first',
        'r3-pair-1',
      );
      const r3b = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'second',
        'r3-pair-2',
      );
      messagesSubject.next([r3a, r3b]);
      fixture.detectChanges();

      const chatMsg = component.chatMessages.find(m => m.id === 'r3-pair-1')!;
      component.onRule3Clicked(chatMsg);

      expect(component.modalVisible).toBe(true);
      expect(component.modalPendingMessages.length).toBe(2);
    });

    it('onRule3Clicked after one reply opens modal with single still-pending message (AC #8)', () => {
      const r3a = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'first',
        'r3-after-1',
      );
      const r3b = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'second',
        'r3-after-2',
      );
      const reply = makeSentMessage(
        { name: '@QATester', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'answering first',
        'reply-after-1',
        'r3-after-1',
      );
      messagesSubject.next([r3a, r3b, reply]);
      fixture.detectChanges();

      const stillPending = component.chatMessages.find(m => m.id === 'r3-after-2')!;
      component.onRule3Clicked(stillPending);

      expect(component.modalVisible).toBe(true);
      expect(component.modalPendingMessages.length).toBe(1);
      expect(component.modalPendingMessages[0].id).toBe('r3-after-2');
    });

    it('onModalReply should call processHumanInput and KEEP modal open (Story 4-7 AC3)', () => {
      component.processId = 'team-42';
      component.modalVisible = true;
      component.modalAgentPair = {
        sender: makeAddress({ name: '@Manager' }),
        recipient: makeAddress({ name: '@QATester' }),
      };
      const dummyMsg: ChatMessage = {
        id: 'msg-123', message_id: 'inner-msg-123', parent_id: null, content: 'test',
        sender: makeAddress({ name: '@Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
        timestamp: new Date(), rule: 3, alignment: 'left', color: '#9ebbcb',
        collapsed: false, label: 'Manager ⇒ QATester',
      };
      component.modalPendingMessages = [dummyMsg];
      component.modalAnsweredMessages = [];

      component.onModalReply({ content: 'approved', messageId: 'msg-123' });

      const api = TestBed.inject(ApiService) as any;
      expect(api.processHumanInput).toHaveBeenCalledWith('team-42', 'approved', 'msg-123');
      // Modal stays open — reclassification is handled by recomputeModalInputs.
      expect(component.modalVisible).toBe(true);
      expect(component.modalAgentPair).not.toBeNull();
      expect(component.modalPendingMessages).toEqual([dummyMsg]);
    });

    it('onModalVisibleChange should update modalVisible and clear ALL state when closed', () => {
      component.modalVisible = true;
      component.modalAgentPair = {
        sender: makeAddress({ name: '@Manager' }),
        recipient: makeAddress({ name: '@QATester' }),
      };
      const dummyMsg: ChatMessage = {
        id: 'msg-1', message_id: 'inner-msg-1', parent_id: null, content: 'test',
        sender: makeAddress({ name: '@Manager' }),
        recipient: makeAddress({ name: '@QATester', role: 'Human' }),
        timestamp: new Date(), rule: 3, alignment: 'left', color: '#9ebbcb',
        collapsed: false, label: 'Manager ⇒ QATester',
      };
      const dummyReq: ChatMessage = { ...dummyMsg, id: 'req-1', message_id: 'inner-req-1' };
      const dummyReply: ChatMessage = {
        ...dummyMsg, id: 'reply-1', message_id: 'inner-reply-1', parent_id: 'inner-req-1',
      };
      component.modalPendingMessages = [dummyMsg];
      component.modalAnsweredMessages = [{ request: dummyReq, reply: dummyReply }];
      component.onModalVisibleChange(false);
      expect(component.modalVisible).toBe(false);
      expect(component.modalAgentPair).toBeNull();
      expect(component.modalPendingMessages).toEqual([]);
      expect(component.modalAnsweredMessages).toEqual([]);
    });
  });

  describe('Story 4-7: modal answered wiring + reactive recompute', () => {
    it('onRule3Clicked populates BOTH modalPendingMessages AND modalAnsweredMessages', () => {
      // Two pending and one already-answered pair in the same pair.
      const r3a = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'pending-1',
        'r3-pend-1',
      );
      const r3b = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'pending-2',
        'r3-pend-2',
      );
      const r3answered = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'answered',
        'r3-answered',
      );
      const reply = makeSentMessage(
        { name: '@QATester', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'done',
        'reply-answered',
        'r3-answered',
      );
      messagesSubject.next([r3answered, reply, r3a, r3b]);
      fixture.detectChanges();

      const pending = component.chatMessages.find((m) => m.id === 'r3-pend-1')!;
      component.onRule3Clicked(pending);

      expect(component.modalVisible).toBe(true);
      expect(component.modalPendingMessages.length).toBe(2);
      expect(component.modalAnsweredMessages.length).toBe(1);
      expect(component.modalAnsweredMessages[0].request.id).toBe('r3-answered');
      expect(component.modalAnsweredMessages[0].reply.id).toBe('reply-answered');
    });

    it('reactive recompute: reply arriving while modal is open reclassifies lists', () => {
      const r3a = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'one',
        'r3-react-1',
      );
      const r3b = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'two',
        'r3-react-2',
      );
      messagesSubject.next([r3a, r3b]);
      fixture.detectChanges();

      const first = component.chatMessages.find((m) => m.id === 'r3-react-1')!;
      component.onRule3Clicked(first);
      expect(component.modalPendingMessages.length).toBe(2);
      expect(component.modalAnsweredMessages.length).toBe(0);

      // A reply to r3-react-1 arrives — without re-click, modal inputs must
      // reclassify.
      const reply = makeSentMessage(
        { name: '@QATester', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'answering',
        'reply-react-1',
        'r3-react-1',
      );
      messagesSubject.next([r3a, r3b, reply]);
      fixture.detectChanges();

      expect(component.modalVisible).toBe(true);
      expect(component.modalPendingMessages.length).toBe(1);
      expect(component.modalPendingMessages[0].id).toBe('r3-react-2');
      expect(component.modalAnsweredMessages.length).toBe(1);
      expect(component.modalAnsweredMessages[0].request.id).toBe('r3-react-1');
      expect(component.modalAnsweredMessages[0].reply.id).toBe('reply-react-1');
    });

    it('auto-closes modal when last pending is answered AND no answered entries remain', () => {
      // Single Rule 3 with no reply in play.
      const r3 = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'only',
        'r3-auto-1',
      );
      messagesSubject.next([r3]);
      fixture.detectChanges();

      const pending = component.chatMessages.find((m) => m.id === 'r3-auto-1')!;
      component.onRule3Clicked(pending);
      expect(component.modalVisible).toBe(true);

      // Force the edge case: no messages at all (both lists empty after
      // recompute). In practice a reply would produce an answered entry, but
      // this guards the defensive auto-close branch.
      messagesSubject.next([]);
      fixture.detectChanges();

      expect(component.modalVisible).toBe(false);
      expect(component.modalAgentPair).toBeNull();
      expect(component.modalPendingMessages).toEqual([]);
      expect(component.modalAnsweredMessages).toEqual([]);
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
      // Reply carries parent_id === r3-1 — per-message clearing requires this linkage.
      const replyMsg = makeSentMessage(
        { name: '@QATester', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'approved',
        'reply-1',
        'r3-1',
      );
      messagesSubject.next([rule3Msg, replyMsg]);
      fixture.detectChanges();

      const chatMsgR3 = component.chatMessages.find(m => m.id === 'r3-1')!;
      expect(component.hasNotification(chatMsgR3)).toBe(false);
    });

    it('two separate messages — one cleared, one still pending (AC #8)', () => {
      const r3First = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'first',
        'r3-1',
      );
      const r3Second = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@QATester', role: 'Human' },
        'second',
        'r3-2',
      );
      const reply = makeSentMessage(
        { name: '@QATester', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'answering first',
        'reply-1',
        'r3-1',
      );
      messagesSubject.next([r3First, r3Second, reply]);
      fixture.detectChanges();

      const msg1 = component.chatMessages.find(m => m.id === 'r3-1')!;
      const msg2 = component.chatMessages.find(m => m.id === 'r3-2')!;
      expect(component.hasNotification(msg1)).toBe(false);
      expect(component.hasNotification(msg2)).toBe(true);
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

      // 2. Reply arrives (simulating WebSocket message); parent_id points at r3-clear-1.
      const replyMsg = makeSentMessage(
        { name: '@QATester', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'approved',
        'reply-clear-1',
        'r3-clear-1',
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
        'r3-reappear-1',
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
        message_id: 'r1',
        parent_id: null,
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

  describe('Rule 6/7 marker collapse (Epic 29 / ADR-010)', () => {
    function makeMarker(overrides: Partial<ChatMessage>): ChatMessage {
      return {
        id: 'evt-1',
        message_id: 'evt-1',
        parent_id: null,
        content: 'summary body',
        sender: makeAddress({ name: '@Researcher', role: 'Worker' }),
        recipient: makeAddress({ name: '@Researcher', role: 'Worker' }),
        timestamp: new Date('2026-06-28T10:00:00Z'),
        rule: 6,
        alignment: 'left',
        color: '',
        collapsed: true,
        label: 'Summarized 8 messages',
        ...overrides,
      };
    }

    it('onToggleCollapse expands a Rule 6 marker and persists it across re-emission', () => {
      const marker = makeMarker({});
      component.onToggleCollapse(marker);
      expect(marker.collapsed).toBe(false);

      // The pure fold rebuilds the marker collapsed-by-default; onMessages must
      // re-apply the expanded override (same expandedMessageIds mechanism as
      // Rule 3/4).
      const rebuilt = makeMarker({ collapsed: true });
      (component as unknown as {
        onMessages: (c: ChatMessage[], t: ThinkingState[]) => void;
      }).onMessages([rebuilt], []);
      expect(rebuilt.collapsed).toBe(false);
    });

    it('onToggleCollapse ignores the Rule 7 clear marker (inert — no flip)', () => {
      const clear = makeMarker({
        id: 'evt-2',
        message_id: 'evt-2',
        rule: 7,
        collapsed: true,
        content: '',
        label: 'Conversation cleared (5 messages)',
      });
      component.onToggleCollapse(clear);
      expect(clear.collapsed).toBe(true);
    });
  });

  describe('displayItems merge (Story 4-8)', () => {
    function getThinkingSubj(): BehaviorSubject<ThinkingState[]> {
      const svc = TestBed.inject(ChatService) as any;
      return svc.thinkingAgents$ as BehaviorSubject<ThinkingState[]>;
    }

    function makeThinking(
      overrides: Partial<ThinkingState> = {},
    ): ThinkingState {
      return {
        agent_id: 'a1',
        agent_name: '@Researcher',
        start_time: new Date('2026-04-12T10:00:00Z'),
        tools: [],
        anchor_message_id: 'anchor-1',
        final: false,
        ...overrides,
      };
    }

    it('sorts a message and a thinking state chronologically', () => {
      const sent = makeSentMessage(
        { name: '@Human', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'later',
        'm-1',
      );
      sent.timestamp = '2026-04-12T10:00:10Z';
      messagesSubject.next([sent]);
      getThinkingSubj().next([
        makeThinking({
          start_time: new Date('2026-04-12T10:00:00Z'),
        }),
      ]);
      fixture.detectChanges();

      expect(component.displayItems.length).toBe(2);
      expect(component.displayItems[0].kind).toBe('thinking');
      expect(component.displayItems[1].kind).toBe('message');
    });

    it('ties (same timestamp) order messages BEFORE thinking bubbles', () => {
      const sent = makeSentMessage(
        { name: '@Human', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'sametime',
        'tie-1',
      );
      sent.timestamp = '2026-04-12T10:00:00Z';
      messagesSubject.next([sent]);
      getThinkingSubj().next([
        makeThinking({ start_time: new Date('2026-04-12T10:00:00Z') }),
      ]);
      fixture.detectChanges();

      expect(component.displayItems.length).toBe(2);
      expect(component.displayItems[0].kind).toBe('message');
      expect(component.displayItems[1].kind).toBe('thinking');
    });

    it('trackByDisplayItem produces stable keys across ephemeral → persistent transition', () => {
      const s1 = makeThinking({ final: false, anchor_message_id: 'anc-stable' });
      const key1 = component.trackByDisplayItem(0, { kind: 'thinking', data: s1 });
      const s2 = makeThinking({ final: true, anchor_message_id: 'anc-stable' });
      const key2 = component.trackByDisplayItem(0, { kind: 'thinking', data: s2 });
      expect(key1).toBe(key2);
    });

    it('trackByDisplayItem distinguishes message ids from thinking anchor ids', () => {
      const chatMsg: ChatMessage = {
        id: 'same-id',
        message_id: 'same-id',
        parent_id: null,
        content: 'x',
        sender: makeAddress({ name: '@A' }),
        recipient: makeAddress({ name: '@B' }),
        timestamp: new Date(),
        rule: 2,
        alignment: 'left',
        color: '#9ebbcb',
        collapsed: false,
        label: 'A ⇒ B',
      };
      const state = makeThinking({ anchor_message_id: 'same-id' });
      const k1 = component.trackByDisplayItem(0, {
        kind: 'message',
        data: chatMsg,
      });
      const k2 = component.trackByDisplayItem(0, { kind: 'thinking', data: state });
      expect(k1).not.toBe(k2);
    });

    it('loading$ DOM block is gone (no .thinking-animation inside .message-list)', () => {
      const sent = makeSentMessage(
        { name: '@Human', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'hello',
      );
      messagesSubject.next([sent]);
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const list = el.querySelector('.message-list');
      expect(list).not.toBeNull();
      expect(list!.querySelector('.thinking-animation')).toBeNull();
    });

    it('onToggleThinkingExpanded toggles the anchor id in the internal set', () => {
      component.onToggleThinkingExpanded('anc-1');
      const state = makeThinking({ anchor_message_id: 'anc-1' });
      expect(component.isThinkingExpanded(state)).toBe(true);
      component.onToggleThinkingExpanded('anc-1');
      expect(component.isThinkingExpanded(state)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Epic 54 — the transcript gets day separators.
  //
  // The arithmetic itself is proved in `day-separator.spec.ts` without a
  // fixture (NFR2). What is worth a fixture — and only what is worth one — is
  // the wiring: that the separator reaches the DOM, that it is NOT a message,
  // and that its track key is its day.
  //
  // Every timestamp here is built from LOCAL components and serialised, so
  // these expectations hold in any time zone the suite runs in.
  // -------------------------------------------------------------------------
  describe('day separators (Epic 54)', () => {
    function turnOn(
      id: string,
      year: number,
      month1: number,
      day: number,
      hour = 10,
    ): SentMessage {
      const sent = makeSentMessage(
        { name: '@Human', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        id,
        id,
      );
      sent.timestamp = new Date(year, month1 - 1, day, hour, 0, 0).toISOString();
      return sent;
    }

    function separatorTexts(): string[] {
      const el: HTMLElement = fixture.nativeElement;
      return Array.from(el.querySelectorAll('.day-separator')).map((n) =>
        (n.textContent ?? '').trim(),
      );
    }

    it('renders a rule where the calendar day changes (FR1)', () => {
      messagesSubject.next([turnOn('d1', 2026, 4, 8), turnOn('d2', 2026, 4, 9)]);
      fixture.detectChanges();

      expect(component.displayItems.map((i) => i.kind)).toEqual([
        'message',
        'day',
        'message',
      ]);
      expect(separatorTexts()).toEqual(['2026-04-09']);
    });

    it('puts no rule above the first turn (FR2)', () => {
      messagesSubject.next([turnOn('only', 2026, 4, 8)]);
      fixture.detectChanges();

      expect(component.displayItems.map((i) => i.kind)).toEqual(['message']);
      expect(separatorTexts()).toEqual([]);
    });

    it('does not repeat the rule within one day (FR3)', () => {
      messagesSubject.next([
        turnOn('a', 2026, 4, 8, 9),
        turnOn('b', 2026, 4, 9, 9),
        turnOn('c', 2026, 4, 9, 17),
      ]);
      fixture.detectChanges();

      expect(separatorTexts()).toEqual(['2026-04-09']);
    });

    it('does not let one undated turn split a day in two (FR4/FR5)', () => {
      const undated = turnOn('mid', 2026, 4, 8, 12);
      undated.timestamp = 'not a date';
      messagesSubject.next([
        turnOn('a', 2026, 4, 8, 9),
        undated,
        turnOn('c', 2026, 4, 8, 15),
      ]);
      fixture.detectChanges();

      expect(separatorTexts()).toEqual([]);
      expect(component.displayItems.length).toBe(3);
    });

    it('is not a message (NFR1)', () => {
      messagesSubject.next([turnOn('d1', 2026, 4, 8), turnOn('d2', 2026, 4, 9)]);
      fixture.detectChanges();

      // The classified stream — everything the scroll model, the pill and the
      // modal read — never sees it.
      expect(component.chatMessages.length).toBe(2);

      const el: HTMLElement = fixture.nativeElement;
      const separator = el.querySelector('.day-separator');
      expect(separator).not.toBeNull();
      // No sender pill, no collapse affordance, no bubble, no message id.
      expect(separator!.querySelector('app-chat-message')).toBeNull();
      expect(separator!.querySelector('.label-pill')).toBeNull();
      expect(separator!.querySelector('.message-bubble')).toBeNull();
      expect(separator!.getAttribute('data-message-id')).toBeNull();
      expect(el.querySelectorAll('app-chat-message').length).toBe(2);
    });

    it('keys the separator on its day, stably and without collision (T4)', () => {
      const key = component.trackByDisplayItem(0, {
        kind: 'day',
        data: { day: '2026-04-09', label: '2026-04-09' },
      });
      const again = component.trackByDisplayItem(7, {
        kind: 'day',
        data: { day: '2026-04-09', label: '2026-04-09' },
      });
      expect(key).toBe(again);
      expect(key).toBe('day:2026-04-09');
      expect(key).not.toBe(
        component.trackByDisplayItem(0, {
          kind: 'thinking',
          data: {
            agent_id: 'a',
            agent_name: '@A',
            start_time: new Date(),
            tools: [],
            anchor_message_id: '2026-04-09',
            final: false,
          },
        }),
      );
    });

    it('holds the separator key steady as the transcript re-emits (T4)', () => {
      messagesSubject.next([turnOn('d1', 2026, 4, 8), turnOn('d2', 2026, 4, 9)]);
      fixture.detectChanges();
      const before = component.displayItems.map((item, i) =>
        component.trackByDisplayItem(i, item),
      );

      messagesSubject.next([
        turnOn('d1', 2026, 4, 8),
        turnOn('d2', 2026, 4, 9),
        turnOn('d3', 2026, 4, 9, 18),
      ]);
      fixture.detectChanges();
      const after = component.displayItems.map((item, i) =>
        component.trackByDisplayItem(i, item),
      );

      // Every key that existed before still exists, unchanged and in order —
      // so Angular re-uses the rows instead of rebuilding the list.
      expect(after.slice(0, before.length)).toEqual(before);
    });
  });

  // -------------------------------------------------------------------------
  // ADR-016 (simplified) — anchor-on-send + opt-in follow mode.
  // Mocks model the REAL browser: scrollTo/scrollTop clamps, scrollHeight clamps
  // UP to clientHeight, and the spacer's min-height feeds scrollHeight.
  // -------------------------------------------------------------------------
  describe('scroll behavior (anchor-on-send + follow)', () => {
    // Most scroll tests assume a RUNNING process (so "Auto scrolling" can show).
    beforeEach(() => {
      TestBed.inject(ContextService).currentTeamRunning$.next(true);
      // The clamp-aware containers below are plain mock objects, not real DOM
      // Elements, so `reserveSpacer`'s `getComputedStyle(c)` (chat-panel.component.ts)
      // throws "parameter 1 is not of type 'Element'" in headless Chrome. Pass real
      // Elements through to the real implementation (Angular/PrimeNG rendering is
      // unaffected) and return a zero-padding stub for the non-Element mocks — the
      // mock spacer math already assumes paddingBottom = 0.
      const realGetComputedStyle = window.getComputedStyle.bind(window);
      spyOn(window, 'getComputedStyle').and.callFake(
        (el: Element, pseudo?: string | null) =>
          el instanceof Element
            ? realGetComputedStyle(el, pseudo)
            : ({ paddingBottom: '0px' } as CSSStyleDeclaration),
      );
    });

    function humanTurn(id: string): SentMessage {
      return makeSentMessage(
        { name: '@Human', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'user turn',
        id,
      );
    }
    function agentMsg(id: string): SentMessage {
      return makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@Human', role: 'Human' },
        'reply',
        id,
      );
    }

    // Clamp-aware container with a single anchor message + spacer.
    // `spacerEl.offsetTop` is the end of real content; mutate it to simulate the
    // reply growing.
    function installClamping(
      anchorOffsetTop: number,
      anchorHeight: number,
      clientHeight: number,
      containerOffsetTop = 0,
    ) {
      let spacerMin = 0;
      const spacerEl = {
        offsetTop: anchorOffsetTop + anchorHeight,
        style: {
          set minHeight(v: string) {
            spacerMin = parseInt(v, 10) || 0;
          },
          get minHeight() {
            return spacerMin + 'px';
          },
        },
      };
      const anchorEl = { offsetTop: anchorOffsetTop };
      const container = {
        offsetTop: containerOffsetTop,
        clientHeight,
        get scrollHeight() {
          return Math.max(clientHeight, spacerEl.offsetTop + spacerMin); // CLAMP UP
        },
        scrollTop: 0,
        lastScrollTo: null as null | { top: number; behavior: string },
        querySelector(sel: string) {
          return sel.includes('message-spacer') ? null : anchorEl;
        },
        scrollTo(o: { top: number; behavior: ScrollBehavior }) {
          this.lastScrollTo = { top: o.top, behavior: o.behavior };
          const max = Math.max(0, this.scrollHeight - this.clientHeight);
          this.scrollTop = Math.max(0, Math.min(o.top, max)); // CLAMP, like a browser
        },
      };
      container.scrollTop = Math.max(0, container.scrollHeight - clientHeight); // parked bottom
      (component as any).scrollContainer = { nativeElement: container };
      (component as any).spacerRef = { nativeElement: spacerEl };
      return { container, spacerEl, anchorEl, getSpacerMin: () => spacerMin };
    }

    // Simple container for follow / indicator tests (no anchor element).
    function installSimple(scrollHeight: number, clientHeight: number, scrollTop = 0) {
      const container = {
        offsetTop: 0,
        clientHeight,
        scrollHeight,
        scrollTop,
        lastScrollTo: null as null | { top: number; behavior: string },
        querySelector: () => null,
        scrollTo(o: { top: number; behavior: ScrollBehavior }) {
          this.lastScrollTo = { top: o.top, behavior: o.behavior };
          this.scrollTop = o.top;
        },
      };
      (component as any).scrollContainer = { nativeElement: container };
      // Spacer marks the end of the messages (= scrollHeight here; no reserved gap).
      (component as any).spacerRef = {
        nativeElement: { offsetTop: scrollHeight, style: { minHeight: '' } },
      };
      return container;
    }

    // --- anchor on send ------------------------------------------------------

    it('pins the just-sent message to the top on a SHORT conversation', () => {
      (component.chatService as any).emitJustSent('k');
      messagesSubject.next([humanTurn('u1')]);
      expect((component as any).anchorId).toBe('u1');

      const { container, getSpacerMin } = installClamping(84, 36, 356);
      expect(container.scrollTop).toBe(0); // content < viewport → parked at 0

      component.ngAfterViewChecked();

      // realBelow = spacer.offsetTop(120) - anchor.offsetTop(84) = 36;
      // reserve = clientHeight(356) - realBelow(36) - TOP_PAD(8) - padBottom(0) = 312.
      expect(getSpacerMin()).toBe(312);
      // target = 84 - containerOffsetTop(0) - pad(8) = 76 → message at the top.
      expect(container.scrollTop).toBe(76);
      expect(84 - container.scrollTop).toBe(8);
    });

    it('pins to the top regardless of the prior scroll position', () => {
      (component.chatService as any).emitJustSent('k');
      messagesSubject.next([humanTurn('u1')]);
      const { container } = installClamping(520, 40, 356);
      container.scrollTop = 999; // user was scrolled elsewhere

      component.ngAfterViewChecked();

      expect(container.scrollTop).toBe(512); // 520 - 8, independent of 999
    });

    it('uses a clean container frame: subtracts container.offsetTop', () => {
      (component.chatService as any).emitJustSent('k');
      messagesSubject.next([humanTurn('u1')]);
      // container is inset 16px inside its positioned parent.
      const { container } = installClamping(100, 40, 356, 16);
      component.ngAfterViewChecked();
      expect(container.scrollTop).toBe(76); // 100 - 16 - 8
    });

    it('anchors the newly-sent message, not a pre-existing one (baseline)', () => {
      messagesSubject.next([humanTurn('old')]); // restored history, no send
      (component.chatService as any).emitJustSent('k'); // baseline = 'old'
      messagesSubject.next([humanTurn('old'), humanTurn('new')]);
      expect((component as any).anchorId).toBe('new');
    });

    it('does NOT anchor messages that arrive without a send (history load)', () => {
      messagesSubject.next([humanTurn('h1'), agentMsg('a1')]);
      const { container } = installClamping(84, 36, 356);
      const before = container.scrollTop;
      component.ngAfterViewChecked();
      expect((component as any).anchorId).toBeNull();
      expect(container.scrollTop).toBe(before); // viewport untouched
    });

    it('the spacer shrinks as the reply grows, keeping scrollHeight constant (shift-free)', () => {
      (component.chatService as any).emitJustSent('k');
      messagesSubject.next([humanTurn('u1')]);
      const { container, spacerEl, getSpacerMin } = installClamping(84, 36, 356);
      component.ngAfterViewChecked();
      expect(getSpacerMin()).toBe(312); // 356 - realBelow(36) - TOP_PAD(8) - padBottom(0)
      const scrollHeightAfterPin = container.scrollHeight; // 120 + 312 = 432

      // The reply adds 100px of content below the anchor.
      spacerEl.offsetTop += 100; // content end moves down
      component.ngAfterViewChecked();

      expect(getSpacerMin()).toBe(212); // shrank by exactly 100 (312 → 212)
      expect(container.scrollHeight).toBe(scrollHeightAfterPin); // constant → no shift
    });

    // --- status pill: New messages / Messages / Auto scrolling --------

    it('shows "New messages" when a NEW reply arrives below the fold', fakeAsync(() => {
      (component.chatService as any).emitJustSent('k');
      messagesSubject.next([humanTurn('u1')]);
      const { spacerEl } = installClamping(20, 40, 500); // small user message
      component.ngAfterViewChecked(); // pin to top
      flushMicrotasks();
      expect(component.indicatorLabel).toBeNull(); // only the user message, visible

      // A NEW reply arrives (count grows → "unseen") and extends below the fold.
      spacerEl.offsetTop += 800;
      messagesSubject.next([humanTurn('u1'), agentMsg('a1')]);
      component.ngAfterViewChecked();
      flushMicrotasks(); // the pill update is deferred to a microtask
      expect(component.indicatorLabel).toBe('New messages');
    }));

    it('shows "Messages" when merely scrolled up (nothing new)', () => {
      installSimple(2000, 500, 1500); // spacer.offsetTop = 2000
      const c = (component as any).scrollContainer.nativeElement;
      c.scrollTop = 200; // user scrolled up, no new message
      component.onScroll();
      expect(component.indicatorLabel).toBe('Messages');
    });

    it('treats the initial history load as "Messages", not "New messages"', () => {
      // First non-empty emission = the loaded backlog — it is NOT "new".
      messagesSubject.next([agentMsg('h1'), agentMsg('h2')]);
      const container = installSimple(2000, 500, 0); // at top, backlog below the fold
      container.scrollTop = 0;
      component.onScroll();
      expect((component as any).unseen).toBe(false);
      expect(component.indicatorLabel).toBe('Messages');
    });

    it('shows "Auto scrolling" while following', () => {
      installSimple(2000, 500, 1500);
      (component as any).following = true;
      component.onScroll();
      expect(component.indicatorLabel).toBe('Auto scrolling');
    });

    it('does NOT show "Auto scrolling" when the process is stopped', () => {
      TestBed.inject(ContextService).currentTeamRunning$.next(false);
      installSimple(2000, 500, 1500); // at bottom
      (component as any).following = true;
      component.onScroll();
      expect(component.indicatorLabel).not.toBe('Auto scrolling');
    });

    it('reaching the bottom activates follow ("Auto scrolling") and clears "unseen"', () => {
      const container = installSimple(2000, 500, 200);
      (component as any).unseen = true;
      container.scrollTop = 1500; // distance 2000-1500-500 = 0 → at bottom
      component.onScroll();
      expect((component as any).following).toBe(true);
      expect(component.indicatorLabel).toBe('Auto scrolling');
      expect((component as any).unseen).toBe(false);
    });

    // --- follow mode ---------------------------------------------------------

    it('clicking the pill enters follow mode, scrolls to bottom, shows "Auto scrolling"', () => {
      const container = installSimple(2000, 500, 100);
      component.onJumpToLatest();
      expect((component as any).following).toBe(true);
      expect(component.indicatorLabel).toBe('Auto scrolling');
      expect(container.scrollTop).toBe(container.scrollHeight); // jumped to bottom
    });

    it('in follow mode, a new message tails to the bottom', () => {
      const container = installSimple(1000, 500, 500);
      (component as any).following = true;
      (component as any).lastScrollHeight = 1000;
      container.scrollHeight = 1400; // new message grew content
      component.ngAfterViewChecked();
      expect(container.scrollTop).toBe(1400); // tailed
    });

    it('the smooth follow tail (moving DOWN) does not exit follow mode', () => {
      installSimple(2000, 500, 1500); // at bottom
      (component as any).following = true;
      (component as any).lastScrollTop = 1000; // tail animated down the page
      component.onScroll(); // a frame of our own smooth tail (moved down, not up)
      expect((component as any).following).toBe(true);
      expect(component.indicatorLabel).toBe('Auto scrolling');
    });

    it('a manual upward scroll exits follow mode → "Messages"', () => {
      const container = installSimple(2000, 500, 1500);
      (component as any).following = true;
      (component as any).lastScrollTop = 1500; // was at the bottom
      container.scrollTop = 200; // user scrolled UP (distance 1300 > 100)
      component.onScroll();
      expect((component as any).following).toBe(false);
      expect(component.indicatorLabel).toBe('Messages'); // no new msg since
    });

    // --- smooth scrolling ----------------------------------------------------

    it('scrolls SMOOTHLY to the top on send (instant only under reduced motion)', () => {
      spyOn(window, 'matchMedia').and.returnValue({ matches: false } as any);
      (component.chatService as any).emitJustSent('k');
      messagesSubject.next([humanTurn('u1')]);
      const { container } = installClamping(84, 36, 356);
      component.ngAfterViewChecked();
      expect(container.lastScrollTo?.behavior).toBe('smooth');
    });

    it('respects reduced motion (instant) for the top anchor', () => {
      spyOn(window, 'matchMedia').and.returnValue({ matches: true } as any);
      (component.chatService as any).emitJustSent('k');
      messagesSubject.next([humanTurn('u1')]);
      const { container } = installClamping(84, 36, 356);
      component.ngAfterViewChecked();
      expect(container.lastScrollTo?.behavior).toBe('auto');
    });

    it('the "New messages" jump scrolls SMOOTHLY to the bottom', () => {
      spyOn(window, 'matchMedia').and.returnValue({ matches: false } as any);
      const container = installSimple(2000, 500, 100);
      component.onJumpToLatest();
      expect(container.lastScrollTo?.behavior).toBe('smooth');
      expect(container.lastScrollTo?.top).toBe(2000);
    });

    it('a new send exits follow mode and re-anchors', () => {
      (component as any).following = true;
      (component.chatService as any).emitJustSent('k');
      expect((component as any).following).toBe(false);
      messagesSubject.next([humanTurn('u2')]);
      expect((component as any).anchorId).toBe('u2');
    });

    // --- REAL layout (actual component + real CSS in ChromeHeadless) ----------
    // No mocked container: the component renders into the live DOM with its own
    // stylesheet, so this exercises the true layout engine (offsetParent frame,
    // scrollHeight clamping, spacer) that the unit mocks can only approximate.
    it('REAL layout: the just-sent message is scrolled to the top of the panel', () => {
      // Force reduced-motion so the real scrollTo is INSTANT and the end position
      // can be asserted synchronously (smooth would animate over real time).
      spyOn(window, 'matchMedia').and.returnValue({ matches: true } as any);
      const host = fixture.nativeElement as HTMLElement;
      host.style.display = 'block';
      host.style.height = '400px';
      document.body.appendChild(host);
      try {
        // A short conversation (the case that used to fail): two replies already
        // shown, then the user sends — the sent message must jump to the top.
        messagesSubject.next([agentMsg('a0'), agentMsg('a1')]);
        fixture.detectChanges();

        (component.chatService as any).emitJustSent('k');
        messagesSubject.next([agentMsg('a0'), agentMsg('a1'), humanTurn('u1')]);
        fixture.detectChanges(); // render + ngAfterViewChecked → pin
        fixture.detectChanges(); // settle spacer/geometry

        const list = host.querySelector('.message-list') as HTMLElement;
        const anchor = host.querySelector('[data-message-id="u1"]') as HTMLElement;
        expect(anchor).toBeTruthy();

        const delta =
          anchor.getBoundingClientRect().top - list.getBoundingClientRect().top;
        // The sent message sits at the top of the scroll viewport (within the
        // small top inset), NOT pushed down the panel.
        expect(delta).toBeGreaterThanOrEqual(0);
        expect(delta).toBeLessThanOrEqual(16);
      } finally {
        document.body.removeChild(host);
      }
    });
  });

});

// ---------------------------------------------------------------------------
// Story 44-1 (AC12, AC13) — the split, seen end to end through the REAL fold.
//
// This is the criterion the user actually looks at. A unit test on `chatFold`
// alone can pass while the panel still draws one box ABOVE the message that
// caused the work: what interleaves the two bubbles with the two user messages
// is the successor's `start_time`, read by `buildDisplayItems`. Feeding the real
// fold's output into the component is the only way to see that.
//
// Self-contained TestBed (its own `describe`), so the surrounding specs' feed —
// which projects `SentMessage`s through a stand-in classification rather than
// through `chatFold` — is left exactly as it was.
// ---------------------------------------------------------------------------

describe('ChatPanelComponent — HandledMessage split, end to end (Story 44-1)', () => {
  let component: ChatPanelComponent;
  let fixture: ComponentFixture<ChatPanelComponent>;

  const AGENT = makeAddress({ name: '@Researcher', agent_id: 'agent-1' });
  const HUMAN = makeAddress({ name: '@Human', role: 'Human', agent_id: 'human-1' });

  function userSent(id: string, content: string, timestamp: string): SentMessage {
    return {
      id,
      parent_id: null,
      team_id: 'team-1',
      timestamp,
      sender: HUMAN,
      display_type: 'human',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.SentMessage',
      message: {
        id: 'inner-' + id,
        parent_id: null,
        team_id: 'team-1',
        timestamp,
        sender: HUMAN,
        display_type: 'human',
        content,
        __model__: 'akgentic.core.messages.orchestrator.SentMessage',
      },
      recipient: AGENT,
    };
  }

  function agentSent(id: string, content: string, timestamp: string): SentMessage {
    return {
      ...userSent(id, content, timestamp),
      sender: AGENT,
      recipient: HUMAN,
      message: {
        ...userSent(id, content, timestamp).message,
        sender: AGENT,
      },
    };
  }

  function received(timestamp: string): ReceivedMessage {
    return {
      id: 'rcv-1',
      parent_id: null,
      team_id: 'team-1',
      timestamp,
      sender: AGENT,
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.ReceivedMessage',
      message_id: 'inner-msg-first',
    };
  }

  function handled(messageId: string, timestamp: string): HandledMessage {
    return {
      id: 'handled-1',
      parent_id: null,
      team_id: 'team-1',
      timestamp,
      sender: AGENT,
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.HandledMessage',
      message_id: messageId,
    };
  }

  function toolCall(id: string, toolCallId: string): EventMessage {
    return {
      id,
      parent_id: null,
      team_id: 'team-1',
      timestamp: '2026-04-12T10:00:02Z',
      sender: AGENT,
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.EventMessage',
      event: {
        __model__: 'akgentic.llm.event.ToolCallEvent',
        tool_call_id: toolCallId,
        tool_name: 'search_web',
        arguments: '{"q":"x"}',
      },
    };
  }

  /** The realistic log: a run that absorbed the user's second message. */
  const LOG: AkgenticMessage[] = [
    userSent('msg-first', 'find two people', '2026-04-12T10:00:00Z'),
    received('2026-04-12T10:00:01Z'),
    toolCall('evt-1', 'call-a'),
    handled('inner-msg-absorbed', '2026-04-12T10:00:05Z'),
    userSent('msg-absorbed', 'also add Arnaud', '2026-04-12T10:00:04Z'),
    toolCall('evt-2', 'call-c'),
    agentSent('msg-answer', 'here they are', '2026-04-12T10:00:09Z'),
  ];

  /** `kind:id` for a message, `kind:anchor` for a bubble, `day:<date>` for a
   *  day rule — the component's own track key, so the assertion reads as the
   *  rendered list. (Every message in LOG is on one day, so no rule appears.) */
  function describeItems(): string[] {
    return component.displayItems.map((item, i) =>
      component.trackByDisplayItem(i, item),
    );
  }

  beforeEach(async () => {
    const folded = chatFold(LOG);
    const chatService = {
      messages$: new BehaviorSubject<ChatMessage[]>(folded.messages),
      pendingNotifications$: of(computePendingNotifications(folded.messages)),
      thinkingAgents$: new BehaviorSubject<ThinkingState[]>(folded.thinkingAgents),
      justSent$: new Subject<string>().asObservable(),
      emitJustSent: (_key: string) => undefined,
    };

    await TestBed.configureTestingModule({
      imports: [ChatPanelComponent, NoopAnimationsModule],
      providers: [
        provideMarkdown(),
        { provide: ChatService, useValue: chatService },
        {
          provide: SelectionService,
          useValue: jasmine.createSpyObj('SelectionService', ['handleSelection']),
        },
        {
          provide: ApiService,
          useValue: jasmine.createSpyObj('ApiService', [
            'sendMessage',
            'processHumanInput',
          ]),
        },
        {
          provide: AkgentService,
          useValue: { selectedAkgent$: new BehaviorSubject<any>(null) },
        },
        { provide: GraphDataService, useValue: { nodes$: of([]) } },
        {
          provide: IngestionService,
          useValue: {
            commands: { snapshot: (_id: string) => [] as any[] },
            loadingProcess$: new BehaviorSubject<boolean>(false),
          },
        },
        MessageService,
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatPanelComponent);
    component = fixture.componentInstance;
    component.processId = 'test-team';
    fixture.detectChanges();
  });

  it('(AC12) the display list reads message, bubble, absorbed message, bubble', () => {
    expect(describeItems()).toEqual([
      'message:msg-first',
      'thinking:inner-msg-first',
      'message:msg-absorbed',
      'thinking:inner-msg-absorbed',
      'message:msg-answer',
    ]);
  });

  it('(AC12) the successor bubble is drawn BELOW the message that caused it', () => {
    const items = describeItems();
    expect(items.indexOf('thinking:inner-msg-absorbed')).toBeGreaterThan(
      items.indexOf('message:msg-absorbed'),
    );
    // …and the predecessor still sits under the FIRST message, not the second.
    expect(items.indexOf('thinking:inner-msg-first')).toBeLessThan(
      items.indexOf('message:msg-absorbed'),
    );
  });

  it('(AC12) each bubble holds only the tool calls issued in its own segment', () => {
    const bubbles = component.displayItems
      .filter((i) => i.kind === 'thinking')
      .map((i) => i.data as ThinkingState);
    expect(bubbles.length).toBe(2);
    expect(bubbles[0].tools.map((t) => t.tool_call_id)).toEqual(['call-a']);
    expect(bubbles[1].tools.map((t) => t.tool_call_id)).toEqual(['call-c']);
  });

  it('(AC13) trackByDisplayItem yields distinct keys for the two segments', () => {
    const bubbles = component.displayItems.filter((i) => i.kind === 'thinking');
    const keys = bubbles.map((b, i) => component.trackByDisplayItem(i, b));
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('(AC13) expanding one segment does not expand the other', () => {
    const bubbles = component.displayItems
      .filter((i) => i.kind === 'thinking')
      .map((i) => i.data as ThinkingState);
    component.onToggleThinkingExpanded(bubbles[0].anchor_message_id);
    expect(component.isThinkingExpanded(bubbles[0])).toBe(true);
    expect(component.isThinkingExpanded(bubbles[1])).toBe(false);

    component.onToggleThinkingExpanded(bubbles[1].anchor_message_id);
    expect(component.isThinkingExpanded(bubbles[0])).toBe(true);
    expect(component.isThinkingExpanded(bubbles[1])).toBe(true);

    component.onToggleThinkingExpanded(bubbles[0].anchor_message_id);
    expect(component.isThinkingExpanded(bubbles[0])).toBe(false);
    expect(component.isThinkingExpanded(bubbles[1])).toBe(true);
  });
});
