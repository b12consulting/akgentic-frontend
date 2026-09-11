import {
  greetableNameOf,
  greetingKeyFor,
  greetingPartFor,
} from './greeting';

/**
 * NO FIXTURE, NO CLOCK, NO `TestBed`.
 *
 * Every case below names the instant it is about. That is the entire point of
 * the module being pure: a suite run at 23:59 in CI exercises the same six
 * boundaries as a suite run at 09:00, where a component reading `new Date()`
 * would exercise whichever branch the build agent happened to be in and would
 * report a pass either way.
 */

/** A local-time instant. Month is 0-based; the date itself never matters. */
function at(hour: number, minute = 0): Date {
  return new Date(2026, 8, 11, hour, minute, 0, 0);
}

describe('greetingPartFor', () => {
  it('reads midnight as morning', () => {
    expect(greetingPartFor(at(0, 0))).toBe('morning');
  });

  it('holds morning to the last minute before noon', () => {
    expect(greetingPartFor(at(11, 59))).toBe('morning');
  });

  it('turns to afternoon exactly at noon', () => {
    // The boundary is inclusive at the LOWER end: 12:00 is afternoon, not the
    // last minute of morning. Stated as a case because an off-by-one here is
    // invisible for 23 hours a day.
    expect(greetingPartFor(at(12, 0))).toBe('afternoon');
  });

  it('holds afternoon to the last minute before six', () => {
    expect(greetingPartFor(at(17, 59))).toBe('afternoon');
  });

  it('turns to evening exactly at six', () => {
    expect(greetingPartFor(at(18, 0))).toBe('evening');
  });

  it('is still evening at the last minute of the day', () => {
    // There is no fourth "night" band, so late evening must not fall through
    // to morning — which is what a `hour < 12` test written last would do.
    expect(greetingPartFor(at(23, 59))).toBe('evening');
  });

  it('reads local hours, not UTC', () => {
    // The same assertion `day-separator.ts` makes about its own boundary: the
    // question is about the reader's wall clock. Constructed from local parts
    // so this passes in every zone the suite might run in — a UTC-based
    // implementation would disagree with it wherever the offset is non-zero.
    const local = new Date(2026, 8, 11, 9, 0, 0, 0);
    expect(local.getHours()).toBe(9);
    expect(greetingPartFor(local)).toBe('morning');
  });

  it('falls back to morning rather than throwing on an unusable clock', () => {
    // Decoration must not be able to abort a page render. No caller here can
    // produce this, and that is why it is asserted rather than assumed.
    expect(greetingPartFor(new Date('not a date'))).toBe('morning');
  });
});

describe('greetingKeyFor', () => {
  it('picks the addressed sentence when there is somebody to name', () => {
    expect(greetingKeyFor(at(9), true)).toBe('home.greeting.morningNamed');
    expect(greetingKeyFor(at(14), true)).toBe('home.greeting.afternoonNamed');
    expect(greetingKeyFor(at(20), true)).toBe('home.greeting.eveningNamed');
  });

  it('picks the name-less sentence otherwise', () => {
    // NOT the addressed key with an empty parameter: that renders the trailing
    // punctuation of a sentence whose subject never arrived.
    expect(greetingKeyFor(at(9), false)).toBe('home.greeting.morning');
    expect(greetingKeyFor(at(14), false)).toBe('home.greeting.afternoon');
    expect(greetingKeyFor(at(20), false)).toBe('home.greeting.evening');
  });
});

describe('greetableNameOf', () => {
  it('names a signed-in user', () => {
    expect(greetableNameOf({ user_id: 'u-1', name: 'Ada Lovelace' })).toBe(
      'Ada Lovelace',
    );
  });

  it('refuses the anonymous sentinel even though it carries a name', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. `AuthService` seeds the anonymous
    // session with the untranslated English literal 'Anonymous'; greeting it
    // by that name puts bare copy on screen past ngx-translate, where neither
    // locale-parity nor the usage audit can see it — and on a community-tier
    // deployment that is the session most users have.
    expect(
      greetableNameOf({ user_id: 'anonymous', name: 'Anonymous' }),
    ).toBeNull();
  });

  it('treats no user at all as nobody to name', () => {
    expect(greetableNameOf(null)).toBeNull();
    expect(greetableNameOf(undefined)).toBeNull();
  });

  it('treats a blank or whitespace name as nobody to name', () => {
    // `null`, not `''`: an empty string is falsy AND printable, which is the
    // combination that ships "Good morning, ".
    expect(greetableNameOf({ user_id: 'u-1', name: '' })).toBeNull();
    expect(greetableNameOf({ user_id: 'u-1', name: '   ' })).toBeNull();
    expect(greetableNameOf({ user_id: 'u-1' })).toBeNull();
  });

  it('trims a name rather than printing its padding', () => {
    expect(greetableNameOf({ user_id: 'u-1', name: '  Grace  ' })).toBe('Grace');
  });
});
