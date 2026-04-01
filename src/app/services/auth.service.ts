import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { catchError, map, take, tap } from 'rxjs/operators';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  httpClient: HttpClient = inject(HttpClient);
  router: Router = inject(Router);
  private currentUserSubject = new BehaviorSubject<any>(null);
  currentUser$ = this.currentUserSubject.asObservable();

  // Storage key for API key in localStorage
  private readonly API_KEY_STORAGE_KEY = 'auth_api_key';

  constructor() {
    // Initial authentication check when the service is created
    this.checkAuth().pipe(take(1)).subscribe();
  }

  // Get stored API key from localStorage
  getApiKey(): string | null {
    return localStorage.getItem(this.API_KEY_STORAGE_KEY);
  }

  // Store API key in localStorage
  setApiKey(apiKey: string): void {
    localStorage.setItem(this.API_KEY_STORAGE_KEY, apiKey);
  }

  // Clear stored API key
  clearApiKey(): void {
    localStorage.removeItem(this.API_KEY_STORAGE_KEY);
  }

  // Create HTTP headers with API key if available
  getAuthHeaders(): HttpHeaders {
    const apiKey = this.getApiKey();
    let headers = new HttpHeaders();

    if (apiKey) {
      headers = headers.set('X-API-Key', apiKey);
    }

    return headers;
  }

  // Login with API key
  loginWithApiKey(apiKey: string): Observable<any> {
    return this.httpClient
      .get<any>(`${environment.api}/auth/login/apikey`, {
        params: { apikey: apiKey },
        withCredentials: true,
      })
      .pipe(
        tap((response) => {
          if (response.success) {
            // Store the API key for future requests
            this.setApiKey(apiKey);
            // Update authentication state
            this.currentUserSubject.next(response.user);
          }
        })
      );
  }

  // This method is triggered when you come back after the Microsoft login
  checkAuth() {
    const headers = this.getAuthHeaders();

    return this.httpClient
      .get(`${environment.api}/auth/me`, {
        headers,
        withCredentials: true,
      })
      .pipe(
        tap((user) => {
          if (user) {
            this.currentUserSubject.next(user); // Update currentUserSubject with fetched user
          } else {
            this.currentUserSubject.next(null); // No user, set null
          }
        }),
        catchError((err) => {
          this.currentUserSubject.next(null);
          return of(null); // In case of error, set user to null
        })
      );
  }

  // Logs the user out and redirects them to the login page
  logout() {
    const headers = this.getAuthHeaders();

    this.httpClient
      .get(`${environment.api}/auth/logout`, {
        headers,
        withCredentials: true,
        observe: 'response',
      })
      .pipe(
        map((response) => {
          // Check if this was an API key auth logout
          const body: any = response.body;
          if (
            body &&
            body.auth_type === 'api_key' &&
            body.action_required === 'clear_api_key'
          ) {
            this.clearApiKey();
          }

          return response;
        })
      )
      .subscribe(() => {
        this.currentUserSubject.next(null);
        if (environment.hideLogin) {
          this.router.navigate(['/']);
        } else this.router.navigate(['/login']);
      });
  }

  // Returns the current user value (user data or null)
  get currentUserValue(): any {
    return this.currentUserSubject.value;
  }
}
