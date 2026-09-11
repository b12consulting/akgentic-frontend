import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { NEVER, of, throwError } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { ConfigService } from '../../core/config/config.service';
import { AuthProvider } from '../../core/auth/auth.types';
import { provideTranslateTesting } from '../../../testing/i18n-testing';
import { environment } from '../../../environments/environment';
import { LoginComponent } from './login.component';

/**
 * Specs for {@link LoginComponent}.
 *
 * Two halves, deliberately. The first is the AUTHENTICATION contract — which
 * service is called with what, where the user lands, what happens when the
 * backend refuses — and it is the part that must not move when the screen is
 * restyled, so it is asserted through the component API rather than through the
 * markup. The second is what the screen RENDERS, which the old spec covered not
 * at all: it never called `detectChanges`, so nothing in the repo asserted that
 * the login page put anything on screen.
 *
 * Copy is asserted as KEYS, never as English: `provideTranslateTesting` installs
 * a no-op loader, so every key misses and the missing-translation handler echoes
 * it back. The one place a raw sentence is expected is the backend's own error
 * message, and that expectation is the point — see `LoginError`.
 */
describe('LoginComponent', () => {
  let component: LoginComponent;
  let fixture: ComponentFixture<LoginComponent>;
  let authSpy: jasmine.SpyObj<AuthService>;
  let routerSpy: jasmine.SpyObj<Router>;

  function setup(
    config: {
      loginProviders?: AuthProvider[];
      logo?: string;
      brandLogo?: string | null;
      welcomeMessage?: string;
    } = {},
  ): void {
    authSpy = jasmine.createSpyObj('AuthService', ['loginWithApiKey']);
    routerSpy = jasmine.createSpyObj('Router', ['navigate']);

    TestBed.configureTestingModule({
      imports: [LoginComponent],
      providers: [
        provideTranslateTesting(),
        { provide: AuthService, useValue: authSpy },
        { provide: Router, useValue: routerSpy },
        {
          // `logo` and `brandLogo` are BOTH stubbed because they answer
          // different questions: `logo` is the path that WOULD be loaded, the
          // framework default included, while `brandLogo` is whether this
          // deployment set a mark of its own. The default below is the ordinary
          // case — the framework's `akgent_logo.png` present, nothing
          // configured — and the masthead must draw type, not that raster.
          provide: ConfigService,
          useValue: {
            api: 'http://backend.test',
            logo: 'akgent_logo.png',
            brandLogo: null,
            welcomeMessage: '',
            loginProviders: ['apikey'] as AuthProvider[],
            ...config,
          },
        },
      ],
    });

    fixture = TestBed.createComponent(LoginComponent);
    component = fixture.componentInstance;
  }

  /** Text of every element matching `selector`, trimmed and whitespace-collapsed. */
  function textOf(selector: string): string[] {
    return fixture.debugElement
      .queryAll(By.css(selector))
      .map((el) => (el.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ').trim() ?? '');
  }

  function query<T extends HTMLElement>(selector: string): T | null {
    return fixture.nativeElement.querySelector(selector) as T | null;
  }

  // --- The authentication contract ---------------------------------------
  //
  // Everything in this block behaved exactly this way before the redesign and
  // must go on behaving this way after it. The restyle is chrome.

  describe('loginWithApiKey — success (AC #1)', () => {
    beforeEach(() => setup());

    it('calls AuthService.loginWithApiKey and navigates to / on success', () => {
      authSpy.loginWithApiKey.and.returnValue(of({ user_id: 'u1' }));
      component.apiKey = 'valid-key';

      component.loginWithApiKey();

      expect(authSpy.loginWithApiKey).toHaveBeenCalledWith('valid-key');
      expect(routerSpy.navigate).toHaveBeenCalledWith(['/']);
      expect(component.loading).toBe(false);
      expect(component.error).toBeNull();
    });
  });

  describe('loginWithApiKey — empty key', () => {
    beforeEach(() => setup());

    it('sets the error and does not call the service', () => {
      component.apiKey = '';

      component.loginWithApiKey();

      // The KEY, not the sentence. This message is the framework's own copy, so
      // pinning the English here would put it back outside @ngx-translate — the
      // exact thing NFR3 exists to stop.
      expect(component.error).toEqual({ kind: 'key', key: 'login.errors.emptyKey' });
      expect(authSpy.loginWithApiKey).not.toHaveBeenCalled();
    });
  });

  describe('loginWithApiKey — error (AC #3)', () => {
    beforeEach(() => setup());

    it('surfaces the backend message, resets loading, and does not navigate', () => {
      authSpy.loginWithApiKey.and.returnValue(
        throwError(() => new Error('Invalid API key')),
      );
      component.apiKey = 'bad-key';

      component.loginWithApiKey();

      // Raw TEXT, not a key: this sentence came from the deployment's own
      // server and the framework has no translation for it to find.
      expect(component.error).toEqual({ kind: 'text', text: 'Invalid API key' });
      expect(component.loading).toBe(false);
      expect(routerSpy.navigate).not.toHaveBeenCalled();
    });

    it('prefers the backend payload over the transport message', () => {
      authSpy.loginWithApiKey.and.returnValue(
        throwError(() => ({ error: { error: 'Key revoked' }, message: 'Http failure' })),
      );
      component.apiKey = 'bad-key';

      component.loginWithApiKey();

      expect(component.error).toEqual({ kind: 'text', text: 'Key revoked' });
    });

    it('falls back to its own copy when the failure carries no readable message', () => {
      authSpy.loginWithApiKey.and.returnValue(throwError(() => null));
      component.apiKey = 'bad-key';

      component.loginWithApiKey();

      expect(component.error).toEqual({ kind: 'key', key: 'login.errors.apiKeyFailed' });
    });
  });

  describe('loginWithApiKey — in flight', () => {
    beforeEach(() => setup());

    it('ignores a second submit while a request is out', () => {
      // Enter fires on the field, which carries no `[disabled]` of its own, so
      // two quick presses used to be two POSTs racing for the session cookie.
      // NEVER, so the first call stays in flight: an observable that completed
      // synchronously would clear `loading` before the second call could be
      // rejected by it, and the test would pass without the guard existing.
      authSpy.loginWithApiKey.and.returnValue(NEVER);
      component.apiKey = 'valid-key';

      component.loginWithApiKey();
      component.loginWithApiKey();

      expect(authSpy.loginWithApiKey).toHaveBeenCalledTimes(1);
    });
  });

  describe('OAuth', () => {
    beforeEach(() => setup({ loginProviders: ['google', 'apikey'] }));

    it('points at the backend login endpoint for the provider', () => {
      // Asserted on the URL rather than by pressing the button: `loginOAuth`
      // assigns `window.location.href`, which would take the test runner with it.
      expect(component.oauthUrl('google')).toBe('http://backend.test/auth/login/google');
      expect(component.oauthUrl('okta')).toBe('http://backend.test/auth/login/okta');
    });
  });

  // --- What the screen renders --------------------------------------------

  describe('rendering — both methods stay reachable', () => {
    beforeEach(() => {
      setup({ loginProviders: ['google', 'apikey'] });
      fixture.detectChanges();
    });

    it('offers one switch entry per configured provider', () => {
      expect(textOf('.login__method')).toEqual([
        'login.providers.google',
        'login.providers.apikey',
      ]);
    });

    it('starts on the deployment\'s first provider and shows only that panel', () => {
      expect(component.activeProvider).toBe('google');
      expect(query('#login-panel-google')).not.toBeNull();
      expect(query('#login-panel-apikey')).toBeNull();
      expect(textOf('.login__submit')).toEqual(['login.submit.google']);
    });

    it('switches to the API-key method and mounts its field', () => {
      const [, apikeyTab] = fixture.debugElement.queryAll(By.css('.login__method'));
      apikeyTab.nativeElement.click();
      fixture.detectChanges();

      expect(query('.login__input')).not.toBeNull();
      expect(textOf('.login__submit')).toEqual(['login.submit.apikey']);
    });

    it('marks exactly one entry selected, for assistive tech as well as the eye', () => {
      const selected = fixture.debugElement
        .queryAll(By.css('.login__method'))
        .filter((el) => el.attributes['aria-selected'] === 'true');

      expect(selected.length).toBe(1);
      expect(selected[0].attributes['id']).toBe('login-method-google');
    });

    it('moves the selection with the arrow keys', () => {
      const list = fixture.debugElement.query(By.css('.login__methods'));
      list.triggerEventHandler('keydown', new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      fixture.detectChanges();

      expect(component.activeProvider).toBe('apikey');

      list.triggerEventHandler('keydown', new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
      fixture.detectChanges();

      expect(component.activeProvider).toBe('google');
    });

    it('drops a failure when the user switches method', () => {
      component.error = { kind: 'text', text: 'Invalid API key' };
      fixture.detectChanges();
      expect(query('.login__error')).not.toBeNull();

      component.selectProvider('apikey');
      fixture.detectChanges();

      // The message belonged to the method that produced it; carrying it across
      // would accuse a path the user has not tried yet.
      expect(component.error).toBeNull();
      expect(query('.login__error')).toBeNull();
    });
  });

  describe('rendering — a single provider', () => {
    beforeEach(() => {
      setup();
      fixture.detectChanges();
    });

    it('draws no switch, because there is nothing to switch between', () => {
      expect(component.showTabs).toBe(false);
      expect(query('.login__methods')).toBeNull();
      expect(query('.login__input')).not.toBeNull();
    });
  });

  describe('rendering — no provider configured', () => {
    beforeEach(() => {
      setup({ loginProviders: [] });
      fixture.detectChanges();
    });

    it('says so once, in a place that can actually be seen', () => {
      // The old page had TWO representations of this state and only one of them
      // could ever render — the other was set on a field whose only host lived
      // inside the API-key panel, which by definition is not mounted here.
      const notice = query('.login__notice');
      expect(notice?.textContent?.trim()).toBe('login.noProviders');
      expect(notice?.getAttribute('role')).toBe('alert');
      expect(query('.login__methods')).toBeNull();
      expect(query('.login__submit')).toBeNull();
    });
  });

  describe('rendering — failure', () => {
    beforeEach(() => {
      setup();
      fixture.detectChanges();
    });

    it('announces the framework\'s own message as a key', () => {
      component.apiKey = '';
      component.loginWithApiKey();
      fixture.detectChanges();

      const error = query('.login__error');
      expect(error?.getAttribute('role')).toBe('alert');
      expect(error?.textContent?.trim()).toBe('login.errors.emptyKey');
    });

    it('announces the backend\'s message verbatim, never as a key', () => {
      authSpy.loginWithApiKey.and.returnValue(
        throwError(() => new Error('Invalid API key')),
      );
      component.apiKey = 'bad-key';
      component.loginWithApiKey();
      fixture.detectChanges();

      expect(query('.login__error')?.textContent?.trim()).toBe('Invalid API key');
    });
  });

  describe('rendering — in flight', () => {
    it('disables the API-key submit and its field, and renames the action', async () => {
      setup();
      fixture.detectChanges();

      component.loading = true;
      fixture.detectChanges();
      // `NgModel` defers `[disabled]` to a microtask (it has to reach the
      // FormControl, not just the element), so the field is still enabled at
      // the end of this change-detection pass. Without the flush the button
      // assertions below would pass and the field one would silently be
      // asserting the pre-disable state.
      await fixture.whenStable();
      fixture.detectChanges();

      const submit = query<HTMLButtonElement>('.login__submit');
      expect(submit?.disabled).toBe(true);
      expect(submit?.getAttribute('aria-busy')).toBe('true');
      expect(submit?.textContent?.trim()).toBe('login.signingIn');
      expect(query<HTMLInputElement>('.login__input')?.disabled).toBe(true);
    });

    it('disables the OAuth submit once its redirect is under way', () => {
      setup({ loginProviders: ['google'] });
      fixture.detectChanges();

      component.oauthPending = 'google';
      fixture.detectChanges();

      const submit = query<HTMLButtonElement>('.login__submit');
      expect(submit?.disabled).toBe(true);
      expect(submit?.textContent?.trim()).toBe('login.signingIn');
    });

    it('leaves a DIFFERENT provider clickable while one redirect is out', () => {
      // The binding used to be `oauthPending !== null`, which let one method's
      // in-flight redirect disable every other method's button too.
      setup({ loginProviders: ['google', 'azure'] });
      fixture.detectChanges();

      component.oauthPending = 'azure';
      component.selectProvider('google');
      // `selectProvider` clears the flag, so put it back: what is under test is
      // the BINDING, not the clearing, and the two would otherwise mask
      // each other.
      component.oauthPending = 'azure';
      fixture.detectChanges();

      const submit = query<HTMLButtonElement>('.login__submit');
      expect(submit?.disabled).toBe(false);
      expect(submit?.textContent?.trim()).toBe('login.submit.google');
    });
  });

  describe('an abandoned OAuth redirect', () => {
    // Nothing in the SPA clears `oauthPending` on the happy path, because the
    // happy path never comes back. These are the paths that do.
    beforeEach(() => {
      setup({ loginProviders: ['google', 'apikey'] });
      fixture.detectChanges();
    });

    it('re-enables the button when the page is restored from bfcache', () => {
      component.oauthPending = 'google';
      fixture.detectChanges();
      expect(query<HTMLButtonElement>('.login__submit')?.disabled).toBe(true);

      // What the browser dispatches when the user presses Back out of the
      // provider's consent screen onto a page it kept frozen: no Angular
      // lifecycle runs, so this event is the component's only notice.
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      fixture.detectChanges();

      expect(component.oauthPending).toBeNull();
      const submit = query<HTMLButtonElement>('.login__submit');
      expect(submit?.disabled).toBe(false);
      expect(submit?.textContent?.trim()).toBe('login.submit.google');
    });

    it('ignores an ordinary load, which is not a restore', () => {
      component.oauthPending = 'google';

      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));

      // A fresh document gets a fresh component, so a non-persisted `pageshow`
      // can only be a page that was never frozen — clearing on it would say
      // something untrue about a redirect that may still be in flight.
      expect(component.oauthPending).toBe('google');
    });

    it('stops listening once the component is gone', () => {
      component.oauthPending = 'google';
      fixture.destroy();

      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));

      // A window listener outlives its component unless it is torn down, and a
      // login page is mounted and destroyed on every sign-out.
      expect(component.oauthPending).toBe('google');
    });

    it('recovers when the user switches method and comes back', () => {
      component.oauthPending = 'google';

      component.selectProvider('apikey');

      expect(component.oauthPending).toBeNull();
    });
  });

  describe('rendering — brand and deployment strings', () => {
    it('sets the product name as a literal and its qualifier through the pipe', () => {
      setup();
      fixture.detectChanges();

      // "Akgents" is a product name — the same word in every language — so it is
      // deliberately NOT a key. The qualifier beside it is copy, and it reuses
      // the rail's key rather than forking a second one.
      expect(query('.login__wordmark-name')?.textContent?.trim()).toBe('Akgents');
      expect(query('.login__wordmark-suffix')?.textContent?.trim()).toBe('rail.brandSuffix');
    });

    it('renders a deployment\'s welcome sentence verbatim', () => {
      setup({ welcomeMessage: 'Welcome to Contoso' });
      fixture.detectChanges();

      // config.json is not a locale file, so this must not go through the pipe.
      expect(query('.login__blurb')?.textContent?.trim()).toBe('Welcome to Contoso');
    });

    it('omits the blurb rather than reserving space for a sentence nobody set', () => {
      setup();
      fixture.detectChanges();

      expect(query('.login__blurb')).toBeNull();
    });

    // --- The mark: wordmark by default, a configured logo REPLACES it -------
    //
    // A REQUIREMENT CHANGE, not a regression. The previous spec here asserted
    // that the wordmark was the page's only mark "whatever config.logo says",
    // which was right about the framework default — `akgent_logo.png` is a
    // raster of that same wordmark, so drawing both put one brand on screen
    // twice — and wrong about a white-label deployment that ships its own
    // (sdworx-sme's config.json sets `"logo": "sdworx-logo.svg"`), for which it
    // meant the mark was drawn nowhere at all. `ConfigService.brandLogo` tells
    // those two cases apart; these assert both sides of it.

    it('sets the product in type when the deployment configured no mark', () => {
      // `logo` is non-empty here, as it is on every deployment — the framework
      // default. Reading THAT rather than `brandLogo` is the bug this pins.
      setup({ logo: 'akgent_logo.png', brandLogo: null });
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelectorAll('img').length).toBe(0);
      expect(query('.login__wordmark-name')?.textContent?.trim()).toBe('Akgents');
    });

    it('draws a configured mark INSTEAD of the wordmark, never above it', () => {
      setup({ brandLogo: 'contoso.svg' });
      fixture.detectChanges();

      const marks = fixture.nativeElement.querySelectorAll('img.login__logo');
      expect(marks.length).toBe(1);
      // `getAttribute`, not `.src`: the property resolves against the test
      // runner's base href, so asserting it would pin Karma's URL rather than
      // the value the deployment configured.
      expect(marks[0].getAttribute('src')).toBe('contoso.svg');

      // The "never stacks" half. Two marks is the failure the old code avoided
      // by drawing none, and it must not come back with the image.
      expect(query('.login__wordmark')).toBeNull();
    });

    it('gives the mark a translated alt rather than an English literal', () => {
      setup({ brandLogo: 'contoso.svg' });
      fixture.detectChanges();

      // The KEY, echoed by the no-op loader. A brand mark is the only thing on
      // the page identifying whose product it is, so it is informative and
      // needs an accessible name — and that name is copy like any other.
      expect(query<HTMLImageElement>('img.login__logo')?.getAttribute('alt')).toBe(
        'chrome.brandLogoAlt',
      );
    });
  });

  /**
   * The rule itself, exercised through the REAL `ConfigService`.
   *
   * The block above stubs the service, so it asserts what the masthead does
   * with an answer; this asserts how the answer is reached. Both halves matter
   * and they fail differently: stub the wrong shape and the first block goes
   * green on a service that cannot produce it.
   *
   * There is no `config.service.spec.ts` to put this in yet — see the report's
   * follow-ups. It lives here because the login masthead is one of the two
   * consumers of the rule, and the only one in this builder's scope.
   */
  describe('ConfigService.brandLogo — what counts as "a deployment set one"', () => {
    /** Boot a real service against a fetched `config.json`, or against none. */
    async function loadConfig(runtime: object | null): Promise<ConfigService> {
      const service = new ConfigService();
      spyOn(window, 'fetch').and.returnValue(
        runtime === null
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve({
              ok: true,
              json: () => Promise.resolve(runtime),
            } as Response),
      );
      await service.load();
      return service;
    }

    it('reports no mark when config.json never mentions one', async () => {
      const config = await loadConfig({ api: 'http://backend.test' });

      // The framework default is still READABLE — nothing about it changed —
      // it just is not a deployment's own mark.
      expect(config.logo).toBe(environment.logo);
      expect(config.brandLogo).toBeNull();
    });

    it('reports the mark a deployment did declare', async () => {
      // sdworx-sme's config.json, reduced to the key under test.
      const config = await loadConfig({ logo: 'sdworx-logo.svg' });

      expect(config.brandLogo).toBe('sdworx-logo.svg');
    });

    it('honours a declaration that happens to name the framework default', async () => {
      // Explicit is explicit. The result is still ONE brand on screen — the
      // raster instead of the type — which is what the deployment asked for.
      const config = await loadConfig({ logo: 'akgent_logo.png' });

      expect(config.brandLogo).toBe('akgent_logo.png');
    });

    it('treats a blank declaration as no mark, not as <img src="">', async () => {
      // An empty `src` re-requests the current document: a broken image and a
      // wasted round trip, rather than "this deployment has no logo".
      const config = await loadConfig({ logo: '   ' });

      expect(config.brandLogo).toBeNull();
    });

    it('reports no mark when config.json cannot be fetched at all', async () => {
      // Local dev, where the file is not served. The build-time defaults stand,
      // and a build-time default is by definition not a deployment's choice.
      const config = await loadConfig(null);

      expect(config.brandLogo).toBeNull();
    });
  });

  describe('an unknown provider', () => {
    beforeEach(() => {
      setup({ loginProviders: ['okta', 'apikey'] });
      fixture.detectChanges();
    });

    it('reaches for a parameterised key rather than a raw dotted one', () => {
      // `AuthProvider` admits any string, so a deployment can name a provider the
      // framework ships no copy for. Without the `custom` fallback the button
      // would read "login.providers.okta" on screen.
      expect(component.providers[0].labelKey).toBe('login.providers.custom');
      expect(component.providers[0].submitKey).toBe('login.submit.custom');
      expect(component.providers[0].name).toBe('Okta');
    });
  });
});
