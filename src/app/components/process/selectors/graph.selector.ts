import { inject, Injectable } from '@angular/core';
import { BehaviorSubject, distinctUntilChanged, map, Observable, shareReplay } from 'rxjs';

import { ENTRY_POINT_NAME } from './chat-message.model';
import { HUMAN_ROLE } from './actor-kind';
import {
  AkgenticMessage,
  ErrorMessage,
  isErrorMessage,
  isProcessedMessage,
  isReceivedMessage,
  isSentMessage,
  isStartMessage,
  isStopMessage,
  ProcessedMessage,
  ReceivedMessage,
  SentMessage,
  StartMessage,
  StopMessage,
} from '../../../protocol/message.types';
import { EdgeInterface, NodeInterface } from '../models/types';
import { CategoryService, readToken } from '../../../core/ui/category.service';
import { MessageLogService } from '../event/message-log.service';

/**
 * Re-exported, not declared. The constant now belongs to `actor-kind.ts` with
 * the predicates that read it; this line keeps every existing importer of
 * `graph.selector` working rather than rewriting a dozen import sites to prove
 * a point about where a string lives.
 */
export { HUMAN_ROLE } from './actor-kind';
export const ORCHESTRATOR_CLASS = 'akgentic.core.orchestrator.Orchestrator';

/**
 * The ink an ERRORED or a THINKING node is drawn in, resolved to a literal.
 *
 * This used to be the CSS keyword `darkred`, which is the one colour on this
 * canvas no deployment could re-point — a rebrand moved every other mark and
 * left failure painted in a keyword from 1996. It is `--akg-danger-fg` now,
 * the same token the Messages tab paints an error severity in, so "this went
 * wrong" is one colour across the console rather than two that happen to both
 * be red.
 *
 * RESOLVED IN JS, not handed over as `var()`: echarts draws this series with
 * the canvas renderer and a canvas has no cascade (see `readToken`).
 *
 * MEMOISED because this is called from the fold, which re-runs over the WHOLE
 * log on every websocket frame, and `getComputedStyle` flushes layout.
 *
 * FALLS BACK to the old keyword when the token is undeclared. `readToken`
 * returns `''` for a missing property, and `''` as a fill is not "no colour" —
 * it is a parse failure that would leave a failed agent indistinguishable from
 * a healthy one. A stylesheet that never loaded should degrade to the previous
 * behaviour, not to silence.
 */
let dangerInkCache: string | null = null;
export function dangerInk(): string {
  dangerInkCache ??= readToken('--akg-danger-fg') || 'darkred';
  return dangerInkCache;
}

/** Test seam: drop the memo so a spec can change the token and re-read it. */
export function resetDangerInk(): void {
  dangerInkCache = null;
}

/**
 * Helper class to build nodes/edges from messages.
 */
export class GraphBuilder {
  message: AkgenticMessage;
  constructor(msg: AkgenticMessage) {
    this.message = msg;
  }

  get source() {
    return this.message.sender?.agent_id || '';
  }

  get target() {
    if (isSentMessage(this.message)) {
      return this.message.recipient?.agent_id || '';
    }
    throw new Error('Message does not have a recipient');
  }

  buildEdge(): EdgeInterface {
    if (!this.message.__model__.includes('SentMessage')) {
      throw new Error('Invalid message type for edge');
    }
    return {
      source: this.source,
      target: this.target,
    };
  }

  isNewEdge(edges: any[]) {
    return !edges.find(
      (e) => e.source === this.source && e.target === this.target
    );
  }

  buildNode(): NodeInterface {
    if (!isStartMessage(this.message)) {
      throw new Error('Invalid message type for node');
    }
    const userProxy = this.message.sender.role === HUMAN_ROLE;
    return {
      name: this.message.sender.agent_id,
      role: this.message.sender.role,
      actorName: this.message.sender.name,
      parentId: this.message.parent?.agent_id ?? '',
      squadId: this.message.sender.squad_id || '',
      userMessage: this.message.sender.user_message || false,
      symbol: userProxy ? 'circle' : 'roundRect',
      category: 0,
    };
  }

  /**
   * Pure variant of `setHumanRequest`: returns a new nodes array with the
   * targeted node replaced by a new object carrying an updated
   * `humanRequests`. Returns the SAME `nodes` reference when no change is
   * required (AC7 reference-equality contract).
   */
  setHumanRequestPure(nodes: NodeInterface[]): NodeInterface[] {
    if (!isSentMessage(this.message)) return nodes;
    if (!this.message.recipient.role.includes(HUMAN_ROLE)) return nodes;
    if (this.message.recipient.name === ENTRY_POINT_NAME) return nodes;
    if (this.message.message.display_type !== 'other') return nodes;

    const senderId = this.message.sender?.agent_id;
    const idx = nodes.findIndex((n) => n.name === senderId);
    if (idx === -1) return nodes;
    const target = nodes[idx];
    const updated: NodeInterface = {
      ...target,
      humanRequests: [...(target.humanRequests || []), this.message],
    };
    return [...nodes.slice(0, idx), updated, ...nodes.slice(idx + 1)];
  }

