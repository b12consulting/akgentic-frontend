import { Component, inject, Input, OnInit, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';

import { ButtonModule } from 'primeng/button';
import { FloatLabelModule } from 'primeng/floatlabel';
import { TextareaModule } from 'primeng/textarea';
import { MultiSelectModule } from 'primeng/multiselect';
import { MentionModule } from 'angular-mentions';

import { environment } from '../../../environments/environment';
import { Message } from '../../models/types';
import { makeAgentNameUserFriendly } from '../../lib/util';

import { ApiService } from '../../services/api.service';
import { ChatService } from '../../services/chat.service';
import { GraphDataService } from '../../services/graph-data.service';
import { ActorMessageService } from '../../services/message.service';

import { isSentMessage, SentMessage } from '../../models/message.types';

import { ProcessControlsComponent } from '../../process-controls/process-controls.component';

@Component({
  selector: 'app-user-input',
  imports: [
    FormsModule,
    TextareaModule,
    FloatLabelModule,
    ButtonModule,
    MultiSelectModule,
    MentionModule,
    ProcessControlsComponent,
  ],
  templateUrl: './user-input.component.html',
  styleUrl: './user-input.component.scss',
})
export class ProcessUserInputComponent implements OnInit {
  @Input() processId!: string;

  apiService: ApiService = inject(ApiService);
  chatService: ChatService = inject(ChatService);
  messageService: ActorMessageService = inject(ActorMessageService);
  graphDataService: GraphDataService = inject(GraphDataService);
  userInput: string = '';
  userInputEnterKeySubmit: boolean = environment.userInputEnterKeySubmit;

  // Mention configuration
  mentionItems: { name: string; actorName: string; agentId: string }[] = [];
  selectedAgents: { name: string; actorName: string; agentId: string }[] = [];
  private destroyRef = inject(DestroyRef);

  ngOnInit() {
    // Subscribe to nodes to populate mention items
    this.graphDataService.nodes$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((nodes) => {
        // Filter all the agents that accept a user message
        const agents = nodes.filter((n) => n.userMessage);
        const parentIds = agents.map((n) => n.parentId);

        // The manager is the first agent with children in the current nodes
        const manager = agents.find((node) => parentIds.includes(node.name));

        if (!manager) {
          this.mentionItems = agents.map((node) => ({
            name: makeAgentNameUserFriendly(node.actorName),
            actorName: node.actorName,
            agentId: node.name,
          }));
          return;
        }

        // Get all descendants of managers recursively
        const getAllDescendants = (parentIds: string[]): any[] => {
          const children = agents.filter(
            (n) => n.parentId && parentIds.includes(n.parentId),
          );
          return children.length
            ? [...children, ...getAllDescendants(children.map((c) => c.name))]
            : [];
        };
        const managersChildren = getAllDescendants([manager.name]);

        // Map children to mention items
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
    // selectedAgents now contains both mentioned and manually selected agents
    // thanks to the auto-detection logic

    if (!this.userInput || this.userInput.trim() === '') {
      return;
    }

    // If no agents specified, broadcast to entire team
    if (!this.selectedAgents || this.selectedAgents.length === 0) {
      await this.apiService.sendMessage(
        this.processId,
        this.userInput,
      );
    } else {
      // Send message to each target agent
      for (const agent of this.selectedAgents) {
        await this.apiService.sendMessage(
          this.processId,
          this.userInput,
          agent.actorName,
        );
      }
    }

    this.userInput = '';
  }

  selectAgent = (item: any) => {
    return `${item.name} `;
  };

  // // Called when user manually changes the multiselect
  onSelectedAgentsChange() {
    // This ensures that manually selected agents are preserved
    // The auto-detection will merge with these on next text change
  }
}
