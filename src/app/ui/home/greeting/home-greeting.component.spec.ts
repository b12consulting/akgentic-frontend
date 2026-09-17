import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { AuthService } from '../../../core/platform/auth/auth.service';
import { ConfigService } from '../../../core/platform/config/config.service';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../testing/i18n-testing';
import { HomeGreetingComponent } from './home-greeting.component';

/**
 * The header the teams page wears, at the level the pure module cannot reach:
 * which SENTENCE is on screen, whose name is in it, and what happens to the
 * deployment's markup on the way to the DOM.
 *
 * The part-of-day boundaries are NOT re-asserted here — `greeting.spec.ts` owns
 * them with no fixture at all. What this file adds is the wiring: the clock
 * arriving as an input, the anonymous sentinel being told apart, and the
 * `[innerHTML]` binding actually being one.
 */
describe('HomeGreetingComponent', () => {
  let fixture: ComponentFixture<HomeGreetingComponent>;
  let component: HomeGreetingComponent;
  let currentUser$: BehaviorSubject<unknown>;

  /** A local instant. `greeting.spec.ts` owns which hour means what. */
  function at(hour: number): Date {
    return new Date(2026, 8, 11, hour, 0, 0, 0);
  }

  /**
   * Build the component against one config.
   *
   * `Partial<ConfigService>` cast rather than a real instance: every spec here
   * cares about exactly one getter, and constructing the service would drag in
   * a `fetch` of `config.json` that Karma cannot serve. The `declared` /
   * default distinction the getter itself makes is asserted in
   * `config.service.spec.ts`, against the real service.
   */
  async function mount(
    config: Partial<ConfigService> = {},
    user: unknown = { user_id: 'anonymous', email: '', name: 'Anonymous' },
  ): Promise<void> {
    currentUser$ = new BehaviorSubject<unknown>(user);
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [HomeGreetingComponent],
      providers: [
        provideTranslateTesting(),
        { provide: ConfigService, useValue: config },
        { provide: AuthService, useValue: { currentUser$ } },
      ],
    }).compileComponents();

    // SYNTHETIC templates, never the shipped copy. The addressed sentence takes
    // a parameter, and with the no-op loader a key comes back unsubstituted —
    // so an assertion on the rendered text would pass whether the name reached
    // the pipe or not. These make it mean something without pinning the English.
    setTestTranslations({
      home: {
        greeting: {
          morning: '<<morning>>',
          afternoon: '<<afternoon>>',
          evening: '<<evening>>',
          morningNamed: '<<morning:{{name}}>>',
          afternoonNamed: '<<afternoon:{{name}}>>',
          eveningNamed: '<<evening:{{name}}>>',
        },
      },
    });

    fixture = TestBed.createComponent(HomeGreetingComponent);
    component = fixture.componentInstance;
  }

  function render(): void {
    fixture.detectChanges();
  }

  function salutation(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.home-greeting__salutation');
  }

  function welcome(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.home-greeting__welcome');
  }

  describe('the salutation', () => {
    it('addresses a signed-in user by name', async () => {
      await mount({}, { user_id: 'u-1', name: 'Ada' });
      component.now = at(9);
      render();

      expect(salutation()?.textContent?.trim()).toBe('<<morning:Ada>>');
    });

    it('degrades to the name-less sentence for an anonymous visitor', async () => {
      // The community-tier session, which is the NORMAL one on a `hideLogin`
      // deployment. The addressed key with an empty parameter would render a
      // dangling comma; a name-based anonymity test would render the sentinel's
      // untranslated English 'Anonymous'.
      await mount({}, { user_id: 'anonymous', email: '', name: 'Anonymous' });
      component.now = at(9);
      render();

      expect(salutation()?.textContent?.trim()).toBe('<<morning>>');
      expect(fixture.nativeElement.textContent as string).not.toContain(
        'Anonymous',
      );
    });

    it('gains the name when a late /auth/me resolves under it', async () => {
      // `checkAuth()` answers after first paint. The header must not be blank
      // until it does, and must not stay name-less once it has.
      await mount({}, { user_id: 'anonymous', name: 'Anonymous' });
      component.now = at(14);
      render();
      expect(salutation()?.textContent?.trim()).toBe('<<afternoon>>');

      currentUser$.next({ user_id: 'u-2', name: 'Grace' });
      render();

      expect(salutation()?.textContent?.trim()).toBe('<<afternoon:Grace>>');
    });

    it('takes the hour from the `now` input, not from the wall clock', async () => {
      // THE REASON THE INPUT EXISTS. Without it this spec would assert whatever
      // time the CI agent happened to be at, and would pass at every hour of
      // the day while testing nothing.
      await mount({}, { user_id: 'u-1', name: 'Ada' });
      component.now = at(20);
      render();

      expect(salutation()?.textContent?.trim()).toBe('<<evening:Ada>>');
    });
  });

  describe('the welcome sentence', () => {
    it('renders a declared sentence as MARKUP, not as escaped text', async () => {
      // The defect this restores. sdworx-sme's real value carries a <sup>, and
      // interpolation puts `&lt;sup&gt;` on screen. Asserting on `innerHTML` is
      // what distinguishes the two bindings — `textContent` reads identically
      // under either and would pass against the bug.
      await mount({
        declaredWelcomeMessage: 'Welcome to SDWorx Akgents<sup>&reg;</sup>',
      });
      render();

      const el = welcome();
      expect(el).not.toBeNull();
      expect(el!.innerHTML).toContain('<sup>');
      expect(el!.querySelector('sup')).not.toBeNull();
      expect(el!.textContent).toContain('Welcome to SDWorx Akgents');
    });

    it('lets the sanitizer strip a script rather than trusting the value', async () => {
      // The guard on the decision above. `bypassSecurityTrustHtml` is NOT used,
      // so Angular's DomSanitizer still runs; this is what would fail if a
      // later pass reached for it to "make the markup work".
      await mount({
        declaredWelcomeMessage: '<script>alert(1)</script>ok',
      });
      render();

      const el = welcome();
      expect(el).not.toBeNull();
      expect(el!.innerHTML).not.toContain('<script');
      expect(el!.querySelector('script')).toBeNull();
      expect(el!.textContent).toContain('ok');
    });

    it('omits the line entirely when the deployment declared none', async () => {
      // Not an empty paragraph: on an unconfigured deployment the block is ONE
      // line, which is what keeps the table where it was. `declaredWelcome-
      // Message` is `null` both for a deployment that set nothing and for local
      // dev with no served config.json.
      await mount({ declaredWelcomeMessage: null });
      render();

      expect(welcome()).toBeNull();
      expect(salutation()).not.toBeNull();
    });

    it('survives a ConfigService that does not answer the question at all', async () => {
      // Three of the home page's own specs stub `ConfigService` as a bare
      // object literal carrying only `hideHome`. An undefined read must
      // collapse the line, not render the word "undefined" under the greeting.
      await mount({});
      render();

      expect(welcome()).toBeNull();
      expect(fixture.nativeElement.textContent as string).not.toContain(
        'undefined',
      );
    });
  });
});
