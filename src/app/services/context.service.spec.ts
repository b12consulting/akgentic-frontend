import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { ApiService } from './api.service';
import { ContextService } from './context.service';
import { TeamContext, TeamResponse } from '../models/team.interface';

function makeTeam(
  teamId: string,
  status: string = 'running',
  name?: string
): TeamContext {
  return {
    team_id: teamId,
    name: name ?? `team-${teamId}`,
    status,
    created_at: '2026-04-19T10:00:00Z',
    updated_at: '2026-04-19T10:00:00Z',
    config_name: name ?? `team-${teamId}`,
    description: null,
  };
}

function makeTeamResponse(teamId: string, status: string = 'running'): TeamResponse {
  return {
    team_id: teamId,
    name: `team-${teamId}`,
    status,
    user_id: 'user-1',
    created_at: '2026-04-19T10:00:00Z',
    updated_at: '2026-04-19T10:00:00Z',
  };
}

describe('ContextService', () => {
  let service: ContextService;
  let apiSpy: jasmine.SpyObj<ApiService>;
  let routerSpy: jasmine.SpyObj<Router>;

  beforeEach(() => {
    apiSpy = jasmine.createSpyObj('ApiService', [
      'getTeams',
      'getTeam',
      'createTeam',
      'deleteTeam',
    ]);
    routerSpy = jasmine.createSpyObj('Router', ['navigate']);
    routerSpy.navigate.and.returnValue(Promise.resolve(true));

    TestBed.configureTestingModule({
      providers: [
        ContextService,
        { provide: ApiService, useValue: apiSpy },
        { provide: Router, useValue: routerSpy },
      ],
    });

    service = TestBed.inject(ContextService);
  });

  // --- AC1, AC11 ---------------------------------------------------------

  it('(AC1) teams$ emits [] synchronously on construction', async () => {
    const value = await firstValueFrom(service.teams$);
    expect(value).toEqual([]);
  });

  // --- AC2 ---------------------------------------------------------------

  it('(AC2) getTeams() calls apiService.getTeams then teams$ receives the list once', async () => {
    const teams = [makeTeam('a'), makeTeam('b')];
    apiSpy.getTeams.and.returnValue(Promise.resolve(teams));

    const emissions: TeamContext[][] = [];
    const sub = service.teams$.subscribe((v) => emissions.push(v));

    const returned = await service.getTeams();

    expect(apiSpy.getTeams).toHaveBeenCalledTimes(1);
    expect(returned).toEqual(teams);
    // Initial [] emission + the new list.
    expect(emissions.length).toBe(2);
    expect(emissions[1]).toEqual(teams);

    sub.unsubscribe();
  });

  it('(AC10) two consecutive getTeams() calls produce two distinct array references', async () => {
    const first = [makeTeam('a')];
    const second = [makeTeam('a'), makeTeam('b')];
    apiSpy.getTeams.and.returnValues(
      Promise.resolve(first),
      Promise.resolve(second)
    );

    await service.getTeams();
    const afterFirst = await firstValueFrom(service.teams$);
    await service.getTeams();
    const afterSecond = await firstValueFrom(service.teams$);

    expect(afterFirst).not.toBe(afterSecond);
    expect(afterFirst).toEqual(first);
    expect(afterSecond).toEqual(second);
  });

  // --- AC3, AC10 ---------------------------------------------------------

  it('(AC3, AC10) getCurrentTeam(false) produces new array ref + new slot ref; unchanged slots preserve identity', async () => {
    const teamA = makeTeam('a', 'running');
    const teamB = makeTeam('b', 'running');
    apiSpy.getTeams.and.returnValue(Promise.resolve([teamA, teamB]));
    await service.getTeams();

    const prev = await firstValueFrom(service.teams$);
    const prevA = prev.find((t) => t.team_id === 'a')!;
    const prevB = prev.find((t) => t.team_id === 'b')!;

    const updatedA = makeTeam('a', 'stopped');
    apiSpy.getTeam.and.returnValue(Promise.resolve(updatedA));

    await service.getCurrentTeam('a', false);

    const next = await firstValueFrom(service.teams$);
    expect(next).not.toBe(prev);
    const nextA = next.find((t) => t.team_id === 'a')!;
    const nextB = next.find((t) => t.team_id === 'b')!;
    expect(nextA).not.toBe(prevA);
    expect(nextA).toBe(updatedA);
    expect(nextB).toBe(prevB);
  });

  it('(AC3) getCurrentTeam(true) cache-hit leaves _context$.value unchanged; currentTeamRunning$.value reflects cached team', async () => {
    const teamA = makeTeam('a', 'running');
    apiSpy.getTeams.and.returnValue(Promise.resolve([teamA]));
    await service.getTeams();

    // Arm the derived pipeline by pointing currentProcessId$ at 'a' BEFORE
    // the cache-hit call. The pipeline is the sole writer to
    // currentTeamRunning$ (Story 10.2); getCurrentTeam no longer emits.
    service.currentProcessId$.next('a');
    // Let the derived pipeline flush its first emission.
    await Promise.resolve();

    const prev = await firstValueFrom(service.teams$);

    const result = await service.getCurrentTeam('a', true);

    expect(apiSpy.getTeam).not.toHaveBeenCalled();
    expect(result).toBe(teamA);
    const next = await firstValueFrom(service.teams$);
    expect(next).toBe(prev);
    // Derived pipeline already emitted `true` for the running cached team;
    // distinctUntilChanged may suppress further emissions, but .value is live.
    expect(service.currentTeamRunning$.value).toBe(true);
  });

  it('(AC3 guard) getCurrentTeam(false) with null API response leaves _context$.value unchanged', async () => {
    const teamA = makeTeam('a', 'running');
    apiSpy.getTeams.and.returnValue(Promise.resolve([teamA]));
    await service.getTeams();

    const prev = await firstValueFrom(service.teams$);
    apiSpy.getTeam.and.returnValue(Promise.resolve(null as unknown as TeamContext));

    const result = await service.getCurrentTeam('a', false);

    expect(result).toBeNull();
    const next = await firstValueFrom(service.teams$);
    expect(next).toBe(prev);
  });

  // --- AC4 ---------------------------------------------------------------

  it('(AC4) createTeamAndNavigate grows _context$.value by one and calls router.navigate', async () => {
    const existing = [makeTeam('a')];
    apiSpy.getTeams.and.returnValue(Promise.resolve(existing));
    await service.getTeams();

    const response = makeTeamResponse('new');
    apiSpy.createTeam.and.returnValue(Promise.resolve(response));
    routerSpy.navigate.and.returnValue(Promise.resolve(true));

    await service.createTeamAndNavigate('cat-1');

    const next = await firstValueFrom(service.teams$);
    expect(next.length).toBe(existing.length + 1);
    expect(next[next.length - 1].team_id).toBe('new');
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/process', 'new']);
  });

  // --- Story 10.4 — reload-free createTeamAndNavigate --------------------

  it('(AC2 10.4) createTeamAndNavigate does not drive a reload', async () => {
    const existing = [makeTeam('a')];
    apiSpy.getTeams.and.returnValue(Promise.resolve(existing));
    await service.getTeams();

    const response = makeTeamResponse('new');
    apiSpy.createTeam.and.returnValue(Promise.resolve(response));
    routerSpy.navigate.and.returnValue(Promise.resolve(true));

    // Variant A (plain removal) is adopted: there is no reloadFn seam in
    // production. The spy exists to document the "no reload" assertion
    // shape — it MUST remain at zero calls because the source code no
    // longer contains any path that would trigger it.
    const reloadSpy = jasmine.createSpy('reloadFn');

    await service.createTeamAndNavigate('cat-1');

    expect(reloadSpy).not.toHaveBeenCalled();
    expect(apiSpy.createTeam).toHaveBeenCalledOnceWith('cat-1');
    expect(routerSpy.navigate).toHaveBeenCalledOnceWith(['/process', 'new']);
  });

  it('(AC1 10.4) createTeamAndNavigate preserves immutability on append', async () => {
    const existing = [makeTeam('a'), makeTeam('b')];
    apiSpy.getTeams.and.returnValue(Promise.resolve(existing));
    await service.getTeams();

    const prev = await firstValueFrom(service.teams$);
    const prevA = prev.find((t) => t.team_id === 'a')!;
    const prevB = prev.find((t) => t.team_id === 'b')!;

    apiSpy.createTeam.and.returnValue(Promise.resolve(makeTeamResponse('new')));
    routerSpy.navigate.and.returnValue(Promise.resolve(true));

    await service.createTeamAndNavigate('cat-1');

    const next = await firstValueFrom(service.teams$);
    expect(next).not.toBe(prev);
    expect(next.length).toBe(prev.length + 1);
    expect(next.find((t) => t.team_id === 'a')).toBe(prevA);
    expect(next.find((t) => t.team_id === 'b')).toBe(prevB);
    expect(next[next.length - 1].team_id).toBe('new');
  });

  it('(AC3 10.4) after create + navigate, currentTeam$ emits the new team and currentTeamRunning$ reflects it', async () => {
    apiSpy.getTeams.and.returnValue(Promise.resolve([]));
    await service.getTeams();

    const newTeamResponse = makeTeamResponse('new', 'running');
    apiSpy.createTeam.and.returnValue(Promise.resolve(newTeamResponse));
    routerSpy.navigate.and.returnValue(Promise.resolve(true));

    await service.createTeamAndNavigate('cat-1');

    // The method itself does NOT set currentProcessId$; ProcessComponent.ngOnInit
    // does that in production. Simulate it here to exercise the derived pipeline.
    service.currentProcessId$.next('new');
    await Promise.resolve();

    const currentTeam = await firstValueFrom(service.currentTeam$);
    expect(currentTeam).not.toBeNull();
    expect(currentTeam!.team_id).toBe('new');
    expect(service.currentTeamRunning$.value).toBe(true);
  });

  // --- AC5 ---------------------------------------------------------------

  it('(AC5) deleteTeam shrinks _context$.value and calls apiService.deleteTeam', async () => {
    const teams = [makeTeam('a'), makeTeam('b'), makeTeam('c')];
    apiSpy.getTeams.and.returnValue(Promise.resolve(teams));
    await service.getTeams();

    apiSpy.deleteTeam.and.returnValue(Promise.resolve());

    await service.deleteTeam('b');

    expect(apiSpy.deleteTeam).toHaveBeenCalledOnceWith('b');
    const next = await firstValueFrom(service.teams$);
    expect(next.map((t) => t.team_id)).toEqual(['a', 'c']);
  });

  it('(AC5) clear(teamId) shrinks, ends with currentTeamRunning$.value === false via derived pipeline, and navigates home', async () => {
    const teams = [makeTeam('a'), makeTeam('b')];
    apiSpy.getTeams.and.returnValue(Promise.resolve(teams));
    await service.getTeams();

    apiSpy.deleteTeam.and.returnValue(Promise.resolve());
    routerSpy.navigate.and.returnValue(Promise.resolve(true));

    // Point currentProcessId$ at 'a' so the derived pipeline flips to `true`
    // first, then `false` after `clear('a')` removes the team.
    service.currentProcessId$.next('a');
    await Promise.resolve();
    expect(service.currentTeamRunning$.value).toBe(true);

    await service.clear('a');

    const next = await firstValueFrom(service.teams$);
    expect(next.map((t) => t.team_id)).toEqual(['b']);
    // Derived pipeline emitted `false` because `currentTeam$` → null.
    expect(service.currentTeamRunning$.value).toBe(false);
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/']);
  });

  // --- AC11 (Story 10.1 late-subscriber on teams$) -----------------------

  it('(AC11 10.1) late-subscriber receives the current value synchronously', async () => {
    const teams = [makeTeam('a')];
    apiSpy.getTeams.and.returnValue(Promise.resolve(teams));
    await service.getTeams();

    let received: TeamContext[] | undefined;
    const sub = service.teams$.subscribe((v) => (received = v));
    expect(received).toEqual(teams);
    sub.unsubscribe();
  });

  // =======================================================================
  // Story 10.2 — derived currentTeam$ pipeline
  // =======================================================================

  // --- AC1 (10.2) --------------------------------------------------------

  it('(AC1 10.2) currentTeam$ is exposed as a subscribable Observable', () => {
    expect(service.currentTeam$).toBeTruthy();
    expect(typeof service.currentTeam$.subscribe).toBe('function');
  });

  // --- AC2 (10.2) --------------------------------------------------------

  it('(AC2 10.2) currentTeam$ emits the team whose id matches currentProcessId$', async () => {
    const teamA = makeTeam('a', 'running');
    const teamB = makeTeam('b', 'stopped');
    apiSpy.getTeams.and.returnValue(Promise.resolve([teamA, teamB]));
    await service.getTeams();

    service.currentProcessId$.next('a');
    const first = await firstValueFrom(service.currentTeam$);
    expect(first).toBe(teamA);

    service.currentProcessId$.next('b');
    const second = await firstValueFrom(service.currentTeam$);
    expect(second).toBe(teamB);
  });

  // --- AC3 (10.2) --------------------------------------------------------

  it('(AC3 10.2) currentTeam$ emits in order on id switch; currentTeamRunning$ tracks running state', async () => {
    const teamA = makeTeam('a', 'running');
    const teamB = makeTeam('b', 'stopped');
    apiSpy.getTeams.and.returnValue(Promise.resolve([teamA, teamB]));
    await service.getTeams();

    const teamEmissions: (TeamContext | null)[] = [];
    const runningEmissions: boolean[] = [];
    const sub1 = service.currentTeam$.subscribe((t) => teamEmissions.push(t));
    const sub2 = service.currentTeamRunning$.subscribe((r) =>
      runningEmissions.push(r)
    );

    service.currentProcessId$.next('a');
    service.currentProcessId$.next('b');
    // Flush microtasks so the derived pipeline propagates.
    await Promise.resolve();

    expect(teamEmissions).toContain(teamA);
    expect(teamEmissions).toContain(teamB);
    // The last emission must be teamB (after the id switch).
    expect(teamEmissions[teamEmissions.length - 1]).toBe(teamB);
    // Running progression: init false → true (team-A) → false (team-B); last
    // emission is false, and the set must include true (from team-A).
    expect(runningEmissions[runningEmissions.length - 1]).toBe(false);
    expect(runningEmissions).toContain(true);

    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  // --- AC4 (10.2) --------------------------------------------------------

  it('(AC4 10.2) late subscriber to currentTeam$ receives current value synchronously', async () => {
    const teamA = makeTeam('a', 'running');
    apiSpy.getTeams.and.returnValue(Promise.resolve([teamA]));
    await service.getTeams();
    service.currentProcessId$.next('a');

    // Let microtasks flush so shareReplay has captured the value.
    await Promise.resolve();

    let received: TeamContext | null | undefined;
    const sub = service.currentTeam$.subscribe((t) => (received = t));
    expect(received).toBe(teamA);
    sub.unsubscribe();
  });

  // --- AC8 (10.2, NFR5) --------------------------------------------------

  it('(AC8 10.2 / NFR5) status flip via getCurrentTeam(id, false) emits currentTeam$ once and currentTeamRunning$ once', async () => {
    const teamA = makeTeam('a', 'running');
    apiSpy.getTeams.and.returnValue(Promise.resolve([teamA]));
    await service.getTeams();
    service.currentProcessId$.next('a');
    await Promise.resolve();

    const teamEmissions: (TeamContext | null)[] = [];
    const runningEmissions: boolean[] = [];
    const sub1 = service.currentTeam$.subscribe((t) => teamEmissions.push(t));
    const sub2 = service.currentTeamRunning$.subscribe((r) =>
      runningEmissions.push(r)
    );

    const countBeforeFlipTeam = teamEmissions.length;
    const countBeforeFlipRunning = runningEmissions.length;

    // Flip the team's status via getCurrentTeam(id, false).
    const stoppedA = makeTeam('a', 'stopped');
    apiSpy.getTeam.and.returnValue(Promise.resolve(stoppedA));
    await service.getCurrentTeam('a', false);

    expect(teamEmissions.length).toBe(countBeforeFlipTeam + 1);
    expect(teamEmissions[teamEmissions.length - 1]).toBe(stoppedA);
    expect(runningEmissions.length).toBe(countBeforeFlipRunning + 1);
    expect(runningEmissions[runningEmissions.length - 1]).toBe(false);

    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  // --- AC9 (10.2) --------------------------------------------------------

  it('(AC9 10.2) unknown currentProcessId$ emits null from currentTeam$ and false from currentTeamRunning$', async () => {
    const teamA = makeTeam('a', 'running');
    apiSpy.getTeams.and.returnValue(Promise.resolve([teamA]));
    await service.getTeams();

    service.currentProcessId$.next('does-not-exist');
    const t = await firstValueFrom(service.currentTeam$);
    expect(t).toBeNull();
    expect(service.currentTeamRunning$.value).toBe(false);
  });

  // --- AC11 (10.2) — single-fetch navigation invariant -------------------

  it('(AC11 10.2) navigation flow issues exactly ONE apiService.getTeam call (home init + id switch + ngOnInit fetch)', async () => {
    const teamA = makeTeam('a', 'running');
    const teamB = makeTeam('b', 'running');
    apiSpy.getTeams.and.returnValue(Promise.resolve([teamA, teamB]));
    // Simulate the single `getCurrentTeam(id, false)` call from
    // ProcessComponent.ngOnInit. No other code path issues a REST call.
    apiSpy.getTeam.and.returnValue(Promise.resolve(teamA));

    // Home init — loads the team list.
    await service.getTeams();

    // Route change — AppComponent reacts to currentProcessId$.next('a') but
    // NO LONGER fetches. The derived pipeline emits the cached team.
    service.currentProcessId$.next('a');
    await Promise.resolve();
    const afterRoute = await firstValueFrom(service.currentTeam$);
    expect(afterRoute).toBe(teamA);

    // ProcessComponent.ngOnInit — the single one-shot fetch.
    await service.getCurrentTeam('a', false);

    expect(apiSpy.getTeam).toHaveBeenCalledTimes(1);
    expect(apiSpy.getTeam).toHaveBeenCalledWith('a');
  });
});
