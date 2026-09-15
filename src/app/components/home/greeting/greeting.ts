/**
 * The teams page's greeting, decided without a component fixture.
 *
 * Everything here is a pure function over values the caller supplies — a clock
 * and a user — so the two decisions that would otherwise be untestable become
 * ordinary assertions: WHICH part of the day it is, and WHETHER there is
 * anybody to name. This follows `process/selectors/day-separator.ts`, which
 * exists for the same reason and states it the same way: time is pushed out of
 * the component and taken as an argument.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `new Date()` IN THE COMPONENT
 * ---------------------------------------------------------------------------
 * `rail-team-row.component.ts` reads the wall clock inline, and its spec pays
 * for it: it builds timestamps relative to `Date.now()` and can only assert
 * loose shapes, because the value under test moves while the suite runs. A
 * greeting is worse — its answer changes at three points in the day, so a suite
 * run at 23:59 in CI would exercise one branch and a suite run at 09:00 would
 * exercise another, and neither run would say so. The clock is read ONCE, in
 * `HomeGreetingComponent`, into an input a spec can set.
 *
 * ---------------------------------------------------------------------------
 * LOCAL, NOT UTC
 * ---------------------------------------------------------------------------
 * `getHours()`, the reader's own wall clock — the same call and the same
 * argument as `day-separator.ts`. "Good morning" is a claim about the person
 * reading it, not about the server.
 */

/** Which third of the day a greeting belongs to. */
export type GreetingPart = 'morning' | 'afternoon' | 'evening';

/**
 * The greeting keys, written out as literals.
 *
 * TWO MAPS, NOT ONE KEY WITH AN OPTIONAL PARAMETER. "Good morning, {{name}}"
 * with an empty name renders a trailing comma, and the punctuation that joins a
 * salutation to a name is not the same in every language — French sets no comma
 * at all in some registers, and a language that puts the name first cannot be
 * served by appending. Two keys let a translator write two sentences.
 *
 * LITERALS RATHER THAN A TEMPLATE STRING. `tools/i18n-usage-audit.mjs` greps
 * `src/**` for each declared key and fails on one it cannot find; a
 * runtime-composed `` `home.greeting.${part}` `` would need an entry in that
 * tool's COMPOSED_PREFIXES allow-list. Writing the six out costs six lines and
 * keeps the audit honest for free.
 */
const GREETING_KEYS: Readonly<Record<GreetingPart, string>> = {
  morning: 'home.greeting.morning',
  afternoon: 'home.greeting.afternoon',
  evening: 'home.greeting.evening',
};

const GREETING_KEYS_NAMED: Readonly<Record<GreetingPart, string>> = {
  morning: 'home.greeting.morningNamed',
  afternoon: 'home.greeting.afternoonNamed',
  evening: 'home.greeting.eveningNamed',
};

/**
 * The part of the day `now` falls in.
 *
 * The boundaries are 12:00 and 18:00 — midday and the end of the working
 * afternoon — so morning runs 00:00–11:59, afternoon 12:00–17:59 and evening
 * 18:00–23:59. There is no fourth "night" band: the console is a working tool,
 * and a greeting that changes again at 22:00 buys nothing a reader would
 * notice while adding a boundary to get wrong.
 *
 * A clock that is not a usable date reads as morning rather than throwing. The
 * case does not arise from any caller here — the only clocks are `new Date()`
 * and a spec's own fixture — but a greeting is decoration, and decoration that
 * can abort a page render is a worse bug than decoration that is wrong. Same
 * argument `localDayKey` makes for returning `null` on a malformed timestamp.
 */
export function greetingPartFor(now: Date): GreetingPart {
  const hour = now.getHours();
  if (!Number.isFinite(hour) || hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

/**
 * The translation key for `now`, addressed or not.
 *
 * `named` rather than the name itself: this module decides which SENTENCE is
 * wanted, and the name is a parameter the template threads through
 * `TranslatePipe`. Passing the name in here would tempt a caller into
 * concatenating a translated string with it, which is how a salutation ends up
 * hard-coding English word order.
 */
export function greetingKeyFor(now: Date, named: boolean): string {
  const part = greetingPartFor(now);
  return named ? GREETING_KEYS_NAMED[part] : GREETING_KEYS[part];
}

/** The shape `AuthService.currentUser$` is read through. It is typed `any`. */
export interface GreetableUser {
  readonly name?: string;
  readonly user_id?: string;
}

/**
 * The name to greet, or `null` when there is nobody to name.
 *
 * THE ANONYMOUS SENTINEL IS MATCHED ON `user_id`, NEVER ON THE NAME. This is
 * the rule `rail-footer.component.ts` states and for the identical reason:
 * `AuthService` seeds an anonymous session with the untranslated English
 * literal `'Anonymous'` as its `name`, so a greeting that tested the name would
 * print "Good morning, Anonymous" — bare copy, past ngx-translate, which
 * neither `locale-parity.spec.ts` nor the usage audit can see because it is not
 * a key. On a community-tier deployment (`hideLogin`) anonymous is the NORMAL
 * session, not an edge case, so that string would be what most users read.
 *
 * `null` rather than `''` so the caller branches on a value it cannot
 * accidentally interpolate: an empty string is falsy AND printable, which is
 * exactly the combination that ships a dangling comma.
 */
export function greetableNameOf(user: GreetableUser | null | undefined): string | null {
  if (!user || user.user_id === 'anonymous') return null;
  const name = (user.name ?? '').trim();
  return name === '' ? null : name;
}
