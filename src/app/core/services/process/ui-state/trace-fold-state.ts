import { Injectable, Signal, signal } from '@angular/core';

import { RunKey } from '../selectors/run-graph.selector';

/**
 * Which trace cards are open in the run-tree transcript (Epic 55, ADR-037 §D6).
 *
 * Keyed by the trace's ROOT RUN KEY, never by index (Trap 7): `log$` re-emits
 * on every event and a trace that grows must not collapse the card the reader
 * just opened.
 *
 * PROCESS-SCOPED, beside `RunGraphService`, rather than held by the panel: the
 * New view switch destroys the panel, and an open card must survive a switch
 * round trip. A team switch resets it with the rest of the team's state.
 *
 * It lives in `ui-state/` rather than beside the panel because
 * `PROCESS_PROVIDERS` may not import from the components tier.
 */
@Injectable()
export class TraceFoldState {
  private readonly _open = signal<ReadonlySet<RunKey>>(new Set());

  /** The open roots, for a template that wants to react to a change. */
  readonly openKeys: Signal<ReadonlySet<RunKey>> = this._open.asReadonly();

  isOpen(root: RunKey): boolean {
    return this._open().has(root);
  }

  toggle(root: RunKey): void {
    const next = new Set(this._open());
    if (next.has(root)) next.delete(root);
    else next.add(root);
    this._open.set(next);
  }

  /** Open, never close: the absorbed-message and provenance links use this. */
  open(root: RunKey): void {
    if (this._open().has(root)) return;
    this._open.set(new Set([...this._open(), root]));
  }
}
