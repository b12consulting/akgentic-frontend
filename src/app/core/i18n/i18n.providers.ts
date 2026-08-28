import { Provider } from '@angular/core';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';

import { LocaleAssetLoader } from './locale.loader';

/**
 * The translation layer's providers, in one place.
 *
 * Deliberately configures **neither** `lang` nor `fallbackLang`.
 * `TranslateService`'s constructor acts on both immediately, and at
 * injector-construction time the store is still empty — so either one would
 * send the loader after `i18n/en.json` over the network in a deployment that
 * configured nothing at all, which is exactly the round trip NFR2 forbids.
 *
 * `I18nService.init()` sets both, in the right order, once it has seeded the
 * compiled-in dictionary and read the configuration. It is awaited by the app
 * initializer, so nothing renders in between and no component observes the
 * unconfigured state.
 */
export function provideI18n(): Provider[] {
  return provideTranslateService({
    loader: { provide: TranslateLoader, useClass: LocaleAssetLoader },
  });
}