  /**
   * Pure variant of `unSetHumanRequest`: returns a new nodes array with the
   * targeted node replaced by a new object whose `humanRequests` has the
   * answered entry removed. Returns the SAME `nodes` reference when no change
   * is required (AC7 reference-equality contract).
   */
  unSetHumanRequestPure(nodes: NodeInterface[]): NodeInterface[] {
    if (!isSentMessage(this.message)) return nodes;
    if (this.message.sender?.role !== HUMAN_ROLE) return nodes;
    const recipientId = this.message.recipient?.agent_id;
    const parentMessageId = this.message.message.parent_id;
    const idx = nodes.findIndex((n) => n.name === recipientId);
    if (idx === -1) return nodes;
    const target = nodes[idx];
    if (!target.humanRequests) return nodes;
    const filtered = target.humanRequests.filter(
      (m: SentMessage) => m.message.id !== parentMessageId,
    );
    if (filtered.length === target.humanRequests.length) return nodes;
    const updated: NodeInterface = { ...target, humanRequests: filtered };
    return [...nodes.slice(0, idx), updated, ...nodes.slice(idx + 1)];
  }
}

/**
 * Story 6.3 (ADR-005 §Decision 4, FR6) — pure graph state.
 *
 * Mirrors the three `BehaviorSubject` slices the old imperative
 * `GraphDataService` exposed (nodes$/edges$/categories$). `EMPTY_GRAPH`
 * is the seed for `graphFold` and the late-subscriber initial value.
 */
export interface GraphState {
  nodes: NodeInterface[];
  edges: EdgeInterface[];
  squad: any[];
}

export const EMPTY_GRAPH: GraphState = { nodes: [], edges: [], squad: [] };

// ---------------------------------------------------------------------------
// Module-scope pure helpers (Task 1.2) — one per domain rule. Each returns the
// SAME state reference for no-op cases (AC7 reference-equality contract) and a
// fresh object with ONLY changed slices replaced for changes.
//
// `CategoryService` is passed through as a companion DI dependency, but the
// per-message helpers only READ from it (`COLORS`). Everything the service
// carries FOR other components — `.nodes`, `.squadDict`, the legend selection —
// is republished once per fold by `syncCategoryCompanions`, from the fold's
// result. It used to be written per message from inside `applyStartMessage`,
// which re-ran it on every frame (the fold replays the whole log each emission)
// and skipped it entirely for a log that folds to nothing. External consumers
// (MessageListComponent, tree/graph components) read the same properties as
// before.
// ---------------------------------------------------------------------------

function applyStartMessage(
  state: GraphState,
  msg: StartMessage,
  categoryService: CategoryService,
): GraphState {
  if (msg.sender.__actor_type__ === ORCHESTRATOR_CLASS) return state;

  const builder = new GraphBuilder(msg);
  const node = builder.buildNode();

  // An agent that announces itself again without an intervening `StopMessage`
  // is the SAME participant, not a second one. Appending unconditionally put
  // two nodes carrying the same `name` into the echarts series, where names are
  // the node key: the pair draws on top of each other, edge endpoints resolve
  // ambiguously, and `applyStopMessage` — which splices the FIRST match — later
  // leaves a ghost of a stopped agent on the canvas for ever.
  if (state.nodes.some((n) => n.name === node.name)) return state;

  // The category IS the index into `state.squad`: squads are only ever appended,
  // and a new one takes `state.squad.length`. So the fold reads its own state
  // here rather than `categoryService.squadDict`. That lookup made a
  // component-scoped fold depend on root-scoped mutable state it had itself
  // written on an earlier frame, and returned `undefined` whenever the two had
  // drifted apart (e.g. across a team switch, which resets the log but not the
  // root-scoped service).
  let nextSquad = state.squad;
  if (node.squadId) {
    const existingIdx = state.squad.findIndex((c) => c.squadId === node.squadId);
    if (existingIdx !== -1) {
      node.category = existingIdx;
    } else {
      const newIndex = state.squad.length;
      node.category = newIndex;
      nextSquad = [
        ...state.squad,
        {
          name: `Team ${newIndex}`,
          squadId: node.squadId,
          // Wrapped, because a deployment with more concurrent squads than the
          // palette has entries otherwise hands echarts `color: undefined` and
          // silently falls back to ITS built-in palette — the one visual escape
          // hatch through which un-themed colour reaches this canvas.
          itemStyle: {
            color:
              categoryService.COLORS[newIndex % categoryService.COLORS.length],
          },
        },
      ];
    }
  }

  return { ...state, nodes: [...state.nodes, node], squad: nextSquad };
}

