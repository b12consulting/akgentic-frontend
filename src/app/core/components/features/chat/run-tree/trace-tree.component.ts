import { CommonModule } from '@angular/common';
import {
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  NgZone,
  output,
  signal,
  untracked,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

import { ActorAddress } from '../../../../protocol/message.types';
import {
  AgentColours,
  NO_AGENT_COLOURS,
} from '../../../../services/process/selectors/agent-colour';
import { RunGraph, RunKey } from '../../../../services/process/selectors/run-graph.selector';
import { traceDuration } from '../../../../services/process/selectors/trace-summary';
import {
  buildTraceTree,
  excerpt,
  JoinPhrase,
  trackTraceChild,
  TraceRunNode,
  TraceTreeChild,
} from '../../../../services/process/selectors/trace-tree';
import { actorInitial, DisplayActorNamePipe } from '../../../../shared/util/util';
import { RunSelectionState } from '../../../../services/process/ui-state/run-selection';
import { TraceFoldState } from '../../../../services/process/ui-state/trace-fold-state';

type TraceLeaf = Exclude<TraceTreeChild, TraceRunNode>;

/** One visible row of the tree, with its indentation. */
export type TraceTreeRow =
  | {
      kind: 'run';
      node: TraceRunNode;
      depth: number;
      expandable: boolean;
      expanded: boolean;
      track: string;
    }
  | { kind: 'leaf'; leaf: TraceLeaf; depth: number; track: string };

/** The rows a reader sees: a node's children only while it is expanded. */
export function visibleRows(
  node: TraceRunNode,
  isExpanded: (key: RunKey) => boolean,
  depth = 0,
): TraceTreeRow[] {
  const expandable = node.children.length > 0;
  const expanded = expandable && isExpanded(node.key);
  const rows: TraceTreeRow[] = [
    { kind: 'run', node, depth, expandable, expanded, track: node.key },
  ];
  if (!expanded) return rows;
  for (const child of node.children) {
    if (child.kind === 'run') rows.push(...visibleRows(child, isExpanded, depth + 1));
    else rows.push({ kind: 'leaf', leaf: child, depth: depth + 1, track: trackTraceChild(child) });
  }
  return rows;
}

/**
 * The run tree inside an open trace card (Epic 55, ADR-037 §D2, §D5–§D7).
 *
 * Each run is a two-line node: who ran and on what, then what it did. The tree
 * is rendered as a flat list of VISIBLE rows with a depth, so `@for` tracks
 * every row by run key or message id and a re-emission never rebuilds a row the
 * reader is looking at (Trap 7). Fold state is the process-scoped
 * `TraceFoldState`, keyed by run key.
 *
 * The CLOCK lives here and nowhere else: a node that is `running` or `waiting`
 * shows a ticking elapsed time. One interval runs while any visible node needs
 * it and stops when none does; the fold and the selectors stay clock-free.
 */
@Component({
  selector: 'app-trace-tree',
  standalone: true,
  imports: [CommonModule, DisplayActorNamePipe, TranslatePipe],
  templateUrl: './trace-tree.component.html',
  styleUrl: './trace-tree.component.scss',
})
export class TraceTreeComponent {
  graph = input.required<RunGraph>();
  root = input.required<RunKey>();
  agentColours = input<AgentColours>(NO_AGENT_COLOURS);
  /** Inner id → envelope id of the bubbles the transcript renders. */
  bubbleIds = input<ReadonlyMap<string, string>>(new Map());
  /** The node a provenance click is flashing. */
  flashingRun = input<RunKey | null>(null);

  /** A waiting seat's Answer button, by the seat's run key. */
  answer = output<RunKey>();
  /** A run node was clicked: the panel selects it. */
  selectRun = output<RunKey>();
  /** An absorbed leaf or join row was clicked: the absorbing run, for the
   *  panel to select and flash. */
  selectAbsorbed = output<RunKey>();
  /** The `@Human` row under the pointer, as its bubble's envelope id. */
  humanRowHover = output<string | null>();
  /** The `@Human` row's "in chat" button, as its bubble's envelope id. */
  showInChat = output<string>();

  readonly folds = inject(TraceFoldState);
  /** The selected run, drawn as such wherever its node is visible. Read, never
   *  written here: the node's click goes up as `selectRun`. */
  readonly selection = inject(RunSelectionState);
  /** The `@Human` row under the pointer, by inner id. */
  private hoveredHuman: string | null = null;

  readonly tree = computed(() => buildTraceTree(this.graph(), this.root()));

  readonly rows = computed<TraceTreeRow[]>(() => {
    const tree = this.tree();
    const root = this.root();
    return tree ? visibleRows(tree, (key) => this.folds.isNodeExpanded(key, root)) : [];
  });

  /** The tree's only clock. */
  readonly now = signal(Date.now());
  private readonly live = computed(() =>
    this.rows().some(
      (r) => r.kind === 'run' && (r.node.status === 'running' || r.node.status === 'waiting'),
    ),
  );
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly zone = inject(NgZone);

  constructor() {
    effect(() => {
      const live = this.live();
      untracked(() => (live ? this.startClock() : this.stopClock()));
    });
    inject(DestroyRef).onDestroy(() => this.stopClock());
  }

  /** Clear the hovered `@Human` row's highlight without a `mouseleave`. */
  private releaseHover(): void {
    if (this.hoveredHuman !== null) this.onHumanHover(this.hoveredHuman, false);
  }

  private startClock(): void {
    if (this.timer !== null) return;
    this.now.set(Date.now());
    // Outside the zone, so a ticking node never keeps the app "unstable"; the
    // signal write alone schedules the re-render.
    this.timer = this.zone.runOutsideAngular(() =>
      setInterval(() => this.now.set(Date.now()), 1000),
    );
  }

  private stopClock(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Line 1's time: elapsed while running or waiting, else the duration. */
  timeOf(node: TraceRunNode): string | null {
    const { start, end } = node.run;
    switch (node.status) {
      case 'running':
      case 'waiting':
        return traceDuration(start, new Date(this.now()));
      case 'answered':
        return node.answeredAfterMs === null
          ? null
          : traceDuration(new Date(0), new Date(node.answeredAfterMs));
      case 'done':
        return traceDuration(start, end);
    }
  }

  excerptOf(node: TraceRunNode): string {
    return excerpt(node.trigger?.content);
  }

  joinKey(phrase: JoinPhrase): string {
    switch (phrase) {
      case 'yours':
        return 'chat.runTree.node.joinYours';
      case 'answer':
        return 'chat.runTree.node.joinAnswer';
      case 'reply':
        return 'chat.runTree.node.joinReply';
    }
  }

  colourOf(agent: ActorAddress): string | null {
    return this.agentColours().of(agent.name);
  }

  initialOf(agent: ActorAddress): string {
    return actorInitial(agent.name);
  }

  bubbleOf(messageId: string): string | null {
    return this.bubbleIds().get(messageId) ?? null;
  }

  /** A click on the run selects it and, when it has children, folds or
   *  unfolds them as its caret does. The caret itself only folds. */
  onNode(key: RunKey, expandable: boolean): void {
    if (expandable) this.onChevron(key);
    this.selectRun.emit(key);
  }

  /** An absorbed leaf or a join row names the run that took the message in:
   *  the only run that read it, and where the inspector shows it whole. The
   *  panel selects it and flashes its node, as a provenance link does. */
  onAbsorbed(key: RunKey): void {
    this.selectAbsorbed.emit(key);
  }

  /** A fold that hides the hovered `@Human` row clears its bubble's highlight:
   *  a row that is gone fires no `mouseleave`. */
  onChevron(key: RunKey): void {
    this.folds.toggleNode(key, this.root());
    const hovered = this.hoveredHuman;
    if (hovered === null) return;
    const visible = this.rows().some(
      (r) => r.kind === 'leaf' && r.leaf.kind === 'human' && r.leaf.messageId === hovered,
    );
    if (!visible) this.onHumanHover(hovered, false);
  }

  /** Answer sits beside the node button; stop the click all the same, so a
   *  later row-level handler never sees it twice (the chevron pattern). */
  onAnswer(event: MouseEvent, key: RunKey): void {
    event.stopPropagation();
    this.answer.emit(key);
  }

  /** Fail-open: a row whose bubble is not rendered highlights nothing. */
  onHumanHover(messageId: string, entering: boolean): void {
    this.hoveredHuman = entering ? messageId : null;
    const bubble = this.bubbleOf(messageId);
    if (bubble === null) return;
    this.humanRowHover.emit(entering ? bubble : null);
  }

  /** The scroll moves the row out from under the pointer, and the flash takes
   *  over from the hover wash: release the hover first. */
  onShowInChat(messageId: string): void {
    this.releaseHover();
    const bubble = this.bubbleOf(messageId);
    if (bubble !== null) this.showInChat.emit(bubble);
  }
}
