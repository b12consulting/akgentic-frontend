import { ChangeDetectionStrategy, Component } from '@angular/core';

import { TeamGraphComponent } from './team-graph.component';

/**
 * The inspector's hierarchy pane: the team, drawn as a graph.
 *
 * A ONE-CHILD WRAPPER, and deliberately still a component rather than being
 * collapsed into `<app-team-graph>` at the call site. `process.component.html`
 * projects a panel per tab and its specs address this pane by element; keeping
 * the seam means the pane can grow chrome of its own (a legend, a zoom control)
 * without every consumer learning what is inside it.
 *
 * It used to host a `<p-tabs>` pair — "List view" (`<app-tree>`) and "Graph
 * view". The list was removed rather than merely defaulted away from: it
 * duplicated the Team tab's roster, and a two-entry strip inside a tabbed pane
 * put two identical controls at two different depths. `TreeComponent` went with
 * it, as its only consumer.
 *
 * `TabsModule`, `TranslatePipe` and `CommonModule` are gone from the imports for
 * the same reason — nothing left in the template uses them, and a standalone
 * component's import list is the closest thing it has to a dependency
 * declaration.
 */
@Component({
  selector: 'app-team-tabs',
  standalone: true,
  imports: [TeamGraphComponent],
  templateUrl: './team-tabs.component.html',
  styleUrl: './team-tabs.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TeamTabsComponent {}
