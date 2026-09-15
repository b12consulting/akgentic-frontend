import { TeamContext } from '../../../core/context/team.interface';
import { railGroups, railMatches } from './rail-teams.selector';

function makeTeam(overrides: Partial<TeamContext> = {}): TeamContext {
  return {
    team_id: 'team-1',
    name: 'Demo Team',
    status: 'stopped',
    created_at: '2026-04-19T10:00:00Z',
    updated_at: '2026-04-19T10:00:00Z',
    config_name: 'demo',
    description: null,
    ...overrides,
  };
}

describe('railMatches', () => {
  it('matches everything when the query is empty or whitespace', () => {
    const team = makeTeam({ name: 'Alpha' });
    expect(railMatches(team, '')).toBeTrue();
    expect(railMatches(team, '   ')).toBeTrue();
  });

  it('matches the team name case-insensitively, as a substring', () => {
    const team = makeTeam({ name: 'Payroll Alpha' });
    expect(railMatches(team, 'ROLL AL')).toBeTrue();
    expect(railMatches(team, 'payroll')).toBeTrue();
    expect(railMatches(team, 'beta')).toBeFalse();
  });

  it('matches a metadata VALUE', () => {
    const team = makeTeam({ name: 'Alpha', metadata: { case_id: 'CS-4471' } });
    expect(railMatches(team, 'cs-44')).toBeTrue();
  });

  it('matches a metadata LABEL, not only its value', () => {
    // The humanised key is what the user sees elsewhere in the app, so typing
    // it has to find the rows that carry it.
    const team = makeTeam({ name: 'Alpha', metadata: { case_id: 'CS-4471' } });
    expect(railMatches(team, 'case id')).toBeTrue();
  });

  it('normalises its own argument, so an un-normalised query still matches', () => {
    const team = makeTeam({ name: 'Alpha' });
    expect(railMatches(team, '  ALPHA  ')).toBeTrue();
  });

  it('ignores metadata entries with no value, exactly as metadataEntries does', () => {
    const team = makeTeam({ name: 'Alpha', metadata: { case_id: '   ' } });
    expect(railMatches(team, 'case id')).toBeFalse();
  });
});

describe('railGroups', () => {
  it('splits running teams from the rest under the two documented keys', () => {
    const groups = railGroups(
      [
        makeTeam({ team_id: 'a', status: 'running' }),
        makeTeam({ team_id: 'b', status: 'stopped' }),
      ],
      '',
    );

    expect(groups.map((g) => g.labelKey)).toEqual(['rail.groupRunning', 'rail.groupRecent']);
    expect(groups[0].rows.map((r) => r.team.team_id)).toEqual(['a']);
    expect(groups[1].rows.map((r) => r.team.team_id)).toEqual(['b']);
  });

  it('omits an empty group entirely rather than returning it with no rows', () => {
    const groups = railGroups([makeTeam({ team_id: 'a', status: 'stopped' })], '');
    expect(groups.length).toBe(1);
    expect(groups[0].labelKey).toBe('rail.groupRecent');
  });

  it('returns no groups at all when nothing matches', () => {
    const groups = railGroups([makeTeam({ name: 'Alpha' })], 'zzz');
    expect(groups).toEqual([]);
  });

  it('resolves each row activity, including the tri-state unknown', () => {
    const groups = railGroups(
      [
        makeTeam({ team_id: 'w', status: 'running', working: true }),
        makeTeam({ team_id: 'i', status: 'running', working: false }),
        // Absent AND null both mean UNKNOWN, which renders as `running` —
        // never as `idle`.
        makeTeam({ team_id: 'u', status: 'running', working: null }),
        makeTeam({ team_id: 'n', status: 'running' }),
        makeTeam({ team_id: 's', status: 'stopped', working: true }),
      ],
      '',
    );

    const byId = new Map(
      groups.flatMap((g) => g.rows).map((r) => [r.team.team_id, r.activity]),
    );
    expect(byId.get('w')).toBe('working');
    expect(byId.get('i')).toBe('idle');
    expect(byId.get('u')).toBe('running');
    expect(byId.get('n')).toBe('running');
    // Stopped ignores the flag — a lifecycle state, not a momentary one.
    expect(byId.get('s')).toBe('stopped');
  });

  it('preserves the incoming order within a group and does not re-sort', () => {
    const groups = railGroups(
      [
        makeTeam({ team_id: 'c', name: 'Charlie', status: 'running' }),
        makeTeam({ team_id: 'a', name: 'Alpha', status: 'running' }),
        makeTeam({ team_id: 'b', name: 'Bravo', status: 'running' }),
      ],
      '',
    );
    expect(groups[0].rows.map((r) => r.team.team_id)).toEqual(['c', 'a', 'b']);
  });

  it('filters before grouping, so a group that loses all its rows disappears', () => {
    const groups = railGroups(
      [
        makeTeam({ team_id: 'a', name: 'Alpha', status: 'running' }),
        makeTeam({ team_id: 'b', name: 'Bravo', status: 'stopped' }),
      ],
      'bravo',
    );
    expect(groups.map((g) => g.labelKey)).toEqual(['rail.groupRecent']);
    expect(groups[0].rows.map((r) => r.team.team_id)).toEqual(['b']);
  });
});
