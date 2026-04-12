import { CommonModule, DatePipe } from '@angular/common';
import { Component, EventEmitter, input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { TextareaModule } from 'primeng/textarea';
import { MarkdownModule } from 'ngx-markdown';

import { ChatMessage } from '../models/chat-message.model';
import { ActorAddress } from '../models/message.types';
import { makeAgentNameUserFriendly } from '../lib/util';

export interface HumanModalReply {
  content: string;
  messageId: string;
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
  ],
  templateUrl: './chat-human-modal.component.html',
  styleUrl: './chat-human-modal.component.scss',
})
export class ChatHumanModalComponent {
  visible = input<boolean>(false);
  agentPair = input<{ sender: ActorAddress; recipient: ActorAddress } | null>(null);
  pendingMessages = input<ChatMessage[]>([]);

  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() reply = new EventEmitter<HumanModalReply>();

  replyText = '';

  get headerText(): string {
    const pair = this.agentPair();
    if (!pair) return 'Human Input';
    const sender = makeAgentNameUserFriendly(pair.sender.name);
    const recipient = makeAgentNameUserFriendly(pair.recipient.name);
    return `${sender} ⇒ ${recipient}`;
  }

  onVisibleChange(value: boolean): void {
    if (!value) {
      this.visibleChange.emit(false);
    }
  }

  onSend(): void {
    if (!this.replyText.trim()) return;
    const messages = this.pendingMessages();
    if (messages.length === 0) return;

    const lastMessage = messages[messages.length - 1];
    this.reply.emit({
      content: this.replyText.trim(),
      messageId: lastMessage.id,
    });
    this.replyText = '';
    this.visibleChange.emit(false);
  }
}
