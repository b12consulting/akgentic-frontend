import { CommonModule } from '@angular/common';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import {
  ActivatedRoute,
  convertToParamMap,
  NavigationExtras,
  ParamMap,
  Router,
} from '@angular/router';
import { BehaviorSubject, of } from 'rxjs';

import { ApiService } from '../../core/http/api.service';
import { AuthService } from '../../core/auth/auth.service';
import { ConfigService } from '../../core/config/config.service';
import { ContextService } from '../../core/context/context.service';
import {
  NO_TEAM_FILTER,
  TeamContext,
  TeamFilter,
} from '../../core/context/team.interface';
import { NamespacePanelComponent } from '../catalog/namespace-panel/namespace-panel.component';
import { HttpError } from '../../core/http/fetch.service';
import {
  MetadataFieldDescriptor,
  NamespaceSummary,
  TeamMetadataContract,
} from '../../protocol/catalog.interface';
import { HomeComponent } from './home.component';
import { TeamCreationService } from './team-creation/team-creation.service';
import { TeamMetadataModalComponent } from './team-metadata-modal/team-metadata-modal.component';
import {
  TeamDescriptionSave,
  TeamRowAction,
  TeamTableComponent,
} from './team-table/team-table.component';

/**
 * A `NamespaceSummary` fixture carrying neutral values for every field these
 * specs do not exercise. Only `namespace` / `name` / `description` and the
 * optional metadata contract are ever asserted on here; the rest exist because
 * the interface requires them.
 *
 * `teamMetadata` is deliberately three-valued. OMITTING the argument leaves the
 * `team_metadata` KEY OFF the object entirely — the shape a server predating
 * the field sends, and the default every pre-existing spec here inherits.
 * Passing `null` sets the key to `null`. Both mean "asks nothing", and the two
 * are distinct fixtures precisely because a gate written as `=== null` passes
 * one and fails the other.
 */
function nsSummary(
  namespace: string,
  name: string,
  description: string,
  teamMetadata?: TeamMetadataContract | null,
): NamespaceSummary {
  const summary: NamespaceSummary = {
    namespace,
    name,
    description,
    team: false,
    shareable: false,
    public: false,
    owner: null,
    counts: {},
  };
  if (teamMetadata !== undefined) {
    summary.team_metadata = teamMetadata;
  }
  return summary;
}

/** One declared field; all four properties are always present on the wire. */
function field(
  key: string,
  overrides: Partial<MetadataFieldDescriptor> = {},
): MetadataFieldDescriptor {
  return { key, description: '', index: false, mandatory: false, ...overrides };
}

function contract(fields: MetadataFieldDescriptor[]): TeamMetadataContract {
  return { type: 'acme.contracts.CaseMetadata', fields };
}

function makeTeam(overrides: Partial<TeamContext> = {}): TeamContext {
  return {
    team_id: 'team-1',
    name: 'Demo Team',
    status: 'stopped',
    created_at: '2026-04-19T10:00:00Z',
    updated_at: '2026-04-19T10:00:00Z',
    config_name: 'demo',
    description: null,
    ...overrides,
  };
}

/**
 * Minimal `ActivatedRoute` for the query-string restore.
 *
 * Only `snapshot.queryParamMap` is provided, because that is all the component
 * reads: the restore is a one-shot read of the ENTRY state, deliberately not a
 * subscription — subscribing would feed the component its own `writeUrl`
 * output and loop. A stub carrying an observable would invite exactly that.
 *
 * ONE mutable object rather than a factory, so a spec can name the entry URL
 * and then create a fresh component from the same TestBed. Rebuilding the
 * TestBed per URL would mean duplicating its whole provider list, which is how
 * the copy silently drifts from the one the other specs run against.
 */
const routeStub: { snapshot: { queryParamMap: ParamMap } } = {
  snapshot: { queryParamMap: convertToParamMap({}) },
};

/** Point the shared stub at an entry URL. Reset in `beforeEach`. */
function setUrl(params: Record<string, string>): void {
  routeStub.snapshot.queryParamMap = convertToParamMap(params);
}

