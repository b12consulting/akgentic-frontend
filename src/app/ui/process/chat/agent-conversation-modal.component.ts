import { CommonModule } from '@angular/common';
import {
  Component,
  computed,
  EventEmitter,
  input,
  Output,
  signal,
} from '@angular/core';
import { DialogModule } from 'primeng/dialog';

import { agentConversation } from '../../../core/services/process/selectors/agent-conversation.selector';
import { ChatMessage } from '../../../core/services/process/selectors/chat-message.model';
import { ThinkingState } from '../../../core/services/process/selectors/chat.selector';
import {
  agentRuns,
  buildDisplayItems,
  DisplayItem,
  trackDisplayItem,
} from '../../../core/services/process/selectors/display-items';
import { NodeInterface } from '../../../core/services/process/models/types';
import {
  AgentColours,
  NO_AGENT_COLOURS,
} from '../../../core/services/process/selectors/agent-colour';
import { makeAgentNameUserFriendly } from '../../../core/shared/util/util';
import { TranslatePipe } from '@ngx-translate/core';

import type { AgentRef } from './agent-reader.service';

import { ChatMessageComponent } from './chat-message.component';
import { ChatThinkingComponent } from '../../../components/process/chat/chat-thinking.component';

/** What the reader's composer asks its host to send. */
export interface ReaderSendRequest extends AgentRef {
  content: string;
}

/**
 * `AgentRef` and `AgentReaderService` now live in their own file — they are shell
 * plumbing shared with the inspector, not reader internals, and keeping the
 * inspector importing a chat COMPONENT file to reach them was the wrong
 * dependency direction. Re-exported here so existing importers of this module
 * keep compiling; new callers should import from `ui/process/chat/agent-reader.service`.
 */
export { AgentReaderService } from './agent-reader.service';
export type { AgentRef } from './agent-reader.service';

/** The rules that render as a collapsed one-liner until the reader opens them.
 *  3/4 are the agent-to-agent lines; 6 is the compaction fold. */
const COLLAPSIBLE_RULES: ReadonlySet<number> = new Set([3, 4, 6]);

/**
 * A READER for one agent's conversation: the team down the left, the selected
 * agent's dialogue on the right.
 *
 * WHY THIS IS NOT A SECOND CHAT PANEL. The right-hand column renders with
 * `ChatMessageComponent` — the very component the main panel uses, not a copy
 * and not a variant — so the conversation surface, the collapse behaviour and
 * the label badge are the same here as there by construction, and cannot drift
 * apart in a later epic. `ChatPanelComponent` itself is deliberately NOT reused:
 * it owns scroll anchoring, the "new messages" pill, the reply modal and the
 * input box, none of which a reader wants and all of which would have arrived
 * together.
 *
 * PRESENTATIONAL. It holds no selection of its own (that would fight the app's
 * single `SelectionService` notion of "selected agent" and leave the right-hand
 * panel pointing elsewhere on close) and it fetches nothing (the message log is
 * already in memory; a request here would make a reader feel like a
 * navigation). Everything it shows arrives as an input; everything it wants
 * changed leaves as an output — INCLUDING the send. The one thing it does
 * NOT offer is the reply control: answering a request opens the human-input
 * modal, which lives in the main panel, so the reader reports a request's
 * state (`pendingNotifications`) and leaves acting on it there.
 *
 * IT IS NO LONGER READ-ONLY (W5b), and the distinction that replaced that rule
 * matters. The old rule was "every write path has a routing contract behind it,
 * and a reader is not the place to exercise one". What actually follows from
 * that is: a reader must not INVENT a routing contract. So the composer here
 * emits `sendToAgent` and the host performs the app's existing "send to one
 * named agent" call — the same one the main composer's Send-to makes. The
 * transcript itself stays inert: no reply affordance, no rating, no edit.
 *
 * WHAT IT SHOWS is scoped by the same rule the main transcript uses (W3): the
 * selected agent's own turns, interleaved with the selected agent's own runs.
 * Before, the reader showed no activity at all while the main panel showed
 * everyone's — two wrong answers to one question.
 */
