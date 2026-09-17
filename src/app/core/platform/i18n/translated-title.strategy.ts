import { Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';

/**
 * The document title, translated.
 *
 * Angular's default `TitleStrategy` takes the `title` string off the matched
 * route and hands it straight to `Title.setTitle`. That happens synchronously,
 * off a plain property — there is no binding and no pipe — so `TranslatePipe`
 * cannot reach it and the browser tab was the one user-visible surface in the
 * app still hardcoded to English. Switching the language relabelled every
 * control on the page and left the tab saying "Process page".
 *
 * So the route entries now carry translation KEYS and this strategy resolves
 * them. Two halves, and the second is the one that is easy to forget:
 *
 *  1. resolve on navigation — what the default does, plus a lookup;
 *  2. re-resolve on `onLangChange` — because a language switch is not a
 *     navigation. Without it the title would be correct only for pages entered
 *     AFTER the switch, which is worse than never translating it: it would be
 *     right often enough that the times it was wrong would read as random.
 *
 * The last resolved key is therefore held. It is a KEY and not the resolved
 * text, since the text is precisely what has to be recomputed.
 *
 * `instant()` rather than `get()`: the active language's dictionary is loaded
 * by an `APP_INITIALIZER` before the first navigation can happen (see
 * `app.config.ts`), so it is in memory by the time anything calls this, and an
 * async resolve would set the title one tick late on every page. A key that
 * genuinely misses comes back as itself — the same failure mode the untranslated
 * strings had, minus the pretence that it was English.
 */
@Injectable({ providedIn: 'root' })
export class TranslatedTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly translate = inject(TranslateService);

  /**
   * The key for the page currently shown, or `null` before the first
   * navigation and for any route that declares no title.
   */
  private currentKey: string | null = null;

  constructor() {
    super();
    this.translate.onLangChange
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.apply());
  }

  override updateTitle(snapshot: RouterStateSnapshot): void {
    // `buildTitle` walks to the DEEPEST route that declares a title, which is
    // why it is used rather than reading the snapshot's own `title`. Child
    // routes may grow later and this keeps working when they do.
    this.currentKey = this.buildTitle(snapshot) ?? null;
    this.apply();
  }

  /**
   * A route with no title leaves the tab ALONE rather than blanking it.
   *
   * Angular's default does the same, and the reason matters: the previous
   * page's title is stale, but an empty tab shows the URL, which is worse to
   * read and looks like a load failure.
   */
  private apply(): void {
    if (this.currentKey === null) {
      return;
    }
    this.title.setTitle(this.translate.instant(this.currentKey));
  }
}
