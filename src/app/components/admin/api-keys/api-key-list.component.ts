import { Component } from '@angular/core';

/**
 * PLACEHOLDER for the API-keys pane (Story 36-1).
 *
 * Holds the `/admin/api-keys` route so `adminGuard` and the two-section rail
 * can ship and be exercised now. Story 36-5 REPLACES this file's contents with
 * the real pane and its three states (endpoint absent / no keys / error); the
 * path is deliberately the one that story targets, so nothing has to move.
 */
@Component({
  selector: 'app-admin-api-key-list',
  standalone: true,
  template: `
    <div data-test="admin-api-keys-pane" class="admin-pane">
      <h2>API Keys</h2>
    </div>
  `,
})
export class ApiKeyListComponent {}