function applySentMessage(state: GraphState, msg: SentMessage): GraphState {
  const builder = new GraphBuilder(msg);
  let nextEdges = state.edges;
  if (builder.isNewEdge(state.edges)) {
    nextEdges = [...state.edges, builder.buildEdge()];
  }
  // Immutable human-request bookkeeping (AC7): return a fresh nodes array
  // with only the targeted node replaced when changes occur; otherwise the
  // same reference. Replaces the former in-place mutation of
  // `node.humanRequests` which silently skipped OnPush change detection.
  let nextNodes = state.nodes;
  nextNodes = builder.setHumanRequestPure(nextNodes);
  nextNodes = builder.unSetHumanRequestPure(nextNodes);

  // Clear error state if the sender recovered (sent a message after an error).
  const senderId = msg.sender?.agent_id;
  if (senderId) {
    const idx = nextNodes.findIndex((n) => n.name === senderId);
    if (idx !== -1 && nextNodes[idx].errorMessage) {
      const { color: _, ...restStyle } = nextNodes[idx].itemStyle || {};
      const updated: NodeInterface = {
        ...nextNodes[idx],
        errorMessage: undefined,
        itemStyle: restStyle,
      };
      nextNodes = [...nextNodes.slice(0, idx), updated, ...nextNodes.slice(idx + 1)];
    }
  }

  if (nextEdges === state.edges && nextNodes === state.nodes) return state;
  return { ...state, edges: nextEdges, nodes: nextNodes };
}

function applyReceivedMessage(
  state: GraphState,
  msg: ReceivedMessage,
): GraphState {
  // Human-role agents (HumanProxy) are waiting for user input, not thinking.
  if (msg.sender?.role === HUMAN_ROLE) return state;
  const idx = state.nodes.findIndex((n) => n.name === msg.sender?.agent_id);
  if (idx === -1) return state;
  const target = state.nodes[idx];
  const updated: NodeInterface = {
    ...target,
    itemStyle: {
      ...(target.itemStyle || {}),
      borderColor: dangerInk(),
      borderWidth: 3,
    },
  };
  const nextNodes = [
    ...state.nodes.slice(0, idx),
    updated,
    ...state.nodes.slice(idx + 1),
  ];
  return { ...state, nodes: nextNodes };
}

function applyProcessedMessage(
  state: GraphState,
  msg: ProcessedMessage,
): GraphState {
  const idx = state.nodes.findIndex((n) => n.name === msg.sender?.agent_id);
  if (idx === -1) return state;
  const target = state.nodes[idx];
  if (!target.itemStyle) return state;
  // Strip thinking-border properties without mutating the existing itemStyle.
  const { borderColor: _bc, borderWidth: _bw, ...restStyle } = target.itemStyle;
  // No-op if neither border property was set — preserve slice identity.
  if (_bc === undefined && _bw === undefined) return state;
  const updated: NodeInterface = { ...target, itemStyle: restStyle };
  const nextNodes = [
    ...state.nodes.slice(0, idx),
    updated,
    ...state.nodes.slice(idx + 1),
  ];
  return { ...state, nodes: nextNodes };
}

function applyStopMessage(state: GraphState, msg: StopMessage): GraphState {
  const idx = state.nodes.findIndex((n) => n.name === msg.sender?.agent_id);
  if (idx === -1) return state;
  const nextNodes = [...state.nodes.slice(0, idx), ...state.nodes.slice(idx + 1)];
  return { ...state, nodes: nextNodes };
}

function applyErrorMessage(state: GraphState, msg: ErrorMessage): GraphState {
  const idx = state.nodes.findIndex((n) => n.name === msg.sender?.agent_id);
  if (idx === -1) return state;
  const target = state.nodes[idx];
  const updated: NodeInterface = {
    ...target,
    errorMessage: msg.content || msg.content_type || 'Error',
    itemStyle: { ...(target.itemStyle || {}), color: dangerInk() },
  };
  const nextNodes = [
    ...state.nodes.slice(0, idx),
    updated,
    ...state.nodes.slice(idx + 1),
  ];
  return { ...state, nodes: nextNodes };
}

/**
 * Pure per-message transition (Task 1.3). Discriminates on `__model__` and
 * delegates to a helper. Returns `state` unchanged for unhandled
 * discriminants (FR11 passthrough — AC6).
 */
