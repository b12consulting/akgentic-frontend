import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { Router, TitleStrategy, provideRouter } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';

import { provideTranslateTesting, setTestTranslations } from '../../../../testing/i18n-testing';
import { TranslatedTitleStrategy } from './translated-title.strategy';

/**
 * Driven through a REAL `Router` rather than a hand-built snapshot.
 *
 * `TitleStrategy.buildTitle` reads the resolved title off a private symbol key
 * in `ActivatedRouteSnapshot.data`; a faked snapshot would either need that
 * symbol or would silently return `undefined`, and a spec that passes because
 * the strategy was handed nothing is worse than no spec. Navigating for real
 * exercises the same path the app does.
 *
 * The translations registered here are deliberately synthetic (`<<…>>`), not
 * the shipped copy — the assertions are about a key being RESOLVED, and pinning
 * English here would pin the copy through the back door.
 */
@Component({ standalone: true, template: '' })
class BlankComponent {}

describe('TranslatedTitleStrategy', () => {
  let router: Router;
  let title: Title;
  let translate: TranslateService;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideTranslateTesting(),
        provideRouter([
          { path: 'titled', component: BlankComponent, title: 'spec.titled' },
          { path: 'other', component: BlankComponent, title: 'spec.other' },
          // No `title` at all — the case the strategy must leave alone.
          { path: 'untitled', component: BlankComponent },
        ]),
        { provide: TitleStrategy, useClass: TranslatedTitleStrategy },
      ],
    });

    router = TestBed.inject(Router);
    title = TestBed.inject(Title);
    translate = TestBed.inject(TranslateService);

    setTestTranslations({
      spec: { titled: '<<titled-en>>', other: '<<other-en>>' },
    });
    setTestTranslations({ spec: { titled: '<<titled-fr>>' } }, 'fr');
  });

  it('resolves the route title as a translation key', async () => {
    await router.navigateByUrl('/titled');
    expect(title.getTitle()).toBe('<<titled-en>>');
  });

  it('re-resolves the CURRENT title when the language changes', async () => {
    await router.navigateByUrl('/titled');
    expect(title.getTitle()).toBe('<<titled-en>>');

    // The half a navigation-only strategy misses: switching language is not a
    // navigation, so without the `onLangChange` subscription the tab would keep
    // the previous language until the user happened to move pages.
    translate.use('fr');
    expect(title.getTitle()).toBe('<<titled-fr>>');
  });

  it('re-resolves the LATEST title, not the first one it ever saw', async () => {
    // Pins that the held key is updated on every navigation. A strategy that
    // captured the key once would still pass the test above.
    await router.navigateByUrl('/titled');
    await router.navigateByUrl('/other');
    expect(title.getTitle()).toBe('<<other-en>>');

    // 'spec.other' has no French template, so it falls back to the English
    // one — the point here is that the key being re-resolved is `other`.
    translate.use('fr');
    expect(title.getTitle()).toBe('<<other-en>>');
  });

  it('leaves the tab alone for a route that declares no title', async () => {
    await router.navigateByUrl('/titled');
    await router.navigateByUrl('/untitled');

    // Stale, deliberately: blanking it would show the URL in the tab, which
    // reads as a failed load.
    expect(title.getTitle()).toBe('<<titled-en>>');
  });

  it('falls back to the key itself when nothing defines it', async () => {
    // Not a nicety — it is the documented failure mode, and pinning it means a
    // missing key shows up as `spec.*` in a tab rather than as an empty string
    // that looks like a rendering bug.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateTesting(),
        provideRouter([
          { path: 'titled', component: BlankComponent, title: 'spec.undefinedKey' },
        ]),
        { provide: TitleStrategy, useClass: TranslatedTitleStrategy },
      ],
    });
    const r = TestBed.inject(Router);
    await r.navigateByUrl('/titled');
    expect(TestBed.inject(Title).getTitle()).toBe('spec.undefinedKey');
  });
});
