import { inject, Injectable } from '@angular/core';

import { Observable, Subscription } from 'rxjs';

import { MessageService } from 'primeng/api';

import { NotificationToastService } from '../../../core/ui/notification-toast.service';
import {
  AkgenticMessage,
  ErrorMessage,
  NotificationMessage,
  notificationSeverity,
  NotificationSeverity,
  WarningMessage,
} from '../../../protocol/message.types';

/**
 * Story 31-6 (FR19): the toast header of last resort, used only when BOTH parts
 * of `"{name} - {content_type}"` are absent — an orchestrator-sent notification
 * with a null `content_type`, or one whose sender never arrived.
 *
 * Deliberately NOT `MessageListComponent`'s `LEGEND_FALLBACK`, whose
 * `error → null` is correct there and wrong here: the Messages tab renders a
 * `p-fieldset` that can legitimately show an empty legend, whereas an empty
 * toast `summary` renders a blank header. The `'Error'` below is therefore not
 * the old hardcoded error-toast summary coming back — that one headed EVERY
 * error; this one is reached only when there is nothing else to say.
 */
const TOAST_FALLBACK: Record<NotificationSeverity, string> = {
  error: 'Error',
  warn: 'Warning',
  info: 'Notification',
};

/**
 * Role of the team orchestrator on `ActorAddress` (akgentic-team `factory.py` /
 * `restorer.py` set `BaseConfig(name="@Orchestrator", role="Orchestrator")`).
 * Matched on `role` and never on `name`: `role` is the domain field, while
 * `name` is a display label carrying a decorative `@` and is the one of the pair
 * that could plausibly be renamed.
 */
const ORCHESTRATOR_ROLE = 'Orchestrator';

/**
 * `NotificationToasts` — the notification-family toast REACTOR (Epic 34 /
 * ADR-025 §0-§1). It owns the whole of stories 31-3 / 31-4 / 31-5 / 31-6:
 * severity dispatch, the `"{name} - {type}"` summary, the toast payload with its
 * three load-bearing omissions, the pre-emptive closed-ids suppressor and the
 * after-the-fact removal.
 *
 * It reads the RAW, UNBATCHED inbound stream, and that is deliberate rather than
 * incidental. `IngestionService` hands `start()` its `_wsInbound$` — a plain
 * `Subject` with one producer — so this unit sees the same frames, in the same
 * order, at the same synchronous instant the inline dispatch used to run at.
 * `bufferTime(16)` lives on the LOG-FEED subscriber, never on the subject, so
 * the batching delays the log and never this fan-out. Two current behaviours
 * depend on exactly that, and both are preserved here on purpose:
 *
 *   - the closed-ids cache LAGS THE WIRE by up to one 16 ms window, because a
 *     `ClosedNotification` reaches the log only when its frame is flushed. A
 *     notification arriving in the same frame as its own closure therefore still
 *     toasts, and is taken back off the screen by `onClosedNotificationIds`.
 *   - the REPLAY ASYMMETRY survives: a stopped team's REST replay goes through
 *     `log.appendAll` and raises NO toast, while a running team's cursor-0 WS
 *     replay goes through this stream and raises one per notification. Same
 *     historical events, different behaviour, decided by the transport alone.
 *
 * Subscribing `log$`, `messageList$` or anything downstream of `bufferTime(16)`
 * would erase both at once. That is a BEHAVIOUR CHANGE (ADR-025 Open Question 1)
 * needing a product decision on its own evidence — not a tidy, and not this
 * unit's to make.
 *
 * A reactor that HOLDS STATE, which the epic's review test otherwise forbids
 * ("if a unit needs to remember something, it is a projection, not a reactor").
 * Unlike `LoadingIndicator`'s and `ConnectionToast`'s transport state, this one
 * is NOT a sanctioned exemption: `closedNotificationIds` is manifestly DOMAIN
 * state, derived from the log — `MessageLogService.closedNotificationIds$` is
 * already a fold over it. It is cached here only because the dispatch runs
 * inside a callback that cannot await an observable, and that inlining is the
 * direct cause of the 16 ms lag above. ADR-025 §0 names this the exact seam
 * where the tiers are currently smeared. This story RELOCATES that seam
 * unchanged and does not resolve it; resolving it means folding `log$`, i.e. the
 * behaviour change above.
 *
 * Nothing is self-wired: the constructor subscribes to nothing (ADR-025 §2,
 * restating ADR-005 §Decision 6). That is the concrete defect being removed —
 * the subscription this unit now opens in `start()` used to be a FIELD
 * INITIALIZER on `IngestionService`, firing during construction, which forced
 * `notificationToast` to be declared above it and made that declaration order a
 * rule the class had to explain in a comment. Both are gone with it.
 *
 * `start()` takes `Observable`s rather than reaching for a service, which is
 * what makes story 34-6 cheap: when `TeamSocket` appears, only the ARGUMENT
 * changes, never this unit.
 *
 * Component-scoped (`@Injectable()` with no `providedIn`), provided on
 * `ProcessComponent` before `IngestionService`, which injects it. Root scope
 * would carry one team's dismissal cache into the next.
 */
