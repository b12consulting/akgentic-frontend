import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { MessageService } from 'primeng/api';

import { ApiService } from '../../../core/http/api.service';
import { HttpError, NetworkError } from '../../../core/http/fetch.service';
import { ApiKeyRecord } from '../../../protocol/api-key.interface';
import {
  ApiKeyListComponent,
  NEVER_EXPIRES_LABEL,
  NO_ROLES_PLACEHOLDER,
} from './api-key-list.component';
import { CREATE_DISABLED_REASON } from './api-key.model';

/**
 * Story 36-5 — the API-keys pane and the three answers it must keep apart.
 *
 * THE POINT OF THIS FILE. `GET /auth/apikeys` is not mounted on any tier
 * today, and never will be on the community tier, so a local click-through can
 * only ever reach the UNAVAILABLE state. Every other state — the table, the
 * empty state, the error state — exists solely in these specs, and every claim
 * about them is theirs to make.
 *
 * The two failures being guarded against are directional, so each needs its
 * own spec: `unavailable` rendering like `empty` tells the operator "you have
 * no keys" when the route never answered, and `unavailable` swallowing `error`
 * hides an outage behind a sentence claiming the feature is not offered here.
 * A single "not the table" assertion catches neither.
 *
 * The toast counts are half the value of these specs. A state assertion alone
 * would pass with a stray toast still firing over it — which is exactly the
 * contradiction (a red "Request failed: Not Found" beside "not available on
 * this deployment") that `notifyOnError` was added to remove.
 *
 * Fixture dates are far from the present (2020 / 2999) so no spec depends on
 * clock mocking or on when it is run. Names are `acme` / `contoso`
 * placeholders; they are incidental.
 */

/** Every state hook the template can render — absence is asserted on all of them. */
const STATE_HOOKS = [
  'api-keys-loading',
  'api-keys-unavailable',
  'api-keys-load-failed',
  'api-keys-empty',
  'api-keys-table',
] as const;

function key(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    key_id: 'ak-acme-1',
    owner_id: 'u-acme',
    owner_email: 'operator@acme.test',
    roles: ['admin'],
    expiration: null,
    created_at: '2026-01-05T09:00:00Z',
    ...overrides,
  };
}

