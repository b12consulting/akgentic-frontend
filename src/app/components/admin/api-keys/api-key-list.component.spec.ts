import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { MessageService } from 'primeng/api';
import { BehaviorSubject } from 'rxjs';

import { AuthService } from '../../../core/auth/auth.service';
import { ApiService } from '../../../core/http/api.service';
import { HttpError, NetworkError } from '../../../core/http/fetch.service';
import {
  ApiKeyRecord,
  CreateApiKeyResponse,
} from '../../../protocol/api-key.interface';
import {
  ApiKeyListComponent,
  NEVER_EXPIRES_LABEL,
  NO_ROLES_PLACEHOLDER,
  toRecord,
} from './api-key-list.component';
import { ApiKeyRevealComponent } from './api-key-reveal.component';

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

/** The one-time plaintext, distinctive enough that any stray copy is obvious. */
const SENTINEL = 'ak_testkeyid_SENTINELPLAINTEXTVALUE';

const ADMIN_USER = {
  user_id: 'u-acme',
  email: 'operator@acme.test',
  name: 'Acme Operator',
  roles: ['admin'],
};

function createdKey(
  overrides: Partial<CreateApiKeyResponse> = {},
): CreateApiKeyResponse {
  return {
    key_id: 'ak-acme-9',
    owner_id: 'u-acme',
    owner_email: 'operator@acme.test',
    roles: ['admin'],
    expiration: null,
    created_at: '2026-08-16T09:00:00Z',
    plaintext_key: SENTINEL,
    ...overrides,
  };
}

/**
 * Does `value` hold the sentinel ANYWHERE — through nested objects and arrays?
 *
 * A shallow scan would miss `keys[0].plaintext_key`, which is the single most
 * likely way this feature ships a leak (`this.keys.unshift(response)` is one
 * reasonable-looking line). Cycles are tracked because component state reaches
 * framework objects that reference themselves.
 */
