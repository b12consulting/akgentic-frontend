import { AfterViewInit, Component, DestroyRef, inject, OnInit, ViewChild } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';

import { CommonModule, Location } from '@angular/common';
import { Toast, ToastModule } from 'primeng/toast';
import { Observable, combineLatest } from 'rxjs';
import { distinctUntilChanged, filter, map, startWith } from 'rxjs/operators';

import { ConsoleShellComponent } from './ui/console/console-shell.component';
import { TeamCreationDialogComponent } from './ui/console/team-creation/team-creation-dialog.component';
import { ApiService } from './core/http/api.service';
import { AuthService } from './core/auth/auth.service';
import { ConfigService } from './core/config/config.service';
import { FaviconService } from './core/config/favicon.service';
import { NotificationToastService } from './ui/console/notification-toast.service';
import { TeamCreationLauncher } from './ui/console/team-creation-launcher.service';

/**
 * The routes that render WITHOUT the app frame.
 *
 * A list here rather than a flag on the route definition (`data: { bare: true }`)
 * because the answer is needed BEFORE the router has produced a snapshot — see
 * `bareRoute$` for why the first paint cannot wait for a `NavigationEnd`.
 */
const BARE_ROUTE_PATHS = new Set<string>(['/login']);

/**
 * Whether a serialized URL is one of the bare routes.
 *
 * The router hands out the serialized form, so query params and the fragment
 * have to come off before the path can be matched: a guard redirect arrives as
 * `/login?next=%2Fprocess%2F1`, and an exact `=== '/login'` would let the frame
 * back in on exactly the navigation that redirected away from it. A trailing
 * slash is the same route.
 */
function isBareRoute(url: string): boolean {
  const path = url.split('?')[0].split('#')[0].replace(/\/$/, '');
  return BARE_ROUTE_PATHS.has(path || '/');
}

/**
 * The application root.
 *
 * Epic 56 emptied this component out. It used to carry the whole of the app
 * chrome: a `p-menubar` whose items were rebuilt from a three-way
 * `combineLatest` over the open team, the session and the inspector's collapse
 * state, plus a language-change subscription to rebuild them again because
 * PrimeNG takes resolved strings rather than keys. All of it is gone — the menu
 * redistributed into the rail (logo, account, all-teams) and the conversation
 * header (team name, status, Clear, Details), each of which reads the state it
 * needs where it is rendered instead of having it pushed down from the root.
 *
 * What is left is the frame and two overlays, and the three are unrelated to
 * each other:
 *   - the shell, told only whether to draw the chrome;
 *   - the app's ONE `<p-toast>` mount, which stories 31-3/31-5 depend on being
 *     exactly one and being owned here;
 *   - the team-creation wizard, mounted only while it is open.
 *
 * BOTH OVERLAYS ARE SIBLINGS OF THE SHELL, for the same reason and a second
 * one. The shared reason is clipping: they are positioned against the viewport,
 * and nesting either in the shell's `overflow: hidden` flex row would simply
 * hide it. The wizard adds its own — the control that opens it is in the rail,
 * and a collapsed rail is `inert` + `aria-hidden`, so a dialog mounted there
 * would become untypeable the moment the user collapsed the rail behind it.
 *
 * This root component still subscribes to NONE of the wizard's state. It reads
 * one boolean off `TeamCreationLauncher` to decide whether the dialog exists;
 * everything a creation-in-progress knows lives on the dialog component, which
 * is created and destroyed with the `@if`.
 */
