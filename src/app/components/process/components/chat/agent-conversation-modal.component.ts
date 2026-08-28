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

import { agentConversation } from '../../selectors/agent-conversation.selector';
import { ChatMessage } from '../../selectors/chat-message.model';
import { NodeInterface } from '../../models/types';
import { makeAgentNameUserFriendly } from '../../../../shared/util/util';
import { TranslatePipe } from '@ngx-translate/core';

import { ChatMessageComponent } from './chat-message.component';

/** The identity a caller needs to move the app's selection to an agent. */
export interface AgentRef {
  /** `agent_id` — the key `AkgentService`/`SelectionService` select by. */
  agentId: string;
  /** The actor name, carried alongside because selection stores both. */
  actorName: string;
}

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
 * changed leaves as an output.
 *
 * READ-ONLY. There is no reply, no edit and no send: every write path in this
 * app has a routing contract behind it, and a reader is not the place to
 * exercise one.
 */
@Component({
  selector: 'app-agent-conversation-modal',
  standalone: true,
  imports: [CommonModule, DialogModule, ChatMessageComponent, TranslatePipe],
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
  /** `agent_id` of the app-wide selected agent — the reader follows it. */
  selectedAgentId = input<string | null>(null);

  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() agentSelected = new EventEmitter<AgentRef>();

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

  agentLabel(agent: NodeInterface): string {
    return makeAgentNameUserFriendly(agent.actorName);
  }

  isSelected(agent: NodeInterface): boolean {
    return agent.name === this.selectedAgentId();
  }

  onAgentClick(agent: NodeInterface): void {
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
  onMessageAgentClick(message: ChatMessage): void {
    const agentId = message.sender.agent_id;
    if (!agentId || agentId === this.selectedAgentId()) return;
    if (!this.agents().some((a) => a.name === agentId)) return;
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
}
