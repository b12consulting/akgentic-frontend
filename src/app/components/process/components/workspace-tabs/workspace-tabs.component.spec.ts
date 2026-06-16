import { CommonModule } from '@angular/common';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { Tabs } from 'primeng/tabs';
import { Tooltip } from 'primeng/tooltip';
import { BehaviorSubject } from 'rxjs';

import { ContextService } from '../../../../core/context/context.service';
import { WorkspaceService } from '../../workspace/workspace.service';
import {
  AgentsById,
  AgentsByIdService,
} from '../../selectors/agents-by-id.selector';
import {
  WorkspaceDescriptor,
  WorkspaceRegistryService,
} from '../../selectors/workspace-registry.selector';
import { WorkspaceExplorerComponent } from '../workspace-explorer/workspace-explorer.component';
import { WorkspaceTabsComponent } from './workspace-tabs.component';

// --------------------------------------------------------------------
// Fixture helpers — descriptor shape mirrors workspace-registry.selector.
// --------------------------------------------------------------------

const TEAM_ID = 'team-1';

function defaultDescriptor(agentIds: string[] = []): WorkspaceDescriptor {
  return {
    workspaceId: TEAM_ID,
    isDefault: true,
    agentIds,
    label: 'Default workspace',
  };
}

function namedDescriptor(
  workspaceId: string,
  agentIds: string[] = ['agent-A'],
): WorkspaceDescriptor {
  return {
    workspaceId,
    isDefault: false,
    agentIds,
    label: workspaceId,
  };
}

/** Fake registry exposing a BehaviorSubject the test drives directly. */
class FakeWorkspaceRegistryService {
  readonly workspaces$ = new BehaviorSubject<WorkspaceDescriptor[]>([
    defaultDescriptor(),
  ]);
}

/** Fake identity map exposing a BehaviorSubject the test drives directly. */
class FakeAgentsByIdService {
  readonly agentsById$ = new BehaviorSubject<AgentsById>({});
}

