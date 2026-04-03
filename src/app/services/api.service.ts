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

  /** V2 processHumanInput: sends human input for a specific message in a team. */
  async processHumanInput(
    teamId: string,
    content: string,
    messageId: string
  ): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}/human-input`,
      options: {
        method: 'POST',
        body: JSON.stringify({ content, message_id: messageId }),
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

  /** No-op stub: description editing is not available in V2. */
  async updateTeamDescription(
    _teamId: string,
    _description: string | null
  ): Promise<void> {
    console.warn('updateTeamDescription is not available in V2');
  }

  // --- Stubs for Story 1.3/1.4 callers (message.service, akgent.service, etc.) ---
  // These remain until their callers are migrated in subsequent stories.

  /** @deprecated Story 1.3 will migrate callers to getEvents(). */
  async getMessages(teamId: string): Promise<any[]> {
    return this.getEvents(teamId);
  }

  /** @deprecated Story 1.3 will migrate callers. */
  async getAgentContext(_teamId: string): Promise<any> {
    return {};
  }

  /** @deprecated Story 1.3 will migrate callers. */
  async getAkgentStates(_teamId: string): Promise<any> {
    return {};
  }

  /** @deprecated Story 1.3 will migrate callers. */
  async updateAkgentState(..._args: any[]): Promise<void> {
    console.warn('updateAkgentState is removed in V2');
  }

  /** @deprecated Story 1.3 will migrate callers. */
  async chat(_teamId: string, _agentId: string, _userInput: string): Promise<any> {
    console.warn('chat is removed in V2');
    return null;
  }

  /** @deprecated Story 1.3 will migrate callers. */
  async relaunch(_teamId: string, _msgId: string): Promise<Response> {
    console.warn('relaunch is removed in V2');
    return new Response(null, { status: 204 });
  }

  /** @deprecated Story 1.4 will migrate callers. */
  async getKnowledgeGraphData(_teamId: string): Promise<any> {
    return { nodes: [], edges: [] };
  }
}
