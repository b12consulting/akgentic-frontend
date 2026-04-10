import { Component, inject, Input, OnInit, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';

import { ButtonModule } from 'primeng/button';
import { FloatLabelModule } from 'primeng/floatlabel';
import { TextareaModule } from 'primeng/textarea';
import { SelectModule } from 'primeng/select';
import { MentionModule } from 'angular-mentions';

import { environment } from '../../../environments/environment';
import { Message } from '../../models/types';
import { makeAgentNameUserFriendly } from '../../lib/util';

import { ApiService } from '../../services/api.service';
import { AkgentService } from '../../services/akgent.service';
import { ChatService } from '../../services/chat.service';
import { GraphDataService } from '../../services/graph-data.service';
import { ActorMessageService } from '../../services/message.service';

import { isSentMessage, SentMessage } from '../../models/message.types';

import { ProcessControlsComponent } from '../../process-controls/process-controls.component';

const ENTRY_POINT_NAME = '@Human';

@Component({
  selector: 'app-user-input',
  imports: [
    FormsModule,
    TextareaModule,
    FloatLabelModule,
    ButtonModule,
    SelectModule,
    MentionModule,
    ProcessControlsComponent,
  ],
  templateUrl: './user-input.component.html',
  styleUrl: './user-input.component.scss',
})
export class ProcessUserInputComponent implements OnInit {
  @Input() processId!: string;

  apiService: ApiService = inject(ApiService);
  akgentService: AkgentService = inject(AkgentService);
  chatService: ChatService = inject(ChatService);
  messageService: ActorMessageService = inject(ActorMessageService);
  graphDataService: GraphDataService = inject(GraphDataService);
  userInput: string = '';
  userInputEnterKeySubmit: boolean = environment.userInputEnterKeySubmit;

  // Mention configuration
  mentionItems: { name: string; actorName: string; agentId: string }[] = [];

  // Dropdown agent selection (single-select)
  selectedAgent: string | null = null;
  dropdownAgents: { label: string; value: string }[] = [];

  private destroyRef = inject(DestroyRef);

  ngOnInit() {
    // Subscribe to nodes to populate mention items and dropdown agents
    this.graphDataService.nodes$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((nodes) => {
        // Dropdown agents: all @-prefixed agents except the entry point
        this.dropdownAgents = nodes
          .filter(n => n.actorName.startsWith('@') && n.actorName !== ENTRY_POINT_NAME)
          .map(n => ({
            label: makeAgentNameUserFriendly(n.actorName),
            value: n.actorName,
          }));

        // Reset selection if selected agent was fired
        if (this.selectedAgent && !this.dropdownAgents.some(a => a.value === this.selectedAgent)) {
          this.selectedAgent = null;
        }

        // Mention items for angular-mentions autocomplete (existing hierarchy logic)
        const agents = nodes.filter((n) => n.userMessage);
        const parentIds = agents.map((n) => n.parentId);
        const manager = agents.find((node) => parentIds.includes(node.name));

        if (!manager) {
          this.mentionItems = agents.map((node) => ({
            name: makeAgentNameUserFriendly(node.actorName),
            actorName: node.actorName,
            agentId: node.name,
          }));
          return;
        }

        const getAllDescendants = (parentIds: string[]): any[] => {
          const children = agents.filter(
            (n) => n.parentId && parentIds.includes(n.parentId),
          );
          return children.length
            ? [...children, ...getAllDescendants(children.map((c) => c.name))]
            : [];
        };
        const managersChildren = getAllDescendants([manager.name]);

        this.mentionItems = [manager, ...managersChildren].map((node) => ({
          name: makeAgentNameUserFriendly(node.actorName),
          actorName: node.actorName,
          agentId: node.name,
        }));
      });

    this.messageService.messages$.subscribe((messages) => {
      // Filter SentMessages and map into chat format.
      // display_type on AgentMessage is always "other", so we infer
      // direction from the sender's role: Human → user, everything else → AI.
      const sentMessages = messages.filter(isSentMessage);
      const final_messages = sentMessages
        .filter((m) => m?.sender.role !== 'ActorSystem')
        .map((m: SentMessage): Message | undefined => {
          const content = m.message.content;
          if (!content) return undefined;
          const isHuman = m.sender.role === 'Human';
          const message: Message = {
            id: m.id,
            content,
            sender: isHuman ? 'human' : 'ai',
            type: isHuman ? 'question' : 'final',
            timestamp: new Date(m.timestamp),
            agent_name: m.sender.name,
            agent_id: m.sender.agent_id,
            send_to: m.recipient.name,
          };
          return message;
        })
        .filter((m): m is Message => !!m);

      // Pass the filtered messages to the chat service
      // Check if a humanRequests has already been answered and update the final messages before passing it to the chat service
      const currentChatMessages = this.chatService.messages$.value;

      // Reapply the alreadyAnswered flag to the matching messages based on their content
      const final_messages_updated = Array.from(final_messages).map(
        (message: Message) => {
          // Find the message in the currentChatMessages by matching its content
          const existingMessage = currentChatMessages.find(
            (m: Message) =>
              m.content === message.content && m.agent_id === message.agent_id,
          );

          // If the message exists and has been marked as answered, apply the alreadyAnswered field
          if (existingMessage?.alreadyAnswered) {
            return {
              ...message,
              alreadyAnswered: true,
            };
          }

          return message;
        },
      );
      this.chatService.messages$.next(final_messages_updated);
    });
  }

  async sendMessage() {
    if (!this.userInput || this.userInput.trim() === '') {
      return;
    }

    const speakAs = this.akgentService.selectedAkgent$.value;

    if (this.selectedAgent) {
      // Dropdown selection → directed send
      if (speakAs) {
        await this.apiService.sendMessageFromTo(
          this.processId,
          speakAs.name,
          this.selectedAgent,
          this.userInput,
        );
      } else {
        await this.apiService.sendMessage(
          this.processId,
          this.userInput,
          this.selectedAgent,
        );
      }
    } else {
      // No selection → broadcast
      await this.apiService.sendMessage(this.processId, this.userInput);
    }
    // Selection persists across sends — do NOT clear selectedAgent

    this.userInput = '';
  }

  selectAgent = (item: any) => {
    return `${item.name} `;
  };

}
