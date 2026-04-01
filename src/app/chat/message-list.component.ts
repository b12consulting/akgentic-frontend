import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  ViewChild,
  ElementRef,
  AfterViewChecked,
} from '@angular/core';
import _ from 'lodash';
import { ProgressBarModule } from 'primeng/progressbar';
import { BehaviorSubject } from 'rxjs';
import { Message } from '../models/types';
import { MessageComponent } from './message.component';

const MESSAGE_VISIBLE = true;

@Component({
  selector: 'app-message-list',
  standalone: true,
  imports: [CommonModule, MessageComponent, ProgressBarModule],
  styleUrls: ['./message-list.component.scss'],
  template: `
    <div class="message-list" #scrollContainer>
      <ng-container
        *ngFor="let group of groupedMessagesProperty; trackBy: trackByIndex"
      >
        <div class="message-group">
          <app-message
            *ngIf="group.question"
            [message]="group.question"
            (messageSelected)="messageSelected.emit($event)"
          ></app-message>

          <div *ngIf="group.hasIntermediateMessages">
            <button
              class="collapse-toggle"
              (click)="toggleIntermediateMessages(group)"
            >
              <i
                class="pi p-ripple p-tree-node-toggle-button"
                [ngClass]="{
                  'pi-chevron-down': !group.areIntermediateMessagesVisible,
                  'pi-chevron-up': group.areIntermediateMessagesVisible
                }"
              ></i>
              <span class="p-tree-node-label p-tree-node-color"
                ><b
                  >Intermediate messages
                  {{ hasHumanRequest(group) ? '- Questions 🙋' : '' }}</b
                ></span
              >
            </button>
          </div>

          <div *ngIf="group.areIntermediateMessagesVisible">
            <app-message
              *ngFor="let message of group.intermediateMessages"
              [message]="message"
              (messageSelected)="messageSelected.emit($event)"
            ></app-message>
          </div>

          <app-message
            *ngIf="group.finalAnswer"
            [message]="group.finalAnswer"
            (messageSelected)="messageSelected.emit($event)"
          ></app-message>
        </div>
      </ng-container>

      <div *ngIf="loading">
        <div class="thinking-animation">
          <div class="dot"></div>
          <div class="dot"></div>
          <div class="dot"></div>
        </div>
      </div>
      <div *ngIf="errorMessage">
        <span class="error-message"
          >Something went wrong: {{ errorMessage }}</span
        >
      </div>
    </div>
  `,
})
export class MessageListComponent implements OnChanges, AfterViewChecked {
  @Output() messageSelected = new EventEmitter<Message>();
  @ViewChild('scrollContainer', { static: false })
  private scrollContainer!: ElementRef;

  @Input() messages!: Message[];
  @Input() loading!: boolean;
  @Input() errorMessage!: string | undefined;

  public groupedMessagesProperty: any[] = []; // Store grouped messages as property
  private groupOpenState: Map<string, boolean> = new Map(); // Pour stocker l'état d'ouverture
  private shouldScrollToBottom = true; // Track if we should auto-scroll
  private lastScrollHeight = 0; // Track previous scroll height

