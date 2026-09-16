import { InjectionToken } from '@angular/core';

/**
 * Story 53-1 (ADR-035 §D6.1): the data layer's only route to the toast surface.
 *
 * `core/platform/http`, `core/services/utils.service.ts` and
 * `core/services/process/event/*` used to inject PrimeNG's `MessageService`
 * directly. Five files, one shared want — somewhere to put a notification — which
 * is a PORT rather than a framework dependency. The implementation is supplied at
 * the composition root (`ui/console/notification.adapter.ts`), so nothing below
 * `ui/` names a UI framework and Epic 53's file move stays a pure rename.
 *
 * It lives in `platform` (T2) because the token must be importable from BOTH sides
 * of the data layer's DAG, and T2 is the highest tier both of them may reach:
 * `core/platform/http/fetch.service.ts` is itself `platform`, which may import only
 * `shared` and `protocol` — so the port cannot sit at T3 — while `svc-event` and
 * the rest of `core/services/**` may import `platform`. T1 `shared/` would also be
 * reachable from both, but §D1 declares that tier pure functions and pipes; a port
 * is plumbing, and it belongs beside `http/`, its closest caller.
 *
 * This paragraph used to argue instead that `core/` was a single `boundaries`
 * element, so that imports within it were unrestricted and no lint change was
 * needed. That stopped being true when the lower tiers moved: `core/` is now a
 * NAMESPACE holding four separately-typed tiers, and every edge inside it is
 * gated. The port's position is a deliberate choice under those rules rather than
 * a free one.
 *
 * The port is a SINK, not a shared payload builder. `ConnectionToast` and
 * `NotificationToasts` deliberately carry opposite `closable` semantics and share
 * nothing — no base class, no helper, no constant — because a shared builder has
 * already caused one copy-paste defect. Each unit keeps its `notify(...)` call
 * literal at its own site; this file must not grow a convenience wrapper that
 * reunites them.
 */

/**
 * The severities the app actually raises.
 *
 * A deliberate SUPERSET of the protocol's `NotificationSeverity`
 * (`error | warn | info`): `FetchService` and `UtilService` raise `'success'`,
 * which is not a wire concept. The port does not import the protocol type — a
 * `core/` unit typing its notifications by the message protocol would make "how
 * the user is told" depend on "what the server can send".
 */
export type NotificationLevel = 'success' | 'info' | 'warn' | 'error';

/**
 * One notification, as the data layer describes it.
 *
 * NOT named `Notification`, which would shadow the DOM global of that name.
 *
 * Every optional field is optional in the load-bearing sense: the adapter OMITS
 * an absent field from the payload it builds rather than passing `undefined`.
 * The distinction is not cosmetic for `closable` — PrimeNG renders its default
 * close cross when the property is absent, which is exactly what a notification
 * toast needs and exactly what a connection toast must not have.
 *
 * There is deliberately no `key` and no `life`. Both omissions are load-bearing
 * at the two call sites that document them: the app mounts a single keyless
 * `<p-toast>` and PrimeNG silently drops a keyed message against it, while any
 * `life` value defeats `sticky: true`. Absent from the interface, they cannot be
 * set by accident.
 */
export interface NotificationRequest {
  severity: NotificationLevel;
  summary: string;
  detail?: string;
  sticky?: boolean;
  closable?: boolean;
  /**
   * Per-event identity, carried through to the rendered toast so a dismissal can
   * address it later. `messageId` is what `dismiss` matches on and what the
   * console's close handler POSTs from; `teamId` rides beside it so that handler
   * can address the dismissal without reading navigation state.
   */
  data?: { messageId?: string; teamId?: string };
}

/**
 * Raise, remove one, remove all.
 *
 * THREE methods rather than the two ADR-035 §D6.1 first specified. The third is
 * `IngestionService`'s: it calls `clear()` at three lifecycle points, and its own
 * docblock records why the call belongs there rather than in either toast unit —
 * it empties the whole keyless container, both toast families at once, so it is
 * lifecycle sequencing rather than a toast unit's business. A two-method port
 * would leave that one file holding its PrimeNG import, which is the one thing
 * this story exists to remove.
 */
export interface NotificationPort {
  /** Raise one notification. */
  notify(request: NotificationRequest): void;

  /**
   * Remove ONE already-rendered notification, addressed by the `data.messageId`
   * stamped on it. A no-op when nothing matches — a closure that arrives over
   * the wire for a toast the user already closed by hand must not throw and must
   * not disturb its neighbours.
   */
  dismiss(messageId: string): void;

  /** Remove all of them, both toast families at once. */
  clear(): void;
}

export const NOTIFICATION_PORT = new InjectionToken<NotificationPort>(
  'NOTIFICATION_PORT',
);
