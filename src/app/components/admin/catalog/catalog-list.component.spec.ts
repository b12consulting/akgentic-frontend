import {
  Component,
  EventEmitter,
  Input,
  Output,
  forwardRef,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { RouterTestingModule } from '@angular/router/testing';
import { MessageService } from 'primeng/api';
import { Dialog } from 'primeng/dialog';
import { BehaviorSubject } from 'rxjs';

import { AuthService } from '../../../core/auth/auth.service';
import { HttpError } from '../../../core/http/fetch.service';
import { ApiService } from '../../../core/http/api.service';
import { ENTRY_KINDS, EntryKind } from '../../../protocol/catalog.interface';
import { NamespacePanelComponent } from '../../catalog/namespace-panel/namespace-panel.component';
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
 *
 * Story 36-4 added the in-page dialog host to the same component, so this file
 * also covers the three-layer Escape coordination, the dirty-close channels and
 * the derived `existingNamespaces`.
 */

const OWNER = 'u-owner';
const OTHER = 'u-other';

/**
 * Stands in for `NamespacePanelComponent` inside the host's `@defer` block.
 *
 * It PROVIDES the real component's token (`useExisting`), so the host's
 * `@ViewChild(NamespacePanelComponent)` still resolves to it — the wiring under
 * test is exercised rather than bypassed, while Monaco and the panel's own HTTP
 * surface stay out of a spec about the host. The panel has its own suite; this
 * one must not re-test it through the dialog.
 */
@Component({
  selector: 'app-namespace-panel',
  standalone: true,
  template: '<div data-test="stub-panel"></div>',
  providers: [
    {
      provide: NamespacePanelComponent,
      useExisting: forwardRef(() => StubNamespacePanelComponent),
    },
  ],
})
class StubNamespacePanelComponent {
  @Input() namespace = '';
  @Input() existingNamespaces: string[] = [];
  @Input() showAll = false;
  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>();

  /** The four state flags the host reads. Writes are the real panel's job. */
  saving = false;
  cloning = false;
  validating = false;
  loading = false;

  /** Flipped per spec; `hasUnsavedChanges()` reports it. */
  dirty = false;
  /** What `handleSecondaryEscape()` reports — i.e. "a modal of mine ate it". */
  secondaryConsumesEscape = false;

  hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  confirmDiscard(): Promise<boolean> {
    return Promise.resolve(true);
  }

  handleSecondaryEscape(): boolean {
    return this.secondaryConsumesEscape;
  }
}

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
      'getNamespaces',
    ]);
    apiSpy.getNamespaces.and.returnValue(Promise.resolve([]));
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
      // Two swaps in ONE override — `set` cannot be combined with
      // `add`/`remove`, so both go through the latter pair.
      //
      // 1. `NamespaceRowsService` is component-scoped by design, so it must be
      //    replaced on the component itself; a root-level provider would never
      //    be consulted.
      // 2. The `@defer`-hosted panel is swapped for a stub (Story 36-4) so the
      //    real Monaco chunk never loads here.
      .overrideComponent(CatalogListComponent, {
        remove: {
          imports: [NamespacePanelComponent],
          providers: [NamespaceRowsService],
        },
        add: {
          imports: [StubNamespacePanelComponent],
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

  function primaryAction(namespace: string): HTMLButtonElement {
    return byTest(`ns-configure-${namespace}`) as HTMLButtonElement;
  }

  /** The two `Dialog` instances this pane owns, by their `data-test` hook. */
  function dialogInstance(dataTest: string): Dialog {
    const found = fixture.debugElement
      .queryAll(By.directive(Dialog))
      .find((de) => de.attributes['data-test'] === dataTest);
    return found!.componentInstance as Dialog;
  }

  function configDialog(): Dialog {
    return dialogInstance('namespace-config-dialog');
  }

  /** The stubbed panel, once the `@defer` block has rendered it. */
  function panelStub(): StubNamespacePanelComponent | undefined {
    return fixture.debugElement.query(By.directive(StubNamespacePanelComponent))
      ?.componentInstance;
  }

  /**
   * Open the config dialog through the row's own control and let the `@defer`
   * block resolve. Two settles: the first renders the deferred block, the
   * second binds its inputs and resolves the host's `@ViewChild`.
   */
  async function openPanel(namespace: string): Promise<void> {
    primaryAction(namespace).click();
    await settle();
    await settle();
  }

  /**
   * A REAL keystroke on `document`. A non-bubbling event dispatched on an inner
   * element never reaches a `document:` HostListener, and a spec written that
   * way would pass for the wrong reason.
   */
  function pressEscape(): void {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
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

  it('(AC7) an unknown owner stays closed when the caller has no user_id either', async () => {
    // The fail-closed half of the predicate, on the ONLY input that can catch
    // it. Every other spec names its caller, and `null === 'u-owner'` is false
    // whether or not the explicit `owner !== null` guard is there — so without
    // this spec that guard can be deleted with the suite still green, and
    // `null === null` then hands every unowned namespace to every caller.
    resolveRows([row('global', { owner: null, team: false })]);
    currentUser$.next({ name: 'No identity' }); // no `user_id` at all
    isAdmin$.next(false);
    await render();

    expect(component.canModify(component.rows[0])).toBeFalse();
    expect(deleteBtn('global').disabled).toBeTrue();
    expect(deleteBtn('global').getAttribute('title')).toBe(DELETE_DENIED_REASON);
    expect(primaryAction('global').textContent!.trim()).toBe('View');
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

  // --- AC 15 (36-3) / AC 6 (36-4): the destination never varies -------------

  it('(36-4 AC6) Configure and View open the SAME dialog, each on its own row', async () => {
    // 36-3's AC 15 asserted this on a `routerLink`. 36-4 changed the control's
    // destination from a navigation to an in-page dialog, so the assertion
    // moves with it — same intent, relocated. It is the one 36-3 assertion this
    // story is entitled to rewrite.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    expect(primaryAction('acme-team').textContent!.trim()).toBe('Configure');
    expect(primaryAction('contoso-product').textContent!.trim()).toBe('View');

    await openPanel('acme-team');
    expect(component.panelVisible).toBeTrue();
    expect(component.panelNamespace).toBe('acme-team');

    // Switching rows re-binds the SAME dialog rather than opening another.
    await openPanel('contoso-product');
    expect(component.panelVisible).toBeTrue();
    expect(component.panelNamespace).toBe('contoso-product');
    expect(panelStub()!.namespace).toBe('contoso-product');
  });

  it('(36-4 AC6) the primary action is a button, not a link to the deep link', async () => {
    // The URL survives as a bookmark (see admin.routes.spec.ts) but is no
    // longer reachable by clicking: a leftover `href` would navigate away from
    // the list and silently undo the whole story.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    const control = primaryAction('acme-team');
    expect(control.tagName).toBe('BUTTON');
    expect(control.getAttribute('href')).toBeNull();
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

  it('(AC12) the dialog keeps PrimeNG off Escape and takes it itself, for 36-4', async () => {
    // Story 36-4 must fold this dialog into a coordinated Escape handler.
    // PrimeNG attaches `closeOnEscape` as a DOCUMENT-level listener per
    // dialog, so flipping it back on would make one Escape close this dialog
    // AND 36-4's panel host in turn — silently, since the Escape spec below
    // would still pass with PrimeNG doing the closing.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    deleteBtn('acme-team').click();
    await settle();

    const dialog = fixture.debugElement.query(By.directive(Dialog));
    expect(dialog).not.toBeNull();
    expect(dialog.componentInstance.closeOnEscape).toBeFalse();
    expect(dialog.componentInstance.modal).toBeTrue();
    expect(dialog.componentInstance.draggable).toBeFalse();
  });

  it('(AC12) Escape cancels from the dialog itself, not only from its message body', async () => {
    // The dialog's own header close button is a SIBLING of the message body,
    // so an Escape handler scoped to that body leaves Escape dead for anyone
    // who reached the header — and PrimeNG's own Escape is deliberately off,
    // so nothing else would catch it. Dispatching on the dialog host (which
    // the body cannot see) discriminates the two placements.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    deleteBtn('acme-team').click();
    await settle();
    expect(component.confirmDialogVisible).toBeTrue();

    byTest('delete-confirm-dialog')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await settle();

    expect(component.confirmDialogVisible).toBeFalse();
    expect(component.pendingDelete).toBeNull();
    expect(apiSpy.deleteNamespace).not.toHaveBeenCalled();
  });

  it('(AC12) the confirmation opens with Proceed focused', async () => {
    // AC 12's affirmative-focused contract. The `@ViewChild` behind it is
    // resolved by a template reference; renaming or moving that reference
    // leaves the dialog opening with focus nowhere, which no other spec sees.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    deleteBtn('acme-team').click();
    await settle();
    component.onConfirmDialogShow();

    expect(document.activeElement).toBe(byTest('delete-proceed-btn'));
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

  // =========================================================================
  // Story 36-4 — the in-page dialog host
  // =========================================================================

  // --- AC 7: the host's structure ------------------------------------------

  it('(36-4 AC7) the panel is absent from the DOM until the dialog is first opened', async () => {
    // The `@defer` claim, asserted structurally: mounted normally (no
    // CUSTOM_ELEMENTS_SCHEMA), so an absent element really is absent.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    expect(byTest('stub-panel')).toBeNull();
    expect(panelStub()).toBeUndefined();

    await openPanel('acme-team');

    expect(byTest('stub-panel')).not.toBeNull();
    // The host's `@ViewChild(NamespacePanelComponent)` resolves to the stub,
    // which provides that token — so the query itself is under test here, not
    // stubbed around.
    expect(component.panel as unknown).toBe(panelStub()!);
  });

  it('(36-4 AC7) the host dialog is modal, splits visible, and keeps PrimeNG off Escape', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');

    const dialog = configDialog();
    expect(dialog.visible).toBeTrue();
    expect(dialog.modal).toBeTrue();
    expect(dialog.closeOnEscape).toBeFalse();
    expect(dialog.closable).toBeTrue();
    expect(dialog.dismissableMask).toBeTrue();
  });

  it('(36-4 AC12) closeOnEscape is off on BOTH dialogs this pane owns', async () => {
    // Pinned on the instances, because flipping either back is otherwise
    // SILENT: PrimeNG would do the closing and the behavioural Escape specs
    // would still pass while the coordination they guard was gone. Extends
    // 36-3's guard on the confirm dialog rather than replacing it.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');
    component.onDeleteClick(component.rows[0]);
    await settle();

    expect(configDialog().closeOnEscape).toBeFalse();
    expect(dialogInstance('delete-confirm-dialog').closeOnEscape).toBeFalse();
  });

  it('(36-4 AC7) the header names the namespace being configured', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');

    // The row's display name, which is what an operator recognises.
    expect(component.panelLabel).toBe('acme-team display');
    expect(q('.p-dialog-title')!.textContent).toContain('acme-team display');
  });

  it('(36-4 AC7) the header falls back to the identifier when the row has no name', async () => {
    resolveRows([row('acme-nameless', { name: '' })]);
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-nameless');

    expect(component.panelLabel).toBe('acme-nameless');
  });

  it('(36-4 AC7) the dirty indicator is ABSENT from the DOM while the panel is clean', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');

    expect(panelStub()!.hasUnsavedChanges()).toBeFalse();
    expect(byTest('dirty-indicator-dialog')).toBeNull();

    panelStub()!.dirty = true;
    await settle();

    expect(byTest('dirty-indicator-dialog')).not.toBeNull();
  });

  it('(36-4 AC7) the panel receives the row, the derived list and the pane showAll', async () => {
    isAdmin$.next(true);
    currentUser$.next({ user_id: OWNER, roles: ['admin'] });
    await render();
    component.onToggleShowAll(true);
    await settle();

    await openPanel('acme-team');

    const panel = panelStub()!;
    expect(panel.namespace).toBe('acme-team');
    expect(panel.existingNamespaces).toEqual(['acme-team', 'contoso-product']);
    expect(panel.showAll).toBeTrue();
  });

  it('(36-4 AC7) the panel (closed) output dismisses the dialog', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');

    panelStub()!.closed.emit();
    await settle();

    expect(component.panelVisible).toBeFalse();
  });

  // --- AC 8: the two dirty-close channels ----------------------------------

  /** The X: PrimeNG's header close button, clicked for real. */
  function clickDialogClose(): void {
    const closeBtn = fixture.nativeElement.querySelector(
      '.p-dialog-close-button',
    ) as HTMLButtonElement;
    closeBtn.click();
  }

  /**
   * The dismissable mask: PrimeNG binds `mousedown` on the mask element and
   * closes only when the mask itself is the target.
   */
  function clickDialogMask(): void {
    const mask = fixture.nativeElement.querySelector(
      '.p-dialog-mask',
    ) as HTMLElement;
    mask.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  }

  it('(36-4 AC8) the X on a DIRTY panel holds the dialog open and asks first', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');
    const panel = panelStub()!;
    panel.dirty = true;
    let resolveDiscard!: (v: boolean) => void;
    const confirmDiscard = spyOn(panel, 'confirmDiscard').and.returnValue(
      new Promise<boolean>((r) => (resolveDiscard = r)),
    );

    clickDialogClose();
    await settle();

    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    expect(component.panelVisible).toBeTrue();

    resolveDiscard(true);
    await settle();

    expect(component.panelVisible).toBeFalse();
  });

  it('(36-4 AC8) Cancel on that confirm leaves the dialog open and the buffer intact', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');
    const panel = panelStub()!;
    panel.dirty = true;
    spyOn(panel, 'confirmDiscard').and.returnValue(Promise.resolve(false));

    clickDialogClose();
    await settle();

    expect(component.panelVisible).toBeTrue();
  });

  it('(36-4 AC8) the dismissable MASK on a dirty panel routes through the same handler', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');
    const panel = panelStub()!;
    panel.dirty = true;
    const confirmDiscard = spyOn(panel, 'confirmDiscard').and.returnValue(
      Promise.resolve(false),
    );

    clickDialogMask();
    await settle();

    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    expect(component.panelVisible).toBeTrue();
  });

  it('(36-4 AC8) the X on a CLEAN panel closes at once, asking nothing', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');
    const confirmDiscard = spyOn(panelStub()!, 'confirmDiscard');

    clickDialogClose();
    await settle();

    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(component.panelVisible).toBeFalse();
  });

  it('(36-4 AC8) the MASK on a clean panel closes at once, asking nothing', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');
    const confirmDiscard = spyOn(panelStub()!, 'confirmDiscard');

    clickDialogMask();
    await settle();

    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(component.panelVisible).toBeFalse();
  });

  it('(36-4 AC8) a dialog whose panel never mounted closes without a confirm', async () => {
    // The `@ViewChild` is `undefined` until the deferred block has rendered.
    // "Not mounted" must read as "nothing to discard", not as a crash.
    await render();
    component.panelVisible = true;

    component.onPanelVisibleChange(false);

    expect(component.panel).toBeUndefined();
    expect(component.panelVisible).toBeFalse();
  });

  // --- AC 9: a write locks every channel; a read locks none ----------------

  it('(36-4 AC9) saving locks the X, the mask and Escape together', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');
    const panel = panelStub()!;
    panel.dirty = true;
    panel.saving = true;
    const confirmDiscard = spyOn(panel, 'confirmDiscard');
    await settle();

    expect(component.isWriteInFlight).toBeTrue();
    expect(configDialog().closable).toBeFalse();
    expect(configDialog().dismissableMask).toBeFalse();

    pressEscape();
    await settle();

    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(component.panelVisible).toBeTrue();
  });

  it('(36-4 AC9) cloning locks them too — a write is a write', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');
    panelStub()!.cloning = true;
    await settle();

    expect(component.isWriteInFlight).toBeTrue();
    expect(configDialog().closable).toBeFalse();
    expect(configDialog().dismissableMask).toBeFalse();
  });

  it('(36-4 AC9) validating leaves every channel LIVE — reads are not writes', async () => {
    // `isWriteInFlight` must not silently widen to include reads: a Validate
    // in flight must never trap the operator inside the dialog.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');
    const panel = panelStub()!;
    panel.validating = true;
    panel.loading = true;
    await settle();

    expect(component.isWriteInFlight).toBeFalse();
    expect(configDialog().closable).toBeTrue();
    expect(configDialog().dismissableMask).toBeTrue();

    pressEscape();
    await settle();

    expect(component.panelVisible).toBeFalse();
  });

  // --- AC 10, 11: three layers, one action per keystroke --------------------

  it('(36-4 AC11.1) a write in flight outranks even the delete confirmation', async () => {
    // AC 11 puts the write-lock FIRST: while a write is in flight NOTHING
    // closes, not even a layer that would otherwise cancel freely.
    //
    // With only the config dialog open the two orderings are
    // indistinguishable — branch 2 falls through on its own — so every other
    // Escape spec stays green if the write-lock is demoted below the
    // delete-confirm branch. This arrangement is the one that separates them,
    // and without it the ordering AC 11 enumerates is not actually pinned.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');
    component.onDeleteClick(component.rows[0]);
    panelStub()!.saving = true;
    await settle();

    pressEscape();
    await settle();

    // Neither layer moved, and no request was issued.
    expect(component.confirmDialogVisible).toBeTrue();
    expect(component.pendingDelete).not.toBeNull();
    expect(component.panelVisible).toBeTrue();
    expect(apiSpy.deleteNamespace).not.toHaveBeenCalled();
  });

  it('(36-4 AC11.2) Escape with the delete confirmation open closes ONLY that', async () => {
    // The named case. The config host is modal, so in practice these two never
    // coexist — both are opened here deliberately, because the point of the
    // ordering is that the handler is TOTAL rather than accidentally correct.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');
    component.onDeleteClick(component.rows[0]);
    await settle();
    const confirmDiscard = spyOn(panelStub()!, 'confirmDiscard');
    const secondary = spyOn(panelStub()!, 'handleSecondaryEscape');

    pressEscape();
    await settle();

    expect(component.confirmDialogVisible).toBeFalse();
    expect(component.pendingDelete).toBeNull();
    expect(apiSpy.deleteNamespace).not.toHaveBeenCalled();
    expect(byTest('ns-id-acme-team')).not.toBeNull(); // the row is intact
    // The config dialog is untouched, and the panel was never consulted.
    expect(component.panelVisible).toBeTrue();
    expect(secondary).not.toHaveBeenCalled();
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it('(36-4 AC11.3) Escape with the Clone sub-dialog open closes ONLY the sub-dialog', async () => {
    // The other named case. The panel reports that one of ITS modals consumed
    // the keystroke; the config dialog must stay open and stay unasked.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');
    const panel = panelStub()!;
    panel.dirty = true;
    panel.secondaryConsumesEscape = true;
    const confirmDiscard = spyOn(panel, 'confirmDiscard');
    const secondary = spyOn(panel, 'handleSecondaryEscape').and.returnValue(
      true,
    );

    pressEscape();
    await settle();

    expect(secondary).toHaveBeenCalledTimes(1);
    expect(component.panelVisible).toBeTrue();
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it('(36-4 AC11.4) Escape with no secondary modal runs the close flow — dirty asks', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');
    const panel = panelStub()!;
    panel.dirty = true;
    const confirmDiscard = spyOn(panel, 'confirmDiscard').and.returnValue(
      Promise.resolve(true),
    );

    pressEscape();
    await settle();

    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    expect(component.panelVisible).toBeFalse();
  });

  it('(36-4 AC11.4) Escape on a clean panel closes it without asking', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');
    const confirmDiscard = spyOn(panelStub()!, 'confirmDiscard');

    pressEscape();
    await settle();

    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(component.panelVisible).toBeFalse();
  });

  it('(36-4 AC11.5) Escape with nothing open does nothing at all', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    pressEscape();
    await settle();

    expect(component.panelVisible).toBeFalse();
    expect(component.confirmDialogVisible).toBeFalse();
    expect(component.pendingDelete).toBeNull();
    expect(apiSpy.deleteNamespace).not.toHaveBeenCalled();
    expect(rowsSpy.getRows).toHaveBeenCalledTimes(1);
  });

  it('(36-4 AC10) the pane owns exactly ONE Escape handler — one keystroke, one action', async () => {
    // 36-3 put a `(keydown.escape)` binding on the confirm dialog itself. If it
    // came back, this Escape would cancel the delete AND then be seen again by
    // the document handler. Driving one keystroke and counting the effects is
    // what catches that.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    deleteBtn('acme-team').click();
    await settle();
    expect(component.confirmDialogVisible).toBeTrue();

    pressEscape();
    await settle();

    expect(component.confirmDialogVisible).toBeFalse();
    // The panel was never opened, so a second action would have to show up as
    // one of these — a stray delete or a phantom reload.
    expect(apiSpy.deleteNamespace).not.toHaveBeenCalled();
    expect(rowsSpy.getRows).toHaveBeenCalledTimes(1);
  });

  // --- AC 14, 15: existingNamespaces, from data already on screen -----------

  it('(36-4 AC14) opening the dialog issues NO additional request', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    rowsSpy.getRows.calls.reset();

    await openPanel('acme-team');

    expect(rowsSpy.getRows).not.toHaveBeenCalled();
    expect(apiSpy.getNamespaces).not.toHaveBeenCalled();
    expect(panelStub()!.existingNamespaces).toEqual([
      'acme-team',
      'contoso-product',
    ]);
  });

  it('(36-4 AC14) existingNamespaces is DERIVED, not a copied field', async () => {
    // A copied array would go stale the moment the table changed under it —
    // here, when a delete drops a row.
    apiSpy.deleteNamespace.and.returnValue(Promise.resolve());
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    expect(component.existingNamespaces).toEqual([
      'acme-team',
      'contoso-product',
    ]);

    deleteBtn('acme-team').click();
    await settle();
    (byTest('delete-proceed-btn') as HTMLButtonElement).click();
    await settle();

    expect(component.existingNamespaces).toEqual(['contoso-product']);
  });

  it('(36-4 AC15) (saved) refreshes the table AND the panel list in ONE call', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');
    rowsSpy.getRows.calls.reset();

    // A namespace present only in the SECOND response — e.g. one the panel's
    // Clone just created.
    resolveRows([...defaultRows(), row('acme-cloned')]);
    panelStub()!.saved.emit();
    await settle();

    expect(rowsSpy.getRows).toHaveBeenCalledTimes(1);
    expect(byTest('ns-id-acme-cloned')).not.toBeNull();
    expect(panelStub()!.existingNamespaces).toContain('acme-cloned');
  });
});
