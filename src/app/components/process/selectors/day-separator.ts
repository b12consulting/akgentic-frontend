/**
 * Day separators for the chat transcript (Epic 54).
 *
 * A transcript that has been open across days runs yesterday's exchange into
 * this morning's with nothing between them. This module decides WHERE a
 * calendar-day rule belongs. It knows nothing about rendering — it takes
 * timestamps and returns, per turn, the separator that must precede it — so
 * every boundary rule below is provable without a component fixture (NFR2).
 *
 * ---------------------------------------------------------------------------
 * LOCAL, NOT UTC (Trap T2)
 * ---------------------------------------------------------------------------
 * The boundary is computed on the reader's LOCAL calendar day, via
 * `getFullYear` / `getMonth` / `getDate`. A separator answers "what day was I
 * reading this on?", which is a question about the reader's wall clock, not
 * about the backend's. The rest of the transcript already agrees: every turn
 * renders its time through Angular's `date` pipe, which is local. Comparing on
 * UTC would put the break at 01:00 or 02:00 local for a European reader — a
 * shift nobody notices until someone works late, and then it looks like the
 * transcript is lying about the day.
 *
 * The cost is that the same transcript separates differently in two time zones.
 * That is the correct trade: the separator is a reading aid, not a record.
 */

/**
 * A calendar-day rule to be rendered ABOVE a turn.
 *
 * `day` is the identity, `label` is what is shown. They are two fields on
 * purpose, even though `formatDayLabel` is currently the identity function:
 * `day` is consumed by `trackBy` and must never change for a given day, while
 * `label` is presentation and a deployment may re-point it.
 */
export interface DaySeparator {
  /** Local calendar day, ISO-8601 `YYYY-MM-DD`. Stable list identity. */
  readonly day: string;
  /** The rendered text. */
  readonly label: string;
}

function pad(value: number, width: number): string {
  return String(Math.abs(value)).padStart(width, '0');
}

/**
 * The LOCAL calendar day of `value` as `YYYY-MM-DD`, or `null` when the value
 * carries no usable date (FR5).
 *
 * `null`, `undefined` and an `Invalid Date` (what `new Date('not a date')`
 * produces, and therefore what `classifyMessage` puts on a message whose
 * backend timestamp is malformed) all return `null`. Nothing here throws: a
 * malformed date from a backend is a rendering question, never an error dialog.
 */
export function localDayKey(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  // Local getters — see the LOCAL, NOT UTC note above.
  return (
    pad(date.getFullYear(), 4) +
    '-' +
    pad(date.getMonth() + 1, 2) +
    '-' +
    pad(date.getDate(), 2)
  );
}

/**
 * The visible label for a day key (FR7 — zero-padded and unambiguous).
 *
 * The ISO-8601 form is the label. `YYYY-MM-DD` is zero-padded by construction
 * and unambiguous in every locale, which `01/02/2026` is not; and the app
 * registers no locale data, so a month-name form would hard-code English into a
 * framework meant to be re-skinned. This function is the single seam to change
 * if a deployment wants something friendlier.
 *
 * "Today" / "Yesterday" are deliberately not used: they are true only while the
 * page is open, and a transcript left open overnight then lies.
 */
export function formatDayLabel(day: string): string {
  return day;
}

/**
 * For each timestamp, the separator that must be rendered immediately BEFORE
 * its turn, or `null` for no separator. The returned array is always the same
 * length as `timestamps`, index for index.
 *
 * The rules, all of which are boundary cases and all of which are covered in
 * `day-separator.spec.ts`:
 *
 * - FR1 — a separator precedes the first turn of a calendar day when a turn
 *   from an earlier day precedes it.
 * - FR2 — the FIRST turn never carries one. There is nothing above it to
 *   separate from, and a rule at the top of a conversation reads as a missing
 *   heading rather than as a break.
 * - FR3 — a second turn on the same day does not repeat it.
 * - FR4 — an undated turn does NOT break the run. It is skipped and the
 *   comparison looks PAST it to the previous DATED turn, so one undated row
 *   cannot split a day in two. (This is the rule "group by day" gets wrong, and
 *   getting it wrong looks like data corruption, not like a layout bug.)
 * - FR5 — an unparseable timestamp is treated exactly as a missing one.
 * - FR6 — a run of only undated turns produces no separator at all: there is no
 *   day to announce.
 *
 * Pure: no side effects, no DOM, no service calls.
 */
export function daySeparatorsFor(
  timestamps: readonly (Date | string | null | undefined)[],
): (DaySeparator | null)[] {
  const out: (DaySeparator | null)[] = [];
  // The last day we actually SAW. Undated turns leave it untouched — that is
  // FR4, and it is also what makes FR6 fall out for free (it never gets set,
  // so no comparison can ever fire).
  let previousDay: string | null = null;

  for (const timestamp of timestamps) {
    const day = localDayKey(timestamp);

    if (day === null) {
      // FR4 / FR5 / FR6 — an undated turn carries no separator and does not
      // advance the run.
      out.push(null);
      continue;
    }

    if (previousDay === null) {
      // FR2 — nothing dated above this turn, so there is nothing to separate.
      // Covers both the true first turn and a leading run of undated ones.
      out.push(null);
    } else if (day !== previousDay) {
      // FR1 — the calendar day changed.
      out.push({ day, label: formatDayLabel(day) });
    } else {
      // FR3 — same day, already announced.
      out.push(null);
    }

    previousDay = day;
  }

  return out;
}
