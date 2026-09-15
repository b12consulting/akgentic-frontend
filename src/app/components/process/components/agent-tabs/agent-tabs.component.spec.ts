import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, Subject } from 'rxjs';
import { MessageService } from 'primeng/api';
import { WebSocketSubject } from 'rxjs/webSocket';

import { AgentTabsComponent } from './agent-tabs.component';
import { Akgent, AkgentService } from '../../../../core/ui/akgent.service';
import { GraphDataService } from '../../../../features/process/selectors/graph.selector';
import { IngestionService } from '../../../../features/process/event/ingestion.service';
import { MessageLogService } from '../../../../features/process/event/message-log.service';
import { PerAgentStoreRegistry } from '../../../../features/process/event/per-agent-store';
import { ProcessStores } from '../../../../features/process/event/process-stores';
import { ReplaySeeder } from '../../../../features/process/event/replay-seeder';
import { ConnectionToast } from '../../../../features/process/event/connection-toast';
import { NotificationToasts } from '../../../../features/process/event/notification-toasts';
import { LogFeeder } from '../../../../features/process/event/log-feeder';
import { TeamSocket } from '../../../../features/process/event/team-socket';
import { LoadingIndicator } from '../../../../features/process/event/loading-indicator';
import { TeamStatusReactor } from '../../../../features/process/event/team-status-reactor';
import { ContextService } from '../../../../core/context/context.service';
import { ChatService } from '../../../../features/process/selectors/chat.selector';
import { ApiService } from '../../../../core/http/api.service';
import { SystemPromptSelector } from '../../../../features/process/selectors/system-prompt.selector';
import { TokenUsageSelector } from '../../../../features/process/selectors/token-usage.selector';

import { provideTranslateTesting } from '../../../../../testing/i18n-testing';

/**
 * Story 17-2 (ADR-014) — the agent-state panel and agent-chat context view are
 * now sourced from `ingestionService.state.forAgent(id)` /
 * `ingestionService.context.forAgent(id)` (PerAgentStore instances) instead of the
 * deleted `stateDict$` / `contextDict$`. These specs verify the host wiring:
 * the local `state$` / `context$` bridge subjects reflect the store values, with
 * `undefined` mapped to the existing defaults (`null` / `[]`) so the template
 * guards behave identically. Drives the real log fold (no store mocking).
 */
