import { CommonModule } from '@angular/common';
import {
  Component,
  DestroyRef,
  EventEmitter,
  Input,
  Output,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';

import { AuthService } from '../../../core/auth/auth.service';
import { CreateApiKeyRequest } from '../../../protocol/api-key.interface';

/** Shown under the owner fields: minting for somebody else is deliberate. */
export const OWNER_HELPER_TEXT =
  'The key will be issued in this owner’s name. It defaults to you — change it only to mint a key for another identity.';

/**
 * The create-key form (Story 36-6, FR17). Hosted in the pane's `p-dialog`; the
 * modal chrome, the Escape contract and the in-flight lock all belong to the
 * host, so this component is the form and nothing else.
 *
 * THE OWNER FIELDS ARE READ REACTIVELY, not snapshotted. `/auth/me` resolves
 * AFTER first render, so a constructor read of `currentUserValue` leaves a
 * genuine admin looking at two blank fields — the same reasoning that makes
 * `isAdmin$` an observable rather than an eager read. A late emission
 * therefore fills them in place.
 *
 * ...but only while the operator has not typed. Once a field is edited, a
 * subsequent emission must not overwrite what was typed: the whole point of
 * editability is minting a key for another identity, and having that silently
 * reverted mid-form is worse than never pre-filling at all.
 *
 * MINTING FOR SOMEBODY ELSE IS ALLOWED AND DELIBERATE. The server takes
 * `owner_id` / `owner_email` as free-form body fields and the route is
 * admin-gated, so the capability is real (the CLI already has it). What the
 * dialog must not do is make it the path of least resistance: the caller's own
 * identity is the default, the change is an explicit edit, and the helper text
 * says whose name the key will carry. (ADR-028 §Open questions 3 records this
 * as a call not yet made; the editable form is the reversible default.)
 */
@Component({
  selector: 'app-api-key-create-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    DatePickerModule,
    InputTextModule,
  ],
  templateUrl: './api-key-create.dialog.html',
  styleUrls: ['./api-key-create.dialog.scss'],
})
export class ApiKeyCreateDialogComponent {
  readonly #auth = inject(AuthService);
  readonly #destroyRef = inject(DestroyRef);

  readonly ownerHelperText = OWNER_HELPER_TEXT;

  /**
   * True while the host's create request is in flight. Drives Submit's
   * disabled state; the TS guard in `onSubmit` is what actually stops a second
   * submit, because a disabled attribute does not gate a keyboard-driven one.
   */
  @Input() submitting = false;

  @Output() submitted = new EventEmitter<CreateApiKeyRequest>();
  @Output() cancelled = new EventEmitter<void>();

  ownerId = '';
  ownerEmail = '';
  /** Comma-separated, parsed on submit — a key with no role is a support ticket. */
  rolesText = '';
  /** `null` means "never expires", which the table renders as the word `never`. */
  expiration: Date | null = null;

  /** Set once the operator edits an owner field; freezes the pre-fill. */
  #ownerEdited = false;

  constructor() {
    this.#auth.currentUser$
      .pipe(takeUntilDestroyed(this.#destroyRef))
      .subscribe((user) => {
        if (this.#ownerEdited) {
          return;
        }
        this.ownerId = user?.user_id ?? '';
        this.ownerEmail = user?.email ?? '';
      });
  }

  onOwnerEdited(): void {
    this.#ownerEdited = true;
  }

  /** The roles as the server wants them: trimmed, blanks dropped. */
  get roles(): string[] {
    return this.rolesText
      .split(',')
      .map((role) => role.trim())
      .filter((role) => role !== '');
  }

  /**
   * A blank owner, or no role at all, is refused BEFORE the request is issued.
   * A key with no role can authenticate and do nothing — a support ticket, not
   * a feature. `owner_email` may legitimately be blank: a machine identity has
   * none, which is the same fact the table's owner-cell fallback exists for.
   */
  get canSubmit(): boolean {
    return (
      !this.submitting && this.ownerId.trim() !== '' && this.roles.length > 0
    );
  }

  onSubmit(): void {
    if (!this.canSubmit) {
      return;
    }
    this.submitted.emit({
      owner_id: this.ownerId.trim(),
      owner_email: this.ownerEmail.trim(),
      roles: this.roles,
      // ISO-8601 or `null` — no local-format string ever reaches the wire.
      expiration: this.expiration === null ? null : this.expiration.toISOString(),
    });
  }

  onCancel(): void {
    this.cancelled.emit();
  }
}
