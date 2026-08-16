import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { AuthService } from '../../core/auth/auth.service';
import { AdminSection, reachableSections } from './admin-sections';

/**
 * Layout shell for the admin area (Story 36-1).
 *
 * Renders the section rail and the `<router-outlet>` its panes mount into.
 * The rail is role-filtered and appears ONLY when more than one section is
 * reachable: with a single destination a rail is navigational noise, so the
 * element is absent from the DOM rather than rendered empty.
 *
 * `sections$` is an `Observable` derived from `AuthService.isAdmin$` and
 * consumed through the `async` pipe — `/auth/me` resolves after first render,
 * so a snapshot taken at construction would leave a genuine admin looking at
 * the non-admin layout until the next navigation.
 */
@Component({
  selector: 'app-admin-shell',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './admin-shell.component.html',
  styleUrls: ['./admin-shell.component.scss'],
})
export class AdminShellComponent {
  private authService = inject(AuthService);

  readonly sections$: Observable<AdminSection[]> =
    this.authService.isAdmin$.pipe(map((isAdmin) => reachableSections(isAdmin)));
}
