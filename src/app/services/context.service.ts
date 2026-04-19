import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable } from 'rxjs';
import { ApiService } from './api.service';
import { isRunning, TeamContext, toTeamContext } from '../models/team.interface';

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

  // Single write path for the team list. A future homepage WebSocket
  // will push updates via _context$.next(applyPatch(_context$.value, patch)).
  private _context$ = new BehaviorSubject<TeamContext[]>([]);
  public teams$: Observable<TeamContext[]> = this._context$.asObservable();

  async getTeams(): Promise<TeamContext[]> {
    const teams = await this.apiService.getTeams();
    this._context$.next(teams);
    return teams;
  }

  async getCurrentTeam(
    teamId: string,
    useCache: boolean = true
  ): Promise<TeamContext | null> {
    if (useCache) {
      const cached = this._context$.value.find(
        (t: TeamContext) => t.team_id === teamId
      );
      if (cached) {
        this.currentTeamRunning$.next(isRunning(cached));
        return cached;
      }
    }

    const team = await this.apiService.getTeam(teamId);

    if (team) {
      const prev = this._context$.value;
      const next = prev.map((t: TeamContext) =>
        t.team_id === teamId ? team : t
      );
      this._context$.next(next);
      this.currentTeamRunning$.next(isRunning(team));
    }

    return team;
  }

  async deleteTeam(teamId: string): Promise<void> {
    await this.apiService.deleteTeam(teamId);
    const prev = this._context$.value;
    this._context$.next(prev.filter((t: TeamContext) => t.team_id !== teamId));
  }

  async clear(teamId: string) {
    await this.deleteTeam(teamId);
    this.currentTeamRunning$.next(false);
    await this.router.navigate(['/']);
  }

  async createTeamAndNavigate(catalogEntryId: string) {
    const response = await this.apiService.createTeam(catalogEntryId);
    const newTeam = toTeamContext(response);
    const prev = this._context$.value;
    this._context$.next([...prev, newTeam]);
    await this.router.navigate(['/process', response.team_id]).then(() => {
      window.location.reload();
    });
  }
}
