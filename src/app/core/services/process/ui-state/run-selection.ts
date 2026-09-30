import { inject, Injectable, Signal, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import { RunGraph, RunKey, traceRootOf } from '../selectors/run-graph.selector';
import { revealKeysFor } from '../selectors/run-inspector';
import { seatRevealKeys } from '../selectors/trace-tree';
import { TraceFoldState } from './trace-fold-state';

export type RunSelectionOrigin = 'provenance' | 'tree' | 'mini-tree' | 'absorbed';

export interface RunSelection {
  key: RunKey;
  origin: RunSelectionOrigin;
}

/**
 * The selected run (Epic 55, ADR-037 §D6, §D9): ONE value, shared by the
 * transcript and the inspector's Run tab, and written only by a user gesture —
 * a provenance link, a tree node, a mini-tree node, the absorbed-message note.
 * Nothing selects on its own, so nothing is highlighted until the user asks.
 *
 * The reveal is done HERE rather than by the transcript panel: a mini-tree
 * click happens in the inspector, not in the transcript. The folds are
 * process-scoped, so the reveal is too.
 *
 * Opening the inspector on the Run tab is the host's (`ProcessComponent`), the
 * only tier allowed to touch the tab mode; it answers `selections$`.
 *
 * There is no "deselect" gesture. A team switch clears it: the route's
 * injector outlives a team, so `TeamSessionService.close()` calls `reset()`,
 * and a selection never carries into the next team or back into its own.
 */
@Injectable()
export class RunSelectionState {
  private readonly folds = inject(TraceFoldState);
  private readonly _selected = signal<RunKey | null>(null);
  /** A plain `Subject`: a late subscriber must never replay a past selection
   *  and re-open an inspector the user has since closed. */
  private readonly _selections = new Subject<RunSelection>();

  readonly selected: Signal<RunKey | null> = this._selected.asReadonly();

  /** One event per user selection, including a repeat of the current key. */
  readonly selections$: Observable<RunSelection> = this._selections.asObservable();

  /** Open the run's card (revealing its waiting seats only if it was closed,
   *  as a header click does), expand its path within its trace and itself,
   *  and select it. No other fold changes. */
  select(graph: RunGraph, key: RunKey, origin: RunSelectionOrigin): void {
    const root = traceRootOf(graph, key);
    this.folds.open(root, seatRevealKeys(graph, root));
    this.folds.expandNodes(revealKeysFor(graph, key));
    this._selected.set(key);
    this._selections.next({ key, origin });
  }

  /** Forget the selection: the team it belongs to is closing. Emits nothing on
   *  `selections$`, since nobody asked to see a run. */
  reset(): void {
    this._selected.set(null);
  }
}
