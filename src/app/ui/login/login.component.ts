import {
  Component,
  DestroyRef,
  ElementRef,
  inject,
  viewChildren,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '../../core/platform/auth/auth.service';
import { ConfigService } from '../../core/platform/config/config.service';
import { AuthProvider } from '../../core/platform/auth/auth.types';

/**
 * What went wrong, in a form that says whose sentence it is.
 *
 * The login screen surfaces two kinds of failure and they are not the same
 * kind of string. One is the framework's own copy ("enter a key first"), which
 * is COPY and must go through `@ngx-translate` like every other user-visible
 * word in the app. The other is whatever the backend said, which is DATA — a
 * sentence chosen by a deployment's own server, in whatever language that
 * server speaks. Putting the second through the pipe would render it as a
 * missing key; hardcoding the first would put an English sentence on a French
 * screen. A single `string | null` field cannot tell the template which it is
 * holding, which is how they ended up being treated identically before.
 */
export type LoginError =
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'text'; readonly text: string };

/**
 * One configured sign-in method, resolved once rather than re-derived per
 * change detection.
 *
 * `AuthProvider` is `... | (string & {})` on purpose — a deployment may name a
 * provider the framework has never heard of — so every label here is a KEY
 * plus the provider's own `name` threaded as a parameter. The four the
 * framework knows ignore the parameter and read as real copy; anything else
 * falls through to the `custom` key, which is just the name in a sentence.
 * That is what stops an unknown provider rendering a raw dotted key on screen.
 */
export interface ProviderOption {
  readonly id: AuthProvider;
  /** Everything that is not the API key is an OAuth/OIDC redirect. */
  readonly isOAuth: boolean;
  /** Short label for the method switch. */
  readonly labelKey: string;
  /** Full sentence on the method's own submit button. */
  readonly submitKey: string;
  /** The provider's own name, for the `{{provider}}` parameter above. */
  readonly name: string;
}

/**
 * The providers the framework ships copy for. Anything else is a deployment's own.
 *
 * EXPORTED so a spec can assert the other half of the claim. "Ships copy for"
 * is a promise about `en.json`, and nothing structural was keeping it: these
 * ids are composed into `login.providers.${id}` at runtime, which puts the
 * whole subtree behind `tools/i18n-usage-audit.mjs`'s COMPOSED_PREFIXES
 * allow-list, and `locale-parity.spec.ts` only compares the two locales to each
 * other. So renaming a slug here without renaming the key was invisible to both
 * guards — which is exactly what happened when `azure` became `azure_ad`, and
 * every Azure deployment's button read `login.providers.azure_ad` until it was
 * caught by eye. The spec that closes that hole needs this list.
 */
export const KNOWN_PROVIDERS: readonly AuthProvider[] = ['azure_ad', 'google', 'apikey', 'default'];

@Component({
  selector: 'app-login',
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss'],
  imports: [FormsModule, TranslatePipe],
  standalone: true,
})
export class LoginComponent {
  private config = inject(ConfigService);

  /**
   * A deployment's own sentence, rendered VERBATIM through `[innerHTML]`.
   *
   * `config.json` is not a locale file and cannot be translated, so a
   * deployment that set a welcome sentence keeps reading its sentence rather
   * than having the framework overwrite it with copy of its own. Verbatim
   * includes the MARKUP: deployments write it (sdworx-sme's value is "Welcome
   * to SDWorx Akgents<sup>&reg;</sup>"), and under interpolation those tags are
   * escaped and read as literal angle brackets on screen. The template binds
   * `innerHTML` so the sanitizer — which still runs, see the template comment —
   * decides what survives.
   *
   * `welcomeMessage` and NOT `ConfigService.declaredWelcomeMessage`, which is
   * the getter added for the home page's greeting: a signed-out visitor is
   * being greeted by the product, and the product has something to say even
   * when a deployment chose nothing. Reading the declared form here would blank
   * this line on every deployment that never configured one — a change nobody
   * asked for. The two reads differ on purpose.
   */
  welcomeMessage: string = this.config.welcomeMessage;
  apiBaseUrl: string = this.config.api;

