import { Injectable } from '@angular/core';
import { Toast } from 'primeng/toast';

/**
 * Story 31-5: removes ONE on-screen notification toast, addressed by the
 * `data.messageId` that `IngestionService.showNotificationToast` stamps on it.
 *
 * It exists because PrimeNG has no such operation. `MessageService` is add-only
 * plus `clear(key)`, and `clear` nulls a whole container rather than one
 * message: against the app's single keyless `<p-toast>` (`app.component.html`)
 * `clear()` would take the disconnect toast and every sibling warning with it,
 * while `clear('some-key')` matches no container and removes nothing. Keying
 * the messages instead is not an escape — `Toast.canAdd` admits a message only
 * when the mount's key equals the message's, so a keyed message never renders
 * at all (pinned by `app.component.spec.ts`).
 *
 * What remains is the container's own `messages` array. Both it and the
 * change-detector are published API (`Toast.messages`, `BaseComponent.cd`), and
 * splicing one entry out is precisely what PrimeNG itself does in
 * `Toast.onMessageClose` when the user clicks the close cross. This service
 * does the same for a dismissal that arrives over the wire instead.
 *
 * `AppComponent` owns the mount and registers it here. `IngestionService` is
 * component-scoped under `ProcessComponent`, so a root service is the only
 * place the two can meet.
 *
 * Two things to know before changing this:
 *
 *   - `Toast.messages` is typed in PrimeNG's shipped `.d.ts` but is NOT an
 *     `@Input()` — it is public state rather than a documented API. That is
 *     tolerable only because both ways it could break are LOUD: a rename or a
 *     retype (PrimeNG's move to signals, say) is a compile error, and a splice
 *     that stopped reaching the DOM turns the real-mount specs below red.
 *   - Splicing bypasses `messagesArchieve`, which PrimeNG only consults when
 *     `preventDuplicates` is set. The mount does not set it; if it ever does, a
 *     warning that was dismissed and then re-raised identically would be
 *     swallowed as a duplicate.
 */
@Injectable({ providedIn: 'root' })
export class NotificationToastService {
  private toast: Toast | null = null;

  /**
   * Called by `AppComponent` once its `<p-toast>` view child resolves, and
   * again with `null` on destroy so a torn-down mount is never spliced.
   */
  register(toast: Toast | null): void {
    this.toast = toast;
  }

  /**
   * Remove the toast raised for `messageId`, if one is still on screen.
   *
   * A no-op when no toast matches: the round-tripped `ClosedNotification` for a
   * toast the user just closed by hand arrives here after PrimeNG has already
   * spliced it, and must neither throw nor disturb its neighbours. Only the
   * matching entry is removed — the disconnect toast and sibling notifications
   * are left exactly as they were, including their close state and position.
   *
   * The splice is deliberately NOT routed through `Toast.onMessageClose`: that
   * path emits the `(onClose)` binding `AppComponent` POSTs a
   * `ClosedNotification` from, so a closure arriving off the wire would answer
   * the server's echo with another one.
   */
  dismiss(messageId: string): void {
    const messages = this.toast?.messages;
    if (!messages) return;
    const index = messages.findIndex(
      (m) =>
        (m.data as { messageId?: string } | undefined)?.messageId === messageId,
    );
    if (index === -1) return;
    messages.splice(index, 1);
    // `Toast` is OnPush: an external splice is invisible until it is marked.
    this.toast?.cd.markForCheck();
  }
}
