import { Injectable } from '@angular/core';
import { Environment, AuthProvider } from '../auth/auth.types';
import { environment } from '../../../environments/environment';

/**
 * Runtime configuration service.
 *
 * Fetches `config.json` relative to the document base href at app startup
 * (via APP_INITIALIZER) and merges it
 * over the build-time `environment.ts` defaults. In local dev (no config.json
 * served), the build-time defaults are used as-is.
 *
 * All components and services should inject this service instead of importing
 * `environment` directly.
 */
@Injectable({ providedIn: 'root' })
export class ConfigService {
  private config: Environment = { ...environment };

  /**
   * The keys the deployment's own `config.json` actually declared.
   *
   * `load()` merges the file over the build-time defaults, and after the merge
   * the two are indistinguishable: every key is present and every key has a
   * value, whether a deployment chose it or the framework did. For most keys
   * that is fine — a default IS the answer. For `logo` it is not, because the
   * framework's default and a deployment's own mark have to be drawn
   * DIFFERENTLY (see `brandLogo`), and telling them apart needs the one fact
   * the merge throws away: whether the file mentioned the key at all.
   *
   * Recorded for every key rather than for `logo` alone so the next key that
   * needs the same distinction does not have to re-invent the bookkeeping.
   */
  private declared = new Set<string>();

  /** Called once by APP_INITIALIZER before the app renders. */
  async load(): Promise<void> {
    try {
      const response = await fetch(new URL('config.json', document.baseURI));
      if (response.ok) {
        const runtime = (await response.json()) as Partial<Environment>;
        this.declared = new Set(Object.keys(runtime));
        this.config = { ...this.config, ...runtime };
      }
    } catch {
      // config.json not available (local dev) — use build-time defaults
    }
  }

  get api(): string {
    return this.config.api;
  }

  /**
   * The configured logo path, defaults included.
   *
   * Kept because it is what `Environment.logo` means, but it is almost never
   * the thing a caller wants: it answers "what path would we load" and not
   * "does this deployment HAVE a mark of its own". Drawing this value
   * unconditionally is how the framework's own `akgent_logo.png` — a raster of
   * the same "Akgents / by Yuma" wordmark the console sets in type — ended up
   * on screen beside the wordmark, twice, on every deployment that had never
   * configured anything. Use `brandLogo`.
   */
  get logo(): string {
    return this.config.logo;
  }

  /**
   * The deployment's OWN brand mark, or `null` when it never set one.
   *
   * THE RULE, and it is the same rule in every place a mark is drawn (the
   * login masthead and the rail's brand row): the typographic wordmark is the
   * default, and an explicitly configured logo REPLACES it. Never both — the
   * framework default is a raster of that very wordmark, so stacking them
   * draws one brand twice, and a white-label deployment that set its own mark
   * does not want the framework's wordmark under it either.
   *
   * "EXPLICITLY CONFIGURED" MEANS: the deployment's `config.json` declares a
   * `logo` key with a non-blank value. Not "differs from the built-in value" —
   * that would need this file to hold a second copy of `environment.logo` to
   * compare against, which goes stale the day somebody edits one of them. And
   * not "is truthy", which is every deployment, because the build-time default
   * is truthy by construction.
   *
   * `config.json` is the supported white-label channel — it is the file a
   * deployment ships (sdworx-sme's sets `"logo": "sdworx-logo.svg"`), and the
   * reason this service exists at all rather than components reading
   * `environment` directly. A fork that edits `environment.ts` instead is
   * editing the framework's own defaults, and gets the framework's own
   * treatment: the wordmark. That is the documented boundary, not an oversight.
   *
   * Blank is `null` rather than `''`: `<img src="">` re-requests the current
   * document, so an empty string is a broken image AND a wasted round trip
   * rather than "no logo".
   */
  get brandLogo(): string | null {
    if (!this.declared.has('logo')) {
      return null;
    }
    const configured = this.config.logo;
    return typeof configured === 'string' && configured.trim().length > 0
      ? configured
      : null;
  }

  /**
   * The configured welcome sentence, defaults included.
   *
   * This is the value the LOGIN page wants: a signed-out visitor is being
   * greeted by the product, and the product has a sentence of its own to say
   * when a deployment chose none. Callers that are greeting a user BY NAME want
   * `declaredWelcomeMessage` instead — see the rule there.
   */
  get welcomeMessage(): string {
    return this.config.welcomeMessage;
  }

