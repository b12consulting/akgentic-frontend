import {
  isRunning,
  metadataEntries,
  TeamActivity,
  teamActivity,
  TeamContext,
} from '../../../core/context/team.interface';

/**
 * One team, ready for the rail to draw.
 *
 * Carries the ACTIVITY beside the team rather than leaving the row to derive
 * it: `teamActivity` is a six-row truth table whose three "unknown" rows are
 * the ones that get collapsed by accident, and resolving it here means the
 * grouping and the status dot can never disagree about what a team is doing.
 */
export interface RailTeamRow {
  readonly team: TeamContext;
  readonly activity: TeamActivity;
}

/**
 * A labelled run of rows.
 *
 * `labelKey` is a TRANSLATION KEY, not a heading — the selector is pure and has
 * no `TranslateService`, and a selector that returned rendered copy could not
 * be unit-tested without one.
 */
export interface RailTeamGroup {
  readonly labelKey: 'rail.groupRunning' | 'rail.groupRecent';
  readonly rows: readonly RailTeamRow[];
}

/**
 * Whether a team survives the rail's search box.
 *
 * A CLIENT-SIDE match over the page already loaded. `GET /teams` has no
 * free-text parameter (only `meta.<key>`, which needs an indexed key declared
 * by a namespace contract, and `catalog_namespace`), so this cannot be pushed
 * to the server and must not pretend to have been — see the note on
 * `RailSearchComponent` and the `rail.noResultsHint` string that goes with it.
 *
 * Normalises its own argument even though the parameter is named for an
 * already-normalised one: `trim().toLowerCase()` is idempotent, so a caller
 * that normalised once gets the same answer, and a caller that forgot does not
 * silently get a case-sensitive search.
 *
 * Matches the team's NAME and every metadata LABEL and VALUE. The labels are
 * included on purpose: the rail renders one metadata value as the row's second
 * line, so a user who can see "Case id" on screen — in the table, in the filter
 * bar — reasonably expects typing it to find the rows that carry it.
 */
export function railMatches(team: TeamContext, normalisedQuery: string): boolean {
  const q = normalisedQuery.trim().toLowerCase();
  if (q === '') {
    return true;
  }
  if (team.name.toLowerCase().includes(q)) {
    return true;
  }
  return metadataEntries(team.metadata).some(
    (entry) =>
      entry.label.toLowerCase().includes(q) || entry.value.toLowerCase().includes(q),
  );
}

/**
 * The rail's list: the matching teams, split into running and everything else.
 *
 * AN EMPTY GROUP IS OMITTED ENTIRELY rather than returned with no rows. The
 * rail renders a group's uppercase header from `labelKey`, so a group that
 * survived empty would draw a "RUNNING" heading over nothing — which reads as
 * rows that failed to load rather than as a category with no members.
 *
 * INCOMING ORDER IS PRESERVED within each group, and nothing is sorted here.
 * The server returns the page in `created_at desc` and this function only ever
 * sees ONE page: a client-side sort would reorder the fetched rows against the
 * server's ordering, so page 2 would open on rows that do not continue page 1.
 * That reads as a bug, and it is one.
 *
 * Pure and DI-free by construction — no service, no pipe, no `TranslateService`
 * — so the grouping rule and the match rule are testable without a TestBed.
 */
export function railGroups(
  teams: readonly TeamContext[],
  query: string,
): readonly RailTeamGroup[] {
  const q = query.trim().toLowerCase();
  const running: RailTeamRow[] = [];
  const recent: RailTeamRow[] = [];

  for (const team of teams) {
    if (!railMatches(team, q)) {
      continue;
    }
    const row: RailTeamRow = { team, activity: teamActivity(team) };
    // Partitioned on `isRunning`, NOT on `activity !== 'stopped'`. They agree
    // today by construction (`teamActivity` returns `'stopped'` for exactly the
    // teams `isRunning` rejects), and saying so through the same predicate the
    // rest of the app groups by is what keeps them agreeing.
    (isRunning(team) ? running : recent).push(row);
  }

  const groups: RailTeamGroup[] = [];
  if (running.length > 0) {
    groups.push({ labelKey: 'rail.groupRunning', rows: running });
  }
  if (recent.length > 0) {
    groups.push({ labelKey: 'rail.groupRecent', rows: recent });
  }
  return groups;
}