@Injectable()
export class NotificationToasts {
  private readonly messageService: MessageService = inject(MessageService);

  /**
   * Story 31-5: the other half of dismissal. `messageService` raises toasts;
   * this removes a single one that is already on screen — an operation PrimeNG's
   * `MessageService` does not offer.
   *
   * Named `notificationToast` (singular, no `s`) exactly as `IngestionService`
   * named it, so the migrated code reads unchanged. It is the root-scoped
   * `core/ui` service that REMOVES one toast, and not this class, which raises
   * them; the two names read almost identically at a glance and this is the only
   * file that imports both.
   */
  private readonly notificationToast: NotificationToastService = inject(
    NotificationToastService,
  );

  /**
   * Story 31-4 (AC #9): latest snapshot of `MessageLogService.closedNotificationIds$`,
   * cached synchronously because `showNotificationToast` runs inside the inbound
   * callback and cannot await an observable.
   *
   * The cache lags the wire by up to one `bufferTime(16)` window — a
   * `ClosedNotification` reaches the log only when its frame is flushed. That is
   * by design: on the live path a dismissal always precedes the next delivery of
   * that message by far more than a frame, and the replay path (where the
   * ordering genuinely bites) is story 31-5's batch computation. Do NOT close the
   * gap with a synchronous side-channel off the inbound stream — that is a
   * partial, untested version of 31-5.
   *
   * Story 31-5 kept that instruction and answered the ordering the other way
   * round: see `onClosedNotificationIds` below.
   *
   * Reset to an empty `Set` by `stop()` (AC9). Before Epic 34 this subscription
   * lived for the whole service lifetime and cleared itself on a team switch,
   * because `log.reset()` re-emits an empty set; under `start()` / `stop()` it is
   * per-cycle instead, and the two are equivalent ONLY because of that reset.
   * Without it, a replayed closure already in the previous cycle's set is no
   * longer new, so its `dismiss(...)` silently disappears.
   */
  private closedNotificationIds: Set<string> = new Set<string>();

  /**
   * Both subscriptions opened by `start()`, in one bag disposed by `stop()`.
   * `null` before the first `start()` and again after every `stop()`.
   *
   * `start()` deliberately does NOT dispose a previous bag of its own. The
   * orchestrator's `disposePriorSubscriptions()` calls `stop()`, and that call
   * is what a spec pins: a `start()` that self-disposed would make removing it
   * harmless, and a leaked second subscription would double every toast.
   */
  private subs: Subscription | null = null;

