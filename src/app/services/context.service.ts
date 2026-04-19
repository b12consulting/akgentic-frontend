import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject, combineLatest, Observable } from 'rxjs';
import { distinctUntilChanged, map, shareReplay } from 'rxjs/operators';
import { ApiService } from './api.service';
import { isRunning, TeamContext, toTeamContext } from '../models/team.interface';

@Injectable({
  providedIn: 'root',
})
export class ContextService {
  apiService: ApiService = inject(ApiService);
  router: Router = inject(Router);
  currentProcessId$ = new BehaviorSubject<string>('');
  /** Reactive running state of the current team. Derived selector fed by
   *  `currentTeam$` — navigation code paths no longer push here. Remains a
   *  BehaviorSubject so `.value` reads in consumers keep working. */
  currentTeamRunning$ = new BehaviorSubject<boolean>(false);

  // Single write path for the team list. A future homepage WebSocket
  // will push updates via _context$.next(applyPatch(_context$.value, patch)).
  private _context$ = new BehaviorSubject<TeamContext[]>([]);
  public teams$: Observable<TeamContext[]> = this._context$.asObservable();

  /** Derived selector: the team whose id matches `currentProcessId$`, or
   *  `null` if none matches (including the empty-string initial id). The
   *  `shareReplay(1, refCount:false)` gives late-subscriber safety without
   *  tearing the inner subscription down when consumer count drops to zero. */
  public currentTeam$: Observable<TeamContext | null> = combineLatest([
    this.currentProcessId$,
    this._context$,
  ]).pipe(
    map(([id, teams]) => (id ? (teams.find((t) => t.team_id === id) ?? null) : null)),
    distinctUntilChanged(),
    shareReplay({ bufferSize: 1, refCount: false }),
  );

  constructor() {
    // Derive currentTeamRunning$ from currentTeam$. The subscription lives
    // for the service lifetime (root-scoped singleton) — no teardown needed.
    // Internal subscription is the sole writer to currentTeamRunning$;
    // navigation code paths no longer call .next() directly.
    this.currentTeam$
      .pipe(
        map((t) => t !== null && isRunning(t)),
        distinctUntilChanged(),
      )
      .subscribe((running) => this.currentTeamRunning$.next(running));
  }

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
