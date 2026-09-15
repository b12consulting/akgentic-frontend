import { CommonModule } from '@angular/common';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { By } from '@angular/platform-browser';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { TranslatePipe, TranslationObject } from '@ngx-translate/core';
import { BehaviorSubject, of } from 'rxjs';

import { StartMessage, StopMessage } from '../../protocol/message.types';
import { AkgentService } from '../../core/ui/akgent.service';
import { ChatService } from '../../services/process/selectors/chat.selector';
import { ContextService } from '../../core/context/context.service';
import { FeedbackService } from '../../services/process/ui-state/feedback.service';
import { GraphDataService } from '../../services/process/selectors/graph.selector';
import { KGStateReducer } from '../../services/process/selectors/knowledge-graph.selector';
import { MessageLogService } from '../../services/process/event/message-log.service';
import { TeamSessionService } from '../../services/process/session/team-session.service';
import { IngestionService } from '../../services/process/event/ingestion.service';
import { SelectionService } from '../../services/process/ui-state/selection.service';
import {
  KG_ACTOR_NAME,
  ToolPresenceService,
} from '../../services/process/selectors/tool-presence.selector';
import { WorkspaceRegistryService } from '../../services/process/selectors/workspace-registry.selector';
import { TeamContext } from '../../core/context/team.interface';
import { NodeInterface } from '../../services/process/models/types';
import { ViewService } from '../../core/ui/view.service';
import { PaneLayoutService } from '../../core/ui/pane-layout.service';
import {
  INSPECTOR_DEFAULT_PERCENT,
  INSPECTOR_MAX_PERCENT,
  INSPECTOR_MIN_PERCENT,
  PANE_LAYOUT_STORAGE_KEY,
} from '../../core/ui/pane-layout';
import { SplitDividerComponent } from '../../components/common/split-divider/split-divider.component';
import { ConsoleInspectorComponent } from '../../components/console/inspector/console-inspector.component';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../testing/i18n-testing';
import { ConfigService } from '../../core/config/config.service';
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
        provideTranslateTesting(),
        // Story 6.2 (AC5): drive presence through the REAL log + selector
        // pipeline so the unit test exercises the same path the production
        // code will on home→process navigation.
        MessageLogService,
        ToolPresenceService,
        KGStateReducer,
        WorkspaceRegistryService,
        { provide: ContextService, useValue: contextService },
        { provide: IngestionService, useValue: ingestionService },
        // The REAL session service over the doubled dependencies above: it is
        // the unit under test's collaborator, not a seam these specs mock —
        // they assert on `ingestionService.init` and `currentProcessId$`, which
        // are exactly what it drives.
        TeamSessionService,
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
          // The divider is REAL here, not stubbed: R3's host wiring is a set of
          // bindings, and the only way to assert that a drag reaches the layout
          // service is to let the real component emit through them.
          // `TranslatePipe` comes along because the divider's label is
          // translated — the heavy children stay stubbed by the schema.
          imports: [CommonModule, TranslatePipe, SplitDividerComponent],
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

  /**
   * The height chain, measured rather than inspected.
   *
   * Every element between the host and the two panes carries `flex: 1` and
   * `min-height: 0`. The chain fails SILENTLY — nothing errors, and the only
   * symptom is that both scroll regions run off the bottom of the window and
   * stop showing scrollbars. It has broken here once already, and the broken
   * link was an element with NO RULE AT ALL: the old template's outer
   * `<section>`, which took the flex default and sized itself to its content,
   * leaving every `flex: 1` beneath it dividing a box that had already
   * collapsed. Reading the stylesheet did not catch it, because the missing
   * link was the thing that was not written down.
   *
   * So this asserts the OUTCOME — a height put on the host arrives at the panes
   * — which is true of any correct chain and false of any future edit that
   * breaks it, wherever in it that happens.
   */
  it('(Epic 52 / 56) a height on the host reaches both panes', () => {
    const host = fixture.nativeElement as HTMLElement;
    // Pinned rather than inherited: `--process-height` is `100%` of a lane the
    // console shell supplies, and there is no shell in this fixture.
    host.style.setProperty('--process-height', '600px');
    fixture.detectChanges();

    const heightOf = (selector: string): number => {
      const element = host.querySelector(selector);
      expect(element).withContext(selector).toBeTruthy();
      return (element as HTMLElement).getBoundingClientRect().height;
    };

    expect(host.getBoundingClientRect().height).toBeCloseTo(600, 0);
    expect(heightOf('.console-panes')).toBeCloseTo(600, 0);
    expect(heightOf('.conversation-pane')).toBeCloseTo(600, 0);
    // The last link before the transcript's own scroll box.
    expect(heightOf('.chat-app')).toBeGreaterThan(0);
  });

  /**
   * The layout seam this view now owns: the conversation's title bar sits
   * INSIDE it, not in the app shell.
   *
   * That is not a styling preference. The header reads the open team, and the
   * inspector beside it reads four services that are component-scoped on this
   * component's `providers` — mounted in the shell, the inspector resolves none
   * of them and throws. Asserting the containment keeps the reason visible to
   * anyone tempted to lift either one out to the shell where the design draws
   * them.
   */
  it('(Epic 56) the header and the inspector are mounted inside this view', () => {
    const host = fixture.nativeElement as HTMLElement;

    expect(
      host.querySelector('.conversation-pane > app-conversation-header'),
    ).not.toBeNull();
    expect(host.querySelector('.console-panes > app-console-inspector')).not.toBeNull();
  });

  /**
   * The panels are PROJECTED into the inspector rather than declared inside it,
   * for the same injector reason — so they must still be children of this
   * component's template, and they must land in the inspector's content slot.
   */
  it('(Epic 56) projects the panels into the inspector, all mounted at once', () => {
    const host = fixture.nativeElement as HTMLElement;
    const panels = host.querySelector('app-console-inspector .inspector-panels');
    expect(panels).not.toBeNull();

    // Team, hierarchy, member and messages are unconditional; the other two are
    // gated on their tool being present, and the log is empty here.
    expect(panels!.querySelector('app-inspector-team-panel')).not.toBeNull();
    expect(panels!.querySelector('app-team-tabs')).not.toBeNull();
    expect(panels!.querySelector('app-agent-tabs')).not.toBeNull();
    expect(panels!.querySelector('app-message-list')).not.toBeNull();
  });

  /**
   * H2, pinned: which panel is in which tab.
   *
   * The redesign gave `team` a new roster/tools/spend panel, and that panel
   * deliberately carries neither the team tree nor the echarts graph. Both of
   * those were in the `team` tab before, so a straight swap would have made
   * them unreachable — nothing errors when a component simply stops being
   * mounted, and the graph view would have vanished silently. They kept a tab.
   *
   * Asserting the PAIRING rather than mere presence: both elements existing
   * somewhere in the inspector is also true of an arrangement that stacks them
   * in one panel, which is the thing this decision rejected.
   */
  it('(Epic 56 / H2) puts the roster panel in Team and the tree + graph in Hierarchy', () => {
    const host = fixture.nativeElement as HTMLElement;

    const team = host.querySelector('#inspector-panel-team')!;
    expect(team.querySelector('app-inspector-team-panel')).not.toBeNull();
    expect(team.querySelector('app-team-tabs')).toBeNull();

    const hierarchy = host.querySelector('#inspector-panel-hierarchy')!;
    expect(hierarchy.querySelector('app-team-tabs')).not.toBeNull();
  });

  /**
   * `.moved-offscreen`, not `*ngIf`.
   *
   * Unmounting the inactive panels would remount `app-graph` (echarts) and
   * `app-knowledge-graph` on every tab change; their init/dispose paths have
   * never been exercised that way, and keeping all five mounted is why the
   * switch is instant and why the graph does not re-run its layout. `inert` is
   * the accessibility half: off-screen is not hidden, so without it four
   * invisible panels stay tabbable.
   */
  it('(Epic 56) hides the inactive panels off-screen and inert, without unmounting them', () => {
    const host = fixture.nativeElement as HTMLElement;
    const team = host.querySelector('#inspector-panel-team')!;
    const member = host.querySelector('#inspector-panel-member')!;

    expect(team.classList.contains('moved-offscreen')).toBe(false);
    expect(team.hasAttribute('inert')).toBe(false);
    expect(member.classList.contains('moved-offscreen')).toBe(true);
    expect(member.hasAttribute('inert')).toBe(true);

    component.setVisualizationMode('member');
    fixture.detectChanges();

    // Still mounted — only the side of the screen it is on changed.
    expect(host.querySelector('#inspector-panel-team')).not.toBeNull();
    expect(team.classList.contains('moved-offscreen')).toBe(true);
    expect(team.hasAttribute('inert')).toBe(true);
    expect(member.classList.contains('moved-offscreen')).toBe(false);
    expect(member.hasAttribute('inert')).toBe(false);
  });

  /**
   * The other half of the tab strip's `aria-controls`. Nothing errors when
   * `aria-controls` names an element that does not exist, so the ids the tabs
   * point at are only real if this side spells them the same way.
   */
  it('(Epic 56) gives every panel the tabpanel id its tab points at', () => {
    const host = fixture.nativeElement as HTMLElement;

    for (const value of ['team', 'hierarchy', 'member', 'messages']) {
      const panel = host.querySelector('#inspector-panel-' + value);
      expect(panel).withContext(value).not.toBeNull();
      expect(panel!.getAttribute('role')).toBe('tabpanel');
      expect(panel!.getAttribute('aria-labelledby')).toBe('inspector-tab-' + value);
    }
  });

  /**
   * The loop the prototype leaves open: the Team panel's member cards are the
   * obvious way into the Member tab, and the mock draws them inert.
   *
   * Both halves are asserted, because either alone is a bug that looks like a
   * feature. Selecting without switching tabs updates a pane the user is not
   * looking at, so the card reads as dead; switching without selecting shows
   * the PREVIOUS member's chat under the impression it is the one just clicked.
   */
  it('(Epic 56) a member selection selects the node and switches to the Member tab', () => {
    // Only the two fields the selection path reads. Typed rather than `any[]`
    // so a rename of either field fails HERE instead of silently feeding the
    // component a shape the real graph never emits.
    type GraphNodeStub = Pick<NodeInterface, 'name' | 'actorName'>;
    const graph = TestBed.inject(GraphDataService) as unknown as {
      nodes$: BehaviorSubject<GraphNodeStub[]>;
    };
    const node: GraphNodeStub = { name: 'agent-7', actorName: 'Worker-role' };
    graph.nodes$.next([{ name: 'agent-1', actorName: 'Other' }, node]);

    const selection = TestBed.inject(
      SelectionService,
    ) as unknown as { handleSelection: jasmine.Spy };

    component.onMemberSelected('agent-7');

    // The same `Selectable` the team tree builds. Two surfaces that select a
    // member must select it identically, or the Member tab and the tree
    // disagree about who is showing.
    expect(selection.handleSelection).toHaveBeenCalledOnceWith({
      type: 'tree-node',
      data: node,
    });
    expect(component.currentVisualizationMode).toBe('member');
  });

  it('(Epic 56) drops a member selection whose agent is no longer on the team', () => {
    // A card can be clicked after the agent it names was stopped and spliced
    // out of `nodes$`. Switching tabs anyway would present someone else's chat
    // as the clicked member's, so the click is dropped entirely.
    const selection = TestBed.inject(
      SelectionService,
    ) as unknown as { handleSelection: jasmine.Spy };

    component.onMemberSelected('agent-gone');

    expect(selection.handleSelection).not.toHaveBeenCalled();
    expect(component.currentVisualizationMode).toBe('team');
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
    // `[team, hierarchy, member, workspace, messages]` — and with KG —
    // `[team, hierarchy, member, knowledge-graph, workspace, messages]`.
    //
    // `hierarchy` is Epic 56 / H2: the Team tab now shows the redesign's
    // roster panel, and the team tree + graph that used to live there kept a
    // tab of their own rather than being folded in under Member.
    log.append(makeWorkspaceStart('ws-start-1', 'Worker'));
    let options = await firstValue(component.visualizationOptions$);
    let labels = options.map((o) => o.value);
    expect(labels).toEqual([
      'team',
      'hierarchy',
      'member',
      'workspace',
      'messages',
    ]);

    log.append(makeKgStart('kg-start-1'));
    options = await firstValue(component.visualizationOptions$);
    labels = options.map((o) => o.value);
    expect(labels).toEqual([
      'team',
      'hierarchy',
      'member',
      'knowledge-graph',
      'workspace',
      'messages',
    ]);
  });

  it('scenario 6 — Workspaces appears between KG and Messages once a WorkspaceTool exists', async () => {
    // With a WorkspaceTool but no KG, the order is
    // [team, hierarchy, member, workspace, messages].
    log.append(makeWorkspaceStart('ws-start-1', 'Worker'));
    let options = await firstValue(component.visualizationOptions$);
    expect(options.map((o) => o.value)).toEqual([
      'team',
      'hierarchy',
      'member',
      'workspace',
      'messages',
    ]);

    // With KG present, Workspace sits between KG and Messages (order).
    log.append(makeKgStart('kg-start-1'));
    options = await firstValue(component.visualizationOptions$);
    expect(options.map((o) => o.value)).toEqual([
      'team',
      'hierarchy',
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
        provideTranslateTesting(),
        MessageLogService,
        ToolPresenceService,
        KGStateReducer,
        WorkspaceRegistryService,
        { provide: ContextService, useValue: contextService },
        { provide: IngestionService, useValue: ingestionService },
        // The REAL session service over the doubled dependencies above: it is
        // the unit under test's collaborator, not a seam these specs mock —
        // they assert on `ingestionService.init` and `currentProcessId$`, which
        // are exactly what it drives.
        TeamSessionService,
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
          imports: [CommonModule, TranslatePipe, SplitDividerComponent],
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
        provideTranslateTesting(),
        MessageLogService,
        ToolPresenceService,
        KGStateReducer,
        WorkspaceRegistryService,
        { provide: ContextService, useValue: context },
        { provide: IngestionService, useValue: ingestion },
        // The REAL session service over the doubled dependencies above: it is
        // the unit under test's collaborator, not a seam these specs mock —
        // they assert on `ingestionService.init` and `currentProcessId$`, which
        // are exactly what it drives.
        TeamSessionService,
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
        set: {
          imports: [CommonModule, TranslatePipe, SplitDividerComponent],
          providers: [],
          schemas: [CUSTOM_ELEMENTS_SCHEMA],
        },
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

// =====================================================================
// R3 — the two panes are arrangeable and resizable
//
// The wiring is a set of BINDINGS, so it is exercised through them: the real
// `app-split-divider` and the real `app-console-inspector` are mounted, and the
// heavy panels stay behind `CUSTOM_ELEMENTS_SCHEMA`. Driving the component's
// handlers directly would pass just as happily with the outputs unbound.
// =====================================================================

describe('ProcessComponent (R3 — arrangeable, resizable panes)', () => {
  interface Harness {
    component: ProcessComponent;
    fixture: ComponentFixture<ProcessComponent>;
    layout: PaneLayoutService;
    collapsed$: BehaviorSubject<boolean>;
  }

  function host(h: Harness): HTMLElement {
    return h.fixture.nativeElement as HTMLElement;
  }

  function paneRow(h: Harness): HTMLElement {
    return host(h).querySelector('.console-panes') as HTMLElement;
  }

  function dividerEl(h: Harness): HTMLElement {
    return host(h).querySelector('app-split-divider') as HTMLElement;
  }

  function divider(h: Harness): SplitDividerComponent {
    return h.fixture.debugElement.query(By.directive(SplitDividerComponent))
      .componentInstance as SplitDividerComponent;
  }

  function inspectorEl(h: Harness): HTMLElement {
    return host(h).querySelector('app-console-inspector') as HTMLElement;
  }

  function stored(): { inspectorSide: string; inspectorPercent: number } | null {
    const raw = localStorage.getItem(PANE_LAYOUT_STORAGE_KEY);
    return raw === null ? null : JSON.parse(raw);
  }

  /**
   * Translations are registered BEFORE the first change-detection pass, which
   * is the shape every translated spec in this codebase uses: it does not
   * depend on `TranslatePipe` re-running after a late `setTranslation`.
   */
  async function build(
    translations?: TranslationObject,
    rowWidth = 1400,
  ): Promise<Harness> {
    const collapsed$ = new BehaviorSubject<boolean>(false);

    await TestBed.configureTestingModule({
      imports: [ProcessComponent, NoopAnimationsModule],
      providers: [
        provideTranslateTesting(),
        MessageLogService,
        ToolPresenceService,
        KGStateReducer,
        WorkspaceRegistryService,
        {
          provide: ContextService,
          useValue: {
            currentProcessId$: new BehaviorSubject<string>(''),
            getCurrentTeam: jasmine.createSpy('getCurrentTeam').and.callFake(async () => makeTeam()),
            navigateHome: jasmine.createSpy('navigateHome').and.resolveTo(true),
          },
        },
        {
          provide: IngestionService,
          useValue: {
            init: jasmine.createSpy('init').and.resolveTo(undefined),
            close: jasmine.createSpy('close'),
          },
        },
        // The REAL session service over the doubled dependencies above: it is
        // the unit under test's collaborator, not a seam these specs mock —
        // they assert on `ingestionService.init` and `currentProcessId$`, which
        // are exactly what it drives.
        TeamSessionService,
        {
          provide: AkgentService,
          useValue: {
            unselect: jasmine.createSpy('unselect'),
            selectedAkgent$: new BehaviorSubject<any>(null),
          },
        },
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
          useValue: {
            isRightColumnCollapsed$: collapsed$,
            toggleRightColumn: () => collapsed$.next(!collapsed$.value),
          },
        },
        {
          provide: Router,
          useValue: { navigate: jasmine.createSpy('navigate').and.resolveTo(true) },
        },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { params: { id: 'team-1' } }, params: of({ id: 'team-1' }) },
        },
      ],
    })
      .overrideComponent(ProcessComponent, {
        set: {
          // The divider and the inspector are REAL: the traps this block exists
          // for (a bound basis beating the collapse rule, a swap that jumps,
          // bounds that do not mirror) all live in the bindings and the
          // stylesheets, and a stub has neither.
          imports: [
            CommonModule,
            TranslatePipe,
            SplitDividerComponent,
            ConsoleInspectorComponent,
          ],
          providers: [],
          schemas: [CUSTOM_ELEMENTS_SCHEMA],
        },
      })
      .compileComponents();

    if (translations !== undefined) {
      setTestTranslations(translations);
    }

    const fixture = TestBed.createComponent(ProcessComponent);
    // A ROW OF A KNOWN, WIDE SIZE, SET BEFORE THE FIRST PASS.
    //
    // The divider's floor is the higher of the 18% preference and the pane's
    // 240px CSS minimum converted at the MEASURED row width, and the component
    // takes that measurement in `ngAfterViewInit` — i.e. during the
    // `detectChanges()` below. Left to the fixture's natural size the row is a
    // few hundred pixels wide, the pixel floor wins in every spec in this
    // block, and specs about frame conversion start failing for a reason that
    // has nothing to do with frame conversion. 1400px puts 240px at 17.1%,
    // below the preference, so the preference governs — which is the case these
    // specs are about. The narrow case has its own spec below.
    fixture.nativeElement.style.display = 'block';
    fixture.nativeElement.style.width = rowWidth + 'px';
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    return {
      component: fixture.componentInstance,
      fixture,
      layout: TestBed.inject(PaneLayoutService),
      collapsed$,
    };
  }

  /**
   * Wait for a `ResizeObserver` callback to have run.
   *
   * Observations are delivered before paint, so one animation frame is the
   * shortest honest wait; the `setTimeout` behind it is the fallback for a
   * headless run where rAF can be throttled to nothing.
   */
  function observed(): Promise<void> {
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => setTimeout(() => resolve(), 0));
    });
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    localStorage.removeItem(PANE_LAYOUT_STORAGE_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(PANE_LAYOUT_STORAGE_KEY);
  });

  // -------------------------------------------------------------------
  // Shape: a sibling, never a wrapper
  // -------------------------------------------------------------------

  /**
   * The divider joins the row as a SIBLING of the two panes.
   *
   * A wrapper would have been the obvious way to group a pane with its
   * boundary, and it would have broken three pinned selectors at once — the two
   * direct-child assertions below plus the projection one — because the
   * inspector has to stay a direct child of `.console-panes` for the injector
   * contract, not for tidiness.
   */
  it('puts the divider between the panes without wrapping either', async () => {
    const h = await build();

    const children = Array.from(paneRow(h).children).map((c) =>
      c.tagName.toLowerCase(),
    );
    expect(children).toEqual([
      'div', // .conversation-pane
      'app-split-divider',
      'app-console-inspector',
    ]);
  });

  it('leaves the pinned containment contract intact', async () => {
    const h = await build();

    expect(host(h).querySelector('.conversation-pane > app-conversation-header')).not.toBeNull();
    expect(host(h).querySelector('.console-panes > app-console-inspector')).not.toBeNull();
    expect(host(h).querySelector('app-console-inspector .inspector-panels')).not.toBeNull();
  });

  // -------------------------------------------------------------------
  // The two frames of reference
  // -------------------------------------------------------------------

  /**
   * The divider measures the LEFTMOST pane; the preference stores the
   * INSPECTOR's share. With the inspector on the right — the default — those
   * are complements, and binding the stored number straight through would put
   * the divider at 26% of the row instead of 74%.
   */
  it('binds the divider in the leading pane frame, not the stored one', async () => {
    const h = await build();

    expect(h.layout.inspectorPercent()).toBe(INSPECTOR_DEFAULT_PERCENT);
    expect(dividerEl(h).getAttribute('aria-valuenow')).toBe(
      String(100 - INSPECTOR_DEFAULT_PERCENT),
    );
  });

  /**
   * Trap 2: reusing `split-width.ts`'s module bounds would give the divider a
   * 20..70 range, i.e. an inspector allowed 30..80% of the row — roughly a
   * 1008px pane on a 1440px screen. Nothing else in the suite would notice.
   */
  it('gives the divider the inspector bounds, mirrored for the leading pane', async () => {
    const h = await build();

    expect(dividerEl(h).getAttribute('aria-valuemin')).toBe(
      String(100 - INSPECTOR_MAX_PERCENT),
    );
    expect(dividerEl(h).getAttribute('aria-valuemax')).toBe(
      String(100 - INSPECTOR_MIN_PERCENT),
    );
  });

  // -------------------------------------------------------------------
  // The narrow end of the drag
  // -------------------------------------------------------------------

  /**
   * `pane-layout.spec.ts` proves the arithmetic and `pane-layout.service.spec`
   * proves the plumbing; what is left for a rendered spec is the part neither
   * can see — that this component MEASURES the row at all. Without the
   * measurement the divider clamps to a flat 18%, which on any row narrower
   * than ~1333px is a percentage the pane will not adopt: the handle keeps
   * tracking the pointer while the boundary stands still, and the width it
   * commits comes back next visit as a width the pane never had.
   *
   * ON THE FIRST FRAME, not after one. The measurement is taken in
   * `ngAfterViewInit` rather than left to the observer's first callback,
   * because a fast drag started in that frame would commit a bad width.
   */
  it('floors the divider at the pane pixel minimum on a narrow row, from the first frame', async () => {
    // 900px row: 240px of it is 26.7%, well above the 18% preference.
    const h = await build(undefined, 900);

    // The inspector is on the right, so ITS floor is the leading pane's ceiling.
    const announcedMax = Number(dividerEl(h).getAttribute('aria-valuemax'));
    expect(announcedMax).toBeLessThan(100 - INSPECTOR_MIN_PERCENT);
    expect(((100 - announcedMax) / 100) * 900).toBeGreaterThanOrEqual(240);
  });

  it('leaves the percentage preference in charge once the row is wide enough', async () => {
    const h = await build(undefined, 1400);

    expect(dividerEl(h).getAttribute('aria-valuemax')).toBe(
      String(100 - INSPECTOR_MIN_PERCENT),
    );
  });

  /**
   * The row changes width for reasons the WINDOW does not know about — the rail
   * collapsing, the inspector closing — and each of those moves the floor
   * exactly as a window resize does. A `window:resize` listener would miss all
   * of them and leave the divider bounded against a width that stopped being
   * true two interactions ago.
   */
  it('follows the row when it changes size under it', async () => {
    const h = await build(undefined, 1400);
    expect(dividerEl(h).getAttribute('aria-valuemax')).toBe(
      String(100 - INSPECTOR_MIN_PERCENT),
    );

    h.fixture.nativeElement.style.width = '900px';
    await observed();
    h.fixture.detectChanges();

    expect(Number(dividerEl(h).getAttribute('aria-valuemax'))).toBeLessThan(
      100 - INSPECTOR_MIN_PERCENT,
    );
  });

  /**
   * `PaneLayoutService` is root-scoped and this view is rebuilt on every team
   * switch, so a width that outlived its element would bound the NEXT team's
   * divider against the last team's row.
   */
  it('retracts the measurement when the view goes away', async () => {
    const h = await build(undefined, 900);
    expect(h.layout.leadingBounds().max).toBeLessThan(100 - INSPECTOR_MIN_PERCENT);

    h.fixture.destroy();

    expect(h.layout.leadingBounds()).toEqual({
      min: 100 - INSPECTOR_MAX_PERCENT,
      max: 100 - INSPECTOR_MIN_PERCENT,
    });
  });

  it('names the divider from a translation key, not a hardcoded caption', async () => {
    const h = await build({ console: { splitLabel: '<<resize>>' } });

    expect(dividerEl(h).getAttribute('aria-label')).toBe('<<resize>>');
  });

  // -------------------------------------------------------------------
  // Swapping
  // -------------------------------------------------------------------

  it('paints the panes in the stored order, and swaps with a class rather than a move', async () => {
    const h = await build();
    expect(paneRow(h).classList.contains('console-panes--swapped')).toBeFalse();

    h.component.onSwapPanes();
    h.fixture.detectChanges();

    expect(paneRow(h).classList.contains('console-panes--swapped')).toBeTrue();
    // The DOM order is untouched: the swap is CSS `order`, so the inspector
    // stays a direct child in the same slot and the injector contract holds.
    expect(host(h).querySelector('.console-panes > app-console-inspector')).not.toBeNull();
    expect(Array.from(paneRow(h).children).map((c) => c.tagName.toLowerCase())).toEqual([
      'div',
      'app-split-divider',
      'app-console-inspector',
    ]);
  });

  /**
   * Trap 3, the one with no other coverage. If the persisted quantity were the
   * divider's own (the leading pane's share), a 26% inspector on the right
   * would come back as a 26% inspector on the LEFT — the pane would visibly
   * change size as it changed sides.
   */
  it('a swap moves the pane without resizing it, and re-mirrors the divider', async () => {
    const h = await build();
    h.component.onPaneCommit(70); // leading 70 → inspector 30, on the right
    h.fixture.detectChanges();
    expect(dividerEl(h).getAttribute('aria-valuenow')).toBe('70');

    h.component.onSwapPanes();
    h.fixture.detectChanges();

    expect(h.layout.inspectorPercent()).toBe(30);
    expect(inspectorEl(h).style.getPropertyValue('--akg-inspector-basis')).toBe('30%');
    // The divider follows the pane: the inspector now leads, so 30 is its share
    // outright, and the range is the inspector's own rather than its mirror.
    expect(dividerEl(h).getAttribute('aria-valuenow')).toBe('30');
    expect(dividerEl(h).getAttribute('aria-valuemin')).toBe(String(INSPECTOR_MIN_PERCENT));
    expect(dividerEl(h).getAttribute('aria-valuemax')).toBe(String(INSPECTOR_MAX_PERCENT));
  });

  /**
   * Through the pane's own control and its `(swapSides)` binding, so an output
   * lost in a rename fails here rather than passing on a direct method call.
   */
  it('the swap control in the pane is what swaps them', async () => {
    const h = await build();

    const swap = inspectorEl(h).querySelector(
      'app-icon-button[data-test="inspector-swap"] button',
    ) as HTMLButtonElement;
    expect(swap).not.toBeNull();
    swap.click();
    h.fixture.detectChanges();

    expect(h.layout.inspectorSide()).toBe('left');
    expect(paneRow(h).classList.contains('console-panes--swapped')).toBeTrue();
  });

  it('tells the pane which side it is on, so its control names the right destination', async () => {
    const h = await build({
      inspector: { moveLeft: '<<left>>', moveRight: '<<right>>' },
    });

    const swapLabel = (): string | null =>
      inspectorEl(h)
        .querySelector('app-icon-button[data-test="inspector-swap"] button')!
        .getAttribute('aria-label');

    expect(swapLabel()).toBe('<<left>>');

    h.component.onSwapPanes();
    h.fixture.detectChanges();

    expect(swapLabel()).toBe('<<right>>');
  });

  // -------------------------------------------------------------------
  // Dragging: continuous layout, one write
  // -------------------------------------------------------------------

  /**
   * A drag, through the REAL divider. The two rects are stubbed so the maths is
   * exact rather than dependent on the karma frame's width and the browser's
   * rem: 600 of 1000 with a zero-width handle is 60% to the leading pane, so
   * 40% to the inspector.
   */
  async function drag(h: Harness, toX: number): Promise<void> {
    spyOn(paneRow(h), 'getBoundingClientRect').and.returnValue({
      left: 0,
      width: 1000,
    } as DOMRect);
    spyOn(dividerEl(h), 'getBoundingClientRect').and.returnValue({
      left: 0,
      width: 0,
    } as DOMRect);
    // `dragging` directly: `setPointerCapture` rejects a pointer id the browser
    // has no record of, and the capture is not what these specs are about.
    divider(h).dragging = true;
    divider(h).onPointerMove({ clientX: toX } as PointerEvent);
    h.fixture.detectChanges();
  }

  it('a drag lays the panes out live and writes NOTHING', async () => {
    const h = await build();

    await drag(h, 600);

    expect(h.layout.inspectorPercent()).toBe(40);
    expect(inspectorEl(h).style.getPropertyValue('--akg-inspector-basis')).toBe('40%');
    expect(stored()).toBeNull();
  });

  it('the drop persists, once, and in the inspector frame', async () => {
    const h = await build();
    await drag(h, 600);

    divider(h).onPointerUp({ pointerId: 1 } as PointerEvent);
    h.fixture.detectChanges();

    expect(stored()).toEqual({ inspectorSide: 'right', inspectorPercent: 40 });
  });

  /**
   * The keyboard path is a settled change the moment it happens, so it both
   * lays out and persists — and it goes through the same conversion, which is
   * where an inverted sign would show up as the pane moving the wrong way.
   */
  it('a keystroke on the divider resizes the inspector and persists it', async () => {
    const h = await build();

    dividerEl(h).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
    );
    h.fixture.detectChanges();

    // Leading 74 → 73 is one percent LESS conversation, i.e. one percent MORE
    // inspector.
    expect(h.layout.inspectorPercent()).toBe(INSPECTOR_DEFAULT_PERCENT + 1);
    expect(stored()!.inspectorPercent).toBe(INSPECTOR_DEFAULT_PERCENT + 1);
  });

  /**
   * The transition has to be off WHILE dragging or the pane trails the pointer
   * by the length of the ease and never arrives. On by default, off between the
   * live output and the settled one, back on afterwards.
   */
  it('suppresses the width transition for the duration of the drag only', async () => {
    const h = await build();
    expect(inspectorEl(h).classList.contains('resizing')).toBeFalse();

    await drag(h, 600);
    expect(inspectorEl(h).classList.contains('resizing')).toBeTrue();

    divider(h).onPointerUp({ pointerId: 1 } as PointerEvent);
    h.fixture.detectChanges();
    expect(inspectorEl(h).classList.contains('resizing')).toBeFalse();
  });

  // -------------------------------------------------------------------
  // Trap 1: the basis must not outrank the collapse
  // -------------------------------------------------------------------

  /**
   * THE TRAP WITH NO OTHER COVERAGE.
   *
   * A bound inline `flex-basis` is an inline declaration, so it beats
   * `:host(.collapsed)` — and the Details toggle and the pane's own close X
   * silently stop working, because nothing in this suite measures a rendered
   * width. The width therefore arrives as a CUSTOM PROPERTY, which the
   * stylesheet reads through `var()`, leaving the cascade intact.
   *
   * Measured with `getComputedStyle`, deliberately: the point is what the
   * browser resolved, not what was written.
   */
  it('a collapsed inspector really is zero wide — basis AND minimum', async () => {
    const h = await build();
    const el = inspectorEl(h);

    // The transition is taken OUT of the measurement, deliberately. Mid-flight,
    // `getComputedStyle` reports the INTERPOLATED value, so a pane one frame
    // into a 180ms ease still reads as its starting width and this assertion
    // would pass or fail on timing rather than on the cascade. Turning the gate
    // off is also a real state: it is what the first paint looks like when the
    // user arrives with details already hidden.
    h.component.animateRightColumn = false;
    h.fixture.detectChanges();

    // Open: the bound share is on the element as a custom property, and the
    // resolved basis is not zero.
    expect(el.style.getPropertyValue('--akg-inspector-basis')).toBe(
      `${INSPECTOR_DEFAULT_PERCENT}%`,
    );
    expect(getComputedStyle(el).flexBasis).not.toBe('0px');

    h.collapsed$.next(true);
    h.fixture.detectChanges();

    expect(el.classList.contains('collapsed')).toBeTrue();
    // The custom property is UNCHANGED — the collapse wins on the cascade, not
    // by the host withdrawing the width. That is the whole mechanism, and it is
    // what an inline `flex-basis` would have broken with nothing to show for it.
    expect(el.style.getPropertyValue('--akg-inspector-basis')).toBe(
      `${INSPECTOR_DEFAULT_PERCENT}%`,
    );
    expect(getComputedStyle(el).flexBasis).toBe('0px');
    // And the pixel floor with it: a "collapsed" pane still holding its
    // minimum is a 240px pane with `inert` set on it.
    expect(getComputedStyle(el).minWidth).toBe('0px');
  });

  /**
   * The other half of the same mechanism: the pane must come BACK. A collapse
   * that could not be undone would be the same defect wearing the opposite
   * class.
   */
  it('and comes back to its dragged width when reopened', async () => {
    const h = await build();
    h.component.animateRightColumn = false;
    h.component.onPaneCommit(65); // inspector → 35%
    h.fixture.detectChanges();
    const el = inspectorEl(h);

    h.collapsed$.next(true);
    h.fixture.detectChanges();
    expect(getComputedStyle(el).flexBasis).toBe('0px');

    h.collapsed$.next(false);
    h.fixture.detectChanges();

    expect(getComputedStyle(el).flexBasis).toBe('35%');
    expect(getComputedStyle(el).minWidth).not.toBe('0px');
  });

  /**
   * There is no boundary to drag when there is only one pane. Leaving the
   * divider standing would give the user a control that moves nothing on screen
   * and still rewrites the stored width — they would find the pane at a size
   * they never chose the next time they opened it.
   */
  it('withdraws the divider while the inspector is collapsed, and brings it back', async () => {
    const h = await build();
    expect(dividerEl(h)).not.toBeNull();

    h.collapsed$.next(true);
    h.fixture.detectChanges();
    expect(dividerEl(h)).toBeNull();

    h.collapsed$.next(false);
    h.fixture.detectChanges();

    expect(dividerEl(h)).not.toBeNull();
    // At the width it had: the collapse never touched the preference.
    expect(dividerEl(h).getAttribute('aria-valuenow')).toBe(
      String(100 - INSPECTOR_DEFAULT_PERCENT),
    );
  });

  // -------------------------------------------------------------------
  // Hydration
  // -------------------------------------------------------------------

  it('paints the stored arrangement on the first frame, not the default', async () => {
    localStorage.setItem(
      PANE_LAYOUT_STORAGE_KEY,
      JSON.stringify({ inspectorSide: 'left', inspectorPercent: 33 }),
    );

    const h = await build();

    expect(paneRow(h).classList.contains('console-panes--swapped')).toBeTrue();
    expect(inspectorEl(h).style.getPropertyValue('--akg-inspector-basis')).toBe('33%');
    expect(dividerEl(h).getAttribute('aria-valuenow')).toBe('33');
  });

  it('falls back to the default arrangement for a corrupt entry', async () => {
    localStorage.setItem(PANE_LAYOUT_STORAGE_KEY, '{"inspectorSide":"sideways"}');

    const h = await build();

    expect(paneRow(h).classList.contains('console-panes--swapped')).toBeFalse();
    expect(inspectorEl(h).style.getPropertyValue('--akg-inspector-basis')).toBe(
      `${INSPECTOR_DEFAULT_PERCENT}%`,
    );
  });

  /**
   * The arrangement is a property of the WINDOW, not of whichever team is open.
   * This component is destroyed and rebuilt on every team switch — that is what
   * its ordered `providers` array is for — so a component-scoped preference
   * would be re-read from storage each time the user changed team, and a width
   * dragged a moment ago would snap back.
   *
   * Asserted by rebuilding the view, which is exactly what a team switch does.
   */
  it('keeps the arrangement across a rebuild of the view', async () => {
    const h = await build();
    h.component.onPaneCommit(60); // inspector → 40%, still on the right
    h.component.onSwapPanes();
    h.fixture.detectChanges();
    h.fixture.destroy();

    const second = TestBed.createComponent(ProcessComponent);
    second.detectChanges();
    const row = second.nativeElement.querySelector('.console-panes') as HTMLElement;
    const pane = second.nativeElement.querySelector(
      'app-console-inspector',
    ) as HTMLElement;

    expect(row.classList.contains('console-panes--swapped')).toBeTrue();
    expect(pane.style.getPropertyValue('--akg-inspector-basis')).toBe('40%');
  });
});

