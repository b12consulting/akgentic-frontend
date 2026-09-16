import { APP_INITIALIZER, ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { TitleStrategy, provideRouter } from '@angular/router';

import { routes } from './app.routes';

import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { MARKED_OPTIONS, provideMarkdown } from 'ngx-markdown';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';

import {
  HTTP_INTERCEPTORS,
  provideHttpClient,
  withInterceptorsFromDi,
} from '@angular/common/http';
import customPreset from './app.theme';
import { CredentialsInterceptor } from './core/auth/credentials.interceptor';
import { markedOptionsFactory } from './app.markdown';
import { ConfigService } from './core/config/config.service';
import { NOTIFICATION_PORT } from './core/notification/notification.port';
import { PrimeNgNotificationAdapter } from './ui/console/notification.adapter';
import { I18nService } from './core/i18n/i18n.service';
import { provideI18n } from './core/i18n/i18n.providers';
import { TranslatedTitleStrategy } from './core/i18n/translated-title.strategy';

export const appConfig: ApplicationConfig = {
  providers: [
    MessageService,
    // Story 53-1 (ADR-035 §D6.1): bind the data layer's notification port to
    // PrimeNG here, at the composition root, so `core/` and `services/` name no
    // UI framework. Root scope reaches both the `providedIn: 'root'` services and
    // the route-scoped event units on `process/:id`.
    //
    // `MessageService` above stays: the adapter injects it, and `ui/` components
    // legitimately use it directly. Removing PrimeNG from `ui/` is not this
    // story's business and not this epic's.
    { provide: NOTIFICATION_PORT, useClass: PrimeNgNotificationAdapter },
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideAnimationsAsync(),
    providePrimeNG({
      theme: {
        preset: customPreset,
        options: {
          darkModeSelector: 'none',
        },
      },
    }),
    provideMarkdown({
      markedOptions: {
        provide: MARKED_OPTIONS,
        useFactory: markedOptionsFactory,
      },
    }),
    provideHttpClient(withInterceptorsFromDi()),
    // Always register — the interceptor checks hideLogin at runtime
    {
      provide: HTTP_INTERCEPTORS,
      useClass: CredentialsInterceptor,
      multi: true,
    },
    provideI18n(),
    // The browser tab, translated. Angular's default strategy writes the
    // route's `title` string verbatim, which left the tab in English on every
    // deployment — see `TranslatedTitleStrategy` for why a pipe cannot reach
    // it and why the strategy also listens to `onLangChange`.
    { provide: TitleStrategy, useClass: TranslatedTitleStrategy },
    // Load runtime config, then resolve the language, before the app renders.
    //
    // One initializer rather than two, because the order matters and
    // APP_INITIALIZER gives no ordering guarantee: I18nService reads the offered
    // languages and the default off ConfigService, which are only right after
    // config.json has landed. Split into two initializers this works by luck.
    {
      provide: APP_INITIALIZER,
      useFactory: (config: ConfigService, i18n: I18nService) => async () => {
        await config.load();
        await i18n.init();
      },
      deps: [ConfigService, I18nService],
      multi: true,
    },
  ],
};
