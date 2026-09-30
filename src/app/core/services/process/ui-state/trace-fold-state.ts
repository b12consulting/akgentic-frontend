import { Injectable, Signal, signal } from '@angular/core';

import { RunKey } from '../selectors/run-graph.selector';

/**
 * What is open in the run-tree transcript (Epic 55, ADR-037 §D6): which trace
 * cards, and which run nodes inside them.
 *
 * Keyed by RUN KEY, never by index (Trap 7): `log$` re-emits on every event and
 * a trace that grows must not collapse what the reader just opened. A card is
 * keyed by its root run; a node by its own run.
 *
 * - A card starts closed. Inside an open card only the root starts expanded;
 *   every other node starts folded until the reader toggles it.
 * - Opening a card (closed → open, by any path) expands the path to each
 *   waiting seat — the `reveal` keys — so its Answer button is visible. That is
 *   one of two things that expand a node without its chevron — the other is a
 *   selection (`expandNodes`) — and a seat that starts waiting in a card
 *   already open is not revealed.
 *
 * PROCESS-SCOPED, beside `RunGraphService`, rather than held by the panel: the
 * inspector's mini-tree selects and reveals runs too, through
 * `RunSelectionState`, whether or not the transcript is rendered. The route's
 * injector outlives a team (the router reuses it when only `:id` changes), so
 * `TeamSessionService.close()` calls `reset()` on a team switch: one team's
 * open cards never carry into the next, or back into itself.
 *
 * It lives in `ui-state/` rather than beside the panel because
 * `PROCESS_PROVIDERS` may not import from the components tier.
 */
@Injectable()
export class TraceFoldState {
  private readonly _open = signal<ReadonlySet<RunKey>>(new Set());
  /** The reader's (or a reveal's) expand state per node; absent = default. */
  private readonly _nodes = signal<ReadonlyMap<RunKey, boolean>>(new Map());

  /** The open roots, for a template that wants to react to a change. */
  readonly openKeys: Signal<ReadonlySet<RunKey>> = this._open.asReadonly();

  isOpen(root: RunKey): boolean {
    return this._open().has(root);
  }

  toggle(root: RunKey, reveal: readonly RunKey[] = []): void {
    if (this._open().has(root)) {
      const next = new Set(this._open());
      next.delete(root);
      this._open.set(next);
    } else {
      this.open(root, reveal);
    }
  }

  /** Open, never close: the absorbed-message and provenance links use this.
   *  `reveal` applies only when the card was closed. */
  open(root: RunKey, reveal: readonly RunKey[] = []): void {
    if (this._open().has(root)) return;
    this._open.set(new Set([...this._open(), root]));
    if (reveal.length === 0) return;
    const nodes = new Map(this._nodes());
    for (const key of reveal) nodes.set(key, true);
    this._nodes.set(nodes);
  }

  /** Whether node `key` of the card rooted at `root` shows its children. */
  isNodeExpanded(key: RunKey, root: RunKey): boolean {
    return this._nodes().get(key) ?? key === root;
  }

  /** Expand each of `keys` and touch no other node: a selection's reveal
   *  (ADR-037 §D6). Opens no card. */
  expandNodes(keys: readonly RunKey[]): void {
    const nodes = new Map(this._nodes());
    for (const key of keys) nodes.set(key, true);
    this._nodes.set(nodes);
  }

  toggleNode(key: RunKey, root: RunKey): void {
    const nodes = new Map(this._nodes());
    nodes.set(key, !this.isNodeExpanded(key, root));
    this._nodes.set(nodes);
  }

  /** Close every card and forget every node: the team this state described
   *  is closing. */
  reset(): void {
    this._open.set(new Set());
    this._nodes.set(new Map());
  }
}
