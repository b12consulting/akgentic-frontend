import { Injectable, signal, Signal } from '@angular/core';

/** Per-viewer storage key for the chat view choice. */
export const CHAT_VIEW_STORAGE_KEY = 'akgentic.chat.new-view';

/**
 * Which chat transcript the conversation pane shows: the legacy panel or the
 * run-tree *New view* (Epic 55, ADR-037 §D11).
 *
 * ROOT-SCOPED, like `ViewService`, because the choice belongs to the viewer and
 * not to the team: switching teams must not flip it back. The two views read
 * the same process-scoped services, so switching costs nothing and loses
 * nothing.
 *
 * The default — and the answer to an unreadable or unknown stored value — is
 * the LEGACY view. The switch goes away at parity (55-6).
 */
@Injectable({
  providedIn: 'root',
})
export class ChatViewService {
  private readonly _newView = signal<boolean>(this.read() === 'true');

  /** `true` while the run-tree view is selected. */
  readonly newView: Signal<boolean> = this._newView.asReadonly();

  toggle(): void {
    this._newView.set(!this._newView());
    this.write();
  }

  /** `localStorage` throws outright when the browser blocks storage for the
   *  origin; a refused read means "legacy". Same pattern as
   *  `pane-layout.service.ts`. */
  private read(): string | null {
    try {
      return localStorage.getItem(CHAT_VIEW_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  /** As `read`: a refused write costs the preference and nothing more. */
  private write(): void {
    try {
      localStorage.setItem(CHAT_VIEW_STORAGE_KEY, String(this._newView()));
    } catch {
      /* storage unavailable — the choice still applies for this visit */
    }
  }
}
