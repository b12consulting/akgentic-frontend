import { CommonModule } from '@angular/common';
import { Component, computed, inject, input, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

import { I18nService } from '../../../../platform/i18n/i18n.service';
import { ActorAddress } from '../../../../protocol/message.types';
import {
  AgentColours,
  NO_AGENT_COLOURS,
} from '../../../../services/process/selectors/agent-colour';
import {
  EMPTY_RUN_GRAPH,
  RunGraph,
  RunKey,
} from '../../../../services/process/selectors/run-graph.selector';
import {
  traceDuration,
  TraceSummary,
} from '../../../../services/process/selectors/trace-summary';
import { TraceTreeComponent } from './trace-tree.component';

/**
 * A trace card (Epic 55, ADR-037 §D8): one per run a message of yours opened.
 *
 * The HEADER is the whole of this story's card: tree icon, stacked avatars, a
 * title in one of four states, `N runs · M tools · duration`, a status and a
 * chevron. It keeps the look of the activity fold it replaces
 * (`thinking.component`).
 *
 * It starts collapsed and owns no fold state: the panel reads `open` from the
 * process-scoped `TraceFoldState`, keyed by the root run, so a card stays open
 * across re-emissions and across a switch of view (Trap 7).
 *
 * The open body is the run tree (`TraceTreeComponent`), whose outputs the
 * card passes up unchanged.
 */
@Component({
  selector: 'app-trace-card',
  standalone: true,
  imports: [CommonModule, TranslatePipe, TraceTreeComponent],
  templateUrl: './trace-card.component.html',
  styleUrl: './trace-card.component.scss',
})
export class TraceCardComponent {
  summary = input.required<TraceSummary>();
  /** The asker, when this trace continues where an agent asked you (case 4). */
  continuesFrom = input<ActorAddress | null>(null);
  open = input<boolean>(false);
  agentColours = input<AgentColours>(NO_AGENT_COLOURS);
  graph = input<RunGraph>(EMPTY_RUN_GRAPH);
  /** Inner id → envelope id of the rendered bubbles, for the `@Human` rows. */
  bubbleIds = input<ReadonlyMap<string, string>>(new Map());
  toggle = output<RunKey>();
  answer = output<RunKey>();
  selectRun = output<RunKey>();
  humanRowHover = output<string | null>();
  showInChat = output<string>();

  private readonly i18n = inject(I18nService);

  readonly lead = computed<ActorAddress>(() => this.summary().agents[0]);

  /** Every agent after the root's, joined by the locale's own list rules —
   *  `Intl.ListFormat`, as `thinking.component` does. */
  readonly others = computed<string>(() =>
    new Intl.ListFormat(this.i18n.currentLanguage || undefined, {
      style: 'long',
      type: 'conjunction',
    }).format(
      this.summary()
        .agents.slice(1)
        .map((a) => a.name),
    ),
  );

  readonly runsKey = computed<string>(() =>
    this.summary().runCount === 1 ? 'chat.runTree.runsOne' : 'chat.runTree.runsMany',
  );

  readonly toolsKey = computed<string>(() =>
    this.summary().toolCount === 1 ? 'chat.runTree.toolsOne' : 'chat.runTree.toolsMany',
  );

  /** Shown only once the trace has ended; nothing ticks while it runs. A
   *  trace waiting on a seat has not ended, whatever its runs did, so it shows
   *  none. */
  readonly duration = computed<string | null>(() =>
    this.summary().title === 'waiting'
      ? null
      : traceDuration(this.summary().start, this.summary().end),
  );

  colourOf(agent: ActorAddress): string | null {
    return this.agentColours().of(agent.name);
  }

  initialOf(agent: ActorAddress): string {
    const name = (agent.name ?? '').replace(/^@/, '').trim();
    return name ? name.slice(0, 1).toUpperCase() : '·';
  }

  onToggle(): void {
    this.toggle.emit(this.summary().root);
  }

  /** The chevron sits inside the clickable header: stop the bubbling click so
   *  the card does not toggle twice (the `thinking.component` pattern). */
  onToggleFromButton(event: MouseEvent): void {
    event.stopPropagation();
    this.onToggle();
  }
}
