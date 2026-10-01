import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { HUMAN, MANAGER, received, sent } from '../../../../../testing/run-log-builders';
import { ContextService } from '../../../platform/context/context.service';
import { AkgentService } from '../../akgent.service';
import { IngestionService } from '../event/ingestion.service';
import { runGraphFold, runKey } from '../selectors/run-graph.selector';
import { RunSelectionState } from '../ui-state/run-selection';
import { TraceFoldState } from '../ui-state/trace-fold-state';
import { TeamSessionService } from './team-session.service';

/**
 * A team switch resets the transcript's open cards and selected run (Epic 55).
 *
 * The route's injector is reused when only `:id` changes, so `TraceFoldState`
 * and `RunSelectionState` outlive a team; without the reset in `close()`, a
 * round trip back to a team would find its old card open and its old run
 * selected.
 */
describe('TeamSessionService — a team switch resets the transcript state', () => {
  let session: TeamSessionService;
  let folds: TraceFoldState;
  let selection: RunSelectionState;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        TeamSessionService,
        TraceFoldState,
        RunSelectionState,
        {
          provide: ContextService,
          useValue: {
            currentProcessId$: new BehaviorSubject<string>(''),
            getCurrentTeam: (id: string) => Promise.resolve({ team_id: id, status: 'running' }),
          },
        },
        { provide: AkgentService, useValue: { unselect: () => undefined } },
        {
          provide: IngestionService,
          useValue: { init: () => Promise.resolve(), close: () => undefined },
        },
      ],
    });
    session = TestBed.inject(TeamSessionService);
    folds = TestBed.inject(TraceFoldState);
    selection = TestBed.inject(RunSelectionState);
  });

  it('A → B → A: no run is selected and no card is open', async () => {
    const graph = runGraphFold([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
    ]);
    const root = runKey('U1', MANAGER.agent_id);

    expect(await session.open('A')).toBe('opened');
    selection.select(graph, root, 'tree');
    expect(folds.isOpen(root)).toBeTrue();
    expect(selection.selected()).toBe(root);

    expect(await session.open('B')).toBe('opened');
    expect(await session.open('A')).toBe('opened');

    expect(selection.selected()).toBeNull();
    expect(folds.isOpen(root)).toBeFalse();
    expect(folds.openKeys().size).toBe(0);
  });
});
