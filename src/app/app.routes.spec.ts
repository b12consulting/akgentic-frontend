import { Route, Router, Routes } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';

import { routes } from './app.routes';
import { AuthGuard } from './core/auth/auth.guard';
import { ADMIN_ROUTES } from './components/admin/admin.routes';
import { namespacePanelCanDeactivate } from './components/catalog/namespace-panel/namespace-panel.guard';

/**
 * Story 11.6 — route-registration tests for the deep-link route, carried
 * forward through Story 36-4's re-parenting.
 *
 * The entry moved from a TOP-LEVEL `admin/catalog/namespace/:namespace` route
 * into the admin shell's children as `catalog/namespace/:namespace`. The URL it
 * produces is byte-identical, so 11.6's claims still hold — they are just
 * asserted one level down. What did NOT move: the `loadComponent` split, the
 * title, and the functional `CanDeactivate` guard.
 *
 * Covers:
 * - AC 1 route entry shape (path, `loadComponent` function, functional
 *   `CanDeactivate` guard) and the auth cover it now inherits from its parent.
 * - AC 15 URL path-parameter parsing (`:namespace` is a path segment, not
 *   a query param) + URL-decoded round-trip.
 * - AC 16 guard is a function (functional CanDeactivateFn).
 */
describe('app.routes (Story 11.6 — deep-link route registration)', () => {
  function findPanelRoute(): Route | undefined {
    return (ADMIN_ROUTES[0].children ?? []).find(
      (r) => r.path === 'catalog/namespace/:namespace',
    );
  }

  function findAdminParent(rs: Routes): Route | undefined {
    return rs.find((r) => r.path === 'admin');
  }

  it('(AC1) the namespace panel route entry exists with expected shape', () => {
    const route = findPanelRoute();
    expect(route).toBeDefined();
    expect(route!.path).toBe('catalog/namespace/:namespace');
    expect(typeof route!.loadComponent).toBe('function');
    expect(route!.component).toBeUndefined(); // lazy-loaded, not eager
    expect(route!.title).toBe('Catalog namespace');
    expect(route!.canDeactivate).toEqual([namespacePanelCanDeactivate]);
  });

  it('(AC1) it is auth-protected by its parent, and does NOT repeat the guard', () => {
    // Angular runs a parent's `canActivate` to completion before a child's, so
    // the deep link is covered exactly once. Repeating `AuthGuard` on the child
    // would resolve `/auth/me` twice for no gain.
    expect(findPanelRoute()!.canActivate).toBeUndefined();
    expect(findAdminParent(routes)!.canActivate).toEqual([AuthGuard]);
  });

  it('(AC1) the deep link is NO LONGER a top-level route', () => {
    // The re-parenting is only real if the old entry is gone: two entries for
    // one URL would resolve by accident of ordering.
    expect(
      routes.some((r) => r.path === 'admin/catalog/namespace/:namespace'),
    ).toBeFalse();
  });

  it('(AC16) canDeactivate guard reference is a function', () => {
    expect(typeof namespacePanelCanDeactivate).toBe('function');
  });

  it('(AC1) existing routes (home, process, login, admin) remain intact', () => {
    // Sanity-check that the story did NOT tamper with sibling entries.
    const paths = routes.map((r) => r.path);
    expect(paths).toContain('');
    expect(paths).toContain('process/:id');
    expect(paths).toContain('login');
    expect(paths).toContain('admin');
  });

  describe('URL parsing (AC15)', () => {
    let router: Router;

    beforeEach(() => {
      TestBed.configureTestingModule({
        imports: [RouterTestingModule.withRoutes(routes)],
      });
      router = TestBed.inject(Router);
    });

    it('(AC15) /admin/catalog/namespace/foo parses as path segments', () => {
      const tree = router.parseUrl('/admin/catalog/namespace/foo');
      const segments = tree.root.children['primary']!.segments.map(
        (s) => s.path,
      );
      expect(segments).toEqual(['admin', 'catalog', 'namespace', 'foo']);
    });

    it('(AC15) URL-encoded namespace (my%20ns) decodes to "my ns"', () => {
      const tree = router.parseUrl('/admin/catalog/namespace/my%20ns');
      const segments = tree.root.children['primary']!.segments.map(
        (s) => s.path,
      );
      expect(segments[3]).toBe('my ns');
    });
  });
});
