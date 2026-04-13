import { CommonModule } from '@angular/common';
import { Component, inject, Input, OnInit, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';

import { ButtonModule } from 'primeng/button';
import { FloatLabelModule } from 'primeng/floatlabel';
import { MultiSelectModule } from 'primeng/multiselect';
import { TextareaModule } from 'primeng/textarea';
import { MentionModule } from 'angular-mentions';

import { environment } from '../../../environments/environment';
import { makeAgentNameUserFriendly } from '../../lib/util';

import { ApiService } from '../../services/api.service';
import { ChatService } from '../../services/chat.service';
import { GraphDataService } from '../../services/graph-data.service';

import { ENTRY_POINT_NAME } from '../../models/chat-message.model';

@Component({
  selector: 'app-user-input',
  imports: [
    CommonModule,
    FormsModule,
    TextareaModule,
    FloatLabelModule,
    ButtonModule,
    MultiSelectModule,
    MentionModule,
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

  // Mention configuration
  mentionItems: { name: string; actorName: string; agentId: string }[] = [];
  // Dropdown configuration
  dropdownAgents: { label: string; value: string }[] = [];
  selectedAgents: string[] = [];
  private destroyRef = inject(DestroyRef);

  ngOnInit() {
    // Subscribe to nodes to populate mention items and dropdown agents
    this.graphDataService.nodes$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((nodes) => {
        const agents = nodes.filter(
          (n) => n.actorName.startsWith('@') && n.actorName !== ENTRY_POINT_NAME,
        );

        this.mentionItems = agents.map((node) => ({
          name: makeAgentNameUserFriendly(node.actorName),
          actorName: node.actorName,
          agentId: node.name,
        }));

        this.dropdownAgents = agents.map((node) => ({
          label: makeAgentNameUserFriendly(node.actorName),
          value: node.actorName,
        }));

        // Remove fired agents from selection
        this.selectedAgents = this.selectedAgents.filter((a) =>
          agents.some((n) => n.actorName === a),
        );
      });
  }

  /**
   * Comma-joined friendly labels of the current dropdown selection, e.g.
   * `@AgentA, @AgentB`. Used by the Send-to echo indicator in the template.
   * Empty string when no agent is selected (broadcast case).
   */
  get selectedAgentsDisplay(): string {
    return this.selectedAgents.map(makeAgentNameUserFriendly).join(', ');
  }

  /**
   * Redundant convenience for clearing the Send-to dropdown selection.
   * The p-multiSelect's own `[showClear]` chip remains the canonical clear
   * control; this method backs the `×` button on the Send-to echo indicator.
   */
  clearSendTo(): void {
    this.selectedAgents = [];
  }

  async sendMessage() {
    if (!this.userInput || this.userInput.trim() === '') {
      return;
    }

    if (this.selectedAgents.length > 0) {
      // Priority 1: dropdown selection -- send to each selected agent
      for (const agentName of this.selectedAgents) {
        await this.apiService.sendMessage(this.processId, this.userInput, agentName);
      }
    } else {
      // Priority 2: broadcast
      await this.apiService.sendMessage(this.processId, this.userInput);
    }

    this.userInput = '';
  }

  selectAgent = (item: any) => {
    return `${item.name} `;
  };
}
