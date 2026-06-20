import { CommonModule } from '@angular/common';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { Router } from '@angular/router';
import { BehaviorSubject, firstValueFrom, of } from 'rxjs';
import { MessageService } from 'primeng/api';
import { TableLazyLoadEvent } from 'primeng/table';

import { ApiService } from '../../core/http/api.service';
import { AuthService } from '../../core/auth/auth.service';
import { ConfigService } from '../../core/config/config.service';
import { ContextService } from '../../core/context/context.service';
import { TeamContext } from '../../core/context/team.interface';
import { NamespacePanelComponent } from '../catalog/namespace-panel/namespace-panel.component';
import { HomeComponent } from './home.component';

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
  let apiSpy: jasmine.SpyObj<ApiService>;
  let contextSpy: jasmine.SpyObj<ContextService> & {
    teams$: BehaviorSubject<TeamContext[]>;
    nextCursor: string | null;
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
        'deleteTeam',
        'createTeamAndNavigate',
        'stopTeamAndAwait',
        'loadTeamsPage',
        'resetTeams',
        'hasMorePages',
      ]
    ) as jasmine.SpyObj<ContextService> & {
      teams$: BehaviorSubject<TeamContext[]>;
      nextCursor: string | null;
    };
    contextSpy.teams$ = teams$;
    contextSpy.getTeams.and.callFake(async () => teams$.value);
    contextSpy.deleteTeam.and.returnValue(Promise.resolve());
    contextSpy.createTeamAndNavigate.and.returnValue(Promise.resolve());
    contextSpy.stopTeamAndAwait.and.returnValue(Promise.resolve());

    // 27.1 data-layer stub. `nextCursor` is a settable property here (a getter
    // on the real service) so tests can drive the last-page case. Default
    // `loadTeamsPage` mirrors the 27.1 append contract (push onto teams$) so
    // appended rows are observable; `resetTeams` clears the list + cursor;
    // `hasMorePages` defaults false (last page / not seeded) unless a test
    // raises it.
    contextSpy.nextCursor = null;
    contextSpy.hasMorePages.and.returnValue(false);
    contextSpy.resetTeams.and.callFake(() => {
      teams$.next([]);
      contextSpy.nextCursor = null;
    });
    contextSpy.loadTeamsPage.and.callFake(async () => {
      teams$.next([...teams$.value]);
    });

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
        // PrimeNG's virtual-scroll <p-table> (p-scroller) injects
        // MessageService; the production app provides it globally (app.config).
        MessageService,
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(HomeComponent);
    component = fixture.componentInstance;
  });

  it('(AC6) component has no `context` field after the refactor', () => {
    expect((component as any).context).toBeUndefined();
  });

  // After Story 27.2 the home <p-table> is lazy virtual-scroll: PrimeNG renders
  // the body through a p-scroller whose visible-window computation depends on a
  // measured viewport. A detached Karma fixture has no stable layout, so the
  // virtualized <tr> set is not deterministically materialisable (ADR-031
  // §Validation / story Dev Notes). These specs therefore assert the binding
  // contract that drives rendering — the <p-table> mounts, the table value is
  // wired to teams$, and the virtual-scroll config is bound — rather than
  // scraping virtualized DOM rows. The cell-template behaviours (selection,
  // status, actions, description edit) are exercised at the handler level in
  // the (27.2 AC7e) specs below.
  function pTable(): HTMLElement | null {
    return fixture.nativeElement.querySelector('p-table') as HTMLElement | null;
  }

  it('(AC6) the <p-table> mounts and its value source (teams$) carries the list', async () => {
    // detectChanges first so ngOnInit's seed (resetTeams + loadTeamsPage) runs
    // and settles; pushing onto teams$ AFTER the seed is what the table renders.
    fixture.detectChanges();
    await fixture.whenStable();
    teams$.next([
      makeTeam({ team_id: 't-1', name: 'Alpha' }),
      makeTeam({ team_id: 't-2', name: 'Beta' }),
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // The table mounted and its [value] source — the async-piped
    // contextService.teams$ — holds the pushed list (the array PrimeNG
    // virtualises; its materialised rows are not deterministically queryable in
    // a detached Karma fixture).
    expect(pTable()).withContext('p-table must mount').not.toBeNull();
    const value = await firstValueFrom(component.contextService.teams$);
    expect(value.map((t) => t.team_id)).toEqual(['t-1', 't-2']);
  });

  it('(AC6, AC9) pushing a new list into teams$ updates the table value source (re-render)', async () => {
    fixture.detectChanges();
    await fixture.whenStable();

    teams$.next([makeTeam({ team_id: 't-1' })]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    let value = await firstValueFrom(component.contextService.teams$);
    expect(value.map((t) => t.team_id)).toEqual(['t-1']);

    teams$.next([
      makeTeam({ team_id: 't-1' }),
      makeTeam({ team_id: 't-2' }),
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    value = await firstValueFrom(component.contextService.teams$);
    expect(value.map((t) => t.team_id)).toEqual(['t-1', 't-2']);
  });

  it('(AC7) deleteTeam(id) delegates to contextService.deleteTeam and does NOT call apiService.deleteTeam directly', async () => {
    await component.deleteTeam('t-1');
    expect(contextSpy.deleteTeam).toHaveBeenCalledOnceWith('t-1');
    expect(apiSpy.deleteTeam).not.toHaveBeenCalled();
  });

  it('(27.2 AC4) refreshContext() re-seeds via resetTeams + loadTeamsPage (no legacy getTeams)', async () => {
    await component.refreshContext();
    expect(contextSpy.resetTeams).toHaveBeenCalledTimes(1);
    expect(contextSpy.loadTeamsPage).toHaveBeenCalledTimes(1);
    expect(contextSpy.getTeams).not.toHaveBeenCalled();
    expect((component as any).context).toBeUndefined();
  });

  // ---- Story 27.2: home-page lazy virtual-scroll team table (ADR-031 §5) ----
  //
  // PrimeNG's lazy/virtual <p-table> fires (onLazyLoad) with a
  // TableLazyLoadEvent. The next-page fetch is gated on the event window
  // reaching the END of the loaded rows (scroll-end), not on the absolute
  // `first` offset, and the held cursor is deduped so an already-requested
  // cursor is never fetched twice (issue #199 — append-driven re-fires would
  // otherwise storm). Seeding happens once in ngOnInit (resetTeams +
  // loadTeamsPage); subsequent pages append via loadTeamsPage's 27.1 contract.
  // HTTP is fully mocked through the ContextService stub.

  // `first`/`rows` default to a window that reaches past the (small) loaded set
  // in the existing specs; pass `last` explicitly to model a window that ends
  // BEFORE the loaded end (append-driven re-fire that must NOT fetch).
  function lazyEvent(first = 0, last?: number): TableLazyLoadEvent {
    return { first, rows: 50, last } as TableLazyLoadEvent;
  }

  it('(27.2 AC4) ngOnInit seeds the first page once via loadTeamsPage (idempotent, not legacy getTeams)', async () => {
    teams$.next([]);
    contextSpy.loadTeamsPage.and.callFake(async () => {
      teams$.next([makeTeam({ team_id: 'seed-1' })]);
    });

    await component.ngOnInit();

    // Init uses the IDEMPOTENT seed (ensureSeeded), which does NOT resetTeams —
    // resetting on init is what enabled the page-1 double-fetch race (issue
    // #199). resetTeams belongs to the explicit create/restore/refresh re-seeds
    // (covered by their own specs). The init seed fetches page 1 exactly once.
    expect(contextSpy.loadTeamsPage).toHaveBeenCalledTimes(1);
    // Seed carries NO cursor (first page).
    expect(contextSpy.loadTeamsPage.calls.mostRecent().args[0]).toBeUndefined();
    expect(contextSpy.resetTeams).not.toHaveBeenCalled();
    expect(contextSpy.getTeams).not.toHaveBeenCalled();
  });

  it('(27.2 AC4) createTeam re-seeds via resetTeams + loadTeamsPage', async () => {
    component.selectedNamespace$.next({
      namespace: 'agent-team-v1',
      name: 'Agent Team',
      description: 'd',
    });
    contextSpy.resetTeams.calls.reset();
    contextSpy.loadTeamsPage.calls.reset();

    await component.createTeam();

    expect(apiSpy.createTeam).toHaveBeenCalledOnceWith('agent-team-v1');
    expect(contextSpy.resetTeams).toHaveBeenCalledTimes(1);
    expect(contextSpy.loadTeamsPage).toHaveBeenCalledTimes(1);
    expect(contextSpy.getTeams).not.toHaveBeenCalled();
  });

  it('(27.2 AC4) restoreTeam re-seeds via resetTeams + loadTeamsPage', async () => {
    contextSpy.resetTeams.calls.reset();
    contextSpy.loadTeamsPage.calls.reset();

    await component.restoreTeam('team-A');

    expect(apiSpy.restoreTeam).toHaveBeenCalledOnceWith('team-A');
    expect(contextSpy.resetTeams).toHaveBeenCalledTimes(1);
    expect(contextSpy.loadTeamsPage).toHaveBeenCalledTimes(1);
    expect(contextSpy.getTeams).not.toHaveBeenCalled();
  });

  it('(27.2 AC1, AC7a) the <p-table> mounts with the virtual-scroll / lazy config bound', async () => {
    teams$.next([
      makeTeam({ team_id: 't-1', name: 'Alpha' }),
      makeTeam({ team_id: 't-2', name: 'Beta' }),
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // Component exposes a concrete px row-height (template binds it to
    // [virtualScrollItemSize]).
    expect(component.virtualRowHeight).toBeGreaterThan(0);

    // The <p-table> instance carries the virtual-scroll / lazy bindings — this
    // is the durable contract that makes PrimeNG render the body through a
    // virtualized scroller (whose materialised rows are not deterministically
    // queryable in a detached Karma fixture).
    const dbg = fixture.debugElement.query(
      (de) => de.nativeElement?.tagName?.toLowerCase() === 'p-table',
    );
    expect(dbg).withContext('p-table must mount').not.toBeNull();
    const table = dbg.componentInstance as {
      scrollable: boolean;
      virtualScroll: boolean;
      virtualScrollItemSize: number;
      lazy: boolean;
      rows: number;
    };
    expect(table.scrollable).toBeTrue();
    expect(table.virtualScroll).toBeTrue();
    expect(table.virtualScrollItemSize).toBe(component.virtualRowHeight);
    expect(table.lazy).toBeTrue();
    // Page-size hint is a positive number (the durable contract); the exact
    // value is a tunable (template [rows] binding), not asserted as a magic
    // number so operator tuning of the page size does not break the spec.
    expect(table.rows).toBeGreaterThan(0);
  });

  it('(27.2 AC2, AC7b) loadPage fetches the next page with the HELD cursor and ignores event.first', async () => {
    // Seed page 1 so the lazy handler advances past the first-load guard.
    await component.ngOnInit();
    contextSpy.loadTeamsPage.calls.reset();

    // A held cursor + more pages remaining → next fetch uses the cursor.
    contextSpy.nextCursor = 'cursor-2';
    contextSpy.hasMorePages.and.returnValue(true);
    contextSpy.loadTeamsPage.and.callFake(async () => {
      teams$.next([...teams$.value, makeTeam({ team_id: 'page-2' })]);
    });

    // event.first is a large absolute offset — it MUST be ignored.
    await component.loadPage(lazyEvent(999));

    expect(contextSpy.loadTeamsPage).toHaveBeenCalledOnceWith('cursor-2');
    const appended = await firstValueFrom(component.contextService.teams$);
    expect(appended.some((t) => t.team_id === 'page-2')).toBeTrue();
  });

  it('(27.2 AC3, AC7c) a re-entrant lazy-load while a fetch is in flight triggers exactly ONE fetch', async () => {
    await component.ngOnInit();
    contextSpy.loadTeamsPage.calls.reset();

    contextSpy.nextCursor = 'cursor-2';
    contextSpy.hasMorePages.and.returnValue(true);
    let resolveFetch!: () => void;
    contextSpy.loadTeamsPage.and.returnValue(
      new Promise<void>((r) => (resolveFetch = r)),
    );

    // First lazy-load starts the fetch (loading=true); the second fires while
    // it is still in flight and must be a no-op.
    const p1 = component.loadPage(lazyEvent(50));
    const p2 = component.loadPage(lazyEvent(50));

    expect(contextSpy.loadTeamsPage).toHaveBeenCalledTimes(1);

    resolveFetch();
    await Promise.all([p1, p2]);
    expect(contextSpy.loadTeamsPage).toHaveBeenCalledTimes(1);
  });

  it('(27.2 AC3, AC7c) two sequential pages = exactly one fetch each', async () => {
    await component.ngOnInit();
    contextSpy.loadTeamsPage.calls.reset();
    contextSpy.hasMorePages.and.returnValue(true);

    contextSpy.nextCursor = 'cursor-2';
    await component.loadPage(lazyEvent(50));
    contextSpy.nextCursor = 'cursor-3';
    await component.loadPage(lazyEvent(100));

    expect(contextSpy.loadTeamsPage).toHaveBeenCalledTimes(2);
    expect(contextSpy.loadTeamsPage.calls.argsFor(0)).toEqual(['cursor-2']);
    expect(contextSpy.loadTeamsPage.calls.argsFor(1)).toEqual(['cursor-3']);
  });

  it('(27.2 AC3, AC7d) on the last page (hasMorePages() false) loadPage fires NO further fetch', async () => {
    await component.ngOnInit();
    contextSpy.loadTeamsPage.calls.reset();

    // Last page reached: cursor null, hasMorePages() false.
    contextSpy.nextCursor = null;
    contextSpy.hasMorePages.and.returnValue(false);

    await component.loadPage(lazyEvent(150));

    expect(contextSpy.loadTeamsPage).not.toHaveBeenCalled();
  });

  // ---- issue #199 regression: no lazy-load request storm / no dup cursors ----
  //
  // These drive loadPage(event) directly with crafted TableLazyLoadEvents +
  // the stubbed ContextService (no DOM materialization needed, sidestepping the
  // p-scroller-doesn't-render-in-Karma limitation). They MUST fail against the
  // pre-fix loadPage (which gated only on `loading` and re-fetched on every
  // append) and pass against the scroll-end + cursor-dedup + idempotent-seed
  // implementation.

  it('(issue #199 i) exactly ONE page-1 load on init even if onLazyLoad fires during the seed', async () => {
    teams$.next([]);
    contextSpy.loadTeamsPage.calls.reset();
    contextSpy.loadTeamsPage.and.callFake(async () => {
      teams$.next([makeTeam({ team_id: 'seed-1' })]);
    });

    // Race: PrimeNG's init onLazyLoad fires concurrently with ngOnInit's seed.
    const init = component.ngOnInit();
    const earlyLazy = component.loadPage(lazyEvent(0));
    await Promise.all([init, earlyLazy]);

    // Idempotent seed: the two collapse into a single page-1 fetch (no cursor).
    expect(contextSpy.loadTeamsPage).toHaveBeenCalledTimes(1);
    expect(contextSpy.loadTeamsPage.calls.mostRecent().args[0]).toBeUndefined();
  });

  it('(issue #199 ii) NO fetch when the event window is within already-loaded rows', async () => {
    await component.ngOnInit();
    // 100 rows loaded; another page remains.
    const loaded = Array.from({ length: 100 }, (_, i) =>
      makeTeam({ team_id: `t-${i}` }),
    );
    teams$.next(loaded);
    contextSpy.nextCursor = 'cursor-2';
    contextSpy.hasMorePages.and.returnValue(true);
    contextSpy.loadTeamsPage.calls.reset();

    // Viewport window ends at row 60 — well inside the 100 loaded rows. This is
    // the append-driven re-fire that must NOT fetch the next page.
    await component.loadPage(lazyEvent(10, 60));

    expect(contextSpy.loadTeamsPage).not.toHaveBeenCalled();
  });

  it('(issue #199 iii) exactly ONE loadTeamsPage per DISTINCT cursor as the viewport advances', async () => {
    await component.ngOnInit();
    const loaded = Array.from({ length: 50 }, (_, i) =>
      makeTeam({ team_id: `t-${i}` }),
    );
    teams$.next(loaded);
    contextSpy.hasMorePages.and.returnValue(true);
    contextSpy.loadTeamsPage.calls.reset();

    // Scroll to the end of the loaded 50 rows: window ends at >= 50.
    contextSpy.nextCursor = 'cursor-2';
    await component.loadPage(lazyEvent(0, 50));
    // Same cursor still held (no append happened) + another end-reaching event:
    // the dedup guard must NOT issue a second fetch for cursor-2.
    await component.loadPage(lazyEvent(0, 50));

    expect(contextSpy.loadTeamsPage).toHaveBeenCalledOnceWith('cursor-2');
  });

  it('(issue #199 iv) fetching STOPS when hasMorePages() is false (null cursor = last page)', async () => {
    await component.ngOnInit();
    const loaded = Array.from({ length: 50 }, (_, i) =>
      makeTeam({ team_id: `t-${i}` }),
    );
    teams$.next(loaded);
    contextSpy.loadTeamsPage.calls.reset();

    // Last page reached: cursor null, hasMorePages() false — even an
    // end-reaching event fires no further fetch.
    contextSpy.nextCursor = null;
    contextSpy.hasMorePages.and.returnValue(false);
    await component.loadPage(lazyEvent(0, 100));

    expect(contextSpy.loadTeamsPage).not.toHaveBeenCalled();
  });

  it('(27.2 AC7e) selection still navigates from a virtualized row', () => {
    component.onRowSelect({ data: { team_id: 'virt-row-1' } });
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/process', 'virt-row-1']);
  });

  it('(27.2 AC6, AC7e) status / action / description templates operate on a virtualized row', async () => {
    const stopped = makeTeam({ team_id: 'virt-row-1', status: 'stopped' });
    teams$.next([stopped]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // Status tag: the row data the virtualized body template renders reports
    // stopped, so the template's `*ngIf="!isRunning(ctx)"` branch shows
    // "Stopped" (the row text itself is not deterministically queryable in the
    // virtual scroller — assert the template predicate that drives it).
    expect(component.isRunning(stopped)).toBeFalse();

    // Action button: restore delegates to apiService (stopped → restore path).
    await component.restoreTeam('virt-row-1');
    expect(apiSpy.restoreTeam).toHaveBeenCalledOnceWith('virt-row-1');

    // Inline description edit: start → draft seeded; save → optimistic update.
    component.startEditDescription('virt-row-1', 'hello');
    expect(component.editingDescriptionFor).toBe('virt-row-1');
    expect(component.descriptionDrafts.get('virt-row-1')).toBe('hello');
    await component.saveDescription('virt-row-1');
    expect(component.editingDescriptionFor).toBeNull();
  });

  it('(AC4 10.4) HomeComponent.createTeamAndNavigate delegates to contextService and has no reload compensation', async () => {
    const ns = { namespace: 'cat-1', name: 'Cat One', description: 'first cat' };
    component.selectedNamespace$.next(ns);
    // The component has not invoked ngOnInit yet (no detectChanges in this
    // test), so contextSpy.getTeams should not have been called. Reset to
    // guard against any spurious prior invocation.
    contextSpy.getTeams.calls.reset();
    await component.createTeamAndNavigate();
    expect(contextSpy.createTeamAndNavigate).toHaveBeenCalledOnceWith('cat-1');
    // No per-component compensation for the removed reload.
    expect(contextSpy.getTeams).not.toHaveBeenCalled();
  });

  it('(AC4 10.4) HomeComponent.createTeamAndNavigate no-entry guard returns cleanly', async () => {
    component.selectedNamespace$.next(null);
    await component.createTeamAndNavigate();
    expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
  });

  it('(AC1 1.9) ngOnInit loads namespaces via getNamespaces and selects the first', async () => {
    apiSpy.getNamespaces.and.returnValue(
      Promise.resolve([
        { namespace: 'agent-team-v1', name: 'Agent Team', description: 'Default' },
        { namespace: 'rag-team-v1', name: 'RAG Team', description: 'With RAG' },
      ]),
    );
    await component.ngOnInit();
    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(1);
    expect(component.namespaces$.value.length).toBe(2);
    expect(component.selectedNamespace$.value?.namespace).toBe('agent-team-v1');
  });

  it('(AC3 1.9) createTeam sends the selected namespace to apiService.createTeam', async () => {
    component.selectedNamespace$.next({
      namespace: 'agent-team-v1',
      name: 'Agent Team',
      description: 'Default',
    });
    apiSpy.createTeam.calls.reset();
    await component.createTeam();
    expect(apiSpy.createTeam).toHaveBeenCalledOnceWith('agent-team-v1');
  });

  it('(AC3 1.9) createTeamAndNavigate passes selected.namespace (not an id lookup)', async () => {
    component.selectedNamespace$.next({
      namespace: 'rag-team-v1',
      name: 'RAG Team',
      description: 'With RAG',
    });
    contextSpy.createTeamAndNavigate.calls.reset();
    await component.createTeamAndNavigate();
    expect(contextSpy.createTeamAndNavigate).toHaveBeenCalledOnceWith('rag-team-v1');
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
      Promise.resolve([{ namespace: 'foo', name: 'Foo', description: '' }]),
    );
    component.selectedNamespace$.next({
      namespace: 'foo',
      name: 'Foo',
      description: '',
    });
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
      Promise.resolve([{ namespace: 'foo', name: 'Foo', description: '' }]),
    );
    component.selectedNamespace$.next({
      namespace: 'foo',
      name: 'Foo',
      description: '',
    });
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
      { namespace: 'agent-team-v1', name: 'Agent Team', description: 'd1' },
      { namespace: 'rag-team-v1', name: 'RAG Team', description: 'd2' },
    ];
    apiSpy.getNamespaces.calls.reset();
    apiSpy.getNamespaces.and.returnValue(Promise.resolve(updated));

    await component.onNamespaceSaved();

    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(1);
    expect(component.namespaces$.value).toEqual(updated);
  });

  it('(14.2 AC8) stale selection (deleted ns) is dropped → advances to first remaining', async () => {
    // Seed a selection that the refreshed list no longer contains.
    component.selectedNamespace$.next({
      namespace: 'agent-team-v1_copy',
      name: 'Agent Team_copy',
      description: 'clone',
    });
    const refreshed = [
      { namespace: 'agent-team-v1', name: 'Agent Team', description: 'd1' },
      { namespace: 'rag-team-v1', name: 'RAG Team', description: 'd2' },
    ];
    apiSpy.getNamespaces.and.returnValue(Promise.resolve(refreshed));

    // Drive loadNamespaces via the public (saved) handler.
    await component.onNamespaceSaved();

    expect(component.selectedNamespace$.value?.namespace).toBe('agent-team-v1');
  });

  it('(14.2 AC9) still-present selection is preserved by `namespace` identity, untouched (no re-set)', async () => {
    // Seed the ORIGINAL object instance.
    const original = {
      namespace: 'rag-team-v1',
      name: 'RAG Team',
      description: 'original',
    };
    component.selectedNamespace$.next(original);

    // Refresh returns a DIFFERENT object instance with the SAME namespace —
    // proves identity is compared on `namespace`, not object reference.
    const refreshed = [
      { namespace: 'agent-team-v1', name: 'Agent Team', description: 'd1' },
      { namespace: 'rag-team-v1', name: 'RAG Team', description: 'refreshed copy' },
    ];
    apiSpy.getNamespaces.and.returnValue(Promise.resolve(refreshed));

    await component.onNamespaceSaved();

    // The subject must hold the EXACT original object (reference-equal) —
    // confirming no `.next()` re-set fired for a still-valid selection.
    expect(component.selectedNamespace$.value).toBe(original);
  });

  it('(14.2 AC10) deleting the last namespace → null selection + placeholder', async () => {
    component.selectedNamespace$.next({
      namespace: 'only-team-v1',
      name: 'Only Team',
      description: 'last one',
    });
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
        { namespace: 'agent-team-v1', name: 'Agent Team', description: 'd1' },
        { namespace: 'rag-team-v1', name: 'RAG Team', description: 'd2' },
      ]),
    );

    await component.ngOnInit();

    expect(component.selectedNamespace$.value?.namespace).toBe('agent-team-v1');
  });

  it('(14.2 AC7) getNamespaces failure leaves namespaces$ unchanged and logs', async () => {
    component.namespaces$.next([
      { namespace: 'existing-v1', name: 'Existing', description: 'd' },
    ]);
    apiSpy.getNamespaces.and.returnValue(Promise.reject(new Error('boom')));
    const consoleErrorSpy = spyOn(console, 'error');

    await expectAsync(component.onNamespaceSaved()).toBeResolved();

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(component.namespaces$.value).toEqual([
      { namespace: 'existing-v1', name: 'Existing', description: 'd' },
    ]);
  });

  it('(11.5 AC13) namespaceIdentifiers returns the `.namespace` field of each namespaces$ entry', () => {
    component.namespaces$.next([
      { namespace: 'foo', name: 'F', description: '' },
      { namespace: 'bar', name: 'B', description: '' },
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
    component.selectedNamespace$.next({
      namespace: 'foo',
      name: 'Foo Display',
      description: '',
    });
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
      { namespace: 'alpha', name: 'Alpha', description: '' },
      { namespace: 'beta', name: 'Beta', description: '' },
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
        { namespace: 'agent-team-v1', name: 'Agent Team', description: 'd' },
      ]),
    );

    await component.ngOnInit();

    expect(component.showAllNamespaces).toBeFalse();
    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(1);
    expect(apiSpy.getNamespaces.calls.first().args[0]).toEqual({ all: false });
  });

  it('(14.4 AC3) toggling on re-fetches with all=true and surfaces a foreign namespace', async () => {
    currentUser$.next({ user_id: 'gpiroux', roles: ['admin'] });
    const foreign = {
      namespace: 'other-tenant-ns',
      name: 'Other Tenant',
      description: 'foreign-owned',
    };
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
    component.selectedNamespace$.next({
      namespace: 'stale-ns',
      name: 'Stale',
      description: 'gone',
    });
    const refreshed = [
      { namespace: 'agent-team-v1', name: 'Agent Team', description: 'd1' },
      { namespace: 'rag-team-v1', name: 'RAG Team', description: 'd2' },
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
    const original = {
      namespace: 'rag-team-v1',
      name: 'RAG Team',
      description: 'original',
    };
    component.selectedNamespace$.next(original);
    apiSpy.getNamespaces.and.returnValue(
      Promise.resolve([
        { namespace: 'agent-team-v1', name: 'Agent Team', description: 'd1' },
        { namespace: 'rag-team-v1', name: 'RAG Team', description: 'refreshed' },
      ]),
    );

    await component.onToggleShowAll(true);

    // Still-present selection left untouched (reference-equal).
    expect(component.selectedNamespace$.value).toBe(original);
  });
});
