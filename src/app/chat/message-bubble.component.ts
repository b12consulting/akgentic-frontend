import { CommonModule } from '@angular/common';
import { Component, EventEmitter, input, Output } from '@angular/core';
import { MarkdownModule } from 'ngx-markdown';
import { Message } from '../models/types';
import { makeAgentNameUserFriendly } from '../lib/util';
import { FeedbackComponent } from './feedback.component';
@Component({
  selector: 'app-message-bubble',
  standalone: true,
  imports: [MarkdownModule, FeedbackComponent, CommonModule],
  styleUrls: ['./message-bubble.component.scss'],
  template: `
    <div
      class="message-bubble"
      [class.user]="message().sender === 'human'"
      [class.bot]="message().sender === 'ai'"
    >
      <button
        [disabled]="message().sender === 'human'"
        (click)="onMessageClick()"
      >
        {{ display_name() }}
      </button>
      <div class="markdown-content">
        <markdown [data]="message().content"></markdown>
      </div>
      <app-feedback
        *ngIf="message().run_id"
        [message]="message()"
      ></app-feedback>
    </div>
  `,
})
export class MessageBubbleComponent {
  @Output() messageSelected = new EventEmitter<Message>();
  message = input.required<Message>();

  onMessageClick() {
    this.messageSelected.emit(this.message());
  }

  display_name() {
    const message = this.message();
    const agent_name = makeAgentNameUserFriendly(message.agent_name);
    if (message.sender === 'human') {
      if (message.send_to != 'Human' && message.send_to) {
        return `You ➡️ ${makeAgentNameUserFriendly(message.send_to!)}`;
      }
      return 'You';
    } else if (message.human_requests && message.human_requests.length > 0) {
      return agent_name + ' - Question 🙋';
    } else {
      return agent_name;
    }
  }
}
