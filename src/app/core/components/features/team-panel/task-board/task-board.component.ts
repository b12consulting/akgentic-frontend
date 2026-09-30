import { AsyncPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
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
  isKnownTaskStatus,
  KnownTaskStatus,
  PlanTask,
  planningTasks,
  TaskStatusCount,
  taskStatusCounts,
} from '../../../../services/process/selectors/task-board';

/** The board as drawn: its tasks, their status counts, and how to paint an
 *  owner. */
export interface TaskBoardView {
  tasks: PlanTask[];
  counts: TaskStatusCount[];
  colours: AgentColours;
  /** Owner names that are people rather than agents. */
  humans: ReadonlySet<string>;
}

/** Literal keys, so the i18n audit can see every one of them. */
const STATUS_KEYS: Record<KnownTaskStatus, string> = {
  started: 'inspector.tasks.status.started',
  pending: 'inspector.tasks.status.pending',
  completed: 'inspector.tasks.status.completed',
  abort: 'inspector.tasks.status.abort',
};

/**
 * The Team tab's task board: the planning tool's tasks, as the agents see
 * them, just above the usage card.
 *
 * A projection of the roster and the per-agent state store — see
 * `task-board.ts` — so it follows every `StateChangedMessage` live and on
 * replay with nothing of its own to keep in step. Draws nothing at all when the
 * team has no planning tool or no tasks.
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

  readonly view$: Observable<TaskBoardView> = combineLatest([
    inject(GraphDataService).nodes$,
    inject(IngestionService).state.all$,
  ]).pipe(
    map(([nodes, states]) => {
      const tasks = planningTasks(nodes, states);
      return {
        tasks,
        counts: taskStatusCounts(tasks),
        colours: agentColours(nodes, this.categories.COLORS),
        humans: new Set(nodes.filter(isHumanNode).map((node) => node.actorName)),
      };
    }),
  );

  /** A known status's label key; an unknown status is shown as sent. */
  statusKey(status: string): string | null {
    return isKnownTaskStatus(status) ? STATUS_KEYS[status] : null;
  }

  /** Tone class for a status chip: its own for the four the tool declares,
   *  neutral for anything else. */
  statusTone(status: string): string {
    return isKnownTaskStatus(status) ? status : 'unknown';
  }

  /** Finished work reads quieter than work still to do. */
  isSettled(status: string): boolean {
    return status === 'completed' || status === 'abort';
  }

  initialOf(name: string): string {
    const bare = name.replace(/^@/, '').trim();
    return bare ? bare.slice(0, 1).toUpperCase() : '·';
  }
}
