import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import {
  ComponentFixture,
  fakeAsync,
  TestBed,
  tick,
} from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { Table, TableLazyLoadEvent, TableRowSelectEvent } from 'primeng/table';

import { TeamContext } from '../../../core/context/team.interface';
import {
  TeamDescriptionSave,
  TeamRowAction,
  TeamTableComponent,
} from './team-table.component';

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

/** A promise plus the handles to settle it, so a spec can hold work in flight. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let a macrotask turn elapse, which is when an unhandled rejection surfaces. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('TeamTableComponent', () => {
  let fixture: ComponentFixture<TeamTableComponent>;
  let component: TeamTableComponent;

  let lazyLoads: TableLazyLoadEvent[];
  let selected: string[];
  let stops: TeamRowAction[];
  let restores: TeamRowAction[];
  let deletes: string[];
  let saves: TeamDescriptionSave[];

  beforeEach(async () => {
    // NO PROVIDERS (AC2), and the list is deliberately empty rather than
    // omitted: this component injects nothing, and an `inject(ApiService)` /
    // `ContextService` / `Router` / `ActivatedRoute` creeping in would throw
    // NullInjectorError at `createComponent` below — every spec in this file
    // goes red at mount, which is exactly the alarm wanted. That is what makes
    // the table testable without standing up a page that loads namespaces.
    await TestBed.configureTestingModule({
      imports: [TeamTableComponent, FormsModule, NoopAnimationsModule],
      providers: [],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(TeamTableComponent);
    component = fixture.componentInstance;

    lazyLoads = [];
    selected = [];
    stops = [];
    restores = [];
    deletes = [];
    saves = [];
    component.lazyLoad.subscribe((e) => lazyLoads.push(e));
    component.rowSelected.subscribe((id) => selected.push(id));
    component.stopRequested.subscribe((a) => stops.push(a));
    component.restoreRequested.subscribe((a) => restores.push(a));
    component.deleteRequested.subscribe((id) => deletes.push(id));
    component.descriptionSaved.subscribe((s) => saves.push(s));

    component.rows = 250;
  });

  /** Bind a page of teams the way the host does, and render. */
  async function render(teams: TeamContext[] = []): Promise<void> {
    component.teams = teams;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function rows(): HTMLTableRowElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('tbody tr'));
  }

  function headerCells(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('thead th'));
  }

  /**
   * The action controls of one row, in template order: the stop-or-restore
   * control first, the delete control second.
   *
   * Queried by position inside the actions cell rather than by title, so the
   * assertions do not depend on how PrimeNG chooses to surface a `title` on
   * its own host element.
   */
  function actionButtons(row: HTMLTableRowElement): HTMLButtonElement[] {
    const cells = Array.from(row.querySelectorAll('td'));
    return Array.from(cells[cells.length - 1].querySelectorAll('button'));
  }

  function tableInstance(): Table {
    return fixture.debugElement.query(By.directive(Table)).componentInstance;
  }

  function descriptionInputs(): HTMLInputElement[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('.description-input'),
    );
  }

  // --- What it renders -----------------------------------------------------

  it('(AC1) renders one row per team, with today\'s six columns', async () => {
    await render([
      makeTeam({ team_id: 't-1', name: 'Alpha' }),
      makeTeam({ team_id: 't-2', name: 'Beta' }),
    ]);

    expect(rows().length).toBe(2);
    expect(headerCells().map((th) => th.textContent?.trim())).toEqual([
      'Name',
      'Metadata',
      'Creation Date',
      'Status',
      'Team ID',
      '',
    ]);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('t-1');
    expect(text).toContain('t-2');
  });

  it('(AC1) renders an EMPTY table without throwing', async () => {
    // The state every page spec starts in: header and paginator, no rows.
    await render([]);

    expect(rows().length).toBe(0);
    expect(headerCells().length).toBe(6);
    expect(
      fixture.nativeElement.querySelector('p-paginator, .p-paginator'),
    ).not.toBeNull();
  });

  it('(AC1) a NEW list pushed into [teams] re-renders the rows', async () => {
    await render([makeTeam({ team_id: 't-1' })]);
    expect(fixture.nativeElement.textContent as string).toContain('t-1');

    await render([makeTeam({ team_id: 't-1' }), makeTeam({ team_id: 't-2' })]);

    expect(rows().length).toBe(2);
    expect(fixture.nativeElement.textContent as string).toContain('t-2');
  });

  it('(AC2) mounts against a TestBed declaring NO providers', () => {
    // The whole point of the extraction: the table renders without a page that
    // loads namespaces, a router, or an HTTP client behind it.
    fixture.detectChanges();

    expect(component).toBeTruthy();
    expect(fixture.nativeElement.querySelector('p-table')).not.toBeNull();
  });

  it('renders the status tag from the row\'s own status', async () => {
    await render([
      makeTeam({ team_id: 'run-1', status: 'running' }),
      makeTeam({ team_id: 'stop-1', status: 'stopped' }),
    ]);

    expect(rows()[0].textContent).toContain('Running');
    expect(rows()[1].textContent).toContain('Stopped');
  });

  // --- The metadata column -------------------------------------------------

  it('renders one metadata chip per answered field, label and value', async () => {
    await render([
      makeTeam({ team_id: 't-1', metadata: { case_id: 'C-1234', tenant: 'acme' } }),
    ]);

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
    await render([makeTeam({ team_id: 't-1', metadata: null })]);

    const cell = fixture.nativeElement.querySelector('.team-metadata-cell');
    expect(cell).not.toBeNull();
    expect(cell.querySelectorAll('.team-metadata-chip').length).toBe(0);
    expect((cell.textContent as string).trim()).toBe('');
  });

  // --- The row's title (Epic 53) -------------------------------------------

  it('renders the nominated metadata field as the row title, type beneath it', async () => {
    // `name` is the team TYPE, identical on every team of a namespace, so a
    // filtered list of twenty reads as twenty copies of a row. The title is
    // what differs; it goes where a title belongs, and the type stays as a
    // quiet second line rather than being thrown away.
    component.titleKey = 'subject';
    await render([
      makeTeam({
        team_id: 't-1',
        name: 'Invoice Dispute',
        metadata: { subject: 'Late invoice for ACME', case_id: 'C-1234' },
      }),
    ]);

    const title = fixture.nativeElement.querySelector('[data-test="row-title"]');
    const type = fixture.nativeElement.querySelector('[data-test="row-team-type"]');
    expect(title.textContent.trim()).toBe('Late invoice for ACME');
    expect(type.textContent.trim()).toBe('Invoice Dispute');
  });

  it('(T2) takes the title OUT of the metadata chips — it is not shown twice', async () => {
    // The title is an ordinary metadata key. Promoted to a heading and left in
    // the chip set as well, it appears twice in one row, which reads as
    // duplicated data rather than as a layout choice.
    component.titleKey = 'subject';
    await render([
      makeTeam({
        team_id: 't-1',
        metadata: { subject: 'Late invoice', case_id: 'C-1234', tenant: 'acme' },
      }),
    ]);

    const chips = Array.from(
      fixture.nativeElement.querySelectorAll('.team-metadata-chip'),
    ) as HTMLElement[];
    expect(chips.length).toBe(2);
    expect(chips.some((c) => (c.textContent ?? '').includes('Late invoice'))).toBeFalse();
    expect(
      fixture.nativeElement.querySelector('[data-test="row-metadata-subject"]'),
    ).toBeNull();
  });

  it('(FR3) renders exactly as before when no field is nominated', async () => {
    // The default state of every deployment today, and the one this epic
    // promised not to disturb: the name cell is the team type and nothing
    // else, and the metadata key that would have been a title is a chip.
    await render([
      makeTeam({
        team_id: 't-1',
        name: 'Invoice Dispute',
        metadata: { subject: 'Late invoice', case_id: 'C-1234' },
      }),
    ]);

    expect(component.titleKey).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-test="row-title"]')).toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-test="row-team-type"]'),
    ).toBeNull();
    const name = fixture.nativeElement.querySelector('.team-name');
    expect(name.textContent.trim()).toBe('Invoice Dispute');
    expect(
      fixture.nativeElement.querySelectorAll('.team-metadata-chip').length,
    ).toBe(2);
  });

  it('(FR3) falls back to the team type for a team that answered no title', async () => {
    // A nomination is per NAMESPACE; answering it is per TEAM. Every team
    // created before the field existed is in this state.
    component.titleKey = 'subject';
    await render([
      makeTeam({ team_id: 't-1', name: 'Invoice Dispute', metadata: { case_id: 'C-1' } }),
    ]);

    expect(fixture.nativeElement.querySelector('[data-test="row-title"]')).toBeNull();
    expect(
      (fixture.nativeElement.querySelector('.team-name').textContent as string).trim(),
    ).toBe('Invoice Dispute');
  });

  it('(T5) falls back to the team type when generation returned an empty title', async () => {
    // The trap: `""` is a present key, so a truthiness check on the KEY passes
    // and the row gets a blank heading and no fallback — which reads as a
    // value that failed to load, and is strictly worse than the team type.
    component.titleKey = 'subject';
    await render([
      makeTeam({
        team_id: 't-1',
        name: 'Invoice Dispute',
        metadata: { subject: '   ' },
      }),
    ]);

    expect(fixture.nativeElement.querySelector('[data-test="row-title"]')).toBeNull();
    expect(
      (fixture.nativeElement.querySelector('.team-name').textContent as string).trim(),
    ).toBe('Invoice Dispute');
  });

  it('decides per ROW, so a titled and an untitled team can sit side by side', async () => {
    component.titleKey = 'subject';
    await render([
      makeTeam({ team_id: 't-1', name: 'Type A', metadata: { subject: 'Titled' } }),
      makeTeam({ team_id: 't-2', name: 'Type A', metadata: { case_id: 'C-2' } }),
    ]);

    const [first, second] = rows();
    expect(
      (first.querySelector('[data-test="row-title"]') as HTMLElement).textContent!.trim(),
    ).toBe('Titled');
    expect(second.querySelector('[data-test="row-title"]')).toBeNull();
    expect((second.querySelector('.team-name') as HTMLElement).textContent!.trim()).toBe(
      'Type A',
    );
  });

  it('(FR6) keeps the FULL title in a tooltip while the display truncates', async () => {
    // A generated line has no length contract. Truncation is CSS — nothing in
    // a unit suite can measure it — so what is pinned here is the part that
    // would silently lose data: the untruncated string stays reachable.
    const long = 'A generated title that runs on well past the width of any column';
    component.titleKey = 'subject';
    await render([makeTeam({ team_id: 't-1', metadata: { subject: long } })]);

    const title = fixture.nativeElement.querySelector(
      '[data-test="row-title"]',
    ) as HTMLElement;
    expect(title.getAttribute('title')).toBe(long);
    expect(title.classList).toContain('team-title');
  });

  it('(T4) renders a title containing markup as TEXT, never as markup', async () => {
    // The title is generated and therefore untrusted. The bar in a list row is
    // lower than in a chat bubble; the consequence is the same.
    const injected = '<img src="x" onerror="alert(1)">';
    component.titleKey = 'subject';
    await render([makeTeam({ team_id: 't-1', metadata: { subject: injected } })]);

    const title = fixture.nativeElement.querySelector(
      '[data-test="row-title"]',
    ) as HTMLElement;
    expect(title.textContent!.trim()).toBe(injected);
    expect(title.querySelector('img')).toBeNull();
    expect(title.children.length).toBe(0);
  });

  // --- The paginator contract ----------------------------------------------

  it('(AC14, 28.3 AC2/AC6a) is scrollable with a flex scroll height, lazy, and paginated', async () => {
    component.totalRecords = 1000;
    await render([makeTeam()]);

    const table = tableInstance();
    expect(table.scrollable).toBeTrue();
    expect(table.scrollHeight).toBe('flex');
    expect(table.lazy).toBeTrue();
    expect(table.paginator).toBeTrue();
    expect(
      fixture.nativeElement.querySelector('p-paginator, .p-paginator'),
    ).withContext('paginator must render below the scroll body').not.toBeNull();
  });

  it('(AC14, 28.3 AC4) does NOT enable virtual scroll', () => {
    fixture.detectChanges();

    expect(tableInstance().virtualScroll).toBeFalsy();
  });

  it('(AC14) [rows], [first] and [totalRecords] are the INPUTS, not constants', async () => {
    // Bound to values no constant would produce: a `[first]="0"` written into
    // the child's template passes every row-rendering spec in this file and
    // strands the paginator on page 1 for the whole application.
    component.rows = 25;
    component.first = 500;
    component.totalRecords = 1000;
    await render([makeTeam()]);

    const table = tableInstance();
    expect(table.rows).toBe(25);
    expect(table.first).toBe(500);
    expect(table.totalRecords).toBe(1000);
  });

  it('(AC14) reports the page as "{first}–{last} of {totalRecords}"', () => {
    fixture.detectChanges();

    const table = tableInstance();
    expect(table.showCurrentPageReport).toBeTrue();
    expect(table.currentPageReportTemplate).toBe(
      '{first}–{last} of {totalRecords}',
    );
  });

  it('(AC14) re-emits (onLazyLoad) VERBATIM through (lazyLoad)', async () => {
    await render([]);
    lazyLoads.length = 0;

    const event: TableLazyLoadEvent = { first: 500, rows: 250 };
    tableInstance().onLazyLoad.emit(event);

    // The SAME object, not a translation of it: the page owns the page
    // arithmetic and the seed-does-not-write-the-URL rule that goes with it.
    expect(lazyLoads.length).toBe(1);
    expect(lazyLoads[0]).toBe(event);
  });

  // --- Row selection -------------------------------------------------------

  it('(AC3) the p-table\'s (onRowSelect) is bound to this component', async () => {
    // The spec below calls `onRowSelect` directly, which proves what the method
    // does but not that the template still calls it. Driven from the table's
    // own emitter, the way the (onLazyLoad) spec above is, so a lost binding
    // goes red rather than silently detaching row-click navigation.
    await render([makeTeam({ team_id: 'row-1' })]);

    tableInstance().onRowSelect.emit({
      data: makeTeam({ team_id: 'row-1' }),
    } as TableRowSelectEvent<TeamContext>);

    expect(selected).toEqual(['row-1']);
  });

  it('(AC3) a row-select event carrying no data emits nothing', async () => {
    await render([makeTeam({ team_id: 'row-1' })]);

    component.onRowSelect({} as TableRowSelectEvent<TeamContext>);

    expect(selected).toEqual([]);
  });

  it('(AC3) selecting a row emits rowSelected with its team_id and nothing else', async () => {
    await render([makeTeam({ team_id: 'row-1', status: 'running' })]);

    component.onRowSelect({
      data: makeTeam({ team_id: 'row-1' }),
    } as TableRowSelectEvent<TeamContext>);

    expect(selected).toEqual(['row-1']);
    // Nothing else happens in the child: no busy mark, no editor, no other
    // output. Navigation is the page's decision.
    expect(component.stoppingTeams.size).toBe(0);
    expect(component.restoringTeams.size).toBe(0);
    expect(component.editingDescriptionFor).toBeNull();
    expect(deletes).toEqual([]);
    expect(stops).toEqual([]);
  });

  // --- Row actions and their in-flight marks -------------------------------

  it('(AC4) the stop control emits stopRequested and spins until the work settles', async () => {
    await render([makeTeam({ team_id: 'row-1', status: 'running' })]);

    actionButtons(rows()[0])[0].click();
    fixture.detectChanges();

    expect(stops.length).toBe(1);
    expect(stops[0].teamId).toBe('row-1');
    // The child called no service — it has none to call.
    expect(component.isStopping('row-1')).toBeFalse();

    const work = deferred();
    stops[0].track(work.promise);
    fixture.detectChanges();

    expect(component.isStopping('row-1')).toBeTrue();
    let button = actionButtons(rows()[0])[0];
    expect(button.querySelector('.pi-spinner')).not.toBeNull();
    expect(button.disabled).toBeTrue();

    work.resolve();
    await work.promise;
    fixture.detectChanges();

    expect(component.isStopping('row-1')).toBeFalse();
    button = actionButtons(rows()[0])[0];
    expect(button.querySelector('.pi-stop-circle')).not.toBeNull();
    expect(button.disabled).toBeFalse();
  });

  it('(AC5) the busy mark clears when the tracked work REJECTS', async () => {
    // The case a "clear when the next page arrives" design leaves spinning
    // forever: the reload never happens, because the action failed.
    const unhandled: PromiseRejectionEvent[] = [];
    const listener = (e: PromiseRejectionEvent): void => {
      unhandled.push(e);
    };
    window.addEventListener('unhandledrejection', listener);

    await render([makeTeam({ team_id: 'row-1', status: 'running' })]);
    actionButtons(rows()[0])[0].click();

    const work = deferred();
    stops[0].track(work.promise);
    expect(component.isStopping('row-1')).toBeTrue();

    work.reject(new Error('boom'));
    await macrotask();
    fixture.detectChanges();

    expect(component.isStopping('row-1')).toBeFalse();
    // And the rejection was consumed here, rather than surfacing as an
    // unhandled promise rejection on top of the page's own logging.
    window.removeEventListener('unhandledrejection', listener);
    expect(unhandled).toEqual([]);
  });

  it('(AC6) the restore control behaves the same way, and clears on a rejection', async () => {
    await render([makeTeam({ team_id: 'row-1', status: 'stopped' })]);

    actionButtons(rows()[0])[0].click();
    fixture.detectChanges();

    expect(restores.length).toBe(1);
    expect(restores[0].teamId).toBe('row-1');

    const work = deferred();
    restores[0].track(work.promise);
    fixture.detectChanges();

    expect(component.isRestoring('row-1')).toBeTrue();
    expect(
      actionButtons(rows()[0])[0].querySelector('.pi-spinner'),
    ).not.toBeNull();
    expect(actionButtons(rows()[0])[0].disabled).toBeTrue();

    work.reject(new Error('boom'));
    await macrotask();
    fixture.detectChanges();

    expect(component.isRestoring('row-1')).toBeFalse();
    expect(
      actionButtons(rows()[0])[0].querySelector('.pi-replay'),
    ).not.toBeNull();
  });

  it('(AC6) the marks are PER ROW — settling one leaves the other spinning', async () => {
    await render([
      makeTeam({ team_id: 'row-A', status: 'running' }),
      makeTeam({ team_id: 'row-B', status: 'running' }),
    ]);

    actionButtons(rows()[0])[0].click();
    actionButtons(rows()[1])[0].click();
    const workA = deferred();
    const workB = deferred();
    stops[0].track(workA.promise);
    stops[1].track(workB.promise);

    expect(component.isStopping('row-A')).toBeTrue();
    expect(component.isStopping('row-B')).toBeTrue();

    workA.resolve();
    await workA.promise;
    fixture.detectChanges();

    expect(component.isStopping('row-A')).toBeFalse();
    expect(component.isStopping('row-B')).toBeTrue();
    expect(actionButtons(rows()[1])[0].disabled).toBeTrue();

    workB.resolve();
    await workB.promise;

    expect(component.isStopping('row-B')).toBeFalse();
  });

  it('(AC7) the delete control emits deleteRequested and marks NO row busy', async () => {
    await render([makeTeam({ team_id: 'row-1', status: 'running' })]);

    actionButtons(rows()[0])[1].click();
    fixture.detectChanges();

    expect(deletes).toEqual(['row-1']);
    expect(component.stoppingTeams.size).toBe(0);
    expect(component.restoringTeams.size).toBe(0);
    expect(actionButtons(rows()[0])[1].disabled).toBeFalse();
  });

  // --- The inline description editor ---------------------------------------

  it('(AC8) clicking a description opens the editor for THAT ROW only', async () => {
    await render([
      makeTeam({ team_id: 'row-A', description: 'first' }),
      makeTeam({ team_id: 'row-B', description: 'second' }),
    ]);

    (rows()[0].querySelector('.team-description') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.editingDescriptionFor).toBe('row-A');
    expect(descriptionInputs().length).toBe(1);
    expect(descriptionInputs()[0].value).toBe('first');
    // The other row stays in display mode.
    expect(rows()[1].querySelector('.team-description')).not.toBeNull();
    expect(rows()[1].querySelector('.description-editor')).toBeNull();
  });

  it('(AC8) a null description opens the editor on an EMPTY string', async () => {
    await render([makeTeam({ team_id: 'row-A', description: null })]);

    (rows()[0].querySelector('.team-description') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.descriptionDrafts.get('row-A')).toBe('');
    expect(descriptionInputs()[0].value).toBe('');
  });

  it('(AC9) the opened input is focused, with its text SELECTED', fakeAsync(() => {
    // Asserted on the DOM, never on a spy. `@ViewChildren('descriptionInput')`
    // resolves against the template it is DECLARED in: declared on the page,
    // with the markup here, it silently resolves to nothing and `focus()`
    // becomes a no-op — while every assertion about the saved text goes on
    // passing. This is the only thing that sees it.
    component.teams = [makeTeam({ team_id: 'row-A', description: 'pick me' })];
    fixture.detectChanges();
    tick();
    fixture.detectChanges();

    (
      fixture.nativeElement.querySelector('.team-description') as HTMLElement
    ).click();
    fixture.detectChanges();
    // The focus call is deferred to a macrotask so the editor's input exists
    // by the time it runs.
    tick();
    fixture.detectChanges();

    const input = descriptionInputs()[0];
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('pick me'.length);
  }));

  it('(AC10) saving emits the TRIMMED description', async () => {
    await render([makeTeam({ team_id: 'row-A', description: 'before' })]);

    component.startEditDescription('row-A', '  spaced out  ');
    component.saveDescription('row-A');

    expect(saves.length).toBe(1);
    expect(saves[0].teamId).toBe('row-A');
    expect(saves[0].description).toBe('spaced out');
  });

  it('(AC10) saving an empty draft emits NULL, not an empty string', async () => {
    await render([makeTeam({ team_id: 'row-A', description: 'before' })]);

    component.startEditDescription('row-A', '   ');
    component.saveDescription('row-A');

    expect(saves[0].description).toBeNull();
  });

  it('(AC10) the ✗ control emits nothing and closes the editor', async () => {
    await render([makeTeam({ team_id: 'row-A', description: 'before' })]);
    (rows()[0].querySelector('.team-description') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    (
      rows()[0].querySelector('.description-cancel-btn') as HTMLElement
    ).click();
    fixture.detectChanges();

    expect(saves).toEqual([]);
    expect(component.editingDescriptionFor).toBeNull();
    expect(descriptionInputs().length).toBe(0);
  });

  it('(AC10) Escape emits nothing and closes the editor', async () => {
    await render([makeTeam({ team_id: 'row-A', description: 'before' })]);
    (rows()[0].querySelector('.team-description') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    descriptionInputs()[0].dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }),
    );
    fixture.detectChanges();

    expect(saves).toEqual([]);
    expect(component.editingDescriptionFor).toBeNull();
  });

  it('(AC11) the editor closes when the tracked save RESOLVES', async () => {
    await render([makeTeam({ team_id: 'row-A', description: 'before' })]);
    component.startEditDescription('row-A', 'after');
    component.saveDescription('row-A');

    const work = deferred();
    saves[0].track(work.promise);
    // Still open while the write is in flight.
    expect(component.editingDescriptionFor).toBe('row-A');

    work.resolve();
    await work.promise;
    await macrotask();

    expect(component.editingDescriptionFor).toBeNull();
  });

  it('(AC11) the editor STAYS OPEN with the typed text when the save rejects', async () => {
    // Closing on emit would discard everything typed at the one moment the
    // user needs it back.
    await render([makeTeam({ team_id: 'row-A', description: 'before' })]);
    component.startEditDescription('row-A', 'my careful wording');
    component.saveDescription('row-A');

    const work = deferred();
    saves[0].track(work.promise);
    work.reject(new Error('boom'));
    await macrotask();
    fixture.detectChanges();

    expect(component.editingDescriptionFor).toBe('row-A');
    expect(component.descriptionDrafts.get('row-A')).toBe('my careful wording');
    expect(descriptionInputs().length).toBe(1);
  });

  // --- Layout --------------------------------------------------------------

  it('(AC12) the HOST joins the page\'s flex/scroll chain', async () => {
    // A host element with no `display` of its own breaks Story 28.3's bounded
    // scroll region: the body stops scrolling and the paginator stops pinning.
    // Neither is visible to a unit test, so what is pinned here is the computed
    // style that makes them possible.
    await render([makeTeam()]);

    const host = getComputedStyle(fixture.nativeElement as HTMLElement);
    expect(host.display).toBe('flex');
    expect(host.flexDirection).toBe('column');
    expect(host.flexGrow).toBe('1');
    expect(host.minHeight).toBe('0px');
  });

  it('(AC12) the p-table inside it continues that chain', async () => {
    await render([makeTeam()]);

    const table = getComputedStyle(
      fixture.nativeElement.querySelector('p-table') as HTMLElement,
    );
    expect(table.display).toBe('flex');
    expect(table.flexDirection).toBe('column');
    expect(table.flexGrow).toBe('1');
    expect(table.minHeight).toBe('0px');
  });

  it('(AC13) a header cell is painted OPAQUE white', async () => {
    // [scrollable] gives the thead a sticky position for free, but the app
    // theme paints header cells `transparent` — so rows scroll THROUGH the
    // pinned labels unless this rule travels with the table.
    await render([makeTeam()]);

    expect(getComputedStyle(headerCells()[0]).backgroundColor).toBe(
      'rgb(255, 255, 255)',
    );
  });

  // --- Loading -----------------------------------------------------------

  it('passes `loading` through to the p-table, both ways', () => {
    // The binding IS the feature here: the component adds no logic of its own,
    // so an input that never reaches `p-table` would leave the spinner dead
    // with every other spec still green.
    component.teams = [makeTeam({ team_id: 't-1', name: 'Alpha' })];
    component.loading = true;
    fixture.detectChanges();

    const table = fixture.debugElement.query(By.css('p-table'));
    expect(table.componentInstance.loading).toBeTrue();

    component.loading = false;
    fixture.detectChanges();
    expect(table.componentInstance.loading).toBeFalse();
  });

  it('defaults to NOT loading', () => {
    // A table that arrives spinning before anything has been asked for would
    // announce work that is not happening.
    expect(component.loading).toBeFalse();
  });

  it('keeps the rows on screen while loading', () => {
    // The previous page stays accurate until the new one lands. Emptying the
    // table would read as "no team matches" — the exact answer the filter
    // exists to give — where dimmed rows read as "updating".
    component.teams = [
      makeTeam({ team_id: 't-1', name: 'Alpha' }),
      makeTeam({ team_id: 't-2', name: 'Beta' }),
    ];
    component.loading = true;
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Alpha');
    expect(text).toContain('Beta');
  });

});