  /**
   * A deployment's own mark, or `null` to set the product's name in type.
   *
   * `brandLogo` rather than `logo`, and the difference is the whole feature:
   * `logo` always has a value, so reading it here would draw the framework's
   * `akgent_logo.png` — a raster of the wordmark below — on every deployment
   * that never configured anything. See `ConfigService.brandLogo` for the rule;
   * the rail's brand row implements the identical one, so a deployment gets its
   * mark in both places or in neither.
   *
   * Read once at construction, like every other config value here: `config.json`
   * is fetched by `APP_INITIALIZER` before the app renders and cannot change
   * afterwards, so a getter would re-read a constant on every check cycle.
   */
  readonly brandLogo: string | null = this.config.brandLogo;

  loginProviders: AuthProvider[] = this.config.loginProviders;

  /** The configured methods, in the deployment's declared order of preference. */
  readonly providers: readonly ProviderOption[];

  // UI state
  activeProvider: AuthProvider | '';
  showTabs: boolean;

  apiKey: string = '';
  loading: boolean = false;
  error: LoginError | null = null;

  /**
   * The provider whose redirect is under way, or `null`.
   *
   * Separate from `loading`, which is the API-key request: an OAuth sign-in
   * leaves the SPA entirely, so the happy path never needs this cleared — the
   * flag exists only so the button reads as "working" during the round trip to
   * the backend instead of looking inert and inviting a second click.
   *
   * The unhappy paths DO come back, though, and that is why the constructor
   * clears this. A user who reaches the provider's consent screen, decides it
   * is the wrong account and presses Back returns to a page Chrome restored
   * from bfcache with this component's heap intact — same instance, same
   * `oauthPending`, and a sign-in button that believes a redirect it can no
   * longer complete is still in flight. Holding the PROVIDER rather than a
   * boolean is the second half of that: only the method that is actually
   * redirecting goes quiet, so a stale flag can never disable a different one.
   */
  oauthPending: AuthProvider | null = null;

  /**
   * The rendered method buttons, in `providers` order.
   *
   * Focus has to move imperatively: a roving `tabindex` decides only where Tab
   * lands, so an arrow key that moved the selection without moving focus would
   * leave focus on a button that is no longer selected — the state
   * `aria-selected` promises cannot happen. Same treatment as the inspector's
   * tab strip, which is where this pattern is documented at length.
   */
  private readonly methodButtons =
    viewChildren<ElementRef<HTMLButtonElement>>('method');

