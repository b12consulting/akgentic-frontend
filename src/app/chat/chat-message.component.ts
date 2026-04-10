import { CommonModule, DatePipe } from '@angular/common';
import { Component, EventEmitter, input, Output } from '@angular/core';
import { MarkdownModule } from 'ngx-markdown';
import { ChatMessage } from '../models/chat-message.model';

@Component({
  selector: 'app-chat-message',
  standalone: true,
  imports: [CommonModule, MarkdownModule, DatePipe],
  templateUrl: './chat-message.component.html',
  styleUrl: './chat-message.component.scss',
})
export class ChatMessageComponent {
  @Output() messageSelected = new EventEmitter<ChatMessage>();
  @Output() toggleCollapse = new EventEmitter<ChatMessage>();
  @Output() bubbleClicked = new EventEmitter<ChatMessage>();
  @Output() rule3Clicked = new EventEmitter<ChatMessage>();
  message = input.required<ChatMessage>();
  selected = input<boolean>(false);
  notification = input<boolean>(false);

  onToggleCollapse(): void {
    const msg = this.message();
    if (msg.rule === 4) {
      this.toggleCollapse.emit(msg);
    }
  }

  onLabelClick(): void {
    const msg = this.message();
    if (msg.rule !== 1) {
      this.messageSelected.emit(msg);
    }
  }

  onBubbleClick(event: Event): void {
    event.stopPropagation();
    const msg = this.message();
    switch (msg.rule) {
      case 1:
      case 2:
        this.bubbleClicked.emit(msg);
        break;
      case 3:
        this.rule3Clicked.emit(msg);
        break;
      case 4:
        this.onToggleCollapse();
        break;
    }
  }
}
