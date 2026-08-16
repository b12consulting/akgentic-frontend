import { Routes } from '@angular/router';
import { AuthGuard } from './core/auth/auth.guard';
import { HomeComponent } from './components/home/home.component';
import { LoginComponent } from './components/login/login.component';
import { ProcessComponent } from './components/process/process.component';
import { namespacePanelCanDeactivate } from './components/catalog/namespace-panel/namespace-panel.guard';

export const routes: Routes = [
  {
    path: '',
    component: HomeComponent,
    title: 'Home page',
    canActivate: [AuthGuard],
  },
  {
    path: 'process/:id',
    component: ProcessComponent,
    title: 'Process page',
    canActivate: [AuthGuard],
  },
  {
    // Story 11.6 — deep-link route for the catalog namespace panel.
    // `loadComponent` keeps the panel (and its Monaco bundle) out of the
    // initial home-page chunk (NFR8). The functional `CanDeactivate` guard
    // prompts before losing an operator's unsaved edit buffer.
    path: 'admin/catalog/namespace/:namespace',
    loadComponent: () =>
      import(
        './components/catalog/namespace-panel/namespace-panel-route.component'
      ).then((m) => m.NamespacePanelRouteComponent),
    title: 'Catalog namespace',
    canActivate: [AuthGuard],
    canDeactivate: [namespacePanelCanDeactivate],
  },
  {
    // Story 36-1 — the admin area (catalog + API keys).
    //
    // Registered BELOW the deep-link entry above so the shipped Story 11.6 URL
    // keeps matching its own top-level route. The recogniser would probably
    // backtrack to a later sibling anyway, but the explicit order costs nothing
    // and the deep link is already in operators' bookmarks.
    //
    // `loadChildren` keeps the whole area (shell, rail, panes) out of the
    // initial bundle. `AuthGuard` here is load-bearing for `adminGuard` on the
    // api-keys child: Angular runs a parent's `canActivate` to completion
    // first, so `/auth/me` has resolved by the time the child reads roles.
    path: 'admin',
    loadChildren: () =>
      import('./components/admin/admin.routes').then((m) => m.ADMIN_ROUTES),
    canActivate: [AuthGuard],
  },
  { path: 'login', component: LoginComponent, title: 'Login page' },
];
