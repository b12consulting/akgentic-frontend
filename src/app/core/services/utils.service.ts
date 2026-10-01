import { Injectable, inject } from '@angular/core';
import { Clipboard } from '@angular/cdk/clipboard';
import { NOTIFICATION_PORT } from '../platform/notification/notification.port';
import { TranslateService } from '@ngx-translate/core';

@Injectable({
  providedIn: 'root',
})
export class UtilService {
  clipboard: Clipboard = inject(Clipboard);
  private notifications = inject(NOTIFICATION_PORT);
  private translate: TranslateService = inject(TranslateService);

  formatJSON(
    content: string | boolean | number | { [key: string]: any }
  ): string {
    if (typeof content === 'object') {
      return JSON.stringify(content, null, 2);
    }
    return content.toString();
  }

  /**
   * Copy `content` and say so.
   *
   * The confirmation is a KEY. It shipped as the literal
   * `'Content copied to the clipbaord'` — hardcoded, English, and misspelled —
   * which is the failure mode neither i18n guard can catch: `locale-parity`
   * compares the two locale files to each other and the usage audit greps for
   * declared keys, so a string that never became a key is invisible to both. A
   * French session read the English typo and nothing went red.
   *
   * `instant` rather than the pipe because there is no template here; the
   * locale is loaded by an APP_INITIALIZER long before any copy control can be
   * clicked, so the synchronous read is safe at this call site.
   */
  copyToClipboard(content: string) {
    this.clipboard.copy(content);
    this.notifications.notify({
      severity: 'success',
      summary: this.translate.instant('common.copiedToClipboard'),
    });
  }
}
