import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { RouterTestingModule } from '@angular/router/testing';
import { MessageService } from 'primeng/api';
import { BehaviorSubject } from 'rxjs';

import { AuthService } from '../../../core/auth/auth.service';
import { HttpError } from '../../../core/http/fetch.service';
import { ApiService } from '../../../core/http/api.service';
import { ENTRY_KINDS, EntryKind } from '../../../protocol/catalog.interface';
import {
  CatalogListComponent,
  DELETE_DENIED_REASON,
} from './catalog-list.component';
import { NamespaceRow, NamespaceRowsResult } from './namespace-row.model';
import { NamespaceRowsService } from './namespace-rows.service';

/**
 * Story 36-3 — the admin catalog table and its per-row authorization.
 *
 * THE POINT OF THIS FILE. On the community tier every caller is `anonymous`
 * AND every catalog entry's `user_id` is `anonymous`, so owner and caller
 * coincide for every row and `canModify` is true for everyone. The gate is
 * therefore INVISIBLE in a click-through — a manual run cannot tell the
 * correct predicate from `() => true`. These specs are the only evidence, and
 * they earn that by constructing a NON-OWNER caller explicitly, with `isAdmin`
 * stubbed INDEPENDENTLY of the user so the admin-non-owner case cannot
 * collapse into the owner case.
 *
 * Names are `acme` / `contoso` placeholders; they are incidental.
 */

const OWNER = 'u-owner';
const OTHER = 'u-other';

/** Zero counts for every kind — overridden per row where the value matters. */
function zeroCounts(): Record<EntryKind, number> {
  const counts = {} as Record<EntryKind, number>;
  for (const kind of ENTRY_KINDS) {
    counts[kind] = 0;
  }
  return counts;
}

function row(
  namespace: string,
  overrides: Partial<NamespaceRow> = {},
): NamespaceRow {
  return {
    namespace,
    name: `${namespace} display`,
    description: `${namespace} description`,
    team: true,
    shareable: false,
    public: false,
    owner: OWNER,
    counts: zeroCounts(),
    ...overrides,
  };
}

/** `acme-team` is owned by OWNER; `contoso-product` is owned by someone else. */
function defaultRows(): NamespaceRow[] {
  return [
    row('acme-team', {
      counts: { ...zeroCounts(), team: 1, agent: 5, meta: 1 },
    }),
    row('contoso-product', {
      owner: OTHER,
      public: true,
      shareable: true,
      counts: { ...zeroCounts(), team: 1, agent: 6, tool: 3 },
    }),
  ];
}

