import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';

import { ApiService } from '../../../core/http/api.service';
import { HttpError, NetworkError } from '../../../core/http/fetch.service';
import { ApiKeyRecord } from '../../../protocol/api-key.interface';
import {
  ApiKeyPaneState,
  CREATE_DISABLED_REASON,
  ENDPOINT_ABSENT_STATUSES,
} from './api-key.model';

/** Shown when the roles array is empty — a blank cell would read as unknown. */
export const NO_ROLES_PLACEHOLDER = '—';

/** Shown for `expiration === null`: a key with no expiry, stated in words. */
export const NEVER_EXPIRES_LABEL = 'never';

/**
 * The admin area's API-keys pane (ADR-028 §D7, FR15/FR16).
 *
 * THE POINT OF THIS COMPONENT is that three answers stay three answers:
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
 * the same reason — on a tier that mounts the route but denies this caller,
 * "not available on this deployment" is simply false, and the pane would be
 * inventing an explanation the server never gave.
 *
 * NO CAPABILITY PROBING. One `getApiKeys()` call, and its response is the
 * signal. There is no `HEAD`, no feature endpoint and no config flag — a probe
 * would be a second contract to keep in sync, and would still have to be
 * believed over the actual answer.
 *
 * NONE OF THIS IS VERIFIABLE LOCALLY. `GET /auth/apikeys` is not mounted on any
 * tier today (it ships from `akgentic-infra-auth` on its own branch) and the
 * community tier will never mount it — it resolves every caller as `anonymous`
 * with no roles, so an admin-gated route could only ever 403 there. A local
 * click-through renders the unavailable state and nothing else; the specs are
 * the only evidence for the table, the empty state and the error state.
 *
 * READ-ONLY. Create / rotate / revoke and the one-time plaintext reveal are
 * Story 36-6. The create control ships disabled with its reason on `title`,
 * following 36-3's Delete: present but visibly not yet usable, rather than
 * silently inert when clicked.
 */
@Component({
  selector: 'app-admin-api-key-list',
  standalone: true,
  imports: [CommonModule, ButtonModule, TableModule, TagModule],
  templateUrl: './api-key-list.component.html',
  styleUrls: ['./api-key-list.component.scss'],
})
export class ApiKeyListComponent implements OnInit {
  readonly #api = inject(ApiService);
  readonly #messages = inject(MessageService);

  readonly createDisabledReason = CREATE_DISABLED_REASON;
  readonly noRolesPlaceholder = NO_ROLES_PLACEHOLDER;
  readonly neverExpiresLabel = NEVER_EXPIRES_LABEL;

  /** The ONE field the template switches on — states cannot overlap. */
  state: ApiKeyPaneState = 'loading';

  keys: ApiKeyRecord[] = [];

  /** The server's own message, shown in the error state alongside the retry. */
  errorMessage = '';

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
