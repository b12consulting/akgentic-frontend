import { inject, Injectable } from '@angular/core';
import { CanActivate, Router } from '@angular/router';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { AuthService } from './services/auth.service';

@Injectable({ providedIn: 'root' })
export class AuthGuard implements CanActivate {
  authService: AuthService = inject(AuthService);
  router: Router = inject(Router);

  canActivate(): Observable<boolean> {
    return this.authService.checkAuth().pipe(
      map((user) => {
        if (user) {
          // If the user data is returned, allow access
          return true;
        } else {
          // Otherwise, redirect to the login page
          this.router.navigate(['/login']);
          return false;
        }
      }),
      catchError((err) => {
        // If there is an error (e.g. 401), redirect to the login page
        this.router.navigate(['/login']);
        return of(false);
      })
    );
  }
}
