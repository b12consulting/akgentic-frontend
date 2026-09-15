import { inject, Injectable } from '@angular/core';

import { MessageService } from 'primeng/api';

/**
 * `ConnectionToast` — the disconnect-warning REACTOR (Epic 34 / ADR-025 §0-§1).
 * It owns the whole of the WebSocket-disconnect toast: its payload, its
 * one-per-cycle deduplication, and its suppression during teardown.
 *
 * A SEPARATE class from the notification-toast surface, and that separateness
 * is the deliverable rather than a side effect. The two toast systems carry
 * DELIBERATELY OPPOSITE `closable` semantics — this one sets `closable: false`
 * because a connection warning must not be dismissable, while a notification
 * omits `closable` because it needs PrimeNG's default close cross. While both
 * lived in `IngestionService` the only thing keeping them apart was a docblock
 * at each site asking the next reader not to copy the other, written after the
 * confusion had already bitten once. Two classes in two files make it
 * structurally impossible instead, which is why the split is pinned by specs
 * (`connection-toast.spec.ts`) and not by this paragraph.
 *
 * Unrelated to `core/ui/notification-toast.service.ts` despite the neighbouring
 * name: that one REMOVES a single already-rendered toast (story 31-5), an
 * operation PrimeNG's `MessageService` does not offer. Nothing is shared with
 * it, nor with the notification toast — no base class, no helper, no payload
 * builder, no constant. Sharing anything would re-open the copy-paste trap.
 *
 * A reactor that HOLDS STATE, which the epic's review test otherwise forbids
 * ("if a unit needs to remember something, it is a projection"). That test
 * targets DOMAIN state. Both flags below are TRANSPORT state: whether the socket
 * dropped, and whether this view is being torn down. Neither is derived from the
 * message log and no fold over it could produce either, even in principle — the
 * same sanctioned exemption `LoadingIndicator` holds for its arrival-timing
 * state. A reactor holding domain state stays a defect.
 *
 * Nothing is self-wired: the constructor subscribes to nothing and raises
 * nothing (ADR-025 §2, restating ADR-005 §Decision 6). `start()` / `show()` /
 * `stop()` are the explicit invocation points, all three driven by
 * `IngestionService`. Wiring this unit to a `TeamSocket` status stream instead
 * of the two push call sites is story 34-6, not this one.
 *
 * `messageService.clear()` is deliberately ABSENT here (and must stay absent):
 * `clear()` empties the whole keyless `<p-toast>` container, notification toasts
 * included, so it belongs to `IngestionService`'s lifecycle sequencing rather
 * than to either toast unit.
 *
 * Component-scoped (`@Injectable()` with no `providedIn`), provided on
 * `ProcessComponent` before `IngestionService`, which injects it. Root scope
 * would be wrong even though the unit holds no per-team domain state: its dedup
 * flag is per-team-cycle, and a root instance would outlive the very team switch
 * `start()` resets it for.
 */
@Injectable()
export class ConnectionToast {
  private readonly messageService: MessageService = inject(MessageService);

  /**
   * Story 8-2 (AC3): deduplication flag — prevents stacking duplicate
   * disconnect toasts when both the WS `error` and the WS `complete` handler
   * fire in sequence, which is the ordinary shape of a dropped socket rather
   * than an edge case.
   *
   * Reset by `start()` (per team cycle) and by `stop()`, never anywhere else.
   */
  private wsDisconnectToastShown = false;

  /**
   * True from `stop()` onward — suppresses the toast on intentional navigation,
   * where `IngestionService.ngOnDestroy()`'s `webSocket.unsubscribe()` closes
   * the socket and the resulting `complete` re-enters `show()`.
   *
   * One-way by design: nothing sets it back to `false`, matching the flag it
   * replaces. A component-scoped service is never re-initialised after its
   * component is destroyed, so there is no path that would need it cleared. If a
   * future story ever re-inits after destroy this becomes a live bug — it is not
   * one today.
   */
  private destroying = false;

  /**
   * Arm the unit for a fresh team cycle. Resets ONLY the dedup flag, so a prior
   * team's disconnect cannot suppress this cycle's warning; the destroying flag
   * is deliberately untouched (see its docblock).
   *
   * Called from `IngestionService.init()` at exactly the point the inline flag
   * reset used to sit.
   */
  start(): void {
    this.wsDisconnectToastShown = false;
  }

  /**
   * Story 8-2 (AC1, AC2, AC3): raise the persistent, non-closable warning toast
   * for a lost WebSocket. Called from the WS `error` handler and the WS
   * `complete` handler — the two of them, and nothing else, are why the dedup
   * flag exists.
   *
   * The payload is exact and load-bearing in both directions: `closable: false`
   * because this warning must not be dismissable, and NO `life` (any value
   * silently defeats `sticky: true`) and NO `key` (the app mounts a single
   * keyless `<p-toast>`, and PrimeNG drops a keyed message against it).
   */
  show(): void {
    if (this.wsDisconnectToastShown || this.destroying) return;
    this.wsDisconnectToastShown = true;
    this.messageService.add({
      severity: 'warn',
      summary: 'Connection Lost',
      detail: 'Real-time connection to the server has been lost. Updates are paused.',
      sticky: true,
      closable: false,
    });
  }

  /**
   * Enter the destroying state and re-arm the dedup flag.
   *
   * Called FIRST in `IngestionService.ngOnDestroy()`, ahead of the
   * `webSocket.unsubscribe()` — the unsubscribe closes the socket, whose
   * `complete` reaches `show()`, so reordering the two raises a "Connection
   * Lost" toast on every intentional navigation.
   */
  stop(): void {
    this.destroying = true;
    this.wsDisconnectToastShown = false;
  }
}