  /**
   * Open both subscriptions for one `init()` cycle.
   *
   * `closedIds$` is wired FIRST, mirroring the order the field-initializer form
   * had by construction: the cache subscribed at construction, i.e. before any
   * frame could arrive. `closedNotificationIds$` is a `BehaviorSubject`
   * derivative, so this subscription populates the cache synchronously with the
   * current set before the inbound one is even created.
   *
   * `inbound$` MUST be the raw, unbatched stream (see the class docblock).
   */
  start(
    inbound$: Observable<AkgenticMessage>,
    closedIds$: Observable<Set<string>>,
  ): void {
    const subs = new Subscription();
    subs.add(
      closedIds$.subscribe((ids: Set<string>) =>
        this.onClosedNotificationIds(ids),
      ),
    );
    subs.add(
      inbound$.subscribe((event: AkgenticMessage) => {
        // Story 31-6 (FR17): all three severities take ONE dispatch, classified
        // once through the shared `notificationSeverity`. `null` means "not a
        // notification": no toast, and no early return either — the log feed is a
        // separate subscriber of the same subject and must be unaffected either
        // way.
        //
        // The cast is what the `data: any` WS callback did implicitly before this
        // moved onto a typed stream: `notificationSeverity` returns
        // `NotificationSeverity | null` and is NOT a type guard, so a non-null
        // severity does not narrow `AkgenticMessage` for the compiler. Do not
        // "fix" that by widening the parameter below — the narrow type is what
        // stops a future edit reading `content_type` off a message that has none
        // — nor by turning `notificationSeverity` into a guard, which is shared
        // with the Messages tab and `message-log.service.ts`'s allowlist.
        const severity = notificationSeverity(event);
        if (severity) {
          this.showNotificationToast(
            event as ErrorMessage | WarningMessage | NotificationMessage,
            severity,
          );
        }
      }),
    );
    this.subs = subs;
  }

  /**
   * Dispose both subscriptions and clear the dismissal cache.
   *
   * Safe before any `start()` and safe to call twice — it is driven from BOTH
   * `IngestionService.disposePriorSubscriptions()` (per re-init cycle) and its
   * `ngOnDestroy`, so the same bag must be releasable without tearing the unit
   * down.
   *
   * The cache reset is not hygiene; it is what makes the per-cycle subscription
   * equivalent to the service-lifetime one it replaces (see
   * `closedNotificationIds`).
   */
  stop(): void {
    this.subs?.unsubscribe();
    this.subs = null;
    this.closedNotificationIds = new Set<string>();
  }

  /**
   * Story 31-5: dismissal, in the direction the 31-4 suppressor cannot cover.
   *
   * The suppressor is pre-emptive — it refuses to raise a toast for an id the
   * log already knows to be closed. That handles a `ClosedNotification` that
   * arrives FIRST. On a reload of a running team the wire delivers the opposite
   * order: history replays from cursor 0, so the `WarningMessage` (older) lands
   * before its `ClosedNotification` (newer), the toast opens, and nothing ever
   * took it down again. A warning dismissed days ago came back on every reload
   * and stayed.
   *
   * Removing the toast when the closure is folded makes the pair
   * order-independent, which is why no replay/live boundary is needed here —
   * there is none on the wire, and this design does not want one.
   *
   * Only ids that are NEW to the set trigger a removal: `closedNotificationIds$`
   * re-emits a fresh `Set` whenever the closed set changes, and re-dismissing
   * the whole set each time would be wasted work that also blunts the tests.
   */
  private onClosedNotificationIds(ids: Set<string>): void {
    const previous = this.closedNotificationIds;
    this.closedNotificationIds = ids;
    for (const id of ids) {
      if (!previous.has(id)) this.notificationToast.dismiss(id);
    }
  }

  /**
   * Story 31-6 (FR19): the toast header — `"{agent name} - {content_type}"`,
   * with either half dropped when it carries nothing.
   *
   * The name half is dropped when the sender IS the orchestrator (it raises
   * most of these, and "@Orchestrator" names nothing useful) or when no sender
   * arrived at all. The type half is dropped when `content_type` is null or
   * empty — structurally nullable upstream, and in practice always null for a
   * warning, since nothing yet gives one the "kind" an exception class name
   * gives an error.
   *
   * The `' - '` separator therefore appears ONLY between two present parts,
   * never leading or trailing; when neither survives, the per-severity
   * `TOAST_FALLBACK` heads the toast rather than a blank string.
   *
   * A pure function of its arguments (no `this` state) so it can be spec'd
   * directly, without driving a frame through the socket.
   */
  private toastSummary(
    event: ErrorMessage | WarningMessage | NotificationMessage,
    severity: NotificationSeverity,
  ): string {
    const sender = event.sender;
    const namePart =
      sender && sender.role !== ORCHESTRATOR_ROLE ? sender.name : null;
    const typePart = event.content_type || null;
    const parts = [namePart, typePart].filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join(' - ') : TOAST_FALLBACK[severity];
  }

