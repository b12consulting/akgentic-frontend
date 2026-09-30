import { inject, Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

import { ConfirmDialogService } from '../../core/components/primitives/confirm-dialog/confirm-dialog.service';

/**
 * The question asked before a team is deleted.
 *
 * ONE question for both places a team can be deleted — the rail's row menu and
 * the teams list — so the two cannot drift into different wording or a
 * different default. Deleting is irreversible: the server stops the team and
 * purges its events and its own workspace.
 */
@Injectable({ providedIn: 'root' })
export class TeamDeleteConfirmService {
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly translate = inject(TranslateService);

  /**
   * Resolves `true` only when the user pressed Delete.
   *
   * `name` is the team's display name, as the caller shows it. `returnFocus`
   * is for a trigger that will not survive the dialog — see `ConfirmRequest`.
   */
  ask(name: string, returnFocus?: HTMLElement | null): Promise<boolean> {
    return this.confirmDialog.confirm({
      header: this.translate.instant('team.deleteConfirm.title'),
      message: this.translate.instant('team.deleteConfirm.message', { name }),
      confirmLabel: this.translate.instant('team.deleteConfirm.confirm'),
      cancelLabel: this.translate.instant('common.cancel'),
      tone: 'danger',
      returnFocus,
    });
  }
}
