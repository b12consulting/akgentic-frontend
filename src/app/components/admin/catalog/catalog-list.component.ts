import { Component } from '@angular/core';

/**
 * PLACEHOLDER for the admin catalog list (Story 36-1).
 *
 * Holds the `/admin/catalog` route so the area's shell, rail and lazy split can
 * ship and be exercised now. Story 36-3 REPLACES this file's contents with the
 * real namespace table (per-row authorization, owner-or-admin delete); the path
 * is deliberately the one that story targets, so nothing has to move.
 */
@Component({
  selector: 'app-admin-catalog-list',
  standalone: true,
  template: `
    <div data-test="admin-catalog-pane" class="admin-pane">
      <h2>Catalog</h2>
    </div>
  `,
})
export class CatalogListComponent {}