describe('AgentTabsComponent — store-backed state/context wiring (Story 17-2)', () => {
  let component: AgentTabsComponent;
  let log: MessageLogService;
  let ingestionService: IngestionService;
  let selectedAkgent$: BehaviorSubject<Akgent | null>;
  let nodes$: BehaviorSubject<any[]>;
  let categories$: BehaviorSubject<any[]>;
  let fakeSocket: Subject<any>;

  function addr(agentId: string) {
    return {
      __actor_address__: true,
      name: '@' + agentId,
      role: 'Worker',
      agent_id: agentId,
      team_id: 'team-1',
      squad_id: 's1',
      user_message: false,
    };
  }

  function mkStateChanged(agentId: string, state: any, id: string): any {
    return {
      id,
      parent_id: null,
      team_id: 'team-1',
      timestamp: '2026-06-13T00:00:00Z',
      sender: addr(agentId),
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.StateChangedMessage',
      state,
    };
  }

  function mkLlmEvent(agentId: string, message: any, id: string): any {
    return {
      id,
      parent_id: null,
      team_id: 'team-1',
      timestamp: '2026-06-13T00:00:00Z',
      sender: addr(agentId),
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.EventMessage',
      event: {
        __model__: 'akgentic.llm.event.LlmMessageEvent',
        message,
      },
    };
  }

  beforeEach(async () => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));

    selectedAkgent$ = new BehaviorSubject<Akgent | null>(null);
    nodes$ = new BehaviorSubject<any[]>([]);
    categories$ = new BehaviorSubject<any[]>([]);
    fakeSocket = new Subject<any>();

    TestBed.configureTestingModule({
      providers: [
        // The template renders `| translate`; without this the DOM spec at the
        // bottom of the file cannot render at all. Every other spec here drives
        // the component instance and is unaffected.
        provideTranslateTesting(),
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
        // Story 37-2: `IngestionService` injects `TeamStatusReactor`, which
        // injects the root-scoped `ContextService`. A real one would need a
        // `Router` this bed has no use for.
        //
        // `currentTeamRunning$` is here for the DOM specs at the bottom: once
        // the pane can actually render `<app-akgent-chat>`, that component's
        // composer reads it to decide whether it may send.
        {
          provide: ContextService,
          useValue: {
            markStopped: jasmine.createSpy('markStopped'),
            currentTeamRunning$: new BehaviorSubject<boolean>(true),
          },
        },
        // `<app-akgent-chat>`'s two component-scoped selectors. Real ones —
        // both are pure derivations over the log this bed already drives, so
        // faking them would put a stub between the spec and the thing it is
        // asserting rendered.
        SystemPromptSelector,
        TokenUsageSelector,
        ChatService,
        {
          provide: ApiService,
          useValue: {
            getEvents: jasmine.createSpy('getEvents').and.resolveTo([]),
            // akgentic-core ADR-020 §4: init() seeds the state store from
            // getAgentStates for EVERY team, running included — the stream
            // subscribers no longer carry StateChangedMessage, so this is the
            // only source. This spec drives the state store through the log
            // directly, so the seed resolves empty.
            getAgentStates: jasmine
              .createSpy('getAgentStates')
              .and.resolveTo([]),
          },
        },
        {
          provide: MessageService,
          useValue: { add: jasmine.createSpy('add'), clear: jasmine.createSpy('clear') },
        },
        {
          provide: AkgentService,
          useValue: { selectedAkgent$, select: jasmine.createSpy('select') },
        },
        {
          provide: GraphDataService,
          useValue: { nodes$, categories$ },
        },
      ],
    });

    ingestionService = TestBed.inject(IngestionService);
    log = TestBed.inject(MessageLogService);
    // Story 34-6: the `createWebSocket` seam lives on `TeamSocket` now. Same
    // stub, new receiver — this spec still drives the real WS pipeline end to
    // end so the registry's `log$` subscription is live.
    spyOn<any>(TestBed.inject(TeamSocket), 'createWebSocket').and.returnValue(
      fakeSocket as unknown as WebSocketSubject<any>,
    );
    // Wire the WS pipeline so the registry's log$ subscription is live.
    await ingestionService.init('proc-1', true);

    component = TestBed.createComponent(AgentTabsComponent).componentInstance;
    component.ngOnInit();
  });

  afterEach(() => {
    try {
      fakeSocket.complete();
    } catch {
      /* already closed */
    }
    jasmine.clock().uninstall();
  });

  it('AC2/AC3: selecting an agent feeds context$/state$ from the store', () => {
    log.appendAll([
      mkStateChanged('agent-A', { phase: 'busy' }, 's1'),
      mkLlmEvent('agent-A', { role: 'user', content: 'hi' }, 'e1'),
    ]);

    selectedAkgent$.next({ name: '@agent-A', agentId: 'agent-A' });

    expect(component.state$.value).toEqual({ schema: {}, state: { phase: 'busy' } });
    expect(component.context$.value).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('AC2/AC3: an agent with no store value maps undefined → null (state) / [] (context)', () => {
    selectedAkgent$.next({ name: '@unknown', agentId: 'unknown' });

    // Template guards (`state$ | async`, `(context$ | async)?.length`) depend
    // on these exact defaults — undefined must never reach the template.
    expect(component.state$.value).toBeNull();
    expect(component.context$.value).toEqual([]);
  });

  it('AC2/AC3: switching agents swaps the source (no cross-agent leak)', () => {
    log.appendAll([
      mkStateChanged('agent-A', { who: 'A' }, 's1'),
      mkStateChanged('agent-B', { who: 'B' }, 's2'),
    ]);

    selectedAkgent$.next({ name: '@agent-A', agentId: 'agent-A' });
    expect(component.state$.value).toEqual({ schema: {}, state: { who: 'A' } });

    selectedAkgent$.next({ name: '@agent-B', agentId: 'agent-B' });
    expect(component.state$.value).toEqual({ schema: {}, state: { who: 'B' } });
  });

  it('AC3: a later context message for the selected agent updates context$ live', () => {
    selectedAkgent$.next({ name: '@agent-A', agentId: 'agent-A' });
    expect(component.context$.value).toEqual([]);

    log.append(mkLlmEvent('agent-A', { role: 'user', content: 'm1' }, 'e1'));
    expect(component.context$.value).toEqual([{ role: 'user', content: 'm1' }]);

    log.append(mkLlmEvent('agent-A', { role: 'assistant', content: 'm2' }, 'e2'));
    expect(component.context$.value).toEqual([
      { role: 'user', content: 'm1' },
      { role: 'assistant', content: 'm2' },
    ]);
  });

  it('deselecting clears context$/state$ to defaults', () => {
    log.append(mkStateChanged('agent-A', { phase: 'busy' }, 's1'));
    selectedAkgent$.next({ name: '@agent-A', agentId: 'agent-A' });
    expect(component.state$.value).toEqual({ schema: {}, state: { phase: 'busy' } });

    selectedAkgent$.next(null);
    expect(component.state$.value).toBeNull();
    expect(component.context$.value).toEqual([]);
  });

  /** Synchronously read the current value of `chatTabVisible$`. */
  function tabVisible(): boolean {
    let visible: boolean | undefined;
    component.chatTabVisible$.subscribe((v) => (visible = v)).unsubscribe();
    return visible as boolean;
  }

  /** Synchronously read the current value of `backstory$`. */
  function backstory(): string {
    let value = '';
    component.backstory$.subscribe((v) => (value = v)).unsubscribe();
    return value;
  }

  // ===========================================================================
  // Story 20-1 (akgentic-agent ADR-007 §4) — never-run backstory head block + chat-tab
  // visibility from AgentState.backstory. Visibility gates on conversation
  // context OR a non-empty trimmed `state.backstory` (a running agent always has
  // context; a never-run agent shows its backstory). The head-block fallback
  // itself is verified at the consumer in akgent-chat.component.spec.ts.
  // ===========================================================================

  it('AC1/AC3 never-run: no system-prompt event but a non-empty state.backstory → backstory$ projects it and the chat tab is visible', () => {
    // A freshly created agent: only a StateChangedMessage carrying the backstory,
    // NO LlmSystemPromptEvent and NO LlmMessageEvent (never run).
    log.append(mkStateChanged('agent-A', { backstory: 'You are Bob.' }, 's1'));
    selectedAkgent$.next({ name: '@agent-A', agentId: 'agent-A' });

    // No context …
    expect(component.context$.value).toEqual([]);
    // … but the backstory is on the client via the `state` store.
    expect(backstory()).toBe('You are Bob.');
    // The chat tab is reachable from state.backstory alone (no white panel).
    expect(tabVisible()).toBeTrue();
  });

  it('AC1 trims: backstory$ projects the TRIMMED state.backstory', () => {
    log.append(
      mkStateChanged('agent-A', { backstory: '  You are Bob.\n' }, 's1'),
    );
    selectedAkgent$.next({ name: '@agent-A', agentId: 'agent-A' });

    expect(backstory()).toBe('You are Bob.');
    expect(tabVisible()).toBeTrue();
  });

  it('AC4 no false-positive: empty/whitespace state.backstory, no context → chat tab hidden', () => {
    log.append(mkStateChanged('agent-A', { backstory: '   \n\t ' }, 's1'));
    selectedAkgent$.next({ name: '@agent-A', agentId: 'agent-A' });

    expect(component.context$.value).toEqual([]);
    // Whitespace-only backstory trims to '' — it must NOT force the tab open.
    expect(backstory()).toBe('');
    expect(tabVisible()).toBeFalse();
  });

  it('AC4 no false-positive: a state with no backstory field at all → backstory$ is "" and the tab is hidden', () => {
    log.append(mkStateChanged('agent-A', { phase: 'busy' }, 's1'));
    selectedAkgent$.next({ name: '@agent-A', agentId: 'agent-A' });

    expect(backstory()).toBe('');
    expect(tabVisible()).toBeFalse();
  });

  it('chatTabVisible$ is false for an agent with neither context nor backstory', () => {
    selectedAkgent$.next({ name: '@unknown', agentId: 'unknown' });

    expect(backstory()).toBe('');
    expect(tabVisible()).toBeFalse();
  });

  it('AC3 context-only: an agent with conversation context (no backstory) is visible', () => {
    log.append(mkLlmEvent('agent-A', { role: 'user', content: 'hi' }, 'e1'));
    selectedAkgent$.next({ name: '@agent-A', agentId: 'agent-A' });

    expect(component.context$.value).toEqual([{ role: 'user', content: 'hi' }]);
    expect(tabVisible()).toBeTrue();
  });

  /**
   * Epic 56 moved this panel into the 310px inspector; the agent picker did not
   * come with it.
   *
   * `minWidth: 220px` was sized for a full-width tab strip. In a ~278px lane,
   * with a tab label beside it, that floor pushed the control off the strip's
   * right edge — and a `min-width` is the one constraint no amount of narrowing
   * recovers from, so the picker was unreachable rather than merely cramped.
   */
  it('lets the agent picker take the pane rather than demanding 220px', () => {
    nodes$.next([
      { name: 'agent-A', actorName: '@agent-A', category: 0, role: 'Worker' },
    ]);
    const fixture = TestBed.createComponent(AgentTabsComponent);
    fixture.detectChanges();

    const dropdown = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
      'p-dropdown',
    );
    expect(dropdown).withContext('the picker rendered').not.toBeNull();

    // Asserted on the RENDERED style, not on the absence of a `[style]` binding:
    // the floor could come back through either channel and the consequence is
    // the same.
    expect(dropdown!.style.minWidth ?? '').toBe('');
    expect(dropdown!.style.maxWidth ?? '').toBe('');
  });

  // ==========================================================================
  // W7 — the Member pane, brought onto the console's design language.
  //
  // Two of these are about a control that could not be operated, and one is
  // about a branch that could never be reached. Both were invisible in review
  // for the same reason: nothing in the suite rendered this template.
  // ==========================================================================

  /** Render a fresh fixture against the CURRENT `nodes$` value. */
  function renderPanel(): HTMLElement {
    const fixture = TestBed.createComponent(AgentTabsComponent);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const AGENT = {
    name: 'agent-A',
    actorName: '@agent-A',
    category: 0,
    role: 'Worker',
  };

  it('draws no tab strip — one tab is not a choice', () => {
    // The strip held a single tab whose caption repeated the agent already
    // named in the picker beside it. A control with one option cannot be
    // operated, and a second tab strip inside a tabbed pane puts two identical
    // controls at two different depths.
    nodes$.next([AGENT]);
    const host = renderPanel();

    expect(host.querySelector('p-tabs')).toBeNull();
    expect(host.querySelector('p-tablist')).toBeNull();
    expect(host.querySelector('p-tab')).toBeNull();
    // …and the picker, which the strip used to carry, survived the removal.
    expect(host.querySelector('p-dropdown')).not.toBeNull();
  });

  it('shows the empty state for a team with no agents, which it never could before', () => {
    // `agentsByCategory` is initialised to `[]` and reset to `[]` for an
    // agentless team — and `[]` is truthy, so the `*ngIf` that was supposed to
    // reach this branch never did. The pane rendered a disabled dropdown over
    // blank space and the copy written for this state was unreachable.
    nodes$.next([]);
    const host = renderPanel();

    expect(host.querySelector('app-inspector-empty-state')).not.toBeNull();
    expect(host.querySelector('p-dropdown')).toBeNull();
  });

  it('says so when the picked agent has nothing to show, rather than going blank', () => {
    // An agent that exists and has never run has neither context nor a
    // backstory. The pane used to render the picker over nothing at all, which
    // is indistinguishable from a panel that failed to load.
    nodes$.next([AGENT]);
    const host = renderPanel();

    expect(host.querySelector('app-akgent-chat')).toBeNull();
    expect(host.querySelector('app-inspector-empty-state')).not.toBeNull();
    // The picker stays: the state is "this one has nothing", not "there is
    // nothing to pick".
    expect(host.querySelector('p-dropdown')).not.toBeNull();
  });

  it('shows the trace, and drops the empty state, once the agent has context', () => {
    nodes$.next([AGENT]);
    log.append(mkLlmEvent('agent-A', { role: 'user', content: 'hi' }, 'e1'));
    selectedAkgent$.next({ name: '@agent-A', agentId: 'agent-A' });

    const host = renderPanel();

    expect(host.querySelector('app-akgent-chat')).not.toBeNull();
    expect(host.querySelector('app-inspector-empty-state')).toBeNull();
  });
});

