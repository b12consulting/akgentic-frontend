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
import { provideMarkdown } from 'ngx-markdown';

import { ChatPanelComponent } from './chat-panel.component';
import {
  ChatService,
  computePendingNotifications,
  ThinkingState,
} from '../../selectors/chat.selector';
import { SelectionService } from '../../ui-state/selection.service';
import { ActorAddress, SentMessage, AkgenticMessage, StartMessage, isSentMessage } from '../../../../protocol/message.types';
import { ChatMessage, classifyMessage } from '../../selectors/chat-message.model';
import { ApiService } from '../../../../core/http/api.service';
import { AkgentService } from '../../../../core/ui/akgent.service';
import { GraphDataService } from '../../selectors/graph.selector';
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

  beforeEach(async () => {
    messagesSubject = new BehaviorSubject<AkgenticMessage[]>([]);
    justSentSubject = new Subject<string>();

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
      selectedAkgent$: new BehaviorSubject<any>(null),
    };

    const graphDataService = {
      nodes$: of([]),
    };

    // Story 15-1 (ADR-013) / Epic 17 (ADR-014): the embedded <app-user-input>
    // injects IngestionService for its `commands` PerAgentStore (the `/`
    // mention store). Story 17-3 removed the bespoke `commandsByAgent$`; this
    // stub mirrors the current surface — a `commands`-shaped object exposing
    // `snapshot(id)` (returns `[]` here: the empty-selection scenarios in this
    // spec short-circuit before any command lookup).
    const messageService = {
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
        { provide: IngestionService, useValue: messageService },
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
  // Story 19-2 (ADR-016) — retire default autoscroll, idle/anchored state
  // machine, one-shot mount scroll, programmatic-vs-user guard, typed hover
  // owed-action. The legacy Story 4.4 default-autoscroll specs are rewritten
  // here for the new state machine (the old `shouldScrollToBottom`/
  // `checkShouldAutoScroll` default re-pin no longer exists).
  // -------------------------------------------------------------------------
  describe('Story 19-2: state machine, mount scroll, programmatic guard, hover owed-action', () => {
    // Helper to install a mock scrollContainer with controllable
    // scrollTop/scrollHeight/clientHeight on the component.
    function installMockScrollContainer(
      initialHeight = 1000,
      clientHeight = 400,
    ): { scrollTop: number; scrollHeight: number; clientHeight: number } {
      const mockEl = { scrollTop: 0, scrollHeight: initialHeight, clientHeight };
      (component as any).scrollContainer = { nativeElement: mockEl };
      (component as any).lastScrollHeight = initialHeight;
      return mockEl;
    }

    function sendUserTurn(id: string, ts = '2026-06-14T10:00:00Z') {
      const sent = makeSentMessage(
        { name: '@Human', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'user turn',
        id,
      );
      sent.timestamp = ts;
      sent.message.timestamp = ts;
      return sent;
    }

    // --- AC #1: no-jump-while-streaming / idle ---------------------------------
    it('AC #1: in idle, repeated growth does NOT move scrollTop (no autoscroll)', () => {
      const mockEl = installMockScrollContainer(1000, 400);
      mockEl.scrollTop = 200; // user parked somewhere, not at bottom
      // Latch the mount scroll so it does not fire (we test pure idle growth).
      (component as any).hasDoneInitialScroll = true;
      expect((component as any).scrollMode).toBe('idle');

      // Several emissions grow the content.
      for (const h of [1200, 1500, 1800]) {
        mockEl.scrollHeight = h;
        component.ngAfterViewChecked();
      }
      // Idle never moves the view on its own.
      expect(mockEl.scrollTop).toBe(200);
    });

    // --- AC #4: one-shot mount scroll + latch ---------------------------------
    it('AC #4: mount fires exactly ONE instant scroll-to-bottom, then never again', () => {
      const mockEl = installMockScrollContainer(1000, 400);
      expect((component as any).hasDoneInitialScroll).toBe(false);

      component.ngAfterViewChecked();
      // Instant jump to bottom on the first laid-out view-settle.
      expect(mockEl.scrollTop).toBe(1000);
      expect((component as any).hasDoneInitialScroll).toBe(true);
      // After mount the panel is idle (does not keep tailing).
      expect((component as any).scrollMode).toBe('idle');

      // Subsequent growth / view-checks must NOT re-fire the mount scroll.
      mockEl.scrollTop = 300; // user scrolled up
      mockEl.scrollHeight = 1600;
      component.ngAfterViewChecked();
      component.ngAfterViewChecked();
      expect(mockEl.scrollTop).toBe(300);
    });

    it('AC #4: mount scroll does not fire while scrollHeight is 0 (not laid out)', () => {
      const mockEl = installMockScrollContainer(0, 400);
      component.ngAfterViewChecked();
      expect((component as any).hasDoneInitialScroll).toBe(false);
      expect(mockEl.scrollTop).toBe(0);

      // Once content lays out, it fires once.
      mockEl.scrollHeight = 900;
      component.ngAfterViewChecked();
      expect((component as any).hasDoneInitialScroll).toBe(true);
      expect(mockEl.scrollTop).toBe(900);
    });

    it('AC #4: anchor precedence — mount scroll is skipped when a turn is anchored', () => {
      const mockEl = installMockScrollContainer(1000, 400) as any;
      // The anchor path runs first in ngAfterViewChecked; give the container a
      // querySelector (anchor not yet rendered → null) so it no-ops cleanly.
      mockEl.querySelector = (_sel: string) => null;
      // A send arrived before mount settled.
      (component as any).anchorMessageId = 'pending-anchor';
      component.ngAfterViewChecked();
      // Mount scroll did not fire (anchor owns the first frame).
      expect((component as any).hasDoneInitialScroll).toBe(false);
      expect(mockEl.scrollTop).toBe(0);
    });

    // --- AC #5: programmatic-vs-user scroll discrimination --------------------
    it('AC #5: a programmatic write does NOT release the anchor', () => {
      const mockEl = installMockScrollContainer(1000, 400);
      (component as any).scrollMode = 'anchored';
      (component as any).anchorMessageId = 'a-1';
      // Simulate the bracket a programmatic write opens.
      (component as any).isProgrammaticScroll = true;
      // The write moved us above the near-bottom threshold...
      mockEl.scrollTop = 0;
      component.onScroll();
      // ...but the guard suppresses the release.
      expect((component as any).scrollMode).toBe('anchored');
      expect((component as any).anchorMessageId).toBe('a-1');
    });

    it('AC #5: a genuine user scroll past the threshold DOES release the anchor', () => {
      const mockEl = installMockScrollContainer(2000, 400);
      (component as any).scrollMode = 'anchored';
      (component as any).anchorMessageId = 'a-2';
      (component as any).anchorScrollDone = true;
      (component as any).lastAnchorOffsetTop = 600;
      component.spacerHeight = 300;
      (component as any).isProgrammaticScroll = false;
      // User scrolled to the top — far above the near-bottom threshold
      // (distanceFromBottom = 2000 - 0 - 400 = 1600 > 100).
      mockEl.scrollTop = 0;

      component.onScroll();

      expect((component as any).scrollMode).toBe('idle');
      expect((component as any).anchorMessageId).toBeNull();
      expect((component as any).anchorScrollDone).toBe(false);
      expect((component as any).lastAnchorOffsetTop).toBeNull();
      expect(component.spacerHeight).toBe(0);
    });

    it('AC #5: a user scroll that stays near the bottom does NOT release', () => {
      const mockEl = installMockScrollContainer(1000, 400);
      (component as any).scrollMode = 'anchored';
      (component as any).anchorMessageId = 'a-3';
      (component as any).isProgrammaticScroll = false;
      // distanceFromBottom = 1000 - 550 - 400 = 50 <= 100 (near bottom).
      mockEl.scrollTop = 550;
      component.onScroll();
      expect((component as any).scrollMode).toBe('anchored');
    });

    it('AC #5: the programmatic guard clears on the trailing debounce so a later user scroll releases', fakeAsync(() => {
      const mockEl = installMockScrollContainer(2000, 400);
      (component as any).scrollMode = 'anchored';
      (component as any).anchorMessageId = 'a-4';
      // Open the guard window the way scrollToBottom()/applyAnchorScroll() do.
      (component as any).beginProgrammaticScroll();
      expect((component as any).isProgrammaticScroll).toBe(true);

      // The guard outlasts a microtask checkpoint (a smooth scrollTo dispatches
      // its `scroll` events across later frames, not the current microtask).
      flushMicrotasks();
      expect((component as any).isProgrammaticScroll).toBe(true);

      // Once the settle window elapses with no further scroll events, it drops.
      tick((component as any).programmaticScrollSettleMs);
      expect((component as any).isProgrammaticScroll).toBe(false);

      // A genuine user scroll in a later tick now releases.
      mockEl.scrollTop = 0;
      component.onScroll();
      expect((component as any).scrollMode).toBe('idle');
    }));

    it('AC #5: the anchor does NOT release itself when its own async programmatic scroll events fire', fakeAsync(() => {
      const mockEl = installMockScrollContainer(2000, 400);
      (component as any).scrollMode = 'anchored';
      (component as any).anchorMessageId = 'a-5';
      // Open the guard the way a smooth anchor write does.
      (component as any).beginProgrammaticScroll();

      // The smooth scroll parks the view near the TOP — its own `scroll` frames
      // arrive across several later ticks, each below the near-bottom threshold.
      // These are the animation's frames, not a user exit: the anchor must hold.
      for (let i = 0; i < 4; i++) {
        mockEl.scrollTop = i * 10; // still far above near-bottom (distance > 100)
        component.onScroll();
        tick(50); // less than the settle window — guard stays armed
      }
      expect((component as any).scrollMode).toBe('anchored');
      expect((component as any).anchorMessageId).toBe('a-5');

      // After the events stop for the full settle window, the guard drops and a
      // genuine later user scroll releases.
      tick((component as any).programmaticScrollSettleMs);
      expect((component as any).isProgrammaticScroll).toBe(false);
      mockEl.scrollTop = 0;
      component.onScroll();
      expect((component as any).scrollMode).toBe('idle');
    }));

    // --- AC #6: typed hover owed-action --------------------------------------
    it('AC #6: a new message during hover (turn anchored) owes a top-anchor', () => {
      const mockEl = installMockScrollContainer(1000, 400);
      mockEl.scrollTop = 850;
      (component as any).anchorMessageId = 'hov-anchor';

      component.onMouseEnter();
      messagesSubject.next([sendUserTurn('hov-1')]);
      // anchorMessageId stays non-null (already set) — owed kind is top-anchor.
      expect((component as any).owedScroll).toBe('top-anchor');
    });

    it('AC #6: a new message during hover (no anchor, near bottom) owes a mount-bottom', () => {
      const mockEl = installMockScrollContainer(1000, 400);
      mockEl.scrollTop = 850; // near bottom (distanceFromBottom = 1000-850-400 < 0)
      (component as any).anchorMessageId = null;

      component.onMouseEnter();
      const sent = makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@Human', role: 'Human' },
        'arrival',
        'mb-1',
      );
      messagesSubject.next([sent]);
      expect((component as any).owedScroll).toBe('mount-bottom');
    });

    it('AC #6: mouseleave replays a top-anchor owed action via the anchor scroll', fakeAsync(() => {
      const mockEl = installMockScrollContainer(1200, 500) as any;
      // Give the container a resolvable anchor element + scrollTo recorder.
      mockEl.scrollTop = 0;
      mockEl.lastScrollTo = null;
      mockEl.scrollTo = (opts: { top: number; behavior: string }) => {
        mockEl.lastScrollTo = opts;
        mockEl.scrollTop = opts.top;
      };
      mockEl.querySelector = (_sel: string) => ({ offsetTop: 600 });
      (component as any).anchorMessageId = 'owed-anchor';
      (component as any).owedScroll = 'top-anchor';
      spyOn(window, 'matchMedia').and.returnValue({ matches: true } as any);

      component.onMouseLeave();
      flushMicrotasks();

      // The anchor scroll replayed (offsetTop 600 - padding 8 = 592).
      expect(mockEl.lastScrollTo?.top).toBe(592);
      expect((component as any).owedScroll).toBeNull();
      flush(); // drain the programmatic-scroll settle timer the replay armed
    }));

    it('AC #6: mouseleave replays a mount-bottom owed action via scrollToBottom', fakeAsync(() => {
      const mockEl = installMockScrollContainer(1300, 400);
      mockEl.scrollTop = 0;
      (component as any).owedScroll = 'mount-bottom';

      component.onMouseLeave();
      flushMicrotasks();

      expect(mockEl.scrollTop).toBe(1300);
      expect((component as any).owedScroll).toBeNull();
      flush(); // drain the programmatic-scroll settle timer the replay armed
    }));

    it('AC #6: collapse toggle during hover does NOT queue an owed scroll', fakeAsync(() => {
      const r4 = makeSentMessage(
        { name: '@Worker', role: 'Worker' },
        { name: '@Manager', role: 'Manager' },
        'ai msg',
        'r4-hover',
      );
      messagesSubject.next([r4]);
      fixture.detectChanges();

      const mockEl = installMockScrollContainer(1000, 400);
      mockEl.scrollTop = 850;
      (component as any).hasDoneInitialScroll = true;

      component.onMouseEnter();
      // A collapse toggle changes DOM height but is NOT a message-arrival event.
      component.onToggleCollapse(component.chatMessages[0]);
      mockEl.scrollHeight = 1100;
      component.ngAfterViewChecked();

      // No owed scroll queued for a collapse toggle; view unmoved.
      expect((component as any).owedScroll).toBeNull();
      expect(mockEl.scrollTop).toBe(850);

      component.onMouseLeave();
      flushMicrotasks();
      expect(mockEl.scrollTop).toBe(850);
    }));
  });

  // -------------------------------------------------------------------------
  // Story 19-1 (ADR-016) — top-anchor primitive
  // -------------------------------------------------------------------------
  describe('top-anchor primitive (Story 19-1)', () => {
    // A mock scroll container whose querySelector returns a controllable
    // anchor element (data-message-id lookup), with controllable client/scroll
    // heights and a recording scrollTo.
    interface MockAnchorEl {
      offsetTop: number;
    }
    interface MockContainer {
      clientHeight: number;
      scrollHeight: number;
      scrollTop: number;
      lastScrollTo: { top: number; behavior: string } | null;
      scrollToCalls: number;
      querySelectorCalls: string[];
      _anchor: MockAnchorEl | null;
      querySelector(sel: string): MockAnchorEl | null;
      scrollTo(opts: { top: number; behavior: ScrollBehavior }): void;
    }

    function installContainer(
      anchor: MockAnchorEl | null,
      clientHeight = 500,
      scrollHeight = 1200,
    ): MockContainer {
      const container: MockContainer = {
        clientHeight,
        scrollHeight,
        scrollTop: 0,
        lastScrollTo: null,
        scrollToCalls: 0,
        querySelectorCalls: [],
        _anchor: anchor,
        querySelector(sel: string) {
          this.querySelectorCalls.push(sel);
          return this._anchor;
        },
        scrollTo(opts) {
          this.scrollToCalls += 1;
          this.lastScrollTo = { top: opts.top, behavior: opts.behavior };
          this.scrollTop = opts.top;
        },
      };
      (component as any).scrollContainer = { nativeElement: container };
      return container;
    }

    function mockReducedMotion(matches: boolean): void {
      spyOn(window, 'matchMedia').and.returnValue({
        matches,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      } as any);
    }

    function sendUserMessage(id: string, ts = '2026-06-14T10:00:00Z') {
      const sent = makeSentMessage(
        { name: '@Human', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'user turn',
        id,
      );
      sent.timestamp = ts;
      sent.message.timestamp = ts;
      return sent;
    }

    // Seed a turn WITHOUT change detection: emit the just-sent key, push the
    // user message through the log (the BehaviorSubject pipe runs synchronously,
    // so `chatMessages`/`displayItems` update and the anchor id resolves), then
    // install the controllable mock container. We deliberately avoid
    // `fixture.detectChanges()` here so Angular's lifecycle does not run
    // `ngAfterViewChecked` against the real @ViewChild('scrollContainer') and
    // fire the anchor before the mock is in place — the test drives the
    // post-layout pass explicitly via `component.ngAfterViewChecked()`.
    function seedTurn(
      msgs: AkgenticMessage[],
      key: string,
      anchor: MockAnchorEl | null,
      clientHeight = 500,
      scrollHeight = 1200,
    ): MockContainer {
      (component.chatService as any).emitJustSent(key);
      messagesSubject.next(msgs);
      return installContainer(anchor, clientHeight, scrollHeight);
    }

    it('AC #2: first id-matched emission fires a single top-anchor, no re-fire on same turn', () => {
      mockReducedMotion(false);
      const container = seedTurn([sendUserMessage('u-1')], '1000', {
        offsetTop: 600,
      });

      component.ngAfterViewChecked();
      expect(container.scrollToCalls).toBe(1);
      // offsetTop(600) - topPadding(8) = 592
      expect(container.lastScrollTo?.top).toBe(592);

      // A subsequent same-turn emission (more streamed content) must NOT re-anchor.
      component.ngAfterViewChecked();
      component.ngAfterViewChecked();
      expect(container.scrollToCalls).toBe(1);
    });

    it('AC #2: latch resets on a new just-sent so the next turn can anchor', () => {
      mockReducedMotion(false);
      const container = seedTurn([sendUserMessage('turn-1')], '1000', {
        offsetTop: 600,
      });
      component.ngAfterViewChecked();
      expect(container.scrollToCalls).toBe(1);

      // New turn: the latch resets; spacer resets to 0 on the new just-sent.
      // Key the new send AFTER turn-1's timestamp so the matcher picks turn-2.
      const turn2Key = String(Date.parse('2026-06-14T10:00:01Z'));
      (component.chatService as any).emitJustSent(turn2Key);
      expect(component.spacerHeight).toBe(0);
      messagesSubject.next([
        sendUserMessage('turn-1', '2026-06-14T10:00:00Z'),
        sendUserMessage('turn-2', '2026-06-14T10:05:00Z'),
      ]);
      // The matcher must have resolved turn-2 (first Rule-1 at/after the key).
      expect((component as any).anchorMessageId).toBe('turn-2');
      const container2 = installContainer({ offsetTop: 800 });
      component.ngAfterViewChecked();
      expect(container2.scrollToCalls).toBe(1);
      expect(container2.lastScrollTo?.top).toBe(792);
    });

    it('AC #4: resolves via data-message-id and is a no-op when not yet rendered', () => {
      mockReducedMotion(false);
      // No anchor element resolvable yet (querySelector returns null).
      const container = seedTurn([sendUserMessage('late-1')], '1000', null);
      component.ngAfterViewChecked();

      expect(container.scrollToCalls).toBe(0);
      expect((component as any).anchorScrollDone).toBe(false);
      expect(container.querySelectorCalls.some((s) => s.includes('late-1'))).toBe(
        true,
      );

      // Element renders on the next pass → first-match latch fires.
      container._anchor = { offsetTop: 300 };
      component.ngAfterViewChecked();
      expect(container.scrollToCalls).toBe(1);
      expect(container.lastScrollTo?.top).toBe(292);
    });

    it('AC #3: spacer is 0 when not anchored and max(0, viewport-content) when anchored, capped at viewport', () => {
      mockReducedMotion(false);
      // Before any send → spacer stays 0.
      expect(component.spacerHeight).toBe(0);

      // viewport 500, scrollHeight 600, offsetTop 550 →
      // heightOfAnchoredTurnAndBelow = 600 - 0 - 550 = 50 → spacer = 450.
      const container = seedTurn(
        [sendUserMessage('sp-1')],
        '1000',
        { offsetTop: 550 },
        500,
        600,
      );
      component.ngAfterViewChecked();
      expect(component.spacerHeight).toBe(450);
      // Capped at the viewport (never exceeds clientHeight).
      expect(component.spacerHeight).toBeLessThanOrEqual(container.clientHeight);
    });

    it('AC #3: spacer collapses toward 0 as the answer fills the viewport', () => {
      mockReducedMotion(false);
      // viewport 500, scrollHeight 2000, offsetTop 10 →
      // heightOfAnchoredTurnAndBelow = 2000 - 0 - 10 = 1990 → max(0, 500-1990)=0.
      seedTurn([sendUserMessage('fill-1')], '1000', { offsetTop: 10 }, 500, 2000);
      component.ngAfterViewChecked();

      expect(component.spacerHeight).toBe(0);
    });

    it('AC #5: re-pins on the anchor element\'s OWN offset change; answer-below growth does not', () => {
      mockReducedMotion(false);
      const anchorEl = { offsetTop: 600 };
      const container = seedTurn(
        [sendUserMessage('st-1')],
        '1000',
        anchorEl,
        500,
        1200,
      );
      component.ngAfterViewChecked();
      expect(container.scrollToCalls).toBe(1);

      // Answer grows BELOW the anchor: scrollHeight changes, offsetTop does not.
      container.scrollHeight = 1800;
      component.ngAfterViewChecked();
      expect(container.scrollToCalls).toBe(1); // no re-pin

      // The anchor's OWN height changes (late image load) → offsetTop shifts.
      anchorEl.offsetTop = 640;
      component.ngAfterViewChecked();
      expect(container.scrollToCalls).toBe(2); // re-pinned
      expect(container.lastScrollTo?.top).toBe(632);
    });

    it('AC #6: instant jump when reduced motion is requested', () => {
      mockReducedMotion(true);
      const container = seedTurn([sendUserMessage('rm-1')], '1000', {
        offsetTop: 600,
      });
      component.ngAfterViewChecked();

      expect(container.lastScrollTo?.behavior).toBe('auto');
    });

    it('AC #6: behavior is smooth when reduced motion is NOT requested', () => {
      mockReducedMotion(false);
      const container = seedTurn([sendUserMessage('rm-2')], '1000', {
        offsetTop: 600,
      });
      component.ngAfterViewChecked();

      expect(container.lastScrollTo?.behavior).toBe('smooth');
    });

    it('renders the trailing spacer bound to spacerHeight, excluded from displayItems', () => {
      mockReducedMotion(false);
      messagesSubject.next([sendUserMessage('dom-1')]);
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      const list = el.querySelector('.message-list');
      const spacer = list!.querySelector('.message-spacer');
      expect(spacer).not.toBeNull();
      // The spacer is the LAST child of the message list.
      expect(list!.lastElementChild).toBe(spacer);
      // It is not a DisplayItem — only the message is.
      expect(component.displayItems.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Story 19-2 (ADR-016) — anchored-holds / release / re-anchor state
  // transitions (driven through the anchor mock container, like 19-1).
  // -------------------------------------------------------------------------
  describe('Story 19-2: anchored-holds, release, re-anchor transitions', () => {
    interface MockAnchorEl {
      offsetTop: number;
    }
    interface MockContainer {
      clientHeight: number;
      scrollHeight: number;
      scrollTop: number;
      lastScrollTo: { top: number; behavior: string } | null;
      scrollToCalls: number;
      _anchor: MockAnchorEl | null;
      querySelector(sel: string): MockAnchorEl | null;
      scrollTo(opts: { top: number; behavior: ScrollBehavior }): void;
    }

    function installContainer(
      anchor: MockAnchorEl | null,
      clientHeight = 500,
      scrollHeight = 1200,
    ): MockContainer {
      const container: MockContainer = {
        clientHeight,
        scrollHeight,
        scrollTop: 0,
        lastScrollTo: null,
        scrollToCalls: 0,
        _anchor: anchor,
        querySelector() {
          return this._anchor;
        },
        scrollTo(opts) {
          this.scrollToCalls += 1;
          this.lastScrollTo = { top: opts.top, behavior: opts.behavior };
          this.scrollTop = opts.top;
        },
      };
      (component as any).scrollContainer = { nativeElement: container };
      return container;
    }

    function mockReducedMotion(matches: boolean): void {
      spyOn(window, 'matchMedia').and.returnValue({ matches } as any);
    }

    function sendUserMessage(id: string, ts = '2026-06-14T10:00:00Z') {
      const sent = makeSentMessage(
        { name: '@Human', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'user turn',
        id,
      );
      sent.timestamp = ts;
      sent.message.timestamp = ts;
      return sent;
    }

    function seedTurn(
      id: string,
      key: string,
      anchor: MockAnchorEl | null,
      clientHeight = 500,
      scrollHeight = 1200,
    ): MockContainer {
      (component.chatService as any).emitJustSent(key);
      messagesSubject.next([sendUserMessage(id)]);
      return installContainer(anchor, clientHeight, scrollHeight);
    }

    it('AC #2: first anchor sets scrollMode = anchored', () => {
      mockReducedMotion(false);
      seedTurn('a-1', '1000', { offsetTop: 600 });
      expect((component as any).scrollMode).toBe('idle');
      component.ngAfterViewChecked();
      expect((component as any).scrollMode).toBe('anchored');
    });

    it('AC #1/#2: anchored holds — answer-below growth does not move the scroll', () => {
      mockReducedMotion(false);
      const anchorEl = { offsetTop: 600 };
      const container = seedTurn('hold-1', '1000', anchorEl, 500, 1200);
      component.ngAfterViewChecked();
      expect(container.scrollToCalls).toBe(1);
      const parkedTop = container.scrollTop;

      // Several downstream growths (streamed tokens) — offsetTop unchanged.
      for (const h of [1600, 2000, 2400]) {
        container.scrollHeight = h;
        component.ngAfterViewChecked();
      }
      expect(container.scrollToCalls).toBe(1); // no extra scroll writes
      expect(container.scrollTop).toBe(parkedTop);
      expect((component as any).scrollMode).toBe('anchored');
    });

    it('AC #3: a user scroll event past the threshold releases the anchor to idle', () => {
      mockReducedMotion(false);
      const container = seedTurn('rel-1', '1000', { offsetTop: 600 }, 500, 2000);
      component.ngAfterViewChecked();
      expect((component as any).scrollMode).toBe('anchored');

      // Let the programmatic-guard window close, then simulate a genuine user
      // scroll to the top (distanceFromBottom = 2000 - 0 - 500 = 1500 > 100).
      (component as any).isProgrammaticScroll = false;
      container.scrollTop = 0;
      component.onScroll();

      expect((component as any).scrollMode).toBe('idle');
      expect((component as any).anchorMessageId).toBeNull();
      expect(component.spacerHeight).toBe(0);
    });

    it('AC #3: natural scroll-off (anchor pushed above the fold) releases to idle', () => {
      mockReducedMotion(false);
      const anchorEl = { offsetTop: 600 };
      const container = seedTurn('off-1', '1000', anchorEl, 500, 1200);
      component.ngAfterViewChecked();
      expect((component as any).scrollMode).toBe('anchored');

      // The answer grew so the anchor scrolled above the top of the viewport:
      // offsetTop - scrollTop < topPadding (8). With scrollTop parked at 592,
      // an anchor offsetTop of 595 means 595 - 592 = 3 < 8 → scrolled off.
      anchorEl.offsetTop = 595;
      component.ngAfterViewChecked();

      expect((component as any).scrollMode).toBe('idle');
      expect((component as any).anchorMessageId).toBeNull();
      expect(container.scrollToCalls).toBe(1); // released, NOT re-pinned
    });

    it('AC #3: re-anchor on send — idle → (send) → anchored', () => {
      mockReducedMotion(false);
      const container = seedTurn('re-1', '1000', { offsetTop: 600 }, 500, 2000);
      component.ngAfterViewChecked();
      expect((component as any).scrollMode).toBe('anchored');

      // Release via user scroll.
      (component as any).isProgrammaticScroll = false;
      container.scrollTop = 0;
      component.onScroll();
      expect((component as any).scrollMode).toBe('idle');

      // A new turn is sent → latch resets, scrollMode returns to idle-intent,
      // and the next matching emission re-anchors.
      const key2 = String(Date.parse('2026-06-14T10:05:01Z'));
      (component.chatService as any).emitJustSent(key2);
      expect((component as any).scrollMode).toBe('idle');
      messagesSubject.next([
        sendUserMessage('re-1', '2026-06-14T10:00:00Z'),
        sendUserMessage('re-2', '2026-06-14T10:06:00Z'),
      ]);
      expect((component as any).anchorMessageId).toBe('re-2');
      const container2 = installContainer({ offsetTop: 800 }, 500, 2000);
      component.ngAfterViewChecked();
      expect((component as any).scrollMode).toBe('anchored');
      expect(container2.scrollToCalls).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Story 19-3 (ADR-016 §Decision 4/6) — jump-to-latest indicator + opt-in
  // follow mode. Completes the state machine: `following` is now ENTERED (it
  // was a reachable-but-unentered placeholder in 19-2).
  // -------------------------------------------------------------------------
  describe('Story 19-3: jump-to-latest indicator + follow mode', () => {
    // Mock container with a recording scrollTo + controllable geometry. The
    // follow tail writes via `scrollTo`; geometry drives isNearBottom().
    interface MockContainer {
      scrollTop: number;
      scrollHeight: number;
      clientHeight: number;
      lastScrollTo: { top: number; behavior: string } | null;
      scrollToCalls: number;
      scrollTo(opts: { top: number; behavior: ScrollBehavior }): void;
    }

    function installMockScrollContainer(
      scrollHeight = 2000,
      clientHeight = 400,
    ): MockContainer {
      const container: MockContainer = {
        scrollTop: 0,
        scrollHeight,
        clientHeight,
        lastScrollTo: null,
        scrollToCalls: 0,
        scrollTo(opts) {
          this.scrollToCalls += 1;
          this.lastScrollTo = { top: opts.top, behavior: opts.behavior };
          this.scrollTop = opts.top;
        },
      };
      (component as any).scrollContainer = { nativeElement: container };
      (component as any).lastScrollHeight = scrollHeight;
      // Mount scroll is irrelevant to these tests — latch it off.
      (component as any).hasDoneInitialScroll = true;
      return container;
    }

    function mockReducedMotion(matches: boolean): void {
      spyOn(window, 'matchMedia').and.returnValue({ matches } as any);
    }

    function aiMessage(id: string, content = 'answer') {
      return makeSentMessage(
        { name: '@Manager', role: 'Manager' },
        { name: '@Human', role: 'Human' },
        content,
        id,
      );
    }

    function sendUserTurn(id: string, ts = '2026-06-14T10:00:00Z') {
      const sent = makeSentMessage(
        { name: '@Human', role: 'Human' },
        { name: '@Manager', role: 'Manager' },
        'user turn',
        id,
      );
      sent.timestamp = ts;
      sent.message.timestamp = ts;
      return sent;
    }

    // --- AC #1: indicator visibility ----------------------------------------
    it('AC #1: indicator SHOWN when not following, not at bottom, unseen content', () => {
      const el = installMockScrollContainer(2000, 400);
      el.scrollTop = 0; // distanceFromBottom = 2000 - 0 - 400 = 1600 > 100
      (component as any).scrollMode = 'idle';
      (component as any).unseenContent = true;

      expect(component.showJumpToLatest).toBe(true);

      // The *ngIf control renders.
      fixture.detectChanges();
      const btn = (fixture.nativeElement as HTMLElement).querySelector(
        '.jump-to-latest',
      );
      expect(btn).not.toBeNull();
    });

    it('AC #1: indicator HIDDEN at bottom (and unseenContent cleared on reaching bottom)', () => {
      const el = installMockScrollContainer(1000, 400);
      el.scrollTop = 600; // distanceFromBottom = 1000 - 600 - 400 = 0 <= 100
      (component as any).scrollMode = 'idle';
      (component as any).unseenContent = true;

      // At bottom → getter false regardless of the flag.
      expect(component.showJumpToLatest).toBe(false);

      // Reaching the bottom via a scroll event clears the flag (AC #1).
      component.onScroll();
      expect((component as any).unseenContent).toBe(false);
    });

    it('AC #1: indicator HIDDEN while following even if not at bottom', () => {
      const el = installMockScrollContainer(2000, 400);
      el.scrollTop = 0; // not near bottom
      (component as any).scrollMode = 'following';
      (component as any).unseenContent = true;

      expect(component.showJumpToLatest).toBe(false);
    });

    it('AC #1: unseenContent SET on growth while not at bottom + not following', () => {
      const el = installMockScrollContainer(2000, 400);
      el.scrollTop = 0; // below the fold
      (component as any).scrollMode = 'idle';

      messagesSubject.next([aiMessage('grow-1')]);
      expect((component as any).unseenContent).toBe(true);
    });

    it('AC #1: unseenContent NOT set on growth while at bottom', () => {
      const el = installMockScrollContainer(800, 400);
      el.scrollTop = 400; // distanceFromBottom = 800 - 400 - 400 = 0 (at bottom)
      (component as any).scrollMode = 'idle';

      messagesSubject.next([aiMessage('grow-2')]);
      expect((component as any).unseenContent).toBe(false);
    });

    // --- AC #2: enter follow on click ---------------------------------------
    it('AC #2: onJumpToLatest enters following, smooth scroll, clears anchor + unseen', () => {
      mockReducedMotion(false);
      const el = installMockScrollContainer(2000, 400);
      el.scrollTop = 0;
      (component as any).scrollMode = 'anchored';
      (component as any).anchorMessageId = 'a-1';
      (component as any).anchorScrollDone = true;
      (component as any).lastAnchorOffsetTop = 600;
      component.spacerHeight = 300;
      (component as any).unseenContent = true;

      component.onJumpToLatest();

      expect((component as any).scrollMode).toBe('following');
      expect(el.scrollToCalls).toBe(1);
      expect(el.lastScrollTo?.top).toBe(2000);
      expect(el.lastScrollTo?.behavior).toBe('smooth');
      // Anchor bookkeeping cleared.
      expect((component as any).anchorMessageId).toBeNull();
      expect(component.spacerHeight).toBe(0);
      // Unseen flag cleared.
      expect((component as any).unseenContent).toBe(false);
    });

    it('AC #2: onJumpToLatest uses instant behavior under prefers-reduced-motion', () => {
      mockReducedMotion(true);
      const el = installMockScrollContainer(2000, 400);
      component.onJumpToLatest();
      expect(el.lastScrollTo?.behavior).toBe('auto');
    });

    // --- AC #2: stay pinned while following ----------------------------------
    it('AC #2: follow tails on EACH subsequent growth (continuous tail)', () => {
      mockReducedMotion(false);
      const el = installMockScrollContainer(2000, 400);
      component.onJumpToLatest();
      expect((component as any).scrollMode).toBe('following');
      expect(el.scrollToCalls).toBe(1); // the click's own scroll

      // First growth → tail armed by subscription, fired by post-layout pass.
      el.scrollHeight = 2400;
      messagesSubject.next([aiMessage('t-1')]);
      component.ngAfterViewChecked();
      expect(el.scrollToCalls).toBe(2);
      expect(el.lastScrollTo?.top).toBe(2400);

      // Second growth → tails again (not a one-shot).
      el.scrollHeight = 2800;
      messagesSubject.next([aiMessage('t-1'), aiMessage('t-2')]);
      component.ngAfterViewChecked();
      expect(el.scrollToCalls).toBe(3);
      expect(el.lastScrollTo?.top).toBe(2800);
    });

    it('AC #2: follow tail routes through the programmatic guard (does not self-release)', () => {
      mockReducedMotion(false);
      const el = installMockScrollContainer(2000, 400);
      component.onJumpToLatest();
      // The programmatic guard is armed by the follow write.
      expect((component as any).isProgrammaticScroll).toBe(true);
      // The follow write's own `scroll` frame arrives near the top — but the
      // guard suppresses any exit (re-arms the debounce, returns early).
      el.scrollTop = 0;
      component.onScroll();
      expect((component as any).scrollMode).toBe('following');
    });

    // --- AC #3: exit follow on scroll up ------------------------------------
    it('AC #3: a genuine user scroll-up exits following → idle, indicator reappears', () => {
      const el = installMockScrollContainer(2000, 400);
      (component as any).scrollMode = 'following';
      (component as any).isProgrammaticScroll = false;
      el.scrollTop = 0; // distanceFromBottom = 1600 > 100 (scrolled up)

      component.onScroll();

      expect((component as any).scrollMode).toBe('idle');
      // The affordance is immediately available (Open Question 5): unseen set.
      expect((component as any).unseenContent).toBe(true);
      expect(component.showJumpToLatest).toBe(true);
    });

    it('AC #3: a near-bottom scroll while following does NOT exit', () => {
      const el = installMockScrollContainer(1000, 400);
      (component as any).scrollMode = 'following';
      (component as any).isProgrammaticScroll = false;
      el.scrollTop = 550; // distanceFromBottom = 50 <= 100 (still near bottom)

      component.onScroll();
      expect((component as any).scrollMode).toBe('following');
    });

    // --- AC #3: exit follow on send -----------------------------------------
    it('AC #3: a send while following re-anchors (following → anchored)', () => {
      mockReducedMotion(false);
      const el = installMockScrollContainer(2000, 500) as any;
      el.querySelector = (_sel: string) => ({ offsetTop: 800 });
      component.onJumpToLatest();
      expect((component as any).scrollMode).toBe('following');

      // A new send: the justSent$ handler resets to idle-intent (supersedes
      // following), the next matching emission resolves the anchor, and the
      // post-layout pass sets `anchored`.
      const key = String(Date.parse('2026-06-14T10:00:01Z'));
      (component.chatService as any).emitJustSent(key);
      expect((component as any).scrollMode).toBe('idle');
      messagesSubject.next([sendUserTurn('snd-1', '2026-06-14T10:05:00Z')]);
      expect((component as any).anchorMessageId).toBe('snd-1');
      component.ngAfterViewChecked();
      expect((component as any).scrollMode).toBe('anchored');
    });

    // --- AC #4: follow-tail hover defer -------------------------------------
    it('AC #4: growth while following + hovered owes a follow-tail (no scroll)', () => {
      mockReducedMotion(false);
      const el = installMockScrollContainer(2000, 400);
      component.onJumpToLatest();
      const callsAfterClick = el.scrollToCalls;

      component.onMouseEnter();
      el.scrollHeight = 2400;
      messagesSubject.next([aiMessage('hov-tail-1')]);
      component.ngAfterViewChecked();

      // Deferred — no scroll fired; the owed kind is the typed follow-tail.
      expect(el.scrollToCalls).toBe(callsAfterClick);
      expect((component as any).owedScroll).toBe('follow-tail');
    });

    it('AC #4: mouseleave replays the follow-tail as a smooth bottom scroll', fakeAsync(() => {
      mockReducedMotion(false);
      const el = installMockScrollContainer(2400, 400);
      (component as any).scrollMode = 'following';
      (component as any).owedScroll = 'follow-tail';

      component.onMouseLeave();
      flushMicrotasks();

      expect(el.scrollToCalls).toBe(1);
      expect(el.lastScrollTo?.top).toBe(2400);
      expect(el.lastScrollTo?.behavior).toBe('smooth');
      expect((component as any).owedScroll).toBeNull();
      flush(); // drain the programmatic-scroll settle timer the replay armed
    }));
  });
});
