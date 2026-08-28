import { CommonModule } from '@angular/common';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { BehaviorSubject, of } from 'rxjs';

import { StartMessage, StopMessage } from '../../protocol/message.types';
import { AkgentService } from '../../core/ui/akgent.service';
import { ChatService } from './selectors/chat.selector';
import { ContextService } from '../../core/context/context.service';
import { FeedbackService } from './ui-state/feedback.service';
import { GraphDataService } from './selectors/graph.selector';
import { KGStateReducer } from './selectors/knowledge-graph.selector';
import { MessageLogService } from './event/message-log.service';
import { IngestionService } from './event/ingestion.service';
import { SelectionService } from './ui-state/selection.service';
import {
  KG_ACTOR_NAME,
  ToolPresenceService,
} from './selectors/tool-presence.selector';
import { WorkspaceRegistryService } from './selectors/workspace-registry.selector';
import { TeamContext } from '../../core/context/team.interface';
import { ViewService } from '../../core/ui/view.service';
import { ProcessComponent } from './process.component';

// --------------------------------------------------------------------
// Fixture helpers
// --------------------------------------------------------------------

function makeTeam(overrides: Partial<TeamContext> = {}): TeamContext {
  return {
    team_id: 'team-1',
    name: 'Demo Team',
    status: 'running',
    created_at: '2026-04-08T10:00:00Z',
    updated_at: '2026-04-08T10:00:00Z',
    config_name: 'demo',
    description: null,
    ...overrides,
  };
}

function baseSender(name: string) {
  return {
    __actor_address__: true as const,
    agent_id: 'agent-' + name,
    name,
    role: 'Tool',
    squad_id: 's1',
    user_message: false,
  };
}

function makeKgStart(id: string): StartMessage {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: new Date().toISOString(),
    sender: baseSender(KG_ACTOR_NAME),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StartMessage',
    config: {} as any,
    parent: null,
  };
}

function makeKgStop(id: string): StopMessage {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: new Date().toISOString(),
    sender: baseSender(KG_ACTOR_NAME),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StopMessage',
  };
}

// A normal agent declaring a WorkspaceTool with no workspace_id (→ default).
function makeWorkspaceStart(id: string, agentName: string): StartMessage {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: new Date().toISOString(),
    sender: baseSender(agentName),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StartMessage',
    config: {
      tools: [
        {
          __model__: 'akgentic.tool.workspace.tool.WorkspaceTool',
          workspace_id: null,
        },
      ],
    } as any,
    parent: null,
  };
}

function makeWorkspaceStop(id: string, agentName: string): StopMessage {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: new Date().toISOString(),
    sender: baseSender(agentName),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StopMessage',
  };
}

