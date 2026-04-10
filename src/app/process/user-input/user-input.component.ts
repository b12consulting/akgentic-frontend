import { CommonModule } from '@angular/common';
import { Component, inject, Input, OnInit, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';

import { ButtonModule } from 'primeng/button';
import { FloatLabelModule } from 'primeng/floatlabel';
import { TextareaModule } from 'primeng/textarea';
import { MentionModule } from 'angular-mentions';
import { MultiSelectModule } from 'primeng/multiselect';

import { environment } from '../../../environments/environment';
import { makeAgentNameUserFriendly } from '../../lib/util';

import { ApiService } from '../../services/api.service';
import { ChatService } from '../../services/chat.service';
import { GraphDataService } from '../../services/graph-data.service';

import { ChatMessage, ENTRY_POINT_NAME } from '../../models/chat-message.model';
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
    MultiSelectModule,
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

  // Multi-select dropdown for routing
  dropdownAgents: { label: string; value: string }[] = [];
  selectedAgents: string[] = [];

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

    // Subscribe to nodes to populate mention items and dropdown agents
    this.graphDataService.nodes$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((nodes) => {
        // Populate dropdown agents: all @-prefixed agents minus entry point
        this.dropdownAgents = nodes
          .filter(
            (n) =>
              n.actorName.startsWith('@') &&
              n.actorName !== ENTRY_POINT_NAME,
          )
          .map((n) => ({
            label: makeAgentNameUserFriendly(n.actorName),
            value: n.actorName,
          }));

        // Prune selectedAgents to remove fired agents
        const validActorNames = new Set(
          this.dropdownAgents.map((d) => d.value),
        );
        this.selectedAgents = this.selectedAgents.filter((s) =>
          validActorNames.has(s),
        );

        // Populate mention items (existing hierarchy heuristic for autocomplete)
        const agents = nodes.filter((n) => n.userMessage);
        const parentIds = agents.map((n) => n.parentId);

        const manager = agents.find((node) =>
          parentIds.includes(node.name),
        );

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
            ? [
                ...children,
                ...getAllDescendants(children.map((c) => c.name)),
              ]
            : [];
        };
        const managersChildren = getAllDescendants([manager.name]);

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
      // Priority 1: Reply context -- directed send to selected bubble's sender
      await this.apiService.sendMessage(
        this.processId,
        this.userInput,
        replyCtx.sender.name,
      );
      this.chatService.clearReplyContext();
    } else if (this.selectedAgents.length > 0) {
      // Priority 2: Dropdown selection -- send to each selected agent
      for (const agentName of this.selectedAgents) {
        await this.apiService.sendMessage(
          this.processId,
          this.userInput,
          agentName,
        );
      }
      // selectedAgents persists -- do NOT clear
    } else {
      // Priority 3: No selection -- broadcast
      await this.apiService.sendMessage(this.processId, this.userInput);
    }

    this.userInput = '';
  }

  selectAgent = (item: any) => {
    return `${item.name} `;
  };
}
