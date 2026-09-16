import { ChangeDetectorRef, Component, NgZone } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { TeamTabsComponent } from './team-tabs.component';
import { GraphComponent } from './graph/graph.component';
import { AkgentService } from '../../../services/akgent.service';
import { ApiService } from '../../../core/http/api.service';
import { CategoryService } from '../../../services/category.service';
import { GraphDataService } from '../../../services/process/selectors/graph.selector';
import { MessageLogService } from '../../../services/process/event/message-log.service';
import { SelectionService } from '../../../services/process/ui-state/selection.service';
import { provideTranslateTesting } from '../../../../testing/i18n-testing';

/**
 * "No agents available" PRINTED OVER A FULLY DRAWN GRAPH — reproduced.
 *
 * `graph/graph.component.spec.ts` already covers this overlay and passes. It
 * cannot see this defect for two reasons, and BOTH have to be removed before
 * the bug appears:
 *
 *  1. IT MOUNTS `GraphComponent` AS THE ROOT OF ITS OWN FIXTURE. In the app the
 *     graph is never a root — `process.component.html` renders
 *     `<app-team-tabs>`, and that is where `<app-graph>` lives.
 *     `TeamTabsComponent` is `OnPush` with no inputs, no outputs, no template
 *     bindings and an empty class body, so NOTHING can ever mark it dirty
 *     again after its first render. `tick()` skips a clean OnPush view together
 *     with every component view beneath it, so the graph's template stops being
 *     re-evaluated for the rest of the app's life. The host below is Default-CD,
 *     exactly like `ProcessComponent`; the real wrapper in between is the only
 *     change-detection difference from the passing spec.
 *
 *  2. IT EMITS IMMEDIATELY AFTER MOUNT. The `TranslatePipe` inside
 *     `<app-inspector-empty-state>` — which only exists WHILE the overlay is on
 *     screen — calls `markForCheck()` when its translation resolves, and that
 *     one call marks the graph's view and its OnPush ancestors dirty. An
 *     emission landing in that window is rendered correctly, which is why the
 *     bug hides in a test and not in the product: in the browser the
 *     translations resolve at boot and the team's first `StartMessage` arrives
 *     seconds later, with nothing left to mark anything dirty. `quiesce()`
 *     below reproduces that ordering, and is load-bearing.
 *
 * The log is driven through the REAL `MessageLogService` + `GraphDataService`,
 * so the assertions also settle the question the overlay was being read as
 * evidence for: whether `nodes$` is emitting empty. It is not.
 */
@Component({
  standalone: true,
  imports: [TeamTabsComponent],
  template: `<app-team-tabs></app-team-tabs>`,
})
class ProcessHostStub {}

function startMessage(agentId: string): any {
  return {
    id: 'start-' + agentId,
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-09-11T10:00:00Z',
    sender: {
      __actor_address__: true,
      agent_id: agentId,
      name: '@' + agentId,
      role: 'Worker',
      squad_id: 'squad-1',
      user_message: false,
    },
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StartMessage',
    config: {},
    parent: null,
  };
}

describe('TeamTabs → Graph — the empty-state overlay, at production topology', () => {
  let fixture: ComponentFixture<ProcessHostStub>;
  let log: MessageLogService;
  let zone: NgZone;

  /**
   * One macrotask. NOT `fixture.whenStable()`: echarts schedules its own
   * animation work, so this fixture never reports stable.
   */
  function settle(): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  /** Spend every mount-time `markForCheck()` before the first agent arrives —
   *  see (2) in the file comment. */
  async function quiesce(): Promise<void> {
    await settle();
    await settle();
    await settle();
  }

  function overlay(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.graph-empty');
  }

  function graph(): GraphComponent {
    return fixture.debugElement.query(By.directive(GraphComponent))
      .componentInstance as GraphComponent;
  }

  /** How many nodes the CHART is currently drawing — the thing the user can
   *  see underneath the overlay. */
  function drawnNodeCount(): number {
    const ec = (graph() as unknown as { echartsInstance: any }).echartsInstance;
    return ec.getOption().series[0].data.length as number;
  }

  /** The team arrives, the way it does in the browser: on the websocket feed,
   *  outside the Angular zone. */
  function agentsArrive(): void {
    zone.runOutsideAngular(() => {
      log.appendAll([
        startMessage('coordinator'),
        startMessage('researcher'),
        startMessage('writer'),
      ]);
    });
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProcessHostStub],
      providers: [
        provideTranslateTesting(),
        MessageLogService,
        CategoryService,
        GraphDataService,
        { provide: ApiService, useValue: {} },
        { provide: AkgentService, useValue: {} },
        { provide: SelectionService, useValue: { handleSelection: () => {} } },
      ],
    }).compileComponents();

    log = TestBed.inject(MessageLogService);
    zone = TestBed.inject(NgZone);
    fixture = TestBed.createComponent(ProcessHostStub);
    // `autoDetectChanges`, as in `graph.component.spec.ts`: Angular ticks on
    // zone activity, the way the browser does, rather than being handed the
    // pass production never makes.
    fixture.autoDetectChanges();
  });

  it('with no agents yet, the pane says so', async () => {
    await quiesce();
    expect(overlay()).not.toBeNull();
  });

  it('REMOVES the overlay when the team arrives on a quiet view', async () => {
    await quiesce();
    agentsArrive();
    await settle();

    // The data got through and the chart is drawing it. `nodes$` is NOT
    // emitting empty — reading the overlay as evidence that it was is what sent
    // the earlier investigations into the fold.
    expect(graph().nodes.length)
      .withContext('the fold delivered all three agents to the component')
      .toBe(3);
    expect(drawnNodeCount())
      .withContext('the chart underneath the overlay is fully drawn')
      .toBe(3);

    expect(overlay())
      .withContext('"No agents available" must not sit on top of a drawn graph')
      .toBeNull();
  });

  it('CONTROL — the same data renders correctly once the view is allowed to check', async () => {
    await quiesce();
    agentsArrive();
    await settle();

    // Nothing about the DATA changes here — only permission to re-render. This
    // is what the component is missing: the subscription updates `nodes` and
    // never tells Angular, so no ancestor is ever marked dirty. The overlay
    // clearing on a `markForCheck()` alone is what identifies the defect as
    // change-detection reachability rather than an empty stream, and is why
    // wrapping the update in `zone.run` could not fix it — a tick is exactly
    // what gets skipped.
    fixture.debugElement
      .query(By.directive(GraphComponent))
      .injector.get(ChangeDetectorRef)
      .markForCheck();
    fixture.detectChanges();

    expect(overlay()).toBeNull();
  });
});