function containsSentinel(
  value: unknown,
  sentinel: string,
  seen: Set<unknown> = new Set(),
): boolean {
  if (typeof value === 'string') {
    return value.includes(sentinel);
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  const children = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  return children.some((child) => containsSentinel(child, sentinel, seen));
}

describe('ApiKeyListComponent (Stories 36-5, 36-6)', () => {
  let fixture: ComponentFixture<ApiKeyListComponent>;
  let apiSpy: jasmine.SpyObj<ApiService>;
  let messageSpy: jasmine.SpyObj<MessageService>;
  let currentUser$: BehaviorSubject<unknown>;

  beforeEach(async () => {
    apiSpy = jasmine.createSpyObj<ApiService>('ApiService', [
      'getApiKeys',
      'getNamespaces',
      'getEntries',
      'createApiKey',
      'rotateApiKey',
      'revokeApiKey',
    ]);
    apiSpy.getApiKeys.and.returnValue(Promise.resolve([]));
    messageSpy = jasmine.createSpyObj<MessageService>('MessageService', ['add']);
    currentUser$ = new BehaviorSubject<unknown>(ADMIN_USER);

    // Mounted NORMALLY — no CUSTOM_ELEMENTS_SCHEMA. Absence assertions are
    // worthless in a schema-suppressed fixture, and absence is most of what
    // this suite claims.
    await TestBed.configureTestingModule({
      imports: [ApiKeyListComponent, NoopAnimationsModule],
      providers: [
        { provide: ApiService, useValue: apiSpy },
        { provide: MessageService, useValue: messageSpy },
        {
          provide: AuthService,
          useValue: { currentUser$: currentUser$.asObservable() },
        },
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

    it('offers the create control ENABLED, and it opens the dialog (36-6 AC 22)', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key()]));

      await render();

      const btn = byTest('api-key-create-btn') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      // 36-5 shipped this control disabled with a reason, and pinned the
      // reason. Story 36-6 enables it, which makes that constant dead — it was
      // deleted rather than kept alive to keep an assertion green, and this is
      // the replacement assertion.
      expect(btn.disabled).toBeFalse();
      expect(byTest('api-key-create-form')).toBeNull();

      btn.click();
      await settle();

      expect(byTest('api-key-create-form')).not.toBeNull();
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
    it('renders the columns in order: key, owner, roles, created, expiry, actions', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key()]));

      await render();

      // 36-5's five columns, unchanged and in the same order; Story 36-6 adds
      // the per-row Rotate / Revoke column at the end.
      const headers = Array.from(
        fixture.nativeElement.querySelectorAll('th'),
      ).map((th) => (th as HTMLElement).textContent?.trim());
      expect(headers).toEqual([
        'Key',
        'Owner',
        'Roles',
        'Created',
        'Expiry',
        'Actions',
      ]);
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

  // =========================================================================
  // Story 36-6 — create, rotate, revoke, and the one-time reveal.
  // =========================================================================

  /** Open the create dialog, fill the one required field, and submit. */
  async function submitCreate(roles = 'admin'): Promise<void> {
    (byTest('api-key-create-btn') as HTMLButtonElement).click();
    await settle();
    const rolesInput = byTest('api-key-create-roles') as HTMLInputElement;
    rolesInput.value = roles;
    rolesInput.dispatchEvent(new Event('input'));
    await settle();
    (byTest('api-key-create-submit-btn') as HTMLButtonElement).click();
    await settle();
  }

  async function clickRotate(keyId: string): Promise<void> {
    (byTest(`api-key-rotate-btn-${keyId}`) as HTMLButtonElement).click();
    await settle();
  }

  /** Open the revoke confirmation and press Proceed. */
  async function revoke(keyId: string): Promise<void> {
    (byTest(`api-key-revoke-btn-${keyId}`) as HTMLButtonElement).click();
    await settle();
    (byTest('api-key-revoke-proceed-btn') as HTMLButtonElement).click();
    await settle();
  }

  function pressEscape(): void {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    fixture.detectChanges();
  }

  function revealComponents(): unknown[] {
    return fixture.debugElement.queryAll(By.directive(ApiKeyRevealComponent));
  }

  /**
   * THE ASSERTION THIS STORY EXISTS FOR — taken AFTER the panel is gone, over
   * state the implementation was never asked about.
   *
   * A spec that only checked "the value is on screen" would pass on an
   * implementation that also wrote it to a service field, a component array and
   * the console. This looks in all of those places instead, and looks for the
   * value's ABSENCE.
   */
  function expectSentinelGone(consoleSpies: jasmine.Spy[]): void {
    const component = fixture.componentInstance;

    // 1. Component state, recursed — `keys[0].plaintext_key` is the leak this
    //    feature is most likely to ship.
    for (const [name, value] of Object.entries(
      component as unknown as Record<string, unknown>,
    )) {
      expect(containsSentinel(value, SENTINEL))
        .withContext(`ApiKeyListComponent.${name} holds the plaintext`)
        .toBeFalse();
    }

    // 2. The injected service. Its methods are spies, so the meaningful check
    //    is that no NON-function state was hung off it (`api.lastCreated = …`)
    //    — which is exactly the shape such a leak takes.
    for (const [name, value] of Object.entries(
      apiSpy as unknown as Record<string, unknown>,
    )) {
      if (typeof value === 'function') {
        continue;
      }
      expect(containsSentinel(value, SENTINEL))
        .withContext(`ApiService.${name} holds the plaintext`)
        .toBeFalse();
    }

    // 2b. THE OTHER SERVICE THE PANE INJECTS. A toast is a leak channel with a
    //     life of its own: `MessageService` queues the text, and the queue
    //     outlives the panel that raised it. `summary: response.plaintext_key`
    //     is one plausible line, and neither the DOM check nor the console
    //     spies below would see it — the toast renders in a `p-toast` mounted
    //     somewhere else entirely.
    for (const call of messageSpy.add.calls.all()) {
      expect(containsSentinel(call.args, SENTINEL))
        .withContext('MessageService.add received the plaintext')
        .toBeFalse();
    }
    for (const [name, value] of Object.entries(
      messageSpy as unknown as Record<string, unknown>,
    )) {
      if (typeof value === 'function') {
        continue;
      }
      expect(containsSentinel(value, SENTINEL))
        .withContext(`MessageService.${name} holds the plaintext`)
        .toBeFalse();
    }

    // 3. The rendered DOM.
    expect(fixture.nativeElement.textContent as string).not.toContain(SENTINEL);

    // 4. Both web storages, over every key.
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < storage.length; i++) {
        const storageKey = storage.key(i) as string;
        expect(storageKey).not.toContain(SENTINEL);
        expect(storage.getItem(storageKey) ?? '').not.toContain(SENTINEL);
      }
    }

    // 5. The URL.
    expect(window.location.href).not.toContain(SENTINEL);

    // 6. Every console channel — including a debug line added while working
    //    and forgotten, which is the one nobody writes on purpose.
    for (const spy of consoleSpies) {
      for (const call of spy.calls.all()) {
        expect(containsSentinel(call.args, SENTINEL))
          .withContext(`console.${spy.and.identity} received the plaintext`)
          .toBeFalse();
      }
    }
  }

  function spyOnEveryConsoleChannel(): jasmine.Spy[] {
    return [
      spyOn(console, 'log'),
      spyOn(console, 'info'),
      spyOn(console, 'debug'),
      spyOn(console, 'warn'),
      spyOn(console, 'error'),
    ];
  }

  describe('the secret is gone after dismissal (AC 11) — the specs that matter', () => {
    it('leaves the plaintext NOWHERE after the create flow is dismissed', async () => {
      const consoleSpies = spyOnEveryConsoleChannel();
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key()]));
      apiSpy.createApiKey.and.returnValue(Promise.resolve(createdKey()));

      await render();
      await submitCreate();

      // It WAS shown — otherwise the absence below would be vacuous.
      expect(byTest('api-key-reveal-value')?.textContent).toContain(SENTINEL);

      (byTest('api-key-reveal-done-btn') as HTMLButtonElement).click();
      await settle();

      expect(byTest('api-key-reveal')).toBeNull();
      expectSentinelGone(consoleSpies);
    });

    it('leaves the plaintext NOWHERE after the rotate flow is dismissed', async () => {
      const consoleSpies = spyOnEveryConsoleChannel();
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key({ key_id: 'ak-1' })]));
      apiSpy.rotateApiKey.and.returnValue(
        Promise.resolve(createdKey({ key_id: 'ak-1' })),
      );

      await render();
      await clickRotate('ak-1');

      expect(byTest('api-key-reveal-value')?.textContent).toContain(SENTINEL);

      (byTest('api-key-reveal-done-btn') as HTMLButtonElement).click();
      await settle();

      expect(byTest('api-key-reveal')).toBeNull();
      expectSentinelGone(consoleSpies);
    });

    it('re-opening the pane never shows the plaintext again (AC 14)', async () => {
      const consoleSpies = spyOnEveryConsoleChannel();
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key()]));
      apiSpy.createApiKey.and.returnValue(Promise.resolve(createdKey()));

      await render();
      await submitCreate();
      (byTest('api-key-reveal-done-btn') as HTMLButtonElement).click();
      await settle();

      // Re-open the create dialog: no reveal rides along with it.
      (byTest('api-key-create-btn') as HTMLButtonElement).click();
      await settle();
      expect(byTest('api-key-reveal')).toBeNull();
      (byTest('api-key-create-cancel-btn') as HTMLButtonElement).click();
      await settle();

      // Re-run the load path: the server cannot re-issue the plaintext, and
      // neither can the client.
      await fixture.componentInstance.loadKeys();
      await settle();

      expect(byTest('api-keys-table')).not.toBeNull();
      expect(byTest('api-key-reveal')).toBeNull();
      expectSentinelGone(consoleSpies);
    });
  });

  describe('the row is an allowlist projection, never the response (AC 12)', () => {
    it('drops plaintext_key AND an unknown stray field on the way into keys[]', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([]));
      // A secret-bearing DTO must lose anything the projection has never heard
      // of — a rest-destructure would carry `key_hash` straight through.
      apiSpy.createApiKey.and.returnValue(
        Promise.resolve({
          ...createdKey(),
          key_hash: 'leaked-hash',
        } as CreateApiKeyResponse),
      );

      await render();
      await submitCreate();
      (byTest('api-key-reveal-done-btn') as HTMLButtonElement).click();
      await settle();

      const row = fixture.componentInstance.keys[0] as unknown as Record<
        string,
        unknown
      >;
      expect(Object.keys(row).sort()).toEqual([
        'created_at',
        'expiration',
        'key_id',
        'owner_email',
        'owner_id',
        'roles',
      ]);
      const text = fixture.nativeElement.textContent as string;
      expect(text).not.toContain('leaked-hash');
      expect(text).not.toContain(SENTINEL);
    });

    it('toRecord names exactly the six non-secret fields', () => {
      const record = toRecord({
        ...createdKey(),
        key_hash: 'leaked-hash',
      } as CreateApiKeyResponse);

      expect(record).toEqual({
        key_id: 'ak-acme-9',
        owner_id: 'u-acme',
        owner_email: 'operator@acme.test',
        roles: ['admin'],
        expiration: null,
        created_at: '2026-08-16T09:00:00Z',
      });
    });
  });

  describe('create (AC 8b, 13)', () => {
    it('prepends the new row and flips empty -> rows, with NO second request', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([]));
      apiSpy.createApiKey.and.returnValue(Promise.resolve(createdKey()));

      await render();
      expectOnlyState('api-keys-empty');

      await submitCreate();

      expect(byTest('api-keys-table')).not.toBeNull();
      expect(fixture.componentInstance.keys.map((k) => k.key_id)).toEqual([
        'ak-acme-9',
      ]);
      // A refetch would be a second request racing the panel already on
      // screen, for data the response already carried.
      expect(apiSpy.getApiKeys).toHaveBeenCalledTimes(1);
    });

    it('prepends ahead of the existing rows — the server sorts newest-first', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key({ key_id: 'ak-1' })]));
      apiSpy.createApiKey.and.returnValue(Promise.resolve(createdKey()));

      await render();
      await submitCreate();

      expect(fixture.componentInstance.keys.map((k) => k.key_id)).toEqual([
        'ak-acme-9',
        'ak-1',
      ]);
    });

    it('closes the create dialog BEFORE the reveal opens — never both at once', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([]));
      apiSpy.createApiKey.and.returnValue(Promise.resolve(createdKey()));

      await render();
      await submitCreate();

      expect(byTest('api-key-reveal')).not.toBeNull();
      expect(byTest('api-key-create-form')).toBeNull();
    });

    it('keeps the dialog open with its values after a rejected submit, and adds no toast', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([]));
      apiSpy.createApiKey.and.returnValue(
        Promise.reject(new HttpError('Boom', 500, null)),
      );

      await render();
      await submitCreate('operator');

      // Discarding a filled form on a 500 is its own small disaster.
      expect(byTest('api-key-create-form')).not.toBeNull();
      expect((byTest('api-key-create-roles') as HTMLInputElement).value).toBe(
        'operator',
      );
      expect(byTest('api-key-reveal')).toBeNull();
      // `createApiKey` keeps the default `notifyOnError`, so FetchService has
      // already reported it — a component toast would be the second one.
      expect(messageSpy.add).toHaveBeenCalledTimes(0);
    });
  });

  describe('rotate (AC 9, 15)', () => {
    it('mounts the SAME reveal component type as create', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key({ key_id: 'ak-1' })]));
      apiSpy.createApiKey.and.returnValue(Promise.resolve(createdKey()));
      apiSpy.rotateApiKey.and.returnValue(
        Promise.resolve(createdKey({ key_id: 'ak-1' })),
      );

      await render();
      await submitCreate();
      expect(revealComponents().length).toBe(1);
      (byTest('api-key-reveal-done-btn') as HTMLButtonElement).click();
      await settle();

      await clickRotate('ak-1');

      // One component type, two flows — a second reveal would be two code
      // paths rendering a secret.
      expect(revealComponents().length).toBe(1);
    });

    it('replaces the row located by the OLD key_id when the store re-mints the id', async () => {
      apiSpy.getApiKeys.and.returnValue(
        Promise.resolve([key({ key_id: 'ak-1' }), key({ key_id: 'ak-2' })]),
      );
      // A re-mint store issues a NEW id; an in-place store keeps the old one.
      // Both are legal, so the row cannot be patched on the assumption that
      // the id survives.
      apiSpy.rotateApiKey.and.returnValue(
        Promise.resolve(createdKey({ key_id: 'ak-1-rotated' })),
      );

      await render();
      await clickRotate('ak-1');

      const ids = fixture.componentInstance.keys.map((k) => k.key_id);
      expect(ids).toEqual(['ak-1-rotated', 'ak-2']);
      expect(ids.length).toBe(2);
      expect(byTest('api-key-row-ak-1')).toBeNull();
      expect(byTest('api-key-row-ak-1-rotated')).not.toBeNull();
    });

    it('leaves the row untouched on a rejection and adds no toast of its own', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key({ key_id: 'ak-1' })]));
      apiSpy.rotateApiKey.and.returnValue(
        Promise.reject(new HttpError('Boom', 500, null)),
      );

      await render();
      await clickRotate('ak-1');

      expect(byTest('api-key-row-ak-1')).not.toBeNull();
      expect(byTest('api-key-reveal')).toBeNull();
      expect(messageSpy.add).toHaveBeenCalledTimes(0);
    });
  });

  describe('revoke (AC 16, 17)', () => {
    it('asks for confirmation NAMING the key_id, and issues nothing on Cancel', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key({ key_id: 'ak-1' })]));

      await render();
      (byTest('api-key-revoke-btn-ak-1') as HTMLButtonElement).click();
      await settle();

      // Asserted on the dialog's CONTENT, not on its `p-dialog` host: PrimeNG
      // leaves the host element in place and renders the body only while the
      // dialog is open, so the host is present either way and proves nothing.
      expect(
        byTest('api-key-revoke-confirm-key-id')?.textContent?.trim(),
      ).toBe('ak-1');

      (byTest('api-key-revoke-cancel-btn') as HTMLButtonElement).click();
      await settle();

      expect(byTest('api-key-revoke-confirm-key-id')).toBeNull();
      expect(apiSpy.revokeApiKey).not.toHaveBeenCalled();
      expect(byTest('api-key-row-ak-1')).not.toBeNull();
    });

    it('removes the row on a 204, silently', async () => {
      apiSpy.getApiKeys.and.returnValue(
        Promise.resolve([key({ key_id: 'ak-1' }), key({ key_id: 'ak-2' })]),
      );
      apiSpy.revokeApiKey.and.returnValue(Promise.resolve(undefined));

      await render();
      await revoke('ak-1');

      expect(apiSpy.revokeApiKey).toHaveBeenCalledOnceWith('ak-1');
      expect(byTest('api-key-row-ak-1')).toBeNull();
      expect(byTest('api-key-row-ak-2')).not.toBeNull();
      expect(messageSpy.add).toHaveBeenCalledTimes(0);
    });

    it('treats a 404 as idempotent SUCCESS — the row goes, and no toast', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key({ key_id: 'ak-1' })]));
      apiSpy.revokeApiKey.and.returnValue(
        Promise.reject(new HttpError('Request failed: Not Found', 404, null)),
      );

      await render();
      await revoke('ak-1');

      // "Already gone" is the outcome that was asked for. A red toast over a
      // row that just correctly disappeared is the pane contradicting itself.
      expect(byTest('api-key-row-ak-1')).toBeNull();
      expect(messageSpy.add).toHaveBeenCalledTimes(0);
      // The last row leaving flips the pane back to its empty state.
      expectOnlyState('api-keys-empty');
    });

    for (const status of [500, 403]) {
      it(`keeps the row and raises exactly one toast on ${status}`, async () => {
        apiSpy.getApiKeys.and.returnValue(
          Promise.resolve([key({ key_id: 'ak-1' })]),
        );
        apiSpy.revokeApiKey.and.returnValue(
          Promise.reject(new HttpError('Upstream vault is down', status, null)),
        );

        await render();
        await revoke('ak-1');

        expect(byTest('api-key-row-ak-1')).not.toBeNull();
        // `revokeApiKey` opted out of FetchService's toast, so this one is not
        // a double-report — it is the only report.
        expect(messageSpy.add).toHaveBeenCalledTimes(1);
        expect(messageSpy.add.calls.first().args[0].summary).toBe(
          'Upstream vault is down',
        );
      });
    }

    it('stays silent on a NetworkError — FetchService always toasts that branch', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key({ key_id: 'ak-1' })]));
      apiSpy.revokeApiKey.and.returnValue(
        Promise.reject(new NetworkError('Server unreachable.')),
      );

      await render();
      await revoke('ak-1');

      // A NetworkError carries NO status, so a bare `err.status` read would be
      // `undefined` and could not be told apart from the 404 branch above.
      expect(byTest('api-key-row-ak-1')).not.toBeNull();
      expect(messageSpy.add).toHaveBeenCalledTimes(0);
    });
  });

  describe('one writer, no double-submit (AC 21)', () => {
    it('refuses a second create while the first is in flight — asserted on the TS guard', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([]));
      let resolveCreate: (r: CreateApiKeyResponse) => void = () => undefined;
      apiSpy.createApiKey.and.returnValue(
        new Promise<CreateApiKeyResponse>((resolve) => {
          resolveCreate = resolve;
        }),
      );

      await render();
      (byTest('api-key-create-btn') as HTMLButtonElement).click();
      await settle();
      const rolesInput = byTest('api-key-create-roles') as HTMLInputElement;
      rolesInput.value = 'admin';
      rolesInput.dispatchEvent(new Event('input'));
      await settle();
      (byTest('api-key-create-submit-btn') as HTMLButtonElement).click();
      await settle();

      // Straight at the method, bypassing `[disabled]` — a disabled attribute
      // does not gate a keyboard-driven submit (epic 33's lesson), so the
      // guard has to be in TypeScript.
      await fixture.componentInstance.onCreateSubmit({
        owner_id: 'u-acme',
        owner_email: '',
        roles: ['admin'],
      });

      expect(apiSpy.createApiKey).toHaveBeenCalledTimes(1);
      resolveCreate(createdKey());
      await settle();
    });

    it('refuses a second rotate and a revoke while a rotate is in flight', async () => {
      apiSpy.getApiKeys.and.returnValue(
        Promise.resolve([key({ key_id: 'ak-1' }), key({ key_id: 'ak-2' })]),
      );
      let resolveRotate: (r: CreateApiKeyResponse) => void = () => undefined;
      apiSpy.rotateApiKey.and.returnValue(
        new Promise<CreateApiKeyResponse>((resolve) => {
          resolveRotate = resolve;
        }),
      );

      await render();
      void fixture.componentInstance.onRotate(fixture.componentInstance.keys[0]);
      await settle();

      await fixture.componentInstance.onRotate(fixture.componentInstance.keys[1]);
      fixture.componentInstance.pendingRevoke = fixture.componentInstance.keys[1];
      await fixture.componentInstance.onRevokeProceed();

      expect(apiSpy.rotateApiKey).toHaveBeenCalledTimes(1);
      expect(apiSpy.revokeApiKey).not.toHaveBeenCalled();
      // Every row control is visibly locked too, off the same one field.
      expect(fixture.componentInstance.isWriteInFlight).toBeTrue();
      expect(
        (byTest('api-key-rotate-btn-ak-2') as HTMLButtonElement).disabled,
      ).toBeTrue();

      resolveRotate(createdKey({ key_id: 'ak-1' }));
      await settle();
      expect(fixture.componentInstance.isWriteInFlight).toBeFalse();
    });
  });

  describe('the Escape contract (AC 18, 19, 20)', () => {
    it('dismisses the reveal AND clears the plaintext (AC 19)', async () => {
      const consoleSpies = spyOnEveryConsoleChannel();
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([]));
      apiSpy.createApiKey.and.returnValue(Promise.resolve(createdKey()));

      await render();
      await submitCreate();
      expect(byTest('api-key-reveal')).not.toBeNull();

      pressEscape();
      await settle();

      // The dismissal path most likely to be wired straight to a visibility
      // flag, bypassing the one clearing method — which is exactly how the
      // secret would survive.
      expect(byTest('api-key-reveal')).toBeNull();
      expect(fixture.componentInstance.revealPlaintext).toBeNull();
      expectSentinelGone(consoleSpies);
    });

    it('cancels the revoke confirmation and issues no request', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key({ key_id: 'ak-1' })]));

      await render();
      (byTest('api-key-revoke-btn-ak-1') as HTMLButtonElement).click();
      await settle();

      pressEscape();
      await settle();

      expect(byTest('api-key-revoke-confirm-key-id')).toBeNull();
      expect(apiSpy.revokeApiKey).not.toHaveBeenCalled();
      expect(byTest('api-key-row-ak-1')).not.toBeNull();
    });

    it('closes the create dialog when it is the only layer open', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([]));

      await render();
      (byTest('api-key-create-btn') as HTMLButtonElement).click();
      await settle();

      pressEscape();
      await settle();

      expect(byTest('api-key-create-form')).toBeNull();
    });

    it('takes the reveal FIRST when a lower layer is also open', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key({ key_id: 'ak-1' })]));
      apiSpy.rotateApiKey.and.returnValue(
        Promise.resolve(createdKey({ key_id: 'ak-1' })),
      );

      await render();
      // Force the ordering question: a pending revoke underneath an open
      // reveal. One keystroke must take the topmost layer and only it.
      fixture.componentInstance.pendingRevoke = fixture.componentInstance.keys[0];
      await clickRotate('ak-1');

      pressEscape();
      await settle();

      expect(fixture.componentInstance.revealPlaintext).toBeNull();
      expect(fixture.componentInstance.pendingRevoke).not.toBeNull();
    });

    it('does NOTHING while a write is in flight — every channel locks together', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key({ key_id: 'ak-1' })]));
      let resolveRevoke: () => void = () => undefined;
      apiSpy.revokeApiKey.and.returnValue(
        new Promise<void>((resolve) => {
          resolveRevoke = resolve;
        }),
      );

      await render();
      (byTest('api-key-revoke-btn-ak-1') as HTMLButtonElement).click();
      await settle();
      (byTest('api-key-revoke-proceed-btn') as HTMLButtonElement).click();
      await settle();

      pressEscape();
      await settle();

      expect(fixture.componentInstance.pendingRevoke).not.toBeNull();
      expect(byTest('api-key-revoke-confirm-key-id')).not.toBeNull();

      resolveRevoke();
      await settle();
    });

    it('does nothing at all when no dialog is open', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key({ key_id: 'ak-1' })]));

      await render();
      pressEscape();
      await settle();

      expectOnlyState('api-keys-table');
      expect(apiSpy.revokeApiKey).not.toHaveBeenCalled();
    });

    it('leaves PrimeNG no Escape listener of its own — one keystroke, one action', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key({ key_id: 'ak-1' })]));

      await render();

      // `closeOnEscape` is a DOCUMENT-level listener PER DIALOG, so leaving it
      // on anywhere would give one keystroke more than one action — the exact
      // failure this contract exists to prevent (ADR-018 amendment (b)).
      const dialogs = fixture.debugElement
        .queryAll(By.css('p-dialog'))
        .map((de) => de.componentInstance as { closeOnEscape: boolean; modal: boolean; draggable: boolean });
      expect(dialogs.length).toBe(3);
      for (const dialog of dialogs) {
        expect(dialog.closeOnEscape).toBeFalse();
        expect(dialog.modal).toBeTrue();
        expect(dialog.draggable).toBeFalse();
      }
    });

    it('makes the reveal mask a REAL dismissal channel, and only the reveal (AC 10)', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key({ key_id: 'ak-1' })]));

      await render();

      // PrimeNG defaults `dismissableMask` to FALSE, so naming the mask as a
      // dismissal channel without setting it describes something that never
      // happens. The reveal sets it, because that channel ends in
      // `dismissReveal()` like every other one; the create dialog does NOT,
      // because a stray click beside a filled form must not discard it.
      const dialog = (hook: string): { dismissableMask: boolean } =>
        fixture.debugElement.query(By.css(`p-dialog[data-test="${hook}"]`))
          .componentInstance as { dismissableMask: boolean };

      expect(dialog('api-key-reveal-dialog').dismissableMask).toBeTrue();
      expect(dialog('api-key-create-dialog').dismissableMask).toBeFalse();
      expect(dialog('api-key-revoke-confirm-dialog').dismissableMask).toBeFalse();
    });

    it('clears the plaintext when the reveal is dismissed through the mask channel', async () => {
      const consoleSpies = spyOnEveryConsoleChannel();
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([]));
      apiSpy.createApiKey.and.returnValue(Promise.resolve(createdKey()));

      await render();
      await submitCreate();
      expect(byTest('api-key-reveal')).not.toBeNull();

      // The mask and the X both arrive as the same `visibleChange(false)`, so
      // this is the assertion that the channel the mask opens ends where every
      // other one does — and not at a bare visibility flag.
      fixture.componentInstance.onRevealVisibleChange(false);
      await settle();

      expect(byTest('api-key-reveal')).toBeNull();
      expect(fixture.componentInstance.revealPlaintext).toBeNull();
      expectSentinelGone(consoleSpies);
    });
  });

  describe('the revoke confirmation takes focus (Dev Notes: copy the pane next door)', () => {
    it('focuses Proceed when the dialog shows, so the keyboard lands inside it', async () => {
      apiSpy.getApiKeys.and.returnValue(Promise.resolve([key({ key_id: 'ak-1' })]));

      await render();
      (byTest('api-key-revoke-btn-ak-1') as HTMLButtonElement).click();
      await settle();

      fixture.componentInstance.onRevokeDialogShow();

      // Asking a destructive question from a modal while focus is still behind
      // it leaves a keyboard operator with nothing to answer it from.
      expect(document.activeElement).toBe(byTest('api-key-revoke-proceed-btn'));
    });
  });

  describe('the create control keeps 36-5\'s presence rule (AC 23)', () => {
    for (const status of [404, 500]) {
      it(`renders no create, rotate or revoke control after a ${status}`, async () => {
        apiSpy.getApiKeys.and.returnValue(
          Promise.reject(new HttpError('Nope', status, null)),
        );

        await render();

        expect(byTest('api-key-create-btn')).toBeNull();
        // Row actions are absent by construction — there is no row.
        expect(
          fixture.nativeElement.querySelector('[data-test^="api-key-rotate-btn-"]'),
        ).toBeNull();
        expect(
          fixture.nativeElement.querySelector('[data-test^="api-key-revoke-btn-"]'),
        ).toBeNull();
      });
    }
  });
});
