import { Injectable } from '@angular/core';
import { TranslateLoader, TranslationObject } from '@ngx-translate/core';
import { Observable, from } from 'rxjs';

/** Where locale files are served from, relative to the document base href. */
export const LOCALE_ASSET_PREFIX = 'i18n/';

/**
 * Loads a language from a **static asset** — `i18n/<lang>.json` next to
 * `config.json`.
 *
 * That is the whole point of FR5: a deployment adds a language by dropping a
 * file next to the bundle, not by rebuilding it. The bundle therefore must not
 * know which languages exist; it only knows how to ask for one.
 *
 * **Never throws and never rejects.** A locale that is absent, unreachable,
 * slow-and-then-500, or valid JSON that is not an object all resolve to `{}`.
 * That is not sloppiness: an empty dictionary is exactly what makes the
 * three-level fallback chain (active locale → fallback locale → the key itself)
 * degrade gracefully. If this rejected instead, `TranslateService.use()` would
 * reject, the app initializer would reject, and a missing translation file
 * would take down a working app over cosmetics.
 *
 * Deliberately **not** built on `HttpClient` or on `FetchService`: a locale is a
 * static asset. It needs no credentials, no interceptor and no error toast, and
 * routing it through the app's API plumbing would give it all three.
 */
@Injectable({ providedIn: 'root' })
export class LocaleAssetLoader implements TranslateLoader {
  getTranslation(lang: string): Observable<TranslationObject> {
    return from(this.load(lang));
  }

  private async load(lang: string): Promise<TranslationObject> {
    const url = new URL(`${LOCALE_ASSET_PREFIX}${lang}.json`, document.baseURI).href;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        return {};
      }
      const body: unknown = await response.json();
      return isDictionary(body) ? (body as TranslationObject) : {};
    } catch {
      return {};
    }
  }
}

function isDictionary(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