@Component({
  selector: 'app-agent-conversation-modal',
  standalone: true,
  imports: [
    CommonModule,
    DialogModule,
    ChatMessageComponent,
    ChatThinkingComponent,
    TranslatePipe,
  ],
  templateUrl: './agent-conversation-modal.component.html',
  styleUrl: './agent-conversation-modal.component.scss',
})
export class AgentConversationModalComponent {
  visible = input<boolean>(false);
  /** The team, straight from the existing graph nodes. This component derives
   *  no membership of its own: two lists of "who is in this team" that can
   *  disagree eventually will. */
  agents = input<NodeInterface[]>([]);
  /** The whole classified conversation; the reader filters it per agent. */
  messages = input<ChatMessage[]>([]);
  /** EVERY agent's activity folds; the reader filters them per agent, exactly
   *  as it does the messages. Handed the whole list rather than a pre-filtered
   *  one so the reader's two halves are scoped by one rule in one place. */
  runs = input<ThinkingState[]>([]);
  /**
   * The INNER `BaseMessage.id` of every rule-3 request still awaiting a human,
   * straight from the host — the same set the main transcript keys its request
   * state off. Handed down rather than re-derived: two surfaces computing "is
   * this still open?" from different inputs is how one of them ends up stating
   * the opposite of the other, which is precisely what an unbound default did.
   */
  pendingNotifications = input<ReadonlySet<string>>(new Set<string>());
  /** `agent_id` of the app-wide selected agent — the reader follows it. */
  selectedAgentId = input<string | null>(null);
  /**
   * The team's agent→colour lookup, handed down from the host.
   *
   * Not rebuilt from `agents()` here even though the roster is right there:
   * this dialog is handed a list the host has already narrowed, and building
   * the lookup from a narrowed list is exactly how two surfaces end up
   * assigning the same agent different stops. One lookup, built once, passed
   * around — the same rule `pendingNotifications` follows and for the same
   * reason.
   */
  agentColours = input<AgentColours>(NO_AGENT_COLOURS);

  /** Whether the team can accept a message at all (the process is running). */
  canSend = input<boolean>(false);

  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() agentSelected = new EventEmitter<AgentRef>();
  @Output() sendToAgent = new EventEmitter<ReaderSendRequest>();

  /** The composer's text. Owned here because it is transient UI state; it is
   *  cleared on send and when the reader moves to another agent, so a half-typed
   *  message can never be delivered to somebody it was not addressed to. */
  readonly draft = signal<string>('');

  /**
   * Ids the reader has been asked to expand.
   *
   * The reader keeps its OWN expansion state and renders COPIES of the
   * messages, rather than toggling `collapsed` on the shared `ChatMessage`
   * objects: those objects belong to the main conversation, and closing this
   * modal must leave that conversation exactly as it was found.
   */
  private readonly expandedIds = signal<ReadonlySet<string>>(new Set<string>());

  readonly selectedAgent = computed(
    () => this.agents().find((a) => a.name === this.selectedAgentId()) ?? null,
  );

  /**
   * The header the SELECTED AGENT gives this dialog, or `null` when none is.
   *
   * `null` rather than a default sentence: the name is the backend's and has no
   * translation key (T6), so only the fallback is copy and only the fallback
   * goes through the layer — in the template, where the boundary shows.
   */
  readonly headerText = computed<string | null>(() => {
    const agent = this.selectedAgent();
    return agent ? makeAgentNameUserFriendly(agent.actorName) : null;
  });

  /** The selected agent's turns, with this reader's expansion applied. */
  readonly conversation = computed<ChatMessage[]>(() => {
    const expanded = this.expandedIds();
    return agentConversation(this.messages(), this.selectedAgentId()).map((m) =>
      COLLAPSIBLE_RULES.has(m.rule)
        ? { ...m, collapsed: !expanded.has(m.id) }
        : m,
    );
  });

  /** Anchor ids of the runs this reader has been asked to expand. Its OWN set,
   *  for the same reason the collapse state is its own: the main panel's
   *  expansion is the user's place in the main conversation. */
  private readonly expandedRunIds = signal<ReadonlySet<string>>(new Set<string>());

  /** The reader's transcript: the agent's turns and the agent's runs, merged.
   *
   *  `agentRuns` is applied BEFORE `buildDisplayItems`, and the result is what
   *  is handed in — never the global list. The contact-step exclusion is derived
   *  from the runs given, so passing the global list here would delete from this
   *  view the very messages whose folds it is not showing. */
  readonly displayItems = computed<DisplayItem[]>(() =>
    buildDisplayItems(this.conversation(), agentRuns(this.runs(), this.selectedAgentId())),
  );

  /** True once there is an agent to address and a team able to receive. */
  readonly composerEnabled = computed<boolean>(
    () => this.canSend() && this.selectedAgent() !== null,
  );

  readonly sendDisabled = computed<boolean>(
    () => !this.composerEnabled() || this.draft().trim().length === 0,
  );

