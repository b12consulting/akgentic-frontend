import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  HostListener,
  OnInit,
  ViewChild,
  inject,
} from '@angular/core';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';

import { ApiService } from '../../../core/http/api.service';
import { HttpError, NetworkError } from '../../../core/http/fetch.service';
import {
  ApiKeyRecord,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
} from '../../../protocol/api-key.interface';
import { ApiKeyCreateDialogComponent } from './api-key-create.dialog';
import { ApiKeyRevealComponent } from './api-key-reveal.component';
import { ApiKeyPaneState, ENDPOINT_ABSENT_STATUSES } from './api-key.model';

/** Shown when the roles array is empty — a blank cell would read as unknown. */
export const NO_ROLES_PLACEHOLDER = '—';

/** Shown for `expiration === null`: a key with no expiry, stated in words. */
export const NEVER_EXPIRES_LABEL = 'never';

/**
 * The single write in flight, or `idle`. ONE field for all three operations,
 * so Submit, Rotate, Revoke and Proceed can never disagree about whether the
 * pane is busy.
 */
export type ApiKeyWritePhase = 'idle' | 'creating' | 'rotating' | 'revoking';

/**
 * Project a secret-bearing response down to the row shape — BY ALLOWLIST.
 *
 * The six fields are named explicitly, and that is the point: an unknown field
 * on a DTO that carries a plaintext key must be DROPPED by default, never
 * carried through. A rest-destructure (`const { plaintext_key: _, ...row }`)
 * would keep whatever the server adds next — including a second piece of secret
 * material — and would look correct while doing it.
 *
 * (This is deliberately the opposite of the persisted-model rule, which forbids
 * enumerating fields because a field added later is silently lost. Here losing
 * it is the desired behaviour: the value being projected is a secret, and the
 * projection is a boundary, not a round trip.)
 */
export function toRecord(response: CreateApiKeyResponse): ApiKeyRecord {
  return {
    key_id: response.key_id,
    owner_id: response.owner_id,
    owner_email: response.owner_email,
    roles: response.roles,
    expiration: response.expiration,
    created_at: response.created_at,
  };
}

/**
 * The admin area's API-keys pane (ADR-028 §D7, FR15–FR18).
 *
 * THE READ SIDE (Story 36-5) is that three answers stay three answers:
 *
 *   200 with rows -> the table
 *   200 with []   -> "No API keys yet", and the create control
 *   404 or 501    -> "API keys are not available on this deployment", and NO
 *                    create control, and no toast
 *
 * An empty table rendered for a route that is not mounted asserts "you have no
 * keys" when the truth is "this deployment cannot tell you". One layer down, a
 * 500 must NOT reach the unavailable state either: an outage dressed up as a
 * missing feature is how an incident goes unnoticed. 401/403 stay errors for
 * the same reason.
 *
 * THE WRITE SIDE (Story 36-6) is one secret and where it must not go. Create
 * and rotate both answer with `CreateApiKeyResponse`, the only DTO that ever
 * carries a plaintext key, and it carries it exactly once. The plaintext lives
 * in ONE property here (`revealPlaintext`), is bound into ONE component, and is
 * cleared by ONE method (`dismissReveal`) that every dismissal channel routes
 * through — the reveal's Done, the dialog's X, the mask, and Escape. A second
 * way to close the panel would be a way for the value to survive the panel.
 *
 * Everything stored from that response goes through `toRecord`, so the row in
 * `keys[]` cannot carry the secret even by accident. Nothing here logs a
 * response.
 *
 * ONE WRITER. `phase` guards create, rotate and revoke together, and each
 * operation clears it in a `finally` around the whole call. The TypeScript
 * early return is the actual gate: a `[disabled]` attribute does not stop a
 * keyboard-driven activation (epic 33's lesson).
 *
 * ONE ESCAPE HANDLER. PrimeNG registers `closeOnEscape` as a document-level
 * listener PER DIALOG, so the three dialogs here would each answer the same
 * keystroke. All three set `[closeOnEscape]="false"` and `onEscape` decides.
 *
 * NONE OF THIS IS VERIFIABLE LOCALLY. The three routes exist on department and
 * enterprise, but the community tier mounts no `/auth/**` at all, so a local
 * click-through renders the unavailable state and no create control to press.
 * The specs are the only evidence — which is why the absence assertions after
 * dismissal, and not the presence of the value while shown, are the ones that
 * carry the weight.
 */
