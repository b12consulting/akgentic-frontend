import {
  metadataEntries,
  NO_TEAM_FILTER,
  teamFilterEquals,
  TeamResponse,
  toTeamContext,
} from './team.interface';

function makeResponse(overrides: Partial<TeamResponse> = {}): TeamResponse {
  return {
    team_id: 't1',
    name: 'Alpha',
    status: 'running',
    user_id: 'u1',
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-01T10:00:00Z',
    ...overrides,
  };
}

describe('toTeamContext — metadata carry-through', () => {
  it('carries a populated metadata object through verbatim', () => {
    const metadata = { case_id: 'C-1234', tenant: 'acme' };

    expect(toTeamContext(makeResponse({ metadata })).metadata).toEqual(metadata);
  });

  it('maps BOTH wire spellings of "no metadata" to null', () => {
    // The two are independent: an older server omits the key entirely, a
    // current server sends an explicit null for a team whose namespace
    // declares no contract. Consumers must not have to tell them apart.
    expect(toTeamContext(makeResponse({ metadata: null })).metadata).toBeNull();
    expect(toTeamContext(makeResponse()).metadata).toBeNull();
  });
});

describe('metadataEntries', () => {
  it('returns [] for a team carrying no metadata, either spelling', () => {
    expect(metadataEntries(null)).toEqual([]);
    expect(metadataEntries(undefined)).toEqual([]);
    expect(metadataEntries({})).toEqual([]);
  });

  it('preserves key order — the order the declared model lists them', () => {
    const entries = metadataEntries(
      { zulu: '1', alpha: '2', mike: '3' },
    );

    expect(entries.map((e) => e.key)).toEqual(['zulu', 'alpha', 'mike']);
  });

  it('humanises the key into a label: separators to spaces, first letter up', () => {
    const entries = metadataEntries(
      { case_id: 'x', 'client-ref': 'y', tenant: 'z' },
    );

    expect(entries.map((e) => e.label)).toEqual(['Case id', 'Client ref', 'Tenant']);
  });

  it('renders non-string scalars as text and structures as JSON', () => {
    const entries = metadataEntries(
      { count: 7, urgent: false, tags: ['a', 'b'] },
    );

    expect(entries.map((e) => e.value)).toEqual(['7', 'false', '["a","b"]']);
  });

  it('drops absent values — null, undefined, and blank strings', () => {
    // An unanswered optional field is not information. Rendering it as an
    // empty chip reads as a value that failed to load.
    const entries = metadataEntries(
      {
        kept: 'yes',
        nulled: null,
        undef: undefined,
        empty: '',
        blank: '   ',
      },
    );

    expect(entries.map((e) => e.key)).toEqual(['kept']);
  });

  it('keeps a value that is falsy but real — 0 and false are answers', () => {
    const entries = metadataEntries({ count: 0, urgent: false });

    expect(entries.map((e) => e.value)).toEqual(['0', 'false']);
  });
});

describe('teamFilterEquals (48.1 AC3)', () => {
  it('is true for two DISTINCT objects with equal contents', () => {
    // The case that matters: every keystroke builds a fresh object, so an
    // identity comparison would suppress nothing.
    const a = { meta: { case_id: 'C-12', tenant: 'acme' }, catalogNamespace: 'ns' };
    const b = { meta: { case_id: 'C-12', tenant: 'acme' }, catalogNamespace: 'ns' };

    expect(a).not.toBe(b);
    expect(teamFilterEquals(a, b)).toBeTrue();
  });

  it('ignores key ORDER — the same terms under the same keys are the same filter', () => {
    const a = { meta: { case_id: 'C-12', tenant: 'acme' }, catalogNamespace: null };
    const b = { meta: { tenant: 'acme', case_id: 'C-12' }, catalogNamespace: null };

    expect(teamFilterEquals(a, b)).toBeTrue();
  });

  it('is false on a changed VALUE', () => {
    const a = { meta: { case_id: 'C-12' }, catalogNamespace: null };
    const b = { meta: { case_id: 'C-13' }, catalogNamespace: null };

    expect(teamFilterEquals(a, b)).toBeFalse();
  });

  it('is false on a changed KEY SET, in either direction', () => {
    const one = { meta: { case_id: 'C-12' }, catalogNamespace: null };
    const two = { meta: { case_id: 'C-12', tenant: 'acme' }, catalogNamespace: null };
    const swapped = { meta: { tenant: 'C-12' }, catalogNamespace: null };

    expect(teamFilterEquals(one, two)).toBeFalse();
    expect(teamFilterEquals(two, one)).toBeFalse();
    // Same size, same values, different keys — a length check alone misses it.
    expect(teamFilterEquals(one, swapped)).toBeFalse();
  });

  it('is false on a changed NAMESPACE, including on/off', () => {
    const off = { meta: { case_id: 'C-12' }, catalogNamespace: null };
    const on = { meta: { case_id: 'C-12' }, catalogNamespace: 'acme-support' };
    const other = { meta: { case_id: 'C-12' }, catalogNamespace: 'other-ns' };

    expect(teamFilterEquals(off, on)).toBeFalse();
    expect(teamFilterEquals(on, other)).toBeFalse();
  });

  it('reports NO_TEAM_FILTER equal to a freshly-built empty filter', () => {
    expect(
      teamFilterEquals(NO_TEAM_FILTER, { meta: {}, catalogNamespace: null }),
    ).toBeTrue();
  });
});
