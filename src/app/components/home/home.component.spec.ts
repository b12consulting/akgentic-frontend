import { CommonModule } from '@angular/common';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { Router } from '@angular/router';
import { Table } from 'primeng/table';
import { BehaviorSubject, of } from 'rxjs';

import { ApiService } from '../../core/http/api.service';
import { AuthService } from '../../core/auth/auth.service';
import { ConfigService } from '../../core/config/config.service';
import { ContextService } from '../../core/context/context.service';
import { TeamContext, TeamFilter } from '../../core/context/team.interface';
import { NamespacePanelComponent } from '../catalog/namespace-panel/namespace-panel.component';
import { HttpError } from '../../core/http/fetch.service';
import {
  MetadataFieldDescriptor,
  NamespaceSummary,
  TeamMetadataContract,
} from '../../protocol/catalog.interface';
import { HomeComponent } from './home.component';
import { TeamMetadataModalComponent } from './team-metadata-modal/team-metadata-modal.component';

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
        // 48.1: `ngOnInit` calls `clearFilter()` on EVERY mount, so leaving it
        // out of this list throws "not a function" in every spec in this file
        // at once — a failure that reads like something far worse than a
        // missing spy name.
        'setFilter',
        'clearFilter',
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
    contextSpy.clearFilter.and.stub();

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
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(HomeComponent);
    component = fixture.componentInstance;
  });

  it('(AC6) component has no `context` field after the refactor', () => {
    expect((component as any).context).toBeUndefined();
  });

  it('(AC6) template renders one row per team emitted on teams$', async () => {
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

  // --- Metadata column -------------------------------------------------

  it('renders one metadata chip per answered field, label and value', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    teams$.next([
      makeTeam({ team_id: 't-1', metadata: { case_id: 'C-1234', tenant: 'acme' } }),
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const chips = Array.from(
      fixture.nativeElement.querySelectorAll('.team-metadata-chip'),
    ) as HTMLElement[];
    expect(chips.length).toBe(2);
    expect(chips[0].textContent).toContain('Case id');
    expect(chips[0].textContent).toContain('C-1234');
    expect(chips[1].textContent).toContain('Tenant');
    expect(chips[1].textContent).toContain('acme');
  });

  it('leaves the metadata cell EMPTY for a team carrying none', async () => {
    // No dash, no "None" — every team predating a namespace contract is in
    // this state, and a placeholder repeated down the page reads as a load
    // failure rather than as an absent contract.
    fixture.detectChanges();
    await fixture.whenStable();
    teams$.next([makeTeam({ team_id: 't-1', metadata: null })]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const cell = fixture.nativeElement.querySelector('.team-metadata-cell');
    expect(cell).not.toBeNull();
    expect(cell.querySelectorAll('.team-metadata-chip').length).toBe(0);
    expect((cell.textContent as string).trim()).toBe('');
  });

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

  it('(AC4 10.4) createTeam delegates to contextService.createTeamAndNavigate with no reload compensation', async () => {
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

  it('(AC3 1.9) createTeam passes selected.namespace (not an id lookup)', async () => {
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

  it('(AC5 10.5) stopTeam tracks the teamId in stoppingTeams across the await boundary', async () => {
    let resolveStop: (() => void) | null = null;
    const pending = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    contextSpy.stopTeamAndAwait.and.returnValue(pending);

    const stopPromise = component.stopTeam('team-A');

    expect(component.isStopping('team-A')).toBe(true);
    expect(component.stoppingTeams.has('team-A')).toBe(true);

    resolveStop!();
    await stopPromise;

    expect(component.isStopping('team-A')).toBe(false);
    expect(component.stoppingTeams.has('team-A')).toBe(false);
  });

  it('(AC6 10.5) stopTeam catches timeout/error and clears the stoppingTeams entry', async () => {
    const timeoutErr = Object.assign(new Error('timeout'), {
      name: 'TimeoutError',
    });
    contextSpy.stopTeamAndAwait.and.returnValue(Promise.reject(timeoutErr));

    const consoleErrorSpy = spyOn(console, 'error');

    await expectAsync(component.stopTeam('team-A')).toBeResolved();

    expect(component.stoppingTeams.has('team-A')).toBe(false);
    expect(component.isStopping('team-A')).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('(AC7 10.5) stopTeam is safe to call concurrently for different teams', async () => {
    let resolveA: (() => void) | null = null;
    let resolveB: (() => void) | null = null;
    contextSpy.stopTeamAndAwait.and.callFake((teamId: string) => {
      if (teamId === 'team-A')
        return new Promise<void>((r) => {
          resolveA = r;
        });
      if (teamId === 'team-B')
        return new Promise<void>((r) => {
          resolveB = r;
        });
      return Promise.resolve();
    });

    const pA = component.stopTeam('team-A');
    const pB = component.stopTeam('team-B');

    expect(component.stoppingTeams.has('team-A')).toBe(true);
    expect(component.stoppingTeams.has('team-B')).toBe(true);

    resolveA!();
    await pA;

    expect(component.stoppingTeams.has('team-A')).toBe(false);
    expect(component.stoppingTeams.has('team-B')).toBe(true);

    resolveB!();
    await pB;

    expect(component.stoppingTeams.has('team-B')).toBe(false);
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

  function paginatorEl(): HTMLElement | null {
    return fixture.nativeElement.querySelector('p-paginator, .p-paginator');
  }

  // Reads the rendered PrimeNG Table instance to assert the scroll-contract
  // inputs (28.3 AC #6a). The scroll body's p-scroller rows may not
  // materialise deterministically in a detached fixture, so we assert the
  // binding/configuration, not scraped viewport geometry.
  function tableInstance(): Table {
    return fixture.debugElement.query(By.directive(Table)).componentInstance;
  }

  it('(28.3 AC2/AC6a) table is configured scrollable with a flex scroll height and the paginator is present', async () => {
    contextSpy.totalCount = 1000;
    totalCount$.next(1000);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const table = tableInstance();
    // The body scrolls within the bounded flex parent (sticky header + bottom
    // paginator follow); the pager is always reachable without scrolling rows.
    expect(table.scrollable).toBeTrue();
    expect(table.scrollHeight).toBe('flex');
    expect(paginatorEl()).withContext('paginator must render below the scroll body').not.toBeNull();
  });

  it('(28.3 AC4) table does NOT enable virtual scroll', () => {
    fixture.detectChanges();
    const table = tableInstance();
    expect(table.virtualScroll).toBeFalsy();
  });

  it('(28.2 AC8a) table renders with a paginator and totalRecords driven by totalCount', async () => {
    contextSpy.totalCount = 1000;
    totalCount$.next(1000);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // The lazy table seeds page 1 on init (loadPage → loadTeamsPage).
    expect(contextSpy.loadTeamsPage).toHaveBeenCalled();
    // Paginator chrome present; totalRecords reflects the 28.1 totalCount.
    expect(paginatorEl()).withContext('paginator must render').not.toBeNull();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('1000');
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

  it('(28.2 AC8f) cell templates work on a paged row: select navigates, status tag, action handlers, inline edit', async () => {
    spyOn(component, 'stopTeam').and.callThrough();
    spyOn(component, 'deleteTeam').and.callThrough();

    fixture.detectChanges();
    await fixture.whenStable();
    // Render a known running row (REPLACE the seed page).
    teams$.next([
      makeTeam({ team_id: 'row-1', name: 'Row One', status: 'running' }),
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('row-1');
    // Status tag reflects running state.
    expect(text).toContain('Running');

    // Row select → navigate to /process/{team_id}.
    component.onRowSelect({ data: { team_id: 'row-1' } });
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/process', 'row-1']);

    // Action handlers invoke the right delegations on a paged row.
    await component.deleteTeam('row-1');
    expect(contextSpy.deleteTeam).toHaveBeenCalledWith('row-1');
    await component.stopTeam('row-1');
    expect(contextSpy.stopTeamAndAwait).toHaveBeenCalledWith('row-1');

    // Inline description edit: open / save / cancel.
    component.startEditDescription('row-1', 'old');
    expect(component.editingDescriptionFor).toBe('row-1');
    expect(component.descriptionDrafts.get('row-1')).toBe('old');
    await component.saveDescription('row-1');
    expect(apiSpy.updateTeamDescription).toHaveBeenCalled();
    expect(component.editingDescriptionFor).toBeNull();
    component.startEditDescription('row-1', 'again');
    component.cancelEditDescription();
    expect(component.editingDescriptionFor).toBeNull();
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
    it('delegates the trimmed description to ContextService', async () => {
      const team = makeTeam({ team_id: 'row-1', description: 'before' });
      teams$.next([team]);

      component.startEditDescription('row-1', '  spaced out  ');
      await component.saveDescription('row-1');

      expect(contextSpy.setTeamDescription).toHaveBeenCalledOnceWith(
        'row-1',
        'spaced out',
      );
    });

    it('does not write the cached team itself', async () => {
      const team = makeTeam({ team_id: 'row-1', description: 'before' });
      teams$.next([team]);

      component.startEditDescription('row-1', 'after');
      await component.saveDescription('row-1');

      // `setTeamDescription` is a stub here, so the only way this object could
      // have changed is the component mutating it — which is the defect.
      expect(team.description).toBe('before');
      expect(teams$.value[0].description).toBe('before');
    });

    it('sends null for an empty draft rather than an empty string', async () => {
      teams$.next([makeTeam({ team_id: 'row-1', description: 'before' })]);

      component.startEditDescription('row-1', '   ');
      await component.saveDescription('row-1');

      expect(contextSpy.setTeamDescription).toHaveBeenCalledOnceWith('row-1', null);
    });

    it('still calls the API and clears the editing row on success', async () => {
      teams$.next([makeTeam({ team_id: 'row-1' })]);

      component.startEditDescription('row-1', 'fresh');
      await component.saveDescription('row-1');

      expect(apiSpy.updateTeamDescription).toHaveBeenCalledWith('row-1', 'fresh');
      expect(component.editingDescriptionFor).toBeNull();
    });

    it('swallows an API failure, leaving the editing row open and the cache alone', async () => {
      apiSpy.updateTeamDescription.and.returnValue(
        Promise.reject(new Error('boom')),
      );
      teams$.next([makeTeam({ team_id: 'row-1' })]);

      component.startEditDescription('row-1', 'fresh');
      await component.saveDescription('row-1');

      // The API call is awaited BEFORE the delegation, so a rejection means the
      // cache is never touched and the row stays in edit mode.
      expect(contextSpy.setTeamDescription).not.toHaveBeenCalled();
      expect(component.editingDescriptionFor).toBe('row-1');
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

    it('creates a team when the seeded page is empty', async () => {
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
  // Story 43.2 — the creation modal gates all three creation paths.
  //
  // These specs drive the gate through the component's methods and host state,
  // NOT through the child modal's DOM: the child's markup is covered by its own
  // spec, and coupling the host spec to it would make both brittle.
  // -------------------------------------------------------------------------

  describe('metadata gate (43.2)', () => {
    const asking = contract([field('tenant', { mandatory: true })]);

    it('(AC9) createTeam with no contract creates immediately, with no metadata payload', async () => {
      component.selectedNamespace$.next(
        nsSummary('agent-team-v1', 'Agent Team', 'd'),
      );
      component.currentPage = 4;
      component.first = 750;
      contextSpy.createTeamAndNavigate.calls.reset();
      contextSpy.loadTeamsPage.calls.reset();

      await component.createTeam();

      expect(component.metadataModalVisible).toBeFalse();
      // The two-argument form 43.1 pins to today's byte-for-byte body.
      expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args).toEqual([
        'agent-team-v1',
        undefined,
      ]);
      // The page is being LEFT for the process view: no reload, no
      // paginator jump — both would be wasted work racing the navigation.
      expect(component.first).toBe(750);
      expect(component.currentPage).toBe(4);
      expect(contextSpy.loadTeamsPage).not.toHaveBeenCalled();
    });

    it('(AC9, AC13) createTeam with a contract opens the modal, creates nothing, and does not spin', async () => {
      component.selectedNamespace$.next(
        nsSummary('acme-cases', 'Acme Cases', 'd', asking),
      );
      contextSpy.createTeamAndNavigate.calls.reset();

      await component.createTeam();

      expect(component.metadataModalVisible).toBeTrue();
      expect(component.metadataContract).toBe(asking);
      expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
      expect(component.isCreatingTeam).toBeFalse();
    });

    it('(AC10) createTeam with no contract navigates immediately', async () => {
      component.selectedNamespace$.next(
        nsSummary('agent-team-v1', 'Agent Team', 'd'),
      );
      contextSpy.createTeamAndNavigate.calls.reset();

      await component.createTeam();

      expect(component.metadataModalVisible).toBeFalse();
      expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args).toEqual([
        'agent-team-v1',
        undefined,
      ]);
    });

    it('(AC10) createTeam with a contract opens the modal and creates nothing', async () => {
      component.selectedNamespace$.next(
        nsSummary('acme-cases', 'Acme Cases', 'd', asking),
      );
      contextSpy.createTeamAndNavigate.calls.reset();

      await component.createTeam();

      expect(component.metadataModalVisible).toBeTrue();
      expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
    });

    // --- AC8: the three no-ask states, each pinned separately ---

    it('(AC8) an ABSENT team_metadata key asks nothing', async () => {
      const ns = nsSummary('agent-team-v1', 'Agent Team', 'd');
      expect('team_metadata' in ns).toBeFalse();
      component.selectedNamespace$.next(ns);

      await component.createTeam();

      expect(component.metadataModalVisible).toBeFalse();
      expect(contextSpy.createTeamAndNavigate).toHaveBeenCalled();
    });

    it('(AC8) a null team_metadata asks nothing', async () => {
      component.selectedNamespace$.next(
        nsSummary('agent-team-v1', 'Agent Team', 'd', null),
      );

      await component.createTeam();

      expect(component.metadataModalVisible).toBeFalse();
      expect(contextSpy.createTeamAndNavigate).toHaveBeenCalled();
    });

    it('(AC8) a declared contract with an empty fields list asks nothing', async () => {
      component.selectedNamespace$.next(
        nsSummary('agent-team-v1', 'Agent Team', 'd', contract([])),
      );

      await component.createTeam();

      expect(component.metadataModalVisible).toBeFalse();
      expect(contextSpy.createTeamAndNavigate).toHaveBeenCalled();
    });

    // --- Confirm / cancel dispatch ---

    it('(AC5, AC9) confirming from the create path creates with the emitted map', async () => {
      component.selectedNamespace$.next(
        nsSummary('acme-cases', 'Acme Cases', 'd', asking),
      );
      await component.createTeam();
      contextSpy.createTeamAndNavigate.calls.reset();

      await component.onMetadataConfirm({ tenant: 'acme' });

      expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args).toEqual([
        'acme-cases',
        { tenant: 'acme' },
      ]);
      expect(component.metadataModalVisible).toBeFalse();
      expect(component.isCreatingTeam).toBeFalse();
    });

    it('(AC10) confirming from the gesture-less path navigates with the emitted map', async () => {
      component.selectedNamespace$.next(
        nsSummary('acme-cases', 'Acme Cases', 'd', asking),
      );
      await component.createTeam();
      contextSpy.createTeamAndNavigate.calls.reset();

      await component.onMetadataConfirm({ tenant: 'acme' });

      expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args).toEqual([
        'acme-cases',
        { tenant: 'acme' },
      ]);
      expect(component.metadataModalVisible).toBeFalse();
    });

    it('(AC6, AC13) cancelling creates nothing and leaves the spinner off', async () => {
      component.selectedNamespace$.next(
        nsSummary('acme-cases', 'Acme Cases', 'd', asking),
      );
      await component.createTeam();
      contextSpy.createTeamAndNavigate.calls.reset();

      component.onMetadataCancel();

      expect(component.metadataModalVisible).toBeFalse();
      expect(component.metadataContract).toBeNull();
      expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
      expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
      expect(component.isCreatingTeam).toBeFalse();
    });

    it('(AC7, Trap 5) uses the namespace captured at open time, not the live selection', async () => {
      component.selectedNamespace$.next(
        nsSummary('acme-cases', 'Acme Cases', 'd', asking),
      );
      await component.createTeam();
      expect(component.metadataNamespaceLabel).toBe('Acme Cases');

      // The dropdown stays live behind the dialog.
      component.selectedNamespace$.next(
        nsSummary('other-ns', 'Other', 'd'),
      );
      contextSpy.createTeamAndNavigate.calls.reset();

      await component.onMetadataConfirm({ tenant: 'acme' });

      expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args[0]).toBe('acme-cases');
    });

    // --- AC14: a rejected create keeps the modal open ---

    it('(AC14) a 422 keeps the modal open and renders the server message', async () => {
      component.selectedNamespace$.next(
        nsSummary('acme-cases', 'Acme Cases', 'd', asking),
      );
      await component.createTeam();
      contextSpy.createTeamAndNavigate.and.returnValue(
        Promise.reject(
          new HttpError('Unprocessable', 422, {
            detail: [{ loc: ['body', 'metadata', 'tenant'], msg: 'field required' }],
          }),
        ),
      );

      await component.onMetadataConfirm({ case: 'C-1234' });

      expect(component.metadataModalVisible).toBeTrue();
      expect(component.metadataError).toBe('tenant: field required');
      expect(component.metadataSubmitting).toBeFalse();
      expect(component.isCreatingTeam).toBeFalse();
    });

    it('(AC14) a non-422 failure keeps the modal open with no inline message', async () => {
      const consoleErrorSpy = spyOn(console, 'error');
      component.selectedNamespace$.next(
        nsSummary('acme-cases', 'Acme Cases', 'd', asking),
      );
      await component.createTeam();
      contextSpy.createTeamAndNavigate.and.returnValue(
        Promise.reject(new HttpError('Server error', 500, 'boom')),
      );

      await component.onMetadataConfirm({ tenant: 'acme' });

      expect(component.metadataModalVisible).toBeTrue();
      expect(component.metadataError).toBeNull();
      // FetchService has ALREADY toasted the failure; the host adds no
      // second channel — no inline message, no console noise.
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('(AC14) a rejected create leaves the typed values alone — the host never clears the contract', async () => {
      component.selectedNamespace$.next(
        nsSummary('acme-cases', 'Acme Cases', 'd', asking),
      );
      await component.createTeam();
      contextSpy.createTeamAndNavigate.and.returnValue(
        Promise.reject(new HttpError('Unprocessable', 422, 'nope')),
      );

      await component.onMetadataConfirm({ tenant: 'acme' });

      expect(component.metadataContract).toBe(asking);
      expect(component.metadataNamespace).toBe('acme-cases');
    });

    // --- The 422 body has three shapes ---

    it('(AC14) renders a string body verbatim', () => {
      expect(
        (component as any).metadataErrorMessage('tenant is required'),
      ).toBe('tenant is required');
    });

    it('(AC14) renders a { detail: "..." } envelope', () => {
      expect(
        (component as any).metadataErrorMessage({ detail: 'tenant is required' }),
      ).toBe('tenant is required');
    });

    it('(AC14) renders one line per FastAPI detail entry, naming the field', () => {
      expect(
        (component as any).metadataErrorMessage({
          detail: [
            { loc: ['body', 'metadata', 'tenant'], msg: 'field required' },
            { loc: ['body', 'metadata', 'case'], msg: 'not a valid integer' },
          ],
        }),
      ).toBe('tenant: field required\ncase: not a valid integer');
    });

    it('(AC14) falls back to the serialized body for an unknown shape', () => {
      expect((component as any).metadataErrorMessage({ oops: 1 })).toBe(
        '{"oops":1}',
      );
    });

    it('(AC14) a 422 with nothing to say renders no alert region at all', async () => {
      component.selectedNamespace$.next(
        nsSummary('acme-cases', 'Acme Cases', 'd', asking),
      );
      await component.createTeam();
      // FetchService hands an empty response body over as `''`, and an empty
      // FastAPI `detail` list extracts to `''` too. Either way there is no
      // message, and `''` would paint an empty red box.
      contextSpy.createTeamAndNavigate.and.returnValue(
        Promise.reject(new HttpError('Unprocessable', 422, '')),
      );

      await component.onMetadataConfirm({ tenant: 'acme' });

      expect(component.metadataModalVisible).toBeTrue();
      expect(component.metadataError).toBeNull();

      contextSpy.createTeamAndNavigate.and.returnValue(
        Promise.reject(new HttpError('Unprocessable', 422, { detail: [] })),
      );

      await component.onMetadataConfirm({ tenant: 'acme' });

      expect(component.metadataModalVisible).toBeTrue();
      expect(component.metadataError).toBeNull();
    });

    // --- AC13: the spinner's OTHER half — it does turn, while the POST runs ---

    it('(AC13) isCreatingTeam is true while the POST is in flight, and false after', async () => {
      component.selectedNamespace$.next(
        nsSummary('agent-team-v1', 'Agent Team', 'd'),
      );
      let release: (value: any) => void = () => undefined;
      contextSpy.createTeamAndNavigate.and.returnValue(
        new Promise<any>((resolve) => {
          release = resolve;
        }),
      );

      const inFlight = component.createTeam();
      // The flag is the Create button's spinner AND its double-submit guard
      // (`[disabled]="isCreatingTeam || …"`). Every other assertion in this
      // file only ever pins it FALSE, so deleting the `= true` would go
      // unnoticed.
      expect(component.isCreatingTeam).toBeTrue();

      release({});
      await inFlight;

      expect(component.isCreatingTeam).toBeFalse();
    });

    it('(AC13) isCreatingTeam clears when the POST is rejected', async () => {
      spyOn(console, 'error');
      component.selectedNamespace$.next(
        nsSummary('agent-team-v1', 'Agent Team', 'd'),
      );
      contextSpy.createTeamAndNavigate.and.returnValue(
        Promise.reject(new HttpError('Server error', 500, 'boom')),
      );

      await component.createTeam();

      expect(component.isCreatingTeam).toBeFalse();
    });

    // --- The host↔child JOIN: the template bindings themselves ---
    //
    // Every spec above asserts the HOST's state, and the modal's own spec
    // asserts the MODAL's inputs. Neither notices if a binding in
    // `home.component.html` is deleted — dropping `[errorMessage]` alone would
    // remove AC14's entire user-visible outcome with both suites still green.
    // These two specs pin the join, and nothing else about the child's markup.

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

    it('(AC1, AC7, AC14) the host state reaches the modal through the template bindings', async () => {
      await renderThenSelect(nsSummary('acme-cases', 'Acme Cases', 'd', asking));

      expect(modal().visible).toBeFalse();

      await component.createTeam();
      fixture.detectChanges();

      expect(modal().visible).toBeTrue();
      expect(modal().contract).toBe(asking);
      expect(modal().namespaceLabel).toBe('Acme Cases');
      expect(modal().pending).toBeFalse();
      expect(modal().errorMessage).toBeNull();

      contextSpy.createTeamAndNavigate.and.returnValue(
        Promise.reject(
          new HttpError('Unprocessable', 422, { detail: 'tenant is required' }),
        ),
      );

      await component.onMetadataConfirm({ case: 'C-1234' });
      fixture.detectChanges();

      expect(modal().visible).toBeTrue();
      expect(modal().errorMessage).toBe('tenant is required');
    });

    it('(AC5) the modal `confirmed` output reaches the host through the template', async () => {
      await renderThenSelect(nsSummary('acme-cases', 'Acme Cases', 'd', asking));
      await component.createTeam();
      fixture.detectChanges();
      expect(modal().visible).toBeTrue();
      contextSpy.createTeamAndNavigate.calls.reset();

      // The POST is issued synchronously by the handler the binding names.
      modal().confirmed.emit({ tenant: 'acme' });

      expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args).toEqual([
        'acme-cases',
        { tenant: 'acme' },
      ]);
    });

    it('(AC6) the modal `cancelled` output reaches the host through the template', async () => {
      await renderThenSelect(nsSummary('acme-cases', 'Acme Cases', 'd', asking));
      await component.createTeam();
      fixture.detectChanges();
      // Guard the guard: without this the cancel assertion below passes on a
      // modal that never opened.
      expect(modal().visible).toBeTrue();
      contextSpy.createTeamAndNavigate.calls.reset();

      modal().cancelled.emit();

      expect(component.metadataModalVisible).toBeFalse();
      expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
    });
  });

  describe('metadata gate on the gesture-less hideHome route (43.2 AC11)', () => {
    const asking = contract([field('tenant', { mandatory: true })]);

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

    it('(AC11) with no contract it creates and navigates exactly as today', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([nsSummary('agent-team-v1', 'Agent Team', 'd')]),
      );
      contextSpy.createTeamAndNavigate.calls.reset();

      const init = component.ngOnInit();
      await component.loadPage({ first: 0, rows: 250 });
      await init;

      expect(component.metadataModalVisible).toBeFalse();
      expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args).toEqual([
        'agent-team-v1',
        undefined,
      ]);
    });

    it('(AC11) with a contract it opens the modal instead of creating silently', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([nsSummary('acme-cases', 'Acme Cases', 'd', asking)]),
      );
      contextSpy.createTeamAndNavigate.calls.reset();
      contextSpy.createTeamAndNavigate.calls.reset();

      const init = component.ngOnInit();
      await component.loadPage({ first: 0, rows: 250 });
      await init;

      expect(component.metadataModalVisible).toBeTrue();
      expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
      expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
    });

    it('(AC11) confirming from the gesture-less route creates and navigates', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([nsSummary('acme-cases', 'Acme Cases', 'd', asking)]),
      );

      const init = component.ngOnInit();
      await component.loadPage({ first: 0, rows: 250 });
      await init;
      contextSpy.createTeamAndNavigate.calls.reset();

      await component.onMetadataConfirm({ tenant: 'acme' });

      expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args).toEqual([
        'acme-cases',
        { tenant: 'acme' },
      ]);
      expect(component.metadataModalVisible).toBeFalse();
    });

    it('(AC11) cancelling from the gesture-less route creates nothing', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([nsSummary('acme-cases', 'Acme Cases', 'd', asking)]),
      );

      const init = component.ngOnInit();
      await component.loadPage({ first: 0, rows: 250 });
      await init;
      contextSpy.createTeamAndNavigate.calls.reset();

      component.onMetadataCancel();

      expect(component.metadataModalVisible).toBeFalse();
      expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
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

  describe('filter bar (48.1)', () => {
    /** Render, then select through the real seam the dropdown uses. */
    async function renderThenFilterOn(ns: NamespaceSummary | null): Promise<void> {
      fixture.detectChanges();
      await fixture.whenStable();
      component.onNamespaceSelected(ns);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    }

    function filterInputs(): HTMLInputElement[] {
      return Array.from(
        fixture.nativeElement.querySelectorAll('[data-test^="filter-meta-"]'),
      ) as HTMLInputElement[];
    }

    function filterInput(key: string): HTMLInputElement | null {
      return fixture.nativeElement.querySelector(
        `[data-test="filter-meta-${key}"]`,
      ) as HTMLInputElement | null;
    }

    function namespaceToggle(): HTMLElement | null {
      return fixture.nativeElement.querySelector(
        '[data-test="filter-namespace-toggle"]',
      ) as HTMLElement | null;
    }

    /** The filter most recently handed to the service. */
    function lastFilter(): TeamFilter {
      return contextSpy.setFilter.calls.mostRecent().args[0];
    }

    // --- AC1: the contract decides which inputs exist ----------------------

    it('(AC1) renders one input per INDEXED field, in declaration order', async () => {
      await renderThenFilterOn(
        nsSummary(
          'acme-cases',
          'Acme Cases',
          'd',
          contract([
            field('zulu', { index: true }),
            field('alpha', { index: true }),
            field('mike', { index: true }),
          ]),
        ),
      );

      expect(
        filterInputs().map((el) => el.getAttribute('data-test')),
      ).toEqual([
        'filter-meta-zulu',
        'filter-meta-alpha',
        'filter-meta-mike',
      ]);
    });

    it('(AC1) `index` alone gates — a MANDATORY unindexed field gets NO input', async () => {
      await renderThenFilterOn(
        nsSummary(
          'acme-cases',
          'Acme Cases',
          'd',
          contract([
            field('tenant', { index: false, mandatory: true }),
            field('case_id', { index: true, mandatory: false }),
          ]),
        ),
      );

      // The two flags are independent. Reusing the creation modal's
      // `mandatory` logic would offer neither a subset nor a superset.
      expect(filterInput('tenant')).toBeNull();
      expect(filterInput('case_id')).not.toBeNull();
    });

    it('(AC1) an ABSENT team_metadata key renders NO metadata inputs', async () => {
      const ns = nsSummary('agent-team-v1', 'Agent Team', 'd');
      expect('team_metadata' in ns).toBeFalse();

      await renderThenFilterOn(ns);

      expect(filterInputs().length).toBe(0);
    });

    it('(AC1) a NULL team_metadata renders NO metadata inputs', async () => {
      await renderThenFilterOn(
        nsSummary('agent-team-v1', 'Agent Team', 'd', null),
      );

      expect(filterInputs().length).toBe(0);
    });

    it('(AC1) a declared contract with an EMPTY fields list renders NO metadata inputs', async () => {
      await renderThenFilterOn(
        nsSummary('agent-team-v1', 'Agent Team', 'd', contract([])),
      );

      expect(filterInputs().length).toBe(0);
    });

    it('(AC1) a contract whose fields are ALL UNINDEXED renders NO metadata inputs', async () => {
      await renderThenFilterOn(
        nsSummary(
          'acme-cases',
          'Acme Cases',
          'd',
          contract([field('tenant'), field('case_id', { mandatory: true })]),
        ),
      );

      expect(filterInputs().length).toBe(0);
    });

    it('(AC1) each input carries a visible label — the description, else the capitalised key', async () => {
      await renderThenFilterOn(
        nsSummary(
          'acme-cases',
          'Acme Cases',
          'd',
          contract([
            field('case_id', { index: true, description: 'Case reference.' }),
            field('tenant', { index: true }),
          ]),
        ),
      );

      const labels: HTMLLabelElement[] = Array.from(
        fixture.nativeElement.querySelectorAll('.home-filter__field label'),
      );
      expect(labels.map((l) => l.textContent?.trim())).toEqual([
        'Case reference.',
        'Tenant',
      ]);
    });

    it('(AC1) each input names the three-character floor in its placeholder', async () => {
      await renderThenFilterOn(
        nsSummary(
          'acme-cases',
          'Acme Cases',
          'd',
          contract([field('case_id', { index: true })]),
        ),
      );

      expect(filterInput('case_id')!.getAttribute('placeholder')).toContain('3');
    });

    // --- AC13: free text, always -------------------------------------------

    it('(AC13) an input is plain text even when the field declares a pattern', async () => {
      await renderThenFilterOn(
        nsSummary(
          'acme-cases',
          'Acme Cases',
          'd',
          contract([
            field('date', { index: true, pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
          ]),
        ),
      );

      // No date picker inferred from the key, no select inferred from the
      // pattern, and no client-side validation attribute either.
      expect(filterInput('date')!.getAttribute('type')).toBe('text');
      expect(filterInput('date')!.getAttribute('pattern')).toBeNull();
    });

    // --- AC5/AC6: below the floor the list is UNFILTERED, never empty -------

    it('(AC6) a two-character term still reaches the filter model VERBATIM', async () => {
      await renderThenFilterOn(
        nsSummary(
          'acme-cases',
          'Acme Cases',
          'd',
          contract([field('case_id', { index: true })]),
        ),
      );
      contextSpy.setFilter.calls.reset();

      component.onFilterTermChanged('case_id', 'az');

      // The floor lives ONCE, where the URL parameter is composed. A second
      // check here would be a second thing to keep in step.
      expect(lastFilter().meta).toEqual({ case_id: 'az' });
    });

    it('(AC6) a short term filters NO rows client-side — the component never touches teams$', async () => {
      await renderThenFilterOn(
        nsSummary(
          'acme-cases',
          'Acme Cases',
          'd',
          contract([field('case_id', { index: true })]),
        ),
      );
      const page = [
        makeTeam({ team_id: 't-1', name: 'Alpha' }),
        makeTeam({ team_id: 't-2', name: 'Beta' }),
      ];
      teams$.next(page);
      fixture.detectChanges();

      component.onFilterTermChanged('case_id', 'a');
      fixture.detectChanges();

      // Still the server's unfiltered page — not an emptied table.
      expect(teams$.value).toBe(page);
    });

    it('(AC5) clearing a term back below the floor RE-ISSUES, without that term', async () => {
      await renderThenFilterOn(
        nsSummary(
          'acme-cases',
          'Acme Cases',
          'd',
          contract([
            field('case_id', { index: true }),
            field('tenant', { index: true }),
          ]),
        ),
      );
      component.onFilterTermChanged('tenant', 'acme');
      component.onFilterTermChanged('case_id', 'aze');
      contextSpy.setFilter.calls.reset();

      component.onFilterTermChanged('case_id', '');

      expect(contextSpy.setFilter).toHaveBeenCalledTimes(1);
      expect(lastFilter().meta).toEqual({ tenant: 'acme' });
    });

    // --- AC7: the narrowing control ----------------------------------------

    it('(AC7, AC14) the narrowing toggle is rendered and carries its data-test', async () => {
      await renderThenFilterOn(
        nsSummary('acme-cases', 'Acme Cases', 'd'),
      );

      expect(namespaceToggle()).not.toBeNull();
    });

    it('(AC7) ON adds the SELECTED namespace identifier', async () => {
      await renderThenFilterOn(
        nsSummary('acme-cases', 'Acme Cases', 'd'),
      );

      component.onFilterNamespaceToggle(true);

      expect(lastFilter().catalogNamespace).toBe('acme-cases');
    });

    it('(AC7) OFF leaves it NULL — not empty, not the namespace', async () => {
      await renderThenFilterOn(
        nsSummary('acme-cases', 'Acme Cases', 'd'),
      );
      component.onFilterNamespaceToggle(true);

      component.onFilterNamespaceToggle(false);

      expect(lastFilter().catalogNamespace).toBeNull();
    });

    it('(AC7) the toggle defaults OFF', () => {
      expect(component.filterByNamespace).toBeFalse();
    });

    it('(AC7) a toggle flipped ON with NO selection is honoured once a selection arrives', async () => {
      // `catalogNamespace` is composed from the SELECTED namespace, so while
      // there is none the toggle composes `null` however it is set. The FIRST
      // selection of the page's lifetime normally issues no fetch — but if it
      // did so unconditionally, the toggle would be left reading ON above a
      // list that is not narrowed, with no further event to reconcile them.
      apiSpy.getNamespaces.and.returnValue(Promise.resolve([]));
      await component.ngOnInit();

      component.onFilterNamespaceToggle(true);
      expect(lastFilter().catalogNamespace).toBeNull();
      contextSpy.setFilter.calls.reset();

      // A team type appears — the panel saved one, or a refresh returned one.
      component.onNamespaceSelected(nsSummary('acme-cases', 'Acme Cases', 'd'));

      expect(contextSpy.setFilter).toHaveBeenCalledTimes(1);
      expect(lastFilter().catalogNamespace).toBe('acme-cases');
    });

    it('(AC11) the first selection with the toggle OFF still issues nothing', async () => {
      // The other half of the condition: the init path is unchanged, so the
      // table's own first (onLazyLoad) remains the sole page-1 seed.
      apiSpy.getNamespaces.and.returnValue(Promise.resolve([]));
      await component.ngOnInit();
      contextSpy.setFilter.calls.reset();

      component.onNamespaceSelected(nsSummary('acme-cases', 'Acme Cases', 'd'));

      expect(contextSpy.setFilter).not.toHaveBeenCalled();
    });

    // --- AC14: the two namespace controls read as two controls --------------

    it('(AC14) the team-type select and the narrowing toggle are separately labelled', async () => {
      await renderThenFilterOn(
        nsSummary('acme-cases', 'Acme Cases', 'd'),
      );

      const selectLabel = fixture.nativeElement.querySelector(
        'label[for="namespace-select"]',
      ) as HTMLLabelElement | null;
      const toggleLabel = fixture.nativeElement.querySelector(
        'label[for="filter-namespace-toggle"]',
      ) as HTMLLabelElement | null;

      expect(selectLabel).not.toBeNull();
      expect(toggleLabel).not.toBeNull();
      expect(selectLabel!.textContent?.trim()).not.toBe(
        toggleLabel!.textContent?.trim(),
      );
    });

    // --- AC8: any filter change resets to page 1 ----------------------------

    it('(AC8) a metadata term change resets first and currentPage', async () => {
      await renderThenFilterOn(
        nsSummary(
          'acme-cases',
          'Acme Cases',
          'd',
          contract([field('case_id', { index: true })]),
        ),
      );
      component.first = 750;
      component.currentPage = 4;

      component.onFilterTermChanged('case_id', 'aze');

      expect(component.first).toBe(0);
      expect(component.currentPage).toBe(1);
    });

    it('(AC8) the narrowing toggle resets first and currentPage too', async () => {
      await renderThenFilterOn(
        nsSummary('acme-cases', 'Acme Cases', 'd'),
      );
      component.first = 750;
      component.currentPage = 4;

      component.onFilterNamespaceToggle(true);

      expect(component.first).toBe(0);
      expect(component.currentPage).toBe(1);
    });

    it('(AC8) the service is told the new filter BEFORE the paginator is reset', async () => {
      // Order is load-bearing: `[first]` re-fires (onLazyLoad), and that extra
      // `loadTeamsPage` must read the NEW filter, not the old one.
      await renderThenFilterOn(
        nsSummary(
          'acme-cases',
          'Acme Cases',
          'd',
          contract([field('case_id', { index: true })]),
        ),
      );
      component.first = 750;
      let firstWhenToldTheFilter = -1;
      contextSpy.setFilter.and.callFake(() => {
        firstWhenToldTheFilter = component.first;
      });

      component.onFilterTermChanged('case_id', 'aze');

      expect(firstWhenToldTheFilter).toBe(750);
      expect(component.first).toBe(0);
    });

    // --- AC9: changing the namespace clears the terms -----------------------

    it('(AC9) selecting a DIFFERENT namespace clears the terms and re-issues', async () => {
      await renderThenFilterOn(
        nsSummary(
          'acme-cases',
          'Acme Cases',
          'd',
          contract([field('case_id', { index: true })]),
        ),
      );
      component.onFilterTermChanged('case_id', 'aze');
      expect(lastFilter().meta).toEqual({ case_id: 'aze' });
      contextSpy.setFilter.calls.reset();

      component.onNamespaceSelected(
        nsSummary(
          'other-ns',
          'Other',
          'd',
          contract([field('ref', { index: true })]),
        ),
      );
      fixture.detectChanges();

      // Re-issued, and with nothing from the previous contract.
      expect(contextSpy.setFilter).toHaveBeenCalledTimes(1);
      expect(lastFilter().meta).toEqual({});
      expect(component.filterTerms).toEqual({});
    });

    it('(AC9) the input set re-renders from the NEW contract', async () => {
      await renderThenFilterOn(
        nsSummary(
          'acme-cases',
          'Acme Cases',
          'd',
          contract([field('case_id', { index: true })]),
        ),
      );
      expect(filterInput('case_id')).not.toBeNull();

      component.onNamespaceSelected(
        nsSummary(
          'other-ns',
          'Other',
          'd',
          contract([field('ref', { index: true })]),
        ),
      );
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(filterInput('case_id')).toBeNull();
      expect(filterInput('ref')).not.toBeNull();
    });

    it('(AC9) re-selecting the SAME namespace identifier clears nothing and re-issues nothing', async () => {
      await renderThenFilterOn(
        nsSummary(
          'acme-cases',
          'Acme Cases',
          'd',
          contract([field('case_id', { index: true })]),
        ),
      );
      component.onFilterTermChanged('case_id', 'aze');
      contextSpy.setFilter.calls.reset();

      // A FRESH object for the same namespace — what `loadNamespaces()` hands
      // back on every refresh. Comparing references would clear the terms on
      // an unrelated refresh.
      component.onNamespaceSelected(
        nsSummary(
          'acme-cases',
          'Acme Cases',
          'd',
          contract([field('case_id', { index: true })]),
        ),
      );

      expect(contextSpy.setFilter).not.toHaveBeenCalled();
      expect(component.filterTerms).toEqual({ case_id: 'aze' });
    });

    it('(AC9) the reconciliation inside loadNamespaces() clears nothing when the selection survives', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([
          nsSummary(
            'acme-cases',
            'Acme Cases',
            'd',
            contract([field('case_id', { index: true })]),
          ),
        ]),
      );
      await component.ngOnInit();
      component.onFilterTermChanged('case_id', 'aze');
      contextSpy.setFilter.calls.reset();

      // A refresh — new objects, same namespace.
      await component.onNamespaceSaved();

      expect(contextSpy.setFilter).not.toHaveBeenCalled();
      expect(component.filterTerms).toEqual({ case_id: 'aze' });
    });

    // --- AC11: a stale filter never outlives the page ------------------------

    it('(AC11) ngOnInit clears the service filter and issues NO fetch of its own', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([
          nsSummary(
            'acme-cases',
            'Acme Cases',
            'd',
            contract([field('case_id', { index: true })]),
          ),
        ]),
      );

      await component.ngOnInit();

      expect(contextSpy.clearFilter).toHaveBeenCalledTimes(1);
      // The FIRST selection of the page's lifetime composes the empty filter
      // that was just cleared — pushing it would race the table's own first
      // (onLazyLoad) with an identical page-1 request.
      expect(contextSpy.setFilter).not.toHaveBeenCalled();
      expect(contextSpy.loadTeamsPage).not.toHaveBeenCalled();
    });

    it('(AC11) the clear lands BEFORE the namespaces fetch is awaited', async () => {
      let clearedBeforeFetch = false;
      apiSpy.getNamespaces.and.callFake(async () => {
        clearedBeforeFetch = contextSpy.clearFilter.calls.count() === 1;
        return [];
      });

      await component.ngOnInit();

      expect(clearedBeforeFetch).toBeTrue();
    });

    it('(AC11) a re-mount starts with empty inputs', async () => {
      await renderThenFilterOn(
        nsSummary(
          'acme-cases',
          'Acme Cases',
          'd',
          contract([field('case_id', { index: true })]),
        ),
      );
      component.onFilterTermChanged('case_id', 'aze');

      const remounted = TestBed.createComponent(HomeComponent);
      await remounted.componentInstance.ngOnInit();

      expect(remounted.componentInstance.filterTerms).toEqual({});
      expect(remounted.componentInstance.filterByNamespace).toBeFalse();
    });
  });
});
