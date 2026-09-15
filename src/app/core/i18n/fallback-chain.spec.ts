import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  TranslateLoader,
  TranslatePipe,
  TranslateService,
  TranslationObject,
} from '@ngx-translate/core';
import { Observable, of } from 'rxjs';

import { ConfigService } from '../config/config.service';
import { I18nService } from './i18n.service';
import { provideI18n } from './i18n.providers';

/**
 * The whole point of this spec is T5: the fallback chain has **three** rungs,
 * and it is one line of carelessness away from having two.
 *
 * ```
 * the active locale        →  the default locale  →  the key itself
 * (may be partial)            (fills the gaps)       (visible, greppable)
 * ```
 *
 * Collapse it to two by treating a whole locale file as present-or-absent and a
 * locale that translates 80% of the app renders the other 20% blank — which is
 * worse than English, and worse than a raw key, because nobody notices it.
 *
 * Every dictionary below is synthetic. None of it is shipped copy: pinning real
 * strings here would defeat NFR3 in the file that exists to defend it.
 */

/** A deliberately partial active locale over a complete default. */
const DEFAULT_LOCALE: TranslationObject = {
  spec: {
    inBoth: 'default-in-both',
    defaultOnly: 'default-only',
  },
};

const ACTIVE_LOCALE: TranslationObject = {
  spec: {
    inBoth: 'active-in-both',
  },
};

class SyntheticLoader implements TranslateLoader {
  getTranslation(lang: string): Observable<TranslationObject> {
    return of(lang === 'zz' ? ACTIVE_LOCALE : DEFAULT_LOCALE);
  }
}

@Component({
  selector: 'app-fallback-probe',
  standalone: true,
  imports: [TranslatePipe],
  template: `
    <span data-test="in-both">{{ 'spec.inBoth' | translate }}</span>
    <span data-test="default-only">{{ 'spec.defaultOnly' | translate }}</span>
    <span data-test="nowhere">{{ 'spec.nowhere' | translate }}</span>
  `,
})
class FallbackProbeComponent {}

describe('the translation fallback chain', () => {
  let fixture: ComponentFixture<FallbackProbeComponent>;

  function text(hook: string): string {
    return (
      fixture.nativeElement as HTMLElement
    ).querySelector(`[data-test="${hook}"]`)!.textContent!.trim();
  }

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [FallbackProbeComponent],
      providers: [
        provideI18n(),
        { provide: TranslateLoader, useClass: SyntheticLoader },
        {
          provide: ConfigService,
          // 'zz' is the active locale and is deliberately incomplete; 'yy' is
          // the default and has every key. Neither is a real language, so
          // nothing here can be mistaken for shipped configuration.
          useValue: { languages: ['zz', 'yy'], defaultLanguage: 'yy' },
        },
      ],
    });

    const i18n = TestBed.inject(I18nService);
    spyOn(i18n, 'readQueryParam').and.returnValue('zz');
    await i18n.init();

    fixture = TestBed.createComponent(FallbackProbeComponent);
    fixture.detectChanges();
  });

  it('rung 1: the active locale wins where it has the key', () => {
    expect(text('in-both')).toBe('active-in-both');
  });

  it('rung 2: the default locale fills a gap in the active one, per key', () => {
    expect(text('default-only')).toBe('default-only');
  });

  it('rung 3: a key missing from every locale renders as the key', () => {
    // FR4 — ugly on purpose. A blank here is invisible in review and
    // ungreppable in a bug report; 'spec.nowhere' is both.
    expect(text('nowhere')).toBe('spec.nowhere');
  });

  it('is the active locale that is current, not the default it borrowed from', () => {
    expect(TestBed.inject(TranslateService).getCurrentLang()).toBe('zz');
  });
});
