import { Routes } from '@angular/router';
import { AuthGuard } from './core/auth/auth.guard';
import { HomeComponent } from './components/home/home.component';
import { LoginComponent } from './components/login/login.component';
import { ProcessComponent } from './components/process/process.component';
import { namespacePanelCanDeactivate } from './components/catalog/namespace-panel/namespace-panel.guard';

/**
 * The app's routes. Epic 56 changed none of the paths: `''` stays
 * `HomeComponent` — that IS the management view the console rail deliberately
 * does not try to replace — and `login` still renders outside the chrome.
 *
 * The four `title` values are translation KEYS, not copy. A plain string here
 * would go straight to the browser tab untranslated, because the router sets
 * the title synchronously off this property with no binding and no pipe in the
 * way. `TranslatedTitleStrategy` (registered in `app.config.ts`) is what makes
 * a key work — including re-resolving the tab when the user switches language,
 * which is not a navigation and so would otherwise be missed.
 *
 * Consequence worth knowing before adding a route: a `title` whose key is not
 * in `en.json` renders as the key itself in the tab. The locale-parity spec
 * catches an en/fr mismatch; it cannot catch a key nobody defined.
 */
export const routes: Routes = [
  {
    path: '',
    component: HomeComponent,
    title: 'title.home',
    canActivate: [AuthGuard],
  },
  {
    path: 'process/:id',
    component: ProcessComponent,
    title: 'title.process',
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
    title: 'title.catalogNamespace',
    canActivate: [AuthGuard],
    canDeactivate: [namespacePanelCanDeactivate],
  },
  { path: 'login', component: LoginComponent, title: 'title.login' },
];
