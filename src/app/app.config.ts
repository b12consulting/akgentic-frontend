import { APP_INITIALIZER, ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';

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
import { markedOptionsFactory } from './shared/util/util';
import { ConfigService } from './core/config/config.service';
import { I18nService } from './core/i18n/i18n.service';
import { provideI18n } from './core/i18n/i18n.providers';

export const appConfig: ApplicationConfig = {
  providers: [
    MessageService,
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