export function graphStep(
  state: GraphState,
  msg: AkgenticMessage,
  categoryService: CategoryService,
): GraphState {
  if (!msg?.__model__) return state;
  const kind = msg.__model__.split('.').pop();
  switch (kind) {
    case 'StartMessage':
      return isStartMessage(msg)
        ? applyStartMessage(state, msg, categoryService)
        : state;
    case 'SentMessage':
      return isSentMessage(msg) ? applySentMessage(state, msg) : state;
    case 'ReceivedMessage':
      return isReceivedMessage(msg) ? applyReceivedMessage(state, msg) : state;
    case 'ProcessedMessage':
      return isProcessedMessage(msg)
        ? applyProcessedMessage(state, msg)
        : state;
    case 'StopMessage':
      return isStopMessage(msg) ? applyStopMessage(state, msg) : state;
    case 'ErrorMessage':
      return isErrorMessage(msg) ? applyErrorMessage(state, msg) : state;
    default:
      return state;
  }
}

/**
 * Republish the companion state `CategoryService` carries for the components
 * that read it imperatively instead of subscribing to `graph$`
 * (`MessageListComponent` reads `.nodes` and `.squadDict` during rendering).
 *
 * WHY this runs once per FOLD, over the fold's RESULT, rather than once per
 * message inside `applyStartMessage` where it used to live:
 *
 *  - `graph$` re-folds the WHOLE log from `EMPTY_GRAPH` on every `log$`
 *    emission, so a per-message mutation re-ran for every message on every
 *    frame. The legend-selection array in particular was `push`ed once per
 *    squad per frame and grew without bound for the whole life of the tab.
 *  - It ran only on the branch that added a node, so a log that folds to
 *    nothing — an empty log after `reset()`, i.e. every team switch — left the
 *    PREVIOUS team's roster in place, and a `StopMessage` removing a node never
 *    reached it at all. Two surfaces reading the same team then disagreed about
 *    who was in it.
 *
 * Derived from `state`, the companions are a projection of the fold and cannot
 * drift from it; that is the only definition under which they can't disagree.
 */
function syncCategoryCompanions(
  state: GraphState,
  categoryService: CategoryService,
): void {
  categoryService.nodes = state.nodes;

  const squadDict: { [key: string]: number } = {};
  state.squad.forEach((c, i) => {
    if (c?.squadId) squadDict[c.squadId] = i;
  });
  categoryService.squadDict = squadDict;

  // The legend selection is indexed BY CATEGORY, so its length has to track the
  // category count and a newly-appeared squad defaults to visible. Republished
  // only on a genuine length change: `selectedSquad$` feeds a `combineLatest` in
  // `MessageListComponent`, so an emission per websocket frame is a re-filter
  // and a re-scroll of the table for no new information. `?? true` rather than
  // `|| true` keeps a squad the user explicitly deselected deselected.
  const selected = categoryService.getSelectedCategory();
  if (selected && selected.length !== state.squad.length) {
    categoryService.setSelectedCategory(
      Array.from({ length: state.squad.length }, (_, i) => selected[i] ?? true),
    );
  }
}

/**
 * Pure fold over the full log (Task 1.4). `categoryService` is an injected
 * companion dependency: `graphStep` reads `COLORS` from it, and the fold
 * republishes its derived companion state once the reduce has settled.
 */
export function graphFold(
  log: AkgenticMessage[],
  categoryService: CategoryService,
): GraphState {
  const state = log.reduce(
    (s, m) => graphStep(s, m, categoryService),
    EMPTY_GRAPH,
  );
  syncCategoryCompanions(state, categoryService);
  return state;
}

/**
 * GraphDataService — Story 6.3 (ADR-005 §Decision 4).
 *
 * Exposes `graph$` as a pure selector over `MessageLogService.log$`. The
 * three legacy observables `nodes$` / `edges$` / `categories$` are re-derived
 * as sliced projections for downstream compatibility. Imperative state
 * (`isLoading$`) is preserved — it reflects UX concerns, not message state
 * (AC10; NFR9 "two exceptions" invariant is unaffected because it lives on
 * `GraphDataService`, not `IngestionService`).
 */
@Injectable()
export class GraphDataService {
  categoryService: CategoryService = inject(CategoryService);
  private readonly log: MessageLogService = inject(MessageLogService);

  readonly graph$: Observable<GraphState> = this.log.log$.pipe(
    map((log) => graphFold(log, this.categoryService)),
    shareReplay(1),
  );

  readonly nodes$: Observable<NodeInterface[]> = this.graph$.pipe(
    map((s) => s.nodes),
    distinctUntilChanged(),
  );
  readonly edges$: Observable<EdgeInterface[]> = this.graph$.pipe(
    map((s) => s.edges),
    distinctUntilChanged(),
  );
  readonly categories$: Observable<any[]> = this.graph$.pipe(
    map((s) => s.squad),
    distinctUntilChanged(),
  );

  /**
   * AC10 — intentionally imperative UX state (external async loading
   * indicator). NOT one of ADR-005's two exceptions — those live on
   * `IngestionService`, so NFR9's invariant is unaffected.
   */
  isLoading$: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);

  set isLoading(value: boolean) {
    this.isLoading$.next(value);
  }
}