@Component({
  selector: 'app-admin-api-key-list',
  standalone: true,
  imports: [
    CommonModule,
    ButtonModule,
    DialogModule,
    TableModule,
    TagModule,
    ApiKeyCreateDialogComponent,
    ApiKeyRevealComponent,
  ],
  templateUrl: './api-key-list.component.html',
  styleUrls: ['./api-key-list.component.scss'],
})
export class ApiKeyListComponent implements OnInit {
  readonly #api = inject(ApiService);
  readonly #messages = inject(MessageService);

  readonly noRolesPlaceholder = NO_ROLES_PLACEHOLDER;
  readonly neverExpiresLabel = NEVER_EXPIRES_LABEL;

  /** The ONE field the template switches on — states cannot overlap. */
  state: ApiKeyPaneState = 'loading';

  keys: ApiKeyRecord[] = [];

  /** The server's own message, shown in the error state alongside the retry. */
  errorMessage = '';

  /** The single writer for create / rotate / revoke. */
  phase: ApiKeyWritePhase = 'idle';

  createDialogVisible = false;

  /**
   * THE ONLY PROPERTY THAT EVER HOLDS THE PLAINTEXT, seeded `null` and set back
   * to `null` by `dismissReveal()` alone. The reveal is `*ngIf`'d on it, so
   * clearing it destroys the component that renders it rather than leaving a
   * hidden node still holding the value.
   */
  revealPlaintext: string | null = null;

  /** The non-secret identifier shown beside the value. */
  revealKeyId = '';

  /** The row awaiting revoke confirmation; `null` when the dialog is closed. */
  pendingRevoke: ApiKeyRecord | null = null;

  /** Proceed, so the confirmation can take focus when it mounts. */
  @ViewChild('revokeProceedBtn')
  private revokeProceedBtn?: ElementRef<HTMLButtonElement>;

  ngOnInit(): void {
    void this.loadKeys();
  }

  /**
   * The ONE path that loads keys — `ngOnInit` and the retry control both come
   * through here, so the branch below can never differ between them.
   *
   * The `instanceof HttpError` check is written that way ON PURPOSE, not for
   * style. `NetworkError` deliberately carries no `status`, so a bare
   * `err.status` read would be `undefined` and fall through to the error
   * branch by accident — correct today, and quietly wrong the day a third
   * failure mode arrives with a `status` of its own.
   */
  async loadKeys(): Promise<void> {
    this.state = 'loading';
    this.errorMessage = '';
    try {
      const keys = await this.#api.getApiKeys();
      this.keys = keys;
      this.state = keys.length === 0 ? 'empty' : 'rows';
    } catch (err) {
      this.keys = [];
      if (err instanceof HttpError && ENDPOINT_ABSENT_STATUSES.includes(err.status)) {
        // Silent BY DESIGN: "this deployment does not offer the feature" is
        // not a failure to report to the user. `getApiKeys` opted out of
        // FetchService's toast precisely so this branch can say nothing.
        this.state = 'unavailable';
        return;
      }
      // Everything else IS a failure and gets the error state, with the retry.
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.state = 'error';
      // The toast is ours ONLY where FetchService did not raise one. It always
      // raises on a NetworkError — `notifyOnError` covers the non-OK branch
      // and deliberately not the transport one — so toasting here as well
      // would report an unreachable server twice.
      if (!(err instanceof NetworkError)) {
        this.#messages.add({ severity: 'error', summary: this.errorMessage });
      }
    }
  }

  /** True while any write is in flight — every dismissal channel reads this. */
  get isWriteInFlight(): boolean {
    return this.phase !== 'idle';
  }

  // --- Create ---------------------------------------------------------------

  onCreateClick(): void {
    this.createDialogVisible = true;
  }

  /**
   * The X, and Cancel. NOT the mask: `dismissableMask` is left at PrimeNG's
   * `false` here on purpose, so a stray click beside a filled form does not
   * throw the operator's input away. In-flight locks this channel with the
   * others.
   */
  onCreateVisibleChange(visible: boolean): void {
    if (visible || this.isWriteInFlight) {
      return;
    }
    this.createDialogVisible = false;
  }

