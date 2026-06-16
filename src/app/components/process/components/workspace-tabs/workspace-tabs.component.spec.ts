import { CommonModule } from '@angular/common';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { Tabs } from 'primeng/tabs';
import { BehaviorSubject } from 'rxjs';

import { ContextService } from '../../../../core/context/context.service';
import { WorkspaceService } from '../../workspace/workspace.service';
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

function defaultDescriptor(): WorkspaceDescriptor {
  return {
    workspaceId: TEAM_ID,
    isDefault: true,
    agentIds: [],
    label: 'Default workspace',
  };
}

function namedDescriptor(workspaceId: string): WorkspaceDescriptor {
  return {
    workspaceId,
    isDefault: false,
    agentIds: ['agent-A'],
    label: workspaceId,
  };
}

/** Fake registry exposing a BehaviorSubject the test drives directly. */
class FakeWorkspaceRegistryService {
  readonly workspaces$ = new BehaviorSubject<WorkspaceDescriptor[]>([
    defaultDescriptor(),
  ]);
}

describe('WorkspaceTabsComponent', () => {
  let fixture: ComponentFixture<WorkspaceTabsComponent>;
  let registry: FakeWorkspaceRegistryService;

  beforeEach(async () => {
    registry = new FakeWorkspaceRegistryService();

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
      // Drive `workspaces$` directly via the component-scoped registry.
      .overrideComponent(WorkspaceTabsComponent, {
        set: {
          providers: [
            { provide: WorkspaceRegistryService, useValue: registry },
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

  it('(AC3) default-only → one explorer, no tab chrome, workspaceId undefined', () => {
    registry.workspaces$.next([defaultDescriptor()]);
    fixture.detectChanges();

    const found = explorers();
    expect(found.length).toBe(1);
    expect(hasTabChrome()).toBe(false);
    expect(found[0].workspaceId).toBeUndefined();
  });

  it('(AC1, AC2, AC4) default + 1 named → tab chrome, one panel per descriptor, correct bindings', () => {
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

  it('(AC5) tab labels render from descriptor.label', () => {
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

  it('(AC6) reactive re-emission re-renders the sub-tabs', () => {
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
});
