import { Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  TranslateLoader,
  TranslateNoOpLoader,
  TranslateService,
  TranslationObject,
  provideTranslateService,
} from '@ngx-translate/core';

/**
 * Translation providers for specs.
 *
 * Any component that uses `TranslatePipe` — or that renders a child which does —
 * needs `TranslateService` in its `TestBed`, or the render throws. This is that
 * requirement in one place, so it does not become a paragraph of boilerplate
 * repeated across every component spec.
 *
 * `TranslateNoOpLoader` returns an empty dictionary for every language, so every
 * key misses and the missing-translation handler echoes the key back. That is
 * what makes NFR3 workable: a spec asserts `'home.create'`, not `'Create'`, and
 * survives the day the copy changes.
 *
 * **It does not survive a parameter.** A key with `{{ count }}` in it comes back
 * as the bare key with nothing substituted, so an assertion written against the
 * interpolated text passes or fails for reasons that have nothing to do with the
 * component. A spec that cares about a threaded parameter must register its own
 * deliberately non-shipping template — see `provideTranslateTestingWith`.
 */
export function provideTranslateTesting(): Provider[] {
  return provideTranslateService({
    // A language must be set, or `TranslatePipe` renders an empty string rather
    // than the key, and the failure message tells you nothing.
    lang: 'en',
    fallbackLang: 'en',
    loader: { provide: TranslateLoader, useClass: TranslateNoOpLoader },
  });
}

/**
 * Register translations for the current `TestBed`, for the specs that need a
 * *resolved* string rather than a key.
 *
 * There is exactly one legitimate reason to want one: a string that carries a
 * parameter. With the no-op loader the key comes back unsubstituted, so a spec
 * asserting that a count reached the template would pass whether the component
 * threaded the parameter or not — it would only be reading the key. Registering
 * a template with the token in it makes the assertion mean something again.
 *
 * The templates a spec registers here are **deliberately not the shipped copy**
 * — conventionally something obviously synthetic like `'<<{{ count }}>>'`. If a
 * spec registered the real English it would be pinning the copy through the back
 * door, which is the thing NFR3 exists to prevent.
 */
export function setTestTranslations(translations: TranslationObject, lang = 'en'): void {
  TestBed.inject(TranslateService).setTranslation(lang, translations, true);
}
