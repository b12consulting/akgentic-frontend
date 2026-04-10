import { CommonModule } from '@angular/common';
import {
  AfterViewChecked,
  Component,
  ElementRef,
  HostListener,
  inject,
  Input,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';

import { ChatMessage, classifyMessage } from '../models/chat-message.model';
import { ActorAddress, isSentMessage } from '../models/message.types';
import { ApiService } from '../services/api.service';
import { ChatService } from '../services/chat.service';
import { ActorMessageService } from '../services/message.service';
import { Selectable, SelectionService } from '../services/selection.service';
import { ChatHumanModalComponent, HumanModalReply } from './chat-human-modal.component';
import { ChatMessageComponent } from './chat-message.component';
import { ProcessUserInputComponent } from '../process/user-input/user-input.component';

@Component({
  selector: 'app-chat-panel',
  standalone: true,
  imports: [CommonModule, ChatMessageComponent, ChatHumanModalComponent, ProcessUserInputComponent],
  templateUrl: './chat-panel.component.html',
  styleUrl: './chat-panel.component.scss',
})
export class ChatPanelComponent implements OnInit, OnDestroy, AfterViewChecked {
  @Input() processId!: string;
  @Input() loading$!: BehaviorSubject<boolean>;

  @ViewChild('scrollContainer', { static: false })
  private scrollContainer!: ElementRef;

  messageService: ActorMessageService = inject(ActorMessageService);
  chatService: ChatService = inject(ChatService);
  selectionService: SelectionService = inject(SelectionService);
  apiService: ApiService = inject(ApiService);

  chatMessages: ChatMessage[] = [];
  loadingProcess$ = this.chatService.loadingProcess$;

  // Modal state for Rule 3 notification dialog
  modalVisible = false;
  modalAgentPair: { sender: ActorAddress; recipient: ActorAddress } | null = null;
  modalPendingMessages: ChatMessage[] = [];

  private subscription!: Subscription;
  private shouldScrollToBottom = true;
  private lastScrollHeight = 0;
  private expandedMessageIds = new Set<string>();
  selectedMessageId: string | null = null;
  private replyContextSubscription!: Subscription;
  private notificationSubscription!: Subscription;
  pendingNotifications: Map<string, ChatMessage[]> = new Map();

  ngOnInit(): void {
    this.replyContextSubscription = this.chatService.replyContext$.subscribe((ctx) => {
      this.selectedMessageId = ctx ? ctx.id : null;
    });
    this.notificationSubscription = this.chatService.pendingNotifications$.subscribe(
      (pending) => { this.pendingNotifications = pending; }
    );
    this.subscription = this.messageService.messages$.subscribe((messages) => {
      this.checkShouldAutoScroll();

      const classified = messages
        .filter(isSentMessage)
        .filter((m) => m.sender.role !== 'ActorSystem')
        .filter((m) => m.message.content != null && m.message.content !== '')
        .map((m) => {
          const chatMsg = classifyMessage(m);
          if (chatMsg.rule === 4 && this.expandedMessageIds.has(chatMsg.id)) {
            chatMsg.collapsed = false;
          }
          return chatMsg;
        });

      this.chatMessages = classified;
      this.chatService.messages$.next(classified);
    });
  }

  onToggleCollapse(chatMsg: ChatMessage): void {
    if (chatMsg.rule !== 4) return;
    chatMsg.collapsed = !chatMsg.collapsed;
    if (chatMsg.collapsed) {
      this.expandedMessageIds.delete(chatMsg.id);
    } else {
      this.expandedMessageIds.add(chatMsg.id);
    }
  }

  ngAfterViewChecked(): void {
    if (this.shouldScrollToBottom && this.hasContentChanged()) {
      this.scrollToBottom();
    }
  }

  hasNotification(chatMsg: ChatMessage): boolean {
    if (chatMsg.rule !== 3) return false;
    const pairKey = `${chatMsg.sender.name}->${chatMsg.recipient.name}`;
    return this.pendingNotifications.has(pairKey);
  }

  ngOnDestroy(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
    if (this.replyContextSubscription) {
      this.replyContextSubscription.unsubscribe();
    }
    if (this.notificationSubscription) {
      this.notificationSubscription.unsubscribe();
    }
  }

  onBubbleClicked(chatMsg: ChatMessage): void {
    this.chatService.setReplyContext(chatMsg);
  }

  onRule3Clicked(chatMsg: ChatMessage): void {
    const pairKey = `${chatMsg.sender.name}->${chatMsg.recipient.name}`;
    const pending = this.pendingNotifications.get(pairKey) ?? [];
    if (pending.length === 0) return;

    this.modalAgentPair = { sender: chatMsg.sender, recipient: chatMsg.recipient };
    this.modalPendingMessages = pending;
    this.modalVisible = true;
  }

  onModalReply(reply: HumanModalReply): void {
    this.modalVisible = false;
    this.modalAgentPair = null;
    this.modalPendingMessages = [];
    this.apiService
      .processHumanInput(this.processId, reply.content, reply.messageId)
      .catch((err) => console.error('Failed to send human input:', err));
  }

  onModalVisibleChange(visible: boolean): void {
    this.modalVisible = visible;
    if (!visible) {
      this.modalAgentPair = null;
      this.modalPendingMessages = [];
    }
  }

  onBackgroundClick(): void {
    this.chatService.clearReplyContext();
  }

  @HostListener('document:keydown.escape')
  onEscapePress(): void {
    this.chatService.clearReplyContext();
  }

  onMessageSelected(chatMsg: ChatMessage): void {
    const selectable: Selectable = {
      type: 'message',
      data: {
        name: chatMsg.sender.agent_id,
        actorName: chatMsg.sender.name,
      },
    };
    this.selectionService.handleSelection(selectable);
  }

  trackById(_index: number, item: ChatMessage): string {
    return item.id;
  }

  private checkShouldAutoScroll(): void {
    if (!this.scrollContainer) {
      this.shouldScrollToBottom = true;
      return;
    }
    const el = this.scrollContainer.nativeElement;
    const threshold = 100;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.shouldScrollToBottom =
      distanceFromBottom <= threshold || this.lastScrollHeight === 0;
  }

  private hasContentChanged(): boolean {
    if (!this.scrollContainer) return false;
    const currentScrollHeight = this.scrollContainer.nativeElement.scrollHeight;
    const changed = currentScrollHeight !== this.lastScrollHeight;
    this.lastScrollHeight = currentScrollHeight;
    return changed;
  }

  private scrollToBottom(): void {
    if (!this.scrollContainer) return;
    try {
      const el = this.scrollContainer.nativeElement;
      el.scrollTop = el.scrollHeight;
    } catch (err) {
      console.warn('Could not scroll to bottom:', err);
    }
  }
}
