import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { provideMarkdown } from 'ngx-markdown';

import {
  AgentConversationModalComponent,
  AgentReaderService,
  AgentRef,
  ReaderSendRequest,
} from './agent-conversation-modal.component';
import { ChatMessage } from '../../selectors/chat-message.model';
import { ThinkingState } from '../../selectors/chat.selector';
import { NodeInterface } from '../../models/types';
import { ActorAddress } from '../../../../protocol/message.types';

import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../../testing/i18n-testing';

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
    name: 'manager',
    role: 'Manager',
    actorName: '@Manager-manager',
    parentId: '',
    squadId: 'squad-1',
    symbol: 'roundRect',
    category: 0,
    userMessage: false,
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
    sender: makeAddress({ name: '@Manager-manager', agent_id: 'manager' }),
    recipient: makeAddress({ name: '@Worker-worker', agent_id: 'worker' }),
    timestamp: new Date('2026-04-08T10:00:00Z'),
    rule: 4,
    alignment: 'left',
    color: 'transparent',
    collapsed: true,
    label: '@Manager ⇒ @Worker',
    ...overrides,
  };
}

function makeRun(overrides: Partial<ThinkingState> = {}): ThinkingState {
  return {
    agent_id: 'manager',
    agent_name: '@Manager',
    start_time: new Date('2026-04-08T10:00:01Z'),
    tools: [],
    anchor_message_id: 'inner-run-1',
    final: false,
    ...overrides,
  };
}

const MANAGER = makeNode();
const WORKER = makeNode({
  name: 'worker',
  role: 'Worker',
  actorName: '@Worker-worker',
});
const SILENT = makeNode({
  name: 'silent',
  role: 'Reviewer',
  actorName: '@Reviewer-reviewer',
});

