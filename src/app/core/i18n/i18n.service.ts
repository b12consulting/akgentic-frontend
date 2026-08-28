import { Injectable, inject } from '@angular/core';
import { TranslateService, TranslationObject } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';

import { ConfigService } from '../config/config.service';
import builtInTranslations from './locales/en.json';

/**
 * The language whose strings are **compiled into the bundle**.
 *
 * Every other language is a static asset fetched at runtime; this one is not,
 * and that is what makes NFR1 and NFR2 true at the same time:
 *
 * - NFR1 — with no configuration at all, the app resolves to this language,
 *   finds its strings already in memory and renders exactly as it did before
 *   the layer existed.
 * - NFR2 — and it does so without a single network round trip that the app was
 *   not already making. A default deployment never fetches a locale file.
 *
 * `i18n/en.json` is *also* published as a static asset, from the same source
 * file, so a translator has the canonical key list to diff against. It is not
 * fetched at runtime.
 */
export const BUILT_IN_LANGUAGE = 'en';

/** Where a resolved language is remembered between visits. */
export const LANGUAGE_STORAGE_KEY = 'akgent.lang';

/** Query parameters that pin a language, most specific first. */
const QUERY_PARAM_KEYS = ['language', 'lang'];

/**
 * Resolves the active language, loads it, and remembers it.
 *
 * Resolution order — first match wins, and every candidate is normalised
 * against the languages this deployment actually offers:
 *
 * ```
 * ?language= / ?lang=   a link can pin a language
 *   → localStorage       what the user last chose here
 *   → navigator.language what their browser asks for
 *   → the configured default
 * ```
 *
 * Nothing in this file names a language other than the built-in one. Which
 * languages a deployment offers is configuration (FR2), so adding Dutch is a
 * `config.json` edit and a file drop, not a release.
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  private translate = inject(TranslateService);
  private config = inject(ConfigService);

  /** Languages this deployment offers. */
  get languages(): string[] {
    return this.config.languages;
  }

  /**
   * The language a missing key falls back to before it falls back to the key
   * itself. FR3: an empty label is worse than an English one.
   */
  get defaultLanguage(): string {
    return this.config.defaultLanguage;
  }

  /** The active language. Empty until `init()` has run. */
  get currentLanguage(): string {
    return this.translate.getCurrentLang();
  }

  /**
   * Resolve a language and load it.
   *
   * Awaited from the app initializer **after** `ConfigService.load()`, so the
   * offered set and the default are already known and no component can render a
   * raw key on first paint.
   */
  async init(): Promise<string> {
    // Seed the compiled-in dictionary before anything else. This is the middle
    // rung of the fallback chain, and seeding it synchronously is what stops
    // `use()` below reaching for the network in a default deployment.
    this.translate.setTranslation(BUILT_IN_LANGUAGE, builtInTranslations as TranslationObject);
    this.translate.addLangs(this.languages);

    // setFallbackLang, not the deprecated setDefaultLang: this is the one that
    // gives *per-key* fallback. A whole-file fallback would render blanks for a
    // partially translated locale, which is T5.
    await firstValueFrom(this.translate.setFallbackLang(this.defaultLanguage));

    const lang = this.resolve();
    await firstValueFrom(this.translate.use(lang));
    return lang;
  }

  /** Switch language, remember the choice, and load its strings. */
  async setLanguage(lang: string): Promise<void> {
    const resolved = this.normalize(lang);
    if (!resolved || resolved === this.currentLanguage) {
      return;
    }
    this.remember(resolved);
    await firstValueFrom(this.translate.use(resolved));
  }

  /**
   * Normalise a candidate to a language this deployment offers, or `null`.
   *
   * A region-qualified tag falls back to its base — `fr-BE` from
   * `navigator.language` resolves to `fr` — because a browser reports a
   * *locale* while this app offers *languages*.
   */
  normalize(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    const trimmed = value.trim().toLowerCase();
    if (this.isOffered(trimmed)) {
      return trimmed;
    }
    const base = trimmed.replace('_', '-').split('-')[0];
    return this.isOffered(base) ? base : null;
  }

  /** Read a language pin off a query string, if there is one. */
  readQueryParam(search: string): string | null {
    const params = new URLSearchParams(search);
    for (const key of QUERY_PARAM_KEYS) {
      const value = params.get(key);
      if (value) {
        return value;
      }
    }
    return null;
  }

  private resolve(): string {
    return (
      this.normalize(this.readQueryParam(window.location.search)) ??
      this.normalize(this.recalled()) ??
      this.normalize(navigator.language) ??
      this.defaultLanguage
    );
  }

  private isOffered(lang: string): boolean {
    return this.languages.includes(lang);
  }

  /** `localStorage` throws outright in private modes and sandboxed frames. */
  private recalled(): string | null {
    try {
      return localStorage.getItem(LANGUAGE_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  private remember(lang: string): void {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
    } catch {
      // A language that cannot be remembered is still worth applying.
    }
  }
}
