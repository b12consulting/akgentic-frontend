import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, of } from 'rxjs';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private currentUserSubject = new BehaviorSubject<any>({
    user_id: 'anonymous',
    email: '',
    name: 'Anonymous',
  });
  currentUser$ = this.currentUserSubject.asObservable();

  /** Returns anonymous user immediately -- no server call (community tier). */
  checkAuth(): Observable<any> {
    return of({ user_id: 'anonymous', email: '', name: 'Anonymous' });
  }

  /** Returns the current user value (anonymous for community tier). */
  get currentUserValue(): any {
    return this.currentUserSubject.value;
  }

  // --- Backward-compatible stubs (Story 1.2 will remove these) ---

  /** @deprecated No-op in community tier. */
  loginWithApiKey(_apiKey: string): Observable<any> {
    return of({ success: true, user: this.currentUserValue });
  }

  /** @deprecated No-op in community tier. */
  setApiKey(_apiKey: string): void {}

  /** @deprecated No-op in community tier. */
  clearApiKey(): void {}

  /** @deprecated No-op in community tier. */
  getApiKey(): string | null {
    return null;
  }

  /** @deprecated No-op in community tier. */
  getAuthHeaders(): any {
    return {};
  }

  /** @deprecated No-op in community tier -- navigates to home. */
  logout(): void {
    console.warn('logout is a no-op in community tier');
  }
}
