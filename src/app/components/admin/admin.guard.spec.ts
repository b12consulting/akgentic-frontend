import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, RouterOutlet } from '@angular/router';
import { RouterTestingModule } from '@angular/router/testing';
import { MessageService } from 'primeng/api';
import { BehaviorSubject, of } from 'rxjs';
import { map } from 'rxjs/operators';

import { routes } from '../../app.routes';
import { AuthService } from '../../core/auth/auth.service';
import { ConfigService } from '../../core/config/config.service';
import { ApiService } from '../../core/http/api.service';
import { adminGuard } from './admin.guard';
import { ADMIN_ROUTES } from './admin.routes';

/**
 * Story 36-1 (AC #9, #10) — `adminGuard` redirects, it does not 403.
 *
 * Exercised through a real navigation rather than by calling the guard
 * function: the assertion that matters is where the operator ENDS UP, and a
 * direct call would still pass with the guard detached from the route.
 */
@Component({
  standalone: true,
  imports: [RouterOutlet],
  template: '<router-outlet></router-outlet>',
})
class GuardHostComponent {}

describe('adminGuard (Story 36-1)', () => {
  let router: Router;
  let fixture: ComponentFixture<GuardHostComponent>;

  async function setUp(user: any): Promise<void> {
    const currentUser$ = new BehaviorSubject<any>(user);
    await TestBed.configureTestingModule({
      imports: [GuardHostComponent, RouterTestingModule.withRoutes(routes)],
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
        {
          provide: ConfigService,
          useValue: { hideLogin: true, hideHome: false, api: 'http://t' },
        },
        // Story 36-3 gave the catalog pane real dependencies (it composes its
        // rows from the catalog endpoints). These specs route INTO that pane,
        // so they must stub the data layer or the mount fails on injection —
        // and would otherwise issue real requests from a unit test.
        {
          provide: ApiService,
          useValue: {
            getNamespaces: () => Promise.resolve([]),
            getEntries: () => Promise.resolve([]),
            deleteNamespace: () => Promise.resolve(),
          },
        },
        { provide: MessageService, useValue: { add: (): void => {} } },
      ],
    }).compileComponents();

    router = TestBed.inject(Router);
    fixture = TestBed.createComponent(GuardHostComponent);
    fixture.detectChanges();
  }

  async function goTo(url: string): Promise<void> {
    // Inside the fixture's zone: a navigation started outside it activates the
    // outlet without ever scheduling the change detection that renders it.
    await fixture.ngZone!.run(() => router.navigateByUrl(url));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('(AC9) a non-admin navigating to /admin/api-keys lands on /admin/catalog', async () => {
    await setUp({ user_id: 'u-2', roles: ['user'] });

    await goTo('/admin/api-keys');

    expect(router.url).toBe('/admin/catalog');
  });

  it('(AC9) the anonymous caller is redirected too', async () => {
    // The community tier's shape: hideLogin short-circuits AuthGuard and the
    // caller has no roles at all, so the pane has nothing to show.
    await setUp({ user_id: 'anonymous' });

    await goTo('/admin/api-keys');

    expect(router.url).toBe('/admin/catalog');
  });

  it('(AC9) an admin navigating to /admin/api-keys STAYS there', async () => {
    await setUp({ user_id: 'u-1', roles: ['admin'] });

    await goTo('/admin/api-keys');

    expect(router.url).toBe('/admin/api-keys');
  });

  it('(AC9) a redirected non-admin is shown the catalog pane, not an error page', async () => {
    await setUp({ user_id: 'u-2', roles: ['user'] });

    await goTo('/admin/api-keys');

    expect(
      fixture.nativeElement.querySelector('[data-test="admin-catalog-pane"]'),
    ).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-test="admin-api-keys-pane"]'),
    ).toBeNull();
  });

  it('(AC9) the guard is a functional CanActivateFn attached to the api-keys route', () => {
    // `typeof adminGuard === 'function'` is true of ANY function and stays
    // green with the guard detached from the route entirely — so the
    // attachment half of AC 9 is pinned here, on the route config itself. The
    // redirect specs above prove the behaviour; this one proves it is wired to
    // the pane it is meant to protect.
    const apiKeys = (ADMIN_ROUTES[0].children ?? []).find(
      (r) => r.path === 'api-keys',
    );

    expect(typeof adminGuard).toBe('function');
    expect(apiKeys).toBeDefined();
    expect(apiKeys!.canActivate).toContain(adminGuard);
  });
});
