import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { routes } from './app.routes';

/**
 * The route table, after the catalog deep link was removed.
 *
 * This file used to be Story 11.6's spec for `/admin/catalog/namespace/:namespace`
 * — its shape, its `canActivate`, its functional `CanDeactivate` guard and its
 * URL parsing. That route is gone: nothing in the application ever linked to
 * it, so it was reachable only by typing the URL, and it was deleted along with
 * `ui/catalog/`.
 *
 * What is left is the check the old file carried as a footnote — that the
 * surviving entries are the ones the shell expects. It is small on purpose. A
 * route table is mostly declaration, and asserting each field back to itself
 * tests the test; what is worth pinning is the SET of paths, because a page
 * silently disappearing from it is the failure a reader of `app.routes.ts`
 * cannot see.
 */
describe('app.routes', () => {
  it('registers exactly the three pages the shell expects', () => {
    const paths = routes.map((r) => r.path);

    expect(paths).toContain('');
    expect(paths).toContain('process/:id');
    expect(paths).toContain('login');

    // The set, not just the members: an entry added without a decision shows up
    // here rather than being discovered in the browser.
    expect(paths.sort()).toEqual(['', 'login', 'process/:id']);
  });

  it('no longer carries the catalog deep link', () => {
    // Guards the deletion rather than the route: re-adding it silently is the
    // regression, and `ui/catalog/` no longer exists to import from.
    const paths = routes.map((r) => r.path ?? '');

    expect(paths.some((p) => p.startsWith('admin/'))).toBeFalse();
  });

  describe('URL parsing', () => {
    let router: Router;

    beforeEach(() => {
      TestBed.configureTestingModule({ providers: [provideRouter(routes)] });
      router = TestBed.inject(Router);
    });

    it('parses a team id as a path segment', () => {
      const tree = router.parseUrl('/process/team-1');
      const segments = tree.root.children['primary'].segments.map((s) => s.path);

      expect(segments).toEqual(['process', 'team-1']);
    });

    it('decodes a percent-encoded team id', () => {
      const tree = router.parseUrl('/process/my%20team');
      const segments = tree.root.children['primary'].segments.map((s) => s.path);

      expect(segments).toEqual(['process', 'my team']);
    });
  });
});
