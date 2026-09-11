import { CommonModule } from '@angular/common';
import { Component, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { By } from '@angular/platform-browser';
import { Router, Routes } from '@angular/router';
import { RouterTestingModule } from '@angular/router/testing';
import { MessageService } from 'primeng/api';
import { BehaviorSubject, of } from 'rxjs';

import { AppComponent } from './app.component';
import { ConsoleShellComponent } from './components/console/console-shell.component';
import { TeamCreationDialogComponent } from './components/console/team-creation/team-creation-dialog.component';
import { TeamContext } from './core/context/team.interface';
import { ApiService } from './core/http/api.service';
import { AuthService } from './core/auth/auth.service';
import { ConfigService } from './core/config/config.service';
import { ContextService } from './core/context/context.service';
import { FaviconService } from './core/config/favicon.service';
import { NotificationToastService } from './core/ui/notification-toast.service';
import { TeamCreationLauncher } from './core/ui/team-creation-launcher.service';
import { ViewService } from './core/ui/view.service';

import { provideTranslateTesting } from '../testing/i18n-testing';

interface ContextStub {
  currentProcessId$: BehaviorSubject<string>;
  currentTeam$: BehaviorSubject<TeamContext | null>;
  currentTeamRunning$: BehaviorSubject<boolean>;
  getCurrentTeam: jasmine.Spy;
  clear: jasmine.Spy;
}

/**
 * Take the team rail out of the shell for the duration of a TestBed.
 *
 * The rail is B2's component with its own suite; what AppComponent owes it is
 * the SELECTOR and nothing else. Rendering the real one here would drag its
 * services into every block in this file and would turn a rail-internal change
 * into a root-component failure. Overriding the shell rather than AppComponent
 * keeps `<p-toast>` real, which the 31-3 and 31-5 blocks depend on. `*ngIf`
 * still comes from `CommonModule`, so whether the rail element is in the DOM is
 * still a live assertion.
 */
function stubRail(): void {
  TestBed.overrideComponent(ConsoleShellComponent, {
    set: { imports: [CommonModule], schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });
}

/**
 * A stand-in for the creation wizard, carrying its SELECTOR and nothing else.
 *
 * Same bargain as `stubRail`: what AppComponent owes the wizard is a mount
 * point and an `@if` around it. The real component fetches namespaces, provides
 * its own creation gate and injects a router; rendering it here would drag all
 * three into a suite about the app frame, and would turn a wizard-internal
 * change into a root-component failure. Whether the element is in the DOM stays
 * a live assertion, which is the only part AppComponent decides.
 */
@Component({ selector: 'app-team-creation-dialog', template: '' })
class TeamCreationDialogStubComponent {}

function stubCreationDialog(): void {
  TestBed.overrideComponent(AppComponent, {
    remove: { imports: [TeamCreationDialogComponent] },
    add: { imports: [TeamCreationDialogStubComponent] },
  });
}

/** An inert routed view. Only its URL matters to this file. */
@Component({ standalone: true, template: '' })
class BlankRouteComponent {}

/**
 * Enough routes for the router to actually navigate.
 *
 * `chromeVisible` is a fact about the URL, so the block below needs REAL
 * navigations rather than a stubbed `Router.url`: url matching, the
 * `NavigationEnd` stream and `Location` all have to be in play, because those
 * are the three things the rule is built from.
 */
const TEST_ROUTES: Routes = [
  { path: '', component: BlankRouteComponent },
  { path: 'login', component: BlankRouteComponent },
  { path: 'process/:id', component: BlankRouteComponent },
];

// ---------------------------------------------------------------------------
// Epic 56 — AppComponent as the console frame
//
// This block replaces the menubar suite that stood here. The menubar is gone,
// and with it the three-way `combineLatest` over the open team, the session and
// the inspector's collapse state, the `onLangChange` rebuild, and `buildMenu`.
// Its contents were redistributed — team name, status, Clear and Details to the
// conversation header; logo, account and All-teams to the rail — and each of
// those reads the state it needs where it is rendered.
//
// So the assertions that used to live here (AC12's "toggling the right column
// rebuilds the menubar", story 10-3's Hide/Show label, AC5's observer-leak
// count) are not deleted: they are RETARGETED at the property that survived
// them, which is that AppComponent subscribes to none of that state at all.
// ---------------------------------------------------------------------------

describe('AppComponent — the console frame (Epic 56)', () => {
  let fixture: ComponentFixture<AppComponent>;
  let component: AppComponent;
  let contextStub: ContextStub;
  let viewStub: {
    isRightColumnCollapsed$: BehaviorSubject<boolean>;
    isRailCollapsed$: BehaviorSubject<boolean>;
    toggleRightColumn: jasmine.Spy;
    toggleRail: jasmine.Spy;
  };
  let authStub: {
    currentUser$: BehaviorSubject<{ name?: string } | null>;
    checkAuth: jasmine.Spy;
    logout: jasmine.Spy;
  };
  let configStub: {
    logo: string;
    hideLogin: boolean;
    favicon: string;
    hideHome: boolean;
    initRailCollapsed: boolean;
    initRightPanelCollapsed: boolean;
  };
  let faviconStub: { setFavicon: jasmine.Spy };
  let apiStub: { getTeam: jasmine.Spy; getTeams: jasmine.Spy };

  beforeEach(async () => {
    contextStub = {
      currentProcessId$: new BehaviorSubject<string>(''),
      currentTeam$: new BehaviorSubject<TeamContext | null>(null),
      currentTeamRunning$: new BehaviorSubject<boolean>(false),
      getCurrentTeam: jasmine.createSpy('getCurrentTeam'),
      clear: jasmine.createSpy('clear'),
    };

    viewStub = {
      isRightColumnCollapsed$: new BehaviorSubject<boolean>(false),
      isRailCollapsed$: new BehaviorSubject<boolean>(false),
      toggleRightColumn: jasmine.createSpy('toggleRightColumn'),
      toggleRail: jasmine.createSpy('toggleRail'),
    };

    authStub = {
      currentUser$: new BehaviorSubject<{ name?: string } | null>({
        name: 'Alice',
      }),
      checkAuth: jasmine.createSpy('checkAuth').and.returnValue(of(true)),
      logout: jasmine.createSpy('logout'),
    };

    configStub = {
      logo: 'logo.png',
      hideLogin: true,
      favicon: 'favicon.ico',
      hideHome: false,
      initRailCollapsed: false,
      initRightPanelCollapsed: false,
    };

    faviconStub = { setFavicon: jasmine.createSpy('setFavicon') };
    apiStub = {
      getTeam: jasmine.createSpy('getTeam'),
      getTeams: jasmine.createSpy('getTeams'),
    };

    TestBed.configureTestingModule({
      imports: [
        AppComponent,
        NoopAnimationsModule,
        RouterTestingModule.withRoutes(TEST_ROUTES),
      ],
      providers: [
        provideTranslateTesting(),
        // The real `<p-toast>` stands in this block (AppComponent's own
        // ToastModule import is kept), and PrimeNG's Toast injects
        // MessageService — so the mount is only constructible with one here.
        // Keeping it real is what lets the "toast is outside the shell"
        // assertion below mean anything.
        MessageService,
        { provide: ContextService, useValue: contextStub },
        { provide: ViewService, useValue: viewStub },
        { provide: AuthService, useValue: authStub },
        { provide: ConfigService, useValue: configStub },
        { provide: FaviconService, useValue: faviconStub },
        { provide: ApiService, useValue: apiStub },
      ],
    });
    stubRail();
    stubCreationDialog();
    await TestBed.compileComponents();
  });

  /** Build the fixture AFTER the test has arranged the stubs it cares about. */
  async function render(): Promise<void> {
    fixture = TestBed.createComponent(AppComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /** The shell instance, so `chromeVisible` can be read as the bound input. */
  function shell(): ConsoleShellComponent {
    return fixture.debugElement.query(By.directive(ConsoleShellComponent))
      .componentInstance as ConsoleShellComponent;
  }

  function rail(): Element | null {
    return fixture.nativeElement.querySelector('app-console-rail');
  }

  /**
   * Put the router on `url` BEFORE the fixture exists.
   *
   * This is the deep-link arrangement: the address bar already says `/login`
   * when the root component is first rendered, which is the case the frame rule
   * has to get right on its FIRST paint and not one `NavigationEnd` later.
   */
  async function arriveAt(url: string): Promise<void> {
    await TestBed.inject(Router).navigateByUrl(url);
  }

  /** Navigate an already-rendered app, then let the view catch up. */
  async function navigateTo(url: string): Promise<void> {
    await TestBed.inject(Router).navigateByUrl(url);
    await settle();
  }

  it('should create', async () => {
    await render();
    expect(component).toBeTruthy();
  });

  // --- the frame --------------------------------------------------------

  it('renders the console shell, and the router outlet inside it', async () => {
    await render();

    const shellElement = fixture.nativeElement.querySelector('app-console-shell');
    expect(shellElement).not.toBeNull();

    // Projected, not a sibling: the routed view takes its height from the
    // shell's main column, and both scroll regions on /process/:id measure
    // off that chain.
    const outlet = fixture.nativeElement.querySelector('router-outlet');
    expect(outlet).not.toBeNull();
    expect(shellElement.contains(outlet)).toBeTrue();
  });

  it('mounts the toast OUTSIDE the shell, where nothing clips it', async () => {
    await render();

    const shellElement = fixture.nativeElement.querySelector('app-console-shell');
    const toast = fixture.nativeElement.querySelector('p-toast');
    expect(toast).not.toBeNull();
    // The shell is `overflow: hidden`; a viewport-positioned overlay nested
    // inside it would simply never appear.
    expect(shellElement.contains(toast)).toBeFalse();
  });

  it('renders no menubar — the chrome moved to the rail and the header', async () => {
    // The regression pin for the redistribution. If a menubar ever comes back
    // the app has two navigations for the same actions.
    await render();

    expect(fixture.nativeElement.querySelector('p-menubar')).toBeNull();
  });

  // --- chromeVisible ----------------------------------------------------
  //
  // The rule has two halves and they are NOT symmetrical. The route is a veto:
  // `/login` renders bare whatever the auth state says. Everywhere else, the
  // old auth terms still decide.
  //
  // Read the `currentUser$ | null` cases below with their limitation in mind.
  // The real `AuthService` cannot emit `null`: its subject is seeded with an
  // anonymous sentinel and re-emits that same sentinel on a 401 (auth.service.ts
  // lines 13, 41, 45). So those two tests pin a rule that is correct but that
  // production never exercises — which is exactly how the rail came to render
  // beside the login card while this file stayed green. The route tests further
  // down are the ones that cover the shipped code path.

  it('shows the chrome when a user is signed in', async () => {
    configStub.hideLogin = false;
    authStub.currentUser$.next({ name: 'Alice' });
    await render();

    expect(shell().chromeVisible).toBeTrue();
    expect(rail()).not.toBeNull();
  });

  it('hides the chrome when there is no user and the deployment has a login', async () => {
    // A signed-out visitor on a login-bearing deployment gets no rail. Kept for
    // the contract, but see the note above: the real service never produces the
    // `null` this arranges, so passing here proves nothing about `/login`.
    configStub.hideLogin = false;
    authStub.currentUser$.next(null);
    await render();

    expect(shell().chromeVisible).toBeFalse();
    expect(rail()).toBeNull();
  });

  it('shows the chrome with no user when the deployment has no login at all', async () => {
    // Community tier: `hideLogin` is the whole authorisation story, and there
    // is no user to wait for. Hiding the rail here would leave that tier with
    // no navigation whatsoever.
    configStub.hideLogin = true;
    authStub.currentUser$.next(null);
    await render();

    expect(shell().chromeVisible).toBeTrue();
    expect(rail()).not.toBeNull();
  });

  it('follows currentUser$ after boot, so a logout takes the chrome with it', async () => {
    // The auth half is still LIVE, not sampled once at init — a route-based
    // veto must not have frozen it.
    configStub.hideLogin = false;
    authStub.currentUser$.next({ name: 'Alice' });
    await render();
    expect(rail()).not.toBeNull();

    authStub.currentUser$.next(null);
    await settle();

    expect(shell().chromeVisible).toBeFalse();
    expect(rail()).toBeNull();
  });

  it('reads hideLogin from the config, not from a literal default', async () => {
    // `hideLogin` initialises to `true` on the class so an un-booted component
    // fails open rather than blank. That default must not survive ngOnInit.
    configStub.hideLogin = false;
    await render();

    expect(component.hideLogin).toBeFalse();
  });

  // --- the login route renders bare, whatever the auth state ---------------
  //
  // Every test in this section FAILS against the binding that shipped before
  // it (`!!(currentUser$ | async) || hideLogin`): each one arranges an auth
  // state that expression calls true, on a route that must render bare anyway.
  // That is the point of them — the old rule had no term for the URL at all.

  it('hides the chrome on /login when the session is the anonymous sentinel', async () => {
    // THE SHIPPED BUG, reproduced. `AuthService` seeds its subject with
    // `{ user_id: 'anonymous', name: 'Anonymous' }` and re-emits it on a 401,
    // so a visitor who has never signed in still reads as truthy. The old
    // binding therefore drew a rail beside the login card — "No teams yet",
    // with an account footer reading "Anonymous".
    configStub.hideLogin = false;
    authStub.currentUser$.next({ name: 'Anonymous' });
    await arriveAt('/login');
    await render();

    expect(shell().chromeVisible).toBeFalse();
    expect(rail()).toBeNull();
  });

  it('hides the chrome on /login even for a genuinely signed-in user', async () => {
    // A live session is not a licence to furnish the login screen: the route
    // is the veto, and it does not consult the session at all.
    configStub.hideLogin = false;
    authStub.currentUser$.next({ name: 'Alice' });
    await arriveAt('/login');
    await render();

    expect(shell().chromeVisible).toBeFalse();
    expect(rail()).toBeNull();
  });

  it('hides the chrome on /login on a deployment that has no login', async () => {
    // Community tier. `/login` carries no `canActivate` (app.routes.ts), so
    // `hideLogin: true` does not make the route unreachable — it is one typed
    // url away, and the old rule furnished it unconditionally.
    configStub.hideLogin = true;
    authStub.currentUser$.next(null);
    await arriveAt('/login');
    await render();

    expect(shell().chromeVisible).toBeFalse();
    expect(rail()).toBeNull();
  });

  it('hides the chrome on the FIRST paint of a /login deep link', async () => {
    // The flash guard. `provideRouter` runs without
    // `withEnabledBlockingInitialNavigation`, so on a real deep link the
    // router has not navigated when the root view is first checked and
    // `Router.url` still reads `'/'`. Seeding the rule off `Location` instead
    // is what keeps the rail out of that first frame; seeding it off the
    // router would paint one.
    //
    // Hence `detectChanges()` ONCE, with no `whenStable()` in between: this
    // asserts the state of the very first pass, not the settled one.
    configStub.hideLogin = false;
    authStub.currentUser$.next({ name: 'Anonymous' });
    await arriveAt('/login');

    fixture = TestBed.createComponent(AppComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    expect(shell().chromeVisible).toBeFalse();
    expect(rail()).toBeNull();
  });

  it('hides the chrome when a redirect lands on /login after boot', async () => {
    // `AuthGuard` answers a failed session check by navigating to `/login`
    // (auth.guard.ts), and `logout()` comes back through the same door. The
    // rule has to follow a navigation that happens long after init, not just
    // the one it booted on.
    configStub.hideLogin = false;
    authStub.currentUser$.next({ name: 'Alice' });
    await render();
    expect(rail()).not.toBeNull();

    await navigateTo('/login');

    expect(shell().chromeVisible).toBeFalse();
    expect(rail()).toBeNull();
  });

  it('hides the chrome on /login carrying query params', async () => {
    // The router hands out the SERIALIZED url. An exact `=== '/login'` would
    // let the frame back in on a redirect that preserved where the user was
    // going — i.e. on the most common way of reaching the route.
    configStub.hideLogin = false;
    authStub.currentUser$.next({ name: 'Anonymous' });
    await arriveAt('/login?next=%2Fprocess%2F1');
    await render();

    expect(shell().chromeVisible).toBeFalse();
    expect(rail()).toBeNull();
  });

  it('restores the chrome when the user leaves /login', async () => {
    // The veto must lift. The API-key path signs in and navigates to `/`
    // (login.component.ts), and a rule that latched off would leave that user
    // with no navigation at all.
    configStub.hideLogin = false;
    authStub.currentUser$.next({ name: 'Anonymous' });
    await arriveAt('/login');
    await render();
    expect(rail()).toBeNull();

    authStub.currentUser$.next({ name: 'Alice' });
    await navigateTo('/');

    expect(shell().chromeVisible).toBeTrue();
    expect(rail()).not.toBeNull();
  });

  it('shows the chrome on a deep-linked /process/:id', async () => {
    // The complement of the flash guard: `Location` says `/process/1` before
    // the router has navigated, so the rail is there from the first frame.
    // Deriving the rule from `NavigationEnd` alone would blank the rail for
    // the whole of the guard's session fetch on every normal load.
    configStub.hideLogin = false;
    authStub.currentUser$.next({ name: 'Alice' });
    await arriveAt('/process/1');
    await render();

    expect(shell().chromeVisible).toBeTrue();
    expect(rail()).not.toBeNull();
  });

  it('leaves no residual router subscription after destroy', async () => {
    // `router.events` is root-scoped and outlives every component, so a
    // hand-rolled subscription on it pins a destroyed AppComponent for the rest
    // of the session. Consuming it through `async` is what prevents that; this
    // asserts the consequence rather than the mechanism.
    await render();
    const router = TestBed.inject(Router);

    fixture.destroy();
    await router.navigateByUrl('/login');

    expect(authStub.currentUser$.observed).toBeFalse();
  });

  // --- boot side effects that outlived the menubar ------------------------

  it('sets the deployment favicon and checks the session once, on init', async () => {
    await render();

    expect(faviconStub.setFavicon).toHaveBeenCalledOnceWith('favicon.ico');
    expect(authStub.checkAuth).toHaveBeenCalledTimes(1);
  });

  // --- what the menubar deletion had to leave behind ----------------------

  it('subscribes to NONE of the team or pane state the menubar used to read', async () => {
    // Retargets AC12 and story 10-3. The menubar rebuilt itself from
    // `currentProcessId$`, `currentTeam$` and `isRightColumnCollapsed$`; the
    // header and the rail read those where they render them now, so the ROOT
    // must hold no subscription to any of them. A leftover one is invisible
    // until it wakes the whole app on every team switch.
    await render();

    expect(contextStub.currentProcessId$.observed).toBeFalse();
    expect(contextStub.currentTeam$.observed).toBeFalse();
    expect(contextStub.currentTeamRunning$.observed).toBeFalse();
    expect(viewStub.isRightColumnCollapsed$.observed).toBeFalse();
    expect(viewStub.isRailCollapsed$.observed).toBeFalse();
  });

  it('never fetches a team — team state reaches the frame by push only', async () => {
    // Retargets AC5/AC11. Kept because the failure it guards is a REST storm
    // on every navigation, which no visual test would notice.
    await render();

    contextStub.currentProcessId$.next('team-1');
    contextStub.currentTeam$.next(null);
    await settle();

    expect(contextStub.getCurrentTeam).not.toHaveBeenCalled();
    expect(apiStub.getTeam).not.toHaveBeenCalled();
    expect(apiStub.getTeams).not.toHaveBeenCalled();
  });

  function creationDialog(): Element | null {
    return fixture.nativeElement.querySelector('app-team-creation-dialog');
  }

  // --- The creation wizard's mount (R2) ---------------------------------

  it('mounts NO creation wizard until something asks for one', async () => {
    await render();

    expect(creationDialog()).toBeNull();
  });

  it('mounts the wizard when the launcher raises its flag', async () => {
    await render();

    TestBed.inject(TeamCreationLauncher).open();
    await settle();

    expect(creationDialog()).not.toBeNull();
  });

  it('DESTROYS the wizard on close rather than hiding it', async () => {
    // The `@if` is load-bearing: TeamCreationDialogComponent provides
    // TeamCreationService on itself, and that gate's captured namespace is
    // documented to die with its host. A hidden-but-alive component would keep
    // it across an open/close cycle — the exact cross-navigation leak the
    // service's scoping exists to prevent.
    await render();
    const launcher = TestBed.inject(TeamCreationLauncher);
    launcher.open();
    await settle();

    launcher.close();
    await settle();

    expect(creationDialog()).toBeNull();
  });

  it('mounts the wizard OUTSIDE the shell, where nothing clips or inerts it', async () => {
    // Two reasons at once: the shell's `overflow: hidden` flex row would clip a
    // viewport-positioned overlay, and the rail — the only other candidate
    // host — is `inert` + `aria-hidden` when collapsed.
    await render();
    TestBed.inject(TeamCreationLauncher).open();
    await settle();

    const dialog = creationDialog()!;
    const shellEl = fixture.nativeElement.querySelector('app-console-shell');

    expect(shellEl.contains(dialog)).toBe(false);
    expect(dialog.parentElement).toBe(shellEl.parentElement);
  });

  it('leaves the wizard mounted across a navigation — the flag, not the route, owns it', async () => {
    await render();
    TestBed.inject(TeamCreationLauncher).open();
    await settle();

    await navigateTo('/login');

    expect(creationDialog()).not.toBeNull();
  });

  it('leaves zero residual observers on currentUser$ after destroy', async () => {
    // Retargets the story 10-3 AC5 observer-leak spec at the one subject the
    // frame still reads. The async pipe unsubscribes on destroy; a hand-rolled
    // subscription added here later would not, and every destroyed AppComponent
    // would stay awake for the rest of the session.
    await render();
    expect(authStub.currentUser$.observed).toBeTrue();

    fixture.destroy();

    expect(authStub.currentUser$.observed).toBeFalse();
  });

  it('leaves zero residual observers after 3 mount/unmount cycles', async () => {
    // The same leak, in the shape it actually appears: not one component that
    // forgot to unsubscribe, but a route that mounts and destroys repeatedly.
    for (let i = 0; i < 3; i++) {
      const f = TestBed.createComponent(AppComponent);
      f.detectChanges();
      await f.whenStable();
      f.detectChanges();
      f.destroy();
    }

    expect(authStub.currentUser$.observed).toBeFalse();
  });
});

// ---------------------------------------------------------------------------
// Story 31-3 — notification toast rendering against the real <p-toast> mount
//
// Three facts about the notification toast are PrimeNG contracts, not service
// state, and are invisible to a `MessageService.add` spy:
//   - a message without `closable: false` renders a close button (AC6)
//   - a message with a `key` is REJECTED by the app's keyless mount (AC7)
//   - two messages coexist rather than replacing one another (AC8)
//
// AppComponent's own ToastModule import therefore stands here and a REAL
// MessageService is provided: under any override that swaps its imports for a
// CUSTOM_ELEMENTS_SCHEMA stub set, `<p-toast>` is an inert unknown element and
// every assertion below passes vacuously.
//
// `stubRail()` (Epic 56) is the one override this block does take, and it is
// deliberately narrow: it replaces the SHELL's imports, not AppComponent's, so
// the toast mount stays real while B2's rail stays out of this file.
// ---------------------------------------------------------------------------

describe('AppComponent — notification toast rendering (Story 31-3)', () => {
  let fixture: ComponentFixture<AppComponent>;
  let messageService: MessageService;
  let apiStub: {
    getTeam: jasmine.Spy;
    getTeams: jasmine.Spy;
    emitClosedNotification: jasmine.Spy;
  };

  beforeEach(async () => {
    const contextStub: ContextStub = {
      currentProcessId$: new BehaviorSubject<string>(''),
      currentTeam$: new BehaviorSubject<TeamContext | null>(null),
      currentTeamRunning$: new BehaviorSubject<boolean>(false),
      getCurrentTeam: jasmine.createSpy('getCurrentTeam'),
      clear: jasmine.createSpy('clear'),
    };

    apiStub = {
      getTeam: jasmine.createSpy('getTeam'),
      getTeams: jasmine.createSpy('getTeams'),
      emitClosedNotification: jasmine
        .createSpy('emitClosedNotification')
        .and.resolveTo(undefined),
    };

    TestBed.configureTestingModule({
      imports: [AppComponent, NoopAnimationsModule, RouterTestingModule],
      providers: [
        provideTranslateTesting(),
        MessageService,
        { provide: ContextService, useValue: contextStub },
        {
          provide: ViewService,
          useValue: {
            isRightColumnCollapsed$: new BehaviorSubject<boolean>(false),
            isRailCollapsed$: new BehaviorSubject<boolean>(false),
            toggleRightColumn: jasmine.createSpy('toggleRightColumn'),
            toggleRail: jasmine.createSpy('toggleRail'),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUser$: new BehaviorSubject<any>({
              name: 'Alice',
              user_id: 'u-1',
            }),
            checkAuth: jasmine.createSpy('checkAuth').and.returnValue(of(true)),
            logout: jasmine.createSpy('logout'),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            logo: 'logo.png',
            hideLogin: true,
            favicon: 'favicon.ico',
            hideHome: false,
          },
        },
        {
          provide: FaviconService,
          useValue: { setFavicon: jasmine.createSpy('setFavicon') },
        },
        { provide: ApiService, useValue: apiStub },
      ],
    });
    stubRail();
    await TestBed.compileComponents();

    fixture = TestBed.createComponent(AppComponent);
    messageService = TestBed.inject(MessageService);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  /** The shape `IngestionService.showNotificationToast` produces. */
  function notificationToast(
    summary: string,
    detail = 'over limit',
  ): Record<string, unknown> {
    return { severity: 'warn', summary, detail, sticky: true };
  }

  function toasts(): HTMLElement[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('.p-toast-message'),
    );
  }

  async function flush(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('AC6: a notification toast renders with a close button', async () => {
    messageService.add(notificationToast('Alpha'));
    await flush();

    const rendered = toasts();
    expect(rendered.length).toBe(1);
    expect(rendered[0].querySelector('.p-toast-summary')?.textContent?.trim())
      .toBe('Alpha');
    expect(rendered[0].querySelector('button.p-toast-close-button'))
      .not.toBeNull();
  });

  it('AC6 (contrast): a closable:false toast renders NO close button', async () => {
    // The disconnect-toast shape. Proves the assertion above is live rather
    // than passing because every toast happens to have a close button.
    messageService.add({ ...notificationToast('Connection Lost'), closable: false });
    await flush();

    const rendered = toasts();
    expect(rendered.length).toBe(1);
    expect(rendered[0].querySelector('button.p-toast-close-button')).toBeNull();
  });

  it('AC7: a keyless message renders; the same message with a key renders nothing', async () => {
    messageService.add(notificationToast('Alpha'));
    await flush();
    expect(toasts().length).toBe(1);

    messageService.clear();
    await flush();
    expect(toasts().length).toBe(0);

    // `<p-toast>` in app.component.html has no key, and PrimeNG's `canAdd`
    // admits a message only when `this.key === message.key`. A keyed message
    // is silently dropped — the invisibility regression this guards.
    messageService.add({ ...notificationToast('Alpha'), key: 'notification-x' });
    await flush();
    expect(toasts().length).toBe(0);
  });

  it('AC8: two keyless messages coexist — neither replaces the other', async () => {
    messageService.add(notificationToast('Alpha', 'first'));
    messageService.add(notificationToast('Beta', 'second'));
    await flush();

    const summaries = toasts().map((t) =>
      t.querySelector('.p-toast-summary')?.textContent?.trim(),
    );
    expect(summaries.length).toBe(2);
    expect(summaries).toContain('Alpha');
    expect(summaries).toContain('Beta');
  });

  // -------------------------------------------------------------------------
  // Story 31-4 (AC #4, #5, #6) — the close round trip, proven at the DOM.
  //
  // Driven by clicking the real `button.p-toast-close-button` rather than
  // calling `onToastClose` directly: the whole point is that the `(onClose)`
  // binding on the app's single `<p-toast>` is wired and that PrimeNG re-emits
  // `data` verbatim. Calling the handler would pass with the binding deleted.
  // -------------------------------------------------------------------------

  function closeFirstToast(): void {
    const button = toasts()[0].querySelector(
      'button.p-toast-close-button',
    ) as HTMLButtonElement;
    button.click();
  }

  it('AC4: clicking close issues exactly one POST with that toast\'s messageId and teamId', async () => {
    messageService.add({
      ...notificationToast('Alpha'),
      data: { messageId: 'w-1', teamId: 'team-1' },
    });
    await flush();
    expect(toasts().length).toBe(1);

    closeFirstToast();
    await flush();

    expect(apiStub.emitClosedNotification).toHaveBeenCalledTimes(1);
    expect(apiStub.emitClosedNotification).toHaveBeenCalledWith(
      'team-1',
      'w-1',
    );
  });

  // Story 31-6 (AC #12) — the same round trip, from an ERROR toast.
  //
  // The message object below is exactly what `showNotificationToast` now emits
  // for an `ErrorMessage`: `severity: 'error'`, sticky, and the same
  // `data.messageId` / `data.teamId` pair. That pair is the entire reason FR18
  // needed no code: `onToastClose` reads `data` and never `__model__`, so the
  // error path reuses this harness rather than extending it. If this spec ever
  // requires a change in `onToastClose`, `ApiService` or
  // `NotificationToastService` to pass, the story has been implemented wrong.
  it('AC #12: closing an ERROR toast issues exactly one POST carrying the error id', async () => {
    messageService.add({
      severity: 'error',
      summary: '@Researcher - ValueError',
      detail: 'boom',
      sticky: true,
      data: { messageId: 'e-1', teamId: 'team-1' },
    });
    await flush();
    expect(toasts().length).toBe(1);

    closeFirstToast();
    await flush();

    expect(apiStub.emitClosedNotification).toHaveBeenCalledTimes(1);
    expect(apiStub.emitClosedNotification).toHaveBeenCalledWith(
      'team-1',
      'e-1',
    );
  });

  it('AC4: closing one of two toasts reports only that toast\'s id', async () => {
    messageService.add({
      ...notificationToast('Alpha', 'first'),
      data: { messageId: 'w-1', teamId: 'team-1' },
    });
    messageService.add({
      ...notificationToast('Beta', 'second'),
      data: { messageId: 'w-2', teamId: 'team-1' },
    });
    await flush();
    expect(toasts().length).toBe(2);

    closeFirstToast();
    await flush();

    expect(apiStub.emitClosedNotification).toHaveBeenCalledTimes(1);
    expect(apiStub.emitClosedNotification).toHaveBeenCalledWith(
      'team-1',
      'w-1',
    );
  });

  it('AC5: closing a toast with no data issues ZERO POSTs', async () => {
    messageService.add(notificationToast('Alpha'));
    await flush();

    closeFirstToast();
    await flush();

    expect(apiStub.emitClosedNotification).not.toHaveBeenCalled();
  });

  it('AC5: closing a toast with data but no messageId issues ZERO POSTs', async () => {
    messageService.add({
      ...notificationToast('Alpha'),
      data: { teamId: 'team-1' },
    });
    await flush();

    closeFirstToast();
    await flush();

    expect(apiStub.emitClosedNotification).not.toHaveBeenCalled();
  });

  it('AC5: closing a toast with a messageId but no teamId issues ZERO POSTs', async () => {
    messageService.add({
      ...notificationToast('Alpha'),
      data: { messageId: 'w-1' },
    });
    await flush();

    closeFirstToast();
    await flush();

    expect(apiStub.emitClosedNotification).not.toHaveBeenCalled();
  });

  it('AC6: a rejected POST is caught and logged, and nothing escapes the handler', async () => {
    // The rejection is asserted through `console.error` rather than a
    // `window.unhandledrejection` listener: Zone.js intercepts rejections in
    // Karma, so that listener never fires and cannot tell a handled rejection
    // from an unhandled one — deleting the terminal `.catch` left it green.
    // The log call is the observable proof that the promise IS terminated.
    const reason = new Error('409 team stopped');
    apiStub.emitClosedNotification.and.returnValue(Promise.reject(reason));
    const consoleError = spyOn(console, 'error');

    messageService.add({
      ...notificationToast('Alpha'),
      data: { messageId: 'w-1', teamId: 'team-1' },
    });
    await flush();

    expect(() => closeFirstToast()).not.toThrow();
    await flush();
    // Give the microtask queue a turn so the `.catch` callback has run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(apiStub.emitClosedNotification).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to record notification dismissal:',
      reason,
    );
  });

  it('AC6: a rejected POST still removes the toast from the DOM', async () => {
    apiStub.emitClosedNotification.and.returnValue(
      Promise.reject(new Error('409 team stopped')),
    );

    messageService.add({
      ...notificationToast('Alpha'),
      data: { messageId: 'w-1', teamId: 'team-1' },
    });
    await flush();
    expect(toasts().length).toBe(1);

    closeFirstToast();
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();

    expect(toasts().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Story 31-5 — removing one on-screen toast, against the real <p-toast> mount
//
// Two things can only be settled here, against real PrimeNG:
//
//   1. WHY the mechanism is what it is. `MessageService` offers `add` and
//      `clear(key)` and nothing else, and neither can take down a single toast
//      on the app's shared keyless mount. The first two specs below run that
//      claim rather than asserting it in a comment — they are the evidence for
//      the design, and they fail loudly if a PrimeNG upgrade ever changes it.
//   2. That splicing `Toast.messages` through `NotificationToastService` really
//      does remove the rendered element, leaving its neighbours in place.
//
// Like the 31-3 block above, this one keeps AppComponent's own ToastModule
// import and a REAL MessageService — under an override that stubbed
// AppComponent's imports out, `<p-toast>` would be an inert unknown element and
// every assertion here would pass vacuously. Only the shell's rail is stubbed.
// ---------------------------------------------------------------------------

describe('AppComponent — single-toast removal (Story 31-5)', () => {
  let fixture: ComponentFixture<AppComponent>;
  let messageService: MessageService;
  let notificationToast: NotificationToastService;

  beforeEach(async () => {
    const contextStub: ContextStub = {
      currentProcessId$: new BehaviorSubject<string>(''),
      currentTeam$: new BehaviorSubject<TeamContext | null>(null),
      currentTeamRunning$: new BehaviorSubject<boolean>(false),
      getCurrentTeam: jasmine.createSpy('getCurrentTeam'),
      clear: jasmine.createSpy('clear'),
    };

    TestBed.configureTestingModule({
      imports: [AppComponent, NoopAnimationsModule, RouterTestingModule],
      providers: [
        provideTranslateTesting(),
        MessageService,
        { provide: ContextService, useValue: contextStub },
        {
          provide: ViewService,
          useValue: {
            isRightColumnCollapsed$: new BehaviorSubject<boolean>(false),
            isRailCollapsed$: new BehaviorSubject<boolean>(false),
            toggleRightColumn: jasmine.createSpy('toggleRightColumn'),
            toggleRail: jasmine.createSpy('toggleRail'),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUser$: new BehaviorSubject<any>({
              name: 'Alice',
              user_id: 'u-1',
            }),
            checkAuth: jasmine.createSpy('checkAuth').and.returnValue(of(true)),
            logout: jasmine.createSpy('logout'),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            logo: 'logo.png',
            hideLogin: true,
            favicon: 'favicon.ico',
            hideHome: false,
          },
        },
        {
          provide: FaviconService,
          useValue: { setFavicon: jasmine.createSpy('setFavicon') },
        },
        {
          provide: ApiService,
          useValue: {
            getTeam: jasmine.createSpy('getTeam'),
            getTeams: jasmine.createSpy('getTeams'),
            emitClosedNotification: jasmine
              .createSpy('emitClosedNotification')
              .and.resolveTo(undefined),
          },
        },
      ],
    });
    stubRail();
    await TestBed.compileComponents();

    fixture = TestBed.createComponent(AppComponent);
    messageService = TestBed.inject(MessageService);
    notificationToast = TestBed.inject(NotificationToastService);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  function notificationToastFor(
    messageId: string,
    summary: string,
  ): Record<string, unknown> {
    return {
      severity: 'warn',
      summary,
      detail: 'over limit',
      sticky: true,
      data: { messageId, teamId: 'team-1' },
    };
  }

  function summaries(): (string | undefined)[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('.p-toast-message'),
    ).map((t) =>
      (t as HTMLElement)
        .querySelector('.p-toast-summary')
        ?.textContent?.trim(),
    );
  }

  async function flush(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  // --- why MessageService alone cannot do this (Task 1 evidence) -----------

  it('MessageService.clear(key) removes NOTHING from the app\'s keyless mount', async () => {
    messageService.add(notificationToastFor('w-1', 'Alpha'));
    await flush();
    expect(summaries().length).toBe(1);

    // The obvious-looking `key: 'notification-<id>'` + `clear(that key)` design.
    // PrimeNG matches a clear against the CONTAINER's key, not a message's, and
    // this container has none — so the toast survives untouched.
    messageService.clear('notification-w-1');
    await flush();

    expect(summaries()).toEqual(['Alpha']);
  });

  it('MessageService.clear() with no key removes EVERY toast, not just one', async () => {
    // The other half of the same point: the only clear that bites is the
    // blanket one, which would take the disconnect toast down with it.
    messageService.add(notificationToastFor('w-1', 'Alpha'));
    messageService.add({ severity: 'warn', summary: 'Connection Lost', sticky: true });
    await flush();
    expect(summaries().length).toBe(2);

    messageService.clear();
    await flush();

    expect(summaries()).toEqual([]);
  });

  // --- what the story actually does ---------------------------------------

  it('dismiss() removes exactly the matching toast from the DOM', async () => {
    messageService.add(notificationToastFor('w-1', 'Alpha'));
    messageService.add(notificationToastFor('w-2', 'Beta'));
    await flush();
    expect(summaries()).toEqual(['Alpha', 'Beta']);

    notificationToast.dismiss('w-1');
    await flush();

    expect(summaries()).toEqual(['Beta']);
  });

  it('dismiss() leaves the disconnect toast standing', async () => {
    messageService.add(notificationToastFor('w-1', 'Alpha'));
    messageService.add({
      severity: 'warn',
      summary: 'Connection Lost',
      sticky: true,
      closable: false,
    });
    await flush();

    notificationToast.dismiss('w-1');
    await flush();

    expect(summaries()).toEqual(['Connection Lost']);
  });

  it('dismiss() for an unknown id leaves every toast on screen', async () => {
    messageService.add(notificationToastFor('w-1', 'Alpha'));
    await flush();

    notificationToast.dismiss('w-9');
    await flush();

    expect(summaries()).toEqual(['Alpha']);
  });

  it('AppComponent registers its mount, so dismiss() reaches a real container', async () => {
    // Guards the `ngAfterViewInit` wiring specifically: without the register
    // call the service holds null and every dismiss above would pass by doing
    // nothing at all to an empty screen.
    messageService.add(notificationToastFor('w-1', 'Alpha'));
    await flush();

    notificationToast.dismiss('w-1');
    await flush();

    expect(summaries()).toEqual([]);
  });

  it('a wire-driven dismissal POSTs nothing back, while a user click still does', async () => {
    // The echo-loop guard. `dismiss()` splices `Toast.messages` directly, which
    // deliberately does NOT go through `Toast.onMessageClose` and so never fires
    // the `(onClose)` binding that `AppComponent.onToastClose` POSTs from. Route
    // the removal through PrimeNG's own close path instead and every closure
    // replayed off the wire would emit a fresh `ClosedNotification` for a
    // notification that is already closed — the client answering the server's
    // echo with another echo.
    const emit = TestBed.inject(ApiService)
      .emitClosedNotification as jasmine.Spy;

    messageService.add(notificationToastFor('w-1', 'Alpha'));
    await flush();

    notificationToast.dismiss('w-1');
    await flush();

    expect(summaries()).toEqual([]);
    expect(emit).not.toHaveBeenCalled();

    // Contrast, so the assertion above cannot pass because nothing ever POSTs:
    // the same toast closed by hand DOES record the dismissal (Story 31-4).
    messageService.add(notificationToastFor('w-2', 'Beta'));
    await flush();
    (
      fixture.nativeElement.querySelector(
        'button.p-toast-close-button',
      ) as HTMLButtonElement
    ).click();
    await flush();

    expect(emit).toHaveBeenCalledOnceWith('team-1', 'w-2');
  });

  it('destroying AppComponent unregisters the mount', async () => {
    messageService.add(notificationToastFor('w-1', 'Alpha'));
    await flush();

    fixture.destroy();

    // A dismissal arriving after teardown must not splice a dead container.
    expect(() => notificationToast.dismiss('w-1')).not.toThrow();
    expect((notificationToast as any).toast).toBeNull();
  });
});
