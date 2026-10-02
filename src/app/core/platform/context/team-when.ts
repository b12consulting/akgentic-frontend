import { formatDate } from '@angular/common';
import { inject, LOCALE_ID, Pipe, PipeTransform } from '@angular/core';

/**
 * A team's timestamp as the two list surfaces print it: a clock time for a
 * stamp from TODAY, a day-and-month otherwise.
 *
 * ONE helper, because two surfaces must agree on "when". The rail's row and
 * the home table's row both answer the same question beside a team's name, and
 * two private formatters would drift the first time one of them was touched —
 * silently, since nothing compares them. This is the rail's own formatter
 * lifted out so the table can literally call the same code.
 *
 * WHY THE TWO FORMATS (carried over from the rail, which chose them). A rail
 * row is 268px wide and the meta line shares it with a summary, so the format
 * has to earn its characters: "16:35" answers "when today?" and "Apr 19"
 * answers "which day?", and neither needs the other's half.
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

/**
 * `formatTeamWhen` as a pipe, for the surfaces that bind it in a template.
 *
 * PURE (the default), and correctly so: the input is a string, so the result
 * can only change when the stamp does. The one thing purity gives up is the
 * clock — a same-day row seen past midnight keeps its clock time until its
 * stamp next changes. That is the staleness the rail has always accepted
 * (its `computeWhen` runs only in `ngOnChanges`), and the table inherits it
 * rather than paying an impure pipe's per-cycle re-run to avoid it.
 *
 * The rail does NOT use this pipe. Its result there is a translation
 * PARAMETER, built in TypeScript so the separator between it and the summary
 * belongs to the sentence; it calls the function directly.
 */
@Pipe({ name: 'teamWhen' })
export class TeamWhenPipe implements PipeTransform {
  private readonly locale = inject(LOCALE_ID);

  transform(iso: string | null | undefined): string {
    return formatTeamWhen(iso, this.locale);
  }
}