  /**
   * The deployment's OWN welcome sentence, or `null` when it never set one.
   *
   * Same rule as `brandLogo`, for the same reason and via the same `declared`
   * bookkeeping: after the merge a framework default and a deployment's choice
   * are indistinguishable, and there are surfaces where only one of them earns
   * a line. "Good morning, Hugo. Welcome to the Akgentic Framework." over a
   * teams list is the framework introducing itself to the people who maintain
   * it — a sentence nobody wrote, taking a line from a table that has to stay
   * above the fold. A deployment that DID write one ("Welcome to SDWorx
   * Akgents<sup>&reg;</sup>") has said something worth the line.
   *
   * "DECLARED" means the same thing as it does for the logo: `config.json`
   * mentions the key with a non-blank value. Not "differs from the built-in
   * string" — that would need a second copy of `environment.welcomeMessage`
   * here to compare against, which goes stale the day somebody edits one of
   * them. Blank is `null` and not `''` so a whitespace-only declaration
   * collapses the block rather than drawing an empty paragraph.
   *
   * The local-dev trade is `brandLogo`'s: `declared` is only filled when the
   * fetch succeeds, so a developer running without a served `config.json` gets
   * `null` — the same answer a deployment that configured nothing gets, which
   * is the answer that matches what they configured.
   *
   * `welcomeMessage` deliberately stays as it is. The login page must go on
   * showing the framework default it shows today; switching that read too would
   * silently blank a sentence on every unconfigured deployment.
   */
  get declaredWelcomeMessage(): string | null {
    if (!this.declared.has('welcomeMessage')) {
      return null;
    }
    const configured = this.config.welcomeMessage;
    return typeof configured === 'string' && configured.trim().length > 0
      ? configured
      : null;
  }

  get loginProviders(): AuthProvider[] {
    return this.config.loginProviders;
  }

  get autoRedirectContext(): string {
    return this.config.autoRedirectContext;
  }

  get hideHome(): boolean {
    return this.config.hideHome;
  }

  get hideLogin(): boolean {
    return this.config.hideLogin;
  }

  /** Hide the agent identity on chat bubbles. Defaults to showing it. */
  get hideAgentNames(): boolean {
    return this.config.hideAgentNames;
  }

  get initRightPanelCollapsed(): boolean {
    return this.config.initRightPanelCollapsed;
  }

  /**
   * Start with the team rail collapsed. See `Environment.initRailCollapsed`.
   *
   * `?? false` rather than a non-null assertion: this key post-dates every
   * `config.json` in the field, and `load()` merges whatever the file holds
   * over the build-time defaults without filling gaps. Reading it raw would
   * hand `undefined` to a `BehaviorSubject<boolean>` — which is falsy, so it
   * would look correct until something compared it with `===`.
   */
  get initRailCollapsed(): boolean {
    return this.config.initRailCollapsed ?? false;
  }

  /**
   * Inspector tabs this deployment has switched off. See
   * `Environment.hiddenInspectorTabs`.
   *
   * `?? []` rather than a non-null assertion, for the reason spelled out on
   * `initRailCollapsed`: the key post-dates every `config.json` in the field
   * and `load()` fills no gaps, so reading it raw hands `undefined` to a
   * `Set` constructor that would then hide nothing — right by accident, until
   * somebody iterated it.
   *
   * `readonly` on the way out because the array is the LIVE config object's,
   * not a copy: a caller that sorted or spliced it would be editing the
   * deployment's configuration for the rest of the session.
   */
  get hiddenInspectorTabs(): readonly string[] {
    return this.config.hiddenInspectorTabs ?? [];
  }

  get userInputEnterKeySubmit(): boolean {
    return this.config.userInputEnterKeySubmit;
  }

  get favicon(): string {
    return this.config.favicon;
  }

  get production(): boolean {
    return this.config.production;
  }

  /** The languages this deployment offers. See `Environment.languages`. */
  get languages(): string[] {
    return this.config.languages;
  }

  /** The per-key fallback language. See `Environment.defaultLanguage`. */
  get defaultLanguage(): string {
    return this.config.defaultLanguage;
  }
}
