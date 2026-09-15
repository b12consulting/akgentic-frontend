import {
  TeamMetadataPipe,
  TeamTitlePipe,
  trackMetadataEntry,
} from './team-metadata.pipe';

describe('TeamMetadataPipe', () => {
  let pipe: TeamMetadataPipe;

  beforeEach(() => {
    pipe = new TeamMetadataPipe();
  });

  it('renders the metadata pairs', () => {
    const entries = pipe.transform({ case_id: 'C-1234' });

    expect(entries.length).toBe(1);
    expect(entries[0].label).toBe('Case id');
    expect(entries[0].value).toBe('C-1234');
  });

  it('yields [] for a team carrying no metadata, either spelling', () => {
    expect(pipe.transform(null)).toEqual([]);
    expect(pipe.transform(undefined)).toEqual([]);
  });

  it('drops the title key when one is passed (53-1, T2)', () => {
    // The title is rendered as the row's headline. Left in the chip set as
    // well it appears twice in one row, which reads as a data bug.
    const entries = pipe.transform(
      { subject: 'Late invoice', case_id: 'C-1234' },
      'subject',
    );

    expect(entries.map((e) => e.key)).toEqual(['case_id']);
  });

  it('keeps every key when no title is nominated (53-1, FR3)', () => {
    // The pre-Epic-53 call shape, and the shape a namespace nominating
    // nothing still produces. Both must render exactly as before.
    const metadata = { subject: 'Late invoice', case_id: 'C-1234' };

    expect(pipe.transform(metadata).map((e) => e.key)).toEqual([
      'subject',
      'case_id',
    ]);
    expect(pipe.transform(metadata, null).map((e) => e.key)).toEqual([
      'subject',
      'case_id',
    ]);
  });

  // The pipe's REASON FOR EXISTING — that it does not rebuild the chips on
  // every change-detection cycle — is pinned against the real DOM in
  // app.component.spec.ts ("does not rebuild the metadata chips on a
  // change-detection cycle"). It cannot be checked from here: memoisation is
  // the framework's behaviour around a pure pipe, not this class's.
});

describe('trackMetadataEntry', () => {
  it('tracks by the metadata key, so a re-sent value rebinds in place', () => {
    expect(trackMetadataEntry(0, { key: 'tenant', label: 'Tenant', value: 'acme' })).toBe(
      'tenant',
    );
    // Same key, different value — same track id, so the chip is updated
    // rather than torn down and recreated.
    expect(trackMetadataEntry(3, { key: 'tenant', label: 'Tenant', value: 'other' })).toBe(
      'tenant',
    );
  });
});

describe('TeamTitlePipe (53-1)', () => {
  let pipe: TeamTitlePipe;

  beforeEach(() => {
    pipe = new TeamTitlePipe();
  });

  it('yields the value under the nominated key', () => {
    expect(pipe.transform({ subject: 'Late invoice' }, 'subject')).toBe(
      'Late invoice',
    );
  });

  it('yields null when there is no title to show', () => {
    // Every "no title" state collapses to one, because the template branches
    // on it once: no nomination, no metadata, an unanswered key, and — the
    // one that is easy to miss — a generation that returned "" (T5).
    expect(pipe.transform({ subject: 'x' }, null)).toBeNull();
    expect(pipe.transform(null, 'subject')).toBeNull();
    expect(pipe.transform({}, 'subject')).toBeNull();
    expect(pipe.transform({ subject: '' }, 'subject')).toBeNull();
    expect(pipe.transform({ subject: '  ' }, 'subject')).toBeNull();
  });
});
