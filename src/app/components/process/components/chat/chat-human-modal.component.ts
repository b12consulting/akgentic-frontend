import { CommonModule, DatePipe } from '@angular/common';
import { Component, EventEmitter, input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { TextareaModule } from 'primeng/textarea';
import { TranslatePipe } from '@ngx-translate/core';
import { MarkdownModule } from 'ngx-markdown';

import { ChatMessage } from '../../selectors/chat-message.model';
import { ActorAddress } from '../../../../protocol/message.types';
import { makeAgentNameUserFriendly } from '../../../../shared/util/util';

export interface HumanModalReply {
  content: string;
  messageId: string;
}

/**
 * A request/reply pair for already-answered Rule 3 messages displayed in
 * the modal's greyed-out "Answered" section. See Story 4-7 AC1/AC4.
 */
export interface AnsweredRequest {
  request: ChatMessage;
  reply: ChatMessage;
}

@Component({
  selector: 'app-chat-human-modal',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    DialogModule,
    TextareaModule,
    ButtonModule,
    MarkdownModule,
    DatePipe,
    TranslatePipe,
  ],
  templateUrl: './chat-human-modal.component.html',
  styleUrl: './chat-human-modal.component.scss',
})
export class ChatHumanModalComponent {
  visible = input<boolean>(false);
  agentPair = input<{ sender: ActorAddress; recipient: ActorAddress } | null>(null);
  pendingMessages = input<ChatMessage[]>([]);
  answeredMessages = input<AnsweredRequest[]>([]);

  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() reply = new EventEmitter<HumanModalReply>();

  /** Per-request reply buffer, keyed on the inner `request.message_id`
   *  (ADR-027 Decision 2) — the id the backend resolves human-input by. */
  replyBuffers: Map<string, string> = new Map();

  /**
   * The header the AGENTS give this dialog, or `null` when there is no pair.
   *
   * `null` rather than a default sentence, and this is the whole of T6 in one
   * property: the two names are the backend's, they have no translation key and
   * they never will. Only the no-pair fallback is copy, so only it goes through
   * the layer — in the template, where the boundary is visible. Piping this
   * string through a lookup instead would "work" (a miss echoes its input) while
   * quietly making every agent name a candidate for accidental translation.
   */
  get headerText(): string | null {
    const pair = this.agentPair();
    if (!pair) return null;
    const sender = makeAgentNameUserFriendly(pair.sender.name);
    const recipient = makeAgentNameUserFriendly(pair.recipient.name);
    return `${sender} ⇒ ${recipient}`;
  }

  getReplyBuffer(id: string): string {
    return this.replyBuffers.get(id) ?? '';
  }

  setReplyBuffer(id: string, value: string): void {
    this.replyBuffers.set(id, value);
  }

  onVisibleChange(value: boolean): void {
    if (!value) {
      this.replyBuffers.clear();
      this.visibleChange.emit(false);
    }
  }

  onSendForRequest(requestId: string): void {
    const buffer = (this.replyBuffers.get(requestId) ?? '').trim();
    if (!buffer) return;
    this.reply.emit({ content: buffer, messageId: requestId });
    this.replyBuffers.delete(requestId);
    // Modal stays open — parent reclassifies pending/answered lists.
  }

  trackByRequestId(_index: number, msg: ChatMessage): string {
    // Reply key is the INNER message id (ADR-027 Decision 2): the backend
    // resolves human-input by ChatMessage.message_id, not the outer envelope id.
    return msg.message_id;
  }

  trackByAnsweredId(_index: number, a: AnsweredRequest): string {
    return a.request.id;
  }
}