  /** Mirrors the main panel's `hasNotification`: only a rule-3 message can be
   *  outstanding, and the set is keyed by the INNER id so a reply's `parent_id`
   *  clears the right entry. */
  isPending(message: ChatMessage): boolean {
    return message.rule === 3 && this.pendingNotifications().has(message.message_id);
  }

  isRunExpanded(state: ThinkingState): boolean {
    return this.expandedRunIds().has(state.anchor_message_id);
  }

  onToggleRunExpanded(anchorId: string): void {
    const next = new Set(this.expandedRunIds());
    if (next.has(anchorId)) {
      next.delete(anchorId);
    } else {
      next.add(anchorId);
    }
    this.expandedRunIds.set(next);
  }

  /** Reads the box. Takes the event rather than a string so the template needs
   *  no `$any` to get at the target — the cast belongs in typed code. */
  onDraftInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * Send the draft to the agent currently open — not to the team.
   *
   * The request carries the ACTOR NAME as well as the `agent_id` because the
   * send path addresses the actor by name; resolving it here, where the graph
   * node is in hand, keeps the host from having to look it up again and keeps
   * the two identities from being confused at the call site.
   */
  onSend(): void {
    const agent = this.selectedAgent();
    const content = this.draft().trim();
    if (!agent || !this.composerEnabled() || content.length === 0) return;
    this.sendToAgent.emit({
      agentId: agent.name,
      actorName: agent.actorName,
      content,
    });
    this.draft.set('');
  }

  /** Enter sends, Shift+Enter breaks the line — the main composer's contract. */
  onComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    this.onSend();
  }

  agentLabel(agent: NodeInterface): string {
    return makeAgentNameUserFriendly(agent.actorName);
  }

  isSelected(agent: NodeInterface): boolean {
    return agent.name === this.selectedAgentId();
  }

  onAgentClick(agent: NodeInterface): void {
    this.draft.set('');
    this.agentSelected.emit({
      agentId: agent.name,
      actorName: agent.actorName,
    });
  }

  /**
   * An agent named inside the conversation was clicked — move the reader to it,
   * IN PLACE. No second dialog on top of this one, and no route change: the
   * user is following a thread, not navigating away from it.
   *
   * `ChatMessageComponent` has already refused the two rules that name no agent
   * before emitting — the user's own turn and the system announcement. What is
   * left to refuse here is an actor that appears on an envelope without being a
   * member of the team (a transport listener, say): selecting one would point
   * the reader, and with it the whole app, at something the left-hand list
   * cannot even show.
   *
   * The badge reads "@Sender ⇒ @Recipient" but is one control, and it moves to
   * the SENDER — the same agent the identical click selects in the main chat.
   * Two clickable halves would be a change to the shared message component, and
   * that component is shared precisely so the two surfaces cannot diverge.
   */
  /**
   * A NAMED PARTY inside a notification row was clicked — move the reader to
   * it, in place, exactly as clicking the badge does.
   *
   * The component has already refused the actors that are not agents (it offers
   * a name as a control only where the colour lookup gave it a colour), so what
   * is left to refuse here is the same thing `onMessageAgentClick` refuses: an
   * actor that is not on THIS dialog's list, which the left-hand column could
   * not show, and the agent already open, which would be a no-op that clears a
   * half-typed draft.
   */
  onPartyClick(agent: AgentRef): void {
    if (!agent.agentId || agent.agentId === this.selectedAgentId()) return;
    if (!this.agents().some((a) => a.name === agent.agentId)) return;
    this.draft.set('');
    this.agentSelected.emit(agent);
  }

  onMessageAgentClick(message: ChatMessage): void {
    const agentId = message.sender.agent_id;
    if (!agentId || agentId === this.selectedAgentId()) return;
    if (!this.agents().some((a) => a.name === agentId)) return;
    this.draft.set('');
    this.agentSelected.emit({ agentId, actorName: message.sender.name });
  }

  onToggleCollapse(message: ChatMessage): void {
    const next = new Set(this.expandedIds());
    if (next.has(message.id)) {
      next.delete(message.id);
    } else {
      next.add(message.id);
    }
    this.expandedIds.set(next);
  }

  onVisibleChange(value: boolean): void {
    if (!value) this.visibleChange.emit(false);
  }

  trackByAgentId(_index: number, agent: NodeInterface): string {
    return agent.name;
  }

  trackByMessageId(_index: number, message: ChatMessage): string {
    return message.id;
  }

  /** The SAME key function the main panel uses — one row, one identity. */
  trackByDisplayItem(index: number, item: DisplayItem): string {
    return trackDisplayItem(index, item);
  }
}
