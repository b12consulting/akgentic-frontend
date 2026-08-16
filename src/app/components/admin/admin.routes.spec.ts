import { CommonModule } from '@angular/common';
import { Component, forwardRef, Input } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import {
  ControlValueAccessor,
  FormsModule,
  NG_VALUE_ACCESSOR,
} from '@angular/forms';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { Router, RouterOutlet } from '@angular/router';
import { RouterTestingModule } from '@angular/router/testing';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';
import { BehaviorSubject, of } from 'rxjs';
import { map } from 'rxjs/operators';

import { routes } from '../../app.routes';
import { AuthGuard } from '../../core/auth/auth.guard';
import { AuthService } from '../../core/auth/auth.service';
import { ConfigService } from '../../core/config/config.service';
import { ApiService } from '../../core/http/api.service';
import { NamespacePanelComponent } from '../catalog/namespace-panel/namespace-panel.component';
import { NamespacePanelRouteComponent } from '../catalog/namespace-panel/namespace-panel-route.component';
import { ValidationReportComponent } from '../catalog/namespace-panel/validation-report/validation-report.component';
import { ADMIN_ROUTES } from './admin.routes';
import { AdminShellComponent } from './admin-shell.component';

/**
 * Story 36-1 (AC #6, #7, #12) — the admin area's route table, extended by
 * Story 36-4 (AC 1–5) when the namespace-panel deep link was re-parented into
 * it.
 *
 * Driven through the REAL top-level `routes` array rather than `ADMIN_ROUTES`
 * in isolation: the lazy `loadChildren` edge, the `AuthGuard` on the parent and
 * the child `redirectTo` only compose correctly when the router resolves the
 * whole tree, and that composition is what AC #6 is about.
 */
@Component({
  standalone: true,
  imports: [RouterOutlet],
  template: '<router-outlet></router-outlet>',
})
class RouteHostComponent {}

/**
 * Stands in for `<nu-monaco-editor>` so activating the panel route does not
 * pull the real Monaco bundle into a unit test. Same swap the panel's own
 * specs and the route shell's specs make.
 */
@Component({
  selector: 'nu-monaco-editor',
  standalone: true,
  template: '<textarea data-test="stub-monaco"></textarea>',
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => StubMonacoEditorComponent),
      multi: true,
    },
  ],
})
class StubMonacoEditorComponent implements ControlValueAccessor {
  @Input() options?: Record<string, unknown>;
  @Input() height?: string;
  writeValue(_value: string): void {}
  registerOnChange(_fn: (value: string) => void): void {}
  registerOnTouched(_fn: () => void): void {}
  setDisabledState?(_isDisabled: boolean): void {}
}

