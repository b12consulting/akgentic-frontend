import { CommonModule } from '@angular/common';
import { Component, inject, Input, OnInit, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';

import { ButtonModule } from 'primeng/button';
import { FloatLabelModule } from 'primeng/floatlabel';
import { TextareaModule } from 'primeng/textarea';
import { MentionModule } from 'angular-mentions';

import { environment } from '../../../environments/environment';
import { makeAgentNameUserFriendly } from '../../lib/util';

import { ApiService } from '../../services/api.service';
import { ChatService } from '../../services/chat.service';
import { GraphDataService } from '../../services/graph-data.service';

import { ChatMessage } from '../../models/chat-message.model';
import { ProcessControlsComponent } from '../../process-controls/process-controls.component';

@Component({
  selector: 'app-user-input',
  imports: [
    CommonModule,
    FormsModule,
    TextareaModule,
    FloatLabelModule,
    ButtonModule,
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
  graphDataService: GraphDataService = inject(GraphDataService);
  userInput: string = '';
  userInputEnterKeySubmit: boolean = environment.userInputEnterKeySubmit;
  replyContext: ChatMessage | null = null;
  replyContextDisplayName: string = '';

  // Mention configuration
  mentionItems: { name: string; actorName: string; agentId: string }[] = [];
  private destroyRef = inject(DestroyRef);

  ngOnInit() {
    // Subscribe to reply context changes
    this.chatService.replyContext$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((ctx) => {
        this.replyContext = ctx;
        this.replyContextDisplayName = ctx
          ? makeAgentNameUserFriendly(ctx.sender.name)
          : '';
      });

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
  }

  clearReplyContext(): void {
    this.chatService.clearReplyContext();
  }

  async sendMessage() {
    if (!this.userInput || this.userInput.trim() === '') {
      return;
    }

    const replyCtx = this.chatService.replyContext$.value;

    if (replyCtx) {
      // Reply context takes priority -- directed send to selected bubble's sender
      await this.apiService.sendMessage(
        this.processId,
        this.userInput,
        replyCtx.sender.name,
      );
      this.chatService.clearReplyContext();
    } else {
      // Existing logic: @mention or broadcast
      const mentionedAgent = this.mentionItems.find((item) =>
        this.userInput.includes(item.name),
      );

      if (mentionedAgent) {
        await this.apiService.sendMessage(
          this.processId,
          this.userInput,
          mentionedAgent.actorName,
        );
      } else {
        await this.apiService.sendMessage(this.processId, this.userInput);
      }
    }

    this.userInput = '';
  }

  selectAgent = (item: any) => {
    return `${item.name} `;
  };
}
