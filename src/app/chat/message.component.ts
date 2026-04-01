import { DatePipe } from '@angular/common';
import { Component, EventEmitter, input, Output } from '@angular/core';
import { Message } from '../models/types';
import { MessageBubbleComponent } from './message-bubble.component';

@Component({
  selector: 'app-message',
  standalone: true,
  imports: [MessageBubbleComponent, DatePipe],
  template: `
    <div
      class="message"
      [class.user]="message().sender === 'human'"
      [class.bot]="message().sender === 'ai'"
    >
      <app-message-bubble
        [message]="message()"
        (messageSelected)="messageSelected.emit($event)"
      ></app-message-bubble>
      <span class="timestamp">{{
        message().timestamp | date : 'shortTime'
      }}</span>
    </div>
  `,
})
export class MessageComponent {
  @Output() messageSelected = new EventEmitter<Message>();
  message = input.required<Message>();
}
