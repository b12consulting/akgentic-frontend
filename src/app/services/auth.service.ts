import { inject, Injectable } from '@angular/core';
import { BehaviorSubject, from, Observable, of } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';
import { ConfigService } from './config.service';

const ANONYMOUS_USER = { user_id: 'anonymous', email: '', name: 'Anonymous' };

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private config = inject(ConfigService);
  private currentUserSubject = new BehaviorSubject<any>(ANONYMOUS_USER);
  currentUser$ = this.currentUserSubject.asObservable();

  /**
   * Check auth status against the backend.
   * - Community tier (hideLogin=true): returns anonymous immediately.
   * - Enterprise tier: calls GET /auth/me with session cookie.
   */
  checkAuth(): Observable<any> {
    if (this.config.hideLogin) {
      return of(ANONYMOUS_USER);
    }

    const options: RequestInit = { credentials: 'include' };
    return from(
      fetch(`${this.config.api}/auth/me`, options).then(async (r) => {
        if (!r.ok) return null;
        return r.json();
      })
    ).pipe(
      tap((user) => {
        if (user) {
          // Ensure name is never empty — fall back to email or user_id
          if (!user.name) {
            user.name = user.email || user.user_id || 'User';
          }
          this.currentUserSubject.next(user);
        } else {
          this.currentUserSubject.next(ANONYMOUS_USER);
        }
      }),
      catchError(() => {
        this.currentUserSubject.next(ANONYMOUS_USER);
        return of(null);
      })
    );
  }

  get currentUserValue(): any {
    return this.currentUserSubject.value;
  }

  /**
   * Authenticate with an API key against the backend.
   *
   * Drives `GET /auth/login/apikey?apikey=<key>` with `credentials: 'include'`
   * so the backend's `Set-Cookie` session response is stored by the browser.
   * The same endpoint contract is exposed by both the Department and Enterprise
   * tiers, so this single code path covers both — no tier-specific branching.
   *
   * The API key is sent once as a query parameter and is NEVER persisted in the
   * browser; the session cookie set by the backend is the sole post-login
   * credential, exactly as on the OAuth path.
   *
   * On a successful (non-error) response, `checkAuth()` refreshes
   * `currentUserSubject` from `GET /auth/me` and the observable completes with
   * the resolved user. On a non-OK response (e.g. HTTP 401 for an invalid,
   * unknown, or expired key) the observable errors so the caller can surface
   * the message.
   */
  loginWithApiKey(apiKey: string): Observable<any> {
    const url = `${this.config.api}/auth/login/apikey?apikey=${encodeURIComponent(apiKey)}`;
    const options: RequestInit = { credentials: 'include' };
    return from(
      fetch(url, options).then((r) => {
        // The backend 302-redirects on success; `fetch` follows it
        // transparently, so a non-error final response means the session
        // cookie was set. A 401 (invalid/unknown/expired key) is not ok.
        if (!r.ok) {
          throw new Error('Invalid API key');
        }
        return r;
      })
    ).pipe(
      // Refresh currentUserSubject from GET /auth/me using the new session
      // cookie, then complete with the resolved user.
      switchMap(() => this.checkAuth())
    );
  }

  /** Logout: redirect to backend logout which clears session and redirects to IdP logout. */
  logout(): void {
    if (this.config.hideLogin) {
      return;
    }
    // Full browser redirect — the backend clears the session and redirects
    // to the IdP's end_session_endpoint, which clears the SSO session and
    // redirects back to /login.
    window.location.href = `${this.config.api}/auth/logout`;
  }
}