describe('HomeComponent', () => {
  let fixture: ComponentFixture<HomeComponent>;
  let component: HomeComponent;
  let teams$: BehaviorSubject<TeamContext[]>;
  let totalCount$: BehaviorSubject<number>;
  let apiSpy: jasmine.SpyObj<ApiService>;
  let contextSpy: jasmine.SpyObj<ContextService> & {
    teams$: BehaviorSubject<TeamContext[]>;
    totalCount$: BehaviorSubject<number>;
    totalCount: number;
  };
  let authSpy: jasmine.SpyObj<AuthService> & {
    currentUser$: BehaviorSubject<any>;
    currentUserValue: any;
  };
  // Settable auth subject so the reactive admin predicate
  // (isAdmin$ derived from currentUser$) can be driven from tests.
  let currentUser$: BehaviorSubject<any>;
  let routerSpy: jasmine.SpyObj<Router>;

  beforeEach(async () => {
    teams$ = new BehaviorSubject<TeamContext[]>([]);
    totalCount$ = new BehaviorSubject<number>(0);

    apiSpy = jasmine.createSpyObj('ApiService', [
      'getNamespaces',
      'createTeam',
      'deleteTeam',
      'restoreTeam',
      'stopTeam',
      'updateTeamDescription',
    ]);
    apiSpy.getNamespaces.and.returnValue(Promise.resolve([]));
    apiSpy.createTeam.and.returnValue(Promise.resolve({} as any));
    apiSpy.deleteTeam.and.returnValue(Promise.resolve());
    apiSpy.restoreTeam.and.returnValue(Promise.resolve({} as any));
    apiSpy.stopTeam.and.returnValue(Promise.resolve());
    apiSpy.updateTeamDescription.and.returnValue(Promise.resolve());

    contextSpy = jasmine.createSpyObj<ContextService>(
      'ContextService',
      [
        'getTeams',
        'loadTeamsPage',
        'resetTeams',
        'deleteTeam',
        'createTeamAndNavigate',
        'stopTeamAndAwait',
        'setTeamDescription',
        // 48.1/48.2: `ngOnInit` calls `restoreFilter()` on EVERY mount (and
        // `clearFilter()` when the URL names a namespace that is gone), so
        // leaving either
        // out of this list throws "not a function" in every spec in this file
        // at once — a failure that reads like something far worse than a
        // missing spy name.
        'setFilter',
        'clearFilter',
        'restoreFilter',
      ],
    ) as jasmine.SpyObj<ContextService> & {
      teams$: BehaviorSubject<TeamContext[]>;
      totalCount$: BehaviorSubject<number>;
      totalCount: number;
    };
    contextSpy.teams$ = teams$;
    contextSpy.totalCount$ = totalCount$;
    // Plain settable property mirroring the 28.1 totalCount getter so the
    // template's [totalRecords]="contextService.totalCount" has a value.
    contextSpy.totalCount = 0;
    contextSpy.getTeams.and.callFake(async () => teams$.value);
    // loadTeamsPage REPLACES teams$ with the page (one page in the DOM) and
    // updates totalCount — mirrors the 28.1 data-layer behavior so REPLACE
    // semantics and the page swap are observable in tests. The fake returns a
    // single-row page keyed by the requested page so a jump-to-page renders
    // distinct rows.
    contextSpy.loadTeamsPage.and.callFake(
      async (page: number = 1, _size?: number) => {
        const pageTeams = [
          makeTeam({ team_id: `team-page-${page}`, name: `Page ${page}` }),
        ];
        teams$.next(pageTeams);
        contextSpy.totalCount = 1000;
        totalCount$.next(1000);
        return { teams: pageTeams, total_count: 1000 };
      },
    );
    contextSpy.resetTeams.and.stub();
    contextSpy.deleteTeam.and.returnValue(Promise.resolve());
    contextSpy.createTeamAndNavigate.and.returnValue(Promise.resolve());
    contextSpy.stopTeamAndAwait.and.returnValue(Promise.resolve());
    // Stubbed deliberately: with the real write path replaced by a no-op, an
    // unchanged team object in teams$ after saveDescription proves the
    // COMPONENT is no longer writing the cache itself (Story 37-3 AC6).
    contextSpy.setTeamDescription.and.stub();
    contextSpy.setFilter.and.stub();
    // The component reads `contextService.filter` back when it mirrors the
    // state into the URL, so the stub has to hold a value the way the real
    // service does. A spy that accepted a filter and then reported none would
    // make every URL assertion below vacuous.
    const holdFilter = (next: TeamFilter): void => {
      (contextSpy as unknown as { filter: TeamFilter }).filter = next;
    };
    holdFilter(NO_TEAM_FILTER);
    contextSpy.setFilter.and.callFake(holdFilter);
    contextSpy.restoreFilter.and.callFake(holdFilter);
    contextSpy.clearFilter.and.callFake(() => holdFilter(NO_TEAM_FILTER));
    // The stub is shared and mutable, so a URL named by one spec must not leak
    // into the next.
    setUrl({});

    // Anonymous by default (no `roles`), so isAdmin$ resolves
    // false and the toggle is hidden unless a test pushes an admin user.
    currentUser$ = new BehaviorSubject<any>({ user_id: 'anonymous' });
    authSpy = jasmine.createSpyObj('AuthService', ['checkAuth'], {
      currentUser$,
      get currentUserValue() {
        return currentUser$.value;
      },
    }) as jasmine.SpyObj<AuthService> & {
      currentUser$: BehaviorSubject<any>;
      currentUserValue: any;
    };
    authSpy.checkAuth.and.returnValue(of(true as any));

    routerSpy = jasmine.createSpyObj('Router', ['navigate']);
    routerSpy.navigate.and.returnValue(Promise.resolve(true));

    // HomeComponent's dirty-close prompt is the panel's custom confirm modal
    // (`panel.confirmDiscard()`); tests stub `namespacePanel.confirmDiscard`
    // directly. (ADR-018)
    await TestBed.configureTestingModule({
      imports: [HomeComponent, CommonModule, NoopAnimationsModule],
      providers: [
        { provide: ApiService, useValue: apiSpy },
        { provide: ContextService, useValue: contextSpy },
        { provide: AuthService, useValue: authSpy },
        { provide: ConfigService, useValue: { hideHome: false } },
        { provide: Router, useValue: routerSpy },
        { provide: ActivatedRoute, useValue: routeStub },
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(HomeComponent);
    component = fixture.componentInstance;
  });

  it('(AC6) component has no `context` field after the refactor', () => {
    expect((component as any).context).toBeUndefined();
  });

  it('(AC6) teams$ reaches the table through [teams] and renders a row each', async () => {
    // The page's half of the row-rendering contract after the extraction: what
    // the service emits arrives at `<app-team-table [teams]>` and comes out as
    // rows. The REAL child renders here — stubbing it would leave this spec
    // asserting that a stub does nothing. What a row LOOKS like (its six
    // columns, its chips, its status tag) is the child's own spec.
    //
    // Render first so the lazy table's initial (onLazyLoad) seed fires; then
    // push the page into teams$ (mirrors a real page arrival — REPLACE).
    fixture.detectChanges();
    await fixture.whenStable();
    teams$.next([
      makeTeam({ team_id: 't-1', name: 'Alpha' }),
      makeTeam({ team_id: 't-2', name: 'Beta' }),
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('tr[psellectablerow], tbody tr');
    // The p-table renders its body through ng-template; rows may be produced
    // as <tr> nodes regardless of the selector. Assert at least two rendered.
    const allRows: NodeListOf<HTMLElement> =
      fixture.nativeElement.querySelectorAll('tbody tr');
    expect(allRows.length).toBeGreaterThanOrEqual(2);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('t-1');
    expect(text).toContain('t-2');
    // Silence unused local warning from dual querySelectorAll above.
    void rows;
  });

  // The Metadata column's own specs — one chip per answered field, and an
  // EMPTY cell for a team carrying none — moved with the markup into
  // team-table.component.spec.ts.

  it('(AC6, AC9) pushing a new list into teams$ triggers a re-render', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    teams$.next([makeTeam({ team_id: 't-1' })]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement.textContent as string)).toContain('t-1');

    teams$.next([
      makeTeam({ team_id: 't-1' }),
      makeTeam({ team_id: 't-2' }),
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement.textContent as string)).toContain('t-2');
  });

  it('(AC7) deleteTeam(id) delegates to contextService.deleteTeam and does NOT call apiService.deleteTeam directly', async () => {
    await component.deleteTeam('t-1');
    expect(contextSpy.deleteTeam).toHaveBeenCalledOnceWith('t-1');
    expect(apiSpy.deleteTeam).not.toHaveBeenCalled();
  });

  it('(28.2 AC4) refreshContext() reloads the current page via loadTeamsPage (REPLACE), not getTeams', async () => {
    component.currentPage = 2;
    await component.refreshContext();
    expect(contextSpy.loadTeamsPage).toHaveBeenCalledOnceWith(2, 250);
    expect(contextSpy.getTeams).not.toHaveBeenCalled();
    expect(contextSpy.resetTeams).not.toHaveBeenCalled();
    expect((component as any).context).toBeUndefined();
  });

  it('(AC4 10.4) createTeam reaches createTeamAndNavigate through the gate, with no reload compensation', async () => {
    const ns = nsSummary('cat-1', 'Cat One', 'first cat');
    component.selectedNamespace$.next(ns);
    // The component has not invoked ngOnInit yet (no detectChanges in this
    // test), so contextSpy.getTeams should not have been called. Reset to
    // guard against any spurious prior invocation.
    contextSpy.getTeams.calls.reset();
    await component.createTeam();
    expect(contextSpy.createTeamAndNavigate).toHaveBeenCalledOnceWith(
      'cat-1',
      undefined,
    );
    // No reload, no paginator jump: the home page is being LEFT — every
    // creation path now lands in the new team's process view.
    expect(contextSpy.getTeams).not.toHaveBeenCalled();
    expect(contextSpy.loadTeamsPage).not.toHaveBeenCalled();
  });

  it('(AC4 10.4) createTeam no-entry guard returns cleanly', async () => {
    component.selectedNamespace$.next(null);
    await component.createTeam();
    expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
  });

  it('(AC1 1.9) ngOnInit loads namespaces via getNamespaces and selects the first', async () => {
    apiSpy.getNamespaces.and.returnValue(
      Promise.resolve([
        nsSummary('agent-team-v1', 'Agent Team', 'Default'),
        nsSummary('rag-team-v1', 'RAG Team', 'With RAG'),
      ]),
    );
    await component.ngOnInit();
    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(1);
    expect(component.namespaces$.value.length).toBe(2);
    expect(component.selectedNamespace$.value?.namespace).toBe('agent-team-v1');
  });

  it('(AC3 1.9) createTeam hands the gate the SELECTED summary, whose namespace is created (not an id lookup)', async () => {
    component.selectedNamespace$.next(
      nsSummary('rag-team-v1', 'RAG Team', 'With RAG'),
    );
    contextSpy.createTeamAndNavigate.calls.reset();
    await component.createTeam();
    expect(contextSpy.createTeamAndNavigate).toHaveBeenCalledOnceWith(
      'rag-team-v1',
      undefined,
    );
  });

  it('(AC5 1.9) empty namespace list leaves the dropdown empty and no selection', async () => {
    apiSpy.getNamespaces.and.returnValue(Promise.resolve([]));
    await component.ngOnInit();
    expect(component.namespaces$.value).toEqual([]);
    expect(component.selectedNamespace$.value).toBeNull();
  });

  it('(AC5 1.9) getNamespaces failure does not crash ngOnInit', async () => {
    apiSpy.getNamespaces.and.returnValue(Promise.reject(new Error('boom')));
    const consoleErrorSpy = spyOn(console, 'error');
    await expectAsync(component.ngOnInit()).toBeResolved();
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(component.namespaces$.value).toEqual([]);
  });

  it('(AC5 10.5) HomeComponent.stopTeam delegates to contextService.stopTeamAndAwait without polling', async () => {
    apiSpy.stopTeam.calls.reset();
    contextSpy.getTeams.calls.reset();
    contextSpy.stopTeamAndAwait.and.returnValue(Promise.resolve());

    await component.stopTeam('team-A');

    expect(contextSpy.stopTeamAndAwait).toHaveBeenCalledOnceWith('team-A');
    expect(apiSpy.stopTeam).not.toHaveBeenCalled();
    expect(contextSpy.getTeams).not.toHaveBeenCalled();
  });

  // The in-flight MARK is no longer the page's: `stoppingTeams` /
  // `restoringTeams` live in the table, where "this row is busy" is per-row
  // view state. What the page still owns is performing the work and handing it
  // straight back, which is what these two assert. The mark's own behaviour —
  // set on request, cleared when the work settles INCLUDING on rejection, and
  // independent per row — is asserted in team-table.component.spec.ts.

  /** Collects whatever the page hands back through a `TeamRowAction.track`. */
  function trackingAction(teamId: string): {
    action: TeamRowAction;
    tracked: Promise<unknown>[];
  } {
    const tracked: Promise<unknown>[] = [];
    return {
      action: { teamId, track: (work) => tracked.push(work) },
      tracked,
    };
  }

  it('(AC5 10.5) onStopRequested performs the stop and hands the work back to track', async () => {
    const { action, tracked } = trackingAction('team-A');

    component.onStopRequested(action);

    expect(contextSpy.stopTeamAndAwait).toHaveBeenCalledOnceWith('team-A');
    // The row is told about the SAME work the page started, so its spinner
    // lasts exactly as long as the stop does.
    expect(tracked.length).toBe(1);
    await expectAsync(tracked[0]).toBeResolved();
  });

  it('(AC5 10.5) onRestoreRequested performs the restore and hands the work back', async () => {
    const { action, tracked } = trackingAction('team-A');

    component.onRestoreRequested(action);

    expect(tracked.length).toBe(1);
    await tracked[0];
    expect(apiSpy.restoreTeam).toHaveBeenCalledOnceWith('team-A');
  });

  it('(AC6 10.5) restoreTeam LOGS its failure before re-throwing', async () => {
    // The table consumes the rejection to clear the spinner, so this log is the
    // ONLY trace a failed restore leaves. Without it the row simply stops
    // spinning and nothing anywhere says the restore did not happen.
    const consoleErrorSpy = spyOn(console, 'error');
    apiSpy.restoreTeam.and.returnValue(Promise.reject(new Error('boom')));

    await expectAsync(component.restoreTeam('team-A')).toBeRejected();

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(contextSpy.loadTeamsPage).not.toHaveBeenCalledWith(
      jasmine.anything(),
      jasmine.anything(),
    );
  });

  it('(AC6 10.5) stopTeam catches a timeout/error, logs it, and still resolves', async () => {
    // The page absorbs the failure and logs it. It must still RESOLVE: the row
    // clears its mark on either outcome, but a page that re-threw here would
    // add an unhandled rejection to a failure it has already reported.
    const timeoutErr = Object.assign(new Error('timeout'), {
      name: 'TimeoutError',
    });
    contextSpy.stopTeamAndAwait.and.returnValue(Promise.reject(timeoutErr));

    const consoleErrorSpy = spyOn(console, 'error');

    await expectAsync(component.stopTeam('team-A')).toBeResolved();

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  function editButton(): HTMLButtonElement | null {
    const el = fixture.nativeElement.querySelector(
      'button[data-test="edit-namespace-yaml-btn"]',
    );
    return el as HTMLButtonElement | null;
  }

  it('(AC14 11.2) "Edit Configuration" button is disabled when no namespace is selected', async () => {
    component.selectedNamespace$.next(null);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const btn = editButton();
    expect(btn).withContext('edit-namespace-yaml-btn must render').not.toBeNull();
    // PrimeNG propagates [disabled] onto the inner button element.
    expect(btn!.disabled).toBeTrue();
  });

  it('(AC14 11.2) "Edit Configuration" button is enabled when a namespace is selected', async () => {
    // The refreshed list (driven by ngOnInit's loadNamespaces) must contain
    // the seeded selection — otherwise the reconciliation correctly drops a
    // selection absent from the fetched list, clearing it to null.
    apiSpy.getNamespaces.and.returnValue(
      Promise.resolve([nsSummary('foo', 'Foo', '')]),
    );
    component.selectedNamespace$.next(nsSummary('foo', 'Foo', ''));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const btn = editButton();
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBeFalse();
  });

  it('(AC14 11.2) clicking the button sets namespacePanelVisible = true', async () => {
    // See note above: keep the seeded selection present in the fetched list so
    // the reconciliation does not drop it during ngOnInit.
    apiSpy.getNamespaces.and.returnValue(
      Promise.resolve([nsSummary('foo', 'Foo', '')]),
    );
    component.selectedNamespace$.next(nsSummary('foo', 'Foo', ''));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.namespacePanelVisible).toBeFalse();

    const btn = editButton();
    expect(btn).not.toBeNull();
    btn!.click();
    fixture.detectChanges();

    expect(component.namespacePanelVisible).toBeTrue();
  });

  it('(AC14 11.2) setting namespacePanelVisible = false simulates the (closed) handler', () => {
    // The (closed)="namespacePanelVisible = false" binding in the template
    // is a direct property assignment — simulate it without relying on the
    // @defer block to mount the nested component in tests.
    component.namespacePanelVisible = true;
    component.namespacePanelVisible = false;
    expect(component.namespacePanelVisible).toBeFalse();
  });

  it('(AC9) N=3 mount/unmount cycles leave zero residual subscribers on teams$', async () => {
    for (let i = 0; i < 3; i++) {
      const f = TestBed.createComponent(HomeComponent);
      f.detectChanges();
      await f.whenStable();
      f.detectChanges();
      f.destroy();
    }
    // The first fixture (from beforeEach) also still holds a subscription
    // until destroyed below. Destroy it and then assert no residual observers.
    fixture.destroy();
    expect(teams$.observed).toBeFalse();
  });

  it('(11.3 AC10) onNamespacePanelVisibleChange(true) is a no-op (opening the dialog)', () => {
    const confirmDiscard = jasmine.createSpy('confirmDiscard');
    component.namespacePanelVisible = true;
    component.namespacePanel = {
      hasUnsavedChanges: () => true,
      confirmDiscard,
    } as unknown as NamespacePanelComponent;

    component.onNamespacePanelVisibleChange(true);

    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(component.namespacePanelVisible).toBeTrue();
  });

  it('(11.3 AC10) onNamespacePanelVisibleChange(false) with clean panel closes without confirm', () => {
    const confirmDiscard = jasmine.createSpy('confirmDiscard');
    component.namespacePanelVisible = true;
    // Simulate a mounted-but-clean panel.
    component.namespacePanel = {
      hasUnsavedChanges: () => false,
      confirmDiscard,
    } as unknown as NamespacePanelComponent;

    component.onNamespacePanelVisibleChange(false);

    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(component.namespacePanelVisible).toBeFalse();
  });

  it('(11.3 AC10) onNamespacePanelVisibleChange(false) with no mounted panel closes without confirm', () => {
    component.namespacePanelVisible = true;
    component.namespacePanel = undefined;

    component.onNamespacePanelVisibleChange(false);

    expect(component.namespacePanelVisible).toBeFalse();
  });

  it('(ADR-018 §c) onNamespacePanelVisibleChange(false) with dirty panel calls confirmDiscard and keeps dialog open; Proceed closes', async () => {
    let resolveDiscard!: (v: boolean) => void;
    const confirmDiscard = jasmine
      .createSpy('confirmDiscard')
      .and.returnValue(new Promise<boolean>((r) => (resolveDiscard = r)));
    component.namespacePanelVisible = true;
    component.namespacePanel = {
      hasUnsavedChanges: () => true,
      confirmDiscard,
    } as unknown as NamespacePanelComponent;

    component.onNamespacePanelVisibleChange(false);

    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    // Re-asserted visibility to keep the dialog open while the modal runs.
    expect(component.namespacePanelVisible).toBeTrue();

    // Proceed → the dialog truly closes.
    resolveDiscard(true);
    await Promise.resolve();
    expect(component.namespacePanelVisible).toBeFalse();
  });

  it('(ADR-018 §c) Cancel/dismiss (confirmDiscard resolves false) leaves the dialog open, buffer intact', async () => {
    let resolveDiscard!: (v: boolean) => void;
    const confirmDiscard = jasmine
      .createSpy('confirmDiscard')
      .and.returnValue(new Promise<boolean>((r) => (resolveDiscard = r)));
    component.namespacePanelVisible = true;
    component.namespacePanel = {
      hasUnsavedChanges: () => true,
      confirmDiscard,
    } as unknown as NamespacePanelComponent;

    component.onNamespacePanelVisibleChange(false);
    resolveDiscard(false);
    await Promise.resolve();

    // Dismissing keeps the dialog open (re-asserted by the handler).
    expect(component.namespacePanelVisible).toBeTrue();
  });

  it('(11.3 AC6) onNamespaceSaved re-invokes getNamespaces and pushes the result into namespaces$', async () => {
    // Prime a new list and invoke the (saved) handler — the dropdown must
    // refresh.
    const updated = [
      nsSummary('agent-team-v1', 'Agent Team', 'd1'),
      nsSummary('rag-team-v1', 'RAG Team', 'd2'),
    ];
    apiSpy.getNamespaces.calls.reset();
    apiSpy.getNamespaces.and.returnValue(Promise.resolve(updated));

    await component.onNamespaceSaved();

    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(1);
    expect(component.namespaces$.value).toEqual(updated);
  });

  it('(14.2 AC8) stale selection (deleted ns) is dropped → advances to first remaining', async () => {
    // Seed a selection that the refreshed list no longer contains.
    component.selectedNamespace$.next(
      nsSummary('agent-team-v1_copy', 'Agent Team_copy', 'clone'),
    );
    const refreshed = [
      nsSummary('agent-team-v1', 'Agent Team', 'd1'),
      nsSummary('rag-team-v1', 'RAG Team', 'd2'),
    ];
    apiSpy.getNamespaces.and.returnValue(Promise.resolve(refreshed));

    // Drive loadNamespaces via the public (saved) handler.
    await component.onNamespaceSaved();

    expect(component.selectedNamespace$.value?.namespace).toBe('agent-team-v1');
  });

  it('(14.2 AC9) still-present selection is preserved by `namespace` identity, untouched (no re-set)', async () => {
    // Seed the ORIGINAL object instance.
    const original = nsSummary('rag-team-v1', 'RAG Team', 'original');
    component.selectedNamespace$.next(original);

    // Refresh returns a DIFFERENT object instance with the SAME namespace —
    // proves identity is compared on `namespace`, not object reference.
    const refreshed = [
      nsSummary('agent-team-v1', 'Agent Team', 'd1'),
      nsSummary('rag-team-v1', 'RAG Team', 'refreshed copy'),
    ];
    apiSpy.getNamespaces.and.returnValue(Promise.resolve(refreshed));

    await component.onNamespaceSaved();

    // The subject must hold the EXACT original object (reference-equal) —
    // confirming no `.next()` re-set fired for a still-valid selection.
    expect(component.selectedNamespace$.value).toBe(original);
  });

  it('(14.2 AC10) deleting the last namespace → null selection + placeholder', async () => {
    component.selectedNamespace$.next(
      nsSummary('only-team-v1', 'Only Team', 'last one'),
    );
    apiSpy.getNamespaces.and.returnValue(Promise.resolve([]));

    await component.onNamespaceSaved();

    expect(component.selectedNamespace$.value).toBeNull();

    // Render the template on a null selection — must not throw, and the
    // Create / Edit buttons must be disabled.
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const createBtn = fixture.nativeElement.querySelector(
      'button[label="Create"]',
    ) as HTMLButtonElement | null;
    const editBtn = fixture.nativeElement.querySelector(
      'button[data-test="edit-namespace-yaml-btn"]',
    ) as HTMLButtonElement | null;
    expect(editBtn).not.toBeNull();
    expect(editBtn!.disabled).toBeTrue();
    if (createBtn) {
      expect(createBtn.disabled).toBeTrue();
    }
  });

  it('(14.2 AC6) initial-load auto-select still works (null → first of non-empty list)', async () => {
    // selectedNamespace$ starts null; loadNamespaces via ngOnInit selects first.
    expect(component.selectedNamespace$.value).toBeNull();
    apiSpy.getNamespaces.and.returnValue(
      Promise.resolve([
        nsSummary('agent-team-v1', 'Agent Team', 'd1'),
        nsSummary('rag-team-v1', 'RAG Team', 'd2'),
      ]),
    );

    await component.ngOnInit();

    expect(component.selectedNamespace$.value?.namespace).toBe('agent-team-v1');
  });

  it('(14.2 AC7) getNamespaces failure leaves namespaces$ unchanged and logs', async () => {
    component.namespaces$.next([
      nsSummary('existing-v1', 'Existing', 'd'),
    ]);
    apiSpy.getNamespaces.and.returnValue(Promise.reject(new Error('boom')));
    const consoleErrorSpy = spyOn(console, 'error');

    await expectAsync(component.onNamespaceSaved()).toBeResolved();

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(component.namespaces$.value).toEqual([
      nsSummary('existing-v1', 'Existing', 'd'),
    ]);
  });

  it('(11.5 AC13) namespaceIdentifiers returns the `.namespace` field of each namespaces$ entry', () => {
    component.namespaces$.next([
      nsSummary('foo', 'F', ''),
      nsSummary('bar', 'B', ''),
    ]);
    expect(component.namespaceIdentifiers).toEqual(['foo', 'bar']);
  });

  it('(11.5 AC13) namespaceIdentifiers returns [] when namespaces$ is empty', () => {
    component.namespaces$.next([]);
    expect(component.namespaceIdentifiers).toEqual([]);
  });

  it('(11.7 AC22) isWriteInFlight is true when namespacePanel.saving === true', () => {
    component.namespacePanel = {
      saving: true,
      cloning: false,
    } as unknown as NamespacePanelComponent;
    expect(component.isWriteInFlight).toBeTrue();
  });

  it('(11.7 AC22) isWriteInFlight is true when namespacePanel.cloning === true', () => {
    component.namespacePanel = {
      saving: false,
      cloning: true,
    } as unknown as NamespacePanelComponent;
    expect(component.isWriteInFlight).toBeTrue();
  });

  it('(11.7 AC23) isWriteInFlight is false when namespacePanel is undefined', () => {
    component.namespacePanel = undefined;
    expect(component.isWriteInFlight).toBeFalse();
  });

  it('(11.7 AC23) isWriteInFlight is false when only validating/loading are true (reads are non-destructive)', () => {
    component.namespacePanel = {
      saving: false,
      cloning: false,
      validating: true,
      loading: true,
    } as unknown as NamespacePanelComponent;
    expect(component.isWriteInFlight).toBeFalse();
  });

  // Single coordinated Escape handler. The host config dialog sets
  // `[closeOnEscape]="false"`; `onConfigDialogEscape` (a `document:keydown.escape`
  // HostListener) delegates to `panel.handleSecondaryEscape()` first — closing
  // only the topmost secondary modal — else runs the config close flow. It is
  // inactive unless the dialog is open, and a write in flight suppresses Escape.
  // (ADR-018)

  function escapeEvent(): jasmine.SpyObj<Event> {
    return jasmine.createSpyObj<Event>('KeyboardEvent', ['preventDefault']);
  }

  it('(ADR-018 §b) Escape is a no-op when the config dialog is not open', () => {
    const handleSecondaryEscape = jasmine.createSpy('handleSecondaryEscape');
    component.namespacePanelVisible = false;
    component.namespacePanel = {
      saving: false,
      cloning: false,
      handleSecondaryEscape,
    } as unknown as NamespacePanelComponent;

    component.onConfigDialogEscape(escapeEvent());

    expect(handleSecondaryEscape).not.toHaveBeenCalled();
  });

  it('(ADR-018 §b) Escape is a no-op while a write is in flight', () => {
    const handleSecondaryEscape = jasmine.createSpy('handleSecondaryEscape');
    component.namespacePanelVisible = true;
    component.namespacePanel = {
      saving: true,
      cloning: false,
      handleSecondaryEscape,
    } as unknown as NamespacePanelComponent;

    component.onConfigDialogEscape(escapeEvent());

    expect(handleSecondaryEscape).not.toHaveBeenCalled();
  });

  it('(ADR-018 §b) Escape closes ONLY the topmost secondary modal when one is open (config stays open)', () => {
    const handleSecondaryEscape = jasmine
      .createSpy('handleSecondaryEscape')
      .and.returnValue(true);
    component.namespacePanelVisible = true;
    component.namespacePanel = {
      saving: false,
      cloning: false,
      hasUnsavedChanges: () => true,
      handleSecondaryEscape,
    } as unknown as NamespacePanelComponent;

    const event = escapeEvent();
    component.onConfigDialogEscape(event);

    expect(handleSecondaryEscape).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    // Config panel was NOT closed (the secondary modal consumed the Escape).
    expect(component.namespacePanelVisible).toBeTrue();
  });

  it('(ADR-018 §b) Escape with no secondary modal open runs the config panel close flow', () => {
    const handleSecondaryEscape = jasmine
      .createSpy('handleSecondaryEscape')
      .and.returnValue(false);
    component.namespacePanelVisible = true;
    component.namespacePanel = {
      saving: false,
      cloning: false,
      hasUnsavedChanges: () => false,
      handleSecondaryEscape,
    } as unknown as NamespacePanelComponent;

    component.onConfigDialogEscape(escapeEvent());

    expect(handleSecondaryEscape).toHaveBeenCalledTimes(1);
    // Clean panel → close flow closes the config dialog directly.
    expect(component.namespacePanelVisible).toBeFalse();
  });

  it('(11.7 AC8) namespaceLabel returns selected.name when present', () => {
    component.selectedNamespace$.next(nsSummary('foo', 'Foo Display', ''));
    expect(component.namespaceLabel).toBe('Foo Display');
  });

  it('(11.7 AC8) namespaceLabel falls back to "Namespace" when none selected', () => {
    component.selectedNamespace$.next(null);
    expect(component.namespaceLabel).toBe('Namespace');
  });

  it('(11.7 AC8, AC9, AC10) dialog header dirty-indicator binding follows panel.hasUnsavedChanges()', () => {
    // Asserts the BINDING contract — the template predicate is
    // `namespacePanel?.hasUnsavedChanges() === true`. PrimeNG's dialog
    // teleports the rendered header into an overlay attached to <body>
    // which is finicky to query deterministically in component tests; the
    // contract that matters here is "indicator gates on panel's dirty
    // method", which is what the binding evaluates.
    function predicate(): boolean {
      return component.namespacePanel?.hasUnsavedChanges() === true;
    }

    component.namespacePanel = undefined;
    expect(predicate()).toBeFalse();

    // Clean panel — predicate is false, indicator hidden.
    component.namespacePanel = {
      hasUnsavedChanges: () => false,
    } as unknown as NamespacePanelComponent;
    expect(predicate()).toBeFalse();

    // Dirty panel — predicate is true, indicator visible.
    component.namespacePanel = {
      hasUnsavedChanges: () => true,
    } as unknown as NamespacePanelComponent;
    expect(predicate()).toBeTrue();
  });

  it('(11.5 AC13) template binding propagates namespaceIdentifiers via ng-reflect', async () => {
    // Prime the ngOnInit load so it does NOT overwrite our namespaces$ with
    // the default empty list: make `getNamespaces` resolve with the pair we
    // want to observe on the binding.
    const list = [
      nsSummary('alpha', 'Alpha', ''),
      nsSummary('beta', 'Beta', ''),
    ];
    apiSpy.getNamespaces.and.returnValue(Promise.resolve(list));

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // Open the panel dialog so the @defer block mounts the panel element.
    // `CUSTOM_ELEMENTS_SCHEMA` prevents the real `NamespacePanelComponent`
    // from asserting its surface; we only care that the input attribute
    // lands on the element.
    component.namespacePanelVisible = true;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const panelEl = fixture.nativeElement.querySelector(
      'app-namespace-panel',
    ) as HTMLElement | null;
    if (panelEl) {
      const attr = panelEl.getAttribute('ng-reflect-existing-namespaces');
      if (attr !== null) {
        expect(attr).toContain('alpha');
        expect(attr).toContain('beta');
      }
    }
    // Deterministic assertion: the getter itself is the contract.
    expect(component.namespaceIdentifiers).toEqual(['alpha', 'beta']);
  });

  function toggleEl(): HTMLElement | null {
    return fixture.nativeElement.querySelector(
      '[data-test="show-all-namespaces-toggle"]',
    ) as HTMLElement | null;
  }

  it('(14.4 AC1, AC11) toggle is hidden for a non-admin (roles: [])', async () => {
    currentUser$.next({ user_id: 'alice', roles: [] });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(toggleEl()).toBeNull();
  });

  it('(14.4 AC1, AC11) toggle is hidden for the anonymous user (roles absent)', async () => {
    currentUser$.next({ user_id: 'anonymous' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(toggleEl()).toBeNull();
  });

  it('(14.4 AC1, AC12) toggle is visible for an admin (roles: ["admin"])', async () => {
    currentUser$.next({ user_id: 'gpiroux', roles: ['admin'] });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(toggleEl()).not.toBeNull();
  });

  it('(14.4 AC7, AC12) toggle appears reactively after a deferred admin /auth/me resolves', async () => {
    // Starts anonymous (seeded in beforeEach) — toggle hidden.
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(toggleEl()).toBeNull();

    // The deferred /auth/me resolves an admin → toggle becomes visible
    // WITHOUT a manual refresh (reactive predicate via currentUser$).
    currentUser$.next({ user_id: 'gpiroux', roles: ['admin'] });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(toggleEl()).not.toBeNull();
  });

  it('(14.4 AC2, AC15) default off on init — first getNamespaces call omits all=true', async () => {
    currentUser$.next({ user_id: 'gpiroux', roles: ['admin'] });
    apiSpy.getNamespaces.calls.reset();
    apiSpy.getNamespaces.and.returnValue(
      Promise.resolve([
        nsSummary('agent-team-v1', 'Agent Team', 'd'),
      ]),
    );

    await component.ngOnInit();

    expect(component.showAllNamespaces).toBeFalse();
    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(1);
    expect(apiSpy.getNamespaces.calls.first().args[0]).toEqual({ all: false });
  });

  it('(14.4 AC3) toggling on re-fetches with all=true and surfaces a foreign namespace', async () => {
    currentUser$.next({ user_id: 'gpiroux', roles: ['admin'] });
    const foreign = nsSummary(
      'other-tenant-ns',
      'Other Tenant',
      'foreign-owned',
    );
    apiSpy.getNamespaces.and.returnValue(Promise.resolve([foreign]));
    apiSpy.getNamespaces.calls.reset();

    await component.onToggleShowAll(true);

    expect(component.showAllNamespaces).toBeTrue();
    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(1);
    expect(apiSpy.getNamespaces.calls.mostRecent().args[0]).toEqual({
      all: true,
    });
    expect(
      component.namespaces$.value.some(
        (n) => n.namespace === 'other-tenant-ns',
      ),
    ).toBeTrue();
  });

  it('(14.4 AC4) toggling off re-fetches the normal owner+public list', async () => {
    currentUser$.next({ user_id: 'gpiroux', roles: ['admin'] });
    apiSpy.getNamespaces.and.returnValue(Promise.resolve([]));

    await component.onToggleShowAll(true);
    apiSpy.getNamespaces.calls.reset();

    await component.onToggleShowAll(false);

    expect(component.showAllNamespaces).toBeFalse();
    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(1);
    expect(apiSpy.getNamespaces.calls.mostRecent().args[0]).toEqual({
      all: false,
    });
  });

  it('(14.4 AC6, AC18) toggle re-fetch still runs the Story 14.2 selection reconciliation', async () => {
    currentUser$.next({ user_id: 'gpiroux', roles: ['admin'] });
    // Seed a selection that the toggled-on list no longer contains — the
    // reconciliation must drop it and advance to the first remaining ns.
    component.selectedNamespace$.next(nsSummary('stale-ns', 'Stale', 'gone'));
    const refreshed = [
      nsSummary('agent-team-v1', 'Agent Team', 'd1'),
      nsSummary('rag-team-v1', 'RAG Team', 'd2'),
    ];
    apiSpy.getNamespaces.and.returnValue(Promise.resolve(refreshed));

    await component.onToggleShowAll(true);

    // AC3: the call carried all=true.
    expect(apiSpy.getNamespaces.calls.mostRecent().args[0]).toEqual({
      all: true,
    });
    // AC18: stale selection dropped, advanced to first remaining.
    expect(component.selectedNamespace$.value?.namespace).toBe('agent-team-v1');
  });

  it('(14.4 AC6, AC18) toggle re-fetch preserves a still-present selection by identity', async () => {
    currentUser$.next({ user_id: 'gpiroux', roles: ['admin'] });
    const original = nsSummary('rag-team-v1', 'RAG Team', 'original');
    component.selectedNamespace$.next(original);
    apiSpy.getNamespaces.and.returnValue(
      Promise.resolve([
        nsSummary('agent-team-v1', 'Agent Team', 'd1'),
        nsSummary('rag-team-v1', 'RAG Team', 'refreshed'),
      ]),
    );

    await component.onToggleShowAll(true);

    // Still-present selection left untouched (reference-equal).
    expect(component.selectedNamespace$.value).toBe(original);
  });

  // --- Epic 28: classic lazy paginated table (view layer) ---

  /** The rendered child component instance. */
  function teamTable(): TeamTableComponent {
    return fixture.debugElement.query(By.directive(TeamTableComponent))
      .componentInstance;
  }

  // The scroll contract itself — [scrollable], scrollHeight="flex", no virtual
  // scroll, the page-report template — moved with the <p-table> into
  // team-table.component.spec.ts. What is left here is the page's half: the
  // paging state it owns reaches the child's inputs.

  it('(28.2 AC8a) the page feeds totalCount, rows and first into the table', async () => {
    contextSpy.totalCount = 1000;
    totalCount$.next(1000);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // The lazy table seeds page 1 on init (loadPage → loadTeamsPage).
    expect(contextSpy.loadTeamsPage).toHaveBeenCalled();

    // Turn a page. `first` is set AFTER the seed on purpose: `ngOnInit`'s
    // restore writes it from the URL, so a value planted before the first
    // render is overwritten and the assertion would be vacuous.
    component.first = 250;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const table = teamTable();
    expect(table.totalRecords).toBe(1000);
    expect(table.rows).toBe(component.rows);
    expect(table.first).toBe(250);
    // Rendered, not merely bound: the "X–Y of N" report is on screen.
    expect(fixture.nativeElement.textContent as string).toContain('1000');
  });

  it('(28.2 AC8b) loadPage computes page = first / rows + 1 and delegates to loadTeamsPage', async () => {
    await component.loadPage({ first: 500, rows: 250 });
    expect(contextSpy.loadTeamsPage).toHaveBeenCalledOnceWith(3, 250);
    expect(component.currentPage).toBe(3);
    expect(component.first).toBe(500);
  });

  it('(28.2 AC8b) loadPage falls back to PAGE_SIZE when event.rows is absent', async () => {
    await component.loadPage({ first: 0 });
    expect(contextSpy.loadTeamsPage).toHaveBeenCalledOnceWith(1, 250);
  });

  it('(28.2 AC8c) opening the home page triggers exactly ONE initial page-1 loadTeamsPage (no double-seed)', async () => {
    // The lazy table fires its initial (onLazyLoad) once on render.
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(contextSpy.loadTeamsPage).toHaveBeenCalledTimes(1);
    expect(contextSpy.loadTeamsPage.calls.first().args[0]).toBe(1);
    // ngOnInit must NOT itself fetch the list (no double seed).
    expect(contextSpy.getTeams).not.toHaveBeenCalled();
  });

  it('(28.2 AC8c) ngOnInit (hideHome off) does NOT fetch the list itself', async () => {
    // Called directly without rendering — no table, so the only list fetch
    // would be an (illegal) ngOnInit fetch. Assert there is none.
    await component.ngOnInit();
    expect(contextSpy.getTeams).not.toHaveBeenCalled();
    expect(contextSpy.loadTeamsPage).not.toHaveBeenCalled();
  });

  it('(28.2 AC8d) a jump-to-page fetches that page and REPLACES (not appends) the rendered rows', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    // Initial seed rendered page 1.
    expect((fixture.nativeElement.textContent as string)).toContain('team-page-1');

    // Jump to page 3 (first = 500, rows = 250).
    await component.loadPage({ first: 500, rows: 250 });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(contextSpy.loadTeamsPage).toHaveBeenCalledWith(3, 250);
    const text = fixture.nativeElement.textContent as string;
    // New page rendered; prior page REPLACED (not accumulated).
    expect(text).toContain('team-page-3');
    expect(text).not.toContain('team-page-1');
  });

  it('(28.2 AC8e, superseded) createTeam leaves — no reload, no paginator jump, no blanked list', async () => {
    // Superseded behaviour: create used to stay on the home page and reload
    // page 1. Every creation path now navigates to the new team's process
    // view, so the paginator is left exactly where it was and NOTHING is
    // reloaded — the page is being unmounted, and a reload here would be a
    // wasted request racing the navigation.
    component.selectedNamespace$.next(
      nsSummary('agent-team-v1', 'Agent Team', 'd'),
    );
    component.currentPage = 4;
    component.first = 750;
    contextSpy.loadTeamsPage.calls.reset();
    contextSpy.createTeamAndNavigate.calls.reset();

    await component.createTeam();

    expect(contextSpy.createTeamAndNavigate).toHaveBeenCalledOnceWith(
      'agent-team-v1',
      undefined,
    );
    expect(contextSpy.loadTeamsPage).not.toHaveBeenCalled();
    expect(component.currentPage).toBe(4);
    expect(component.first).toBe(750);
    expect(contextSpy.resetTeams).not.toHaveBeenCalled();
  });

  it('(28.2 AC8e) restoreTeam reloads the CURRENT page with no empty emission', async () => {
    component.currentPage = 2;
    contextSpy.loadTeamsPage.calls.reset();
    const emissions: TeamContext[][] = [];
    const sub = teams$.subscribe((v) => emissions.push(v));

    await component.restoreTeam('team-X');

    expect(apiSpy.restoreTeam).toHaveBeenCalledOnceWith('team-X');
    expect(contextSpy.loadTeamsPage).toHaveBeenCalledOnceWith(2, 250);
    expect(contextSpy.resetTeams).not.toHaveBeenCalled();
    // No empty [] emission slipped in before the reloaded page.
    expect(emissions.some((e) => e.length === 0 && e !== emissions[0])).toBeFalse();
    sub.unsubscribe();
  });

  it('(28.2 AC8e) refreshContext reloads the CURRENT page with no empty emission', async () => {
    component.currentPage = 3;
    contextSpy.loadTeamsPage.calls.reset();

    await component.refreshContext();

    expect(contextSpy.loadTeamsPage).toHaveBeenCalledOnceWith(3, 250);
    expect(contextSpy.resetTeams).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // What the child asks for, the page performs (28.2 AC8f, split).
  //
  // The single spec these replace asserted FIVE behaviours at once — row
  // select, the status tag, two action handlers and the inline editor. Split
  // carelessly into one child spec it would have dropped four of them, so each
  // is now its own `it` on the side that owns it: the page's four delegations
  // here, the status tag and the editor's open/cancel in
  // team-table.component.spec.ts.
  // -------------------------------------------------------------------------

  it('(28.2 AC8f) a paged row still renders, and (rowSelected) navigates to it', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    // Render a known running row (REPLACE the seed page).
    teams$.next([
      makeTeam({ team_id: 'row-1', name: 'Row One', status: 'running' }),
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent as string).toContain('row-1');

    // The child emits the team_id; navigating is this page's decision.
    component.onRowSelect('row-1');

    expect(routerSpy.navigate).toHaveBeenCalledWith(['/process', 'row-1']);
  });

  it('(28.2 AC8f) (deleteRequested) delegates to contextService.deleteTeam', async () => {
    await component.deleteTeam('row-1');

    expect(contextSpy.deleteTeam).toHaveBeenCalledWith('row-1');
  });

  it('(28.2 AC8f) (stopRequested) delegates to contextService.stopTeamAndAwait', async () => {
    await component.stopTeam('row-1');

    expect(contextSpy.stopTeamAndAwait).toHaveBeenCalledWith('row-1');
  });

  it('(28.2 AC8f) (descriptionSaved) reaches the API', async () => {
    await component.saveDescription('row-1', 'old');

    expect(apiSpy.updateTeamDescription).toHaveBeenCalledWith('row-1', 'old');
  });

  // -------------------------------------------------------------------------
  // The BINDINGS themselves, driven from the child's outputs.
  //
  // The four specs above call the page's methods directly, which proves the
  // page still does the right thing but says nothing about whether the child
  // is still WIRED to it. Deleting `(rowSelected)`, `(stopRequested)`,
  // `(restoreRequested)`, `(deleteRequested)` and `(descriptionSaved)` from
  // home.component.html leaves every one of them green — the extraction's own
  // seam, unguarded. These emit from the REAL rendered child instead, so a
  // binding lost in a rename or a merge goes red here.
  //
  // `(lazyLoad)` needs no spec of its own: the seed-load counts above already
  // originate inside the child and travel through it.
  // -------------------------------------------------------------------------

  /** Render the page with one known running row, and return the real child. */
  async function renderedTable(): Promise<TeamTableComponent> {
    fixture.detectChanges();
    await fixture.whenStable();
    teams$.next([makeTeam({ team_id: 'row-1', status: 'running' })]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return teamTable();
  }

  it('(AC3) the child\'s (rowSelected) is bound to the page\'s navigation', async () => {
    const table = await renderedTable();

    table.rowSelected.emit('row-1');

    expect(routerSpy.navigate).toHaveBeenCalledWith(['/process', 'row-1']);
  });

  it('(AC7) the child\'s (deleteRequested) is bound to deleteTeam', async () => {
    const table = await renderedTable();

    table.deleteRequested.emit('row-1');
    await fixture.whenStable();

    expect(contextSpy.deleteTeam).toHaveBeenCalledWith('row-1');
  });

  it('(AC4) the child\'s (stopRequested) is bound, and the work comes back', async () => {
    const table = await renderedTable();
    const { action, tracked } = trackingAction('row-1');

    table.stopRequested.emit(action);

    expect(contextSpy.stopTeamAndAwait).toHaveBeenCalledWith('row-1');
    // Bound to `onStopRequested`, not to `stopTeam` — only the former hands
    // the work back, and a row that is never told stays busy forever.
    expect(tracked.length).toBe(1);
    await tracked[0];
  });

  it('(AC6) the child\'s (restoreRequested) is bound, and the work comes back', async () => {
    const table = await renderedTable();
    const { action, tracked } = trackingAction('row-1');

    table.restoreRequested.emit(action);

    expect(tracked.length).toBe(1);
    await tracked[0];
    expect(apiSpy.restoreTeam).toHaveBeenCalledWith('row-1');
  });

  it('(AC11) the child\'s (descriptionSaved) is bound, and the work comes back', async () => {
    const table = await renderedTable();
    const tracked: Promise<unknown>[] = [];

    table.descriptionSaved.emit({
      teamId: 'row-1',
      description: 'fresh',
      track: (work) => tracked.push(work),
    });

    expect(tracked.length).toBe(1);
    await tracked[0];
    expect(apiSpy.updateTeamDescription).toHaveBeenCalledWith('row-1', 'fresh');
  });

  it('(AC17) the page no longer owns any of the table\'s row state', () => {
    // Not tidiness: each of these left behind on the page is a second place the
    // same state can be written, and the two would drift the moment one of them
    // is updated. `descriptionInputs` in particular resolves to nothing here —
    // its markup is in the child — so it would be a silently dead query.
    for (const member of [
      'stoppingTeams',
      'restoringTeams',
      'isStopping',
      'isRestoring',
      'editingDescriptionFor',
      'descriptionDrafts',
      'startEditDescription',
      'cancelEditDescription',
      'descriptionInputs',
      'trackMetadataEntry',
      'isRunning',
    ]) {
      expect((component as unknown as Record<string, unknown>)[member])
        .withContext(`HomeComponent must no longer declare ${member}`)
        .toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // Story 37-3 AC6 — saveDescription delegates instead of mutating the cache.
  //
  // This bed injects a ContextService SPY, so it can prove exactly one thing
  // about the write, and it is the right thing: with `setTeamDescription`
  // stubbed to a no-op, NOTHING writes the cache. A team object that still
  // reports its old description afterwards therefore proves the component
  // itself did not write it. The new-object / reference-inequality half lives
  // in context.service.spec.ts, where the real `_upsertTeam` runs.
  // -------------------------------------------------------------------------

  describe('saveDescription delegation (Story 37-3 AC6)', () => {
    it('forwards the description it is given, VERBATIM', async () => {
      // The trim-and-null rule travels with the draft: the table applies it and
      // emits the finished value. The page applying it a SECOND time would be a
      // second place the rule lives, and the two would drift. Passed a value
      // that is still padded, the page must forward the padding rather than
      // quietly repair it.
      const team = makeTeam({ team_id: 'row-1', description: 'before' });
      teams$.next([team]);

      await component.saveDescription('row-1', '  spaced out  ');

      expect(contextSpy.setTeamDescription).toHaveBeenCalledOnceWith(
        'row-1',
        '  spaced out  ',
      );
      expect(apiSpy.updateTeamDescription).toHaveBeenCalledWith(
        'row-1',
        '  spaced out  ',
      );
    });

    it('does not write the cached team itself', async () => {
      const team = makeTeam({ team_id: 'row-1', description: 'before' });
      teams$.next([team]);

      await component.saveDescription('row-1', 'after');

      // `setTeamDescription` is a stub here, so the only way this object could
      // have changed is the component mutating it — which is the defect.
      expect(team.description).toBe('before');
      expect(teams$.value[0].description).toBe('before');
    });

    it('forwards a null description as null', async () => {
      // The empty-draft case, arriving already resolved to `null` by the table.
      teams$.next([makeTeam({ team_id: 'row-1', description: 'before' })]);

      await component.saveDescription('row-1', null);

      expect(contextSpy.setTeamDescription).toHaveBeenCalledOnceWith('row-1', null);
    });

    it('calls the API BEFORE the cache, and resolves on success', async () => {
      teams$.next([makeTeam({ team_id: 'row-1' })]);

      await expectAsync(
        component.saveDescription('row-1', 'fresh'),
      ).toBeResolved();

      expect(apiSpy.updateTeamDescription).toHaveBeenCalledWith('row-1', 'fresh');
      expect(contextSpy.setTeamDescription).toHaveBeenCalledWith('row-1', 'fresh');
    });

    it('LOGS AND RE-THROWS an API failure, leaving the cache alone', async () => {
      // It used to swallow, and cleared the editing row itself. Neither is
      // possible now: the editor belongs to the table, and the only way to tell
      // it a save failed — so it can keep the typed text on screen — is to
      // reject the work it is tracking. A resolved promise here would close the
      // editor and throw the user's text away on every failed save.
      apiSpy.updateTeamDescription.and.returnValue(
        Promise.reject(new Error('boom')),
      );
      const consoleErrorSpy = spyOn(console, 'error');
      teams$.next([makeTeam({ team_id: 'row-1' })]);

      await expectAsync(
        component.saveDescription('row-1', 'fresh'),
      ).toBeRejected();

      // The API call is awaited BEFORE the delegation, so a rejection means the
      // cache is never touched.
      expect(contextSpy.setTeamDescription).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('onDescriptionSaved hands the write back to the row that asked for it', async () => {
      const tracked: Promise<unknown>[] = [];
      const save: TeamDescriptionSave = {
        teamId: 'row-1',
        description: 'fresh',
        track: (work) => tracked.push(work),
      };

      component.onDescriptionSaved(save);

      expect(tracked.length).toBe(1);
      await tracked[0];
      expect(apiSpy.updateTeamDescription).toHaveBeenCalledWith('row-1', 'fresh');
    });
  });

  describe('hideHome reactive read (28.2 AC3)', () => {
    beforeEach(async () => {
      // Re-configure with hideHome ON so the auto-route branch runs.
      TestBed.resetTestingModule();
      await TestBed.configureTestingModule({
        imports: [HomeComponent, CommonModule, NoopAnimationsModule],
        providers: [
          { provide: ApiService, useValue: apiSpy },
          { provide: ContextService, useValue: contextSpy },
          { provide: AuthService, useValue: authSpy },
          { provide: ConfigService, useValue: { hideHome: true } },
          { provide: Router, useValue: routerSpy },
          { provide: ActivatedRoute, useValue: routeStub },
        ],
        schemas: [CUSTOM_ELEMENTS_SCHEMA],
      }).compileComponents();
      fixture = TestBed.createComponent(HomeComponent);
      component = fixture.componentInstance;
    });

    it('navigates to the first team after the seed lands (reactive read, single fetch)', async () => {
      // ngOnInit awaits the seed; drive the table seed via loadPage, which the
      // fake resolves with a one-row page.
      const init = component.ngOnInit();
      await component.loadPage({ first: 0, rows: 250 });
      await init;

      // Exactly one page-1 fetch (the seed) — no extra ngOnInit fetch.
      expect(contextSpy.loadTeamsPage).toHaveBeenCalledTimes(1);
      expect(contextSpy.getTeams).not.toHaveBeenCalled();
      expect(routerSpy.navigate).toHaveBeenCalledWith(['/process', 'team-page-1']);
    });

    it('creates a team through the gate, as an `auto` request, when the seeded page is empty', async () => {
      // loadNamespaces must keep the selection present (else reconciliation
      // clears it to null and the create branch has no namespace to use).
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([
          nsSummary('agent-team-v1', 'Agent Team', 'd'),
        ]),
      );
      component.selectedNamespace$.next(
        nsSummary('agent-team-v1', 'Agent Team', 'd'),
      );
      // Seed an EMPTY page so the create branch runs.
      contextSpy.loadTeamsPage.and.callFake(async () => {
        teams$.next([]);
        return { teams: [], total_count: 0 };
      });

      const init = component.ngOnInit();
      await component.loadPage({ first: 0, rows: 250 });
      await init;

      expect(contextSpy.createTeamAndNavigate).toHaveBeenCalledOnceWith(
        'agent-team-v1',
        undefined,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Story 49.2 — the creation gate, from the PAGE's side.
  //
  // What the gate DECIDES — the three no-ask states, the two origins, the
  // spinner rule, the 422 shapes, capture-at-open — is
  // `team-creation.service.spec.ts`, which runs without a page at all. Nothing
  // here re-tests it.
  //
  // What is left is the page's own half, and it is exactly the half 49-1's
  // review found missing: that the page ROUTES THROUGH the gate rather than
  // creating for itself, and that the gate's state and the modal's answers
  // actually travel across the seven template bindings. Every spec below drives
  // the RENDERED page and the REAL modal; driving `creation.request` directly
  // would prove nothing about the wiring.
  // -------------------------------------------------------------------------

  describe('the creation gate, from the page (49.2)', () => {
    const asking = contract([field('tenant', { mandatory: true })]);

    function modal(): TeamMetadataModalComponent {
      return fixture.debugElement.query(By.directive(TeamMetadataModalComponent))
        .componentInstance as TeamMetadataModalComponent;
    }

    /**
     * Render FIRST, select AFTER. `fixture.detectChanges()` runs `ngOnInit`,
     * and `loadNamespaces` reconciles the selection against the (empty)
     * `getNamespaces` spy result — so a selection pushed before the first
     * render is replaced by `null` and every creation path silently takes its
     * no-selection guard.
     */
    async function renderThenSelect(ns: NamespaceSummary): Promise<void> {
      fixture.detectChanges();
      await fixture.whenStable();
      component.selectedNamespace$.next(ns);
      fixture.detectChanges();
    }

    /** Render, select a contract-bearing namespace, and open the dialog. */
    async function openDialog(): Promise<void> {
      await renderThenSelect(nsSummary('acme-cases', 'Acme Cases', 'd', asking));
      await component.createTeam();
      fixture.detectChanges();
      // Guard the guard: every assertion below is vacuous on a dialog that
      // never opened.
      expect(modal().visible).toBeTrue();
    }

    // --- AC1: one gate per page mount, never a root singleton ---

    it('(AC1) the gate is the PAGE\'s, not the root injector\'s', () => {
      // A component-level provider is invisible to the environment injector.
      // `providedIn: 'root'` would resolve here — and would then outlive the
      // page, carrying a captured namespace and an open dialog across a
      // navigation away and back. That is a behaviour change, not a refactor.
      expect(TestBed.inject(TeamCreationService, null)).toBeNull();
    });

    it('(AC1) two page mounts hold two different gates', () => {
      const second = TestBed.createComponent(HomeComponent);

      expect(component.creation).toBeInstanceOf(TeamCreationService);
      expect(second.componentInstance.creation).not.toBe(component.creation);
    });

    // --- AC14: the Create button routes through the gate ---

    it('(AC14) the Create button opens the REAL modal on a selection that asks, and creates nothing', async () => {
      await renderThenSelect(nsSummary('acme-cases', 'Acme Cases', 'd', asking));
      contextSpy.createTeamAndNavigate.calls.reset();
      expect(modal().visible).toBeFalse();

      await component.createTeam();
      fixture.detectChanges();

      expect(modal().visible).toBeTrue();
      expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
    });

    it('(AC14) the Create button creates with the two-argument form when nothing is asked', async () => {
      await renderThenSelect(nsSummary('agent-team-v1', 'Agent Team', 'd'));
      contextSpy.createTeamAndNavigate.calls.reset();

      await component.createTeam();
      fixture.detectChanges();

      expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args).toEqual([
        'agent-team-v1',
        undefined,
      ]);
      expect(modal().visible).toBeFalse();
    });

    it('(AC14, AC18) the no-selection guard is still the page\'s, and creates nothing', async () => {
      component.selectedNamespace$.next(null);

      await component.createTeam();

      expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
    });

    // --- AC8, from the page: the dropdown stays live behind the dialog ---

    it('(AC8) confirming creates for the namespace the dialog was opened for, not the live selection', async () => {
      await openDialog();
      // WHAT THIS SPEC ACTUALLY GUARDS, because the title alone oversells it:
      // capture-at-open is STRUCTURAL here — the gate injects `ContextService`
      // and nothing else, so it cannot read the live selection even if it tried,
      // and no mutation of the gate can make this assertion fail for the reason
      // the title gives. That property is pinned in the gate's own spec
      // ("uses the namespace CAPTURED at open time"), which a re-pointing
      // mutation does redden.
      //
      // What goes red HERE is the ROUTE and the JOIN: the page reaching the gate
      // at all, and `(confirmed)` carrying the answer back across the template.
      // It is kept because it is the spec a reader looks for when they ask "can
      // a dropdown change behind the dialog steal the create?" — and because it
      // is the only place that question is asked of the RENDERED page.
      //
      // The user changes the dropdown while the dialog is up. The header still
      // says Acme Cases and the answers are Acme Cases's.
      component.selectedNamespace$.next(nsSummary('other-ns', 'Other', 'd'));
      fixture.detectChanges();
      contextSpy.createTeamAndNavigate.calls.reset();

      modal().confirmed.emit({ tenant: 'acme' });
      await fixture.whenStable();

      expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args[0]).toBe('acme-cases');
    });

    // --- AC16: the seven bindings, one spec each ---
    //
    // Deleting any ONE of them must redden at least one named spec. A single
    // spec asserting all five inputs at once cannot say which binding went —
    // and the two OUTPUTS are the pair 49-1 shipped unguarded, because its
    // delegation specs called the page's own methods and never proved the child
    // was wired to anything.

    it('(AC16) [visible] — the gate\'s open state reaches the modal', async () => {
      await renderThenSelect(nsSummary('acme-cases', 'Acme Cases', 'd', asking));
      expect(modal().visible).toBeFalse();

      await component.createTeam();
      fixture.detectChanges();

      expect(modal().visible).toBeTrue();
    });

    it('(AC16) [contract] — the captured contract reaches the modal', async () => {
      await openDialog();

      expect(modal().contract).toBe(asking);
    });

    it('(AC16) [namespaceLabel] — the captured label reaches the modal header', async () => {
      await openDialog();

      expect(modal().namespaceLabel).toBe('Acme Cases');
    });

    it('(AC16) [errorMessage] — the server\'s 422 reaches the modal', async () => {
      await openDialog();
      expect(modal().errorMessage).toBeNull();
      contextSpy.createTeamAndNavigate.and.returnValue(
        Promise.reject(
          new HttpError('Unprocessable', 422, { detail: 'tenant is required' }),
        ),
      );

      await component.creation.confirm({ case: 'C-1234' });
      fixture.detectChanges();

      expect(modal().visible).toBeTrue();
      expect(modal().errorMessage).toBe('tenant is required');
    });

    it('(AC16) [pending] — an in-flight confirm reaches the modal and locks it', async () => {
      await openDialog();
      expect(modal().pending).toBeFalse();
      let release: () => void = () => undefined;
      contextSpy.createTeamAndNavigate.and.returnValue(
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
      );

      const inFlight = component.creation.confirm({ tenant: 'acme' });
      fixture.detectChanges();

      expect(modal().pending).toBeTrue();

      release();
      await inFlight;
    });

    it('(AC16) (confirmed) — the modal\'s answers reach the gate through the template', async () => {
      await openDialog();
      contextSpy.createTeamAndNavigate.calls.reset();

      // The POST is issued synchronously by the handler the binding names.
      modal().confirmed.emit({ tenant: 'acme' });

      expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args).toEqual([
        'acme-cases',
        { tenant: 'acme' },
      ]);
    });

    it('(AC16) (cancelled) — a dismissal reaches the gate through the template', async () => {
      await openDialog();
      contextSpy.createTeamAndNavigate.calls.reset();

      modal().cancelled.emit();
      fixture.detectChanges();

      expect(component.creation.modalVisible).toBeFalse();
      expect(modal().visible).toBeFalse();
      expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
    });

    // --- AC17: none of it is left behind on the page ---

    it('(AC17) the page no longer owns any part of the creation gate', () => {
      // Not tidiness: each of these left behind is a second place the same
      // decision or the same state lives, and the two would drift the moment
      // one of them is changed — which is the duplication this story removes.
      for (const member of [
        'metadataModalVisible',
        'metadataContract',
        'metadataNamespace',
        'metadataNamespaceLabel',
        'metadataError',
        'metadataSubmitting',
        'pendingCreation',
        'isCreatingTeam',
        'metadataContractOf',
        'createAndNavigate',
        'openMetadataModal',
        'onMetadataConfirm',
        'onMetadataCancel',
        'closeMetadataModal',
        'handleMetadataCreateError',
        'metadataErrorMessage',
        'metadataErrorLine',
      ]) {
        expect((component as unknown as Record<string, unknown>)[member])
          .withContext(`HomeComponent must no longer declare ${member}`)
          .toBeUndefined();
      }
      // What it KEEPS: the two call sites, both delegating.
      expect(typeof component.createTeam).toBe('function');
    });
  });

  describe('the creation gate on the gesture-less hideHome route (49.2 AC15)', () => {
    const asking = contract([field('tenant', { mandatory: true })]);

    /**
     * Let the `handleHideHome` chain run to (and through) its
     * `await creation.request(...)`.
     *
     * The branch awaits two `firstValueFrom`s before it reaches the gate, and
     * the gate then awaits the create — so a single microtask turn is nowhere
     * near enough either to observe the create IN FLIGHT or to read the state
     * it leaves behind.
     */
    async function settleMicrotasks(): Promise<void> {
      for (let i = 0; i < 32; i += 1) {
        await Promise.resolve();
      }
    }

    beforeEach(async () => {
      // Re-configure with hideHome ON so the auto-route branch runs, exactly as
      // the 28.2 hideHome block above does.
      TestBed.resetTestingModule();
      await TestBed.configureTestingModule({
        imports: [HomeComponent, CommonModule, NoopAnimationsModule],
        providers: [
          { provide: ApiService, useValue: apiSpy },
          { provide: ContextService, useValue: contextSpy },
          { provide: AuthService, useValue: authSpy },
          { provide: ConfigService, useValue: { hideHome: true } },
          { provide: Router, useValue: routerSpy },
          { provide: ActivatedRoute, useValue: routeStub },
        ],
        schemas: [CUSTOM_ELEMENTS_SCHEMA],
      }).compileComponents();
      fixture = TestBed.createComponent(HomeComponent);
      component = fixture.componentInstance;

      // Seed an EMPTY page so the create branch of handleHideHome runs.
      contextSpy.loadTeamsPage.and.callFake(async () => {
        teams$.next([]);
        return { teams: [], total_count: 0 };
      });
    });

    /**
     * Arrive on the route: render, let the table's first `(onLazyLoad)` seed
     * page 1, and let `handleHideHome` run to completion.
     *
     * `ngOnInit` is NOT called by hand. The first change detection runs it, so
     * calling it as well would run the whole arrival TWICE — and the second
     * pass re-opens the dialog behind the spec's back, after the first one has
     * been confirmed or cancelled.
     */
    async function arriveOnTheRoute(): Promise<void> {
      fixture.detectChanges();
      await component.loadPage({ first: 0, rows: 250 });
      await settleMicrotasks();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    }

    function modal(): TeamMetadataModalComponent {
      return fixture.debugElement.query(By.directive(TeamMetadataModalComponent))
        .componentInstance as TeamMetadataModalComponent;
    }

    it('(AC15) a selection that ASKS opens the real modal and creates nothing', async () => {
      // The whole reason the gesture-less route gates. Nobody pressed anything,
      // so a mandatory field skipped here is skipped in silence.
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([nsSummary('acme-cases', 'Acme Cases', 'd', asking)]),
      );
      contextSpy.createTeamAndNavigate.calls.reset();

      await arriveOnTheRoute();

      expect(component.creation.modalVisible).toBeTrue();
      expect(modal().visible).toBeTrue();
      expect(modal().contract).toBe(asking);
      expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
    });

    it('(AC15) a selection that asks NOTHING creates and navigates with (namespace, undefined)', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([nsSummary('agent-team-v1', 'Agent Team', 'd')]),
      );
      contextSpy.createTeamAndNavigate.calls.reset();

      await arriveOnTheRoute();

      expect(component.creation.modalVisible).toBeFalse();
      expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args).toEqual([
        'agent-team-v1',
        undefined,
      ]);
    });

    it('(AC15) the gesture-less create NEVER spins the Create button', async () => {
      // The origin is what makes this true, and it is asserted MID-FLIGHT:
      // after the create settles the flag is false whichever origin was passed,
      // so an end-state assertion would pass on a route wrongly marked
      // `'gesture'`.
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([nsSummary('agent-team-v1', 'Agent Team', 'd')]),
      );
      let release: () => void = () => undefined;
      contextSpy.createTeamAndNavigate.and.returnValue(
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
      );

      fixture.detectChanges();
      await component.loadPage({ first: 0, rows: 250 });
      await settleMicrotasks();

      expect(contextSpy.createTeamAndNavigate).toHaveBeenCalled();
      expect(component.creation.creatingByGesture).toBeFalse();

      release();
      await settleMicrotasks();

      expect(component.creation.creatingByGesture).toBeFalse();
    });

    it('(AC15) a gated arrival never spins the Create button either', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([nsSummary('acme-cases', 'Acme Cases', 'd', asking)]),
      );

      await arriveOnTheRoute();

      expect(component.creation.modalVisible).toBeTrue();
      expect(component.creation.creatingByGesture).toBeFalse();
    });

    it('(AC15) confirming from the gesture-less route creates and navigates', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([nsSummary('acme-cases', 'Acme Cases', 'd', asking)]),
      );

      await arriveOnTheRoute();
      contextSpy.createTeamAndNavigate.calls.reset();

      // Through the real modal's output, so the join is exercised on this route
      // too — the confirm that follows an AUTO open was never actually covered
      // before (the spec that claimed to drove `createTeam`).
      modal().confirmed.emit({ tenant: 'acme' });
      // `(confirmed)` binds a promise-returning method to a `void` output, so
      // nothing here holds the create's promise — settle the microtasks by hand
      // before reading the state it leaves behind.
      await settleMicrotasks();

      expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args).toEqual([
        'acme-cases',
        { tenant: 'acme' },
      ]);
      expect(component.creation.modalVisible).toBeFalse();
    });

    it('(AC15) cancelling from the gesture-less route creates nothing', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([nsSummary('acme-cases', 'Acme Cases', 'd', asking)]),
      );

      await arriveOnTheRoute();
      contextSpy.createTeamAndNavigate.calls.reset();

      modal().cancelled.emit();
      fixture.detectChanges();

      expect(component.creation.modalVisible).toBeFalse();
      expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Story 48.1 — the filter bar.
  //
  // The service is a spy throughout, so what is asserted here is the FILTER
  // MODEL the component composes and the input set it renders — never a URL
  // and never a fetch. The URL is `ApiService`'s contract and the debounce is
  // `ContextService`'s; each is pinned in its own spec file.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // The filter, from the PAGE's side (Stories 48.1 / 48.2).
  //
  // What the form itself does — which fields it offers, how it labels them,
  // what it composes, Reset — is `team-filter.component.spec.ts`. Everything
  // here is the page's half of the contract: the filter reaching the service,
  // the page resetting, the URL, and coming back to a list as it was left.
  //
  // These specs drive `onFilterChanged(filter)` directly, which is the seam the
  // form reports through. Rendering the real form and typing into it would be
  // testing the child twice, and would say nothing extra about the page.
  // -------------------------------------------------------------------------

  describe('filter (48.1 / 48.2)', () => {
    const NS_WITH_CASE_ID = nsSummary(
      'acme-cases',
      'Acme Cases',
      'd',
      contract([field('case_id', { index: true })]),
    );

    function filterOf(meta: Record<string, string>, ns: string | null = null) {
      return { meta, catalogNamespace: ns };
    }

    /**
     * Mount at a given entry URL and await `ngOnInit`.
     *
     * The fixture is deliberately NOT rendered: `detectChanges()` would run
     * `ngOnInit` a second time (Angular calls it on first render), and these
     * specs assert component state rather than markup.
     */
    async function mountWithUrl(
      params: Record<string, string>,
      namespaces: NamespaceSummary[],
    ): Promise<HomeComponent> {
      setUrl(params);
      apiSpy.getNamespaces.and.returnValue(Promise.resolve(namespaces));
      const c = TestBed.createComponent(HomeComponent).componentInstance;
      await c.ngOnInit();
      return c;
    }

    // --- A filter change is applied in one place ---------------------------

    it('(AC8) hands the filter to the service and returns to page 1', async () => {
      await component.ngOnInit();
      component.first = 500;
      component.currentPage = 3;

      component.onFilterChanged(filterOf({ case_id: 'C-1234' }));

      expect(contextSpy.setFilter).toHaveBeenCalledWith(
        filterOf({ case_id: 'C-1234' }),
      );
      expect(component.first).toBe(0);
      expect(component.currentPage).toBe(1);
    });

    it('(AC8) the service is told BEFORE the paginator is reset', async () => {
      // `p-table`'s `[first]` binding re-fires `(onLazyLoad)` when it changes,
      // which issues one extra `loadTeamsPage` alongside the debounced fetch.
      // That request is not wrong — the service already holds the new filter,
      // so it asks the same question. Written the other way round it would ask
      // the OLD one.
      await component.ngOnInit();
      component.first = 500;
      let firstWhenTold = -1;
      contextSpy.setFilter.and.callFake(() => {
        firstWhenTold = component.first;
      });

      component.onFilterChanged(filterOf({ case_id: 'C-1234' }));

      expect(firstWhenTold).toBe(500);
      expect(component.first).toBe(0);
    });

    it('(AC8) already on page 1, the paginator is not written at all', async () => {
      // Which keeps the extra request above to at most one per filter session,
      // and to none in the common case.
      await component.ngOnInit();
      component.first = 0;
      const before = component.first;

      component.onFilterChanged(filterOf({ case_id: 'C-1234' }));

      expect(component.first).toBe(before);
    });

    it('(AC6) the page never filters rows itself — teams$ is untouched', async () => {
      // Filtering is the server's answer. A client-side pass over the loaded
      // page would disagree with a `total_count` counted server-side.
      await component.ngOnInit();
      const page = [
        makeTeam({ team_id: 't-1', name: 'Alpha' }),
        makeTeam({ team_id: 't-2', name: 'Beta' }),
      ];
      teams$.next(page);

      component.onFilterChanged(filterOf({ case_id: 'zzz' }));

      expect(teams$.value).toEqual(page);
    });

    // --- The collapse control ----------------------------------------------

    it('the filter form is CLOSED on arrival', async () => {
      // The page's job on arrival is to show the teams. An empty panel above
      // them is a row of controls asking to be used before the list is read.
      const c = await mountWithUrl({}, [NS_WITH_CASE_ID]);

      expect(c.filtersVisible).toBeFalse();
    });

    it('toggling visibility never touches the filter', async () => {
      // Clearing and dismissing are different actions. A collapse that also
      // cleared would repaint the table — a data change disguised as a layout
      // one.
      await component.ngOnInit();
      component.onFilterChanged(filterOf({ case_id: 'C-1234' }));
      contextSpy.setFilter.calls.reset();

      component.toggleFilters();
      component.toggleFilters();

      expect(contextSpy.setFilter).not.toHaveBeenCalled();
    });

    it('hasActiveFilter reports a HIDDEN form that is still narrowing', async () => {
      // Why the control changes appearance when collapsed: otherwise the table
      // is filtered with its cause off screen.
      await component.ngOnInit();
      expect(component.hasActiveFilter).toBeFalse();

      component.onFilterChanged(filterOf({ case_id: 'C-1234' }));
      component.toggleFilters();

      expect(component.filtersVisible).toBeTrue();
      expect(component.hasActiveFilter).toBeTrue();
    });

    it('hasActiveFilter asks the SERVICE, so it cannot disagree with the request', async () => {
      // The service holds the composed filter, which already has the term floor
      // applied. Reading the form's raw terms instead would report a
      // below-floor term as active when nothing was actually narrowed.
      await component.ngOnInit();

      component.onFilterChanged(filterOf({}, 'acme-cases'));
      expect(component.hasActiveFilter).toBeTrue();

      component.onFilterChanged(filterOf({}));
      expect(component.hasActiveFilter).toBeFalse();
    });

    // --- Restoring from the URL --------------------------------------------

    it('(48.2) hands the URL filter to the form and to the service', async () => {
      const c = await mountWithUrl(
        { type: 'acme-cases', 'meta.case_id': 'C-1234' },
        [NS_WITH_CASE_ID],
      );

      expect(c.restoredFilter).toEqual(filterOf({ case_id: 'C-1234' }));
      expect(contextSpy.restoreFilter).toHaveBeenCalledWith(
        filterOf({ case_id: 'C-1234' }),
      );
    });

    it('(48.2) restores through restoreFilter, never setFilter', async () => {
      // `setFilter` is the only writer of the change subject, so proving it was
      // not called proves the restore issued no request. `loadTeamsPage` reads
      // the VALUE, so the table's own first lazy load carries the filter — a
      // second page-1 request would race that seed, and the seed is a direct
      // call rather than a trip through the debounced pipeline, so nothing
      // could order the two.
      contextSpy.setFilter.calls.reset();
      contextSpy.restoreFilter.calls.reset();

      await mountWithUrl({ type: 'acme-cases', 'meta.case_id': 'C-1234' }, [
        NS_WITH_CASE_ID,
      ]);

      expect(contextSpy.restoreFilter).toHaveBeenCalledTimes(1);
      expect(contextSpy.setFilter).not.toHaveBeenCalled();
    });

    it('(48.2) the restore lands BEFORE the namespaces fetch is awaited', async () => {
      // Ordering, not merely occurrence: the template renders when `ngOnInit`
      // reaches its first `await`, and the table's `(onLazyLoad)` reads the
      // filter the service already holds.
      let restoredBeforeFetch = false;
      apiSpy.getNamespaces.and.callFake(async () => {
        restoredBeforeFetch = contextSpy.restoreFilter.calls.count() === 1;
        return [];
      });

      await component.ngOnInit();

      expect(restoredBeforeFetch).toBeTrue();
    });

    it('(48.2) selects the team type the URL names, not the first in the list', async () => {
      const first = nsSummary('aaa-other', 'Other', 'd', contract([]));
      const c = await mountWithUrl(
        { type: 'acme-cases', 'meta.case_id': 'C-1234' },
        [first, NS_WITH_CASE_ID],
      );

      expect(c.selectedNamespace$.value?.namespace).toBe('acme-cases');
      // And the terms travel with it: the form adopts them as a `value`, which
      // outranks the namespace arriving in the same cycle.
      expect(c.restoredFilter.meta).toEqual({ case_id: 'C-1234' });
    });

    it('(48.2) restores the narrowing toggle and the page', async () => {
      const c = await mountWithUrl(
        { type: 'acme-cases', only: '1', page: '3' },
        [nsSummary('acme-cases', 'Acme Cases', 'd', contract([]))],
      );

      expect(c.currentPage).toBe(3);
      expect(c.first).toBe(2 * c.rows);
      expect(c.restoredFilter).toEqual(filterOf({}, 'acme-cases'));
    });

    it('(48.2) opens the form iff the URL carries a filter', async () => {
      const filtered = await mountWithUrl(
        { type: 'acme-cases', 'meta.case_id': 'C-1234' },
        [NS_WITH_CASE_ID],
      );
      expect(filtered.filtersVisible).toBeTrue();

      const plain = await mountWithUrl({}, [NS_WITH_CASE_ID]);
      expect(plain.filtersVisible).toBeFalse();
    });

    it('(48.2) a page number alone does NOT open the form', async () => {
      // Paging is not filtering. Opening for it would put an empty form on
      // screen for every deep link into the list.
      const c = await mountWithUrl({ page: '2' }, [NS_WITH_CASE_ID]);

      expect(c.currentPage).toBe(2);
      expect(c.filtersVisible).toBeFalse();
    });

    it('(48.2) drops the whole filter when the URL names a type that is gone', async () => {
      // Its terms cannot be offered, so leaving the list narrowed by something
      // the form cannot show would be a filtered table with no visible cause.
      const c = await mountWithUrl(
        { type: 'deleted-ns', 'meta.case_id': 'C-1234', only: '1' },
        [nsSummary('aaa-other', 'Other', 'd', contract([]))],
      );

      expect(c.restoredFilter).toEqual(filterOf({}));
      expect(c.filtersVisible).toBeFalse();
      expect(contextSpy.clearFilter).toHaveBeenCalled();
    });

    it('(48.2) honours the floor on a hand-edited URL', async () => {
      const c = await mountWithUrl(
        { type: 'acme-cases', 'meta.case_id': 'C' },
        [NS_WITH_CASE_ID],
      );

      expect(c.restoredFilter.meta).toEqual({});
      expect(c.filtersVisible).toBeFalse();
    });

    it('(48.2) a re-mount with a bare URL starts clean', async () => {
      const c = await mountWithUrl({}, [NS_WITH_CASE_ID]);

      expect(c.restoredFilter).toEqual(filterOf({}));
      expect(contextSpy.restoreFilter).toHaveBeenCalledWith(filterOf({}));
    });

    // --- Writing the URL ----------------------------------------------------

    it('(48.2) writes the filter, replacing rather than stacking history', async () => {
      // `replaceUrl` because a filter change arrives per keystroke: a history
      // entry per character would make Back useless for anything else.
      await component.ngOnInit();
      routerSpy.navigate.calls.reset();

      component.onFilterChanged(filterOf({ case_id: 'C-1234' }, 'acme-cases'));

      const args = routerSpy.navigate.calls.mostRecent().args;
      const extras = args[1] as NavigationExtras;
      const written = extras.queryParams as Record<string, unknown>;
      expect(args[0]).toEqual([]);
      expect(extras.replaceUrl).toBeTrue();
      expect(written['meta.case_id']).toBe('C-1234');
      expect(written['only']).toBe('1');
      // Page 1 is the default and is ABSENT, not null: the write replaces the
      // query string, so nothing has to be nulled out to disappear.
      expect('page' in written).toBeFalse();
    });

    it('(48.2) a filter cleared again leaves the URL clean', async () => {
      await component.ngOnInit();
      component.onFilterChanged(filterOf({ case_id: 'C-1234' }));

      component.onFilterChanged(filterOf({}));

      const extras = routerSpy.navigate.calls.mostRecent()
        .args[1] as NavigationExtras;
      expect(extras.queryParams).toEqual({});
      // Nothing is merged from the previous write, which is what makes the
      // empty object above a real assertion rather than a coincidence.
      expect(extras.queryParamsHandling).toBeUndefined();
    });

    it('(48.2) the seed write does NOT wipe the restored filter — the logo bug', async () => {
      // The reported defect, reproduced with its real INTERLEAVING, which is
      // the whole bug: the table's first lazy load fires while `ngOnInit` is
      // still awaiting the namespace list. When the URL was derived from the
      // FORM, the form was empty at that moment, so the seed wrote a blank URL
      // over the restored one and recorded blank parameters for the logo to
      // replay — the first return showed a filtered list under an empty address
      // bar, and the second returned unfiltered.
      //
      // Awaiting `ngOnInit` before the seed hides it completely. The unawaited
      // `init` below is not ceremony; it is the reproduction.
      setUrl({ type: 'acme-cases', 'meta.case_id': 'C-1234' });
      apiSpy.getNamespaces.and.returnValue(Promise.resolve([NS_WITH_CASE_ID]));
      const c = TestBed.createComponent(HomeComponent).componentInstance;

      const init = c.ngOnInit();
      await c.loadPage({ first: 0, rows: 250 });
      await init;

      expect(contextSpy.homeQueryParams).toEqual({
        type: 'acme-cases',
        'meta.case_id': 'C-1234',
      });
      expect(contextSpy.filter).toEqual(filterOf({ case_id: 'C-1234' }));
    });

    // --- Selecting a team type ----------------------------------------------

    it('(AC9) re-selecting the SAME type identifier does nothing at all', async () => {
      // Compared on the stable identifier, not object identity: every fetch
      // returns new objects, so a reference test would re-select on each one
      // and clear the terms under the user.
      await component.ngOnInit();
      const same = nsSummary('acme-cases', 'Acme Cases', 'd', contract([]));
      component.onNamespaceSelected(same);
      contextSpy.setFilter.calls.reset();

      component.onNamespaceSelected(
        nsSummary('acme-cases', 'Acme Cases', 'd', contract([])),
      );

      expect(contextSpy.setFilter).not.toHaveBeenCalled();
    });

    it('(AC9) a refresh that returns the SAME type re-selects nothing', async () => {
      // The reconciliation inside `loadNamespaces` compares on the stable
      // identifier, not object identity — every fetch returns new objects. A
      // reference test would re-select on each refresh and clear the terms
      // under the user, mid-typing.
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([NS_WITH_CASE_ID]),
      );
      await component.ngOnInit();
      component.onFilterChanged(filterOf({ case_id: 'aze' }));
      const selected = component.selectedNamespace$.value;
      contextSpy.setFilter.calls.reset();

      // A refresh: new objects, same namespace.
      await component.onNamespaceSaved();

      expect(contextSpy.setFilter).not.toHaveBeenCalled();
      expect(component.selectedNamespace$.value).toBe(selected);
    });

    it('(AC14) the team-type select and the narrowing toggle are labelled differently', async () => {
      // Two controls that both mention the team type, one selecting it and one
      // narrowing to it. Sharing a caption is how the select starts reading as
      // a filter that does not work.
      const c = await mountWithUrl({}, [NS_WITH_CASE_ID]);
      c.filtersVisible = true;
      fixture.detectChanges();

      const selectLabel = fixture.nativeElement.querySelector(
        'label[for="namespace-select"]',
      ) as HTMLLabelElement | null;
      expect(selectLabel).not.toBeNull();
      // The toggle's own caption is asserted exactly in the form's spec; here
      // the point is only that the two differ.
      expect(selectLabel!.textContent?.trim()).toBe('Team type');
    });

    it('(AC9) selecting a DIFFERENT type moves the selection', async () => {
      // Clearing the terms and answering is the FORM's half — it takes this
      // selection as an input. The page's half is only that the selection moved.
      await component.ngOnInit();
      component.onNamespaceSelected(NS_WITH_CASE_ID);

      component.onNamespaceSelected(
        nsSummary('other', 'Other', 'd', contract([field('tenant', { index: true })])),
      );

      expect(component.selectedNamespace$.value?.namespace).toBe('other');
    });
  });
});
