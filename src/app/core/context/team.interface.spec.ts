import {
  MetadataFieldDescriptor,
  TeamMetadataContract,
} from '../../protocol/catalog.interface';
import {
  metadataEntries,
  NO_TEAM_FILTER,
  teamFilterEquals,
  TeamResponse,
  teamTitle,
  titleFieldKey,
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

describe('metadataEntries — excluding the title key (53-1, T2)', () => {
  it('drops the excluded key and keeps every other one, in order', () => {
    // The title is an ordinary metadata key. A surface that promotes it to a
    // heading and does NOT exclude it here renders the same value twice in
    // one row, which reads as duplicated data rather than as a layout slip.
    const entries = metadataEntries(
      { subject: 'Late invoice', case_id: 'C-1234', tenant: 'acme' },
      'subject',
    );

    expect(entries.map((e) => e.key)).toEqual(['case_id', 'tenant']);
  });

  it('is unchanged by an exclusion no key matches', () => {
    const entries = metadataEntries({ case_id: 'C-1234' }, 'subject');

    expect(entries.map((e) => e.key)).toEqual(['case_id']);
  });

  it('excludes NOTHING when the argument is omitted, null or undefined', () => {
    // FR3: a caller that renders no title sees exactly today's behaviour. The
    // three spellings must agree — `null` in particular is what a template
    // passes when the namespace nominates no field, and an implementation
    // comparing loosely would strip a key literally called "null".
    const metadata = { case_id: 'C-1234', tenant: 'acme' };

    expect(metadataEntries(metadata).map((e) => e.key)).toEqual([
      'case_id',
      'tenant',
    ]);
    expect(metadataEntries(metadata, null).map((e) => e.key)).toEqual([
      'case_id',
      'tenant',
    ]);
    expect(metadataEntries(metadata, undefined).map((e) => e.key)).toEqual([
      'case_id',
      'tenant',
    ]);
  });
});

/** A field descriptor with the four always-emitted properties filled in. */
function makeField(
  overrides: Partial<MetadataFieldDescriptor> & { key: string },
): MetadataFieldDescriptor {
  return {
    description: '',
    index: false,
    mandatory: false,
    ...overrides,
  };
}

describe('titleFieldKey (53-1, FR1)', () => {
  it('returns the key of the field that declares itself the title', () => {
    const contract: TeamMetadataContract = {
      type: 'demo.Team',
      fields: [makeField({ key: 'case_id' }), makeField({ key: 'subject', is_title: true })],
    };

    expect(titleFieldKey(contract)).toBe('subject');
  });

  it('returns null when no field declares itself the title', () => {
    // FR3 — the state of every namespace shipped before this epic.
    const contract: TeamMetadataContract = {
      type: 'demo.Team',
      fields: [makeField({ key: 'case_id' }), makeField({ key: 'tenant' })],
    };

    expect(titleFieldKey(contract)).toBeNull();
  });

  it('maps BOTH spellings of "the namespace declares no contract" to null', () => {
    // `team_metadata` is optional AND nullable and the two mean the same
    // thing. A consumer gating on `=== null` alone would be broken.
    expect(titleFieldKey(null)).toBeNull();
    expect(titleFieldKey(undefined)).toBeNull();
  });

  it('returns null for a declared contract with no fields at all', () => {
    expect(titleFieldKey({ type: 'demo.Team', fields: [] })).toBeNull();
  });

  it('treats undefined, null and false as "not the title" alike', () => {
    // A server predating the field omits the key; a current server may send
    // an explicit null or false. All three are the same answer.
    const contract: TeamMetadataContract = {
      type: 'demo.Team',
      fields: [
        makeField({ key: 'a' }),
        makeField({ key: 'b', is_title: null }),
        makeField({ key: 'c', is_title: false }),
      ],
    };

    expect(titleFieldKey(contract)).toBeNull();
  });

  it('(T3) takes the FIRST declared title when a malformed contract declares two', () => {
    // "Exactly one" is a rule the SERVER owns, so the server can break it. The
    // frontend must still be deterministic: declaration order decides, and
    // `fields` arrives in declaration order always. The failure mode this
    // pins out is resolving the title by walking a metadata object's keys,
    // where the answer would depend on one team's data rather than on the
    // contract.
    const contract: TeamMetadataContract = {
      type: 'demo.Team',
      fields: [
        makeField({ key: 'case_id' }),
        makeField({ key: 'subject', is_title: true }),
        makeField({ key: 'headline', is_title: true }),
      ],
    };

    expect(titleFieldKey(contract)).toBe('subject');
  });

  it('(T3) is stable across repeated calls on the same malformed contract', () => {
    const contract: TeamMetadataContract = {
      type: 'demo.Team',
      fields: [
        makeField({ key: 'first', is_title: true }),
        makeField({ key: 'second', is_title: true }),
      ],
    };

    expect([titleFieldKey(contract), titleFieldKey(contract), titleFieldKey(contract)])
      .toEqual(['first', 'first', 'first']);
  });
});

describe('teamTitle (53-1, FR2/FR3)', () => {
  it('reads the title out of the metadata under the nominated key', () => {
    expect(teamTitle({ subject: 'Late invoice', tenant: 'acme' }, 'subject')).toBe(
      'Late invoice',
    );
  });

  it('returns null when the namespace nominates no field', () => {
    expect(teamTitle({ subject: 'Late invoice' }, null)).toBeNull();
    expect(teamTitle({ subject: 'Late invoice' }, undefined)).toBeNull();
  });

  it('returns null for a team carrying no metadata, either spelling', () => {
    // Every team created before the namespace declared a contract.
    expect(teamTitle(null, 'subject')).toBeNull();
    expect(teamTitle(undefined, 'subject')).toBeNull();
    expect(teamTitle({}, 'subject')).toBeNull();
  });

  it('returns null when the nominated key is present but unanswered', () => {
    expect(teamTitle({ subject: null }, 'subject')).toBeNull();
    expect(teamTitle({ subject: undefined }, 'subject')).toBeNull();
  });

  it('(T5) falls back for an empty string — a generation that produced ""', () => {
    // The trap: `""` is present, so a truthiness check on the KEY passes and a
    // blank heading is rendered with no fallback. A blank heading is strictly
    // worse than the team type: it reads as a value that failed to load.
    expect(teamTitle({ subject: '' }, 'subject')).toBeNull();
  });

  it('(T5) falls back for a whitespace-only title, by the same rule chips use', () => {
    expect(teamTitle({ subject: '   ' }, 'subject')).toBeNull();
    expect(teamTitle({ subject: '\t\n ' }, 'subject')).toBeNull();
  });

  it('keeps the title VERBATIM, including its surrounding spaces', () => {
    // Only the emptiness TEST trims. Trimming the value itself would be this
    // layer editing a generated string it does not own.
    expect(teamTitle({ subject: '  Late invoice  ' }, 'subject')).toBe(
      '  Late invoice  ',
    );
  });

  it('renders a non-string scalar as text, the same way a chip does', () => {
    // A contract is free to nominate a numeric field. It is a poor title, but
    // it is a title, and it must not come out as "[object Object]" or crash.
    expect(teamTitle({ ref: 42 }, 'ref')).toBe('42');
    expect(teamTitle({ ref: false }, 'ref')).toBe('false');
  });

  it('(T4) returns markup as the TEXT it is, never as markup', () => {
    // A generated title is untrusted. This function hands back a string; the
    // template interpolates it. Nothing here builds HTML for a caller to pass
    // to a sanitiser bypass.
    const injected = '<img src=x onerror="alert(1)">';

    expect(teamTitle({ subject: injected }, 'subject')).toBe(injected);
  });
});
