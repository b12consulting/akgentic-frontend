import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { ButtonModule } from 'primeng/button';

/**
 * The one-time plaintext reveal (Story 36-6, ADR-028 §D7).
 *
 * ONE COMPONENT, TWO FLOWS. Create and rotate answer with the same DTO
 * (`CreateApiKeyResponse`), so both mount THIS component. A second reveal for
 * rotate would be two code paths rendering a secret, and two code paths
 * rendering a secret drift in exactly the way that matters.
 *
 * IT OWNS NOTHING. The plaintext arrives as an `@Input` and is rendered
 * straight from it — no field copies it, no timer holds it, no clipboard
 * history remembers it, and nothing here logs it. The host clears its single
 * plaintext field and the `*ngIf` around this component destroys it, taking the
 * only reference with it. That is the whole mechanism: there is no other place
 * for the value to survive.
 *
 * THE COPY CONTROL IS WRITTEN INLINE, on purpose.
 * `shared/components/copy-button` is an empty shell — a labelled `p-button`
 * with no click handler and no clipboard call — so importing it would render a
 * button that silently copies nothing, on the one screen where the value cannot
 * be recovered afterwards. Fixing that shared component is a separate change;
 * it is used elsewhere.
 *
 * `navigator.clipboard.writeText` needs a secure context (HTTPS or
 * `localhost`), which holds everywhere this pane is reachable. A rejection is
 * reported in place rather than swallowed: the value stays on screen and can be
 * selected by hand, which is the only remaining chance to keep it.
 */
@Component({
  selector: 'app-api-key-reveal',
  standalone: true,
  imports: [CommonModule, ButtonModule],
  templateUrl: './api-key-reveal.component.html',
  styleUrls: ['./api-key-reveal.component.scss'],
})
export class ApiKeyRevealComponent {
  /**
   * The plaintext key, rendered once. Bound straight into the template and to
   * the clipboard call — deliberately never copied into another field.
   */
  @Input() plaintext = '';

  /** The non-secret identifier, shown so the operator knows which key this is. */
  @Input() keyId = '';

  /**
   * Dismissal. The host's ONE clearing method is the only listener, so every
   * channel that closes this panel goes through the same line that nulls the
   * plaintext.
   */
  @Output() dismissed = new EventEmitter<void>();

  /** Copy feedback only — never the value itself. */
  copyState: 'idle' | 'copied' | 'failed' = 'idle';

  async onCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.plaintext);
      this.copyState = 'copied';
    } catch {
      // Reported in place, not logged: a console line here would put the
      // failure next to the value it is about, and consoles are kept.
      this.copyState = 'failed';
    }
  }

  onDone(): void {
    this.dismissed.emit();
  }
}
