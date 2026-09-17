import { Component, NgZone } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { BehaviorSubject } from 'rxjs';
import { Dropdown } from 'primeng/dropdown';

import { MemberContextComponent } from './member-context.component';
import { Akgent, AkgentService } from '../../../services/akgent.service';
import { GraphDataService } from '../../../services/process/selectors/graph.selector';
import { IngestionService } from '../../../services/process/event/ingestion.service';
import { provideTranslateTesting } from '../../../../../testing/i18n-testing';

/**
 * THE MEMBER PANE, READ OFF THE CONTROL THE USER OPERATES.
 *
 * The specs next door assert the component's OWN fields — `grouped`,
 * `agentsByCategory[0].label`, the items array. Every one of them can be true
 * while the picker on screen lists a single blank row, because what PrimeNG
 * draws is not `agentsByCategory` but `agentsByCategory` INTERPRETED through
 * `[group]`: `getAllVisibleAndNonVisibleOptions()` flattens the array only when
 * `group` is true and otherwise returns it verbatim. Hand it the grouped shape
 * with `group="false"` and the WRAPPER objects become the options.
 *
 * So these read `Dropdown.visibleOptions()` and `Dropdown.label()` — the two
 * computed signals that decide what is in the list and what the closed control
 * says — rather than the fields that feed them.
 */
function member(id: string, category: number): Record<string, unknown> {
  return {
    name: id,
    actorName: '@' + id,
    agent_id: id,
    role: 'Worker',
    category,
  };
}

