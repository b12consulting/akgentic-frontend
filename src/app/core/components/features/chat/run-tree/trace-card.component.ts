import { CommonModule } from '@angular/common';
import { Component, computed, inject, input, output } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

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
import { actorInitial, displayActorName, DisplayActorNamePipe } from '../../../../shared/util/util';
import { TraceTreeComponent } from './trace-tree.component';

/** The header title, around the agent it names. */
export interface TitleParts {
  before: string;
  agent: string;
  after: string;
}

/** Stands in for the agent while the title is translated; never shown. */
const AGENT_MARK = '\u0001';

/**
 * A trace card (Epic 55, ADR-037 §D8): one per run a message of yours opened.
 *
 * The HEADER is the whole of this story's card: tree icon, stacked avatars, a
 * title in one of four states, `N runs · M tools · duration`, a status and a
 * chevron: the quiet look of the activity fold it replaced.
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
  imports: [CommonModule, DisplayActorNamePipe, TranslatePipe, TraceTreeComponent],
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
  /** The run node a provenance click is flashing, passed to the tree. */
  flashingRun = input<RunKey | null>(null);
  toggle = output<RunKey>();
  answer = output<RunKey>();
  selectRun = output<RunKey>();
  humanRowHover = output<string | null>();
  showInChat = output<string>();

  private readonly i18n = inject(I18nService);
  private readonly translate = inject(TranslateService);

  readonly lead = computed<ActorAddress>(() => this.summary().agents[0]);

  /** Every agent after the root's, joined by the locale's own list rules —
   *  `Intl.ListFormat`. */
  readonly others = computed<string>(() =>
    new Intl.ListFormat(this.i18n.currentLanguage || undefined, {
      style: 'long',
      type: 'conjunction',
    }).format(
      this.summary()
        .agents.slice(1)
        .map((a) => displayActorName(a.name)),
    ),
  );

  readonly runsKey = computed<string>(() =>
    this.summary().runCount === 1 ? 'chat.runTree.runsOne' : 'chat.runTree.runsMany',
  );

  readonly toolsKey = computed<string>(() =>
    this.summary().toolCount === 1 ? 'chat.runTree.toolsOne' : 'chat.runTree.toolsMany',
  );

  /** The `doneOne` title carries the run and tool counts itself; repeating
   *  them in the meta said everything twice. */
  readonly metaHasCounts = computed<boolean>(() => this.summary().title !== 'doneOne');

  /** Shown only once the trace has ended; nothing ticks while it runs. A
   *  trace waiting on a seat has not ended, whatever its runs did, so it shows
   *  none. */
  readonly duration = computed<string | null>(() =>
    this.summary().title === 'waiting'
      ? null
      : traceDuration(this.summary().start, this.summary().end),
  );

  /**
   * The title in one of its four states, cut around the agent it names so the
   * name alone can be set strong. The agent is translated as a marker and the
   * string split there, so the name lands wherever the locale puts it. A
   * method, not a `computed`: it follows a change of language like the pipe.
   */
  titleParts(): TitleParts {
    const { key, agent, params } = this.titleSource();
    const text = this.translate.instant(key, { ...params, agent: AGENT_MARK }) as string;
    const at = text.indexOf(AGENT_MARK);
    return at < 0
      ? { before: text, agent: '', after: '' }
      : { before: text.slice(0, at), agent, after: text.slice(at + AGENT_MARK.length) };
  }

  private titleSource(): {
    key: string;
    agent: string;
    params: Record<string, string | undefined>;
  } {
    const s = this.summary();
    switch (s.title) {
      case 'waiting':
        return {
          key: 'chat.runTree.title.waiting',
          agent: displayActorName(s.waitingOn?.name ?? ''),
          params: {},
        };
      case 'running':
        return {
          key: s.activeTool ? 'chat.runTree.title.running' : 'chat.runTree.title.working',
          agent: displayActorName(s.activeAgent?.name ?? ''),
          params: { tool: s.activeTool ?? undefined },
        };
      case 'doneMany':
        return {
          key: 'chat.runTree.title.doneMany',
          agent: displayActorName(this.lead().name),
          params: { others: this.others() },
        };
      case 'doneOne':
        return {
          key: 'chat.runTree.title.doneOne',
          agent: displayActorName(this.lead().name),
          params: {
            runs: this.translate.instant(this.runsKey(), { count: s.runCount }) as string,
            tools: this.translate.instant(this.toolsKey(), { count: s.toolCount }) as string,
          },
        };
    }
  }

  colourOf(agent: ActorAddress): string | null {
    return this.agentColours().of(agent.name);
  }

  initialOf(agent: ActorAddress): string {
    return actorInitial(agent.name);
  }

  onToggle(): void {
    this.toggle.emit(this.summary().root);
  }

  /** The chevron sits inside the clickable header: stop the bubbling click so
   *  the card does not toggle twice. */
  onToggleFromButton(event: MouseEvent): void {
    event.stopPropagation();
    this.onToggle();
  }
}
