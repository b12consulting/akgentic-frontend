import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, skip, Subject } from 'rxjs';
import { WebSocketSubject } from 'rxjs/webSocket';

import { asyncClosingSocket } from '../../../../../testing/async-closing-socket';
import { HUMAN, MANAGER, received, sent } from '../../../../../testing/run-log-builders';
import { ContextService } from '../../../platform/context/context.service';
import { ApiService } from '../../../platform/http/api.service';
import { NOTIFICATION_PORT } from '../../../platform/notification/notification.port';
import { AkgentService } from '../../akgent.service';
import { ConnectionToast } from '../event/connection-toast';
import { IngestionService } from '../event/ingestion.service';
import { LoadingIndicator } from '../event/loading-indicator';
import { LogFeeder } from '../event/log-feeder';
import { MessageLogService } from '../event/message-log.service';
import { NotificationToasts } from '../event/notification-toasts';
import { PerAgentStoreRegistry } from '../event/per-agent-store';
import { ProcessStores } from '../event/process-stores';
import { ReplaySeeder } from '../event/replay-seeder';
import { SELECTED_AGENT_ID } from '../event/selected-agent';
import { TeamSocket } from '../event/team-socket';
import { TeamStatusReactor } from '../event/team-status-reactor';
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

/**
 * Leaving the view closes the pipeline and cancels an in-flight open (#405),
 * over a STUBBED pipeline: the router never destroys the route's injector, so
 * nothing but `dispose()` releases a team when the user leaves for Home.
 */
describe('TeamSessionService — dispose() closes the pipeline (#405)', () => {
  let session: TeamSessionService;
  let ingestionClose: jasmine.Spy;
  let init: jasmine.Spy;
  let getCurrentTeam: jasmine.Spy;
  let currentProcessId$: BehaviorSubject<string>;

  beforeEach(() => {
    ingestionClose = jasmine.createSpy('close');
    init = jasmine.createSpy('init').and.resolveTo();
    getCurrentTeam = jasmine
      .createSpy('getCurrentTeam')
      .and.callFake((id: string) => Promise.resolve({ team_id: id, status: 'running' }));
    currentProcessId$ = new BehaviorSubject<string>('');
    TestBed.configureTestingModule({
      providers: [
        TeamSessionService,
        TraceFoldState,
        RunSelectionState,
        { provide: ContextService, useValue: { currentProcessId$, getCurrentTeam } },
        { provide: AkgentService, useValue: { unselect: () => undefined } },
        { provide: IngestionService, useValue: { init, close: ingestionClose } },
      ],
    });
    session = TestBed.inject(TeamSessionService);
  });

  it('closes the pipeline BEFORE retracting the pointer', async () => {
    await session.open('A');
    const calls: string[] = [];
    ingestionClose.and.callFake(() => calls.push('close'));
    currentProcessId$.pipe(skip(1)).subscribe((id) => calls.push(`id:${id}`));

    session.dispose();

    // `close()` guards on the open id, so it has to run while there still is
    // one. Retract first and it returns early: the team keeps running on Home.
    expect(calls).toEqual(['close', 'id:']);
    expect(ingestionClose).toHaveBeenCalledTimes(1);
  });

  it('dispose() during an in-flight open() cancels it: the pipeline never starts', async () => {
    let resolve!: (team: unknown) => void;
    getCurrentTeam.and.returnValue(new Promise((r) => (resolve = r)));
    const pending = session.open('A');

    session.dispose();
    resolve({ team_id: 'A', status: 'running' });

    expect(await pending).toBe('superseded');
    expect(init).not.toHaveBeenCalled();
  });
});

/**
 * The reported bug, end to end (#405): `TeamSessionService` over the REAL
 * ingestion stack. Only the edges are doubles — the transport, the HTTP client,
 * the toast sink and the root-scoped context.
 */
describe('TeamSessionService — a stale socket close raises no toast (#405)', () => {
  let session: TeamSessionService;
  let ingestion: IngestionService;
  let socket: TeamSocket;
  let createWebSocket: jasmine.Spy;
  let notify: jasmine.Spy;

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));
    notify = jasmine.createSpy('notify');

    TestBed.configureTestingModule({
      providers: [
        MessageLogService,
        PerAgentStoreRegistry,
        ProcessStores,
        ReplaySeeder,
        LoadingIndicator,
        ConnectionToast,
        NotificationToasts,
        TeamSocket,
        LogFeeder,
        TeamStatusReactor,
        IngestionService,
        TraceFoldState,
        RunSelectionState,
        TeamSessionService,
        {
          provide: SELECTED_AGENT_ID,
          useValue: new BehaviorSubject<string | null>(null),
        },
        {
          provide: ContextService,
          useValue: {
            currentProcessId$: new BehaviorSubject<string>(''),
            // As fast as a promise can resolve: no macrotask separates the
            // teardown from the next `init()`, so nothing here passes on timing.
            getCurrentTeam: (id: string) => Promise.resolve({ team_id: id, status: 'running' }),
            markStopped: jasmine.createSpy('markStopped'),
          },
        },
        { provide: AkgentService, useValue: { unselect: () => undefined } },
        {
          provide: ApiService,
          useValue: {
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
            getAgentStates: jasmine.createSpy('getAgentStates').and.resolveTo([]),
          },
        },
        {
          provide: NOTIFICATION_PORT,
          useValue: {
            notify,
            dismiss: jasmine.createSpy('dismiss'),
            clear: jasmine.createSpy('clear'),
          },
        },
      ],
    });
    session = TestBed.inject(TeamSessionService);
    ingestion = TestBed.inject(IngestionService);
    socket = TestBed.inject(TeamSocket);
    createWebSocket = spyOn<any>(socket, 'createWebSocket');
  });

  afterEach(() => {
    jasmine.clock().uninstall();
  });

  /** Every 'Connection Lost' payload raised so far, in order. */
  function disconnectToasts(): any[] {
    return notify.calls
      .allArgs()
      .map((a: any[]) => a[0])
      .filter((c: any) => c.severity === 'warn' && c.summary === 'Connection Lost');
  }

  function statusObservers(): number {
    return (socket as any)._status$.observers.length;
  }

  /** Open team A on a socket that will close asynchronously once stopped. */
  async function openA(): Promise<ReturnType<typeof asyncClosingSocket>> {
    const a = asyncClosingSocket();
    createWebSocket.and.returnValue(a.socket);
    expect(await session.open('A')).toBe('opened');
    return a;
  }

  /** Open team B on a plain subject the spec can end by hand. */
  async function openB(): Promise<Subject<any>> {
    const b = new Subject<any>();
    createWebSocket.and.returnValue(b as unknown as WebSocketSubject<any>);
    expect(await session.open('B')).toBe('opened');
    return b;
  }

  it("team → Home → team: A's stale close raises no toast; B's real loss raises exactly one", async () => {
    spyOn(console, 'error');
    const a = await openA();

    session.dispose();
    expect(a.unsubscribed()).toBe(1);
    expect(statusObservers()).toBe(0);

    const b = await openB();
    jasmine.clock().tick(600); // A's close lands here, with B's cycle subscribed
    expect(disconnectToasts().length).toBe(0);
    expect(ingestion.loadingProcess$.value).toBe(true);

    b.error(new Error('lost'));
    expect(disconnectToasts().length).toBe(1);
    expect(ingestion.loadingProcess$.value).toBe(false);
  });
});
