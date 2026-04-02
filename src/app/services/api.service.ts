import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { FetchService } from './fetch.service';
import {
  TeamContext,
  TeamResponse,
  TeamListResponse,
  EventResponse,
  EventListResponse,
  toTeamContext,
} from '../models/team.interface';

@Injectable({
  providedIn: 'root',
})
export class ApiService {
  fetchService: FetchService = inject(FetchService);
  authService: AuthService = inject(AuthService);
  router: Router = inject(Router);

  private apiUrl = environment.api;
  webSocketTicket$ = new BehaviorSubject<string | null>(null);

  // --- Team CRUD (AC1) ---

  async getTeams(): Promise<TeamContext[]> {
    const response: TeamListResponse = await this.fetchService.fetch({
      url: `${this.apiUrl}/teams`,
    });
    const teams = response?.teams ?? [];
    return teams.map(toTeamContext);
  }

  async getTeam(teamId: string): Promise<TeamContext> {
    const response: TeamResponse = await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}`,
    });
    return toTeamContext(response);
  }

  async createTeam(catalogEntryId: string): Promise<TeamResponse> {
    return await this.fetchService.fetch({
      url: `${this.apiUrl}/teams`,
      options: {
        method: 'POST',
        body: JSON.stringify({ catalog_entry_id: catalogEntryId }),
        headers: { 'Content-Type': 'application/json' },
      },
    });
  }

  async deleteTeam(teamId: string): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}`,
      options: { method: 'DELETE' },
      successMessage: 'Team deleted successfully',
    });
  }

  async stopTeam(teamId: string): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}/stop`,
      options: { method: 'POST' },
      successMessage: 'Team stopped successfully',
    });
  }

  async restoreTeam(teamId: string): Promise<TeamResponse> {
    return await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}/restore`,
      options: { method: 'POST' },
      successMessage: 'Team restored successfully',
    });
  }

  // --- Messaging (AC2) ---

  async sendMessage(
    teamId: string,
    content: string,
    agentName?: string | null
  ): Promise<void> {
    if (agentName) {
      return this.sendMessageTo(teamId, content, agentName);
    }
    await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}/message`,
      options: {
        method: 'POST',
        body: JSON.stringify({ content }),
        headers: { 'Content-Type': 'application/json' },
      },
    });
  }

  async sendMessageTo(
    teamId: string,
    content: string,
    agentName: string
  ): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}/message/${agentName}`,
      options: {
        method: 'POST',
        body: JSON.stringify({ content }),
        headers: { 'Content-Type': 'application/json' },
      },
    });
  }

  /**
   * V2 signature: processHumanInput(teamId, content, messageId).
   * Also accepts V1 signature: processHumanInput(userInput, sentMessage)
   * for backward compatibility with un-migrated components (Story 1.2 will remove V1 path).
   */
  async processHumanInput(
    teamIdOrContent: string,
    contentOrMessage: string | { team_id: string; message_id?: string; id?: string },
    messageId?: string
  ): Promise<void> {
    let teamId: string;
    let content: string;
    let msgId: string;

    if (typeof contentOrMessage === 'string' && messageId !== undefined) {
      // V2 signature: processHumanInput(teamId, content, messageId)
      teamId = teamIdOrContent;
      content = contentOrMessage;
      msgId = messageId;
    } else if (typeof contentOrMessage === 'object' && contentOrMessage?.team_id) {
      // V1 signature: processHumanInput(userInput, sentMessage)
      teamId = contentOrMessage.team_id;
      content = teamIdOrContent;
      msgId = contentOrMessage.message_id ?? contentOrMessage.id ?? '';
    } else {
      console.warn('processHumanInput: unrecognized call signature, skipping');
      return;
    }

    await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}/human-input`,
      options: {
        method: 'POST',
        body: JSON.stringify({ content, message_id: msgId }),
        headers: { 'Content-Type': 'application/json' },
      },
    });
  }

  // --- Events (AC3) ---

  async getEvents(teamId: string): Promise<EventResponse[]> {
    const response: EventListResponse = await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}/events`,
    });
    return response?.events ?? [];
  }

  // --- Catalog (AC4) ---

  async getTeamConfigs(): Promise<any> {
    return await this.fetchService.fetch({
      url: `${this.apiUrl}/catalog/api/teams/`,
    });
  }

  // --- Auth stub (AC6 / AC12) ---

  getWebSocketTicket(): Observable<string> {
    return of('noauth');
  }

  // --- Backward-compatible aliases (Story 1.2 will remove these) ---
  // These stubs prevent compilation errors in components not yet migrated.

  /** @deprecated Use getTeams() */
  async getContext(): Promise<any[]> {
    return this.getTeams();
  }

  /** @deprecated Use getTeam() */
  async getProcess(processId: string): Promise<any> {
    return this.getTeam(processId);
  }

  /** @deprecated Use createTeam() */
  async createProcess(teamId: string, _config: string): Promise<void> {
    await this.createTeam(teamId);
  }

  /** @deprecated Use deleteTeam() */
  async deleteProcess(teamId: string): Promise<void> {
    await this.deleteTeam(teamId);
  }

  /** @deprecated Use stopTeam() */
  async archiveProcess(teamId: string): Promise<void> {
    await this.stopTeam(teamId);
  }

  /** @deprecated Use restoreTeam() */
  async restoreProcess(teamId: string): Promise<void> {
    await this.restoreTeam(teamId);
  }

  /** @deprecated Removed in V2 -- no-op stub for compilation. */
  async updateTeamDescription(
    _teamId: string,
    _description: string | null
  ): Promise<void> {
    console.warn('updateTeamDescription is removed in V2');
  }

  /** @deprecated Use getTeamConfigs() */
  async getConfig(_processType: string, _full: boolean = true): Promise<any[]> {
    return [];
  }

  /** @deprecated Removed in V2 -- no-op stub. */
  async saveConfig(..._args: any[]): Promise<void> {
    console.warn('saveConfig is removed in V2');
  }

  /** @deprecated Removed in V2 -- no-op stub. */
  async deleteConfig(..._args: any[]): Promise<void> {
    console.warn('deleteConfig is removed in V2');
  }

  /** @deprecated Use getEvents() */
  async getMessages(teamId: string): Promise<any[]> {
    return this.getEvents(teamId);
  }

  /** @deprecated Removed in V2 -- returns empty object. */
  async getAgentContext(_teamId: string): Promise<any> {
    return {};
  }

  /** @deprecated Removed in V2 -- returns empty object. */
  async getAkgentStates(_teamId: string): Promise<any> {
    return {};
  }

  /** @deprecated Removed in V2 -- no-op stub. */
  async updateAkgentState(..._args: any[]): Promise<void> {
    console.warn('updateAkgentState is removed in V2');
  }

  /** @deprecated Removed in V2 -- no-op stub. */
  async chat(_teamId: string, _agentId: string, _userInput: string): Promise<any> {
    console.warn('chat is removed in V2');
    return null;
  }

  /** @deprecated Removed in V2 -- no-op stub. */
  async relaunch(_teamId: string, _msgId: string): Promise<Response> {
    console.warn('relaunch is removed in V2');
    return new Response(null, { status: 204 });
  }

  /** @deprecated Removed in V2 -- returns empty graph. */
  async getKnowledgeGraphData(_teamId: string): Promise<any> {
    return { nodes: [], edges: [] };
  }
}