describe('CatalogListComponent (Story 36-3)', () => {
  let fixture: ComponentFixture<CatalogListComponent>;
  let component: CatalogListComponent;
  let rowsSpy: jasmine.SpyObj<NamespaceRowsService>;
  let apiSpy: jasmine.SpyObj<ApiService>;
  let messageSpy: jasmine.SpyObj<MessageService>;
  let currentUser$: BehaviorSubject<any>;
  let isAdmin$: BehaviorSubject<boolean>;

  beforeEach(async () => {
    rowsSpy = jasmine.createSpyObj<NamespaceRowsService>(
      'NamespaceRowsService',
      ['getRows'],
    );
    apiSpy = jasmine.createSpyObj<ApiService>('ApiService', [
      'deleteNamespace',
    ]);
    messageSpy = jasmine.createSpyObj<MessageService>('MessageService', ['add']);

    // Independent streams. Deriving `isAdmin$` from `currentUser$` here would
    // make "admin who is not the owner" unreachable — the case that proves the
    // predicate is a disjunction.
    currentUser$ = new BehaviorSubject<any>({ user_id: 'anonymous' });
    isAdmin$ = new BehaviorSubject<boolean>(false);

    resolveRows(defaultRows());

    await TestBed.configureTestingModule({
      imports: [
        CatalogListComponent,
        RouterTestingModule,
        NoopAnimationsModule,
      ],
      providers: [
        { provide: ApiService, useValue: apiSpy },
        { provide: MessageService, useValue: messageSpy },
        {
          provide: AuthService,
          useValue: { currentUser$, isAdmin$ },
        },
      ],
    })
      // The service is component-scoped by design, so it must be replaced on
      // the component itself — a root-level provider would never be consulted.
      .overrideComponent(CatalogListComponent, {
        set: {
          providers: [{ provide: NamespaceRowsService, useValue: rowsSpy }],
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(CatalogListComponent);
    component = fixture.componentInstance;
  });

  function resolveRows(
    rows: NamespaceRow[],
    unavailableKinds: EntryKind[] = [],
  ): void {
    const result: NamespaceRowsResult = { rows, unavailableKinds };
    rowsSpy.getRows.and.returnValue(Promise.resolve(result));
  }

  /** Mount and let the initial load settle. */
  async function render(): Promise<void> {
    fixture.detectChanges();
    await settle();
  }

  /**
   * Drain the microtask queue, then re-run change detection WITHOUT remounting
   * — the lever every "late resolution" spec pulls.
   */
  async function settle(): Promise<void> {
    await fixture.whenStable();
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    fixture.detectChanges();
  }

  function q(selector: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(selector);
  }

  function byTest(value: string): HTMLElement | null {
    return q(`[data-test="${value}"]`);
  }

  function deleteBtn(namespace: string): HTMLButtonElement {
    return byTest(`ns-delete-${namespace}`) as HTMLButtonElement;
  }

  function primaryAction(namespace: string): HTMLAnchorElement {
    return byTest(`ns-configure-${namespace}`) as HTMLAnchorElement;
  }

  function chipValues(namespace: string): string[] {
    const cell = byTest(`ns-visibility-${namespace}`)!;
    return Array.from(cell.querySelectorAll('p-tag')).map((tag) =>
      (tag as HTMLElement).textContent!.trim(),
    );
  }

  function countValue(namespace: string, kind: EntryKind): string | null {
    const el = byTest(`ns-count-${namespace}-${kind}`);
    return el === null ? null : el.textContent!.trim();
  }

  // --- AC 1, 2: the component shell and the single load path ----------------

  it('(AC1) mounts through its own NamespaceRowsService provider', async () => {
    await render();

    expect(byTest('admin-catalog-pane')).not.toBeNull();
    // Resolving the component-scoped token at all proves the `providers` entry
    // is present: the service is a bare `@Injectable()` with no `providedIn`.
    expect(fixture.debugElement.injector.get(NamespaceRowsService)).toBe(
      rowsSpy,
    );
  });

  it('(AC2) loads once on init, through getRows, defaulting to all=false', async () => {
    await render();

    expect(rowsSpy.getRows).toHaveBeenCalledTimes(1);
    expect(rowsSpy.getRows).toHaveBeenCalledWith({ all: false });
  });

  it('(AC2) shows a loading indicator while the load is in flight', async () => {
    let release!: (result: NamespaceRowsResult) => void;
    rowsSpy.getRows.and.returnValue(
      new Promise<NamespaceRowsResult>((resolve) => {
        release = resolve;
      }),
    );

    fixture.detectChanges();
    expect(byTest('catalog-loading')).not.toBeNull();
    expect(byTest('catalog-table')).toBeNull();

    release({ rows: defaultRows(), unavailableKinds: [] });
    await settle();

    expect(byTest('catalog-loading')).toBeNull();
    expect(byTest('catalog-table')).not.toBeNull();
  });

  it('(AC2) Refresh re-runs the same single load path', async () => {
    await render();

    (byTest('catalog-refresh-btn') as HTMLButtonElement).click();
    await settle();

    expect(rowsSpy.getRows).toHaveBeenCalledTimes(2);
    expect(rowsSpy.getRows.calls.mostRecent().args).toEqual([{ all: false }]);
  });

  // --- AC 3: one row per namespace -----------------------------------------

  it('(AC3) renders one row per namespace, in the service order', async () => {
    await render();

    const ids = Array.from(
      fixture.nativeElement.querySelectorAll('[data-test^="ns-id-"]'),
    ).map((el) => (el as HTMLElement).textContent!.trim());
    expect(ids).toEqual(['acme-team', 'contoso-product']);
  });

  it('(AC3) each row carries the display name, the identifier and the owner', async () => {
    await render();

    expect(byTest('ns-id-acme-team')!.textContent!.trim()).toBe('acme-team');
    expect(byTest('ns-owner-acme-team')!.textContent!.trim()).toBe(OWNER);
    expect(
      byTest('ns-row-acme-team')!.textContent,
    ).toContain('acme-team display');
  });

  it('(AC3) an unknown owner reads "unknown", not blank', async () => {
    resolveRows([row('global', { owner: null, team: false })]);
    await render();

    expect(byTest('ns-owner-global')!.textContent!.trim()).toBe('unknown');
  });

  // --- AC 4: visibility chips ----------------------------------------------

  it('(AC4) public + shareable renders public, shareable and team', async () => {
    resolveRows([row('acme-a', { public: true, shareable: true, team: true })]);
    await render();

    expect(chipValues('acme-a')).toEqual(['public', 'shareable', 'team']);
  });

  it('(AC4) public + NOT shareable renders no shareable chip', async () => {
    resolveRows([row('acme-b', { public: true, shareable: false, team: true })]);
    await render();

    expect(chipValues('acme-b')).toEqual(['public', 'team']);
  });

  it('(AC4) private + shareable renders private and shareable', async () => {
    resolveRows([
      row('acme-c', { public: false, shareable: true, team: true }),
    ]);
    await render();

    expect(chipValues('acme-c')).toEqual(['private', 'shareable', 'team']);
  });

  it('(AC4) private + NOT shareable renders private and team only', async () => {
    resolveRows([
      row('acme-d', { public: false, shareable: false, team: true }),
    ]);
    await render();

    expect(chipValues('acme-d')).toEqual(['private', 'team']);
  });

  it('(AC4) a team-less namespace reads "library", never neither and never both', async () => {
    resolveRows([row('global', { team: false })]);
    await render();

    const chips = chipValues('global');
    expect(chips).toContain('library');
    expect(chips).not.toContain('team');
    // Exactly one of public/private, always.
    expect(chips.filter((c) => c === 'public' || c === 'private').length).toBe(
      1,
    );
  });

  // --- AC 5: counts --------------------------------------------------------

  it('(AC5) renders all six kinds for every row', async () => {
    await render();

    for (const namespace of ['acme-team', 'contoso-product']) {
      for (const kind of ENTRY_KINDS) {
        expect(countValue(namespace, kind))
          .withContext(`${namespace}/${kind}`)
          .not.toBeNull();
      }
    }
  });

  it('(AC5) a count of zero renders as the character 0, not blank and not a dash', async () => {
    await render();

    expect(countValue('acme-team', 'agent')).toBe('5');
    expect(countValue('acme-team', 'tool')).toBe('0');
    expect(countValue('acme-team', 'prompt')).toBe('0');
  });

  it('(AC5) an unavailable kind renders — for EVERY row, not just some', async () => {
    resolveRows(defaultRows(), ['tool']);
    await render();

    expect(countValue('acme-team', 'tool')).toBe('—');
    expect(countValue('contoso-product', 'tool')).toBe('—');
    // The other kinds are unaffected — the failure is per-column, not per-row.
    expect(countValue('contoso-product', 'agent')).toBe('6');
  });

  // --- AC 6: the admin-only toggle -----------------------------------------

  it('(AC6) an admin sees the show-all toggle', async () => {
    isAdmin$.next(true);
    await render();

    expect(byTest('show-all-namespaces-toggle')).not.toBeNull();
  });

  it('(AC6) a non-admin gets NO toggle element at all', async () => {
    currentUser$.next({ user_id: OTHER, roles: ['user'] });
    await render();

    expect(
      fixture.nativeElement.querySelector(
        '[data-test="show-all-namespaces-toggle"]',
      ),
    ).toBeNull();
  });

  it('(AC6) the anonymous user gets NO toggle element either', async () => {
    await render();

    expect(
      fixture.nativeElement.querySelector(
        '[data-test="show-all-namespaces-toggle"]',
      ),
    ).toBeNull();
  });

  it('(AC6) the toggle defaults off and flipping it re-loads with all=true', async () => {
    isAdmin$.next(true);
    await render();

    expect(component.showAll).toBeFalse();
    expect(rowsSpy.getRows).toHaveBeenCalledWith({ all: false });

    component.onToggleShowAll(true);
    await settle();

    expect(rowsSpy.getRows).toHaveBeenCalledTimes(2);
    expect(rowsSpy.getRows.calls.mostRecent().args).toEqual([{ all: true }]);
  });

  // --- AC 7-10: THE RULE ---------------------------------------------------

  it('(AC8) a NON-ADMIN who OWNS the namespace can delete it', async () => {
    // The single most important spec in this story. Gating Delete on `isAdmin`
    // alone would take from owners a capability the server grants them.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    isAdmin$.next(false);
    await render();

    expect(component.canModify(component.rows[0])).toBeTrue();
    expect(deleteBtn('acme-team').disabled).toBeFalse();
    expect(deleteBtn('acme-team').getAttribute('title')).toBeNull();
    expect(primaryAction('acme-team').textContent!.trim()).toBe('Configure');
  });

  it('(AC9) neither owner nor admin: Delete is PRESENT, disabled, and carries the reason', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    isAdmin$.next(false);
    await render();

    const btn = deleteBtn('contoso-product');
    expect(btn).not.toBeNull(); // present, never hidden
    expect(btn.disabled).toBeTrue();
    expect(btn.getAttribute('title')).toBe(DELETE_DENIED_REASON);
    expect(primaryAction('contoso-product').textContent!.trim()).toBe('View');
  });

  it('(AC10) an ADMIN who is NOT the owner gets both controls live', async () => {
    // Proves the predicate is a disjunction, not an ownership-only check.
    currentUser$.next({ user_id: 'u-admin', roles: ['admin'] });
    isAdmin$.next(true);
    await render();

    expect(deleteBtn('contoso-product').disabled).toBeFalse();
    expect(deleteBtn('contoso-product').getAttribute('title')).toBeNull();
    expect(primaryAction('contoso-product').textContent!.trim()).toBe(
      'Configure',
    );
  });

  it('(AC7) an unknown owner fails closed for a non-admin and opens for an admin', async () => {
    resolveRows([row('global', { owner: null, team: false })]);
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    expect(deleteBtn('global').disabled).toBeTrue();

    isAdmin$.next(true);
    await settle();

    expect(deleteBtn('global').disabled).toBeFalse();
  });

  it('(AC7b) a LATE admin resolution enables a non-owned row WITHOUT remounting', async () => {
    // `/auth/me` resolves after first render. A snapshot taken in the
    // constructor would leave a genuine admin looking at a disabled Delete
    // until the next navigation.
    await render();
    expect(deleteBtn('contoso-product').disabled).toBeTrue();

    currentUser$.next({ user_id: 'u-admin', roles: ['admin'] });
    isAdmin$.next(true);
    await settle();

    expect(deleteBtn('contoso-product').disabled).toBeFalse();
    expect(primaryAction('contoso-product').textContent!.trim()).toBe(
      'Configure',
    );
  });

  it('(AC7b) a LATE ownership resolution enables the owned row WITHOUT remounting', async () => {
    // The other half of the predicate, on the same lever: `isAdmin` never
    // changes here, only the caller's identity.
    await render();
    expect(deleteBtn('acme-team').disabled).toBeTrue();

    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await settle();

    expect(deleteBtn('acme-team').disabled).toBeFalse();
    expect(isAdmin$.value).toBeFalse();
  });

  // --- AC 15: the destination never varies ---------------------------------

  it('(AC15) Configure and View target the same deep link', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    expect(primaryAction('acme-team').textContent!.trim()).toBe('Configure');
    expect(primaryAction('contoso-product').textContent!.trim()).toBe('View');

    expect(primaryAction('acme-team').getAttribute('href')).toBe(
      '/admin/catalog/namespace/acme-team',
    );
    expect(primaryAction('contoso-product').getAttribute('href')).toBe(
      '/admin/catalog/namespace/contoso-product',
    );
  });

  // --- AC 12, 13, 14: delete -----------------------------------------------

  it('(AC12) Delete asks first, naming the namespace, and issues no request yet', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    deleteBtn('acme-team').click();
    await settle();

    expect(byTest('delete-confirm-namespace')!.textContent!.trim()).toBe(
      'acme-team',
    );
    expect(apiSpy.deleteNamespace).not.toHaveBeenCalled();
  });

  it('(AC12) cancelling issues no request and leaves the row', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    deleteBtn('acme-team').click();
    await settle();
    (byTest('delete-cancel-btn') as HTMLButtonElement).click();
    await settle();

    expect(apiSpy.deleteNamespace).not.toHaveBeenCalled();
    expect(byTest('ns-id-acme-team')).not.toBeNull();
    expect(byTest('delete-proceed-btn')).toBeNull();
  });

  it('(AC12) Escape cancels the confirmation without issuing a request', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    deleteBtn('acme-team').click();
    await settle();

    byTest('delete-proceed-btn')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await settle();

    expect(component.confirmDialogVisible).toBeFalse();
    expect(apiSpy.deleteNamespace).not.toHaveBeenCalled();
  });

  it('(AC13) a successful delete removes that row and ONLY that row', async () => {
    apiSpy.deleteNamespace.and.returnValue(Promise.resolve());
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    deleteBtn('acme-team').click();
    await settle();
    (byTest('delete-proceed-btn') as HTMLButtonElement).click();
    await settle();

    expect(apiSpy.deleteNamespace).toHaveBeenCalledOnceWith('acme-team');
    expect(byTest('ns-id-acme-team')).toBeNull();
    // The survivor is untouched: still there, same chips, same counts, and no
    // second page-wide re-fetch was issued.
    expect(byTest('ns-id-contoso-product')).not.toBeNull();
    expect(chipValues('contoso-product')).toEqual([
      'public',
      'shareable',
      'team',
    ]);
    expect(countValue('contoso-product', 'agent')).toBe('6');
    expect(rowsSpy.getRows).toHaveBeenCalledTimes(1);
  });

  it('(AC14) a 403 leaves the row and surfaces the message exactly ONCE', async () => {
    // The spy stands in for the real plumbing: FetchService raises the toast
    // BEFORE it throws, so "exactly once" is what catches a well-meaning
    // second toast added in the component's catch.
    apiSpy.deleteNamespace.and.callFake(async () => {
      messageSpy.add({
        severity: 'error',
        summary: 'Error',
        detail: 'Not authorized',
      });
      throw new HttpError('Not authorized', 403, { detail: 'Not authorized' });
    });
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    deleteBtn('acme-team').click();
    await settle();
    (byTest('delete-proceed-btn') as HTMLButtonElement).click();
    await settle();

    expect(byTest('ns-id-acme-team')).not.toBeNull();
    expect(byTest('ns-id-contoso-product')).not.toBeNull();
    expect(messageSpy.add).toHaveBeenCalledTimes(1);
    expect(messageSpy.add.calls.mostRecent().args[0].severity).toBe('error');
  });

  it('(AC14) a 500 behaves identically — row intact, one toast, no silent removal', async () => {
    apiSpy.deleteNamespace.and.callFake(async () => {
      messageSpy.add({ severity: 'error', summary: 'Error', detail: 'boom' });
      throw new HttpError('boom', 500, 'boom');
    });
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    deleteBtn('acme-team').click();
    await settle();
    (byTest('delete-proceed-btn') as HTMLButtonElement).click();
    await settle();

    expect(byTest('ns-id-acme-team')).not.toBeNull();
    expect(messageSpy.add).toHaveBeenCalledTimes(1);
  });

  // --- AC 16: failure and empty are different states ------------------------

  it('(AC16) a rejected load renders the failure state and NO table', async () => {
    rowsSpy.getRows.and.returnValue(Promise.reject(new Error('boom')));
    await render();

    expect(byTest('catalog-load-failed')).not.toBeNull();
    expect(byTest('catalog-table')).toBeNull();
    expect(byTest('catalog-empty')).toBeNull();
    // FetchService already toasted — the pane adds nothing.
    expect(messageSpy.add).not.toHaveBeenCalled();
  });

  it('(AC16) an empty catalog renders the empty state, distinguishable from failure', async () => {
    resolveRows([]);
    await render();

    expect(byTest('catalog-empty')).not.toBeNull();
    expect(byTest('catalog-empty')!.textContent!.trim()).toBe('No namespaces');
    expect(byTest('catalog-load-failed')).toBeNull();
  });
});
