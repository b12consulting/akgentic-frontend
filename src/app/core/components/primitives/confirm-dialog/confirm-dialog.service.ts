import { Injectable, signal } from '@angular/core';

/**
 * What a confirmation asks, in the user's language.
 *
 * ALREADY-TRANSLATED text, never keys — the `IconButtonComponent` rule, for the
 * same reason: the message routinely carries a name (a team's), and the caller
 * owns its i18n.
 */
export interface ConfirmRequest {
  header: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  /** `danger` draws the confirm button in the palette's destructive tone. */
  tone?: 'default' | 'danger';
  /**
   * Where focus goes when the dialog closes. Defaults to whatever held focus
   * when `confirm` was called — right for a button, wrong for a popup menu
   * item that is gone by the time the dialog closes, which is what this is for.
   */
  returnFocus?: HTMLElement | null;
}

/** The request on screen, with the resolver its answer settles. */
export interface OpenConfirm {
  request: ConfirmRequest;
  resolve: (confirmed: boolean) => void;
  returnFocus: HTMLElement | null;
}

/**
 * The app's ONE confirmation dialog, as a promise.
 *
 * Every caller awaits `confirm(...)` and acts only on `true`. The dialog itself
 * (`ConfirmDialogComponent`) is mounted once at the root and renders whatever
 * `current` holds, so two call sites asking the same question cannot drift into
 * two different dialogs.
 *
 * ONE AT A TIME. A second request settles the first as cancelled rather than
 * queueing behind it: the first question was asked about a screen the user has
 * since moved on from, and answering it later would act on a stale intent.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmDialogService {
  private readonly open = signal<OpenConfirm | null>(null);

  /** The request on screen, or `null` when nothing is being asked. */
  readonly current = this.open.asReadonly();

  /** Ask. Resolves `true` on confirm, `false` on every other way out. */
  confirm(request: ConfirmRequest): Promise<boolean> {
    this.settle(false);
    const active = document.activeElement;
    const returnFocus =
      request.returnFocus ?? (active instanceof HTMLElement ? active : null);
    return new Promise<boolean>((resolve) => {
      this.open.set({ request, resolve, returnFocus });
    });
  }

  /**
   * Answer the open request and hand focus back. A no-op when nothing is open,
   * so a double click on a button cannot answer twice.
   *
   * Focus is returned only to an element still in the document: a delete
   * removes the row its trigger lived in, and focusing a detached node is
   * silently nothing, which is what the browser would do anyway.
   */
  settle(confirmed: boolean): void {
    const open = this.open();
    if (open === null) {
      return;
    }
    this.open.set(null);
    open.resolve(confirmed);
    if (open.returnFocus?.isConnected) {
      open.returnFocus.focus();
    }
  }
}