  private authService = inject(AuthService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  constructor() {
    this.providers = this.loginProviders.map((id) => this.describe(id));

    // No error is raised for the empty case. The old code set one here and the
    // template could never show it — the only element bound to `error` lived
    // inside the API-key panel, which by definition does not render when there
    // are no providers. The notice is rendered from the empty list directly, so
    // there is one representation of "nothing is configured" rather than two
    // and only one of them reachable.
    this.activeProvider = this.providers.length > 0 ? this.providers[0].id : '';
    this.showTabs = this.providers.length > 1;

    // `pageshow` rather than a router hook or `visibilitychange`: a bfcache
    // restore runs NO Angular lifecycle at all — the component was never
    // destroyed, the router never navigated, and the app has no `unload`
    // handler to disqualify the page from the cache in the first place. This
    // event, with `persisted`, is the only signal the browser gives that a
    // frozen page is live again, and so the only place the abandoned redirect
    // can be noticed.
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) {
        this.oauthPending = null;
      }
    };
    window.addEventListener('pageshow', onPageShow);
    this.destroyRef.onDestroy(() =>
      window.removeEventListener('pageshow', onPageShow),
    );
  }

  private describe(id: AuthProvider): ProviderOption {
    const known = KNOWN_PROVIDERS.includes(id);
    const suffix = known ? id : 'custom';
    return {
      id,
      isOAuth: id !== 'apikey',
      labelKey: `login.providers.${suffix}`,
      submitKey: `login.submit.${suffix}`,
      // Only ever read by the `custom` keys, but filled for every option so the
      // template can thread one parameter unconditionally instead of branching.
      name: id.charAt(0).toUpperCase() + id.slice(1),
    };
  }

  selectProvider(provider: AuthProvider): void {
    this.activeProvider = provider;
    // A failure belongs to the method that produced it. Carrying it across to
    // the other method would accuse a path the user has not tried yet.
    this.error = null;
    // Same argument for the in-flight flag, plus a recovery: reaching the
    // switch at all proves the redirect did not take, so the user has a way
    // back to a working button that does not involve reloading the page.
    this.oauthPending = null;
  }

  isProviderActive(provider: AuthProvider): boolean {
    return this.activeProvider === provider;
  }

  /**
   * Arrow / Home / End move the selection, per the WAI-ARIA tabs pattern for
   * automatic activation. Selecting on arrow costs nothing here — switching
   * method mounts a field, not a fetch — and saves a keystroke.
   */
  onMethodKeydown(event: KeyboardEvent): void {
    const count = this.providers.length;
    if (count === 0) {
      return;
    }

    // `-1` folded to 0 so a selection that is not in the list still moves from
    // a defined starting point rather than from nowhere.
    const current = Math.max(
      0,
      this.providers.findIndex((option) => option.id === this.activeProvider),
    );

    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (current + 1) % count;
        break;
      case 'ArrowLeft':
        // `+ count` before the modulo: JavaScript's `%` keeps the sign of the
        // left operand, so `-1 % 2` is `-1`, not `1`.
        next = (current - 1 + count) % count;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      default:
        return;
    }

    // Only once the key is known to be handled — preventing the default for
    // every keystroke would swallow the browser's own shortcuts.
    event.preventDefault();
    this.selectProvider(this.providers[next].id);
    this.methodButtons()[next]?.nativeElement.focus();
  }

  /**
   * Where a provider's sign-in starts.
   *
   * Split out from the navigation below so the URL is assertable: a spec that
   * called `loginOAuth` would take the test runner with it.
   */
  oauthUrl(provider: AuthProvider): string {
    return `${this.apiBaseUrl}/auth/login/${provider}`;
  }

  /** Redirects to the backend OAuth login endpoint for any provider. */
  loginOAuth(provider: AuthProvider): void {
    // Recorded BEFORE the assignment, not after: this is a full-page
    // navigation, so nothing written after it is guaranteed to run.
    this.oauthPending = provider;
    window.location.href = this.oauthUrl(provider);
  }

  /**
   * Authenticates the user using API key.
   *
   * The request itself is unchanged: `AuthService` posts the key in the body,
   * the backend sets the session cookie, and the key is never persisted
   * client-side.
   */
  loginWithApiKey(): void {
    // Enter fires on the FIELD as well as the button, and only the button
    // carries `[disabled]` — so without this guard two quick presses were two
    // POSTs to `/auth/login/apikey`, racing each other for the session cookie.
    if (this.loading) {
      return;
    }

    if (!this.apiKey) {
      this.error = { kind: 'key', key: 'login.errors.emptyKey' };
      return;
    }

    this.loading = true;
    this.error = null;

    this.authService.loginWithApiKey(this.apiKey).subscribe({
      next: () => {
        // A non-error response means the backend established the session
        // cookie — the API key is never persisted client-side.
        this.loading = false;
        this.router.navigate(['/']);
      },
      error: (err: unknown) => {
        this.loading = false;
        this.error = toLoginError(err);
      },
    });
  }
}

/**
 * The server's own words win, and are rendered verbatim.
 *
 * Typed `unknown` rather than `any` because that is genuinely what an RxJS
 * error channel carries: a rejected `fetch`, an `HttpErrorResponse` and the
 * service's own `new Error('Invalid API key')` all arrive here and only the
 * shape tells them apart. The framework's own sentence is the last resort, so a
 * failure with nothing readable in it still says something.
 */
function toLoginError(err: unknown): LoginError {
  const shape = err as { error?: { error?: unknown }; message?: unknown } | null | undefined;

  const detail = shape?.error?.error;
  if (typeof detail === 'string' && detail.length > 0) {
    return { kind: 'text', text: detail };
  }

  const message = shape?.message;
  if (typeof message === 'string' && message.length > 0) {
    return { kind: 'text', text: message };
  }

  return { kind: 'key', key: 'login.errors.apiKeyFailed' };
}