  /**
   * Story 31-3 (FR11), widened by Story 31-6 (FR17): one permanent, closable
   * toast per member of the notification family — errors included.
   *
   * Errors reached this method by deleting the WS handler's separate
   * `life: 5000` branch, which is the whole of FR18: `data.messageId` and
   * `AppComponent.onToastClose` are type-agnostic, so an error dismissal
   * round-trips and survives a reload with no error-specific code anywhere in
   * the chain. Do not add any. The accepted cost is that error toasts no longer
   * auto-dismiss — if the resulting pile ever needs relief the answer is a
   * "dismiss all" affordance, never a `life` value, which silently defeats
   * `sticky: true`.
   *
   * `severity` is a PARAMETER, not recomputed here. It used to be
   * `isWarningMessage(event) ? 'warn' : 'info'`, correct only while the caller
   * excluded errors: once errors were admitted that expression sent every one
   * of them to `'info'` — a red error rendered as a blue info toast, with
   * nothing failing. The caller now classifies once through the shared
   * `notificationSeverity` and passes the answer down.
   *
   * Three properties are deliberately ABSENT, and each omission is
   * load-bearing — do not "complete" this object:
   *
   *   - **no `key`** — `app.component.html` mounts a single keyless
   *     `<p-toast>`, and PrimeNG admits a message only when the mount's key
   *     equals the message's (`Toast.canAdd`). A keyed message is silently
   *     dropped and never renders. Per-event identity travels in `data`
   *     instead; `Toast.add()` appends, so keyless messages already coexist
   *     rather than clobbering one another. Story 31-5 re-tested this before
   *     building removal on top of it and reached the same conclusion: a key
   *     here would buy nothing anyway, since `MessageService.clear(key)` empties
   *     a whole container rather than one message.
   *   - **no `closable`** — `ConnectionToast` sets `closable: false` on
   *     purpose; this toast is its exact opposite and needs the close cross
   *     PrimeNG renders by default. Epic 34 moved that one into its own class
   *     precisely so the two can no longer be read as variants of each other,
   *     so do not reunite them behind a shared payload builder.
   *   - **no `life`** — any value defeats `sticky: true`.
   *
   * `data.messageId` (not `id`, which PrimeNG binds to the rendered DOM `id`
   * attribute) carries the source event id; `Toast.onClose` re-emits the whole
   * message, so it survives to `AppComponent.onToastClose`. Story 31-4 added
   * `data.teamId` alongside it so that handler can address the dismissal POST
   * without reading navigation state — `event.team_id` is populated on the wire
   * by `Message.init` in `Agent._notify_orchestrator`.
   *
   * Story 31-4 also added the suppression guard below: an id already carried by
   * a `ClosedNotification` on the log raises no toast at all. It is an early
   * return HERE and not in the inbound subscriber, so the message still reaches
   * the log feed and the Messages tab — closing dismisses the popup, not the
   * historical record. Story 31-5 covers the opposite arrival order by removing
   * the toast after the fact (`onClosedNotificationIds`); `data.messageId` is
   * what addresses it, which is why that field is load-bearing and not debug
   * decoration.
   */
  private showNotificationToast(
    event: ErrorMessage | WarningMessage | NotificationMessage,
    severity: NotificationSeverity,
  ): void {
    if (this.closedNotificationIds.has(event.id)) return;
    this.messageService.add({
      severity,
      summary: this.toastSummary(event, severity),
      detail: event.content,
      sticky: true,
      data: { messageId: event.id, teamId: event.team_id },
    });
  }
}
