import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { TeamTabsComponent } from './team-tabs.component';
import { ApiService } from '../../../platform/http/api.service';
import { AkgentService } from '../../../services/akgent.service';
import { CategoryService } from '../../../services/category.service';
import { GraphDataService } from '../../../services/process/selectors/graph.selector';
import { SelectionService } from '../../../services/process/ui-state/selection.service';
import { NodeInterface } from '../../../services/process/models/types';
import { provideTranslateTesting } from '../../../../../testing/i18n-testing';

/**
 * W6 — the hierarchy tab shows the graph and nothing else.
 *
 * This is a user-reported defect, not a refactor, so the assertions are written
 * against what the user can SEE: no inner tab strip, no second copy of the
 * roster, and the graph still there. They are deliberately negative where the
 * complaint was negative — "the list view should be gone" is not satisfied by a
 * list view that merely starts unselected.
 *
 * `<app-team-graph>` is rendered for real rather than stubbed. A schema-ignoring
 * harness would let this suite keep passing if the element were renamed or
 * dropped, which is the one thing it exists to catch.
 */
describe('TeamTabsComponent (W6)', () => {
  let fixture: ComponentFixture<TeamTabsComponent>;
  let nodes$: BehaviorSubject<NodeInterface[]>;

  beforeEach(async () => {
    nodes$ = new BehaviorSubject<NodeInterface[]>([]);

    await TestBed.configureTestingModule({
      imports: [TeamTabsComponent],
      providers: [
        // `<app-pending-request>`, reached through the graph, translates its copy.
        provideTranslateTesting(),
        {
          provide: GraphDataService,
          useValue: {
            nodes$,
            edges$: new BehaviorSubject<unknown[]>([]),
            categories$: new BehaviorSubject<unknown[]>([]),
            categoryService: { COLORS: ['#fff', '#000'] },
            set isLoading(_v: boolean) {
              /* irrelevant here */
            },
          },
        },
        {
          provide: SelectionService,
          useValue: {
            handleSelection: jasmine.createSpy('handleSelection'),
            userRequest$: new BehaviorSubject<unknown>({}),
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

    fixture = TestBed.createComponent(TeamTabsComponent);
    fixture.detectChanges();
  });

  function host(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('renders the graph', () => {
    expect(host().querySelector('app-team-graph')).not.toBeNull();
  });

  it('renders NO list view — the element is gone, not merely unselected', () => {
    // The complaint was "the list view should be gone". A `<p-tabpanel>` whose
    // tab happens not to be active still renders, still holds a second copy of
    // the roster, and is still one click from being back on screen.
    expect(host().querySelector('app-tree')).toBeNull();
  });

  it('leaves no inner tab strip behind', () => {
    // A two-entry strip reduced to one entry is worse than no strip: a control
    // with a single choice reads as broken rather than as absent.
    expect(host().querySelector('p-tabs')).toBeNull();
    expect(host().querySelector('p-tablist')).toBeNull();
    expect(host().querySelector('p-tab')).toBeNull();
    expect(host().querySelector('.p-tablist')).toBeNull();
  });

  it('has the graph as its only child, so nothing else can creep into the pane', () => {
    // Stated structurally rather than as three more absences: the panel IS the
    // graph, and anything at all beside it contradicts that.
    const children = Array.from(host().children).map((c) =>
      c.tagName.toLowerCase(),
    );
    expect(children).toEqual(['app-team-graph']);
  });

  it('keeps the human-request affordance, which the tree also carried', () => {
    // The tree and the graph both rendered `<app-pending-request>`; removing the
    // tree must not have taken the surviving copy with it, or answering an
    // agent's request from this pane would have become impossible.
    expect(host().querySelector('app-pending-request')).not.toBeNull();
  });

  it('passes its height down instead of letting the canvas measure the window', () => {
    // The chain fails silently — a broken link gives echarts a zero-height box
    // that it measures once and never re-measures. Asserted on the rendered
    // style so it holds however the rule is written.
    const style = getComputedStyle(host());
    expect(style.display).toBe('flex');
    expect(style.minHeight).toBe('0px');
  });
});
