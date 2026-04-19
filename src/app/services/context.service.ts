import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { ApiService } from './api.service';
import { isRunning, TeamContext } from '../models/team.interface';

@Injectable({
  providedIn: 'root',
})
export class ContextService {
  apiService: ApiService = inject(ApiService);
  router: Router = inject(Router);
  currentProcessId$ = new BehaviorSubject<string>('');
  /** Reactive running state of the current team. Updated by getCurrentTeam()
   *  and reset when navigating away. Future: fed by homepage WebSocket. */
  currentTeamRunning$ = new BehaviorSubject<boolean>(false);

  _context: TeamContext[] = [];

  async getTeams(): Promise<TeamContext[]> {
    this._context = await this.apiService.getTeams();
    return this._context;
  }

  async getCurrentTeam(
    teamId: string,
    useCache: boolean = true
  ): Promise<TeamContext | null> {
    if (useCache) {
      const cached = this._context.find(
        (t: TeamContext) => t.team_id === teamId
      );
      if (cached) {
        this.currentTeamRunning$.next(isRunning(cached));
        return cached;
      }
    }

    const team = await this.apiService.getTeam(teamId);

    this._context = this._context.map((t: TeamContext) =>
      t.team_id === teamId ? team : t
    );

    if (team) {
      this.currentTeamRunning$.next(isRunning(team));
    }

    return team;
  }

  async deleteTeam(teamId: string): Promise<void> {
    await this.apiService.deleteTeam(teamId);
  }

  async clear(teamId: string) {
    await this.deleteTeam(teamId);
    this.currentTeamRunning$.next(false);
    await this.router.navigate(['/']);
  }

  async createTeamAndNavigate(catalogEntryId: string) {
    const response = await this.apiService.createTeam(catalogEntryId);
    await this.router.navigate(['/process', response.team_id]).then(() => {
      window.location.reload();
    });
  }

}
