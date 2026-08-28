import { Injectable } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, TranslateService, TranslationObject } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';

import { ConfigService } from '../config/config.service';
import { BUILT_IN_LANGUAGE, I18nService, LANGUAGE_STORAGE_KEY } from './i18n.service';
import { provideI18n } from './i18n.providers';

/**
 * Stands in for the network. Every language it is asked for resolves to a
 * dictionary carrying that language's own marker string, so a spec can tell
 * which locale actually won without asserting on shipped copy.
 */
@Injectable()
class StubLoader implements TranslateLoader {
  readonly asked: string[] = [];

  getTranslation(lang: string): Observable<TranslationObject> {
    this.asked.push(lang);
    return of({ marker: `from:${lang}` });
  }
}

/** Give `navigator.language` a value, and take it back afterwards. */
function overrideNavigatorLanguage(value: string): void {
  Object.defineProperty(navigator, 'language', {
    value,
    configurable: true,
  });
}

function restoreNavigatorLanguage(): void {
  delete (navigator as unknown as Record<string, unknown>)['language'];
}

describe('I18nService', () => {
  let i18n: I18nService;
  let translate: TranslateService;
  let loader: StubLoader;
  let languages: string[];
  let defaultLanguage: string;

  function configure(): void {
    TestBed.configureTestingModule({
      providers: [
        provideI18n(),
        // After provideI18n(), so it replaces the real asset loader rather than
        // racing it. The real loader has its own spec.
        { provide: TranslateLoader, useClass: StubLoader },
        {
          provide: ConfigService,
          useValue: {
            get languages() {
              return languages;
            },
            get defaultLanguage() {
              return defaultLanguage;
            },
          },
        },
      ],
    });
    i18n = TestBed.inject(I18nService);
    translate = TestBed.inject(TranslateService);
    loader = TestBed.inject(TranslateLoader) as unknown as StubLoader;
  }

  beforeEach(() => {
    languages = [BUILT_IN_LANGUAGE];
    defaultLanguage = BUILT_IN_LANGUAGE;
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    restoreNavigatorLanguage();
  });

  describe('a deployment that configures nothing', () => {
    it('resolves the built-in language', async () => {
      configure();

      await expectAsync(i18n.init()).toBeResolvedTo(BUILT_IN_LANGUAGE);
      expect(i18n.currentLanguage).toBe(BUILT_IN_LANGUAGE);
    });

    // NFR2. The compiled-in dictionary is seeded before either setFallbackLang
    // or use() runs, so neither of them finds an empty store and reaches for the
    // loader. If this ever fails, a default deployment has grown a network round
    // trip in front of its first paint.
    it('never asks the loader for a locale file', async () => {
      configure();

      await i18n.init();

      expect(loader.asked).toEqual([]);
    });

    it('has the built-in strings resolved, not echoed as keys', async () => {
      configure();

      await i18n.init();

      // Any key from the compiled-in dictionary would do; asserting it differs
      // from the key is the point, not what it says.
      expect(translate.instant('common.create')).not.toBe('common.create');
    });

    it('ignores a language it does not offer, however it was asked for', async () => {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, 'de');
      overrideNavigatorLanguage('nl-BE');
      configure();
      spyOn(i18n, 'readQueryParam').and.returnValue('fr');

      await expectAsync(i18n.init()).toBeResolvedTo(BUILT_IN_LANGUAGE);
    });
  });

  describe('resolution order', () => {
    beforeEach(() => {
      languages = ['en', 'fr', 'nl'];
    });

    it('prefers a query parameter over everything else', async () => {
      configure();
      spyOn(i18n, 'readQueryParam').and.returnValue('fr');
      localStorage.setItem(LANGUAGE_STORAGE_KEY, 'nl');
      overrideNavigatorLanguage('nl-BE');

      await expectAsync(i18n.init()).toBeResolvedTo('fr');
    });

    it('prefers a remembered choice over the browser', async () => {
      configure();
      spyOn(i18n, 'readQueryParam').and.returnValue(null);
      localStorage.setItem(LANGUAGE_STORAGE_KEY, 'fr');
      overrideNavigatorLanguage('nl-BE');

      await expectAsync(i18n.init()).toBeResolvedTo('fr');
    });

    it('falls back to the browser when nothing was pinned or remembered', async () => {
      configure();
      spyOn(i18n, 'readQueryParam').and.returnValue(null);
      overrideNavigatorLanguage('nl-BE');

      await expectAsync(i18n.init()).toBeResolvedTo('nl');
    });

    it('falls back to the configured default when the browser asks for nothing offered', async () => {
      defaultLanguage = 'fr';
      configure();
      spyOn(i18n, 'readQueryParam').and.returnValue(null);
      overrideNavigatorLanguage('de-DE');

      await expectAsync(i18n.init()).toBeResolvedTo('fr');
    });
  });

  describe('readQueryParam', () => {
    it('reads ?language=', () => {
      configure();

      expect(i18n.readQueryParam('?language=fr')).toBe('fr');
    });

    it('reads ?lang= as well, because both were always accepted', () => {
      configure();

      expect(i18n.readQueryParam('?lang=fr&other=1')).toBe('fr');
    });

    it('prefers ?language= when a URL carries both', () => {
      configure();

      expect(i18n.readQueryParam('?lang=nl&language=fr')).toBe('fr');
    });

    it('is null when no language is pinned', () => {
      configure();

      expect(i18n.readQueryParam('?team=abc')).toBeNull();
    });

    it('is null for an empty value rather than resolving to an empty language', () => {
      configure();

      expect(i18n.readQueryParam('?lang=')).toBeNull();
    });
  });

  describe('normalize', () => {
    beforeEach(() => {
      languages = ['en', 'fr'];
      configure();
    });

    it('accepts an offered language unchanged', () => {
      expect(i18n.normalize('fr')).toBe('fr');
    });

    it('accepts a region-qualified tag by its base, which is what a browser reports', () => {
      expect(i18n.normalize('fr-BE')).toBe('fr');
      expect(i18n.normalize('fr_BE')).toBe('fr');
      expect(i18n.normalize('FR-be')).toBe('fr');
    });

    it('rejects a language this deployment does not offer', () => {
      expect(i18n.normalize('de')).toBeNull();
      expect(i18n.normalize('de-DE')).toBeNull();
    });

    it('rejects nothing at all', () => {
      expect(i18n.normalize('')).toBeNull();
      expect(i18n.normalize(null)).toBeNull();
      expect(i18n.normalize(undefined)).toBeNull();
    });
  });

  describe('setLanguage', () => {
    beforeEach(async () => {
      languages = ['en', 'fr'];
      configure();
      spyOn(i18n, 'readQueryParam').and.returnValue(null);
      overrideNavigatorLanguage('en');
      await i18n.init();
    });

    it('loads the language and makes it current', async () => {
      await i18n.setLanguage('fr');

      expect(i18n.currentLanguage).toBe('fr');
      expect(loader.asked).toContain('fr');
    });

    it('remembers the choice for the next visit', async () => {
      await i18n.setLanguage('fr');

      expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('fr');
    });

    it('ignores a language this deployment does not offer', async () => {
      await i18n.setLanguage('de');

      expect(i18n.currentLanguage).toBe(BUILT_IN_LANGUAGE);
      expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
    });

    it('does no work when the language is already current', async () => {
      const before = loader.asked.length;

      await i18n.setLanguage(BUILT_IN_LANGUAGE);

      expect(loader.asked.length).toBe(before);
    });
  });

  it('applies a language even when localStorage refuses to remember it', async () => {
    languages = ['en', 'fr'];
    configure();
    spyOn(i18n, 'readQueryParam').and.returnValue(null);
    overrideNavigatorLanguage('en');
    await i18n.init();
    // Private browsing and sandboxed frames throw outright on access.
    spyOn(Storage.prototype, 'setItem').and.throwError('QuotaExceededError');

    await expectAsync(i18n.setLanguage('fr')).toBeResolved();
    expect(i18n.currentLanguage).toBe('fr');
  });

  it('survives a localStorage that throws on read', async () => {
    languages = ['en', 'fr'];
    configure();
    spyOn(i18n, 'readQueryParam').and.returnValue(null);
    spyOn(Storage.prototype, 'getItem').and.throwError('SecurityError');
    overrideNavigatorLanguage('fr');

    await expectAsync(i18n.init()).toBeResolvedTo('fr');
  });
});
