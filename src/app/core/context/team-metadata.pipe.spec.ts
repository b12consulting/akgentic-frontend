import { TeamMetadataPipe, trackMetadataEntry } from './team-metadata.pipe';

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
