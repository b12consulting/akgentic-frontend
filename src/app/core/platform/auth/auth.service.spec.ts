import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService, SessionProbe } from './auth.service';
import { ConfigService } from '../config/config.service';

/**
 * Specs for {@link AuthService.loginWithApiKey} (Stories 1.8, 1.9, 30.1).
 *
 * The network boundary is the global `fetch`, which is stubbed via a Jasmine
 * spy — no real server is contacted. The key travels in a `POST` JSON body
 * (`{"apikey": "<key>"}`), never in the URL. The backend returns a `200` JSON
 * body (`{"success": true, "user": {...}}`) on success; the body itself is the
 * success signal — no redirect is followed and no `/auth/me` round-trip is
 * issued.
 */
describe('AuthService', () => {
  let service: AuthService;
  let fetchSpy: jasmine.Spy;
  let router: jasmine.SpyObj<Router>;
  let config: { api: string; hideLogin: boolean };

  const API = 'http://backend.test';

  function makeResponse(
    ok: boolean,
    body: unknown = null,
  ): Response {
    return {
      ok,
      json: () => Promise.resolve(body),
    } as unknown as Response;
  }

  /** A bodyless response carrying a real status, for the session probe. */
  function statusResponse(status: number): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(null),
    } as unknown as Response;
  }

  beforeEach(() => {
    router = jasmine.createSpyObj<Router>('Router', ['navigate']);
    router.navigate.and.resolveTo(true);
    config = { api: API, hideLogin: false };
    TestBed.configureTestingModule({
      providers: [
        AuthService,
        { provide: ConfigService, useValue: config },
        { provide: Router, useValue: router },
      ],
    });
    service = TestBed.inject(AuthService);
    fetchSpy = spyOn(window, 'fetch');
  });

  describe('loginWithApiKey — success path (AC #2, #4, #5)', () => {
    it('POSTs the key in a JSON body to a URL that never carries it', async () => {
      // One call only — the 200 JSON body is the success signal, no /auth/me.
      fetchSpy.and.returnValue(
        Promise.resolve(makeResponse(true, { success: true, user: { user_id: 'u1', name: 'Op' } })),
      );

      const key = 'secret key/+&';
      await firstValueFrom(service.loginWithApiKey(key));

      const loginCall = fetchSpy.calls.argsFor(0);
      const url = loginCall[0] as string;
      const init = loginCall[1] as RequestInit;

      // The key never reaches the URL — raw or URL-encoded.
      expect(url).toBe(`${API}/auth/login/apikey`);
      expect(url).not.toContain(key);
      expect(url).not.toContain(encodeURIComponent(key));

      expect(init.method).toBe('POST');
      // Load-bearing: the backend binds the session via Set-Cookie.
      expect(init.credentials).toBe('include');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

      // Parse rather than string-match: key order in JSON.stringify is incidental.
      expect(JSON.parse(init.body as string)).toEqual({ apikey: key });
    });

    it('reads the 200 JSON body so currentUser$ reflects the response user', async () => {
      const resolvedUser = { user_id: 'u1', email: 'op@test', name: 'Operator' };
      fetchSpy.and.returnValue(
        Promise.resolve(makeResponse(true, { success: true, user: resolvedUser })),
      );

      const result = await firstValueFrom(service.loginWithApiKey('valid-key'));

      // Single request — no followed redirect, no /auth/me round-trip.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual(resolvedUser);
      expect(service.currentUserValue).toEqual(resolvedUser);
    });
  });

  describe('loginWithApiKey — error path (AC #3)', () => {
    it('errors the observable on an HTTP 401 response', async () => {
      fetchSpy.and.returnValue(Promise.resolve(makeResponse(false)));

      await expectAsync(
        firstValueFrom(service.loginWithApiKey('bad-key')),
      ).toBeRejected();
    });

    it('does not establish a session on a 401 (currentUser stays anonymous)', async () => {
      fetchSpy.and.returnValue(Promise.resolve(makeResponse(false)));

      await expectAsync(
        firstValueFrom(service.loginWithApiKey('bad-key')),
      ).toBeRejected();

      // No checkAuth() follow-up — only the failed login call was issued.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(service.currentUserValue.user_id).toBe('anonymous');
    });
  });

  describe('no client-side key persistence (AC #6)', () => {
    it('never writes the API key to localStorage or sessionStorage', async () => {
      const localSpy = spyOn(Storage.prototype, 'setItem').and.callThrough();
      fetchSpy.and.returnValue(
        Promise.resolve(makeResponse(true, { success: true, user: { user_id: 'u1', name: 'Op' } })),
      );

      await firstValueFrom(service.loginWithApiKey('top-secret-key'));

      const persistedKey = localSpy.calls
        .allArgs()
        .some((args) => String(args[1]).includes('top-secret-key'));
      expect(persistedKey).toBe(false);
    });

    it('exposes no key-storage methods — the removed stubs are gone', () => {
      // Regression guard for AC #6: the deprecated stubs were deleted.
      const s = service as unknown as Record<string, unknown>;
      expect(s['setApiKey']).toBeUndefined();
      expect(s['getApiKey']).toBeUndefined();
      expect(s['clearApiKey']).toBeUndefined();
      expect(s['getAuthHeaders']).toBeUndefined();
    });
  });

  describe('sessionExpired — the one reaction, once', () => {
    it('navigates to /login once however many times it is called', () => {
      service.sessionExpired();
      service.sessionExpired();
      service.sessionExpired();

      expect(router.navigate).toHaveBeenCalledOnceWith(['/login']);
    });

    it('resets the current user to the anonymous sentinel', async () => {
      fetchSpy.and.resolveTo(
        makeResponse(true, { success: true, user: { user_id: 'u1', name: 'Op' } }),
      );
      await firstValueFrom(service.loginWithApiKey('valid-key'));
      expect(service.currentUserValue.user_id).toBe('u1');

      service.sessionExpired();

      expect(service.currentUserValue.user_id).toBe('anonymous');
    });

    it('navigates nowhere when the login page is hidden', () => {
      config.hideLogin = true;

      service.sessionExpired();

      expect(router.navigate).not.toHaveBeenCalled();
    });

    it('is armed again by a successful API-key login', async () => {
      service.sessionExpired();
      fetchSpy.and.resolveTo(
        makeResponse(true, { success: true, user: { user_id: 'u1', name: 'Op' } }),
      );
      await firstValueFrom(service.loginWithApiKey('valid-key'));

      service.sessionExpired();

      expect(router.navigate).toHaveBeenCalledTimes(2);
    });

    it('is armed again by a checkAuth() that resolves a user', async () => {
      service.sessionExpired();
      fetchSpy.and.resolveTo(makeResponse(true, { user_id: 'u1', name: 'Op' }));
      await firstValueFrom(service.checkAuth());

      service.sessionExpired();

      expect(router.navigate).toHaveBeenCalledTimes(2);
    });

    it('stays spent after a checkAuth() that resolves no user', async () => {
      service.sessionExpired();
      fetchSpy.and.resolveTo(makeResponse(false));
      await firstValueFrom(service.checkAuth());

      service.sessionExpired();

      expect(router.navigate).toHaveBeenCalledTimes(1);
    });
  });

  describe('probeSession — three answers, never a rejection', () => {
    const table: [string, () => void, SessionProbe][] = [
      ['200', () => fetchSpy.and.resolveTo(statusResponse(200)), 'valid'],
      ['401', () => fetchSpy.and.resolveTo(statusResponse(401)), 'expired'],
      ['500', () => fetchSpy.and.resolveTo(statusResponse(500)), 'unknown'],
      ['403', () => fetchSpy.and.resolveTo(statusResponse(403)), 'unknown'],
      [
        'a request that never landed',
        () => fetchSpy.and.rejectWith(new TypeError('Failed to fetch')),
        'unknown',
      ],
    ];

    for (const [label, arrange, verdict] of table) {
      it(`answers '${verdict}' for ${label}`, async () => {
        arrange();

        await expectAsync(service.probeSession()).toBeResolvedTo(verdict);
      });
    }

    it('asks /auth/me with the session cookie', async () => {
      fetchSpy.and.resolveTo(statusResponse(200));

      await service.probeSession();

      expect(fetchSpy).toHaveBeenCalledOnceWith(`${API}/auth/me`, {
        credentials: 'include',
      });
    });

    it("answers 'valid' without a request when the login page is hidden", async () => {
      config.hideLogin = true;

      await expectAsync(service.probeSession()).toBeResolvedTo('valid');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('leaves the current user as it was, whatever it answers', async () => {
      fetchSpy.and.resolveTo(
        makeResponse(true, { success: true, user: { user_id: 'u1', name: 'Op' } }),
      );
      await firstValueFrom(service.loginWithApiKey('valid-key'));

      fetchSpy.and.resolveTo(statusResponse(401));
      await service.probeSession();
      fetchSpy.and.rejectWith(new TypeError('Failed to fetch'));
      await service.probeSession();

      expect(service.currentUserValue.user_id).toBe('u1');
      expect(router.navigate).not.toHaveBeenCalled();
    });
  });
});
