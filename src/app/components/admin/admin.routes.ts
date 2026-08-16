import { Routes } from '@angular/router';

import { namespacePanelCanDeactivate } from '../catalog/namespace-panel/namespace-panel.guard';
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
 *
 * Story 36-4 added the namespace-panel deep link as the FIRST child, so the
 * shipped `/admin/catalog/namespace/:namespace` URL now renders inside the
 * shell rather than replacing the page.
 */
export const ADMIN_ROUTES: Routes = [
  {
    path: '',
    component: AdminShellComponent,
    children: [
      {
        // Story 11.6's deep link, re-parented here by Story 36-4. The URL it
        // produces — `/admin/catalog/namespace/:namespace` — is byte-identical
        // to the one it had as a top-level entry, because this whole table is
        // mounted under `admin`. It is shipped and bookmarkable; the path must
        // not drift.
        //
        // FIRST among the children, ahead of `catalog`. The recogniser does
        // backtrack across siblings, so `catalog` first would probably still
        // resolve — but "probably" is not a property to hang a bookmarked URL
        // on, and specific-before-generic costs nothing.
        //
        // No `canActivate`: the parent `admin` entry carries `AuthGuard` and
        // Angular runs a parent's guard to completion first. Repeating it here
        // would resolve `/auth/me` twice for no gain.
        //
        // `loadComponent` keeps the panel (and its Monaco chunk) out of the
        // admin area's own chunk; `canDeactivate` prompts before an operator
        // loses an unsaved edit buffer by navigating away.
        path: 'catalog/namespace/:namespace',
        loadComponent: () =>
          import(
            '../catalog/namespace-panel/namespace-panel-route.component'
          ).then((m) => m.NamespacePanelRouteComponent),
        title: 'Catalog namespace',
        canDeactivate: [namespacePanelCanDeactivate],
      },
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
