import { environment } from '../../../environments/environment';
import { ConfigService } from './config.service';

/**
 * Specs for {@link ConfigService}.
 *
 * The service has two kinds of getter and only one of them is worth a spec.
 * Most of them return a merged value and could not be wrong: `load()` puts the
 * deployment's `config.json` over the build-time defaults, and afterwards
 * `api`, `favicon`, `hideHome` and the rest just read the result.
 *
 * The interesting ones are the pair that asks a question the merge cannot
 * answer — "did this DEPLOYMENT choose the value, or did the framework?" —
 * because a default is a perfectly good answer for `api` and a wrong one for a
 * brand mark or a greeting. Both are implemented off the same `declared` set
 * and both have the same four edge cases (absent key, declared key, blank
 * declaration, no file at all), so they are specced side by side: a change that
 * makes them disagree should be visible in one file.
 *
 * These drive the REAL service, not a stub. The consuming components stub it,
 * which asserts what they do with an answer; this asserts how the answer is
 * reached. Both halves matter and they fail differently — stub the wrong shape
 * and the component specs go green against a service that cannot produce it.
 */
describe('ConfigService', () => {
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

  describe('brandLogo — what counts as "a deployment set one"', () => {
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

  /**
   * The same rule, for the welcome sentence.
   *
   * Two getters on purpose, and the difference between them is the feature:
   * `welcomeMessage` is what the LOGIN page reads, where the product greets a
   * visitor and has something to say even when nobody configured it;
   * `declaredWelcomeMessage` is for a surface that should stay silent rather
   * than put the framework's own sentence under a user's name.
   */
  describe('declaredWelcomeMessage — a deployment\'s sentence vs the framework\'s', () => {
    it('reports no sentence when config.json never mentions one', async () => {
      const config = await loadConfig({ api: 'http://backend.test' });

      // The framework default is untouched and still readable — the login page
      // depends on exactly that.
      expect(config.welcomeMessage).toBe(environment.welcomeMessage);
      expect(config.declaredWelcomeMessage).toBeNull();
    });

    it('reports the sentence a deployment did declare', async () => {
      // sdworx-sme's real value, markup and all: what a deployment declares is
      // handed back verbatim, and the decision about rendering the markup
      // belongs to the template that binds it.
      const config = await loadConfig({
        welcomeMessage: 'Welcome to SDWorx Akgents<sup>&reg;</sup>',
      });

      expect(config.declaredWelcomeMessage).toBe(
        'Welcome to SDWorx Akgents<sup>&reg;</sup>',
      );
    });

    it('honours a declaration that happens to repeat the framework default', async () => {
      // Explicit is explicit, exactly as for the logo. A deployment that typed
      // the framework's sentence out chose it, and gets to keep the line.
      const config = await loadConfig({
        welcomeMessage: environment.welcomeMessage,
      });

      expect(config.declaredWelcomeMessage).toBe(environment.welcomeMessage);
    });

    it('treats a blank declaration as no sentence', async () => {
      // Otherwise a deployment that cleared the key would get an empty line of
      // reserved space instead of a collapsed block.
      const config = await loadConfig({ welcomeMessage: '   ' });

      expect(config.declaredWelcomeMessage).toBeNull();
    });

    it('reports no sentence when config.json cannot be fetched at all', async () => {
      // Local dev again, and the same trade `brandLogo` already makes: with no
      // file there is nothing a deployment declared.
      const config = await loadConfig(null);

      expect(config.declaredWelcomeMessage).toBeNull();
    });

    it('answers independently of whether a logo was declared', async () => {
      // One `declared` set backs both getters; this is the spec that fails if
      // somebody ever narrows it to the key that needed it first.
      const config = await loadConfig({ logo: 'sdworx-logo.svg' });

      expect(config.brandLogo).toBe('sdworx-logo.svg');
      expect(config.declaredWelcomeMessage).toBeNull();
    });
  });

  /**
   * W18 — the per-deployment tab filter.
   *
   * Worth a spec despite being a plain read, for the one reason the header of
   * this file gives: this key is OPTIONAL, so the merge cannot fill it, and the
   * value a caller gets when a deployment never mentioned it is a decision
   * rather than a default. `undefined` reaching `new Set(...)` would hide
   * nothing — right by accident, and wrong the moment anybody iterates it.
   */
  describe('hiddenInspectorTabs — a deployment turning tabs off', () => {
    it('hides nothing for a config.json that predates the key', async () => {
      const config = await loadConfig({ api: 'http://backend.test' });

      expect(config.hiddenInspectorTabs).toEqual([]);
    });

    it('hides nothing when there is no config.json at all', async () => {
      const config = await loadConfig(null);

      expect(config.hiddenInspectorTabs).toEqual([]);
    });

    it('reports the tabs a deployment named, in the order it named them', async () => {
      const config = await loadConfig({
        hiddenInspectorTabs: ['messages', 'member'],
      });

      expect(config.hiddenInspectorTabs).toEqual(['messages', 'member']);
    });

    it('accepts an empty list as "hide nothing" rather than as absent', async () => {
      const config = await loadConfig({ hiddenInspectorTabs: [] });

      expect(config.hiddenInspectorTabs).toEqual([]);
    });
  });
});