describe('ApiKeyListComponent (Story 36-5)', () => {
  let fixture: ComponentFixture<ApiKeyListComponent>;
  let apiSpy: jasmine.SpyObj<ApiService>;
  let messageSpy: jasmine.SpyObj<MessageService>;

  beforeEach(async () => {
    apiSpy = jasmine.createSpyObj<ApiService>('ApiService', [
      'getApiKeys',
      'getNamespaces',
      'getEntries',
    ]);
    apiSpy.getApiKeys.and.returnValue(Promise.resolve([]));
    messageSpy = jasmine.createSpyObj<MessageService>('MessageService', ['add']);

    // Mounted NORMALLY — no CUSTOM_ELEMENTS_SCHEMA. Absence assertions are
    // worthless in a schema-suppressed fixture, and absence is most of what
    // this suite claims.
    await TestBed.configureTestingModule({
      imports: [ApiKeyListComponent, NoopAnimationsModule],
      providers: [
        { provide: ApiService, useValue: apiSpy },
        { provide: MessageService, useValue: messageSpy },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ApiKeyListComponent);
  });

  /** Mount and let the initial load settle — `ngOnInit` starts an async call. */
  async function render(): Promise<void> {
    fixture.detectChanges();
    await settle();
  }

  async function settle(): Promise<void> {
    await fixture.whenStable();
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    fixture.detectChanges();
  }

  function byTest(value: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-test="${value}"]`);
  }

  /** Assert exactly one state hook is in the DOM — the others are absent. */
  function expectOnlyState(present: (typeof STATE_HOOKS)[number]): void {
    for (const hook of STATE_HOOKS) {
      if (hook === present) {
        expect(byTest(hook)).withContext(`${hook} present`).not.toBeNull();
      } else {
        expect(byTest(hook)).withContext(`${hook} absent`).toBeNull();
      }
    }
  }

  describe('one request, no capability probing (AC 4)', () => {
    it('issues exactly one getApiKeys call and no other ApiService method', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key()]));

      await render();

      // The response to the list call IS the signal. A HEAD, a feature
      // endpoint or a config toggle would be a second contract to keep in sync
      // with the first, and would still have to be believed over the answer.
      expect(apiSpy.getApiKeys).toHaveBeenCalledTimes(1);
      expect(apiSpy.getNamespaces).not.toHaveBeenCalled();
      expect(apiSpy.getEntries).not.toHaveBeenCalled();
    });

    it('re-issues exactly one call when Retry is pressed, and nothing else', async () => {
      apiSpy.getApiKeys.and.returnValue(
        Promise.reject(new HttpError('Boom', 500, null)),
      );

      await render();
      apiSpy.getApiKeys.calls.reset();
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key()]));

      (byTest('api-keys-retry-btn') as HTMLButtonElement).click();
      await settle();

      expect(apiSpy.getApiKeys).toHaveBeenCalledTimes(1);
      expectOnlyState('api-keys-table');
    });
  });

  describe('200 with rows -> the table (AC 8)', () => {
    it('renders the table, and no empty or unavailable text anywhere in the DOM', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key()]));

      await render();

      expectOnlyState('api-keys-table');
      expect(fixture.nativeElement.textContent).not.toContain(
        'not available on this deployment',
      );
      expect(fixture.nativeElement.textContent).not.toContain('No API keys yet');
      expect(messageSpy.add).toHaveBeenCalledTimes(0);
    });

    it('offers the create control, disabled with its reason (AC 16)', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key()]));

      await render();

      const btn = byTest('api-key-create-btn') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      // Present but visibly not yet usable — 36-6 enables it. The reason rides
      // on `title` because a disabled button fires no mouse events.
      expect(btn.disabled).toBeTrue();
      // The REASON, not merely some title: a disabled control with an empty or
      // placeholder tooltip is the silently-inert button AC 16 rules out, and
      // `toBeTruthy()` would have passed for any string at all.
      expect(btn.getAttribute('title')).toBe(CREATE_DISABLED_REASON);
    });
  });

  describe('200 with [] -> "No API keys yet" (AC 9)', () => {
    it('renders the empty state WITH the create control, and raises no toast', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([]));

      await render();

      expectOnlyState('api-keys-empty');
      expect(byTest('api-keys-empty')?.textContent).toContain('No API keys yet');
      // The route answered, so creating a key is a reasonable thing to offer.
      expect(byTest('api-key-create-btn')).not.toBeNull();
      expect(messageSpy.add).toHaveBeenCalledTimes(0);
      // AC 4 covers EVERY state, not just the populated one.
      expect(apiSpy.getApiKeys).toHaveBeenCalledTimes(1);
    });
  });

  describe('404 / 501 -> unavailable, and NOT empty (AC 9)', () => {
    for (const status of [404, 501]) {
      it(`renders the unavailable state on ${status}, with NO create control and NO toast`, async () => {
        apiSpy.getApiKeys.and.returnValue(
          Promise.reject(new HttpError('Request failed: Not Found', status, null)),
        );

        await render();

        expectOnlyState('api-keys-unavailable');
        expect(byTest('api-keys-unavailable')?.textContent).toContain(
          'API keys are not available on this deployment',
        );
        // ABSENT from the DOM, not merely disabled — the two are different
        // claims, and only absence says "there is nothing to offer here".
        expect(byTest('api-key-create-btn')).toBeNull();
        // "This deployment does not offer the feature" is not a failure to
        // report. A toast here would contradict the sentence beside it.
        expect(messageSpy.add).toHaveBeenCalledTimes(0);
        // AC 4 pinned WHERE IT MATTERS MOST: this is the state a capability
        // probe would be bolted onto — a HEAD or a feature endpoint to
        // "confirm" the route is really absent. One call, still, and the
        // answer already in hand is the only signal.
        expect(apiSpy.getApiKeys).toHaveBeenCalledTimes(1);
        expect(apiSpy.getNamespaces).not.toHaveBeenCalled();
        expect(apiSpy.getEntries).not.toHaveBeenCalled();
      });
    }

    it('501 is treated identically to 404 — the pair is the whole absent set', async () => {
      // Pinned as a pair because some deployments answer an unmounted route
      // with 501. Collapsing this to 404 alone reddens the 501 spec above.
      apiSpy.getApiKeys.and.returnValue(
        Promise.reject(new HttpError('Not Implemented', 501, null)),
      );

      await render();

      expect(byTest('api-keys-unavailable')).not.toBeNull();
      expect(byTest('api-keys-empty')).toBeNull();
    });
  });

  describe('a 500 is an ERROR, not the unavailable state (AC 10)', () => {
    it('renders the error state, hides the unavailable text and the create control, and toasts once', async () => {
      apiSpy.getApiKeys.and.returnValue(
        Promise.reject(
          new HttpError('Request failed: Internal Server Error', 500, null),
        ),
      );

      await render();

      expectOnlyState('api-keys-load-failed');
      // The failure this direction guards: an outage dressed up as a missing
      // feature is an outage nobody investigates.
      expect(fixture.nativeElement.textContent).not.toContain(
        'not available on this deployment',
      );
      expect(byTest('api-key-create-btn')).toBeNull();
      expect(byTest('api-keys-retry-btn')).not.toBeNull();
      // `getApiKeys` opted out of FetchService's toast, so this one is not a
      // double-report — it is the only report.
      expect(messageSpy.add).toHaveBeenCalledTimes(1);
      expect(messageSpy.add.calls.first().args[0].severity).toBe('error');
    });

    it('carries the server message into the error state', async () => {
      apiSpy.getApiKeys.and.returnValue(
        Promise.reject(new HttpError('Upstream vault is down', 500, null)),
      );

      await render();

      expect(byTest('api-keys-error-message')?.textContent).toContain(
        'Upstream vault is down',
      );
      expect(messageSpy.add.calls.first().args[0].summary).toBe(
        'Upstream vault is down',
      );
    });

    for (const status of [401, 403]) {
      it(`treats ${status} as an error, not as "not available on this deployment"`, async () => {
        apiSpy.getApiKeys.and.returnValue(
          Promise.reject(new HttpError('Denied', status, null)),
        );

        await render();

        // On a tier that mounts the route but denies THIS caller, "not
        // available on this deployment" is false — the pane would be inventing
        // an explanation the server did not give.
        expectOnlyState('api-keys-load-failed');
        expect(messageSpy.add).toHaveBeenCalledTimes(1);
      });
    }
  });

  describe('a NetworkError is an error too (AC 11)', () => {
    it('renders the error state, not the unavailable one, and stays silent', async () => {
      apiSpy.getApiKeys.and.returnValue(
        Promise.reject(new NetworkError('Server unreachable.')),
      );

      await render();

      // A NetworkError carries NO `status` by design, so a bare `err.status`
      // read would be `undefined` and land here by accident. The branch checks
      // `instanceof HttpError` first so it is right on purpose.
      expectOnlyState('api-keys-load-failed');
      expect(byTest('api-key-create-btn')).toBeNull();
      // FetchService toasts network failures itself — this component adds none.
      expect(messageSpy.add).toHaveBeenCalledTimes(0);
    });
  });

  describe('the loading state is its own state (AC 8-11)', () => {
    it('shows loading, and no other state, before the call resolves', () => {
      let resolveCall: (keys: ApiKeyRecord[]) => void = () => undefined;
      apiSpy.getApiKeys.and.returnValue(
        new Promise<ApiKeyRecord[]>((resolve) => {
          resolveCall = resolve;
        }),
      );

      fixture.detectChanges();

      expectOnlyState('api-keys-loading');
      resolveCall([]);
    });
  });

  describe('the table (AC 12, 13, 14)', () => {
    it('renders five columns in order: key, owner, roles, created, expiry', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key()]));

      await render();

      const headers = Array.from(
        fixture.nativeElement.querySelectorAll('th'),
      ).map((th) => (th as HTMLElement).textContent?.trim());
      expect(headers).toEqual(['Key', 'Owner', 'Roles', 'Created', 'Expiry']);
    });

    it('renders owner_email, falling back to owner_id when the email is blank', async () => {
      apiSpy.getApiKeys.and.returnValue(
        Promise.resolve([
          key({ key_id: 'ak-1', owner_email: 'operator@acme.test' }),
          // A machine identity carries no email; a blank owner cell is not an
          // answer, so the id stands in.
          key({ key_id: 'ak-2', owner_id: 'contoso-svc', owner_email: '   ' }),
        ]),
      );

      await render();

      expect(byTest('api-key-owner-ak-1')?.textContent).toContain(
        'operator@acme.test',
      );
      expect(byTest('api-key-owner-ak-2')?.textContent).toContain('contoso-svc');
    });

    it('renders a placeholder for an empty roles array, never an empty cell', async () => {
      apiSpy.getApiKeys.and.returnValue(
        Promise.resolve([
          key({ key_id: 'ak-1', roles: ['admin', 'operator'] }),
          key({ key_id: 'ak-2', roles: [] }),
        ]),
      );

      await render();

      expect(byTest('api-key-roles-ak-1')?.textContent).toContain(
        'admin, operator',
      );
      expect(byTest('api-key-roles-ak-2')?.textContent?.trim()).toBe(
        NO_ROLES_PLACEHOLDER,
      );
    });

    it('renders created_at through the DatePipe', async () => {
      apiSpy.getApiKeys.and.returnValue(
        Promise.resolve([key({ key_id: 'ak-1', created_at: '2026-01-05T09:00:00Z' })]),
      );

      await render();

      const text = byTest('api-key-created-ak-1')?.textContent ?? '';
      // Formatted, not the raw ISO string.
      expect(text).not.toContain('2026-01-05T09:00:00Z');
      expect(text).toContain('2026');
    });

    it('renders the WORD "never" for a null expiration, not an empty cell', async () => {
      apiSpy.getApiKeys.and.returnValue(
        Promise.resolve([key({ key_id: 'ak-1', expiration: null })]),
      );

      await render();

      // An empty cell would read as missing data; the truth is a key with no
      // expiry, and that is a fact worth stating.
      expect(byTest('api-key-expiry-ak-1')?.textContent?.trim()).toBe(
        NEVER_EXPIRES_LABEL,
      );
      expect(byTest('api-key-expired-ak-1')).toBeNull();
    });

    it('marks an expired key and leaves a live one unmarked', async () => {
      apiSpy.getApiKeys.and.returnValue(
        Promise.resolve([
          key({ key_id: 'ak-past', expiration: '2020-03-01T00:00:00Z' }),
          key({ key_id: 'ak-future', expiration: '2999-03-01T00:00:00Z' }),
        ]),
      );

      await render();

      // Present/absent on the DOM, not a CSS class — and the dates sit far
      // enough from now that no clock mocking is needed.
      expect(byTest('api-key-expired-ak-past')).not.toBeNull();
      expect(byTest('api-key-expired-ak-future')).toBeNull();
      // The expired row still shows its date; the marker is beside it.
      expect(byTest('api-key-expiry-ak-past')?.textContent).toContain('2020');
    });
  });

  describe('no secret material is rendered (AC 1, 16)', () => {
    it('renders nothing from a stray secret-bearing field on the record', async () => {
      // The list response is `ApiKeyRecord` by contract and carries no secret.
      // If a server ever leaked one, the pane must still not paint it.
      const leaky = {
        ...key({ key_id: 'ak-1' }),
        key_hash: 'hash-must-not-render',
        plaintext_key: 'sk-must-not-render',
      } as ApiKeyRecord;
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([leaky]));

      await render();

      const text = fixture.nativeElement.textContent as string;
      expect(text).not.toContain('hash-must-not-render');
      expect(text).not.toContain('sk-must-not-render');
    });
  });
});
