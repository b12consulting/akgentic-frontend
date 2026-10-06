import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslatePipe } from '@ngx-translate/core';
import { map, zip } from 'rxjs';

import { I18nService } from '../../../platform/i18n/i18n.service';
import { ActorAddress, AkgenticMessage } from '../../../protocol/message.types';
import { CategoryService } from '../../../services/category.service';
import { MessageLogService } from '../../../services/process/event/message-log.service';
import {
  AgentColours,
  agentColours,
  NO_AGENT_COLOURS,
} from '../../../services/process/selectors/agent-colour';
import { GraphDataService } from '../../../services/process/selectors/graph.selector';
import {
  EMPTY_RUN_GRAPH,
  RunGraph,
  RunGraphService,
  RunKey,
} from '../../../services/process/selectors/run-graph.selector';
import {
  AbsorbedInput,
  absorbedInputs,
  buildMiniTree,
  displayedRun,
  LedgerScope,
  ledgerLines,
  MiniTreeRow,
  miniTreeRoot,
  RunPill,
  runPill,
  runSteps,
  RunStepRow,
} from '../../../services/process/selectors/run-inspector';
import { RunSelectionState } from '../../../services/process/ui-state/run-selection';
import { actorInitial, displayActorName, DisplayActorNamePipe } from '../../../shared/util/util';
import { EmptyStateComponent } from '../../primitives/empty-state/empty-state.component';

/** A mini-tree row as drawn: whether its children show. */
export interface MiniRowView extends MiniTreeRow {
  expanded: boolean;
}

/** The rows a reader sees: a row's subtree only while it is expanded. A row
 *  with children is expanded by its override, else by being on the path. */
export function visibleMiniRows(
  rows: readonly MiniTreeRow[],
  folds: ReadonlyMap<RunKey, boolean>,
): MiniRowView[] {
  const out: MiniRowView[] = [];
  let hiddenBelow = Infinity;
  for (const row of rows) {
    if (row.depth > hiddenBelow) continue;
    hiddenBelow = Infinity;
    const expanded = row.childCount > 0 && (folds.get(row.key) ?? row.onPath);
    if (row.childCount > 0 && !expanded) hiddenBelow = row.depth;
    out.push({ ...row, expanded });
  }
  return out;
}

const PILL_KEYS: Record<RunPill, string> = {
  running: 'runInspector.status.running',
  done: 'runInspector.status.done',
  doneSilent: 'runInspector.status.doneSilent',
  waiting: 'runInspector.status.waiting',
  answered: 'runInspector.status.answered',
};

interface InspectorState {
  log: readonly AkgenticMessage[];
  graph: RunGraph;
}

/**
 * The inspector's Run tab (Epic 55, ADR-037 §D9): the displayed run — the
 * selected one, else the latest running, else the latest — in four sections:
 * where it sits, what it handled, its steps, its raw events.
 *
 * It READS the selection and never writes it, except from its own mini-tree,
 * which is a user gesture: showing a fallback run highlights nothing in the
 * transcript. It does not tick — nothing here reads the clock.
 *
 * Always mounted behind `.moved-offscreen`, like every inspector panel, so the
 * default path stays cheap: the whole-team ledger is built only while that
 * mode is on, and OnPush keeps the template's method calls (`agentList`,
 * `colourOf`) off every app-wide tick — everything it shows is a signal.
 */
@Component({
  selector: 'app-run-inspector',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DisplayActorNamePipe, TranslatePipe, EmptyStateComponent],
  templateUrl: './run-inspector.component.html',
  styleUrl: './run-inspector.component.scss',
})
export class RunInspectorComponent {
  private readonly selection = inject(RunSelectionState);
  private readonly i18n = inject(I18nService);
  private readonly categories = inject(CategoryService);

