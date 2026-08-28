import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { provideMarkdown } from 'ngx-markdown';

import {
  AgentConversationModalComponent,
  AgentRef,
} from './agent-conversation-modal.component';
import { ChatMessage } from '../../selectors/chat-message.model';
import { NodeInterface } from '../../models/types';
import { ActorAddress } from '../../../../protocol/message.types';

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
      providers: [provideMarkdown()],
    }).compileComponents();

    fixture = TestBed.createComponent(AgentConversationModalComponent);
    component = fixture.componentInstance;
  });

  /** Render the reader open, on `agentId`, over `messages`. */
  function open(
    messages: ChatMessage[],
    agentId: string | null,
    agents: NodeInterface[] = [MANAGER, WORKER, SILENT],
  ): void {
    fixture.componentRef.setInput('visible', true);
    fixture.componentRef.setInput('agents', agents);
    fixture.componentRef.setInput('messages', messages);
    fixture.componentRef.setInput('selectedAgentId', agentId);
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
      open([makeChatMessage()], 'silent');
      const empty = document.querySelector('.conversation-column .empty-state');
      expect(empty).not.toBeNull();
      expect(empty!.textContent).toContain('Reviewer');
      expect(empty!.textContent).toContain('not sent or received');
      expect(document.querySelectorAll('app-chat-message').length).toBe(0);
    });

    it('asks for an agent when none is selected', () => {
      open([makeChatMessage()], null);
      const empty = document.querySelector('.conversation-column .empty-state');
      expect(empty!.textContent).toContain('Select an agent');
    });
  });

  describe('read-only', () => {
    it('offers no way to write from the reader', () => {
      // NFR1: every write path in this app has a routing contract behind it,
      // and none of them belongs to a reader.
      const request = makeChatMessage({ id: 'r3', rule: 3, collapsed: false });
      open([request], 'manager');

      expect(document.querySelector('.conversation-column textarea')).toBeNull();
      // The Reply affordance that ChatMessageComponent draws for a rule-3 turn
      // is inert here: the reader passes no notification, so it is disabled.
      const reply = document.querySelector<HTMLButtonElement>(
        '.conversation-column .open-button button',
      );
      expect(reply?.disabled).withContext('Reply must be inert in the reader').toBe(true);
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

      expect(document.querySelector('.collapsed-line')).toBeNull();
      expect(document.querySelector('.message-bubble')).not.toBeNull();
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