describe('MemberContextComponent — what the agent picker actually lists', () => {
  let fixture: ComponentFixture<MemberContextComponent>;
  let component: MemberContextComponent;
  let nodes$: BehaviorSubject<unknown[]>;
  let categories$: BehaviorSubject<unknown[]>;
  let selectedAkgent$: BehaviorSubject<Akgent | null>;

  beforeEach(() => {
    nodes$ = new BehaviorSubject<unknown[]>([]);
    categories$ = new BehaviorSubject<unknown[]>([]);
    selectedAkgent$ = new BehaviorSubject<Akgent | null>(null);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [MemberContextComponent],
      providers: [
        provideTranslateTesting(),
        {
          provide: AkgentService,
          useValue: {
            selectedAkgent$,
            select: jasmine.createSpy('select'),
            unselect: jasmine.createSpy('unselect'),
          },
        },
        { provide: GraphDataService, useValue: { nodes$, categories$ } },
        {
          provide: IngestionService,
          useValue: {
            context: { forAgent: () => new BehaviorSubject<unknown>([]) },
            state: { forAgent: () => new BehaviorSubject<unknown>(null) },
          },
        },
      ],
    });

    fixture = TestBed.createComponent(MemberContextComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  /** The live PrimeNG control, not a stand-in. */
  function dropdown(): Dropdown {
    return fixture.debugElement.query(By.directive(Dropdown))
      .componentInstance as Dropdown;
  }

  function listedLabels(): unknown[] {
    return dropdown()
      .visibleOptions()
      .map((o: unknown) => (o as { label?: unknown })?.label);
  }

  it('lists the members of a single-squad team, not one blank row', () => {
    categories$.next([{ name: 'Team 0' }]);
    nodes$.next([member('a', 0), member('b', 0)]);
    fixture.detectChanges();

    expect(listedLabels())
      .withContext('the picker must offer the team members')
      .toEqual(['@a', '@b']);
  });

  it('lists the members of an unsquadded team, not one blank row', () => {
    // No categories at all — the other branch onto the ungrouped shape.
    categories$.next([]);
    nodes$.next([member('a', 0)]);
    fixture.detectChanges();

    expect(listedLabels()).toEqual(['@a']);
  });

  it('still names the selected member on the closed control', async () => {
    categories$.next([{ name: 'Team 0' }]);
    nodes$.next([member('a', 0), member('b', 0)]);
    fixture.detectChanges();
    // `ngModel` propagates its value to the control over a microtask, so the
    // dropdown's own `modelValue()` is one turn behind the field.
    await fixture.whenStable();
    fixture.detectChanges();

    // `label()` resolves the model against the SAME option list. An option list
    // holding group wrappers cannot match the picked member, so the control
    // falls back to its placeholder while an agent is in fact selected.
    expect(component.selectedAgent?.label).toBe('@a');
    expect(dropdown().label()).toBe('@a');
  });

  it('keeps the squad headers when there is more than one squad', () => {
    categories$.next([{ name: 'Research' }, { name: 'Delivery' }]);
    nodes$.next([member('a', 0), member('b', 1)]);
    fixture.detectChanges();

    // Grouped: PrimeNG flattens to header-then-children, and a header carries
    // no `label` of its own in the flattened shape (it is `{optionGroup, ...}`),
    // so assert on the member labels that survive the flattening.
    expect(listedLabels()).toContain('@a');
    expect(listedLabels()).toContain('@b');
    expect(dropdown().group).toBeTrue();
  });

  it('selecting a listed member selects it rather than unselecting', () => {
    categories$.next([{ name: 'Team 0' }]);
    nodes$.next([member('a', 0), member('b', 0)]);
    fixture.detectChanges();

    const akgent = TestBed.inject(AkgentService) as unknown as {
      select: jasmine.Spy;
      unselect: jasmine.Spy;
    };
    akgent.select.calls.reset();
    akgent.unselect.calls.reset();

    // Exactly what the overlay hands back: one entry of the bound options.
    const picked = dropdown().visibleOptions()[1];
    component.onAgentSelect({ value: picked as never });

    expect(akgent.unselect)
      .withContext('picking a member must not clear the selection')
      .not.toHaveBeenCalled();
    expect(akgent.select).toHaveBeenCalledWith('b', '@b');
  });
});

/**
 * THE MEMBER PANE NEEDS ITS OWN TICK.
 *
 * `TeamGraphComponent` was repaired for this exact defect — a subscriber that
 * mutates plain fields on a websocket emission, i.e. OUTSIDE the Angular zone,
 * under a template gate (`@if`) that only re-evaluates on a change-detection
 * pass. This pane reads the same two streams and gates on
 * `agentsByCategory.length > 0`.
 *
 * It renders today only because `<app-team-tabs>` happens to be mounted beside
 * it in `process.component.html` and its `zone.run` produces a pass that
 * incidentally re-checks this view. Nothing declares that dependency; hiding or
 * unmounting the hierarchy panel — which W18's per-deployment tab filtering
 * makes a one-line change — brings the user's original bug back here. So the
 * host below mounts this pane ALONE.
 */
@Component({
  standalone: true,
  imports: [MemberContextComponent],
  template: `<app-member-context></app-member-context>`,
})
class MemberPanelHostComponent {}

describe('The member pane, mounted without the hierarchy pane beside it', () => {
  let fixture: ComponentFixture<MemberPanelHostComponent>;
  let nodes$: BehaviorSubject<unknown[]>;
  let categories$: BehaviorSubject<unknown[]>;

  beforeEach(async () => {
    nodes$ = new BehaviorSubject<unknown[]>([]);
    categories$ = new BehaviorSubject<unknown[]>([]);

    await TestBed.configureTestingModule({
      imports: [MemberPanelHostComponent],
      providers: [
        provideTranslateTesting(),
        {
          provide: AkgentService,
          useValue: {
            selectedAkgent$: new BehaviorSubject<Akgent | null>(null),
            select: jasmine.createSpy('select'),
            unselect: jasmine.createSpy('unselect'),
          },
        },
        { provide: GraphDataService, useValue: { nodes$, categories$ } },
        {
          provide: IngestionService,
          useValue: {
            context: { forAgent: () => new BehaviorSubject<unknown>([]) },
            state: { forAgent: () => new BehaviorSubject<unknown>(null) },
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(MemberPanelHostComponent);
    // Ticks come from ZONE ACTIVITY, as in the browser. A manual
    // `detectChanges()` per emission would hand the pane by hand the pass that
    // production does not give it.
    fixture.autoDetectChanges();
  });

  function panel(): HTMLElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector('.agent-panel');
  }

  it('says there are no agents while there are none', () => {
    expect(panel()).toBeNull();
  });

  it('STOPS saying "No agents available" once the roster arrives off the socket', () => {
    const zone = TestBed.inject(NgZone);
    zone.runOutsideAngular(() => {
      categories$.next([{ name: 'Team 0' }]);
      nodes$.next([member('a', 0), member('b', 0)]);
    });

    const component = fixture.debugElement.query(
      (de) => de.componentInstance instanceof MemberContextComponent,
    ).componentInstance as MemberContextComponent;

    // The stream is fine — this is not an empty feed.
    expect(component.agentsByCategory.length)
      .withContext('the roster reached the component')
      .toBeGreaterThan(0);

    expect(panel())
      .withContext('the member list must not stay hidden behind the empty state')
      .not.toBeNull();
  });
});
