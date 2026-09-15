import { AsyncPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  Input,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { map, Observable } from 'rxjs';

import { AuthService } from '../../../core/auth/auth.service';
import { ConfigService } from '../../../core/config/config.service';
import { greetableNameOf, greetingKeyFor } from '../../../features/home/greeting/greeting';

/** The salutation, reduced to what the template threads into one pipe. */
export interface GreetingLine {
  /** A literal key from `greeting.ts` — addressed, or not. */
  readonly key: string;
  /** The `{{name}}` parameter. `''` when the key takes none. */
  readonly name: string;
}

/**
 * The teams page's header: a time-of-day salutation and, under it, the
 * deployment's own welcome sentence.
 *
 * A HEADER, NOT A LANDING. It sits ABOVE the existing list and the list stays
 * the page — this is not a composer landing with the teams pushed off it. That
 * is also why it is mounted by `home.component.html` and not by the shell: a
 * greeting that reappeared over the conversation on every route would stop
 * being a greeting and become a banner.
 *
 * ---------------------------------------------------------------------------
 * THE CLOCK IS AN INPUT
 * ---------------------------------------------------------------------------
 * `now` defaults to `new Date()` — ONE wall-clock read, at construction, in the
 * one place in this feature that is allowed to have one. Everything that acts
 * on it is a pure function in `greeting.ts`, so the six boundaries of the day
 * are asserted there with no fixture at all and a CI run at 23:59 cannot
 * exercise a different branch than a run at 09:00 and call both a pass.
 *
 * The greeting is computed at MOUNT and does not re-run at midday on a page
 * left open. `formatDayLabel` (day-separator.ts) rejects "Today"/"Yesterday"
 * for that exact reason, and the objection is genuinely weaker here: a
 * transcript's day rule is a record and must not lie, a salutation is a hello
 * and is about the moment you arrived. Re-deciding it under the reader — the
 * heading silently changing word while they read the table — would be the more
 * surprising behaviour, and buying it costs a timer this component would have
 * to own and tear down.
 *
 * ---------------------------------------------------------------------------
 * ANONYMOUS IS THE NORMAL CASE, NOT AN EDGE CASE
 * ---------------------------------------------------------------------------
 * A community-tier deployment (`hideLogin`) never signs anybody in, so the rail
 * footer's "Anonymous" is what most users have. The name-less sentence is a
 * first-class rendering rather than a fallback, and `greetableNameOf` is what
 * keeps the sentinel's untranslated English name off the screen.
 */
@Component({
  selector: 'app-home-greeting',
  imports: [AsyncPipe, TranslatePipe],
  templateUrl: './home-greeting.component.html',
  styleUrl: './home-greeting.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomeGreetingComponent {
  private readonly authService = inject(AuthService);
  private readonly configService = inject(ConfigService);

  /**
   * The clock. PASSED, not read, so a spec can name the instant it is about.
   *
   * The default is evaluated once per instance, at construction — the app's
   * only reading of the wall clock for this feature.
   */
  @Input() now: Date = new Date();

  /**
   * The welcome sentence, or `null` when this deployment never wrote one.
   *
   * `declaredWelcomeMessage`, NOT `welcomeMessage`. The framework default —
   * "Welcome to the Akgentic Framework" — is a sentence nobody chose, and over
   * a teams list it costs a line of a page whose job is to get the table above
   * the fold. Read undeclared, the block collapses to the salutation alone,
   * which is the shape an unconfigured deployment should have. The LOGIN page
   * deliberately keeps reading the raw value: there the sentence is the only
   * thing on the card, and blanking it would be a behaviour change nobody
   * asked for.
   *
   * `?? null` because a spec may stub `ConfigService` as a bare object literal
   * carrying only the keys it cares about — three of the home page's own specs
   * do — and an undefined read must collapse the block, not render "undefined".
   *
   * Resolved ONCE: `config.json` is fetched by an APP_INITIALIZER before the
   * app renders and never changes afterwards, so a getter would re-answer the
   * same question on every change-detection pass.
   */
  readonly welcomeMessage: string | null =
    this.configService.declaredWelcomeMessage ?? null;

  /**
   * Which sentence to render, and the name it takes.
   *
   * `this.now` is read inside the `map`, which runs when the template's `async`
   * pipe subscribes — after Angular has set the inputs — so a spec that assigns
   * `component.now` before the first change detection gets the instant it
   * named. `currentUser$` is a `BehaviorSubject`, so that subscription emits
   * immediately rather than leaving the header blank until `/auth/me` resolves;
   * when the real user does land, this re-emits and the salutation gains its
   * name.
   */
  readonly greeting$: Observable<GreetingLine> =
    this.authService.currentUser$.pipe(
      map((user: { name?: string; user_id?: string } | null) => {
        const name = greetableNameOf(user);
        return {
          key: greetingKeyFor(this.now, name !== null),
          // A person's name is not copy and is never translated; it is threaded
          // through the pipe as a parameter so the translator owns the sentence
          // around it and this component owns none of it.
          name: name ?? '',
        };
      }),
    );
}
