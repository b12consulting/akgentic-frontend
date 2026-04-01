import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject, from, map, Observable, take } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { FetchService } from './fetch.service';
import { SentMessage } from '../models/message.types';

@Injectable({
  providedIn: 'root',
})
export class ApiService {
  fetchService: FetchService = inject(FetchService);
  authService: AuthService = inject(AuthService);
  router: Router = inject(Router);

  private apiUrl = environment.api;
  webSocketTicket$ = new BehaviorSubject<string | null>(null);

  async getContext(): Promise<Array<any>> {
    const response = await this.fetchService.fetch({
      url: `${this.apiUrl}/processes`,
    });
    return response ?? [];
  }

  async getProcess(processId: string): Promise<any> {
    const response = await this.fetchService.fetch({
      url: `${this.apiUrl}/process/${processId}`,
    });
    return response;
  }

  async getConfig(
    processType: string,
    full: boolean = true
  ): Promise<Array<any>> {
    const response = await this.fetchService.fetch({
      url: `${this.apiUrl}/config/${processType}?full=${full}`,
    });
    return response ?? [];
  }

  async saveConfig(
    processType: string,
    configId: string | null,
    name: string | null,
    config: any,
    dry_run: boolean = false
  ): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/config/${processType}`,
      options: {
        method: 'PUT',
        body: JSON.stringify({
          id: configId,
          name,
          config,
          dry_run,
        }),
        headers: { 'Content-Type': 'application/json' },
      },
      successMessage: dry_run
        ? 'Configuration validated successfully'
        : 'Configuration saved successfully',
    });
  }

  async deleteConfig(processType: string, configId: string): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/config/${processType}/${configId}`,
      options: {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      },
      successMessage: 'Configuration deleted successfully',
    });
  }

  async createProcess(teamId: string, config: string): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/process/${teamId}?config=${config}`,
      options: { method: 'POST' },
    });
  }

  async deleteProcess(teamId: string): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/process/${teamId}`,
      options: { method: 'DELETE' },
      successMessage: 'Process delete successful',
    });
  }

  async archiveProcess(teamId: string): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/process/${teamId}/archive`,
      options: { method: 'DELETE' },
      successMessage: 'Process stopped successfully',
    });
  }

  async restoreProcess(teamId: string): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/process/${teamId}/restore`,
      options: { method: 'POST' },
      successMessage: 'Process restored successfully',
    });
  }

  async updateTeamDescription(
    teamId: string,
    description: string | null
  ): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/process/${teamId}/description`,
      options: {
        method: 'PATCH',
        body: JSON.stringify({ description }),
        headers: { 'Content-Type': 'application/json' },
      },
      successMessage: 'Description updated successfully',
    });
  }

  async sendMessage(
    teamId: string,
    userInput: string,
    agent_id: string | null
  ): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/process/${teamId}`,
      options: {
        method: 'PATCH',
        body: JSON.stringify({ content: userInput, send_to: agent_id }),
        headers: { 'Content-Type': 'application/json' },
      },
    });
  }

  async getMessages(team_id: string): Promise<Array<any>> {
    const response = await this.fetchService.fetch({
      url: `${this.apiUrl}/messages/${team_id}`,
    });
    return response ?? [];
  }

  async processHumanInput(
    userInput: string,
    message: SentMessage
  ): Promise<void> {
    const team_id = message.team_id;
    const humanProxy = message.recipient.agent_id;
    await this.fetchService.fetch({
      url: `${this.apiUrl}/process_human_input/${team_id}/human/${humanProxy}`,
      options: {
        method: 'POST',
        body: JSON.stringify({
          content: userInput,
          message: message.message,
        }),
        headers: { 'Content-Type': 'application/json' },
      },
    });
  }

  // If the response is null, feature not available !
  async getAgentContext(teamId: string): Promise<Array<any>> {
    return await this.fetchService.fetch({
      url: `${this.apiUrl}/llm_context/${teamId}`,
    });
  }

  async getAkgentStates(teamId: string): Promise<any> {
    return await this.fetchService.fetch({
      url: `${this.apiUrl}/states/${teamId}`,
    });
  }

  async updateAkgentState(
    teamId: string,
    agentId: string,
    partialState: any
  ): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/state/${teamId}/of/${agentId}`,
      options: {
        method: 'PATCH',
        body: JSON.stringify({ content: partialState }),
        headers: { 'Content-Type': 'application/json' },
      },
    });
  }

  async chat(teamId: string, agentId: string, userInput: string): Promise<any> {
    return await this.fetchService.fetch({
      url: `${this.apiUrl}/chat/${teamId}/with/${agentId}`,
      options: {
        method: 'POST',
        body: JSON.stringify({ content: userInput }),
        headers: { 'Content-Type': 'application/json' },
      },
    });
  }

  async relaunch(teamId: string, msgId: string): Promise<Response> {
    return fetch(`${this.apiUrl}/relaunch/${teamId}/message/${msgId}`, {
      method: 'POST',
    });
  }

  async getKnowledgeGraphData(teamId: string): Promise<any> {
    const response = await this.fetchService.fetch({
      url: `${this.apiUrl}/process/${teamId}`,
    });

    // Extract knowledge graph data from the response
    const knowledgeGraph = response?.knowledge_graph || {
      entities: [],
      relations: [],
    };
    // Transform the data to match our component interface
    return {
      nodes: knowledgeGraph.entities || [],
      edges: knowledgeGraph.relations || [],
    };
  }

  getWebSocketTicket(): Observable<string> {
    return from(
      this.fetchService.fetch({
        url: `${this.apiUrl}/auth/ws-ticket`,
      })
    ).pipe(map((response) => response.ticket));
  }
}