  /**
   * Create, then show the plaintext exactly once.
   *
   * ON SUCCESS the dialog closes BEFORE the reveal opens, so the two never
   * coexist and the reveal is unambiguously the topmost layer. The new row is
   * PROJECTED from the response and prepended — the server sorts newest-first,
   * and re-fetching would be a second request racing the panel that is already
   * on screen with data it already has.
   *
   * ON FAILURE the dialog stays open with the operator's input intact, and this
   * stays SILENT: `FetchService` has already raised the server's message
   * (create keeps the default `notifyOnError`), so a second toast here would
   * report one failure twice.
   */
  async onCreateSubmit(body: CreateApiKeyRequest): Promise<void> {
    if (this.isWriteInFlight) {
      return;
    }
    this.phase = 'creating';
    try {
      const response = await this.#api.createApiKey(body);
      this.createDialogVisible = false;
      this.keys = [toRecord(response), ...this.keys];
      this.state = 'rows';
      this.#openReveal(response);
    } catch {
      // Deliberately empty: the dialog survives with its values, and the toast
      // is not ours to raise.
    } finally {
      this.phase = 'idle';
    }
  }

  // --- Rotate ---------------------------------------------------------------

  /**
   * Rotate a key and replace its row FROM THE RESPONSE.
   *
   * The id-stability policy belongs to the store: an in-place store keeps the
   * same `key_id` and swaps the secret, a re-mint store issues a new id. So the
   * row is located by the id that was SENT and rebuilt from the id that came
   * BACK — never patched in place on the assumption that the two agree.
   *
   * The reveal is the SAME component the create flow mounts, because the server
   * answers both with the same DTO.
   */
  async onRotate(key: ApiKeyRecord): Promise<void> {
    if (this.isWriteInFlight) {
      return;
    }
    this.phase = 'rotating';
    const rotatedId = key.key_id;
    try {
      const response = await this.#api.rotateApiKey(rotatedId);
      const record = toRecord(response);
      this.keys = this.keys.map((row) =>
        row.key_id === rotatedId ? record : row,
      );
      this.#openReveal(response);
    } catch {
      // The row is untouched and FetchService has already reported it.
    } finally {
      this.phase = 'idle';
    }
  }

  // --- Revoke ---------------------------------------------------------------

  onRevokeClick(key: ApiKeyRecord): void {
    this.pendingRevoke = key;
  }

  onRevokeCancel(): void {
    this.pendingRevoke = null;
  }

  /**
   * Focus Proceed as the confirmation mounts, as the delete confirmation next
   * door does. A modal that asks a destructive question while focus is still
   * behind it leaves a keyboard operator with nothing to answer it from.
   */
  onRevokeDialogShow(): void {
    this.revokeProceedBtn?.nativeElement.focus();
  }

  /** The X, mirroring the create dialog's channel — and, like it, no mask. */
  onRevokeVisibleChange(visible: boolean): void {
    if (visible || this.isWriteInFlight) {
      return;
    }
    this.pendingRevoke = null;
  }

  /**
   * Revoke the pending key, and treat a 404 as SUCCESS.
   *
   * The server documents the operation as idempotent — a missing key is fine —
   * so "already gone" is the outcome the operator asked for, not a failure.
   * Painting a red "Request failed: Not Found" over a row that just correctly
   * disappeared would be the pane contradicting itself, which is why
   * `revokeApiKey` opts out of the generic toast and this method owns every
   * branch instead.
   *
   * Any other rejection leaves the row exactly where it was and raises exactly
   * one toast — except a `NetworkError`, where `FetchService` has already
   * spoken and a second report would blame the server twice.
   */
  async onRevokeProceed(): Promise<void> {
    const pending = this.pendingRevoke;
    if (pending === null || this.isWriteInFlight) {
      return;
    }
    this.phase = 'revoking';
    try {
      await this.#api.revokeApiKey(pending.key_id);
      this.#removeRow(pending.key_id);
    } catch (err) {
      this.#handleRevokeFailure(err, pending.key_id);
    } finally {
      this.phase = 'idle';
      this.pendingRevoke = null;
    }
  }

