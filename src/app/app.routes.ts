import { Routes } from '@angular/router';
import { AuthGuard } from './core/auth/auth.guard';
import { HomeComponent } from './components/home/home.component';
import { LoginComponent } from './components/login/login.component';
import { ProcessComponent } from './components/process/process.component';

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
    // Story 36-1 — the admin area (catalog + API keys).
    //
    // Story 36-4 moved the Story 11.6 deep link INTO this subtree: the URL
    // `/admin/catalog/namespace/:namespace` is unchanged and still bookmarkable,
    // but it is now a child of the admin shell (see `admin.routes.ts`) so the
    // panel renders under the rail instead of replacing the whole page.
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
