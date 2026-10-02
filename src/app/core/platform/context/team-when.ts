import { formatDate } from '@angular/common';

/**
 * A team's timestamp as the rail prints it: a clock time for a stamp from
 * TODAY, a day-and-month otherwise.
 *
 * Lifted out of the rail's row (Story 58-3) so the rule is a pure function
 * with a pinned clock. It lives in `platform` rather than in `ui` because it
 * is a display rule over a team field, like `team-metadata.pipe.ts` beside it,
 * and nothing in it belongs to one component. The home table does NOT use it:
 * its Updated column sits beside Creation Date and renders through the same
 * `date: "short"` pipe as that cell, so two adjacent dates are written one way.
 *
 * WHY THE TWO FORMATS. A rail row is 268px wide and the meta line shares it
 * with a summary, so the format has to earn its characters: "16:35" answers
 * "when today?" and "Apr 19" answers "which day?", and neither needs the
 * other's half.
 *
 * `now` IS A PARAMETER, defaulting to the clock, so a spec can pin the
 * same-day branch without racing midnight. Production callers pass nothing.
 *
 * `''` for every flavour of "no stamp" — absent, `null`, empty, unparseable —
 * rather than a throw or an "Invalid Date": a server that sent something odd
 * should not blank the row that carries it.
 */
export function formatTeamWhen(
  iso: string | null | undefined,
  locale: string,
  now: Date = new Date(),
): string {
  if (!iso) {
    return '';
  }
  const stamp = new Date(iso);
  if (Number.isNaN(stamp.getTime())) {
    return '';
  }
  const sameDay =
    stamp.getFullYear() === now.getFullYear() &&
    stamp.getMonth() === now.getMonth() &&
    stamp.getDate() === now.getDate();
  return formatDate(stamp, sameDay ? 'shortTime' : 'MMM d', locale);
}
