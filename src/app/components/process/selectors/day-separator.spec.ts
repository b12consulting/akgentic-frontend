import {
  DaySeparator,
  daySeparatorsFor,
  formatDayLabel,
  localDayKey,
} from './day-separator';

/**
 * Every fixture date is built from LOCAL components (`new Date(y, m, d, h)`),
 * so these specs assert the same thing in every time zone the suite might run
 * in. Where a test is specifically about the local-vs-UTC choice it says so.
 */
function at(
  year: number,
  month1: number,
  day: number,
  hour = 12,
  minute = 0,
): Date {
  return new Date(year, month1 - 1, day, hour, minute, 0, 0);
}

/** Convenience: the day strings of a separator run, `null` for "no rule". */
function days(seps: (DaySeparator | null)[]): (string | null)[] {
  return seps.map((s) => (s === null ? null : s.day));
}

describe('localDayKey', () => {
  it('formats the local calendar day zero-padded (FR7)', () => {
    expect(localDayKey(at(2026, 8, 27))).toBe('2026-08-27');
    expect(localDayKey(at(2026, 1, 5))).toBe('2026-01-05');
    expect(localDayKey(at(999, 12, 31))).toBe('0999-12-31');
  });

  it('compares on the LOCAL calendar, not on UTC (T2)', () => {
    // Half an hour either side of local midnight. A UTC-based key would put
    // both on the same day in every zone east of Greenwich, which is the bug
    // that only shows up when someone works late.
    expect(localDayKey(at(2026, 8, 27, 23, 30))).toBe('2026-08-27');
    expect(localDayKey(at(2026, 8, 28, 0, 30))).toBe('2026-08-28');
  });

  it('reads an ISO string through the reader s local clock', () => {
    const iso = '2026-08-27T23:30:00Z';
    const local = new Date(iso);
    const expected =
      local.getFullYear() +
      '-' +
      String(local.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(local.getDate()).padStart(2, '0');
    expect(localDayKey(iso)).toBe(expected);
  });

  it('returns null for a missing timestamp', () => {
    expect(localDayKey(null)).toBeNull();
    expect(localDayKey(undefined)).toBeNull();
    expect(localDayKey('')).toBeNull();
  });

  it('returns null for an unparseable timestamp instead of throwing (FR5)', () => {
    expect(() => localDayKey('not a date')).not.toThrow();
    expect(localDayKey('not a date')).toBeNull();
    // What `new Date(<garbage>)` leaves on a ChatMessage.timestamp.
    expect(localDayKey(new Date('nonsense'))).toBeNull();
    expect(localDayKey(new Date(NaN))).toBeNull();
  });
});

describe('formatDayLabel', () => {
  it('labels the day with its zero-padded, unambiguous calendar date (FR7)', () => {
    expect(formatDayLabel('2026-08-27')).toBe('2026-08-27');
    expect(formatDayLabel('2026-01-05')).toBe('2026-01-05');
  });

  it('never says Today or Yesterday', () => {
    const label = formatDayLabel(localDayKey(new Date()) as string);
    expect(label.toLowerCase()).not.toContain('today');
    expect(label.toLowerCase()).not.toContain('yesterday');
  });
});

describe('daySeparatorsFor', () => {
  it('returns one entry per turn, in order', () => {
    expect(daySeparatorsFor([])).toEqual([]);
    expect(daySeparatorsFor([at(2026, 8, 27)]).length).toBe(1);
    expect(daySeparatorsFor([at(2026, 8, 27), at(2026, 8, 28)]).length).toBe(2);
  });

  it('inserts a separator before the first turn of a new day (FR1)', () => {
    const seps = daySeparatorsFor([
      at(2026, 8, 27, 9),
      at(2026, 8, 28, 9),
      at(2026, 8, 29, 9),
    ]);
    expect(days(seps)).toEqual([null, '2026-08-28', '2026-08-29']);
  });

  it('carries the label on the separator (FR7)', () => {
    const seps = daySeparatorsFor([at(2026, 8, 27), at(2026, 8, 28)]);
    expect(seps[1]).toEqual({ day: '2026-08-28', label: '2026-08-28' });
  });

  it('never puts a separator above the FIRST turn (FR2)', () => {
    expect(days(daySeparatorsFor([at(2026, 8, 27)]))).toEqual([null]);
    expect(
      days(daySeparatorsFor([at(2026, 8, 27, 9), at(2026, 8, 27, 17)])),
    ).toEqual([null, null]);
  });

  it('does not repeat the separator for a second turn on the same day (FR3)', () => {
    const seps = daySeparatorsFor([
      at(2026, 8, 27, 9),
      at(2026, 8, 28, 9),
      at(2026, 8, 28, 10),
      at(2026, 8, 28, 23),
    ]);
    expect(days(seps)).toEqual([null, '2026-08-28', null, null]);
  });

  it('separates two turns an hour apart across local midnight', () => {
    const seps = daySeparatorsFor([at(2026, 8, 27, 23, 30), at(2026, 8, 28, 0, 30)]);
    expect(days(seps)).toEqual([null, '2026-08-28']);
  });

  it('does not separate two turns 23 hours apart on the same day', () => {
    const seps = daySeparatorsFor([at(2026, 8, 27, 0, 30), at(2026, 8, 27, 23, 30)]);
    expect(days(seps)).toEqual([null, null]);
  });

  // --- FR4: the rule "group by day" gets wrong -------------------------------

  it('looks PAST an undated turn to the previous dated one (FR4)', () => {
    // Three turns, all on the same day, with an undated one in the middle. A
    // naive implementation resets on the undated row and emits a separator for
    // the third — splitting one day in two, which reads as data corruption.
    const seps = daySeparatorsFor([at(2026, 8, 27, 9), null, at(2026, 8, 27, 11)]);
    expect(days(seps)).toEqual([null, null, null]);
  });

  it('still separates across a day boundary that spans an undated turn (FR4)', () => {
    const seps = daySeparatorsFor([at(2026, 8, 27, 23), null, at(2026, 8, 28, 1)]);
    expect(days(seps)).toEqual([null, null, '2026-08-28']);
  });

  it('looks past a RUN of undated turns (FR4)', () => {
    const seps = daySeparatorsFor([
      at(2026, 8, 27, 9),
      null,
      undefined,
      new Date(NaN),
      at(2026, 8, 27, 15),
    ]);
    expect(days(seps)).toEqual([null, null, null, null, null]);
  });

  it('never puts a separator on the undated turn itself (FR4)', () => {
    const seps = daySeparatorsFor([at(2026, 8, 27), null, at(2026, 8, 29)]);
    expect(seps[1]).toBeNull();
    expect(days(seps)).toEqual([null, null, '2026-08-29']);
  });

  it('treats an unparseable timestamp exactly as a missing one (FR5)', () => {
    const parseable = daySeparatorsFor([at(2026, 8, 27), null, at(2026, 8, 28)]);
    const unparseable = daySeparatorsFor([
      at(2026, 8, 27),
      'not a date',
      at(2026, 8, 28),
    ]);
    expect(days(unparseable)).toEqual(days(parseable));
  });

  it('emits no separator at all for a run of only undated turns (FR6)', () => {
    const seps = daySeparatorsFor([null, undefined, 'not a date', new Date(NaN)]);
    expect(days(seps)).toEqual([null, null, null, null]);
  });

  it('emits nothing for undated turns LEADING the transcript (FR2 + FR6)', () => {
    // The first dated turn is still the first thing with a day, so it gets no
    // rule — there is nothing dated above it to separate from.
    const seps = daySeparatorsFor([null, null, at(2026, 8, 27), at(2026, 8, 28)]);
    expect(days(seps)).toEqual([null, null, null, '2026-08-28']);
  });

  it('emits nothing for undated turns TRAILING the transcript', () => {
    const seps = daySeparatorsFor([at(2026, 8, 27), null, null]);
    expect(days(seps)).toEqual([null, null, null]);
  });

  it('gives the separator a day identity that is stable across re-emission (T4)', () => {
    const first = daySeparatorsFor([at(2026, 8, 27, 9), at(2026, 8, 28, 9)]);
    const second = daySeparatorsFor([
      at(2026, 8, 27, 9),
      at(2026, 8, 28, 9),
      at(2026, 8, 28, 10),
    ]);
    // The transcript re-emits constantly; the separator's key must not move
    // when a turn is appended below it.
    expect(second[1]?.day).toBe(first[1]?.day as string);
  });

  it('marks a boundary that lands between two turns that both collapse (T3)', () => {
    // Collapsed rows are ordinary siblings in the flat list, so the boundary is
    // reported exactly as it would be between two expanded turns. The caller
    // does not special-case it.
    const seps = daySeparatorsFor([at(2026, 8, 27, 23, 50), at(2026, 8, 28, 0, 5)]);
    expect(days(seps)).toEqual([null, '2026-08-28']);
  });

  it('does not mutate its input', () => {
    const input = [at(2026, 8, 27), at(2026, 8, 28)];
    const copy = input.map((d) => d.getTime());
    daySeparatorsFor(input);
    expect(input.map((d) => d.getTime())).toEqual(copy);
  });
});
