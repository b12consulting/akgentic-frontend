import { Routes } from '@angular/router';

import { AdminShellComponent } from './admin-shell.component';
import { adminGuard } from './admin.guard';

/**
 * The admin area's child route table (Story 36-1).
 *
 * Reached from `app.routes.ts` through a dynamic `import()`, so this file and
 * everything it pulls in are a lazy chunk — the shell never weighs on the
 * initial bundle. The two panes are `loadComponent`-split on top of that, so a
 * visitor to the catalog does not download the API-key pane.
 *
 * The shell is a component-less-path layout route: `''` mounts
 * `AdminShellComponent`, and the panes render into its `<router-outlet>`.
 * `AuthGuard` lives on the PARENT `admin` entry in `app.routes.ts`, not here —
 * `adminGuard` depends on it having resolved `/auth/me` first.
 */
export const ADMIN_ROUTES: Routes = [
  {
    path: '',
    component: AdminShellComponent,
    children: [
      { path: '', redirectTo: 'catalog', pathMatch: 'full' },
      {
        path: 'catalog',
        loadComponent: () =>
          import('./catalog/catalog-list.component').then(
            (m) => m.CatalogListComponent
          ),
        title: 'Catalog',
      },
      {
        path: 'api-keys',
        loadComponent: () =>
          import('./api-keys/api-key-list.component').then(
            (m) => m.ApiKeyListComponent
          ),
        title: 'API keys',
        canActivate: [adminGuard],
      },
    ],
  },
];