describe('WorkspaceTabsComponent', () => {
  let fixture: ComponentFixture<WorkspaceTabsComponent>;
  let registry: FakeWorkspaceRegistryService;
  let agents: FakeAgentsByIdService;

  beforeEach(async () => {
    registry = new FakeWorkspaceRegistryService();
    agents = new FakeAgentsByIdService();

    const contextStub = {
      currentProcessId$: new BehaviorSubject<string>('proc'),
      currentTeamRunning$: new BehaviorSubject<boolean>(true),
    };
    const workspaceStub = jasmine.createSpyObj('WorkspaceService', [
      'getWorkspaceTree',
      'getFileContent',
      'getDownloadUrl',
      'uploadFiles',
    ]);
    workspaceStub.getWorkspaceTree.and.resolveTo([]);

    await TestBed.configureTestingModule({
      imports: [WorkspaceTabsComponent, NoopAnimationsModule],
      providers: [
        { provide: ContextService, useValue: contextStub },
        { provide: WorkspaceService, useValue: workspaceStub },
      ],
    })
      // Drive `workspaces$` / `agentsById$` directly via the component-scoped
      // services.
      .overrideComponent(WorkspaceTabsComponent, {
        set: {
          providers: [
            { provide: WorkspaceRegistryService, useValue: registry },
            { provide: AgentsByIdService, useValue: agents },
          ],
        },
      })
      // Neutralise the explorer's heavy PrimeNG/markdown template so we can
      // mount the REAL explorer (and read its `workspaceId` @Input) without
      // pulling in its full render tree.
      .overrideComponent(WorkspaceExplorerComponent, {
        set: {
          imports: [CommonModule],
          template: '',
          schemas: [CUSTOM_ELEMENTS_SCHEMA],
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(WorkspaceTabsComponent);
  });

  function explorers(): WorkspaceExplorerComponent[] {
    return fixture.debugElement
      .queryAll(By.directive(WorkspaceExplorerComponent))
      .map((de) => de.componentInstance as WorkspaceExplorerComponent);
  }

  function hasTabChrome(): boolean {
    return (
      fixture.debugElement.query(By.css('p-tabs')) !== null ||
      fixture.debugElement.query(By.css('p-tablist')) !== null
    );
  }

  function chipLabels(): string[] {
    return fixture.debugElement
      .queryAll(By.css('p-chip'))
      .map((de) => (de.nativeElement.textContent as string).trim());
  }

  function strips(): number {
    return fixture.debugElement.queryAll(By.css('.workspace-header-strip'))
      .length;
  }

  /**
   * Activate the tab at `index`. PrimeNG 19's `<p-tabpanel>` renders ONLY the
   * active panel's content (`@if (active())`), so each tab's explorer is
   * mounted only while its panel is selected. Switching the `Tabs` value lets
   * us inspect the explorer bound inside each panel in turn.
   */
  function activateTab(index: number): void {
    const tabs = fixture.debugElement.query(By.directive(Tabs))
      .componentInstance as Tabs;
    tabs.value.set(index.toString());
    fixture.detectChanges();
  }

  // -------------------------------------------------------------------
  // Story 23-3 sub-tab behaviour (must stay green — AC6 no churn).
  // -------------------------------------------------------------------

  it('(23-3 AC3) default-only → one explorer, no tab chrome, workspaceId undefined', () => {
    registry.workspaces$.next([defaultDescriptor()]);
    fixture.detectChanges();

    const found = explorers();
    expect(found.length).toBe(1);
    expect(hasTabChrome()).toBe(false);
    expect(found[0].workspaceId).toBeUndefined();
  });

  it('(23-3 AC1, AC2, AC4) default + 1 named → tab chrome, one panel per descriptor, correct bindings', () => {
    registry.workspaces$.next([
      defaultDescriptor(),
      namedDescriptor('ws-named'),
    ]);
    fixture.detectChanges();

    expect(hasTabChrome()).toBe(true);
    // One <p-tabpanel> per descriptor exists in the DOM (AC1)...
    expect(fixture.debugElement.queryAll(By.css('p-tabpanel')).length).toBe(2);

    // ...but PrimeNG mounts only the active panel's content, so we inspect
    // each panel's bound explorer by activating its tab in turn.
    // Default tab (index 0) is active by default: explorer keeps team-id-only
    // behaviour (workspaceId undefined) (AC2).
    let found = explorers();
    expect(found.length).toBe(1);
    expect(found[0].workspaceId).toBeUndefined();

    // Named tab (index 1): explorer is bound to its workspace id (AC2).
    activateTab(1);
    found = explorers();
    expect(found.length).toBe(1);
    expect(found[0].workspaceId).toBe('ws-named');
  });

  it('(23-3 AC5) tab labels render from descriptor.label', () => {
    registry.workspaces$.next([
      defaultDescriptor(),
      namedDescriptor('ws-named'),
    ]);
    fixture.detectChanges();

    const labels = fixture.debugElement
      .queryAll(By.css('p-tab'))
      .map((de) => (de.nativeElement.textContent as string).trim());
    expect(labels).toEqual(['Default workspace', 'ws-named']);
  });

  it('(23-3 AC6) reactive re-emission re-renders the sub-tabs', () => {
    registry.workspaces$.next([defaultDescriptor()]);
    fixture.detectChanges();
    expect(explorers().length).toBe(1);
    expect(hasTabChrome()).toBe(false);

    // A later named-workspace discovery flips the view to tabbed chrome with
    // one <p-tabpanel> per descriptor.
    registry.workspaces$.next([
      defaultDescriptor(),
      namedDescriptor('ws-named'),
    ]);
    fixture.detectChanges();
    expect(hasTabChrome()).toBe(true);
    expect(fixture.debugElement.queryAll(By.css('p-tabpanel')).length).toBe(2);
  });

  // -------------------------------------------------------------------
  // Story 23-4 member-chip header strip.
  // -------------------------------------------------------------------

  it('(AC2) single-default → strip above the bare explorer, NO tab chrome', () => {
    registry.workspaces$.next([defaultDescriptor(['a1'])]);
    agents.agentsById$.next({ a1: { name: 'Bob', role: 'Scrum Master' } });
    fixture.detectChanges();

    expect(strips()).toBe(1);
    expect(explorers().length).toBe(1);
    expect(hasTabChrome()).toBe(false);
  });

  it('(AC3) one chip per member, names in agentIds order, role as tooltip', () => {
    registry.workspaces$.next([
      defaultDescriptor(),
      namedDescriptor('ws-named', ['a1', 'a2']),
    ]);
    agents.agentsById$.next({
      a1: { name: 'Bob', role: 'Scrum Master' },
      a2: { name: 'Amelia', role: 'Developer' },
    });
    fixture.detectChanges();

    // The named workspace's members are visible on its (active) panel.
    activateTab(1);
    expect(chipLabels()).toEqual(['Bob', 'Amelia']);

    // Each chip exposes its role via the pTooltip binding (Tooltip.content is
    // the `pTooltip` input's property alias).
    const tooltips = fixture.debugElement
      .queryAll(By.directive(Tooltip))
      .map((de) => (de.injector.get(Tooltip) as Tooltip).content);
    expect(tooltips).toEqual(['Scrum Master', 'Developer']);
  });

  it('(AC4) descriptor with no declared members → no strip rendered (no empty bar)', () => {
    // A workspace is only ever listed because ≥1 agent declared access, so an
    // empty member set is not a real state to label — render no strip at all.
    registry.workspaces$.next([defaultDescriptor([])]);
    agents.agentsById$.next({});
    fixture.detectChanges();

    expect(chipLabels()).toEqual([]);
    expect(strips()).toBe(0);
    expect(fixture.debugElement.query(By.css('.ws-no-members'))).toBeNull();
  });

  it('(AC4b) the default workspace is NOT treated as "all members" — chips reflect its agentIds', () => {
    // Access is per-workspace and tool-dependent: a default workspace with one
    // declared member shows that member, never an implicit "all members".
    registry.workspaces$.next([defaultDescriptor(['agent-A'])]);
    agents.agentsById$.next({ 'agent-A': { name: 'Bob', role: 'Scrum Master' } });
    fixture.detectChanges();

    expect(chipLabels()).toEqual(['Bob']);
    expect(fixture.debugElement.query(By.css('.ws-no-members'))).toBeNull();
  });

  it('(layout) header strip is rendered above the explorer within the pane', () => {
    registry.workspaces$.next([defaultDescriptor(['d1'])]);
    agents.agentsById$.next({ d1: { name: 'Bob', role: 'SM' } });
    fixture.detectChanges();

    const pane = fixture.debugElement.query(By.css('.workspace-pane'))
      .nativeElement as HTMLElement;
    const strip = pane.querySelector('.workspace-header-strip');
    const explorer = pane.querySelector('app-workspace-explorer');
    expect(strip).not.toBeNull();
    expect(explorer).not.toBeNull();
    // The strip must precede the explorer in document order (strip on top).
    expect(
      strip!.compareDocumentPosition(explorer!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('(AC5) selecting a sub-tab updates the chip row to that workspace members', () => {
    registry.workspaces$.next([
      defaultDescriptor(['d1']),
      namedDescriptor('ws-named', ['n1', 'n2']),
    ]);
    agents.agentsById$.next({
      d1: { name: 'Dana', role: 'Lead' },
      n1: { name: 'Bob', role: 'Scrum Master' },
      n2: { name: 'Amelia', role: 'Developer' },
    });
    fixture.detectChanges();

    // Default tab (index 0) active first → its sole member.
    expect(chipLabels()).toEqual(['Dana']);

    // Switching to the named tab updates the strip to that workspace members.
    activateTab(1);
    expect(chipLabels()).toEqual(['Bob', 'Amelia']);
  });

  it('(AC3 defensive) unknown agent_id falls back to the raw id as the name', () => {
    registry.workspaces$.next([defaultDescriptor(['ghost'])]);
    agents.agentsById$.next({});
    fixture.detectChanges();

    expect(chipLabels()).toEqual(['ghost']);
  });
});
