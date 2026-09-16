import { Injectable, inject } from '@angular/core';

import { MessageService, ToastMessageOptions } from 'primeng/api';

import {
  NotificationPort,
  NotificationRequest,
} from '../../core/platform/notification/notification.port';
import { NotificationToastService } from './notification-toast.service';

/**
 * Story 53-1 (ADR-035 §D6.1): the PrimeNG side of `NOTIFICATION_PORT`, and the
 * only file this story adds that names a UI framework.
 *
 * It lives in `ui/console/` rather than in `core/`, which is the whole point:
 * `core/services/` stops importing PrimeNG, and `ui/console/` is where
 * ADR-035 §D5 sends the toast machinery this class delegates to. `app.config.ts`
 * is the composition root and is the only place outside `ui/` allowed to name a
 * `ui/` symbol (§D1), so the binding is made there and nothing below reaches up.
 *
 * Root-scoped by that provider registration: `FetchService` and `UtilService` are
 * `providedIn: 'root'` while the three event units are route-scoped on
 * `process/:id`, and a root-provided token reaches both.
 */
@Injectable()
export class PrimeNgNotificationAdapter implements NotificationPort {
  private readonly messageService: MessageService = inject(MessageService);

  /**
   * Story 31-5's single-toast remover, which is the `dismiss` half of the port.
   *
   * Delegated to rather than reimplemented: its correctness rests on details
   * recorded in that file — it splices the mount's own `messages` array and
   * deliberately bypasses `Toast.onMessageClose`, so a closure arriving off the
   * wire does not answer the server's echo with another one. A second copy of
   * that splice here would be a second thing to keep right.
   */
  private readonly notificationToast: NotificationToastService = inject(
    NotificationToastService,
  );

  /**
   * Build the PrimeNG `Message` by OMITTING absent fields, never by spreading
   * `undefined`.
   *
   * The distinction is the whole reason this method is written out longhand
   * instead of as one object literal. `{ closable: request.closable }` creates an
   * own `closable` property whose value is `undefined`, and PrimeNG's `Toast`
   * reads the property rather than testing its truthiness at every point that
   * matters — so the spread form silently changes how a notification toast
   * renders its close cross while satisfying every value-based assertion. The
   * specs pin this with `'closable' in payload`, not `toBeUndefined()`.
   *
   * `key` and `life` are never set, on any path. Both omissions are load-bearing
   * and documented at their call sites: the app mounts a single keyless
   * `<p-toast>`, and `Toast.canAdd` admits a message only when the mount's key
   * equals the message's, so a keyed message never renders at all; and any `life`
   * value defeats `sticky: true`. They are absent from `NotificationRequest` too,
   * so there is no path by which a caller could reintroduce either.
   */
  notify(request: NotificationRequest): void {
    const message: ToastMessageOptions = {
      severity: request.severity,
      summary: request.summary,
    };
    if (request.detail !== undefined) message.detail = request.detail;
    if (request.sticky !== undefined) message.sticky = request.sticky;
    if (request.closable !== undefined) message.closable = request.closable;
    if (request.data !== undefined) message.data = request.data;
    this.messageService.add(message);
  }

  /** Remove one already-rendered toast, addressed by its `data.messageId`. */
  dismiss(messageId: string): void {
    this.notificationToast.dismiss(messageId);
  }

  /**
   * Empty the whole keyless `<p-toast>` — both toast families at once, which is
   * exactly what `IngestionService`'s three lifecycle call sites mean.
   *
   * No key argument, deliberately: `clear('some-key')` matches no container and
   * removes nothing.
   */
  clear(): void {
    this.messageService.clear();
  }
}
