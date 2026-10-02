import { LOCALE_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { formatTeamWhen, TeamWhenPipe } from './team-when';

/**
 * `now` is PASSED, never read from the clock: the same-day branch is the one
 * thing here that a wall clock would make flaky, and the whole reason the
 * helper takes it as a parameter.
 */
const NOW = new Date('2026-04-19T12:00:00');

/** 16:35 on NOW's local calendar day. Built locally, so it holds in any zone. */
function sameDayAt1635(): string {
  const d = new Date(NOW);
  d.setHours(16, 35, 0, 0);
  return d.toISOString();
}

describe('formatTeamWhen', () => {
  it('renders a clock time for a stamp on the same local day as now', () => {
    const when = formatTeamWhen(sameDayAt1635(), 'en-US', NOW);

    // A clock time has a colon; a day-and-month never does.
    expect(when).toContain(':');
  });

  it('renders a day-and-month for a stamp on another day', () => {
    const when = formatTeamWhen('2020-04-19T10:00:00Z', 'en-US', NOW);

    expect(when).toMatch(/\d/);
    expect(when).not.toContain(':');
  });

  it('decides same-day on the LOCAL calendar, not on 24 hours', () => {
    // Same calendar day as NOW but twelve hours apart in either direction:
    // still a clock time. The question is "which day?", not "how long ago?".
    const earlyMorning = new Date(NOW);
    earlyMorning.setHours(0, 5, 0, 0);
    const lateEvening = new Date(NOW);
    lateEvening.setHours(23, 55, 0, 0);

    expect(formatTeamWhen(earlyMorning.toISOString(), 'en-US', NOW)).toContain(':');
    expect(formatTeamWhen(lateEvening.toISOString(), 'en-US', NOW)).toContain(':');
  });

  it('returns an empty string for every flavour of "no stamp"', () => {
    expect(formatTeamWhen('', 'en-US', NOW)).toBe('');
    expect(formatTeamWhen(null, 'en-US', NOW)).toBe('');
    expect(formatTeamWhen(undefined, 'en-US', NOW)).toBe('');
  });

  it('returns an empty string for an unparseable stamp rather than throwing', () => {
    // A server that sent something unparseable should not blank the row.
    expect(formatTeamWhen('not-a-date', 'en-US', NOW)).toBe('');
  });

  it('defaults `now` to the clock, so callers need not pass it', () => {
    const today = new Date();
    today.setHours(16, 35, 0, 0);

    expect(formatTeamWhen(today.toISOString(), 'en-US')).toContain(':');
    expect(formatTeamWhen('2020-04-19T10:00:00Z', 'en-US')).not.toContain(':');
  });
});

describe('TeamWhenPipe', () => {
  let pipe: TeamWhenPipe;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [TeamWhenPipe, { provide: LOCALE_ID, useValue: 'en-US' }],
    });
    pipe = TestBed.inject(TeamWhenPipe);
  });

  it('is the function, with the injected locale', () => {
    const iso = '2020-04-19T10:00:00Z';

    expect(pipe.transform(iso)).toBe(formatTeamWhen(iso, 'en-US'));
    expect(pipe.transform(iso)).not.toBe('');
  });

  it('passes the empty cases straight through', () => {
    expect(pipe.transform(null)).toBe('');
    expect(pipe.transform(undefined)).toBe('');
    expect(pipe.transform('')).toBe('');
  });
});
