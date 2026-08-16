/**
 * Page-private types for the API-keys pane (Story 36-5).
 *
 * The wire DTO is NOT here — `ApiKeyRecord` lives in
 * `src/app/protocol/api-key.interface.ts` because `ApiService` imports it and
 * `core` may not reach into a page. This file holds only what the pane itself
 * renders with, and deliberately re-exports nothing from `protocol/`.
 */

/**
 * The five states the pane can be in — mutually exclusive, held in ONE field.
 *
 * The whole story is that `empty` and `unavailable` are different facts and
 * must never render alike: an empty table for a route that answered 404 tells
 * the operator "you have no keys" when the truth is "this deployment cannot
 * tell you". One layer down, `unavailable` must not swallow `error` either, or
 * a real outage hides behind a sentence claiming the feature is simply not
 * offered here.
 *
 * * `loading` — the request is in flight.
 * * `rows` — the server answered with at least one key.
 * * `empty` — the server answered, and there are genuinely no keys.
 * * `unavailable` — the route is not mounted on this deployment (404 / 501).
 * * `error` — anything else went wrong; the operator is offered a retry.
 */
export type ApiKeyPaneState =
  | 'loading'
  | 'rows'
  | 'empty'
  | 'unavailable'
  | 'error';

/**
 * The ONLY two HTTP statuses that mean "this deployment does not offer the
 * feature", named once so the two never drift apart.
 *
 * `501 Not Implemented` is treated identically to `404 Not Found` because some
 * deployments answer an unmounted route that way; both are the server saying
 * the route is not there.
 *
 * 401/403 are deliberately EXCLUDED. On a tier that mounts the route but
 * denies this caller, "not available on this deployment" is simply false, and
 * the pane would be inventing an explanation the server never gave. 500 is
 * excluded for the sharper reason: it is an outage, and dressing it up as a
 * missing feature is how an incident goes unnoticed.
 */
export const ENDPOINT_ABSENT_STATUSES: readonly number[] = [404, 501];

/**
 * The text shown while the create control cannot be used yet.
 *
 * Following this epic's established idiom (36-3's row Delete): a control that
 * is present but visibly not usable, with the reason on the native `title`,
 * rather than one that silently does nothing when clicked. Story 36-6 enables
 * it and attaches the dialog. `title` and not `pTooltip` — a disabled button
 * fires no mouse events, so a PrimeNG tooltip would be written and never read.
 */
export const CREATE_DISABLED_REASON =
  'Creating API keys is not available yet';