@Component({
  selector: 'app-root',
  imports: [
    CommonModule,
    RouterOutlet,
    ToastModule,
    ConsoleShellComponent,
    TeamCreationDialogComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, AfterViewInit {
  private configService = inject(ConfigService);

  /**
   * Whether the creation wizard is on screen. PUBLIC because the template's
   * `@if` reads it; nothing here writes it — the rail opens the wizard and the
   * wizard closes itself.
   */
  readonly creationLauncher = inject(TeamCreationLauncher);

  /**
   * Community tier runs with no login at all, so there is no user to wait for
   * and the chrome must still be drawn. Read once, in `ngOnInit`, because
   * `ConfigService` is only populated after the `APP_INITIALIZER` has fetched
   * `config.json`.
   */
  hideLogin = true;

  authService: AuthService = inject(AuthService);
  destroyRef = inject(DestroyRef);
  faviconService = inject(FaviconService);
  apiService = inject(ApiService);

  private router = inject(Router);
  private location = inject(Location);

  /**
   * Is the CURRENT route one that renders bare?
   *
   * Two sources, because neither alone is correct at both ends of the app's
   * life:
   *
   *   - `NavigationEnd` is the authority once the router is running, and
   *     `urlAfterRedirects` is the url that matters — `AuthGuard` answers a
   *     rejected activation by navigating to `/login`, and a guard returning a
   *     `UrlTree` would leave `event.url` pointing at the route it refused.
   *   - `Location.path()` is the authority BEFORE the router is running.
   *     `provideRouter` is registered without `withEnabledBlockingInitialNavigation`,
   *     so the initial navigation is kicked off by a bootstrap listener that
   *     runs AFTER the root view's first `tick()`. For that first pass
   *     `Router.url` is still `'/'` on every deep link, which on `/login` is
   *     precisely the frame-flash this rule exists to prevent. `Location`
   *     reads the browser's address bar and does not wait for the router.
   *
   * Seeding `false` instead would trade that flash for a missing rail lasting
   * the whole of `AuthGuard`'s session fetch on every normal load, which is the
   * worse of the two.
   */
  private bareRoute$: Observable<boolean> = this.router.events.pipe(
    filter((event): event is NavigationEnd => event instanceof NavigationEnd),
    map((event) => isBareRoute(event.urlAfterRedirects)),
    startWith(isBareRoute(this.location.path() || '/')),
    distinctUntilChanged(),
  );

  /**
   * Whether the shell draws the app frame (currently: the team rail).
   *
   * THE ROUTE IS A VETO, not one vote among two. `currentUser$` cannot answer
   * this question: `AuthService` seeds its subject with an anonymous sentinel
   * and re-emits that same sentinel on a 401, so `!!user` is true for a visitor
   * who has never signed in — which is how the rail came to render beside the
   * login card, offering "No teams yet" and an account footer reading
   * "Anonymous". `hideLogin` cannot answer it either: `/login` carries no
   * guard, so a community-tier deployment can still reach it by url.
   *
   * So the auth terms are kept — they still decide the frame on every OTHER
   * route — and the route gates them unconditionally.
   *
   * Exposed as an observable and consumed through `async` so the subscription
   * dies with the view. A hand-rolled one on `router.events` (a root-scoped
   * subject that outlives every component) is the shape the frame's leak specs
   * exist to catch.
   */
  chromeVisible$: Observable<boolean> = combineLatest([
    this.bareRoute$,
    this.authService.currentUser$,
  ]).pipe(
    // `hideLogin` is read at emission time, not capture time: it is only
    // truthful after `ngOnInit`, and every source here emits on subscribe —
    // which the template does after the hooks have run.
    map(([bare, user]) => !bare && (!!user || this.hideLogin)),
    distinctUntilChanged(),
  );

  /**
   * Story 31-5: the app's one and only toast container. Handed to
   * `NotificationToastService` so a `ClosedNotification` arriving over the wire
   * can remove the toast it dismisses — see that service for why PrimeNG leaves
   * no other route to a single-toast removal.
   */
  @ViewChild(Toast) private toast?: Toast;
  private notificationToast = inject(NotificationToastService);

  ngAfterViewInit() {
    this.notificationToast.register(this.toast ?? null);
    this.destroyRef.onDestroy(() => this.notificationToast.register(null));
  }

  ngOnInit() {
    this.hideLogin = this.configService.hideLogin;
    this.faviconService.setFavicon(this.configService.favicon);

    // Fetch the authenticated user from the backend session. Nothing here
    // subscribes to the RESULT: the rail and the shell read `currentUser$`
    // where they render it, so this call exists only to populate that subject.
    this.authService.checkAuth().subscribe();
  }

  /**
   * Story 31-4: record a dismissed notification toast on the team's event
   * stream, so it stays dismissed across reloads.
   *
   * This handler lives on `AppComponent` and not in `IngestionService` because
   * the close hook only exists on the `<p-toast>` element: PrimeNG's
   * `MessageService` has no close observer, and `app.component.html` mounts the
   * app's only toast. Everything `showNotificationToast` put in `data` is
   * re-emitted verbatim by `Toast.onMessageClose`, which is the only reason the
   * ids survive to here.
   *
   * Every other toast in the app (disconnect, errors, save confirmations)
   * carries no `data.messageId` and must issue no POST at all — hence the early
   * return rather than a best-effort fallback to the current route's team.
   *
   * The POST is fire-and-forget with a terminal `.catch`: the handler is a
   * `void` DOM callback so it cannot `await`, and a failure here is already
   * surfaced by `FetchService`'s own error toast. Logging a second time is the
   * whole error policy — see the story's route table for the 400/404/409 cases.
   */
  onToastClose(event: {
    message?: { data?: { messageId?: string; teamId?: string } };
  }): void {
    const data = event?.message?.data;
    const messageId = data?.messageId;
    const teamId = data?.teamId;
    if (!messageId || !teamId) return;

    this.apiService
      .emitClosedNotification(teamId, messageId)
      .catch((err: unknown) => {
        console.error('Failed to record notification dismissal:', err);
      });
  }
}