  private visibilitySubject: BehaviorSubject<any[]> = new BehaviorSubject<
    any[]
  >([]);

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['messages']) {
      // Check if we should auto-scroll before updating messages
      this.checkShouldAutoScroll();

      // Préserver l'état d'ouverture des groupes existants
      this.saveGroupOpenStates();

      // Recalcule les groupes
      this.groupedMessagesProperty = this.groupMessages();

      // Restaurer l'état d'ouverture
      this.restoreGroupOpenStates();

      this.visibilitySubject.next(this.groupedMessagesProperty);
    }
  }

  ngAfterViewChecked(): void {
    // Auto-scroll to bottom if we should and content has changed
    if (this.shouldScrollToBottom && this.hasContentChanged()) {
      this.scrollToBottom();
    }
  }

  private checkShouldAutoScroll(): void {
    if (!this.scrollContainer) {
      this.shouldScrollToBottom = true;
      return;
    }

    const element = this.scrollContainer.nativeElement;
    const threshold = 100; // pixels from bottom to consider "near bottom"
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;

    // Auto-scroll if user is near the bottom or if this is the first load
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
      const element = this.scrollContainer.nativeElement;
      element.scrollTop = element.scrollHeight;
    } catch (err) {
      console.warn('Could not scroll to bottom:', err);
    }
  }

  // Sauvegarde l'état d'ouverture de tous les groupes
  private saveGroupOpenStates() {
    this.groupedMessagesProperty.forEach((group, index) => {
      if (group.question) {
        const key = `q-${group.question.id || index}`;
        this.groupOpenState.set(key, group.areIntermediateMessagesVisible);
      }
    });
  }

  // Restaure l'état d'ouverture des groupes
  private restoreGroupOpenStates() {
    this.groupedMessagesProperty.forEach((group, index) => {
      if (group.question) {
        const key = `q-${group.question.id || index}`;
        const isOpen = this.groupOpenState.get(key);
        if (isOpen !== undefined) {
          group.areIntermediateMessagesVisible = isOpen;
        }
      }
    });
  }

  private groupMessages() {
    // Extracted grouping logic into a separate method
    let groups: any[] = [];
    let currentGroup: any = null;
    const messages = this.messages;

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];

      if (message.type === 'question') {
        if (currentGroup) {
          groups.push({
            ...currentGroup,
            areIntermediateMessagesVisible: MESSAGE_VISIBLE,
            hasIntermediateMessages:
              currentGroup.intermediateMessages.length > 0,
          });
        }
        currentGroup = { question: message, intermediateMessages: [] };
      } else if (message.type === 'intermediate') {
        if (currentGroup) {
          currentGroup.intermediateMessages.push(message);
        }
      } else if (message.type === 'final') {
        if (currentGroup) {
          if (currentGroup.finalAnswer) {
            currentGroup.intermediateMessages.push(currentGroup.finalAnswer);
          }
          currentGroup.finalAnswer = message;
          const isLastMessage = i === messages.length - 1;
          const nextMessageIsQuestion =
            !isLastMessage && messages[i + 1].type === 'question';

          if (isLastMessage || nextMessageIsQuestion) {
            groups.push({
              ...currentGroup,
              areIntermediateMessagesVisible: MESSAGE_VISIBLE,
              hasIntermediateMessages:
                currentGroup.intermediateMessages.length > 0,
            });
            currentGroup = null;
          }
        } else {
          groups.push({
            finalAnswer: message,
            areIntermediateMessagesVisible: MESSAGE_VISIBLE,
            hasIntermediateMessages: false,
            intermediateMessages: [],
          });
        }
      }
    }

    if (currentGroup) {
      groups.push({
        ...currentGroup,
        areIntermediateMessagesVisible: MESSAGE_VISIBLE,
        hasIntermediateMessages: currentGroup.intermediateMessages.length > 0,
      });
    }
    // sort intermediate messages by timestamp
    groups.forEach((group) => {
      group.intermediateMessages = _.sortBy(
        group.intermediateMessages,
        (message) => message.timestamp
      );
    });
    return groups;
  }

  get groupedMessages() {
    return this.groupedMessagesProperty;
  }

  toggleIntermediateMessages(group: any) {
    group.areIntermediateMessagesVisible =
      !group.areIntermediateMessagesVisible;

    // Sauvegarde l'état après un clic manuel
    if (group.question) {
      const key = `q-${
        group.question.id || this.groupedMessagesProperty.indexOf(group)
      }`;
      this.groupOpenState.set(key, group.areIntermediateMessagesVisible);
    }
  }

  hasHumanRequest(group: any): boolean {
    return group.intermediateMessages.some(
      (m: Message) => m.human_requests && m.human_requests.length > 0
    );
  }

  trackByIndex(index: number) {
    return index;
  }
}
