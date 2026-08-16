import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map, take } from 'rxjs/operators';

import { AuthService } from '../../core/auth/auth.service';

/**
 * Keeps a non-admin out of the admin-only panes by REDIRECTING them to the
 * catalog rather than showing a dead end (Story 36-1).
 *
 * THIS GUARD IS A UX CONTRACT, NOT THE SECURITY BOUNDARY. It decides what the
 * browser offers, and nothing more: anyone can bypass it by calling the API
 * directly, and the client's notion of "admin" is a field on a response body it
 * received. What actually protects the data is the server's
 * `require_role("admin")` on the API-key routes — if that check were removed,
 * this guard would keep redirecting and the data would be wide open. Never add
 * a capability here on the strength of this guard alone.
 *
 * Redirect rather than 403: the operator asked for the admin area and the
 * catalog is the part of it they can use, so landing them there is more useful
 * than an error page. `createUrlTree` (not `router.navigate`) is the functional
 * -guard idiom — returning the tree lets the router replace the navigation in
 * one pass instead of racing a second one against it.
 *
 * `take(1)` is safe HERE because the parent `admin` route carries `AuthGuard`,
 * which resolves `/auth/me` to completion before any child guard runs — so the
 * single read sees real roles, not the anonymous seed. Drop `AuthGuard` from
 * the parent and this guard starts redirecting genuine admins.
 */
export const adminGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.isAdmin$.pipe(
    take(1),
    map((isAdmin) => isAdmin || router.createUrlTree(['/admin/catalog']))
  );
};
