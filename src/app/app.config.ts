import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
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
import { environment } from '../environments/environment';
import customPreset from './app.theme';
import { CredentialsInterceptor } from './credentials.interceptor';
import { markedOptionsFactory } from './lib/util';

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
    ...(environment.hideLogin
      ? []
      : [
          {
            provide: HTTP_INTERCEPTORS,
            useClass: CredentialsInterceptor,
            multi: true,
          },
        ]),
  ],
};
