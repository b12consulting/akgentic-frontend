import { Component, DoCheck, NgZone } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { TeamTabsComponent } from './team-tabs.component';
import { GraphComponent } from './graph/graph.component';
import { ApiService } from '../../../../core/http/api.service';
import { AkgentService } from '../../../../core/ui/akgent.service';
import { CategoryService } from '../../../../core/ui/category.service';
import { GraphDataService } from '../../../../features/process/selectors/graph.selector';
import { SelectionService } from '../../../../features/process/ui-state/selection.service';
import { NodeInterface } from '../../../../features/process/models/types';
import { provideTranslateTesting } from '../../../../../testing/i18n-testing';

/**
 * "No agents available" PRINTED OVER A FULLY DRAWN GRAPH.
 *
 * `graph.component.spec.ts` already pins the overlay's behaviour, and it passes
 * — because it mounts `<app-graph>` as the FIXTURE ROOT. A fixture root is
 * checked on every tick whatever its strategy, so that harness cannot see the
 * one thing standing between the graph feed and the overlay in production:
 * `TeamTabsComponent` sits between them, is `OnPush`, and has a template with
 * NO bindings, NO inputs and NO async pipe. Nothing can ever mark it dirty
 * again after its first check, so Angular skips it — and with it the whole
 * `<app-graph>` subtree — on every subsequent pass.
 *
 * The canvas keeps updating regardless, because `updateChart()` hands echarts a
 * new option object imperatively and never asks Angular for anything. So the
 * data arrives, the agents are drawn, and `@if (nodes.length === 0)` is left
 * frozen on the value it had at first check: true.
 *
 * The host below is what production looks like — `process.component.html`
 * projects `<app-team-tabs>` from a Default-CD component — and is the whole
 * difference from the passing spec next door.
 */
@Component({
  standalone: true,
  imports: [TeamTabsComponent],
  template: `<app-team-tabs></app-team-tabs>`,
})
class HierarchyPanelHostComponent implements DoCheck {
  /** How many change-detection passes have reached THIS view. It is what
   *  separates "no pass ran" (the zone hypothesis, already tried and already
   *  ruled out) from "a pass ran and was turned away at the OnPush wrapper" —
   *  the two leave an identical stale overlay on screen.
   *
   *  Counted in `ngDoCheck` rather than from a template expression: a getter
   *  that mutates on read trips `checkNoChanges` in dev mode, which is a
   *  failure about the probe rather than about the pane. */
  passes = 0;
  ngDoCheck(): void {
    this.passes++;
  }
}

describe('The hierarchy pane, mounted the way production mounts it', () => {
  let fixture: ComponentFixture<HierarchyPanelHostComponent>;
  let nodes$: BehaviorSubject<NodeInterface[]>;

  function node(name: string): NodeInterface {
    return {
      name,
      role: 'Agent',
      actorName: name,
      parentId: '',
      squadId: 's1',
      userMessage: false,
      symbol: 'roundRect',
      category: 0,
    } as NodeInterface;
  }

  /** One macrotask. echarts schedules animation work, so this fixture never
   *  reports stable and `whenStable()` would simply time out. */
  function settle(): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  function overlay(): HTMLElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector('.graph-empty');
  }

  beforeEach(async () => {
    nodes$ = new BehaviorSubject<NodeInterface[]>([]);

    await TestBed.configureTestingModule({
      imports: [HierarchyPanelHostComponent],
      providers: [
        provideTranslateTesting(),
        {
          provide: GraphDataService,
          useValue: {
            nodes$,
            edges$: new BehaviorSubject<unknown[]>([]),
            categories$: new BehaviorSubject<unknown[]>([]),
            categoryService: { COLORS: ['#fff', '#000'] },
          },
        },
        {
          provide: SelectionService,
          useValue: {
            handleSelection: jasmine.createSpy('handleSelection'),
            userRequest$: new BehaviorSubject<unknown>(null),
            modalVisible$: new BehaviorSubject<boolean>(false),
            onSave: jasmine.createSpy('onSave'),
          },
        },
        { provide: ApiService, useValue: {} },
        {
          provide: AkgentService,
          useValue: {
            selectedAkgent$: new BehaviorSubject<unknown>(null),
            select: jasmine.createSpy('select'),
          },
        },
        {
          provide: CategoryService,
          useValue: {
            COLORS: ['#fff', '#000'],
            setSelectedCategory: jasmine.createSpy('setSelectedCategory'),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(HierarchyPanelHostComponent);
    // Angular ticks on ZONE ACTIVITY, as the browser does. A manual
    // `detectChanges()` per emission would supply by hand the pass production
    // is missing, and the defect would pass the test.
    fixture.autoDetectChanges();
  });

  it('says the graph is empty while it is empty', () => {
    expect(overlay()).not.toBeNull();
  });

  it('STOPS saying "No agents available" once the agents are on the canvas', async () => {
    const zone = TestBed.inject(NgZone);
    // Let the pane finish starting up FIRST. echarts' own init fires
    // `(chartInit)`, a template listener, and firing a template listener marks
    // its view and every ancestor dirty — so an emission racing the startup
    // borrows a change-detection pass it would never get in production, where
    // the first agent lands long after the canvas exists.
    await settle();
    await settle();
    await settle();

    const passesBefore = fixture.componentInstance.passes;
    zone.runOutsideAngular(() => {
      nodes$.next([node('@Generalist'), node('@Quant')]);
    });
    await settle();

    // The data DID arrive — this is not an empty stream. Everything the pane
    // draws imperatively is already correct; only the template is stale.
    const graph = fixture.debugElement
      .query((de) => de.componentInstance instanceof GraphComponent)
      .componentInstance as GraphComponent;
    expect(graph.nodes.length)
      .withContext('the graph feed reached the component')
      .toBe(2);

    // And a change-detection pass DID run for the emission: the host above the
    // OnPush wrapper was re-checked. So the overlay below is not stale for want
    // of a tick — the tick happened and stopped one component short.
    expect(fixture.componentInstance.passes)
      .withContext('a change-detection pass ran after the agents arrived')
      .toBeGreaterThan(passesBefore);

    expect(overlay())
      .withContext('"No agents available" must not sit on top of a drawn graph')
      .toBeNull();
  });
});