describe('ProcessComponent (Story 6.2 — log-driven presence)', () => {
  let component: ProcessComponent;
  let fixture: ComponentFixture<ProcessComponent>;
  let log: MessageLogService;

  beforeEach(async () => {
    const contextService = {
      currentProcessId$: new BehaviorSubject<string>(''),
      getCurrentTeam: jasmine
        .createSpy('getCurrentTeam')
        .and.callFake(async () => makeTeam()),
      navigateHome: jasmine.createSpy('navigateHome').and.resolveTo(true),
    };

    // Story 6.4 (AC1): `messages$` / `message$` / `createAgentGraph$` were
    // deleted from `IngestionService`; the stub no longer references them.
    // Code review fix: `knowledgeGraphLoading$` deleted (dead state, never
    // `.next()`-ed and its `isLoading$` consumer was never read in the KG
    // component template — collapsed into the two-exceptions invariant purity).
    const ingestionService = {
      init: jasmine.createSpy('init').and.returnValue(Promise.resolve()),
      // Story 52-1: the component tears the previous team down explicitly
      // before it opens the next one, so the stub has to answer `close()`.
      close: jasmine.createSpy('close'),
    };

    const akgentService = {
      unselect: jasmine.createSpy('unselect'),
      selectedAkgent$: new BehaviorSubject<any>(null),
    };

    const graphDataService = {
      isLoading$: new BehaviorSubject<boolean>(false),
      nodes$: new BehaviorSubject<any[]>([]),
    };

    const chatService = {
      messages$: new BehaviorSubject<any[]>([]),
    };

    const selectionService = {
      handleSelection: jasmine.createSpy('handleSelection'),
    };

    const feedbackService = {};

    const viewService = {
      isRightColumnCollapsed$: new BehaviorSubject<boolean>(false),
    };

    const router = {
      navigate: jasmine
        .createSpy('navigate')
        .and.returnValue(Promise.resolve(true)),
    };

    // Story 52-1: `params` is an OBSERVABLE now, not a snapshot read — the
    // route mode subscribes so a `:id` change on a reused component is seen.
    const activatedRoute = {
      snapshot: { params: { id: 'team-1' } },
      params: of({ id: 'team-1' }),
    };

    await TestBed.configureTestingModule({
      imports: [ProcessComponent, NoopAnimationsModule],
      providers: [
        // Story 6.2 (AC5): drive presence through the REAL log + selector
        // pipeline so the unit test exercises the same path the production
        // code will on home→process navigation.
        MessageLogService,
        ToolPresenceService,
        KGStateReducer,
        WorkspaceRegistryService,
        { provide: ContextService, useValue: contextService },
        { provide: IngestionService, useValue: ingestionService },
        { provide: AkgentService, useValue: akgentService },
        { provide: GraphDataService, useValue: graphDataService },
        { provide: ChatService, useValue: chatService },
        { provide: SelectionService, useValue: selectionService },
        { provide: FeedbackService, useValue: feedbackService },
        { provide: ViewService, useValue: viewService },
        { provide: Router, useValue: router },
        { provide: ActivatedRoute, useValue: activatedRoute },
      ],
    })
      // Swap the heavy child components out for a minimal, empty-template
      // metadata set + CUSTOM_ELEMENTS_SCHEMA so the DOM still contains the
      // `<app-knowledge-graph>` / `<app-*>` tags (we assert on them) without
      // needing to bootstrap the children's full dependency graphs.
      .overrideComponent(ProcessComponent, {
        set: {
          imports: [CommonModule],
          // Strip the component-level providers so the module-level providers
          // above (real MessageLogService + ToolPresenceService + KGStateReducer)
          // are used instead of fresh instances per-component.
          providers: [],
          schemas: [CUSTOM_ELEMENTS_SCHEMA],
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(ProcessComponent);
    component = fixture.componentInstance;
    log = TestBed.inject(MessageLogService);

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('scenario 1 — empty log: KG option absent, <app-knowledge-graph> not in DOM', async () => {
    const options = await firstValue(component.visualizationOptions$);
    expect(options.some((o) => o.value === 'knowledge-graph')).toBe(false);

    const kgEl = fixture.nativeElement.querySelector('app-knowledge-graph');
    expect(kgEl).toBeNull();
  });

  it('scenario 2 — KG StartMessage appended to log: KG option appears and <app-knowledge-graph> mounts (AC5 race fix)', async () => {
    log.append(makeKgStart('kg-start-1'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const options = await firstValue(component.visualizationOptions$);
    expect(options.some((o) => o.value === 'knowledge-graph')).toBe(true);

    const kgEl = fixture.nativeElement.querySelector('app-knowledge-graph');
    expect(kgEl).not.toBeNull();
  });

  it('scenario 3 — KG StopMessage in log: KG option disappears and <app-knowledge-graph> unmounts', async () => {
    log.append(makeKgStart('kg-start-1'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    log.append(makeKgStop('kg-stop-1'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const options = await firstValue(component.visualizationOptions$);
    expect(options.some((o) => o.value === 'knowledge-graph')).toBe(false);

    const kgEl = fixture.nativeElement.querySelector('app-knowledge-graph');
    expect(kgEl).toBeNull();
  });

  it('scenario 4 — active-mode reset: KG active then presence→false flips visualization mode back to team', () => {
    log.append(makeKgStart('kg-start-1'));
    component.setVisualizationMode('knowledge-graph');
    expect(component.currentVisualizationMode).toBe('knowledge-graph');

    log.append(makeKgStop('kg-stop-1'));
    expect(component.currentVisualizationMode).toBe('team');
  });

  it('scenario 5 — no regression: Team / Member / Messages entries remain present under both KG presence states (order preserved)', async () => {
    // Workspace presence is reactive (ADR-020): declare a WorkspaceTool so the
    // Workspaces tab is present, then verify the order holds without KG —
    // `[team, member, workspace, messages]` — and with KG —
    // `[team, member, knowledge-graph, workspace, messages]`.
    log.append(makeWorkspaceStart('ws-start-1', 'Worker'));
    let options = await firstValue(component.visualizationOptions$);
    let labels = options.map((o) => o.value);
    expect(labels).toEqual(['team', 'member', 'workspace', 'messages']);

    log.append(makeKgStart('kg-start-1'));
    options = await firstValue(component.visualizationOptions$);
    labels = options.map((o) => o.value);
    expect(labels).toEqual([
      'team',
      'member',
      'knowledge-graph',
      'workspace',
      'messages',
    ]);
  });

  it('scenario 6 — Workspaces appears between KG and Messages once a WorkspaceTool exists', async () => {
    // With a WorkspaceTool but no KG, the order is [team, member, workspace,
    // messages].
    log.append(makeWorkspaceStart('ws-start-1', 'Worker'));
    let options = await firstValue(component.visualizationOptions$);
    expect(options.map((o) => o.value)).toEqual([
      'team',
      'member',
      'workspace',
      'messages',
    ]);

    // With KG present, Workspace sits between KG and Messages (order).
    log.append(makeKgStart('kg-start-1'));
    options = await firstValue(component.visualizationOptions$);
    expect(options.map((o) => o.value)).toEqual([
      'team',
      'member',
      'knowledge-graph',
      'workspace',
      'messages',
    ]);
  });

  it('scenario 7 — empty log: Workspaces option absent, <app-workspace-tabs> not in DOM', async () => {
    const options = await firstValue(component.visualizationOptions$);
    expect(options.some((o) => o.value === 'workspace')).toBe(false);
    expect(
      fixture.nativeElement.querySelector('app-workspace-tabs'),
    ).toBeNull();
  });

  it('scenario 8 — WorkspaceTool appears; sticky: Stop keeps the Workspaces tab', async () => {
    log.append(makeWorkspaceStart('ws-start-1', 'Worker'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    let options = await firstValue(component.visualizationOptions$);
    expect(options.some((o) => o.value === 'workspace')).toBe(true);
    expect(
      fixture.nativeElement.querySelector('app-workspace-tabs'),
    ).not.toBeNull();

    // Firing the member (Stop) is sticky — the workspace persists, tab stays.
    log.append(makeWorkspaceStop('ws-stop-1', 'Worker'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    options = await firstValue(component.visualizationOptions$);
    expect(options.some((o) => o.value === 'workspace')).toBe(true);
  });
});

// Small synchronous-first-emission helper for BehaviorSubject-derived
// observables (combineLatest over BehaviorSubjects replays synchronously).
function firstValue<T>(observable$: {
  subscribe: (fn: (v: T) => void) => { unsubscribe(): void };
}): Promise<T> {
  return new Promise((resolve) => {
    const sub = observable$.subscribe((v) => {
      resolve(v);
      setTimeout(() => sub.unsubscribe(), 0);
    });
  });
}

// =====================================================================
// Story 10-2 — single-fetch navigation and ingestionService.init argument
// =====================================================================

describe('ProcessComponent (Story 10-2 — single-fetch navigation)', () => {
  async function setup(options: {
    fetchedTeam: TeamContext | null;
  }): Promise<{
    component: ProcessComponent;
    fixture: ComponentFixture<ProcessComponent>;
    contextSpy: { getCurrentTeam: jasmine.Spy; navigateHome: jasmine.Spy };
    messageSpy: { init: jasmine.Spy; close: jasmine.Spy };
    routerSpy: { navigate: jasmine.Spy };
  }> {
    const contextService = {
      currentProcessId$: new BehaviorSubject<string>(''),
      getCurrentTeam: jasmine
        .createSpy('getCurrentTeam')
        .and.returnValue(Promise.resolve(options.fetchedTeam)),
      navigateHome: jasmine.createSpy('navigateHome').and.resolveTo(true),
    };

    const ingestionService = {
      init: jasmine.createSpy('init').and.returnValue(Promise.resolve()),
      // Story 52-1: the component tears the previous team down explicitly
      // before it opens the next one, so the stub has to answer `close()`.
      close: jasmine.createSpy('close'),
    };

    const akgentService = {
      unselect: jasmine.createSpy('unselect'),
      selectedAkgent$: new BehaviorSubject<any>(null),
    };

    const graphDataService = {
      isLoading$: new BehaviorSubject<boolean>(false),
      nodes$: new BehaviorSubject<any[]>([]),
    };

    const chatService = {
      messages$: new BehaviorSubject<any[]>([]),
    };

    const selectionService = { handleSelection: jasmine.createSpy('handleSelection') };
    const feedbackService = {};
    const viewService = {
      isRightColumnCollapsed$: new BehaviorSubject<boolean>(false),
    };
    const router = {
      navigate: jasmine.createSpy('navigate').and.returnValue(Promise.resolve(true)),
    };
    const activatedRoute = {
      snapshot: { params: { id: 'team-1' } },
      params: of({ id: 'team-1' }),
    };

    await TestBed.configureTestingModule({
      imports: [ProcessComponent, NoopAnimationsModule],
      providers: [
        MessageLogService,
        ToolPresenceService,
        KGStateReducer,
        WorkspaceRegistryService,
        { provide: ContextService, useValue: contextService },
        { provide: IngestionService, useValue: ingestionService },
        { provide: AkgentService, useValue: akgentService },
        { provide: GraphDataService, useValue: graphDataService },
        { provide: ChatService, useValue: chatService },
        { provide: SelectionService, useValue: selectionService },
        { provide: FeedbackService, useValue: feedbackService },
        { provide: ViewService, useValue: viewService },
        { provide: Router, useValue: router },
        { provide: ActivatedRoute, useValue: activatedRoute },
      ],
    })
      .overrideComponent(ProcessComponent, {
        set: {
          imports: [CommonModule],
          providers: [],
          schemas: [CUSTOM_ELEMENTS_SCHEMA],
        },
      })
      .compileComponents();

    const fixture = TestBed.createComponent(ProcessComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    return {
      component,
      fixture,
      contextSpy: contextService,
      messageSpy: ingestionService,
      routerSpy: router,
    };
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('(AC6, AC11) ngOnInit calls getCurrentTeam exactly once with (processId, false)', async () => {
    const { contextSpy } = await setup({ fetchedTeam: makeTeam({ status: 'running' }) });
    expect(contextSpy.getCurrentTeam).toHaveBeenCalledTimes(1);
    expect(contextSpy.getCurrentTeam).toHaveBeenCalledWith('team-1', false);
  });

  it('(AC6) ingestionService.init is called with (processId, true) for a running team', async () => {
    const { messageSpy } = await setup({ fetchedTeam: makeTeam({ status: 'running' }) });
    expect(messageSpy.init).toHaveBeenCalledTimes(1);
    expect(messageSpy.init).toHaveBeenCalledWith('team-1', true);
  });

  it('(AC6) ingestionService.init is called with (processId, false) for a stopped team', async () => {
    const { messageSpy } = await setup({ fetchedTeam: makeTeam({ status: 'stopped' }) });
    expect(messageSpy.init).toHaveBeenCalledTimes(1);
    expect(messageSpy.init).toHaveBeenCalledWith('team-1', false);
  });

  it('(AC6) null team short-circuits: router.navigate([/]) is called and ingestionService.init is NOT', async () => {
    const { messageSpy, contextSpy } = await setup({ fetchedTeam: null });
    // The bail-out now DELEGATES: the component no longer builds the home
    // route itself, so the router is no longer its collaborator here. Asserting
    // on `navigateHome` is what keeps this spec about the short-circuit rather
    // than about a URL shape that belongs to the teams list (Story 48.2).
    expect(contextSpy.navigateHome).toHaveBeenCalled();
    expect(messageSpy.init).not.toHaveBeenCalled();
  });

});

// =====================================================================
// Story 52-1 — the id comes from OUTSIDE, and it can change
// =====================================================================

describe('ProcessComponent (Story 52-1 — team id as an input)', () => {
  interface Harness {
    component: ProcessComponent;
    fixture: ComponentFixture<ProcessComponent>;
    context: {
      currentProcessId$: BehaviorSubject<string>;
      getCurrentTeam: jasmine.Spy;
      navigateHome: jasmine.Spy;
    };
    ingestion: { init: jasmine.Spy; close: jasmine.Spy };
    akgent: { unselect: jasmine.Spy };
    routeParams$: BehaviorSubject<{ id?: string }>;
  }

  /**
   * Builds the component WITHOUT rendering it, so a spec can set `teamId`
   * before the first change detection — which is what a host binding does, and
   * the only way to exercise the "input wins over the route" branch.
   */
  async function build(options: {
    routeId?: string;
    team?: (id: string) => TeamContext | null;
  }): Promise<Harness> {
    const resolve = options.team ?? (() => makeTeam());
    const context = {
      currentProcessId$: new BehaviorSubject<string>(''),
      getCurrentTeam: jasmine
        .createSpy('getCurrentTeam')
        .and.callFake(async (id: string) => resolve(id)),
      navigateHome: jasmine.createSpy('navigateHome').and.resolveTo(true),
    };
    const ingestion = {
      init: jasmine.createSpy('init').and.returnValue(Promise.resolve()),
      close: jasmine.createSpy('close'),
    };
    const akgent = {
      unselect: jasmine.createSpy('unselect'),
      selectedAkgent$: new BehaviorSubject<any>(null),
    };
    const routeParams$ = new BehaviorSubject<{ id?: string }>(
      options.routeId === undefined ? {} : { id: options.routeId },
    );

    await TestBed.configureTestingModule({
      imports: [ProcessComponent, NoopAnimationsModule],
      providers: [
        MessageLogService,
        ToolPresenceService,
        KGStateReducer,
        WorkspaceRegistryService,
        { provide: ContextService, useValue: context },
        { provide: IngestionService, useValue: ingestion },
        { provide: AkgentService, useValue: akgent },
        {
          provide: GraphDataService,
          useValue: {
            isLoading$: new BehaviorSubject<boolean>(false),
            nodes$: new BehaviorSubject<any[]>([]),
          },
        },
        { provide: ChatService, useValue: { messages$: new BehaviorSubject<any[]>([]) } },
        { provide: SelectionService, useValue: { handleSelection: () => undefined } },
        { provide: FeedbackService, useValue: {} },
        {
          provide: ViewService,
          useValue: { isRightColumnCollapsed$: new BehaviorSubject<boolean>(false) },
        },
        {
          provide: Router,
          useValue: { navigate: jasmine.createSpy('navigate').and.resolveTo(true) },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { params: options.routeId === undefined ? {} : { id: options.routeId } },
            params: routeParams$,
          },
        },
      ],
    })
      .overrideComponent(ProcessComponent, {
        set: { imports: [CommonModule], providers: [], schemas: [CUSTOM_ELEMENTS_SCHEMA] },
      })
      .compileComponents();

    const fixture = TestBed.createComponent(ProcessComponent);
    return {
      component: fixture.componentInstance,
      fixture,
      context,
      ingestion,
      akgent,
      routeParams$,
    };
  }

  /** One render + settle cycle, the shape every spec in this file uses. */
  async function settle(fixture: ComponentFixture<ProcessComponent>): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('(FR1) opens the team the INPUT names, and never asks the route', async () => {
    const h = await build({ routeId: 'from-route' });
    h.fixture.componentRef.setInput('teamId', 'from-input');
    await settle(h.fixture);

    expect(h.context.getCurrentTeam).toHaveBeenCalledOnceWith('from-input', false);
    expect(h.ingestion.init).toHaveBeenCalledOnceWith('from-input', true);
    expect(h.component.processId).toBe('from-input');
  });

  it('(FR1, NFR1) with no input bound it falls back to the route parameter', async () => {
    const h = await build({ routeId: 'from-route' });
    await settle(h.fixture);

    expect(h.context.getCurrentTeam).toHaveBeenCalledOnceWith('from-route', false);
    expect(h.ingestion.init).toHaveBeenCalledOnceWith('from-route', true);
  });

  it('(FR2, T1) a CHANGED input opens the new team — the id is not read once', async () => {
    const h = await build({ routeId: 'from-route' });
    h.fixture.componentRef.setInput('teamId', 'team-a');
    await settle(h.fixture);
    expect(h.ingestion.init).toHaveBeenCalledOnceWith('team-a', true);

    h.fixture.componentRef.setInput('teamId', 'team-b');
    await settle(h.fixture);

    expect(h.component.processId).toBe('team-b');
    expect(h.ingestion.init).toHaveBeenCalledTimes(2);
    expect(h.ingestion.init.calls.mostRecent().args).toEqual(['team-b', true]);
  });

  it('(FR2, T2) the previous team is torn down BEFORE the new one is fetched', async () => {
    const order: string[] = [];
    const h = await build({ routeId: undefined });
    h.ingestion.close.and.callFake(() => order.push('close'));
    h.context.getCurrentTeam.and.callFake(async (id: string) => {
      order.push('fetch:' + id);
      return makeTeam({ team_id: id });
    });
    h.ingestion.init.and.callFake(async (id: string) => {
      order.push('init:' + id);
    });

    h.fixture.componentRef.setInput('teamId', 'team-a');
    await settle(h.fixture);
    h.fixture.componentRef.setInput('teamId', 'team-b');
    await settle(h.fixture);

    // `close` sits between team A's init and team B's fetch: the old socket is
    // gone before the network call that precedes the new one, not after it.
    expect(order).toEqual(['fetch:team-a', 'init:team-a', 'close', 'fetch:team-b', 'init:team-b']);
  });

  it('(FR2) the root-scoped agent selection does not survive a team switch', async () => {
    const h = await build({ routeId: undefined });
    h.fixture.componentRef.setInput('teamId', 'team-a');
    await settle(h.fixture);
    h.akgent.unselect.calls.reset();

    h.fixture.componentRef.setInput('teamId', 'team-b');
    await settle(h.fixture);

    expect(h.akgent.unselect).toHaveBeenCalled();
  });

  it('(FR2) re-announcing the SAME id opens nothing a second time', async () => {
    // Driven through the route, because that is the channel that really does
    // re-emit an unchanged value (a `queryParams` write on the hosting page
    // re-emits `params` too). A teardown here would drop a live socket and
    // replay the whole conversation for no reason at all.
    const h = await build({ routeId: 'team-a' });
    await settle(h.fixture);
    h.routeParams$.next({ id: 'team-a' });
    await settle(h.fixture);

    expect(h.ingestion.init).toHaveBeenCalledTimes(1);
    expect(h.ingestion.close).not.toHaveBeenCalled();
  });

  it('(FR2) a slow fetch that resolves after a newer selection initialises nothing', async () => {
    let releaseA: (team: TeamContext) => void = () => undefined;
    const h = await build({ routeId: undefined });
    h.context.getCurrentTeam.and.callFake((id: string) => {
      if (id === 'team-a') {
        return new Promise<TeamContext>((r) => {
          releaseA = r;
        });
      }
      return Promise.resolve(makeTeam({ team_id: id }));
    });

    h.fixture.componentRef.setInput('teamId', 'team-a');
    await settle(h.fixture);
    // A is still in flight; B is chosen and completes.
    h.fixture.componentRef.setInput('teamId', 'team-b');
    await settle(h.fixture);
    releaseA(makeTeam({ team_id: 'team-a' }));
    await settle(h.fixture);

    expect(h.ingestion.init).toHaveBeenCalledOnceWith('team-b', true);
    expect(h.component.processId).toBe('team-b');
  });

  it('(T1) in route mode a `:id` change on the SAME instance opens the new team', async () => {
    const h = await build({ routeId: 'team-a' });
    await settle(h.fixture);
    expect(h.ingestion.init).toHaveBeenCalledOnceWith('team-a', true);

    h.routeParams$.next({ id: 'team-b' });
    await settle(h.fixture);

    expect(h.ingestion.init).toHaveBeenCalledTimes(2);
    expect(h.component.processId).toBe('team-b');
  });

  it('(T3) it is the only writer: currentProcessId$ follows the input, and empties on destroy', async () => {
    const h = await build({ routeId: undefined });
    h.fixture.componentRef.setInput('teamId', 'team-a');
    await settle(h.fixture);
    expect(h.context.currentProcessId$.value).toBe('team-a');

    h.fixture.componentRef.setInput('teamId', 'team-b');
    await settle(h.fixture);
    expect(h.context.currentProcessId$.value).toBe('team-b');

    h.fixture.destroy();
    expect(h.context.currentProcessId$.value).toBe('');
  });

  it('(FR3) a dangling selection is REPORTED to the host, not navigated away from', async () => {
    const h = await build({ routeId: undefined, team: () => null });
    const reported: string[] = [];
    h.component.teamUnavailable.subscribe((id) => reported.push(id));

    h.fixture.componentRef.setInput('teamId', 'gone');
    await settle(h.fixture);

    expect(reported).toEqual(['gone']);
    expect(h.ingestion.init).not.toHaveBeenCalled();
    // Hosted, the host owns the selection — this view must not move the page.
    expect(h.context.navigateHome).not.toHaveBeenCalled();
  });

  it('(NFR1) standalone, a dangling team still navigates home', async () => {
    const h = await build({ routeId: 'gone', team: () => null });
    await settle(h.fixture);

    expect(h.context.navigateHome).toHaveBeenCalled();
  });
});
