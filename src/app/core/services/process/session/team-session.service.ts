import { inject, Injectable } from '@angular/core';

import { ContextService } from '../../../platform/context/context.service';
import { isRunning } from '../../../platform/context/team.interface';
import { AkgentService } from '../../akgent.service';
import { IngestionService } from '../event/ingestion.service';
import { RunSelectionState } from '../ui-state/run-selection';
import { TraceFoldState } from '../ui-state/trace-fold-state';

/**
 * WHAT IT TAKES TO HAVE A TEAM OPEN. The whole ritual, owned by the data layer.
 *
 * This is the one thing a second frontend cannot discover by reading the layer
 * it reuses. `Route.providers` already made the twenty-three team services
 * reachable from anywhere under `process/:id` — but the ~130 lines that make
 * them *work* stayed in `ProcessComponent`, which is precisely the file a new
 * UI deletes. So a UI built against `core/components/` and `core/services/`
 * compiled, linted, rendered — and then failed quietly: `SelectionService`
 * reads `currentProcessId$`, whose only writer was that component, so saving
 * a human input died on "no team selected", the header showed no team, and
 * the previous team's agent stayed selected. Nothing threw.
 *
 * Everything here is mechanism. The POLICY stays with the view, and that
 * division is the point rather than an accident of where the lines fell:
 *
 *   - "the team is gone, so navigate home" is one console's answer. Another
 *     might show an empty state, or offer to create it. `open()` reports
 *     `'missing'` and says nothing about what to do next.
 *   - the default visualization tab is a view preference and this layer has no
 *     tabs.
 *   - which id to open — a route param, a host input, a list selection — is the
 *     caller's question. This takes the id it is given.
 *
 * SCOPED WITH THE REST OF THE TEAM'S SERVICES, on the route, never
 * `providedIn: 'root'`: it holds the open team's id and the epoch guarding it.
 */

/**
 * What `open()` did, as a value rather than as a side effect the caller has to
 * infer from three observables.
 *
 * `'superseded'` is not a failure. It means a newer `open()` started while this
 * one was awaiting the backend, and that newer call has already published its
 * own id and torn this one down — so the correct behaviour is to do nothing at
 * all. A caller that treats it as an error will navigate away from the team the
 * user actually asked for.
 */
export type TeamOpenOutcome = 'opened' | 'missing' | 'superseded' | 'cleared';

@Injectable()
export class TeamSessionService {
  private readonly contextService = inject(ContextService);
  private readonly akgentService = inject(AkgentService);
  private readonly ingestionService = inject(IngestionService);
  // Epic 55: the transcript's folds and run selection, reset on a switch.
  private readonly folds = inject(TraceFoldState);
  private readonly runSelection = inject(RunSelectionState);

  /** The id currently open, or `''`. Read by callers that need to know what
   *  `open()` settled on without re-reading the route. */
  get openTeamId(): string {
    return this.teamId;
  }

  private teamId = '';

  /**
   * `true` once `open()` has run, which is what tells "not opened yet" from
   * "opened, and the id has not changed". The plain `id === teamId` test cannot:
   * both are `''` before the first call.
   */
  private opened = false;

  /**
   * Monotonic ticket for in-flight opens.
   *
   * Two rapid switches race on one awaited fetch. Without this the loser
   * finishes last and initialises the pipeline for a team nobody is looking at,
   * over a log the winner already owns.
   */
  private epoch = 0;

  /**
   * Open `teamId`, releasing whatever was open before.
   *
   * THE TEARDOWN IS FIRST AND SYNCHRONOUS, before the awaited fetch below —
   * not folded into the next `ingestionService.init()`. Across that await the
   * previous team's socket would otherwise still be writing into the log the
   * new team is about to inherit.
   *
   * THE ID IS PUBLISHED BEFORE THE FETCH, not after it. Consumers read
   * `currentProcessId$` synchronously during their own construction — the
   * workspace explorer does — so a value published after the round trip
   * arrives too late for the first mount.
   */
  async open(teamId: string): Promise<TeamOpenOutcome> {
    if (this.opened && teamId === this.teamId) {
      return 'opened';
    }
    this.opened = true;
    const ticket = ++this.epoch;

    this.close();

    this.teamId = teamId;
    // THE SINGLE WRITER of the app-wide open-team pointer. Two writers make the
    // agent tabs and the workspace follow whichever wrote last.
    this.contextService.currentProcessId$.next(teamId);

    if (teamId === '') {
      return 'cleared';
    }

    const useCache = false;
    const team = await this.contextService.getCurrentTeam(teamId, useCache);

    if (ticket !== this.epoch) {
      return 'superseded';
    }

    if (team === null) {
      return 'missing';
    }

    await this.ingestionService.init(teamId, isRunning(team));
    return 'opened';
  }

  /**
   * Release everything belonging to the team currently open.
   *
   * Four things outlive a team switch and so have to be named. `close()` on the
   * pipeline disposes the cycle AND empties the log — which is what unmounts
   * the knowledge-graph and workspace panels, since their presence is a fold
   * over that log. `AkgentService` is another: it is root-scoped, so the
   * previous team's selected agent survives a switch that destroys nothing.
   * The last two are the transcript's open cards (`TraceFoldState`) and its
   * selected run (`RunSelectionState`): route-scoped, and the route's injector
   * is reused when only `:id` changes, so without a reset they would carry
   * into the next team — and back into this one on a return trip.
   *
   * Safe to call when nothing is open; that is the `''` guard.
   */
  close(): void {
    if (this.teamId === '') {
      return;
    }
    this.akgentService.unselect();
    this.ingestionService.close();
    this.folds.reset();
    this.runSelection.reset();
  }

  /**
   * Give up the session: close the pipeline, drop the selection and retract
   * the pointer.
   *
   * Leaving the view closes the pipeline too, and nothing else would. The
   * router caches the route's environment injector and never destroys it on
   * navigation, so `IngestionService.ngOnDestroy()` does not run when the user
   * leaves for Home: without the `close()` below the team's socket, log feed
   * and reactors keep running behind the Home page, and the next team to open
   * inherits a socket that is still closing (#405).
   *
   * What it adds to `close()` is the retraction: a team switch closes and
   * immediately republishes an id, while leaving retracts the id and resets
   * `opened`, so the same team can be opened again afterwards.
   *
   * `close()` is FIRST because it guards on `teamId`: after the id is cleared
   * it returns early and releases nothing.
   *
   * `unselect()` is unconditional here, where `close()` guards on an open team:
   * the selected agent is root-scoped and outlives this session whether or not
   * a team was ever opened.
   */
  dispose(): void {
    this.close();
    this.akgentService.unselect();
    this.teamId = '';
    this.opened = false;
    this.contextService.currentProcessId$.next('');
  }
}
