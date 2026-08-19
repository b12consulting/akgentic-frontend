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
import { isRunning, TeamContext, TeamPage, toTeamContext } from './team.interface';

/** How long a stop or restore may take to land in the cached team status. */
const TEAM_STATE_TIMEOUT_MS = 10_000;

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

  // Total teams across all pages (classic offset+total pagination, Epic 28).
  // Single write path, same discipline as `_context$`; reset with the team
  // list so a stale total never bleeds across teams.
  private _totalCount$ = new BehaviorSubject<number>(0);
  public totalCount$: Observable<number> = this._totalCount$.asObservable();
  public get totalCount(): number {
    return this._totalCount$.value;
  }

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

  /**
   * Classic page load (Epic 28): fetch one page via `apiService.getTeamsPage`
   * and REPLACE the team list with it (one page in the DOM at a time — NOT
   * append) while recording `total_count`. Returns the page for awaiting
   * callers. Story 28.2 wires this to the paginator's `(onLazyLoad)`.
   */
  async loadTeamsPage(page?: number, size?: number): Promise<TeamPage> {
    const result = await this.apiService.getTeamsPage(page, size);
    this._context$.next(result.teams);
    this._totalCount$.next(result.total_count);
    return result;
  }

  /** Clear team-list state on team-switch / context reset so a stale page or
   *  total never bleeds across teams. */
  resetTeams(): void {
    this._context$.next([]);
    this._totalCount$.next(0);
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

  /**
   * Story 37-2: record that a team has stopped, without asking the server.
   *
   * The SECOND caller of the `_upsertTeam` seam that the comment on `_context$`
   * has anticipated since this service was written — a push, not a fetch. It
   * exists for the REMOTE stop: the idle timer, another tab, an operator, a
   * worker crash. `stopTeamAndAwait` already covers the local one by polling,
   * but when this tab did not issue the stop, nothing writes `_context$` at all
   * and `currentTeam$` reports a live session that has ceased to exist.
   *
   * COPY-AND-OVERRIDE, never `team.status = 'stopped'`. `currentTeam$` ends in a
   * `distinctUntilChanged()` with default reference equality, so an in-place
   * mutation re-emits nothing and no OnPush consumer repaints — the write would
   * appear to work, the cached value would even be correct, and the screen would
   * still show a running team. The new object reference IS the notification.
   *
   * Guarded BEFORE the write, and both halves of the guard are load-bearing:
   *   - unknown id — `_upsertTeam` APPENDS when the id is absent, so an
   *     unguarded call would materialise a phantom team row out of an event for
   *     a team this tab has never listed;
   *   - already not running — a re-entry writes nothing and emits nothing, which
   *     is what makes a stopped-team cold load (whose REST replay carries the
   *     stop event) a no-op rather than a redundant write.
   *
   * The literal `'stopped'` and not an enum: `TeamContext.status` is a plain
   * string here and `isRunning` compares against `'running'`. Widening that to
   * an enum is its own change with its own blast radius.
   */
  markStopped(teamId: string): void {
    const team = this._context$.value.find((t) => t.team_id === teamId);
    if (!team || !isRunning(team)) return;
    this._upsertTeam({ ...team, status: 'stopped' });
  }

  /**
   * Story 37-3: record a team's edited description, without asking the server.
   *
   * The THIRD caller of the `_upsertTeam` seam, after `getCurrentTeam` /
   * `refreshOneTeam` and `markStopped`. It exists because the Home page used to
   * reach into this cache and write `team.description = …` from outside the
   * service that owns it — a write that "succeeded" while the screen stayed
   * stale.
   *
   * COPY-AND-OVERRIDE, never `team.description = …`, for the same reason
   * `markStopped` copies: `currentTeam$` ends in a `distinctUntilChanged()` with
   * default reference equality, so an in-place write re-emits nothing and no
   * OnPush consumer repaints. The cached value would even be CORRECT while the
   * view showed the old text. The new object reference IS the notification.
   *
   * Guarded on the unknown id BEFORE the write, because `_upsertTeam` APPENDS
   * when the id is absent — an unguarded call would materialise a phantom team
   * row out of an edit for a team this tab has never listed.
   *
   * One guard only, and deliberately not `markStopped`'s pair: that method also
   * short-circuits an already-stopped team because a replayed stop event
   * arrives repeatedly and idempotence is what makes a cold load a no-op. A
   * description save is an explicit one-shot user action with no re-entry to
   * suppress, so a "description unchanged" guard would be behaviour nobody
   * asked for. Revisit if a future caller ever drives this from a stream.
   *
   * A sibling of `markStopped`, NOT a widening of it. Resist generalising the
   * two into a `patchTeam(id, partial)`: a general patch invites callers to
   * write fields they have not actually observed.
   */
  setTeamDescription(teamId: string, description: string | null): void {
    const team = this._context$.value.find((t) => t.team_id === teamId);
    if (!team) return;
    this._upsertTeam({ ...team, description });
  }

  async stopTeamAndAwait(
    teamId: string,
    timeoutMs: number = TEAM_STATE_TIMEOUT_MS,
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

  /**
   * Restart a stopped team and resolve once the cache reports it running
   * (ADR-024 §Decision 1). Mirror of `stopTeamAndAwait` with the readiness
   * predicate flipped to `isRunning`.
   *
   * Order is fixed: `POST /restore` is awaited FIRST — its 200 IS the readiness
   * signal (there is no "team ready" event to subscribe to) — and only then does
   * the bounded 1 s `refreshOneTeam` poll feed `_context$` until the cached team
   * satisfies `isRunning`. Rejects with a `TimeoutError` when that has not
   * happened within `timeoutMs`; the interval is torn down in the `finally` on
   * both the resolve and the reject path.
   *
   * Deliberately does NOT write `currentTeamRunning$`: the constructor
   * subscription is its sole writer (ADR-010), so the flip travels
   * `refreshOneTeam` → `_upsertTeam` → `_context$` → `currentTeam$`. "The
   * restore is done" and "the cache is fresh" are therefore the same statement.
   *
   * Because `teams$` replays the stale pre-restore snapshot at t=0 and the
   * interval first emits at t≈1 s, this typically resolves ≈1 s after the 200
   * even when the team is already ready. That latency is inherited from
   * `stopTeamAndAwait` and is intentional (see issue #235).
   */
  async restoreTeamAndAwait(
    teamId: string,
    timeoutMs: number = TEAM_STATE_TIMEOUT_MS,
  ): Promise<void> {
    await this.apiService.restoreTeam(teamId);

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
          filter((t): t is TeamContext => t !== undefined && isRunning(t)),
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
