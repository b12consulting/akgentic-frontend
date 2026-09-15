import { AsyncPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  inject,
  Output,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { distinctUntilChanged, map, Observable, shareReplay } from 'rxjs';

import { GraphDataService } from '../../../process/selectors/graph.selector';
import {
  buildInspectorTeam,
  inspectorTeamsEqual,
  InspectorTeamView,
} from './team-members.selector';
import { InspectorEmptyStateComponent } from '../inspector-empty-state.component';
import { MemberCardComponent } from './member-card.component';
import { ToolChipsComponent } from './tool-chips.component';
import { UsagePanelComponent } from './usage-panel.component';
import { AgentReaderService } from '../../../../core/ui/agent-reader.service';
import { CategoryService } from '../../../../core/ui/category.service';
import { agentColours } from '../../../process/selectors/agent-colour';

/**
 * The inspector's Team panel: who is on this team, what it can use, what it has
 * spent.
 *
 * BARE `inject(GraphDataService)`. The service is component-scoped on
 * `ProcessComponent` — that scoping is the only thing stopping one team's graph
 * leaking into the next one after a switch — so re-providing it here would give
 * this panel a second, permanently empty instance.
 *
 * The whole view is derived in ONE pass (`buildInspectorTeam`) so the human
 * card, the member list and the tool chips cannot disagree about who is on the
 * team. `nodes$` re-emits on every message frame and the derivation returns a
 * fresh object each time, so a STRUCTURAL comparator is what actually stops an
 * OnPush repaint per frame; a reference one would never suppress anything.
 *
 * `nodes$` is the right source rather than `AgentsByIdService`: it has stopped
 * agents SPLICED OUT (`applyStopMessage`), which is exactly the question this
 * panel answers. `agentsById$` deliberately keeps stopped agents resolvable so
 * old messages still render a name — that is a historical lookup, not a roster.
 *
 * ONE OF THE TWO MEMBER ACTIONS IS HANDLED HERE RATHER THAN EMITTED, which
 * contradicts the paragraph above and does so deliberately. "Open this member's
 * conversation" targets a dialog mounted inside the CHAT panel, on the far side
 * of the split; there is no host between the two that can see both, so an
 * output would have to be forwarded through the process view purely to be
 * forwarded on again. `AgentReaderService` — the SAME root-scoped stream the
 * chat panel subscribes to — is the seam instead, and the panel calls it.
 * `selected`, whose destination (the Member tab) IS the inspector's own, is
 * still emitted.
 */
@Component({
  selector: 'app-inspector-team-panel',
  standalone: true,
  imports: [
    AsyncPipe,
    TranslatePipe,
    InspectorEmptyStateComponent,
    MemberCardComponent,
    ToolChipsComponent,
    UsagePanelComponent,
  ],
  templateUrl: './inspector-team-panel.component.html',
  styleUrl: './inspector-team-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InspectorTeamPanelComponent {
  private readonly graph = inject(GraphDataService);
  private readonly agentReader = inject(AgentReaderService);

  /**
   * A member row was activated, by agent_id.
   *
   * Emitted rather than acted on: what "select a member" means — open the
   * Member tab, focus the member's chat — belongs to whatever mounts the
   * inspector, and this panel has no business knowing which tab strip it is
   * sitting in.
   */
  @Output() memberSelected = new EventEmitter<string>();

  /**
   * The row's trailing action: read this member's conversation.
   *
   * Forwarded straight to `AgentReaderService`. Nothing is re-emitted for a
   * host to handle, because there is no host that could — the reader is inside
   * the chat panel and the inspector's ancestors do not own it.
   *
   * Deliberately does NOT also select the member. Two affordances on one row
   * that both move the view behind the dialog would leave the user somewhere
   * they never asked to be as soon as they closed it.
   *
   * The card reports an agent_id; the reader also needs the RAW actor name to
   * address a reply, so it is resolved here off the view the rows were built
   * from. Resolving rather than widening the card's output keeps the card
   * ignorant of what the reader does with it. An id with no matching row is
   * dropped: it can only mean the roster re-emitted without this member (the
   * agent stopped), and opening a reader on somebody who just left the team is
   * worse than the click doing nothing.
   */
  onReadRequested(view: InspectorTeamView, agentId: string): void {
    const member = view.members.find((m) => m.id === agentId);
    if (!member) {
      return;
    }
    this.agentReader.open({ agentId, actorName: member.actorName });
  }

  /** The resolved categorical ramp, memoised in the service. `getComputedStyle`
   *  is a layout flush, so it is read per roster emission rather than per row. */
  private readonly categoryService = inject(CategoryService);

  /**
   * ONE COLOUR PER AGENT, from the SAME function the transcript and the
   * hierarchy graph call — see `agent-colour.ts`.
   *
   * Built over the WHOLE node list, before `buildInspectorTeam` partitions it.
   * The lookup applies its own exclusions, and handing it the already-narrowed
   * agent list would make this panel's stop assignment depend on a partition no
   * other surface performs — the two would agree until the day one of them
   * changed, which is the failure this shared function exists to prevent.
   */
  readonly view$: Observable<InspectorTeamView> = this.graph.nodes$.pipe(
    map((nodes) =>
      buildInspectorTeam(
        nodes,
        agentColours(nodes, this.categoryService.COLORS),
      ),
    ),
    distinctUntilChanged(inspectorTeamsEqual),
    shareReplay({ bufferSize: 1, refCount: true }),
  );
}
