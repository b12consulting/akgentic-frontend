import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import {
  BehaviorSubject,
  combineLatest,
  firstValueFrom,
  interval,
  Observable,
  Subject,
} from 'rxjs';
import {
  distinctUntilChanged,
  filter,
  map,
  shareReplay,
  switchMap,
  take,
  takeUntil,
  timeout,
} from 'rxjs/operators';
import { ApiService } from '../http/api.service';
import { isRunning, TeamContext, toTeamContext } from './team.interface';

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

  // Held cursor for the paginated team list (ADR-031). `null` initially and
  // after the last page; an opaque token otherwise. Single source of truth
  // for whether more pages remain.
  private _nextCursor: string | null = null;

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

  /** Full-replace load of the first page (legacy home-view path, Story 27.2
   *  migrates its callers to `loadTeamsPage`). Replaces `teams$` wholesale. */
  async getTeams(): Promise<TeamContext[]> {
    const page = await this.apiService.getTeams();
    this._context$.next(page.teams);
    return page.teams;
  }

  /** Held cursor for the paginated list: `null` before any load and on the
   *  last page, an opaque token otherwise. */
  get nextCursor(): string | null {
    return this._nextCursor;
  }

  /** Whether another page remains to fetch (true once a page reported a
   *  non-null `next_cursor`; false initially and after the last page). */
  hasMorePages(): boolean {
    return this._nextCursor !== null;
  }

  /** Fetch one page (cursor-paginated, ADR-031) and APPEND it to `teams$`
   *  without replacing the existing rows; track the returned opaque cursor.
   *  Called with no cursor to seed the first page onto whatever is in the
   *  list (typically empty after `resetTeams`). */
  async loadTeamsPage(cursor?: string): Promise<void> {
    const page = await this.apiService.getTeams(cursor);
    this._context$.next([...this._context$.value, ...page.teams]);
    this._nextCursor = page.next_cursor;
  }

  /** Reset the paginated list to a fresh first page: clear `teams$` and the
   *  held cursor (e.g. on team-switch). */
  resetTeams(): void {
    this._context$.next([]);
    this._nextCursor = null;
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
      this._upsertTeam(team);
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

  async createTeamAndNavigate(namespace: string) {
    const response = await this.apiService.createTeam(namespace);
    const newTeam = toTeamContext(response);
    const prev = this._context$.value;
    this._context$.next([...prev, newTeam]);
    await this.router.navigate(['/process', response.team_id]);
  }

  private async refreshOneTeam(teamId: string): Promise<TeamContext | null> {
    const fresh = await this.apiService.getTeam(teamId);
    if (fresh) {
      this._upsertTeam(fresh);
    }
    return fresh;
  }

  /** Upsert a team into `_context$`: replace if already cached (preserves
   *  reference identity of other slots); append if not yet cached. Single
   *  write path shared by `getCurrentTeam` and `refreshOneTeam` so the two
   *  cannot diverge in a future change. Issue #104 regression fix. */
  private _upsertTeam(team: TeamContext): void {
    const prev = this._context$.value;
    const exists = prev.some((t) => t.team_id === team.team_id);
    const next = exists
      ? prev.map((t) => (t.team_id === team.team_id ? team : t))
      : [...prev, team];
    this._context$.next(next);
  }

  async stopTeamAndAwait(
    teamId: string,
    timeoutMs: number = 10000,
  ): Promise<void> {
    await this.apiService.stopTeam(teamId);

    // Bounded periodic refresh feeding _context$ with fresh data for this
    // team only. When homepage WebSocket lands this interval is replaced by
    // WS-driven _context$.next(...) updates; the firstValueFrom awaiter below
    // stays unchanged.
    const stop$ = new Subject<void>();
    interval(1000)
      .pipe(
        takeUntil(stop$),
        switchMap(() => this.refreshOneTeam(teamId)),
      )
      .subscribe();

    try {
      await firstValueFrom(
        this.teams$.pipe(
          map((teams) => teams.find((t) => t.team_id === teamId)),
          filter((t): t is TeamContext => t !== undefined && !isRunning(t)),
          take(1),
          timeout(timeoutMs),
        ),
      );
    } finally {
      stop$.next();
      stop$.complete();
    }
  }
}
