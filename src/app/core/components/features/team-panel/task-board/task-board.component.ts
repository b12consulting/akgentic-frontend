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

/** The board as drawn. */
export interface TaskBoardView {
  /** Every task — the header counts the whole plan. */
  total: number;
  /** The rows shown: every task, or the open ones while closed are hidden. */
  rows: PlanTask[];
  colours: AgentColours;
  /** Owner names that are people rather than agents. */
  humans: ReadonlySet<string>;
}

/** One glyph per status the tool declares; its label key names it. */
interface StatusGlyph {
  icon: string;
  labelKey: string;
}

const GLYPHS: Record<KnownTaskStatus, StatusGlyph> = {
  pending: { icon: 'pi pi-circle', labelKey: 'inspector.tasks.status.pending' },
  // Spinning: work in progress. Reduced motion stops it (the stylesheet).
  started: { icon: 'pi pi-spinner pi-spin', labelKey: 'inspector.tasks.status.started' },
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
  imports: [AsyncPipe, TranslatePipe],
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

  initialOf(name: string): string {
    const bare = name.replace(/^@/, '').trim();
    return bare ? bare.slice(0, 1).toUpperCase() : '·';
  }

  /** `localStorage` throws outright when the browser blocks storage; a refused
   *  read means "show everything". The `chat-view.service.ts` pattern. */
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