describe('admin routes (Story 36-1)', () => {
  let router: Router;
  let fixture: ComponentFixture<RouteHostComponent> | undefined;
  let currentUser$: BehaviorSubject<any>;

  /** Configure the router with a caller who is (or is not) an admin. */
  async function setUp(user: any, config: Record<string, any> = {}): Promise<void> {
    currentUser$ = new BehaviorSubject<any>(user);
    await TestBed.configureTestingModule({
      imports: [
        RouteHostComponent,
        NoopAnimationsModule,
        RouterTestingModule.withRoutes(routes),
      ],
      providers: [
        {
          provide: AuthService,
          useValue: {
            currentUser$,
            isAdmin$: currentUser$.pipe(
              map((u) => u?.roles?.includes('admin') === true),
            ),
            checkAuth: jasmine.createSpy('checkAuth').and.returnValue(of(user)),
            logout: jasmine.createSpy('logout'),
          },
        },
        // hideLogin: true short-circuits AuthGuard on the parent route, so
        // these specs exercise the admin table and not the auth stack. The
        // 36-4 auth spec overrides it — that one IS about the guard.
        {
          provide: ConfigService,
          useValue: {
            hideLogin: true,
            hideHome: false,
            api: 'http://t',
            ...config,
          },
        },
        // Story 36-3 gave the catalog pane real dependencies (it reads the
        // catalog endpoint). These specs mount that pane through the router,
        // so they must stub the data layer or the mount fails on injection —
        // and would otherwise issue real requests from a unit test. 36-4 added
        // the panel route to the same subtree, so its reads are stubbed here
        // too.
        {
          provide: ApiService,
          useValue: {
            getNamespaces: () => Promise.resolve([]),
            deleteNamespace: () => Promise.resolve(),
            exportNamespace: () => Promise.resolve(''),
            importNamespace: () => Promise.resolve(),
            validateNamespaceBuffer: () => Promise.resolve(null),
            validatePersistedNamespace: () => Promise.resolve(null),
          },
        },
        { provide: MessageService, useValue: { add: (): void => {} } },
      ],
    })
      .overrideComponent(NamespacePanelComponent, {
        set: {
          imports: [
            CommonModule,
            FormsModule,
            ButtonModule,
            DialogModule,
            InputTextModule,
            ToggleSwitchModule,
            TooltipModule,
            StubMonacoEditorComponent,
            ValidationReportComponent,
          ],
        },
      })
      .compileComponents();

    router = TestBed.inject(Router);
  }

  /**
   * Mount the outlet the routed components render into. Kept separate from
   * `setUp` so a spec that only cares about URL RESOLUTION can navigate
   * without an outlet — with none registered the router still resolves the
   * URL, but no component is instantiated and no dependency of a heavyweight
   * page has to be stubbed here.
   */
  function mountOutlet(): void {
    fixture = TestBed.createComponent(RouteHostComponent);
    fixture.detectChanges();
  }

  async function goTo(url: string): Promise<void> {
    if (!fixture) {
      await router.navigateByUrl(url);
      return;
    }
    // Inside the fixture's zone: a navigation started outside it activates the
    // outlet without ever scheduling the change detection that renders it.
    await fixture.ngZone!.run(() => router.navigateByUrl(url));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  afterEach(() => {
    fixture = undefined;
    TestBed.resetTestingModule();
  });

  it('(AC6) /admin redirects to /admin/catalog', async () => {
    await setUp({ user_id: 'anonymous' });
    mountOutlet();

    await goTo('/admin');

    expect(router.url).toBe('/admin/catalog');
  });

  it('(AC6) /admin/catalog mounts the catalog pane inside the shell', async () => {
    await setUp({ user_id: 'anonymous' });
    mountOutlet();

    await goTo('/admin/catalog');

    const shell = fixture!.nativeElement.querySelector('app-admin-shell');
    expect(shell).not.toBeNull();
    expect(
      shell.querySelector('[data-test="admin-catalog-pane"]'),
    ).not.toBeNull();
  });

  it('(AC6) /admin/api-keys mounts the api-keys pane inside the SAME shell', async () => {
    await setUp({ user_id: 'u-1', roles: ['admin'] });
    mountOutlet();

    await goTo('/admin/api-keys');

    const shell = fixture!.nativeElement.querySelector('app-admin-shell');
    expect(shell).not.toBeNull();
    expect(
      shell.querySelector('[data-test="admin-api-keys-pane"]'),
    ).not.toBeNull();
    expect(shell.querySelector('[data-test="admin-catalog-pane"]')).toBeNull();
  });

  it('(AC6) the shell renders a router-outlet for its panes', async () => {
    await setUp({ user_id: 'anonymous' });
    mountOutlet();

    await goTo('/admin/catalog');

    expect(
      fixture!.nativeElement.querySelector('app-admin-shell router-outlet'),
    ).not.toBeNull();
  });

  it('(AC7) the shipped namespace deep link still resolves, now inside the admin subtree', async () => {
    await setUp({ user_id: 'anonymous' });

    // The regression guard for re-parenting. Story 36-4 moved the entry from a
    // top-level route into the shell's children; the URL is byte-identical and
    // must keep matching, with `:namespace` still a path parameter.
    await goTo('/admin/catalog/namespace/acme-team-v1');

    expect(router.url).toBe('/admin/catalog/namespace/acme-team-v1');
    const matched = router.routerState.snapshot.root.firstChild!.firstChild!
      .firstChild!;
    expect(matched.routeConfig!.path).toBe('catalog/namespace/:namespace');
    expect(matched.params['namespace']).toBe('acme-team-v1');
  });

  it('(AC12) the admin area is reached through loadChildren, never an eager component', () => {
    const entry = routes.find((r) => r.path === 'admin');

    expect(entry).toBeDefined();
    expect(typeof entry!.loadChildren).toBe('function');
    expect(entry!.component).toBeUndefined();
    expect(entry!.children).toBeUndefined();
  });

  it('(AC9) AuthGuard stays on the PARENT admin route — adminGuard depends on it', () => {
    // `adminGuard` reads `isAdmin$` with `take(1)`, so it needs `/auth/me`
    // already resolved when it runs. Angular runs a parent's `canActivate` to
    // completion before a child's, and `AuthGuard` is what does the resolving.
    // Remove it here and the child guard starts redirecting genuine admins on
    // every tier that authenticates — a regression NO behavioural spec in this
    // file or in admin.guard.spec.ts would catch, because both run with
    // `hideLogin: true`, under which `AuthGuard` short-circuits to `of(true)`.
    const entry = routes.find((r) => r.path === 'admin');

    expect(entry!.canActivate).toContain(AuthGuard);
  });

  it('(AC12) both panes are loadComponent-split', () => {
    const children = ADMIN_ROUTES[0].children ?? [];
    const catalog = children.find((r) => r.path === 'catalog');
    const apiKeys = children.find((r) => r.path === 'api-keys');

    expect(typeof catalog!.loadComponent).toBe('function');
    expect(catalog!.component).toBeUndefined();
    expect(typeof apiKeys!.loadComponent).toBe('function');
    expect(apiKeys!.component).toBeUndefined();
  });

  it('(AC12) the shell is the layout route hosting both panes', () => {
    expect(ADMIN_ROUTES[0].component).toBe(AdminShellComponent);
    const children = ADMIN_ROUTES[0].children ?? [];
    expect(children.map((r) => r.path)).toEqual([
      'catalog/namespace/:namespace',
      '',
      'catalog',
      'api-keys',
    ]);
    const redirect = children.find((r) => r.path === '')!;
    expect(redirect.redirectTo).toBe('catalog');
    expect(redirect.pathMatch).toBe('full');
  });

  // --- Story 36-4: the re-parented deep link -------------------------------

  it('(36-4 AC2) the specific child is registered BEFORE the generic catalog one', () => {
    // The recogniser does backtrack across siblings, so `catalog` first would
    // probably still resolve the deep link. "Probably" is not a property to
    // hang a bookmarked URL on: specific-before-generic makes the resolution
    // independent of backtracking, and costs nothing.
    const paths = (ADMIN_ROUTES[0].children ?? []).map((r) => r.path);
    expect(paths.indexOf('catalog/namespace/:namespace')).toBeLessThan(
      paths.indexOf('catalog'),
    );
  });

  it('(36-4 AC3) the deep link renders the panel route INSIDE the admin shell', async () => {
    await setUp({ user_id: 'anonymous' });
    mountOutlet();

    await goTo('/admin/catalog/namespace/acme-team-v1');

    // Asserted on the DOM, not on the route config: a child registered under
    // the wrong parent still "resolves", it just renders somewhere else.
    const shell = fixture!.nativeElement.querySelector('app-admin-shell');
    expect(shell).not.toBeNull();
    expect(shell.querySelector('app-namespace-panel-route')).not.toBeNull();
  });

  it('(36-4 AC2) /admin/catalog still resolves to the catalog pane, not the panel', async () => {
    await setUp({ user_id: 'anonymous' });
    mountOutlet();

    await goTo('/admin/catalog');

    const shell = fixture!.nativeElement.querySelector('app-admin-shell');
    expect(
      shell.querySelector('[data-test="admin-catalog-pane"]'),
    ).not.toBeNull();
    expect(shell.querySelector('app-namespace-panel-route')).toBeNull();
  });

  it('(36-4 AC4) the deep link is still auth-protected by the parent guard', async () => {
    // `hideLogin: false` takes AuthGuard off its community-tier short-circuit,
    // and a null user is an unauthenticated caller (`checkAuth` emits it). The
    // child carries no guard of its own — this is the parent's guard doing the
    // work, exactly as it did when the route was top-level.
    //
    // No outlet: activation is the claim, and mounting one would only make the
    // login page's own dependencies this spec's problem.
    await setUp(null, { hideLogin: false });

    await goTo('/admin/catalog/namespace/acme-team-v1');

    expect(router.url).toBe('/login');
    const paths: string[] = [];
    for (let s = router.routerState.snapshot.root.firstChild; s; s = s.firstChild) {
      paths.push(s.routeConfig?.path ?? '');
    }
    expect(paths).not.toContain('catalog/namespace/:namespace');
  });

  // --- Story 36-4 AC5: the CanDeactivate guard survives the move ------------

  /**
   * Reach the mounted panel and make it look dirty. The guard reads
   * `component.panel` off the route shell, so replacing the panel with a fake
   * is enough — and keeps the real panel's internals out of a routing spec.
   */
  function stubPanel(
    hasUnsavedChanges: boolean,
    confirmDiscard: jasmine.Spy,
  ): void {
    // Queried by TYPE, not by tag: a routed component is instantiated through
    // a ViewContainerRef, so its debug node reads `#host` and a name-based
    // predicate silently finds nothing.
    const shell = fixture!.debugElement.query(
      (de) => de.componentInstance instanceof NamespacePanelRouteComponent,
    );
    shell.componentInstance.panel = {
      hasUnsavedChanges: () => hasUnsavedChanges,
      confirmDiscard,
    };
  }

  it('(36-4 AC5) a dirty panel prompts, and Cancel aborts the navigation', async () => {
    await setUp({ user_id: 'anonymous' });
    mountOutlet();
    await goTo('/admin/catalog/namespace/acme-team-v1');

    const confirmDiscard = jasmine
      .createSpy('confirmDiscard')
      .and.returnValue(Promise.resolve(false));
    stubPanel(true, confirmDiscard);

    await goTo('/admin/catalog');

    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    expect(router.url).toBe('/admin/catalog/namespace/acme-team-v1');
  });

  it('(36-4 AC5) a dirty panel prompts, and Proceed lets the navigation through', async () => {
    await setUp({ user_id: 'anonymous' });
    mountOutlet();
    await goTo('/admin/catalog/namespace/acme-team-v1');

    const confirmDiscard = jasmine
      .createSpy('confirmDiscard')
      .and.returnValue(Promise.resolve(true));
    stubPanel(true, confirmDiscard);

    await goTo('/admin/catalog');

    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    expect(router.url).toBe('/admin/catalog');
  });

  it('(36-4 AC5) a clean panel is never asked, and navigation proceeds', async () => {
    await setUp({ user_id: 'anonymous' });
    mountOutlet();
    await goTo('/admin/catalog/namespace/acme-team-v1');

    const confirmDiscard = jasmine.createSpy('confirmDiscard');
    stubPanel(false, confirmDiscard);

    await goTo('/admin/catalog');

    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(router.url).toBe('/admin/catalog');
  });
});
