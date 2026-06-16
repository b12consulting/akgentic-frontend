import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TabsModule } from 'primeng/tabs';

import { WorkspaceRegistryService } from '../../selectors/workspace-registry.selector';
import { WorkspaceExplorerComponent } from '../workspace-explorer/workspace-explorer.component';

/**
 * Workspace sub-tabs view — Story 23-3 (ADR-019 §Decision 4).
 *
 * Renders one PrimeNG `<p-tabpanel>` per `WorkspaceDescriptor` emitted by
 * `WorkspaceRegistryService.workspaces$`, each hosting an
 * `<app-workspace-explorer>`. A non-default descriptor binds its
 * `workspaceId`; the default descriptor leaves the explorer's `workspaceId`
 * unset (`undefined`) so it keeps today's team-id-only behaviour.
 *
 * When only the default descriptor is present the view renders a single
 * explorer with NO tab chrome — visually identical to today's single-pane
 * Workspace view (FR13). Tab chrome appears only once at least one named
 * workspace is discovered.
 *
 * `WorkspaceRegistryService` is NOT re-provided here — it is provided by
 * `ProcessComponent` so the view shares the component-scoped
 * `MessageLogService` lifecycle.
 */
@Component({
  selector: 'app-workspace-tabs',
  standalone: true,
  imports: [CommonModule, TabsModule, WorkspaceExplorerComponent],
  templateUrl: './workspace-tabs.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceTabsComponent {
  readonly workspaces$ = inject(WorkspaceRegistryService).workspaces$;
}