/**
 * THE PICKER'S GROUP HEADERS.
 *
 * Two strings reached the user through this control without a translation key
 * and without anything watching: `"Agents"`, over a list of agents, inside a
 * control already placeheld "Select agent"; and `` `Team ${idx}` ``, composed
 * here from a loop index while the graph fold was composing the SAME label from
 * its own. Two derivations of one string is how the picker's header and the
 * graph's legend come to disagree.
 */
describe('AgentTabsComponent — the picker groups by squad, or not at all', () => {
  let component: AgentTabsComponent;
  let nodes$: BehaviorSubject<any[]>;
  let categories$: BehaviorSubject<any[]>;

  function member(id: string, category: number): any {
    return {
      name: id,
      actorName: '@' + id,
      agent_id: id,
      role: 'Worker',
      category,
    };
  }

  beforeEach(() => {
    nodes$ = new BehaviorSubject<any[]>([]);
    categories$ = new BehaviorSubject<any[]>([]);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AgentTabsComponent],
      providers: [
        provideTranslateTesting(),
        {
          provide: AkgentService,
          useValue: {
            selectedAkgent$: new BehaviorSubject<Akgent | null>(null),
            select: () => {},
            unselect: () => {},
          },
        },
        { provide: GraphDataService, useValue: { nodes$, categories$ } },
        {
          provide: IngestionService,
          useValue: {
            context: { forAgent: () => new BehaviorSubject<any>([]) },
            state: { forAgent: () => new BehaviorSubject<any>(null) },
          },
        },
      ],
    });

    const fixture = TestBed.createComponent(AgentTabsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('draws no group header for a single squad — one group separates nothing', () => {
    categories$.next([{ name: 'Team 0' }]);
    nodes$.next([member('a', 0), member('b', 0)]);

    expect(component.grouped).toBeFalse();
    expect(component.agentsByCategory.length).toBe(1);
    expect(component.agentsByCategory[0].label).toBe('');
    expect(component.agentsByCategory[0].items.map((i) => i.label)).toEqual([
      '@a',
      '@b',
    ]);
  });

  it("takes each header from the SQUAD's own name rather than re-deriving it from an index", () => {
    // The name the graph fold put on the squad. A picker that composed
    // `Team ${idx}` locally would answer 'Team 0' / 'Team 1' here and disagree
    // with the legend the moment a real squad name arrived.
    categories$.next([{ name: 'Research' }, { name: 'Delivery' }]);
    nodes$.next([member('a', 0), member('b', 1)]);

    expect(component.grouped).toBeTrue();
    expect(component.agentsByCategory.map((g) => g.label)).toEqual([
      'Research',
      'Delivery',
    ]);
    expect(component.agentsByCategory[1].items.map((i) => i.label)).toEqual([
      '@b',
    ]);
  });

  it('survives a squad the fold has not named yet, rather than printing "undefined"', () => {
    categories$.next([{ name: 'Research' }, {}]);
    nodes$.next([member('a', 0), member('b', 1)]);

    expect(component.agentsByCategory.map((g) => g.label)).toEqual([
      'Research',
      '',
    ]);
  });
});
