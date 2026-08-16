import { Component } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { Router, RouterOutlet } from '@angular/router';
import { RouterTestingModule } from '@angular/router/testing';
import { BehaviorSubject, of } from 'rxjs';
import { map } from 'rxjs/operators';

import { routes } from '../../app.routes';
import { AuthService } from '../../core/auth/auth.service';
import { ConfigService } from '../../core/config/config.service';
import { ADMIN_ROUTES } from './admin.routes';
import { AdminShellComponent } from './admin-shell.component';

/**
 * Story 36-1 (AC #6, #7, #12) — the admin area's route table.
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

describe('admin routes (Story 36-1)', () => {
  let router: Router;
  let fixture: ComponentFixture<RouteHostComponent> | undefined;
  let currentUser$: BehaviorSubject<any>;

  /** Configure the router with a caller who is (or is not) an admin. */
  async function setUp(user: any): Promise<void> {
    currentUser$ = new BehaviorSubject<any>(user);
    await TestBed.configureTestingModule({
      imports: [RouteHostComponent, RouterTestingModule.withRoutes(routes)],
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
        // these specs exercise the admin table and not the auth stack.
        {
          provide: ConfigService,
          useValue: { hideLogin: true, hideHome: false, api: 'http://t' },
        },
      ],
    }).compileComponents();

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

  it('(AC7) the shipped namespace deep link still resolves to its own route', async () => {
    await setUp({ user_id: 'anonymous' });

    // The regression guard for re-parenting: the top-level entry must keep
    // matching, and must NOT be swallowed by the new `admin` sibling. No
    // outlet is mounted — resolution is the whole claim, and activating the
    // real panel would drag Monaco and the catalog HTTP stack in with it.
    await goTo('/admin/catalog/namespace/acme-team-v1');

    expect(router.url).toBe('/admin/catalog/namespace/acme-team-v1');
    const matched = router.routerState.snapshot.root.firstChild;
    expect(matched!.routeConfig!.path).toBe('admin/catalog/namespace/:namespace');
    expect(matched!.params['namespace']).toBe('acme-team-v1');
  });

  it('(AC12) the admin area is reached through loadChildren, never an eager component', () => {
    const entry = routes.find((r) => r.path === 'admin');

    expect(entry).toBeDefined();
    expect(typeof entry!.loadChildren).toBe('function');
    expect(entry!.component).toBeUndefined();
    expect(entry!.children).toBeUndefined();
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
    expect(children.map((r) => r.path)).toEqual(['', 'catalog', 'api-keys']);
    expect(children[0].redirectTo).toBe('catalog');
    expect(children[0].pathMatch).toBe('full');
  });
});