  /** One pair per log emission — `zip`, never `combineLatest`, which would
   *  pair a new log with the previous graph (the `RunTreeService` reasoning). */
  private readonly state = toSignal(
    zip(inject(MessageLogService).log$, inject(RunGraphService).graph$).pipe(
      map(([log, graph]): InspectorState => ({ log, graph })),
    ),
    { initialValue: { log: [], graph: EMPTY_RUN_GRAPH } },
  );

  readonly colours = toSignal<AgentColours, AgentColours>(
    inject(GraphDataService).nodes$.pipe(
      map((nodes) => agentColours(nodes, this.categories.COLORS)),
    ),
    { initialValue: NO_AGENT_COLOURS },
  );

  readonly run = computed(() => displayedRun(this.state().graph, this.selection.selected()));
  private readonly runKey = computed(() => this.run()?.key ?? null);

  readonly pill = computed<RunPill | null>(() => {
    const key = this.runKey();
    return key === null ? null : runPill(this.state().graph, key);
  });
  readonly pillKeys = PILL_KEYS;

  readonly trigger = computed(() => {
    const run = this.run();
    return run === null ? null : (this.state().graph.messages.get(run.message_id) ?? null);
  });

  /** The run's other inputs: what it took in from its mailbox while it ran. */
  readonly absorbed = computed<AbsorbedInput[]>(() => {
    const run = this.run();
    return run === null ? [] : absorbedInputs(this.state().graph, run);
  });

  readonly steps = computed<RunStepRow[]>(() => {
    const run = this.run();
    return run === null ? [] : runSteps(this.state().graph, run);
  });

  // --- where this run sits ---------------------------------------------------

  /** The mini-tree's own folds: never `TraceFoldState`, so a toggle here moves
   *  nothing in the transcript, and the other way round. */
  private readonly miniFolds = signal<ReadonlyMap<RunKey, boolean>>(new Map());
  private readonly tree = computed(() => {
    const key = this.runKey();
    return key === null ? [] : buildMiniTree(this.state().graph, key);
  });
  readonly miniRows = computed(() => visibleMiniRows(this.tree(), this.miniFolds()));
  /** The message the tree's top run handles, drawn above the tree. */
  readonly root = computed(() => miniTreeRoot(this.state().graph, this.tree()));

  // --- event log -------------------------------------------------------------

  readonly scope = signal<LedgerScope>('run');
  readonly ledger = computed(() => {
    const run = this.run();
    return run === null ? [] : ledgerLines(this.state().log, run, this.scope());
  });

  constructor() {
    // A newly displayed run's path opens again, whatever the reader folded
    // there before: the run on display is never hidden inside its own tree.
    effect(() => {
      if (this.runKey() === null) return;
      untracked(() => this.clearPathFolds());
    });
  }

  private clearPathFolds(): void {
    const onPath = this.tree().filter((row) => row.onPath);
    if (!onPath.some((row) => this.miniFolds().has(row.key))) return;
    const folds = new Map(this.miniFolds());
    for (const row of onPath) folds.delete(row.key);
    this.miniFolds.set(folds);
  }

  toggleMini(row: MiniRowView): void {
    this.miniFolds.set(new Map(this.miniFolds()).set(row.key, !row.expanded));
  }

  /** A mini-tree node is a user gesture like any other selection. */
  selectFromTree(key: RunKey): void {
    this.selection.select(this.state().graph, key, 'mini-tree');
  }

  setScope(scope: LedgerScope): void {
    this.scope.set(scope);
  }

  runsKey(count: number): string {
    return count === 1 ? 'chat.runTree.runsOne' : 'chat.runTree.runsMany';
  }

  /** The agents a fold hides, joined by the locale's own list rules. */
  agentList(agents: readonly ActorAddress[]): string {
    return new Intl.ListFormat(this.i18n.currentLanguage || undefined, {
      style: 'long',
      type: 'conjunction',
    }).format(agents.map((a) => displayActorName(a.name)));
  }

  colourOf(agent: ActorAddress): string | null {
    return this.colours().of(agent.name);
  }

  initialOf(agent: ActorAddress): string {
    return actorInitial(agent.name);
  }
}
