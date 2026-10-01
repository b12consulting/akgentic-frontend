import { AsyncPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { TranslatePipe } from '@ngx-translate/core';
import { combineLatest, map, Observable } from 'rxjs';

import { CategoryService } from '../../../../services/category.service';
import { IngestionService } from '../../../../services/process/event/ingestion.service';
import { isHumanNode } from '../../../../services/process/selectors/actor-kind';
import {
  AgentColours,
  agentColours,
} from '../../../../services/process/selectors/agent-colour';
import { GraphDataService } from '../../../../services/process/selectors/graph.selector';
import {
  isClosedTask,
  isKnownTaskStatus,
  KnownTaskStatus,
  PlanTask,
  planningTasks,
} from '../../../../services/process/selectors/task-board';
import { actorInitial, DisplayActorNamePipe } from '../../../../shared/util/util';

/** The board as drawn. */
export interface TaskBoardView {
  /** Every task — the header counts the whole plan. */
  total: number;
  /** The rows shown: every task, or the open ones while closed are hidden. */
  rows: PlanTask[];
  colours: AgentColours;
  /** Owner names that are people rather than agents. */
  humans: ReadonlySet<string>;
  /** Owner names processing a message right now (the roster's `thinking`). */
  busy: ReadonlySet<string>;
}

/** One glyph per status the tool declares; its label key names it. */
interface StatusGlyph {
  icon: string;
  labelKey: string;
}

const GLYPHS: Record<KnownTaskStatus, StatusGlyph> = {
  // Not started yet: a plain ring, set in the idle-dot grey by the stylesheet.
  pending: { icon: 'pi pi-circle glyph-pending', labelKey: 'inspector.tasks.status.pending' },
  // Work in progress. It SPINS only while its owner is processing a message
  // (the template adds `pi-spin` from the roster's `thinking`); a started task
  // whose owner is idle keeps the still spinner. Reduced motion stops the spin.
  started: { icon: 'pi pi-spinner', labelKey: 'inspector.tasks.status.started' },
  completed: { icon: 'pi pi-check', labelKey: 'inspector.tasks.status.completed' },
  abort: { icon: 'pi pi-times', labelKey: 'inspector.tasks.status.abort' },
};

const UNKNOWN_GLYPH = 'pi pi-question';

/** Where the viewer's "Hide closed" choice is kept, per browser. */
export const TASK_BOARD_HIDE_CLOSED_KEY = 'akgentic.taskBoard.hideClosed';

/**
 * The Team tab's task board: the planning tool's tasks, as the agents see
 * them, just above the usage card.
 *
 * A projection of the roster and the per-agent state store — see
 * `task-board.ts` — so it follows every `StateChangedMessage` live and on
 * replay. Draws nothing when the team has no planning tool or no tasks.
 *
 * MONOCHROME: one glyph per status, text and muted tones only, the accent
 * spent once on the started glyph. The owner is its avatar alone, the name in
 * its title, so the description keeps the width at any pane size.
 */
@Component({
  selector: 'app-task-board',
  standalone: true,
  imports: [AsyncPipe, DisplayActorNamePipe, TranslatePipe],
  templateUrl: './task-board.component.html',
  styleUrl: './task-board.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskBoardComponent {
  private readonly categories = inject(CategoryService);

  /** The viewer's "Hide closed" choice, remembered across visits. */
  readonly hideClosed = signal(this.readHideClosed());

  readonly view$: Observable<TaskBoardView> = combineLatest([
    inject(GraphDataService).nodes$,
    inject(IngestionService).state.all$,
    toObservable(this.hideClosed),
  ]).pipe(
    map(([nodes, states, hideClosed]) => {
      const tasks = planningTasks(nodes, states);
      return {
        total: tasks.length,
        rows: hideClosed ? tasks.filter((task) => !isClosedTask(task)) : tasks,
        colours: agentColours(nodes, this.categories.COLORS),
        humans: new Set(nodes.filter(isHumanNode).map((node) => node.actorName)),
        // Members processing a message right now: the same `thinking` flag the
        // member cards' active dot reads.
        busy: new Set(nodes.filter((node) => node.thinking === true).map((node) => node.actorName)),
      };
    }),
  );

  toggleHideClosed(): void {
    this.hideClosed.update((hide) => !hide);
    this.writeHideClosed();
  }

  /** The status's glyph, `?` for one the tool does not declare. */
  glyphOf(status: string): string {
    return isKnownTaskStatus(status) ? GLYPHS[status].icon : UNKNOWN_GLYPH;
  }

  /** A known status's label key; `null` for an unknown one, named as sent. */
  labelKeyOf(status: string): string | null {
    return isKnownTaskStatus(status) ? GLYPHS[status].labelKey : null;
  }

  isClosed(task: PlanTask): boolean {
    return isClosedTask(task);
  }

  /** A started task spins only while its owner is processing a message. */
  isSpinning(task: PlanTask, busy: ReadonlySet<string>): boolean {
    return task.status === 'started' && task.owner !== '' && busy.has(task.owner);
  }

  initialOf(name: string): string {
    return actorInitial(name);
  }

  /** `localStorage` throws outright when the browser blocks storage; a refused
   *  read means "show everything". */
  private readHideClosed(): boolean {
    try {
      return localStorage.getItem(TASK_BOARD_HIDE_CLOSED_KEY) === 'true';
    } catch {
      return false;
    }
  }

  private writeHideClosed(): void {
    try {
      localStorage.setItem(TASK_BOARD_HIDE_CLOSED_KEY, String(this.hideClosed()));
    } catch {
      /* storage unavailable — the choice still applies for this visit */
    }
  }
}
