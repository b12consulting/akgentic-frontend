import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Observable, combineLatest } from 'rxjs';
import { map } from 'rxjs/operators';

import { TagModule } from 'primeng/tag';

import { AuthService } from '../../core/auth/auth.service';
import { AdminSectionCounts } from './admin-section-counts.service';
import { AdminSection, reachableSections } from './admin-sections';

/**
 * One rail entry: the section, plus what the pane behind it has published.
 *
 * `count === null` is UNKNOWN and renders no badge — not `0`. The two are
 * different facts (Story 36-9), the same way `catalog-empty` and
 * `catalog-load-failed` are next door.
 */
export interface AdminRailItem {
  readonly section: AdminSection;
  readonly count: number | null;
}

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
 *
 * Story 36-9 gave the rail an eyebrow and a trailing count per item. The shell
 * still issues NO request: the counts arrive through `AdminSectionCounts`,
 * published by the panes that already loaded the data.
 */
@Component({
  selector: 'app-admin-shell',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive, RouterOutlet, TagModule],
  templateUrl: './admin-shell.component.html',
  styleUrls: ['./admin-shell.component.scss'],
})
export class AdminShellComponent {
  private authService = inject(AuthService);
  readonly #counts = inject(AdminSectionCounts);

  readonly sections$: Observable<AdminSection[]> =
    this.authService.isAdmin$.pipe(map((isAdmin) => reachableSections(isAdmin)));

  /**
   * The rail, as ONE view model: the reachable sections zipped with whatever
   * the panes have published for them.
   *
   * Composed here rather than in the template so the `*ngIf` that hides a
   * one-section rail keeps reading a plain `length`, and so a count of `0`
   * cannot be swallowed by an `as` binding (`0` is falsy). The lookup is keyed
   * by `section.path` and total: a section nobody publishes for reads as
   * unknown, which is the honest answer.
   */
  readonly railItems$: Observable<AdminRailItem[]> = combineLatest([
    this.sections$,
    this.#counts.catalog$,
    this.#counts.apiKeys$,
  ]).pipe(
    map(([sections, catalog, apiKeys]) => {
      const byPath: Record<string, number | null> = {
        catalog,
        'api-keys': apiKeys,
      };
      return sections.map((section) => ({
        section,
        count: byPath[section.path] ?? null,
      }));
    }),
  );
}
