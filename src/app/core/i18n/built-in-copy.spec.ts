import en from './locales/en.json';

/**
 * The one place in this repo that asserts what a string SAYS.
 *
 * NFR3 puts every other spec on keys, and rightly: a component spec that pins
 * "Create" fails the day the copy improves, and tells you nothing when it does.
 * But a handful of strings carry a product decision rather than a wording, and
 * converting their specs to key assertions would have quietly retired the
 * decision along with the sentence. Those claims live here instead — stated
 * once, about the BUILT-IN English only.
 *
 * Deliberately narrow. This is not a copy review and it must not become one:
 * a claim belongs here only if it was a stated requirement that some component
 * spec used to enforce through its rendered text. Translations are never
 * asserted — `fr.json` may phrase the same claim however French phrases it.
 */

type Dict = Record<string, unknown>;

function copy(path: string): string {
  const value = path
    .split('.')
    .reduce<unknown>((node, key) => (node as Dict | undefined)?.[key], en as Dict);
  expect(typeof value)
    .withContext(`no built-in string at "${path}"`)
    .toBe('string');
  return value as string;
}

describe('claims the built-in English is required to make', () => {
  // Epic 55. The activity flag describes one instant and arrives inside a page
  // fetched at another; nothing polls to keep it fresh. The tags' titles used to
  // be pinned in the team-table spec, which now asserts only that each state
  // binds its own title key — the promise itself is this.
  it('qualifies an activity tag as of the last refresh rather than as live', () => {
    expect(copy('team.status.workingTitle')).toContain('as of the last refresh');
    expect(copy('team.status.idleTitle')).toContain('as of the last refresh');
  });

  it('does not let an activity title claim the reading is current', () => {
    for (const key of ['team.status.workingTitle', 'team.status.idleTitle']) {
      expect(copy(key).toLowerCase()).not.toContain('now');
      expect(copy(key).toLowerCase()).not.toContain('currently');
    }
  });

  // Epic 48 AC14. Two controls both mention the team type: the select that picks
  // one and the toggle that narrows to it. Sharing a caption is how the select
  // starts reading as a filter that does not work.
  it('does not let the narrowing toggle reuse the team-type select\'s caption', () => {
    expect(copy('home.filter.thisTeamTypeOnly')).not.toBe(copy('home.teamType'));
  });
});