describe('AgentConversationModalComponent', () => {
  let component: AgentConversationModalComponent;
  let fixture: ComponentFixture<AgentConversationModalComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AgentConversationModalComponent, NoopAnimationsModule],
      providers: [provideMarkdown(), provideTranslateTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(AgentConversationModalComponent);
    component = fixture.componentInstance;
  });

  /** Render the reader open, on `agentId`, over `messages`. */
  function open(
    messages: ChatMessage[],
    agentId: string | null,
    agents: NodeInterface[] = [MANAGER, WORKER, SILENT],
    runs: ThinkingState[] = [],
  ): void {
    fixture.componentRef.setInput('visible', true);
    fixture.componentRef.setInput('agents', agents);
    fixture.componentRef.setInput('messages', messages);
    fixture.componentRef.setInput('runs', runs);
    fixture.componentRef.setInput('selectedAgentId', agentId);
    fixture.detectChanges();
  }

  /** `open`, plus the host's set of still-unanswered request ids. Separate
   *  helper so the many specs that do not care about request state keep reading
   *  as they did. */
  function openPending(
    messages: ChatMessage[],
    agentId: string | null,
    pending: string[],
  ): void {
    fixture.componentRef.setInput('pendingNotifications', new Set(pending));
    open(messages, agentId);
  }

  /** The composer is gated on a RUNNING team; most specs want it usable. */
  function enableComposer(): void {
    fixture.componentRef.setInput('canSend', true);
    fixture.detectChanges();
  }

  it('should create', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  describe('the team list', () => {
    it('renders one row per graph node, in the order the graph gives them', () => {
      // The list IS the graph's node list. This component derives no membership
      // of its own — two lists of "who is on this team" that can disagree,
      // eventually will.
      open([], 'manager');
      const rows = Array.from(document.querySelectorAll('.agent-item'));
      expect(rows.length).toBe(3);
      expect(rows.map((r) => r.getAttribute('data-agent-id'))).toEqual([
        'manager',
        'worker',
        'silent',
      ]);
    });

    it('marks the app-selected agent, and only that one', () => {
      open([], 'worker');
      const selected = Array.from(
        document.querySelectorAll('.agent-item.selected'),
      );
      expect(selected.length).toBe(1);
      expect(selected[0].getAttribute('data-agent-id')).toBe('worker');
    });

    it('emits the picked agent rather than selecting it internally', () => {
      // Selection is global: the reader asks for a move and lets the app's one
      // SelectionService make it, so the right-hand panel cannot fall out of
      // step with what the reader is showing.
      open([], 'manager');
      const emitted: AgentRef[] = [];
      component.agentSelected.subscribe((a) => emitted.push(a));

      const worker = document.querySelector<HTMLElement>(
        '.agent-item[data-agent-id="worker"]',
      );
      worker!.click();

      expect(emitted).toEqual([
        { agentId: 'worker', actorName: '@Worker-worker' },
      ]);
      // It did NOT move itself.
      expect(component.selectedAgentId()).toBe('manager');
    });
  });

  describe('the conversation', () => {
    it('shows every turn the agent sent OR received', () => {
      const sent = makeChatMessage({ id: 'sent' });
      const received = makeChatMessage({
        id: 'received',
        sender: makeAddress({ name: '@Worker-worker', agent_id: 'worker' }),
        recipient: makeAddress({ name: '@Manager-manager', agent_id: 'manager' }),
      });
      const elsewhere = makeChatMessage({
        id: 'elsewhere',
        sender: makeAddress({ name: '@Worker-worker', agent_id: 'worker' }),
        recipient: makeAddress({ name: '@Other-other', agent_id: 'other' }),
      });

      open([sent, received, elsewhere], 'manager');

      const ids = Array.from(
        document.querySelectorAll('app-chat-message'),
      ).map((el) => el.getAttribute('data-message-id'));
      expect(ids).toEqual(['sent', 'received']);
    });

    it('renders with the SAME message component the main panel uses', () => {
      // FR3 / T1: the unit reused is the message, not the panel. If this ever
      // becomes a second renderer, the two surfaces start drifting apart.
      open([makeChatMessage({ id: 'm1', rule: 2, collapsed: false })], 'manager');
      const el = document.querySelector('app-chat-message');
      expect(el).withContext('the reader must delegate to ChatMessageComponent').not.toBeNull();
      expect(el!.querySelector('.label-pill')).not.toBeNull();
      expect(el!.querySelector('.markdown-content markdown')).not.toBeNull();
      expect(el!.textContent).toContain('@Manager ⇒ @Worker');
    });

    it('follows the app selection when it moves, in place', () => {
      const managerTurn = makeChatMessage({ id: 'manager-turn' });
      const workerTurn = makeChatMessage({
        id: 'worker-turn',
        sender: makeAddress({ name: '@Worker-worker', agent_id: 'worker' }),
        recipient: makeAddress({ name: '@Other-other', agent_id: 'other' }),
      });
      open([managerTurn, workerTurn], 'manager');

      fixture.componentRef.setInput('selectedAgentId', 'worker');
      fixture.detectChanges();

      const ids = Array.from(
        document.querySelectorAll('app-chat-message'),
      ).map((el) => el.getAttribute('data-message-id'));
      // Both turns involve the worker as sender or recipient.
      expect(ids).toEqual(['manager-turn', 'worker-turn']);
      // One dialog, not two: the reader moved rather than stacking.
      expect(document.querySelectorAll('.reader').length).toBe(1);
    });

    it('names the agent it is showing', () => {
      open([], 'worker');
      expect(component.headerText()).toContain('Worker');
    });
  });

  describe('empty states', () => {
    it('says an agent that never ran has nothing to show', () => {
      // T6: a team lists agents that have not spoken. Silence has to read as
      // silence, not as a load that failed.
      // T3: the agent's NAME is a parameter of this sentence, and the
      // key-echoing test loader substitutes nothing — so `toContain('Reviewer')`
      // would fail whether or not the component threaded it. The registered
      // template is deliberately synthetic; what is pinned is that the name
      // arrives, not the English around it.
      setTestTranslations({ chat: { reader: { noTurns: '<<silent:{{agent}}>>' } } });
      open([makeChatMessage()], 'silent');
      const empty = document.querySelector('.conversation-column .empty-state');
      expect(empty).not.toBeNull();
      expect(empty!.textContent).toContain('<<silent:');
      expect(empty!.textContent).toContain('Reviewer');
      expect(document.querySelectorAll('app-chat-message').length).toBe(0);
    });

    it('asks for an agent when none is selected', () => {
      open([makeChatMessage()], null);
      const empty = document.querySelector('.conversation-column .empty-state');
      expect(empty!.textContent).toContain('chat.reader.selectAgent');
    });
  });

  // The reader gained a composer (W5b), but the TRANSCRIPT did not gain a write
  // path. That distinction is the whole of the rule that replaced "read-only":
  // a reader must not invent a routing contract, and it must not turn somebody
  // else's pending request into an action the user can take from here.
  describe('the transcript stays inert', () => {
    it('offers no reply affordance inside the conversation itself', () => {
      const request = makeChatMessage({ id: 'r3', rule: 3, collapsed: false });
      // The request is LIVE. Inertness must not depend on that — it used to,
      // and the accidental disabling was the bug: the reader left
      // `notification` unbound, which both disabled Reply and made the fold
      // claim the request had been answered.
      openPending([request], 'manager', ['r3']);

      // The one place you can type is the composer, and it is not in here.
      expect(document.querySelector('.conversation-column textarea')).toBeNull();
      // Not merely disabled — ABSENT. Answering opens the human-input modal,
      // which only the main panel hosts, so there is no button to press rather
      // than a button that reaches nothing.
      expect(document.querySelector('.conversation-column .open-button'))
        .withContext('Reply must not be offered in the reader')
        .toBeNull();
    });

    /**
     * The reader REPORTS a request's state; it does not invent one.
     *
     * `notification` is a fact about the message, and the new request fold
     * states it in words. An unbound input therefore stopped meaning "say
     * nothing" and started meaning "claim this was answered" — over a request
     * a human was still being waited on for.
     */
    it('shows an outstanding request as pending, not as answered', () => {
      setTestTranslations({
        chat: {
          request: { pending: '<<pending>>', answered: '<<answered>>' },
        },
      });
      const request = makeChatMessage({ id: 'r3', rule: 3, collapsed: true });
      openPending([request], 'manager', ['r3']);

      const fold = document.querySelector('.collapsed-request');
      expect(fold).not.toBeNull();
      expect(fold!.textContent).toContain('<<pending>>');
      expect(fold!.classList.contains('answered'))
        .withContext('a live request must not recede')
        .toBe(false);
    });

    it('shows a resolved request as answered', () => {
      setTestTranslations({
        chat: {
          request: { pending: '<<pending>>', answered: '<<answered>>' },
        },
      });
      const request = makeChatMessage({ id: 'r3', rule: 3, collapsed: true });
      openPending([request], 'manager', []);

      const fold = document.querySelector('.collapsed-request');
      expect(fold!.textContent).toContain('<<answered>>');
      expect(fold!.classList.contains('answered')).toBe(true);
    });

    it('offers no RATING control — submitting a rating is a send', () => {
      // Cross-epic: Epic 57 embedded a rating control inside
      // `ChatMessageComponent`, which this reader renders. Rating submits, and
      // NFR1 says this surface sends nothing — so the reader opts out with
      // `[ratingEnabled]="false"`.
      //
      // Neither epic could see the other: 57 was written against the main
      // conversation and 51 against a component that did not yet rate. This
      // spec is the only thing standing between the reader and a write path it
      // would otherwise inherit silently the next time the shared component
      // grows one.
      const answer = makeChatMessage({ id: 'a1', rule: 2, collapsed: false });
      open([answer], 'manager');

      expect(document.querySelector('.conversation-column app-feedback'))
        .withContext('the reader must not offer a rating')
        .toBeNull();
    });

    it('expands a folded line without touching the main conversation', () => {
      // FR7: closing the reader must return the user to the conversation
      // exactly as they left it, so the reader renders copies and keeps its own
      // expansion state rather than toggling the shared message objects.
      const folded = makeChatMessage({ id: 'folded', rule: 4, collapsed: true });
      open([folded], 'manager');
      expect(document.querySelector('.collapsed-line')).not.toBeNull();

      component.onToggleCollapse(component.conversation()[0]);
      fixture.detectChanges();

      // THE SAME ROW, opened. A notification no longer swaps for a bubble — it
      // lets its own sentence finish — so what proves it expanded is the text
      // being unclipped, not a different element appearing.
      expect(document.querySelector('.collapsed-line')).not.toBeNull();
      expect(document.querySelector('.notice-text.expanded')).not.toBeNull();
      expect(folded.collapsed)
        .withContext('the shared message object must be untouched')
        .toBe(true);
    });

    it('re-folds on a second toggle', () => {
      const folded = makeChatMessage({ id: 'folded', rule: 4, collapsed: true });
      open([folded], 'manager');
      component.onToggleCollapse(component.conversation()[0]);
      fixture.detectChanges();
      component.onToggleCollapse(component.conversation()[0]);
      fixture.detectChanges();
      expect(document.querySelector('.collapsed-line')).not.toBeNull();
    });
  });

  // --- following a mention (Story 51-2) --------------------------------------
  //
  // The reader is a place you read FROM, not just a place you land: an agent
  // named in the conversation is the natural next thing to want, and clicking
  // it should move the reader rather than send you back to the chat to start
  // again.
  describe('following a mention', () => {
    function emitted(): AgentRef[] {
      const seen: AgentRef[] = [];
      component.agentSelected.subscribe((a) => seen.push(a));
      return seen;
    }

    it('moves to the agent whose badge was clicked, in place', () => {
      const turn = makeChatMessage({
        id: 'm1',
        rule: 2,
        collapsed: false,
        sender: makeAddress({ name: '@Worker-worker', agent_id: 'worker' }),
        recipient: makeAddress({ name: '@Manager-manager', agent_id: 'manager' }),
      });
      open([turn], 'manager');
      const seen = emitted();

      const pill = document.querySelector<HTMLElement>(
        '.conversation-column .label-pill',
      );
      pill!.click();

      expect(seen).toEqual([{ agentId: 'worker', actorName: '@Worker-worker' }]);
      // In place: one dialog, and it did not move itself — the host owns
      // selection and hands the new agent back down.
      expect(document.querySelectorAll('.reader').length).toBe(1);
      expect(component.selectedAgentId()).toBe('manager');
    });

    it('ignores the agent it is already showing', () => {
      const turn = makeChatMessage({ id: 'm1', rule: 2, collapsed: false });
      open([turn], 'manager');
      const seen = emitted();

      component.onMessageAgentClick(turn);

      expect(seen).toEqual([]);
    });

    it('refuses an actor that is not on the team', () => {
      // An envelope can name a transport listener. Selecting one would point
      // the app at something the agent list cannot show.
      const turn = makeChatMessage({
        id: 'm1',
        sender: makeAddress({ name: '@ActorSystem', agent_id: 'actor-system' }),
      });
      open([turn], 'manager');
      const seen = emitted();

      component.onMessageAgentClick(turn);

      expect(seen).toEqual([]);
    });

    it('never fires for the turns that name no agent', () => {
      // T5: the user's own turn and the system announcement are not agents.
      // The shared message component already refuses to emit for either, and
      // the reader inherits that guard by reusing it rather than re-deriving
      // the rule.
      for (const rule of [1, 5] as const) {
        open(
          [
            makeChatMessage({
              id: 'm-' + rule,
              rule,
              collapsed: false,
              sender: makeAddress({ name: '@Worker-worker', agent_id: 'worker' }),
              recipient: makeAddress({
                name: '@Manager-manager',
                agent_id: 'manager',
              }),
            }),
          ],
          'manager',
        );
        const seen = emitted();

        // Stronger than it used to be: these turns no longer render a name to
        // click. Rule 1 is your own words — labelling them names the reader —
        // and rule 5 is a centred rule, not a turn. The guard that used to stop
        // the emit is now the absence of the control.
        const pill = document.querySelector<HTMLElement>(
          '.conversation-column .label-pill',
        );
        expect(pill).withContext('rule ' + rule + ' offers no name').toBeNull();
        expect(seen).withContext('rule ' + rule + ' names no agent').toEqual([]);
      }
    });
  });

  // --- the agent's own activity (W3) ----------------------------------------
  //
  // Before this, the reader showed no runs at all while the main panel showed
  // everyone's — two wrong answers to one question. One scoping rule, applied
  // at both ends: the runs on screen are the runs of the inbox on screen.
  describe('activity folds', () => {
    it('shows the open agent’s runs, interleaved chronologically', () => {
      const early = makeChatMessage({
        id: 'early',
        timestamp: new Date('2026-04-08T10:00:00Z'),
      });
      const late = makeChatMessage({
        id: 'late',
        timestamp: new Date('2026-04-08T10:00:10Z'),
      });
      open([early, late], 'manager', [MANAGER, WORKER, SILENT], [
        makeRun({ agent_id: 'manager', start_time: new Date('2026-04-08T10:00:05Z') }),
      ]);

      const rows = Array.from(
        document.querySelectorAll(
          '.conversation-column app-chat-message, .conversation-column app-chat-thinking',
        ),
      ).map((el) => el.tagName.toLowerCase());
      expect(rows).toEqual([
        'app-chat-message',
        'app-chat-thinking',
        'app-chat-message',
      ]);
    });

    it('shows no other agent’s runs', () => {
      open([makeChatMessage()], 'manager', [MANAGER, WORKER, SILENT], [
        makeRun({ agent_id: 'worker', anchor_message_id: 'inner-elsewhere' }),
      ]);

      expect(
        document.querySelectorAll('.conversation-column app-chat-thinking').length,
      ).toBe(0);
    });

    it('keeps a message whose absorbing run belongs to another agent', () => {
      // The highest-consequence invariant in the shared selector: contact-step
      // exclusion is derived from the runs HANDED to it. Were the global run
      // list passed here, @Manager's instruction to @Worker would be deleted
      // from this view with no fold left to show it in — and with it the only
      // explanation of why @Worker ran.
      const instruction = makeChatMessage({ id: 'instruction' });
      const managersRun = makeRun({
        agent_id: 'manager',
        tools: [
          {
            tool_call_id: 'instruction',
            tool_name: '@Worker',
            arguments_preview: '',
            done: true,
            kind: 'contact',
          },
        ],
      });
      const workersRun = makeRun({
        agent_id: 'worker',
        anchor_message_id: 'inner-instruction',
        start_time: new Date('2026-04-08T10:00:02Z'),
      });

      open([instruction], 'worker', [MANAGER, WORKER, SILENT], [
        managersRun,
        workersRun,
      ]);

      const ids = Array.from(
        document.querySelectorAll('.conversation-column app-chat-message'),
      ).map((el) => el.getAttribute('data-message-id'));
      expect(ids).toEqual(['instruction']);
      expect(
        document.querySelectorAll('.conversation-column app-chat-thinking').length,
      ).toBe(1);
    });

    it('draws a calendar-day rule when the reader’s own turns cross midnight', () => {
      // A consequence of sharing the merge, not a second implementation: the
      // reader never had day separators and now gets them for free.
      open(
        [
          makeChatMessage({ id: 'd1', timestamp: new Date(2026, 3, 8, 10, 0) }),
          makeChatMessage({ id: 'd2', timestamp: new Date(2026, 3, 9, 10, 0) }),
        ],
        'manager',
      );

      const rules = Array.from(
        document.querySelectorAll('.conversation-column .day-separator'),
      ).map((n) => (n.textContent ?? '').trim());
      expect(rules).toEqual(['2026-04-09']);
    });

    it('keeps its own run-expansion state', () => {
      const run = makeRun({ agent_id: 'manager', anchor_message_id: 'anc-1' });
      open([makeChatMessage()], 'manager', [MANAGER, WORKER, SILENT], [run]);

      expect(component.isRunExpanded(run)).toBe(false);
      component.onToggleRunExpanded('anc-1');
      expect(component.isRunExpanded(run)).toBe(true);
      component.onToggleRunExpanded('anc-1');
      expect(component.isRunExpanded(run)).toBe(false);
    });
  });

  // --- the composer (W5b) -----------------------------------------------------
  describe('messaging the open agent', () => {
    function sends(): ReaderSendRequest[] {
      const seen: ReaderSendRequest[] = [];
      component.sendToAgent.subscribe((r) => seen.push(r));
      return seen;
    }

    function textarea(): HTMLTextAreaElement {
      return document.querySelector<HTMLTextAreaElement>('.reader-composer-input')!;
    }

    /** Type into the real box, so the binding is exercised too. */
    function typeDraft(value: string): void {
      const box = textarea();
      box.value = value;
      box.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    }

    function sendButton(): HTMLButtonElement {
      return document.querySelector<HTMLButtonElement>('.reader-composer-send')!;
    }

    it('asks the host to send — it does not route the message itself', () => {
      // The reader must not invent a routing contract; the host performs the
      // app's existing "send to one named agent" call.
      open([], 'worker');
      enableComposer();
      const seen = sends();

      typeDraft('  what did you find?  ');
      fixture.detectChanges();
      sendButton().click();

      expect(seen).toEqual([
        {
          agentId: 'worker',
          actorName: '@Worker-worker',
          content: 'what did you find?',
        },
      ]);
    });

    it('carries the ACTOR NAME as well as the agent id', () => {
      // The send path addresses the actor by name in the URL; an agent_id
      // there addresses nobody. Resolving it where the graph node is in hand
      // is what keeps the two from being confused at the call site.
      open([], 'worker');
      enableComposer();
      const seen = sends();

      typeDraft('hi');
      component.onSend();

      expect(seen[0].actorName).toBe('@Worker-worker');
      expect(seen[0].agentId).toBe('worker');
      expect(seen[0].actorName).not.toBe(seen[0].agentId);
    });

    it('clears the box on send, so one keystroke cannot send twice', () => {
      open([], 'worker');
      enableComposer();
      const seen = sends();

      typeDraft('once');
      component.onSend();
      component.onSend();

      expect(seen.length).toBe(1);
    });

    it('sends nothing but whitespace', () => {
      open([], 'worker');
      enableComposer();
      const seen = sends();

      typeDraft('   ');
      fixture.detectChanges();

      expect(sendButton().disabled).toBe(true);
      component.onSend();
      expect(seen).toEqual([]);
    });

    it('is disabled while the team is not running', () => {
      // A stopped team accepts no message. An enabled control that silently
      // does nothing is worse than a disabled one.
      open([], 'worker');
      const seen = sends();
      typeDraft('hello');
      fixture.detectChanges();

      expect(textarea().disabled).toBe(true);
      expect(sendButton().disabled).toBe(true);
      component.onSend();
      expect(seen).toEqual([]);
    });

    it('offers nothing to type into when no agent is open', () => {
      // There is no "send to the team" here — that is the main composer's job,
      // and a broadcast from a per-agent reader would be a different message
      // than the one the user thinks they are writing.
      open([], null);
      enableComposer();
      expect(document.querySelector('.reader-composer')).toBeNull();
    });

    it('drops the draft when the reader moves to another agent', () => {
      // A half-typed message belongs to the agent it was addressed to. Carrying
      // it across would deliver it to somebody it was never meant for.
      open([], 'manager');
      enableComposer();
      typeDraft('meant for the manager');

      const worker = document.querySelector<HTMLElement>(
        '.agent-item[data-agent-id="worker"]',
      );
      worker!.click();

      expect(component.draft()).toBe('');
    });

    it('sends on Enter and breaks the line on Shift+Enter', () => {
      open([], 'worker');
      enableComposer();
      const seen = sends();
      typeDraft('line one');

      const shifted = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true });
      component.onComposerKeydown(shifted);
      expect(seen).toEqual([]);
      expect(shifted.defaultPrevented).toBe(false);

      const plain = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
      component.onComposerKeydown(plain);
      expect(seen.length).toBe(1);
      expect(plain.defaultPrevented).toBe(true);
    });
  });

  describe('AgentReaderService', () => {
    it('delivers an open request to whoever is hosting the reader', () => {
      const service = new AgentReaderService();
      const seen: AgentRef[] = [];
      service.open$.subscribe((a) => seen.push(a));

      service.open({ agentId: 'worker', actorName: '@Worker-worker' });

      expect(seen).toEqual([{ agentId: 'worker', actorName: '@Worker-worker' }]);
    });

    it('replays nothing to a subscriber that arrives later', () => {
      // "Open the reader" is an event. A replayed last value would re-open the
      // dialog the user had just dismissed.
      const service = new AgentReaderService();
      service.open({ agentId: 'worker', actorName: '@Worker-worker' });

      const late: AgentRef[] = [];
      service.open$.subscribe((a) => late.push(a));

      expect(late).toEqual([]);
    });
  });

  it('reports its own close so the host can hide it', () => {
    open([], 'manager');
    const seen: boolean[] = [];
    component.visibleChange.subscribe((v) => seen.push(v));

    component.onVisibleChange(false);
    expect(seen).toEqual([false]);

    // An open event is the host's business, not the dialog's — it must not
    // echo one back.
    component.onVisibleChange(true);
    expect(seen).toEqual([false]);
  });
});
