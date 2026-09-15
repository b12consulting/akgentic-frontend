import { NgZone } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { GraphComponent } from './graph.component';
import { AkgentService } from '../../../../core/ui/akgent.service';
import { ApiService } from '../../../../core/http/api.service';
import { CategoryService } from '../../../../core/ui/category.service';
import { GraphDataService } from '../../../../services/process/selectors/graph.selector';
import { SelectionService } from '../../../../services/process/ui-state/selection.service';
import { provideTranslateTesting } from '../../../../../testing/i18n-testing';

/**
 * The hierarchy pane's EMPTY-STATE OVERLAY, which had no spec at all.
 *
 * The overlay was added when this pane became the whole hierarchy tab, and it
 * shipped broken in a way no existing test could see: the chart is driven
 * imperatively (echarts is handed a new option object), so nothing in the
 * template depended on `nodes` and a missed change-detection pass had no
 * visible consequence. `@if (nodes.length === 0)` is an ordinary binding and
 * does, and the data arrives on the websocket feed OUTSIDE the Angular zone —
 * so the overlay rendered once against the initial empty array and never
 * re-evaluated. The canvas filled with agents and "No agents available" sat on
 * top of them permanently.
 *
 * The test that catches that is specifically "emit, THEN assert the overlay is
 * gone" — asserting only the empty case passes against the bug.
 */
describe('GraphComponent — the empty-state overlay', () => {
  let fixture: ComponentFixture<GraphComponent>;
  let nodes$: BehaviorSubject<any[]>;
  let edges$: BehaviorSubject<any[]>;
  let categories$: BehaviorSubject<any[]>;

  function node(name: string): any {
    return { id: name, name, actorName: name, category: 0, value: 1 };
  }

  /**
   * One macrotask. NOT `fixture.whenStable()`: echarts schedules its own
   * animation work, so this fixture never reports stable and `whenStable`
   * simply times out. What the assertion needs is only for the zone to have
   * drained the turn in which the emission landed.
   */
  function settle(): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  function overlay(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.graph-empty');
  }

  beforeEach(async () => {
    nodes$ = new BehaviorSubject<any[]>([]);
    edges$ = new BehaviorSubject<any[]>([]);
    categories$ = new BehaviorSubject<any[]>([]);

    await TestBed.configureTestingModule({
      imports: [GraphComponent],
      providers: [
        provideTranslateTesting(),
        { provide: GraphDataService, useValue: { nodes$, edges$, categories$ } },
        { provide: ApiService, useValue: {} },
        { provide: AkgentService, useValue: {} },
        {
          //  is part of this service's shape and the graph reads it to
          // colour a node per agent. A stub that omitted it crashed the pane the
          // moment nodes arrived — the stub was lying about the contract, not the
          // caller being unsafe.
          provide: CategoryService,
          useValue: { setSelectedCategory: () => {}, COLORS: ['#101010', '#202020'] },
        },
        { provide: SelectionService, useValue: { handleSelection: () => {} } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(GraphComponent);
    // autoDetectChanges, NOT detectChanges. A manual `fixture.detectChanges()`
    // after each emission supplies exactly the change-detection pass that
    // production is missing, so the bug this file exists for passes such a
    // test. Here Angular ticks on ZONE ACTIVITY, as the browser does, and the
    // emissions below are deliberately made outside the zone.
    fixture.autoDetectChanges();
  });

  it('tells the user the graph is empty rather than showing a blank canvas', () => {
    expect(overlay()).not.toBeNull();
  });

  it('REMOVES the overlay when agents arrive FROM OUTSIDE THE ANGULAR ZONE', async () => {
    // This is the regression, reproduced at its real origin. The graph feed is
    // the websocket, which delivers outside the zone; the component must bring
    // the update back in or the template never re-evaluates and the overlay
    // stays on top of a fully drawn graph. Emitting inside the zone here would
    // test nothing — it passes with the defect in place.
    const zone = TestBed.inject(NgZone);
    zone.runOutsideAngular(() => {
      nodes$.next([node('@Generalist'), node('@Quant')]);
    });
    await settle();

    expect(fixture.componentInstance.nodes.length).toBe(2);
    expect(overlay())
      .withContext('"No agents available" must not sit on top of a drawn graph')
      .toBeNull();
  });

  it('brings the overlay back if the graph empties again', async () => {
    const zone = TestBed.inject(NgZone);
    zone.runOutsideAngular(() => nodes$.next([node('@Generalist')]));
    await settle();
    expect(overlay()).toBeNull();

    zone.runOutsideAngular(() => nodes$.next([]));
    await settle();
    expect(overlay()).not.toBeNull();
  });
});
