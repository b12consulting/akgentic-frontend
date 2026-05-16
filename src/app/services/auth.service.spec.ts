import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { ConfigService } from './config.service';

/**
 * Specs for {@link AuthService.loginWithApiKey} (Story 1.8).
 *
 * The network boundary is the global `fetch`, which is stubbed via a Jasmine
 * spy — no real server is contacted. Both the API-key login request and the
 * follow-up `GET /auth/me` (issued by `checkAuth()`) go through the same spy.
 */
describe('AuthService', () => {
  let service: AuthService;
  let fetchSpy: jasmine.Spy;

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

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        AuthService,
        {
          provide: ConfigService,
          useValue: { api: API, hideLogin: false },
        },
      ],
    });
    service = TestBed.inject(AuthService);
    fetchSpy = spyOn(window, 'fetch');
  });

  describe('loginWithApiKey — success path (AC #1, #3)', () => {
    it('calls /auth/login/apikey with the key URL-encoded and credentials: include', async () => {
      // First call: the apikey login. Second call: checkAuth() -> /auth/me.
      fetchSpy.and.returnValues(
        Promise.resolve(makeResponse(true)),
        Promise.resolve(makeResponse(true, { user_id: 'u1', name: 'Op' })),
      );

      await firstValueFrom(service.loginWithApiKey('secret key/+&'));

      const loginCall = fetchSpy.calls.argsFor(0);
      expect(loginCall[0]).toBe(
        `${API}/auth/login/apikey?apikey=${encodeURIComponent('secret key/+&')}`,
      );
      expect((loginCall[1] as RequestInit).credentials).toBe('include');
    });

    it('triggers checkAuth() so currentUser$ reflects the resolved user', async () => {
      const resolvedUser = { user_id: 'u1', email: 'op@test', name: 'Operator' };
      fetchSpy.and.returnValues(
        Promise.resolve(makeResponse(true)),
        Promise.resolve(makeResponse(true, resolvedUser)),
      );

      await firstValueFrom(service.loginWithApiKey('valid-key'));

      // checkAuth() hits GET /auth/me with credentials.
      const meCall = fetchSpy.calls.argsFor(1);
      expect(meCall[0]).toBe(`${API}/auth/me`);
      expect((meCall[1] as RequestInit).credentials).toBe('include');
      expect(service.currentUserValue).toEqual(resolvedUser);
    });
  });

  describe('loginWithApiKey — error path (AC #4)', () => {
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

  describe('no client-side key persistence (AC #2)', () => {
    it('never writes the API key to localStorage or sessionStorage', async () => {
      const localSpy = spyOn(Storage.prototype, 'setItem').and.callThrough();
      fetchSpy.and.returnValues(
        Promise.resolve(makeResponse(true)),
        Promise.resolve(makeResponse(true, { user_id: 'u1', name: 'Op' })),
      );

      await firstValueFrom(service.loginWithApiKey('top-secret-key'));

      const persistedKey = localSpy.calls
        .allArgs()
        .some((args) => String(args[1]).includes('top-secret-key'));
      expect(persistedKey).toBe(false);
    });

    it('exposes no key-storage methods — the removed stubs are gone', () => {
      // Regression guard for AC #2: the deprecated stubs were deleted.
      const s = service as unknown as Record<string, unknown>;
      expect(s['setApiKey']).toBeUndefined();
      expect(s['getApiKey']).toBeUndefined();
      expect(s['clearApiKey']).toBeUndefined();
      expect(s['getAuthHeaders']).toBeUndefined();
    });
  });
});