  #handleRevokeFailure(err: unknown, keyId: string): void {
    if (err instanceof HttpError && err.status === 404) {
      // Idempotent success: the key is gone, which is what was asked for.
      this.#removeRow(keyId);
      return;
    }
    if (err instanceof NetworkError) {
      // FetchService always toasts the transport branch; staying silent here
      // is what keeps an unreachable server from being reported twice.
      return;
    }
    this.#messages.add({
      severity: 'error',
      summary: err instanceof Error ? err.message : String(err),
    });
  }

  #removeRow(keyId: string): void {
    this.keys = this.keys.filter((row) => row.key_id !== keyId);
    if (this.keys.length === 0) {
      this.state = 'empty';
    }
  }

  // --- The one-time reveal --------------------------------------------------

  /**
   * The ONLY place the plaintext is ever written. Private on purpose: every
   * other path into the reveal would be another chance to store the value
   * somewhere first.
   */
  #openReveal(response: CreateApiKeyResponse): void {
    this.revealKeyId = response.key_id;
    this.revealPlaintext = response.plaintext_key;
  }

  /**
   * THE ONLY WAY THE REVEAL CLOSES. Done, the X, the mask and Escape all call
   * this, so there is no dismissal path that leaves the plaintext behind.
   */
  dismissReveal(): void {
    this.revealPlaintext = null;
    this.revealKeyId = '';
  }

  /** The X and the mask on the reveal dialog — routed to the one clearing method. */
  onRevealVisibleChange(visible: boolean): void {
    if (visible) {
      return;
    }
    this.dismissReveal();
  }

  // --- The coordinated Escape handler ---------------------------------------

  /**
   * THE Escape handler for this pane — one keystroke, exactly one action.
   *
   * It must be DOCUMENT-level. PrimeNG teleports each dialog to `<body>` as a
   * sibling overlay, so a keydown inside one does not bubble through this
   * pane's element tree. For the same reason PrimeNG's own `closeOnEscape` is
   * off on all three dialogs: it registers ONE document listener PER DIALOG, so
   * an inner dialog calling `stopPropagation()` cannot stop an outer one's
   * listener — they are siblings on `document`, not parent and child.
   *
   * Priority order, first match wins:
   *   1. a write is in flight → NOTHING. All dismissal channels lock together.
   *   2. the reveal is open → `dismissReveal()`, which CLEARS THE PLAINTEXT.
   *      Wiring this branch to a visibility flag instead is precisely how the
   *      secret would survive the panel.
   *   3. the revoke confirmation is open → cancel it, issue no request.
   *   4. the create dialog is open → close it.
   *   5. nothing open → nothing.
   *
   * Branch 4 is not reachable today: the create dialog closes before the reveal
   * opens, so the two never coexist. It is ordered anyway — that makes the
   * handler total rather than accidentally correct, and costs one `if`.
   */
  @HostListener('document:keydown.escape', ['$event'])
  onEscape(event: Event): void {
    if (this.isWriteInFlight) {
      return;
    }
    if (this.revealPlaintext !== null) {
      this.dismissReveal();
      event.preventDefault();
      return;
    }
    if (this.pendingRevoke !== null) {
      this.onRevokeCancel();
      event.preventDefault();
      return;
    }
    if (this.createDialogVisible) {
      this.createDialogVisible = false;
      event.preventDefault();
    }
  }

  // --- Cell rendering -------------------------------------------------------

  /** `owner_email`, falling back to `owner_id` — a machine identity has none. */
  ownerLabel(key: ApiKeyRecord): string {
    const email = key.owner_email?.trim() ?? '';
    return email === '' ? key.owner_id : email;
  }

  /** The roles, joined; `—` for none, because a blank cell reads as unknown. */
  rolesLabel(key: ApiKeyRecord): string {
    return key.roles.length === 0
      ? NO_ROLES_PLACEHOLDER
      : key.roles.join(', ');
  }

  /**
   * Whether this key's expiry has passed, computed at render time against
   * `Date.now()` — nothing is cached, so a pane left open does not go stale.
   *
   * A `null` expiration never expires, and an unparseable date is NOT reported
   * as expired: claiming a key is dead on the strength of a value we could not
   * read is the more damaging of the two mistakes.
   */
  isExpired(key: ApiKeyRecord): boolean {
    if (key.expiration === null) {
      return false;
    }
    const at = Date.parse(key.expiration);
    return !Number.isNaN(at) && at < Date.now();
  }
}
