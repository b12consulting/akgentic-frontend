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

  it('(AC3) getCurrentTeam(true) cache-hit leaves _context$.value unchanged and emits currentTeamRunning$', async () => {
    const teamA = makeTeam('a', 'running');
    apiSpy.getTeams.and.returnValue(Promise.resolve([teamA]));
    await service.getTeams();

    const prev = await firstValueFrom(service.teams$);

    const runningEmissions: boolean[] = [];
    const sub = service.currentTeamRunning$.subscribe((v) =>
      runningEmissions.push(v)
    );

    const result = await service.getCurrentTeam('a', true);

    expect(apiSpy.getTeam).not.toHaveBeenCalled();
    expect(result).toBe(teamA);
    const next = await firstValueFrom(service.teams$);
    expect(next).toBe(prev);
    // Initial false + cached isRunning(teamA) == true.
    expect(runningEmissions[runningEmissions.length - 1]).toBe(true);

    sub.unsubscribe();
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

    // router.navigate(...).then(() => window.location.reload()) — the reload
    // is out-of-scope for this story; stub .then by replacing navigate with
    // a resolved Promise that does not actually reload. We spy on navigate
    // and force `then` to swallow the reload callback safely.
    routerSpy.navigate.and.returnValue({
      then: (_cb: () => void) => Promise.resolve(true),
    } as unknown as Promise<boolean>);

    await service.createTeamAndNavigate('cat-1');

    const next = await firstValueFrom(service.teams$);
    expect(next.length).toBe(existing.length + 1);
    expect(next[next.length - 1].team_id).toBe('new');
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/process', 'new']);
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

  it('(AC5) clear(teamId) shrinks, emits currentTeamRunning$ false, and navigates home', async () => {
    const teams = [makeTeam('a'), makeTeam('b')];
    apiSpy.getTeams.and.returnValue(Promise.resolve(teams));
    await service.getTeams();

    apiSpy.deleteTeam.and.returnValue(Promise.resolve());
    routerSpy.navigate.and.returnValue(Promise.resolve(true));

    service.currentTeamRunning$.next(true);

    await service.clear('a');

    const next = await firstValueFrom(service.teams$);
    expect(next.map((t) => t.team_id)).toEqual(['b']);
    expect(service.currentTeamRunning$.value).toBe(false);
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/']);
  });

  // --- AC11 --------------------------------------------------------------

  it('(AC11) late-subscriber receives the current value synchronously', async () => {
    const teams = [makeTeam('a')];
    apiSpy.getTeams.and.returnValue(Promise.resolve(teams));
    await service.getTeams();

    let received: TeamContext[] | undefined;
    const sub = service.teams$.subscribe((v) => (received = v));
    expect(received).toEqual(teams);
    sub.unsubscribe();
  });
});