/**
 * W18(b) — the deployment filter, wired through the component rather than
 * exercised as a pure function.
 *
 * `inspector-tabs.registry.spec.ts` already pins `visibleInspectorTabs` and
 * `resolveInspectorTab` on their own. What it CANNOT pin is that
 * `ProcessComponent` actually reads `ConfigService.hiddenInspectorTabs` and
 * actually routes the active mode through the resolver — the wiring is the
 * half that silently does nothing if somebody drops the argument, and a green
 * registry spec would not notice.
 */
describe('ProcessComponent — hiding inspector tabs per deployment (W18b)', () => {
  async function mountWithHidden(
    hidden: readonly string[],
  ): Promise<ProcessComponent> {
    // Same stubs the suite's main bed uses; only ConfigService differs.
    const contextService = {
      currentProcessId$: new BehaviorSubject<string>(''),
      getCurrentTeam: jasmine
        .createSpy('getCurrentTeam')
        .and.callFake(async () => makeTeam()),
      navigateHome: jasmine.createSpy('navigateHome').and.resolveTo(true),
    };
    const ingestionService = {
      init: jasmine.createSpy('init').and.returnValue(Promise.resolve()),
      close: jasmine.createSpy('close'),
    };
    const akgentService = {
      unselect: jasmine.createSpy('unselect'),
      selectedAkgent$: new BehaviorSubject<NodeInterface | null>(null),
    };
    const graphDataService = {
      isLoading$: new BehaviorSubject<boolean>(false),
      nodes$: new BehaviorSubject<NodeInterface[]>([]),
    };
    const chatService = { messages$: new BehaviorSubject<unknown[]>([]) };

    await TestBed.configureTestingModule({
      imports: [ProcessComponent, NoopAnimationsModule],
      providers: [
        provideTranslateTesting(),
        MessageLogService,
        ToolPresenceService,
        KGStateReducer,
        WorkspaceRegistryService,
        { provide: ContextService, useValue: contextService },
        { provide: IngestionService, useValue: ingestionService },
        // The REAL session service over the doubled dependencies above: it is
        // the unit under test's collaborator, not a seam these specs mock —
        // they assert on `ingestionService.init` and `currentProcessId$`, which
        // are exactly what it drives.
        TeamSessionService,
        { provide: AkgentService, useValue: akgentService },
        { provide: GraphDataService, useValue: graphDataService },
        { provide: ChatService, useValue: chatService },
        {
          provide: SelectionService,
          useValue: { handleSelection: jasmine.createSpy('handleSelection') },
        },
        { provide: FeedbackService, useValue: {} },
        {
          provide: ViewService,
          useValue: { isRightColumnCollapsed$: new BehaviorSubject<boolean>(false) },
        },
        {
          provide: Router,
          useValue: {
            navigate: jasmine
              .createSpy('navigate')
              .and.returnValue(Promise.resolve(true)),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { params: { id: 'team-1' } },
            params: of({ id: 'team-1' }),
          },
        },
        // The whole point of the fixture: a deployment's config.json.
        { provide: ConfigService, useValue: { hiddenInspectorTabs: hidden } },
      ],
    })
      .overrideComponent(ProcessComponent, {
        set: {
          imports: [CommonModule, TranslatePipe, SplitDividerComponent],
          providers: [],
          schemas: [CUSTOM_ELEMENTS_SCHEMA],
        },
      })
      .compileComponents();

    const fixture = TestBed.createComponent(ProcessComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  afterEach(() => TestBed.resetTestingModule());

  it('drops a tab this deployment switched off', async () => {
    const component = await mountWithHidden(['messages']);

    const options = await firstValue(component.visualizationOptions$);
    expect(options.some((o) => o.value === 'messages')).toBeFalse();
    // The rest of the strip is untouched — hiding is a filter, not a rebuild.
    expect(options.some((o) => o.value === 'team')).toBeTrue();
    expect(options.some((o) => o.value === 'hierarchy')).toBeTrue();
  });

  it('IGNORES an id that names no tab, rather than throwing', async () => {
    // Hand-written JSON naming a tab that was renamed or never existed. The
    // console must still boot: the correct response to "hide something that is
    // not there" is that it is already not there.
    const component = await mountWithHidden(['not-a-tab', 'messages']);

    const options = await firstValue(component.visualizationOptions$);
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o.value === 'messages')).toBeFalse();
    expect(options.some((o) => o.value === 'team')).toBeTrue();
  });

  it('moves off a hidden ACTIVE tab instead of leaving a blank pane', async () => {
    const component = await mountWithHidden(['team']);

    const options = await firstValue(component.visualizationOptions$);
    expect(options.some((o) => o.value === 'team')).toBeFalse();
    // `team` is the component's initial mode, so this is the case where the
    // deployment hid the tab the user is standing on. It must land on a
    // VISIBLE one — and specifically not on the hard-coded 'team' the two
    // guards this replaced both snapped back to.
    expect(component.currentVisualizationMode).not.toBe('team');
    expect(
      options.some((o) => o.value === component.currentVisualizationMode),
    ).toBeTrue();
  });
});
