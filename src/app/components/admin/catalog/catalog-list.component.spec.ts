import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnInit,
  Output,
  SimpleChanges,
  forwardRef,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { RouterTestingModule } from '@angular/router/testing';
import { MessageService } from 'primeng/api';
import { Dialog } from 'primeng/dialog';
import { SelectableRow, Table } from 'primeng/table';
import { Tag } from 'primeng/tag';
import { BehaviorSubject } from 'rxjs';

import { AuthService } from '../../../core/auth/auth.service';
import { HttpError } from '../../../core/http/fetch.service';
import { ApiService } from '../../../core/http/api.service';
import {
  ENTRY_KINDS,
  EntryKind,
  NamespaceKindCount,
  NamespaceSummary,
} from '../../../protocol/catalog.interface';
import { NamespacePanelComponent } from '../../catalog/namespace-panel/namespace-panel.component';
import { AdminSectionCounts } from '../admin-section-counts.service';
import {
  CATALOG_DESCRIPTION_ADMIN,
  CATALOG_DESCRIPTION_MEMBER,
  CATALOG_FILTER_PLACEHOLDER,
  CATALOG_NO_MATCH_MESSAGE,
  CLONE_DENIED_REASON,
  CatalogListComponent,
  DELETE_DENIED_REASON,
  SHOWN_ENTRY_KINDS,
} from './catalog-list.component';
import { EXPECTED_COUNTS, NAMESPACES } from './catalog-list.fixtures';

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
 *
 * Story 36-8 deleted the composing service — the server now sends `owner` and
 * `counts` on `NamespaceSummary`, so the pane issues ONE request and derives
 * nothing. The harness below therefore stubs `ApiService.getNamespaces`
 * directly, and the assertions the deleted service's own suite used to carry
 * (one request per load, `?all=` threading, the five-namespace fixture, the
 * present-key-with-zero rule, `owner: null` surviving untouched) are re-homed
 * here rather than deleted with it. Every AUTHORIZATION `it(...)` below is
 * unchanged from 36-3 — that is the evidence the rule did not move.
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
class StubNamespacePanelComponent implements OnInit, OnChanges {
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

  /** Story 36-14 — the real panel's clone gate, driven per spec. */
  canClone = true;
  cloneDialogVisible = false;
  /** The namespace the stub HELD when clone was requested — the trap's witness. */
  cloneOpenedFor: string[] = [];

  hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  confirmDiscard(): Promise<boolean> {
    return Promise.resolve(true);
  }

  /**
   * Records WHICH namespace it was showing when the host fired, not merely that
   * the host fired. That is what makes the 36-14 specs discriminate: a
   * synchronous trigger records the previous row, a correctly gated one records
   * the row the operator clicked, and "the modal opened" would pass either way.
   */
  onCloneClick(): void {
    this.cloneOpenedFor.push(this.namespace);
    this.cloneDialogVisible = true;
  }

  /**
   * The real panel loads ASYNCHRONOUSLY on mount and again on every namespace
   * re-bind, clearing its buffer first. A stub that landed instantly could not
   * tell a correct readiness gate from a broken one, so both loads are modelled
   * and the spec releases them explicitly through `finishLoad()`.
   */
  ngOnInit(): void {
    this.loading = true;
  }

  ngOnChanges(changes: SimpleChanges): void {
    const change = changes['namespace'];
    if (change && !change.firstChange) {
      this.loading = true;
    }
  }

  finishLoad(): void {
    this.loading = false;
  }

  /** Mirrors the real panel: its Clone modal consumes Escape too. */
  handleSecondaryEscape(): boolean {
    return this.cloneDialogVisible || this.secondaryConsumesEscape;
  }
}

/**
 * Zero counts for every kind — overridden per row where the value matters.
 *
 * The value is `{ total: 0 }`, NOT `0`: the catalog nests the tally so a second
 * one can be added without reshaping a response this client already parses.
 */
function zeroCounts(): Record<EntryKind, NamespaceKindCount> {
  const counts = {} as Record<EntryKind, NamespaceKindCount>;
  for (const kind of ENTRY_KINDS) {
    counts[kind] = { total: 0 };
  }
  return counts;
}

function row(
  namespace: string,
  overrides: Partial<NamespaceSummary> = {},
): NamespaceSummary {
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
function defaultRows(): NamespaceSummary[] {
  return [
    row('acme-team', {
      counts: {
        ...zeroCounts(),
        team: { total: 1 },
        agent: { total: 5 },
        meta: { total: 1 },
      },
    }),
    row('contoso-product', {
      owner: OTHER,
      public: true,
      shareable: true,
      counts: {
        ...zeroCounts(),
        team: { total: 1 },
        agent: { total: 6 },
        tool: { total: 3 },
      },
    }),
  ];
}

describe('CatalogListComponent (Story 36-3)', () => {
  let fixture: ComponentFixture<CatalogListComponent>;
  let component: CatalogListComponent;
  let apiSpy: jasmine.SpyObj<ApiService>;
  let messageSpy: jasmine.SpyObj<MessageService>;
  let currentUser$: BehaviorSubject<any>;
  let isAdmin$: BehaviorSubject<boolean>;
  let sectionCounts: AdminSectionCounts;

  beforeEach(async () => {
    // The pane calls exactly two of these. The other four are stubbed anyway so
    // that `totalApiCalls()` below actually spans the catalog surface: a
    // re-introduced fan-out through one of them must be COUNTED, not merely
    // crash on an undefined method inside `loadRows()`'s bare `catch`.
    apiSpy = jasmine.createSpyObj<ApiService>('ApiService', [
      'deleteNamespace',
      'getNamespaces',
      'exportNamespace',
      'importNamespace',
      'validatePersistedNamespace',
      'validateNamespaceBuffer',
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
        // The REAL holder (Story 36-9), registered on the shell's route in
        // production. The pane publishes its row count into it; asserting on
        // what it holds is how the rail's number is checked without mounting
        // the shell.
        AdminSectionCounts,
      ],
    })
      // ONE swap now that 36-8 deleted the composing service: the
      // `@defer`-hosted panel is replaced by a stub (Story 36-4) so the real
      // Monaco chunk never loads in a spec about the host. The pane's data
      // layer is the root `ApiService`, stubbed above like any other caller's.
      .overrideComponent(CatalogListComponent, {
        remove: { imports: [NamespacePanelComponent] },
        add: { imports: [StubNamespacePanelComponent] },
      })
      .compileComponents();

    sectionCounts = TestBed.inject(AdminSectionCounts);
    fixture = TestBed.createComponent(CatalogListComponent);
    component = fixture.componentInstance;
  });

  /** The value the pane last published for the admin rail's Catalog badge. */
  function publishedCatalogCount(): number | null {
    let published: number | null = null;
    sectionCounts.catalog$.subscribe((value) => (published = value)).unsubscribe();
    return published;
  }

  /** Serve one page's worth of rows from the ONE request the pane issues. */
  function resolveRows(rows: NamespaceSummary[]): void {
    apiSpy.getNamespaces.and.returnValue(Promise.resolve(rows));
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

  /**
   * Story 36-14 — the row's `read-only` warning, present iff `canModify(row)`
   * is false.
   *
   * It replaces the Configure/View label as the per-row entitlement signal:
   * that label was the only place a non-owner learned they were read-only
   * BEFORE clicking, and 36-14 removed the control, not the fact.
   */
  function readOnlyTag(namespace: string): HTMLElement | null {
    return byTest(`ns-readonly-${namespace}`);
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
   * Click a CELL of the row — never a button — which is the click an operator
   * makes. Two settles: the first renders the `@defer` block, the second binds
   * its inputs and resolves the host's `@ViewChild`.
   *
   * Hoisted here from 36-12's block at the bottom of the file so `openPanel`
   * can delegate to it rather than duplicate it.
   */
  async function clickRow(namespace: string): Promise<void> {
    (byTest(`ns-owner-${namespace}`) as HTMLElement).click();
    await settle();
    await settle();
  }

  /**
   * Open the config dialog and let the `@defer` block resolve.
   *
   * Story 36-14 removed the Configure/View button this used to click, making
   * the ROW the sole entry to the panel — so the helper re-points rather than
   * every 36-4 dialog spec being rewritten. Changing the helper is what keeps
   * those specs byte-identical: what they are about is the dialog, not the
   * control that opened it.
   */
  async function openPanel(namespace: string): Promise<void> {
    await clickRow(namespace);
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

  /**
   * Story 36-11 — the `severity` INPUT each chip in a row's visibility cell
   * received, keyed by the chip's value.
   *
   * The INPUT, not the rendered class and not a computed colour. `severity` is a
   * documented `@Input()` on PrimeNG's `Tag`, which PrimeNG maps internally to
   * `p-tag-warn`; asserting that class would couple these specs to PrimeNG's
   * class scheme, and asserting a background would couple them to the theme.
   * Both make the theme unchangeable and neither proves more than this does.
   *
   * Read off the MOUNTED instances after `detectChanges()`, never off a
   * component property: both of 36-11's changes are template-only, so a spec
   * that read the component would prove nothing about what a browser renders.
   */
  function chipSeverities(namespace: string): Record<string, string | undefined> {
    const cell = byTest(`ns-visibility-${namespace}`)!;
    const severities: Record<string, string | undefined> = {};
    for (const debugEl of fixture.debugElement.queryAll(By.directive(Tag))) {
      if (!cell.contains(debugEl.nativeElement)) {
        continue;
      }
      const tag = debugEl.componentInstance as Tag;
      severities[tag.value!] = tag.severity;
    }
    return severities;
  }

  function countValue(namespace: string, kind: EntryKind): string | null {
    const el = byTest(`ns-count-${namespace}-${kind}`);
    return el === null ? null : el.textContent!.trim();
  }

  /**
   * Total calls across EVERY method on the `ApiService` spy — which is stubbed
   * with the whole catalog surface, not just the two the pane uses.
   *
   * The "one request" claim is about the DATA LAYER, not about one method, so
   * counting a single spy would still pass with a per-kind fan-out re-added
   * through another one. Spanning the surface is what makes THIS assertion the
   * one that fails, with a number in the message, rather than some downstream
   * row expectation going red because an undefined method threw into
   * `loadRows()`'s bare `catch`.
   */
  function totalApiCalls(): number {
    return Object.values(apiSpy as unknown as Record<string, unknown>)
      .filter((value): value is jasmine.Spy => {
        return typeof value === 'function' && 'calls' in value;
      })
      .reduce((total, spy) => total + spy.calls.count(), 0);
  }

  // --- AC 1, 2: the component shell and the single load path ----------------

  it('(AC1) mounts and paints from the root ApiService alone', async () => {
    await render();

    expect(byTest('admin-catalog-pane')).not.toBeNull();
    // The pane holds NamespaceSummary rows verbatim — no row model of its own,
    // and no component-scoped composing provider to resolve.
    expect(component.rows).toEqual(defaultRows());
  });

  it('(36-8 AC2) ONE request paints the page — not seven', async () => {
    // Supersedes 36-2's assertion of SEVEN, which lived in the service suite
    // this story deleted. Assert the NUMBER: "few requests" is not an
    // invariant, and a re-introduced per-kind fan-out would be invisible
    // without it.
    await render();

    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(1);
    // ...and NOTHING else on the data layer. Counting every method on the spy
    // is what catches a fan-out coming back through a different door.
    expect(totalApiCalls()).toBe(1);
  });

  it('(AC2) loads once on init, through getNamespaces, defaulting to all=false', async () => {
    await render();

    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(1);
    expect(apiSpy.getNamespaces).toHaveBeenCalledWith({ all: false });
  });

  it('(AC2) shows a loading indicator while the load is in flight', async () => {
    let release!: (rows: NamespaceSummary[]) => void;
    apiSpy.getNamespaces.and.returnValue(
      new Promise<NamespaceSummary[]>((resolve) => {
        release = resolve;
      }),
    );

    fixture.detectChanges();
    expect(byTest('catalog-loading')).not.toBeNull();
    expect(byTest('catalog-table')).toBeNull();

    release(defaultRows());
    await settle();

    expect(byTest('catalog-loading')).toBeNull();
    expect(byTest('catalog-table')).not.toBeNull();
  });

  it('(AC2) Refresh re-runs the same single load path', async () => {
    await render();

    (byTest('catalog-refresh-btn') as HTMLButtonElement).click();
    await settle();

    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(2);
    expect(apiSpy.getNamespaces.calls.mostRecent().args).toEqual([
      { all: false },
    ]);
  });

  it('(36-8 AC2) the five-namespace fixture yields the same rows, in order', async () => {
    // The row set the deleted composition produced from seven responses, now
    // produced from one. Same namespaces, same order, same per-kind numbers.
    resolveRows(NAMESPACES);
    await render();

    const ids = Array.from(
      fixture.nativeElement.querySelectorAll('[data-test^="ns-id-"]'),
    ).map((el) => (el as HTMLElement).textContent!.trim());
    expect(ids).toEqual([
      'acme-team',
      'acme-coding',
      'contoso-product',
      'global',
      'global-tools',
    ]);

    for (const namespace of ids) {
      // SHOWN_ENTRY_KINDS, not ENTRY_KINDS: Story 36-9 dropped `meta` from the
      // COLUMN (FR21) while leaving it on the wire and in the model, the same
      // way 36-8 superseded 36-2's seven-request count. The numbers themselves
      // are unchanged.
      for (const kind of SHOWN_ENTRY_KINDS) {
        expect(countValue(namespace, kind))
          .withContext(`${namespace}/${kind}`)
          .toBe(String(EXPECTED_COUNTS[namespace][kind]));
      }
    }
  });

  it('(36-8 AC2) the two team-less library namespaces survive as rows', async () => {
    resolveRows(NAMESPACES);
    await render();

    const libraries = component.rows.filter((r) => !r.team).map((r) => r.namespace);
    expect(libraries).toEqual(['global', 'global-tools']);
    expect(countValue('global-tools', 'tool')).toBe('8');
  });

  // --- AC 3: one row per namespace -----------------------------------------

  it('(AC3) renders one row per namespace, in the response order', async () => {
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

  it('(36-8 AC6) owner reaches canModify EXACTLY as it arrived — null stays null', async () => {
    // The pane derives no owner and coerces none. A `?? ''` or a `|| ''`
    // anywhere on this path would turn `null` into `''`, and `canModify`
    // guards on `row.owner !== null` — so an empty string would be compared
    // against the caller's `user_id` instead of failing closed, silently
    // changing who may delete.
    resolveRows([
      row('global', { owner: null, team: false }),
      row('acme-team', { owner: OWNER }),
    ]);
    await render();

    expect(component.rows[0].owner).toBeNull();
    expect(component.rows[0].owner).not.toBe('');
    expect(component.rows[1].owner).toBe(OWNER);
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

  // --- Story 36-11 AC6/AC8: the visibility chip has its OWN severity --------
  //
  // `public` is `success`, `private` is `info`, `shareable` is `warn` and the
  // kind chip is `secondary`. The two middle values are NOT 36-11's: it shipped
  // `private` as `warn` and `shareable` as `info`, and Story 36-13 swapped them.
  // 36-11's story text therefore names the OLD pair — the comment beside the
  // chips in the template is the one that states what is true, and the titles
  // below keep the 36-11 prefix only because that is where the specs came from.
  //
  // All four are asserted, not just the ones that
  // changed. The property being protected is that the VISIBILITY pair
  // (public/private) stays distinguishable from the KIND pair (team/library)
  // beside it — a later change making `team` `info` too would restore exactly
  // the defect this fixes and would sail past a one-assertion spec. The rows
  // come from the same `row()` helper the `(AC4)` value specs above use; a
  // second fixture shape here would be a second source of truth for the same
  // four states.

  it('(36-11 AC6) a PRIVATE namespace renders its visibility chip as info', async () => {
    resolveRows([row('acme-c', { public: false, shareable: true, team: true })]);
    await render();

    expect(chipSeverities('acme-c')['private']).toBe('info');
  });

  it('(36-11 AC6) a PUBLIC namespace renders its visibility chip as success', async () => {
    resolveRows([row('acme-a', { public: true, shareable: true, team: true })]);
    await render();

    expect(chipSeverities('acme-a')['public']).toBe('success');
  });

  it('(36-11 AC6) the shareable chip renders as warn', async () => {
    resolveRows([row('acme-c', { public: false, shareable: true, team: true })]);
    await render();

    expect(chipSeverities('acme-c')['shareable']).toBe('warn');
  });

  it('(36-11 AC6) the KIND chip stays secondary — for team and for library', async () => {
    // The assertion that makes the change mean something: `private` is only a
    // signal while the chip next to it is not the same severity.
    resolveRows([
      row('acme-c', { public: false, team: true }),
      row('global', { public: false, team: false, owner: null }),
    ]);
    await render();

    expect(chipSeverities('acme-c')['team']).toBe('secondary');
    expect(chipSeverities('global')['library']).toBe('secondary');
    // ...and in the same DOM, distinct from the visibility chip beside it.
    expect(chipSeverities('acme-c')['private']).not.toBe(
      chipSeverities('acme-c')['team'],
    );
  });

  it('(36-11 AC8) the new hook addresses the VISIBILITY chip, not a neighbour', async () => {
    // Without this, the hook could drift onto the shareable or kind chip and
    // every assertion above would still pass through `By.directive(Tag)`.
    resolveRows([row('acme-c', { public: false, shareable: true, team: true })]);
    await render();

    const hooked = fixture.debugElement.query(
      By.css('[data-test="ns-visibility-chip-acme-c"]'),
    );
    expect(hooked).not.toBeNull();
    const tag = hooked.componentInstance as Tag;
    expect(tag.value).toBe('private');
    expect(tag.severity).toBe('info');
  });

  // --- AC 5: counts --------------------------------------------------------

  it('(AC5) renders every SHOWN kind for every row, and no meta cell', async () => {
    // Superseded from 36-3's "all six kinds" by Story 36-9 / FR21: `meta` is the
    // `_meta` implementation entry, always 0 or 1, and noise in an operator's
    // list. It stays on the wire and in the model — only the column narrows,
    // which is what the absence assertion below pins.
    await render();

    for (const namespace of ['acme-team', 'contoso-product']) {
      for (const kind of SHOWN_ENTRY_KINDS) {
        expect(countValue(namespace, kind))
          .withContext(`${namespace}/${kind}`)
          .not.toBeNull();
      }
      expect(byTest(`ns-count-${namespace}-meta`))
        .withContext(`${namespace}/meta`)
        .toBeNull();
    }
  });

  it('(AC5) a count of zero renders as the character 0, not blank and not a dash', async () => {
    await render();

    expect(countValue('acme-team', 'agent')).toBe('5');
    expect(countValue('acme-team', 'tool')).toBe('0');
    expect(countValue('acme-team', 'prompt')).toBe('0');
  });

  it('(36-8 AC5) every row carries all six keys, PRESENT and zero-valued', async () => {
    // Re-homed from the deleted service suite, where the zero-fill was the
    // client's. It is the server's now — the assertion survives the move
    // because "a present key whose total is 0" is what the pane depends on,
    // whoever fills it. An absent key would render as the empty string here,
    // indistinguishable from nothing at all now that `—` is gone.
    resolveRows(NAMESPACES);
    await render();

    const expectedKeys = [...ENTRY_KINDS].sort();
    for (const summary of component.rows) {
      expect(Object.keys(summary.counts).sort())
        .withContext(summary.namespace)
        .toEqual(expectedKeys);
    }

    const acmeTeam = component.rows.find((r) => r.namespace === 'acme-team')!;
    expect(acmeTeam.counts.tool).toEqual({ total: 0 });
    expect(countValue('acme-team', 'tool')).toBe('0');
  });

  it('(36-8 AC5) the count is read off the NESTED total, never the object', async () => {
    // `String(counts[kind])` on the nested shape renders "[object Object]".
    // This is the spec that catches a flattening done on the wrong side.
    await render();

    for (const kind of SHOWN_ENTRY_KINDS) {
      expect(countValue('acme-team', kind))
        .withContext(kind)
        .not.toContain('object');
    }
    expect(countValue('acme-team', 'agent')).toBe('5');
  });

  it('(36-8 AC10) the pane applies NO visibility logic — it renders what it is given', async () => {
    // The server tallies through its visibility-filtered listing, so the
    // numbers already match what THIS caller could list. The pane must not
    // second-guess them: the same response renders identically for an admin
    // and for a non-admin.
    resolveRows(NAMESPACES);
    isAdmin$.next(false);
    currentUser$.next({ user_id: OTHER, roles: ['user'] });
    await render();

    const asNonAdmin = SHOWN_ENTRY_KINDS.map((k) =>
      countValue('acme-coding', k),
    );

    isAdmin$.next(true);
    currentUser$.next({ user_id: 'u-admin', roles: ['admin'] });
    await settle();

    expect(SHOWN_ENTRY_KINDS.map((k) => countValue('acme-coding', k))).toEqual(
      asNonAdmin,
    );
    expect(asNonAdmin).toEqual(
      SHOWN_ENTRY_KINDS.map((k) => String(EXPECTED_COUNTS['acme-coding'][k])),
    );
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
    expect(apiSpy.getNamespaces).toHaveBeenCalledWith({ all: false });

    component.onToggleShowAll(true);
    await settle();

    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(2);
    expect(apiSpy.getNamespaces.calls.mostRecent().args).toEqual([
      { all: true },
    ]);
  });

  it('(36-8 AC8) the all flag threads BOTH ways, and adds no other parameter', async () => {
    // The catalog introduced NO new query parameter with the widened DTO —
    // `?all=` on this route already existed. Flipping the toggle back must
    // return to `{ all: false }`, not merely stop sending `true`.
    isAdmin$.next(true);
    await render();

    component.onToggleShowAll(true);
    await settle();
    expect(apiSpy.getNamespaces.calls.mostRecent().args).toEqual([
      { all: true },
    ]);

    component.onToggleShowAll(false);
    await settle();
    expect(apiSpy.getNamespaces.calls.mostRecent().args).toEqual([
      { all: false },
    ]);
    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(3);
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
  });

  it('(AC8) an OWNED row carries NO read-only tag, for a non-admin owner', async () => {
    // Story 36-14 removed the Configure/View control this block used to read
    // ("Configure" for an entitled row). The FACT it proved — entitlement is
    // observable on the row, per row, before clicking anything — is migrated
    // here onto the tag that now carries it, off the same `canModify`.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    isAdmin$.next(false);
    await render();

    expect(readOnlyTag('acme-team')).toBeNull();
  });

  it('(AC9) neither owner nor admin: Delete is PRESENT, disabled, and carries the reason', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    isAdmin$.next(false);
    await render();

    const btn = deleteBtn('contoso-product');
    expect(btn).not.toBeNull(); // present, never hidden
    expect(btn.disabled).toBeTrue();
    expect(btn.getAttribute('title')).toBe(DELETE_DENIED_REASON);
  });

  it('(AC9) neither owner nor admin: the row carries the read-only tag', async () => {
    // Migrated from this block's `'View'` assertion (Story 36-14). Same caller,
    // same row, same fact — the warning a non-owner gets BEFORE clicking.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    isAdmin$.next(false);
    await render();

    const tag = readOnlyTag('contoso-product');
    expect(tag).not.toBeNull();
    expect(tag!.textContent!.trim()).toBe('read-only');
  });

  it('(AC10) an ADMIN who is NOT the owner gets both controls live', async () => {
    // Proves the predicate is a disjunction, not an ownership-only check.
    currentUser$.next({ user_id: 'u-admin', roles: ['admin'] });
    isAdmin$.next(true);
    await render();

    expect(deleteBtn('contoso-product').disabled).toBeFalse();
    expect(deleteBtn('contoso-product').getAttribute('title')).toBeNull();
  });

  it('(AC10) an ADMIN who is NOT the owner gets NO read-only tag', async () => {
    // Migrated from this block's `'Configure'` assertion. The disjunction seen
    // from the tag's side: admin-not-owner must read as entitled, which is the
    // case an ownership-only predicate would get wrong.
    currentUser$.next({ user_id: 'u-admin', roles: ['admin'] });
    isAdmin$.next(true);
    await render();

    expect(readOnlyTag('contoso-product')).toBeNull();
    expect(readOnlyTag('acme-team')).toBeNull();
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
  });

  it('(AC7) an unknown owner and no caller identity: the row reads read-only', async () => {
    // Migrated from this block's `'View'` assertion (Story 36-14), on the same
    // fail-closed input: `owner: null` and a caller with no `user_id` at all.
    resolveRows([row('global', { owner: null, team: false })]);
    currentUser$.next({ name: 'No identity' }); // no `user_id` at all
    isAdmin$.next(false);
    await render();

    const tag = readOnlyTag('global');
    expect(tag).not.toBeNull();
    expect(tag!.textContent!.trim()).toBe('read-only');
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
  });

  it('(AC7b) a LATE admin resolution REMOVES the read-only tag, without remounting', async () => {
    // Migrated from this block's `'Configure'` assertion (Story 36-14), on the
    // same lever. THE spec that fails if the tag is computed once at mount
    // instead of read off the live predicate: `/auth/me` resolves after first
    // render, and a snapshot would leave a genuine admin warned they are
    // read-only on a row they may in fact edit.
    await render();
    expect(readOnlyTag('contoso-product')).not.toBeNull();

    currentUser$.next({ user_id: 'u-admin', roles: ['admin'] });
    isAdmin$.next(true);
    await settle();

    expect(readOnlyTag('contoso-product')).toBeNull();
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

  it('(36-4 AC6) an owned and a non-owned row open the SAME dialog, each on its own row', async () => {
    // 36-3's AC 15 asserted this on a `routerLink`. 36-4 changed the control's
    // destination from a navigation to an in-page dialog, so the assertion
    // moves with it — same intent, relocated. It is the one 36-3 assertion this
    // story is entitled to rewrite.
    //
    // The two label reads it opened with belonged to the Configure/View control
    // Story 36-14 removed; the destination assertions below are the point and
    // are untouched.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    await openPanel('acme-team');
    expect(component.panelVisible).toBeTrue();
    expect(component.panelNamespace).toBe('acme-team');

    // Switching rows re-binds the SAME dialog rather than opening another.
    await openPanel('contoso-product');
    expect(component.panelVisible).toBeTrue();
    expect(component.panelNamespace).toBe('contoso-product');
    expect(panelStub()!.namespace).toBe('contoso-product');
  });

  it('(36-4 AC6) opening the panel does not navigate away from the list', async () => {
    // The URL survives as a bookmark (see admin.routes.spec.ts) but is no
    // longer reachable by clicking: a leftover `href` would navigate away from
    // the list and silently undo the whole story.
    //
    // Story 36-14 removed the Configure/View button this used to inspect, so
    // the guarantee is re-homed onto what opens the panel NOW — the row itself
    // — plus the Clone control beside it. Deleting it instead would leave a
    // `routerLink` creeping back onto either one unguarded.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    const before = window.location.href;
    const rowEl = rowFor('acme-team');
    expect(rowEl.tagName).toBe('TR');
    expect(rowEl.getAttribute('href')).toBeNull();
    expect(rowEl.querySelector('a')).toBeNull();

    await clickRow('acme-team');

    expect(component.panelVisible).toBeTrue();
    expect(window.location.href).toBe(before);

    const clone = byTest('ns-clone-acme-team')!;
    expect(clone.tagName).toBe('BUTTON');
    expect(clone.getAttribute('href')).toBeNull();
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
    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(1);
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
    apiSpy.getNamespaces.and.returnValue(Promise.reject(new Error('boom')));
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
    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(1);
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
    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(1);
  });

  // --- AC 14, 15: existingNamespaces, from data already on screen -----------

  it('(36-4 AC14) opening the dialog issues NO additional request', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    apiSpy.getNamespaces.calls.reset();

    await openPanel('acme-team');

    expect(totalApiCalls()).toBe(0);
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

  // =========================================================================
  // Story 36-9 — the mockup's information architecture, on the app's own style
  // =========================================================================

  // --- AC 4: what the pane publishes to the rail ---------------------------

  it('(36-9 AC4) a successful load publishes the LOADED row count', async () => {
    resolveRows(NAMESPACES);
    await render();

    expect(publishedCatalogCount()).toBe(5);
  });

  it('(36-9 AC4) a FAILED load publishes unknown, never zero', async () => {
    // A `0` in the rail would make the same false claim the empty table would:
    // "this deployment has no namespaces", for a request that never answered.
    apiSpy.getNamespaces.and.returnValue(Promise.reject(new Error('boom')));
    await render();

    expect(component.loadFailed).toBeTrue();
    expect(publishedCatalogCount()).toBeNull();
  });

  it('(36-9 AC4) an EMPTY catalog publishes zero — a fact, not an absence', async () => {
    resolveRows([]);
    await render();

    expect(publishedCatalogCount()).toBe(0);
  });

  it('(36-9 AC2) the published count is the LOADED count, not the filtered one', async () => {
    // The rail states what the deployment holds; the filter box is about what
    // the operator is currently looking at. Publishing the filtered length
    // would make the rail's number jump around as they type.
    await render();
    expect(publishedCatalogCount()).toBe(2);

    component.onFilterChange('acme');
    await settle();

    expect(component.filteredRows.length).toBe(1);
    expect(publishedCatalogCount()).toBe(2);
  });

  it('(36-9 AC4) a delete republishes the smaller count', async () => {
    apiSpy.deleteNamespace.and.returnValue(Promise.resolve());
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    expect(publishedCatalogCount()).toBe(2);

    deleteBtn('acme-team').click();
    await settle();
    (byTest('delete-proceed-btn') as HTMLButtonElement).click();
    await settle();

    expect(publishedCatalogCount()).toBe(1);
  });

  // --- AC 7: the role-aware description ------------------------------------

  it('(36-9 AC7) an admin is told the list is the whole deployment', async () => {
    isAdmin$.next(true);
    await render();

    expect(byTest('catalog-description')!.textContent!.trim()).toBe(
      CATALOG_DESCRIPTION_ADMIN,
    );
  });

  it('(36-9 AC7) everyone else is told what their own list contains', async () => {
    currentUser$.next({ user_id: OTHER, roles: ['user'] });
    await render();

    expect(byTest('catalog-description')!.textContent!.trim()).toBe(
      CATALOG_DESCRIPTION_MEMBER,
    );
  });

  it('(36-9 AC7) a LATE admin resolution rewrites the description in place', async () => {
    // `/auth/me` resolves after first render, so a snapshot would leave a
    // genuine admin told they are looking only at their own namespaces.
    await render();
    expect(byTest('catalog-description')!.textContent!.trim()).toBe(
      CATALOG_DESCRIPTION_MEMBER,
    );

    isAdmin$.next(true);
    await settle();

    expect(byTest('catalog-description')!.textContent!.trim()).toBe(
      CATALOG_DESCRIPTION_ADMIN,
    );
  });

  // --- AC 8, 9: the client-side filter -------------------------------------

  it('(36-9 AC8) the filter box is present and says what it filters', async () => {
    await render();

    const input = byTest('catalog-filter') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.getAttribute('placeholder')).toBe(CATALOG_FILTER_PLACEHOLDER);
  });

  it('(36-9 AC8) typing in the BOX itself narrows the table', async () => {
    // Every other filter spec drives `onFilterChange` directly, which leaves
    // the template's own `(ngModelChange)` binding unasserted: delete that
    // binding and all of them stay green while the box does nothing at all in
    // a browser. This is the one spec that goes through the input an operator
    // actually types in, so the wiring is a fact and not an assumption.
    await render();

    const input = byTest('catalog-filter') as HTMLInputElement;
    input.value = 'contoso';
    input.dispatchEvent(new Event('input'));
    await settle();

    expect(component.filterText).toBe('contoso');
    expect(byTest('ns-id-contoso-product')).not.toBeNull();
    expect(byTest('ns-id-acme-team')).toBeNull();
  });

  it('(36-9 AC8) filtering narrows on the IDENTIFIER, case-insensitively', async () => {
    await render();

    component.onFilterChange('CONTOSO');
    await settle();

    expect(byTest('ns-id-contoso-product')).not.toBeNull();
    expect(byTest('ns-id-acme-team')).toBeNull();
  });

  it('(36-9 AC8) filtering narrows on the DISPLAY NAME too', async () => {
    // The fixture's names are `<namespace> display`, so a needle that only the
    // NAME carries is the one that proves both fields are matched.
    resolveRows([
      row('ns-one', { name: 'Payroll workspace' }),
      row('ns-two', { name: 'Sandbox' }),
    ]);
    await render();

    component.onFilterChange('payroll');
    await settle();

    expect(byTest('ns-id-ns-one')).not.toBeNull();
    expect(byTest('ns-id-ns-two')).toBeNull();
  });

  it('(36-9 AC8) the needle is TRIMMED before matching', async () => {
    await render();

    component.onFilterChange('  acme  ');
    await settle();

    expect(byTest('ns-id-acme-team')).not.toBeNull();
    expect(byTest('ns-id-contoso-product')).toBeNull();
  });

  it('(36-9 AC8) typing issues ZERO requests', async () => {
    // The whole point of Story 36-8's single load. A request per keystroke
    // would give it back with interest, and only a NUMBER catches that.
    await render();
    const before = totalApiCalls();

    component.onFilterChange('a');
    await settle();
    component.onFilterChange('ac');
    await settle();
    component.onFilterChange('acme');
    await settle();
    component.onFilterChange('');
    await settle();

    expect(totalApiCalls()).toBe(before);
  });

  it('(36-9 AC8) clearing the filter restores every row', async () => {
    await render();
    component.onFilterChange('acme');
    await settle();
    expect(byTest('ns-id-contoso-product')).toBeNull();

    component.onFilterChange('');
    await settle();

    expect(byTest('ns-id-acme-team')).not.toBeNull();
    expect(byTest('ns-id-contoso-product')).not.toBeNull();
  });

  it('(36-9 AC8) the loaded set is untouched by filtering', async () => {
    // `component.rows` stays what the server sent — the filter is a view over
    // it, not a replacement for it.
    await render();

    component.onFilterChange('acme');
    await settle();

    expect(component.rows).toEqual(defaultRows());
  });

  it('(36-9 AC9) a filter matching nothing is NOT an empty catalog', async () => {
    // Three distinct states, three distinct hooks. Collapsing the no-match case
    // into `catalog-empty` would tell the operator the deployment is empty
    // when their own filter is what is hiding everything.
    await render();

    component.onFilterChange('nothing-matches-this');
    await settle();

    expect(byTest('catalog-no-match')).not.toBeNull();
    expect(byTest('catalog-empty')).toBeNull();
    expect(byTest('catalog-load-failed')).toBeNull();
    expect(byTest('catalog-table')).toBeNull();
  });

  it('(36-9 AC9) an EMPTY catalog still renders catalog-empty, not the no-match state', async () => {
    resolveRows([]);
    await render();

    expect(byTest('catalog-empty')).not.toBeNull();
    expect(byTest('catalog-no-match')).toBeNull();
  });

  it('(36-9 AC9) a deleted row leaves the FILTERED view too', async () => {
    // The delete-success path rebuilds `rows`; if it does not rebuild the
    // filtered view, the row survives on screen whenever a filter is on.
    apiSpy.deleteNamespace.and.returnValue(Promise.resolve());
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    component.onFilterChange('acme');
    await settle();
    expect(byTest('ns-id-acme-team')).not.toBeNull();

    deleteBtn('acme-team').click();
    await settle();
    (byTest('delete-proceed-btn') as HTMLButtonElement).click();
    await settle();

    expect(byTest('ns-id-acme-team')).toBeNull();
    expect(component.filteredRows.map((r) => r.namespace)).toEqual([]);
  });

  // --- AC 10: identifier first ---------------------------------------------

  it('(36-9 AC10) the Namespace cell puts the IDENTIFIER before the display name', async () => {
    // DOM ORDER, not a class and not a font: the identifier is what you act on,
    // deep-link to and filter against, so it leads.
    await render();

    const idEl = byTest('ns-id-acme-team')!;
    const cell = idEl.parentElement!;
    const nameEl = cell.querySelector('.admin-catalog__ns-name')!;

    expect(idEl.textContent!.trim()).toBe('acme-team');
    expect(nameEl.textContent!.trim()).toBe('acme-team display');
    expect(
      idEl.compareDocumentPosition(nameEl) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // --- AC 11: the `you` chip -----------------------------------------------

  it('(36-9 AC11) the owner gets a "you" chip on their own row', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    expect(byTest('ns-owner-you-acme-team')).not.toBeNull();
    expect(byTest('ns-owner-you-acme-team')!.textContent!.trim()).toBe('you');
    // ...and not on the row they do not own.
    expect(byTest('ns-owner-you-contoso-product')).toBeNull();
  });

  it('(36-9 AC11) an ADMIN who is not the owner gets NO chip', async () => {
    // The chip says "yours", not "you may". An admin may modify every row and
    // owns none of them here — marking them all would make the chip meaningless.
    currentUser$.next({ user_id: 'u-admin', roles: ['admin'] });
    isAdmin$.next(true);
    await render();

    expect(component.canModify(component.rows[0])).toBeTrue();
    expect(byTest('ns-owner-you-acme-team')).toBeNull();
    expect(byTest('ns-owner-you-contoso-product')).toBeNull();
  });

  it('(36-9 AC11) an UNKNOWN owner gets no chip, whoever is asking', async () => {
    // `owner === null` must not coincide with a caller who also has none.
    resolveRows([row('global', { owner: null, team: false })]);
    currentUser$.next({ name: 'No identity' });
    await render();

    expect(component.isOwnedByViewer(component.rows[0])).toBeFalse();
    expect(byTest('ns-owner-you-global')).toBeNull();
  });

  it('(36-9 AC11) the chip and canModify read ONE expression', async () => {
    // The refactor's evidence: `canModify` is `isAdmin || isOwnedByViewer`, so
    // for a non-admin the two must agree row for row. A second equality written
    // for the chip would drift from this one.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    isAdmin$.next(false);
    await render();

    for (const r of component.rows) {
      expect(component.canModify(r))
        .withContext(r.namespace)
        .toBe(component.isOwnedByViewer(r));
    }
  });

  // --- AC 12: the Σ total and dimmed zeros ---------------------------------

  it('(36-9 AC12) Σ sums the SHOWN kinds, excluding meta', async () => {
    // `acme-team` is team 1, agent 5, tool 0, model 0, prompt 1, meta 1. The
    // total is 7, not 8 — the fixture is chosen so that dropping `meta` changes
    // the answer, which is the only way this assertion proves anything.
    resolveRows(NAMESPACES);
    await render();

    expect(byTest('ns-total-acme-team')!.textContent!.trim()).toBe('7');
    expect(component.shownTotal(component.rows[0])).toBe(7);
  });

  it('(36-9 AC12) Σ agrees with the numbers rendered beside it', async () => {
    // The column must add up on inspection, for every row.
    resolveRows(NAMESPACES);
    await render();

    for (const summary of component.rows) {
      const shown = SHOWN_ENTRY_KINDS.map((kind) =>
        Number(countValue(summary.namespace, kind)),
      ).reduce((a, b) => a + b, 0);
      expect(byTest(`ns-total-${summary.namespace}`)!.textContent!.trim())
        .withContext(summary.namespace)
        .toBe(String(shown));
    }
  });

  it('(36-9 AC12) a zero is PRESENT and marked, never hidden', async () => {
    // Absent would read as "unknown", which is exactly what a zero is not —
    // Story 36-8 works hard to guarantee a present zero. The marker is asserted,
    // the colour and the opacity are not: a spec pinned to those makes the
    // theme unchangeable.
    await render();

    const zero = byTest('ns-count-acme-team-tool')!;
    expect(zero.textContent!.trim()).toBe('0');
    expect(
      zero.closest('.admin-catalog__count')!.classList,
    ).toContain('admin-catalog__count--zero');

    const nonZero = byTest('ns-count-acme-team-agent')!;
    expect(nonZero.textContent!.trim()).toBe('5');
    expect(
      nonZero.closest('.admin-catalog__count')!.classList,
    ).not.toContain('admin-catalog__count--zero');
  });

  // --- The table's own cell contract ----------------------------------------

  it('(36-9 review) each column lives INSIDE its own cell, and the row has five', async () => {
    // WHAT THIS CANNOT DO, said plainly: it does not catch the bug it was
    // written for. Three `<td>`s carried a class whose SCSS set
    // `display: flex`, which stops a cell being a `table-cell` — the browser
    // drops it from the column grid, wraps the survivors in anonymous table
    // boxes, and the row renders two columns under a five-column header. In
    // the DOM those `<td>`s are still correct siblings, so Karma sees nothing
    // wrong; the table rendered broken from Story 36-3 through 36-8 with a
    // fully green suite. Asserting a computed style instead would pin the
    // theme, which the epic's testing rule forbids and which would not have
    // caught it either (the cell was legitimately flex — on the wrong node).
    //
    // What IS assertable is the structural contract the CSS must not
    // contradict: as many body cells as header cells, and every column's
    // content nested inside its own cell rather than beside it. A future
    // refactor that hoists content back out of a `<td>` goes red here.
    resolveRows(NAMESPACES);
    await render();

    const headerCells = fixture.nativeElement.querySelectorAll(
      '.p-datatable-thead > tr > th',
    ).length;
    const row = byTest('ns-row-acme-team')!;
    const cells = Array.from(row.querySelectorAll('td'));

    expect(cells.length).toBe(5);
    expect(cells.length).toBe(headerCells);
    expect(cells[0].querySelector('[data-test="ns-id-acme-team"]')).not.toBeNull();
    expect(cells[2].querySelector('.admin-catalog__chips')).not.toBeNull();
    expect(
      cells[3].querySelector('[data-test="ns-total-acme-team"]'),
    ).not.toBeNull();
    expect(
      cells[4].querySelector('[data-test="ns-delete-acme-team"]'),
    ).not.toBeNull();
  });

  it('(36-9 AC12) the shown kinds are DERIVED from the protocol tuple', async () => {
    // Hand-writing the five is the one way this list falls silently behind a
    // seventh kind added server-side.
    expect(SHOWN_ENTRY_KINDS).toEqual(
      ENTRY_KINDS.filter((kind) => kind !== 'meta'),
    );
    expect(SHOWN_ENTRY_KINDS).not.toContain('meta');
  });

  // --- AC 13, 15: three controls, in order ---------------------------------

  it('(36-9 AC13) the row carries export, clone and delete, in that order', async () => {
    // Story 36-14: Configure/View is gone (the row click replaces it) and Clone
    // takes the middle slot, between the read-only export and the destructive
    // delete.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    const hooks = Array.from(
      byTest('ns-row-acme-team')!.querySelectorAll(
        '[data-test^="ns-export-"], [data-test^="ns-clone-"], [data-test^="ns-delete-"]',
      ),
    ).map((el) => el.getAttribute('data-test'));
    expect(hooks).toEqual([
      'ns-export-acme-team',
      'ns-clone-acme-team',
      'ns-delete-acme-team',
    ]);
  });

  it('(36-9 AC13) all three stay NATIVE buttons', async () => {
    // A `<p-button>` component would keep the `data-test` hook on its own host,
    // so `.tagName` and `.disabled` — which the authorization specs read —
    // would report `P-BUTTON` and `undefined`.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    for (const hook of ['ns-export', 'ns-clone', 'ns-delete']) {
      expect(byTest(`${hook}-acme-team`)!.tagName)
        .withContext(hook)
        .toBe('BUTTON');
    }
  });

  it('(36-9 AC13) the row still says, in TEXT, who may modify it', async () => {
    // This block used to assert the Configure/View label, and its subject is
    // gone. What it EXISTED to guarantee is not: the entitlement affordance is
    // a piece of text on the row, readable before clicking anything, and not a
    // colour or a disabled state a non-owner has to infer. Story 36-14 moved it
    // onto the `read-only` tag; asserting the tag is asserting the same
    // guarantee on its new carrier.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    isAdmin$.next(false);
    await render();

    expect(readOnlyTag('acme-team')).toBeNull();
    expect(readOnlyTag('contoso-product')!.textContent!.trim()).toBe(
      'read-only',
    );
  });

  it('(36-9 AC15) the icon delete keeps disabled + title on a NON-OWNER row', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    isAdmin$.next(false);
    await render();

    const btn = deleteBtn('contoso-product');
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBeTrue();
    expect(btn.getAttribute('title')).toBe(DELETE_DENIED_REASON);
  });

  it('(36-9 AC15) an ENTITLED row carries NO title — the name comes from aria-label', async () => {
    // `title` means one thing here: the denial reason. A well-meaning
    // `title="Delete namespace"` added for the icon-only case would redden the
    // AC8 and AC10 authorization specs above.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    const btn = deleteBtn('acme-team');
    expect(btn.disabled).toBeFalse();
    expect(btn.getAttribute('title')).toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('Delete namespace acme-team');
  });

  it('(36-9 AC13) delete no longer carries the destructive class', async () => {
    // Destructive intent lives in the confirmation dialog, whose Proceed keeps
    // its treatment — asserted here so the two do not both drift.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    expect(deleteBtn('acme-team').classList).not.toContain(
      'admin-catalog__danger',
    );

    deleteBtn('acme-team').click();
    await settle();

    expect(
      (byTest('delete-proceed-btn') as HTMLButtonElement).classList,
    ).toContain('admin-catalog__danger');
  });

  // --- AC 14: export -------------------------------------------------------

  /** Watch the object-URL lifecycle instead of letting a real download run. */
  function stubObjectUrl(): { create: jasmine.Spy; revoke: jasmine.Spy } {
    return {
      create: spyOn(URL, 'createObjectURL').and.returnValue('blob:stub'),
      revoke: spyOn(URL, 'revokeObjectURL'),
    };
  }

  it('(36-9 AC14) export calls the existing client with the row and all=false', async () => {
    stubObjectUrl();
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('kind: team\n'));
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    (byTest('ns-export-acme-team') as HTMLButtonElement).click();
    await settle();

    expect(apiSpy.exportNamespace).toHaveBeenCalledOnceWith('acme-team', {
      all: false,
    });
  });

  it('(36-9 AC14) export threads `all` exactly as loadRows does', async () => {
    // So an admin in "show all" can export a namespace they do not own: the
    // flag that made the row visible is the flag that makes it readable.
    stubObjectUrl();
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('kind: team\n'));
    isAdmin$.next(true);
    currentUser$.next({ user_id: 'u-admin', roles: ['admin'] });
    await render();
    component.onToggleShowAll(true);
    await settle();

    (byTest('ns-export-contoso-product') as HTMLButtonElement).click();
    await settle();

    expect(apiSpy.exportNamespace).toHaveBeenCalledOnceWith('contoso-product', {
      all: true,
    });
  });

  it('(36-9 AC14) the YAML is handed to the browser as <namespace>.yaml', async () => {
    const url = stubObjectUrl();
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('kind: team\n'));
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    (byTest('ns-export-acme-team') as HTMLButtonElement).click();
    await settle();

    expect(url.create).toHaveBeenCalledTimes(1);
    expect(url.create.calls.mostRecent().args[0] instanceof Blob).toBeTrue();
    // The leak check: an un-revoked object URL holds its buffer for the life of
    // the document.
    expect(url.revoke).toHaveBeenCalledOnceWith('blob:stub');
  });

  it('(36-9 AC14) a SECOND activation while one export is in flight is refused', async () => {
    // By a TypeScript early return, not by a `[disabled]` attribute: a disabled
    // attribute does not stop a keyboard-driven activation (epic 33's lesson),
    // so the guard is driven here by calling the handler directly.
    stubObjectUrl();
    let release!: (yaml: string) => void;
    apiSpy.exportNamespace.and.returnValue(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    void component.onExportClick(component.rows[0]);
    void component.onExportClick(component.rows[0]);
    await settle();

    expect(apiSpy.exportNamespace).toHaveBeenCalledTimes(1);

    release('kind: team\n');
    await settle();

    // ...and the gate reopens once the first one lands.
    void component.onExportClick(component.rows[0]);
    await settle();
    expect(apiSpy.exportNamespace).toHaveBeenCalledTimes(2);
  });

  it('(36-9 AC14) a rejected export leaves the row and raises NO toast of its own', async () => {
    // FetchService already surfaced the server's message (ADR-026); a second
    // would report one failure twice.
    const url = stubObjectUrl();
    apiSpy.exportNamespace.and.callFake(async () => {
      messageSpy.add({ severity: 'error', summary: 'Error', detail: 'boom' });
      throw new HttpError('boom', 500, 'boom');
    });
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    (byTest('ns-export-acme-team') as HTMLButtonElement).click();
    await settle();

    expect(byTest('ns-id-acme-team')).not.toBeNull();
    expect(messageSpy.add).toHaveBeenCalledTimes(1);
    expect(url.create).not.toHaveBeenCalled();
    // ...and the single-flight gate is released, not stuck closed.
    expect(component.exporting).toBeFalse();
  });

  it('(36-4 AC15) (saved) refreshes the table AND the panel list in ONE call', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    await openPanel('acme-team');
    apiSpy.getNamespaces.calls.reset();

    // A namespace present only in the SECOND response — e.g. one the panel's
    // Clone just created.
    resolveRows([...defaultRows(), row('acme-cloned')]);
    panelStub()!.saved.emit();
    await settle();

    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(1);
    expect(byTest('ns-id-acme-cloned')).not.toBeNull();
    expect(panelStub()!.existingNamespaces).toContain('acme-cloned');
  });

  // =========================================================================
  // Story 36-10 — the filter matches every field the row already carries
  // =========================================================================

  /**
   * Rows whose four fields do NOT echo one another — the only shape that can
   * prove per-field matching.
   *
   * `defaultRows()` cannot: `row()` derives `name` and `description` from the
   * namespace, so a needle like `acme` hits three fields at once and a spec
   * written over it would stay green with three of the four fields unmatched.
   * Here each needle below is carried by exactly ONE field of ONE row:
   *
   *   `ns-one`     → namespace only
   *   `workspace`  → name only
   *   `ingestion`  → description only
   *   `marie`      → owner only
   *
   * `ns-two` carries none of them.
   */
  function distinctFieldRows(): NamespaceSummary[] {
    return [
      row('ns-one', {
        name: 'Payroll workspace',
        description: 'handles ingestion of monthly files',
        owner: 'u-marie',
      }),
      row('ns-two', {
        name: 'Sandbox',
        description: 'scratch space',
        owner: OTHER,
      }),
    ];
  }

  /** The identifiers currently rendered, in table order. */
  function renderedNamespaces(): string[] {
    return component.filteredRows.map((r) => r.namespace);
  }

  /** Type into the box an operator actually types in, not into the handler. */
  async function typeInFilterBox(text: string): Promise<void> {
    const input = byTest('catalog-filter') as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  // --- AC 1: all four fields are matched, each on its own -------------------

  it('(36-10 AC1) a needle only the NAMESPACE carries narrows the table', async () => {
    resolveRows(distinctFieldRows());
    await render();

    component.onFilterChange('ns-one');
    await settle();

    expect(renderedNamespaces()).toEqual(['ns-one']);
    expect(byTest('ns-id-ns-two')).toBeNull();
  });

  it('(36-10 AC1) a needle only the DISPLAY NAME carries narrows the table', async () => {
    resolveRows(distinctFieldRows());
    await render();

    component.onFilterChange('workspace');
    await settle();

    expect(renderedNamespaces()).toEqual(['ns-one']);
    expect(byTest('ns-id-ns-two')).toBeNull();
  });

  it('(36-10 AC1) a needle only the DESCRIPTION carries narrows the table', async () => {
    // The one that matters most: no column renders `description`, so without
    // this spec the field could be matched by nobody and missed by everybody.
    resolveRows(distinctFieldRows());
    await render();

    component.onFilterChange('ingestion');
    await settle();

    expect(renderedNamespaces()).toEqual(['ns-one']);
    expect(byTest('ns-id-ns-two')).toBeNull();
  });

  it('(36-10 AC1) a needle only the OWNER carries narrows the table', async () => {
    resolveRows(distinctFieldRows());
    await render();

    component.onFilterChange('marie');
    await settle();

    expect(renderedNamespaces()).toEqual(['ns-one']);
    expect(byTest('ns-id-ns-two')).toBeNull();
  });

  it('(36-10 AC1) matching is a SUBSTRING and case-insensitive on every field', async () => {
    // Not a prefix: `gestio` sits in the middle of `ingestion`, and an operator
    // typing a fragment of a description is the reported use.
    resolveRows(distinctFieldRows());
    await render();

    for (const needle of ['S-ON', 'WORKSPACE', 'gestio', 'MARIE']) {
      component.onFilterChange(needle);
      await settle();
      expect(renderedNamespaces()).withContext(needle).toEqual(['ns-one']);
    }
  });

  // --- AC 2: terms are ANDed, fields are ORed -------------------------------

  it('(36-10 AC2) a row matching only ONE of two terms is EXCLUDED', async () => {
    // The AND. Flip `every` to `some` and `ns-three` — which carries `marie`
    // and nothing else — comes back, which is what this fixture separates.
    resolveRows([
      ...distinctFieldRows(),
      row('ns-three', { name: 'Archive', description: 'cold storage', owner: 'u-marie' }),
    ]);
    await render();

    component.onFilterChange('marie payroll');
    await settle();

    expect(renderedNamespaces()).toEqual(['ns-one']);
    expect(byTest('ns-id-ns-three')).toBeNull();
  });

  it('(36-10 AC2) two terms landing on two DIFFERENT fields both count', async () => {
    // The OR across fields, inside the AND across terms: `marie` is only in
    // `owner` and `ns-one` is only in `namespace`, so neither term alone is
    // the match and no single field carries both.
    resolveRows(distinctFieldRows());
    await render();

    await typeInFilterBox('marie ns-one');

    expect(component.filterText).toBe('marie ns-one');
    expect(renderedNamespaces()).toEqual(['ns-one']);
    expect(byTest('ns-id-ns-one')).not.toBeNull();
    expect(byTest('ns-id-ns-two')).toBeNull();
  });

  it('(36-10 AC2) runs of whitespace collapse — the query is the same query', async () => {
    resolveRows(distinctFieldRows());
    await render();

    component.onFilterChange('  marie   ns-one  ');
    await settle();

    expect(renderedNamespaces()).toEqual(['ns-one']);
  });

  it('(36-10 AC2) a query of nothing but whitespace hides no row', async () => {
    // `'   '.trim().split(/\s+/)` is `['']`, and an empty term matches every
    // string — so an unfiltered term list must be EMPTY, not one blank term.
    resolveRows(distinctFieldRows());
    await render();

    component.onFilterChange('   ');
    await settle();

    expect(renderedNamespaces()).toEqual(['ns-one', 'ns-two']);
    expect(component.filterHidesEverything).toBeFalse();
    // THE assertion that actually bites. Everything above stays green with the
    // empty-term guard deleted: `''.includes('')` is true for every field, so
    // one blank term matches every row and the visible outcome is identical.
    // What differs is that the unfiltered path assigns `rows` ITSELF, while a
    // blank term walks the predicate and builds a new array. Verified by
    // mutation: drop `.filter((term) => term !== '')` and only this line goes
    // red — the whole suite was green without it.
    expect(component.filteredRows).toBe(component.rows);
  });

  // --- AC 4: a null owner ---------------------------------------------------

  it('(36-10 AC4) a null owner neither throws nor matches, and survives an empty filter', async () => {
    resolveRows([row('ns-unowned', { owner: null }), row('ns-two')]);
    await render();

    expect(() => component.onFilterChange('marie')).not.toThrow();
    await settle();
    // Excluded by a term it does not otherwise carry...
    expect(renderedNamespaces()).toEqual([]);

    component.onFilterChange('');
    await settle();

    // ...and back when the filter is empty.
    expect(renderedNamespaces()).toEqual(['ns-unowned', 'ns-two']);
  });

  // --- AC 5: the no-match state names the query and offers a way out --------

  it('(36-10 AC5) the no-match state NAMES the trimmed query', async () => {
    resolveRows(distinctFieldRows());
    await render();

    component.onFilterChange('  no-such-namespace  ');
    await settle();

    const block = byTest('catalog-no-match')!;
    expect(block).not.toBeNull();
    expect(byTest('catalog-no-match-query')!.textContent!.trim()).toBe(
      'no-such-namespace',
    );
    expect(block.textContent).toContain(CATALOG_NO_MATCH_MESSAGE);
    expect(block.textContent).toContain('no-such-namespace');
    // The TRIM itself, at its source. Every assertion above survives a
    // `trimmedFilter` that forgot to trim: `.trim()` on the read side and
    // `toContain` both hide the padding, and HTML collapses it on screen.
    expect(component.trimmedFilter).toBe('no-such-namespace');
  });

  it('(36-10 AC5) the clear control restores every row, the field AND the box', async () => {
    // The box's own `value` is asserted because a handler that reset only
    // `filterText` would leave the operator reading a query that no longer
    // applies — the state and the control disagreeing on screen.
    resolveRows(distinctFieldRows());
    await render();

    await typeInFilterBox('no-such-namespace');
    expect(byTest('catalog-no-match')).not.toBeNull();

    const clear = byTest('catalog-no-match-clear') as HTMLButtonElement;
    expect(clear).not.toBeNull();
    expect(clear.tagName).toBe('BUTTON');
    clear.click();
    await settle();

    expect(component.filterText).toBe('');
    expect((byTest('catalog-filter') as HTMLInputElement).value).toBe('');
    expect(renderedNamespaces()).toEqual(['ns-one', 'ns-two']);
    expect(byTest('catalog-no-match')).toBeNull();
    expect(byTest('catalog-table')).not.toBeNull();
  });

  // --- AC 6: empty catalog and no-match are different facts -----------------

  it('(36-10 AC6) an empty catalog and a filter hiding everything render DIFFERENTLY', async () => {
    // Both directions in one body, so the distinction cannot be half-lost:
    // rendering `catalog-empty` for a loaded catalog tells the operator their
    // data is gone.
    resolveRows([]);
    await render();

    expect(byTest('catalog-empty')).not.toBeNull();
    expect(byTest('catalog-no-match')).toBeNull();
    expect(byTest('catalog-load-failed')).toBeNull();

    resolveRows(distinctFieldRows());
    await component.loadRows();
    await settle();
    component.onFilterChange('no-such-namespace');
    await settle();

    expect(byTest('catalog-no-match')).not.toBeNull();
    expect(byTest('catalog-empty')).toBeNull();
    expect(byTest('catalog-load-failed')).toBeNull();
  });

  // --- AC 7: the description reaches the namespace cell's title -------------

  it('(36-10 AC7) the namespace cell carries the DESCRIPTION as its title', async () => {
    // The field is matched but rendered in no column, so a row that matched on
    // it would otherwise look like it matched on nothing.
    await render();

    const cell = byTest('ns-id-acme-team')!.parentElement!;
    expect(cell.tagName).toBe('TD');
    expect(cell.getAttribute('title')).toBe('acme-team description');
  });

  it('(36-10 AC7) an EMPTY description leaves no title attribute at all', async () => {
    // `[attr.title]=""` renders `title=""`, which hovers as an empty tooltip
    // box and reads to a spec as "a title is present".
    resolveRows([row('ns-undescribed', { description: '' })]);
    await render();

    const cell = byTest('ns-id-ns-undescribed')!.parentElement!;
    expect(cell.getAttribute('title')).toBeNull();
  });

  it('(36-10 AC7) the cell keeps its two children, in order', async () => {
    // The title goes ON the existing cell — no new element, no wrapper, no
    // move. `(36-9 AC10)` walks this markup.
    await render();

    const idEl = byTest('ns-id-acme-team')!;
    const cell = idEl.parentElement!;
    expect(cell.children.length).toBe(2);
    expect(cell.children[0]).toBe(idEl);
    expect(cell.children[1].classList).toContain('admin-catalog__ns-name');
  });

  // --- AC 8: still zero requests --------------------------------------------

  it('(36-10 AC8) a MULTI-TERM query and the clear control issue ZERO requests', async () => {
    // Across the WHOLE spy: a single-method count would pass with a fan-out
    // returning through another door.
    resolveRows(distinctFieldRows());
    await render();
    const before = totalApiCalls();

    await typeInFilterBox('marie ns-one');
    await typeInFilterBox('marie ns-one extra');
    await typeInFilterBox('no-such-namespace');
    (byTest('catalog-no-match-clear') as HTMLButtonElement).click();
    await settle();

    expect(totalApiCalls()).toBe(before);
    expect(renderedNamespaces()).toEqual(['ns-one', 'ns-two']);
  });

  // --- the flex wrappers are DIVS, never the cell itself --------------------

  it('no <td> carries a flex-wrapper class — they belong to the div inside', async () => {
    // The defect a user found and 1760 green specs missed: `display: flex` on a
    // `<td>` drops `table-cell`, so the header keeps rendering five columns
    // while the row renders two. The DOM tree is IDENTICAL either way, which is
    // why no structural spec saw it.
    //
    // `(36-9 AC11)` asserts `cells[2].querySelector('.admin-catalog__chips')`
    // is not null — but that still passes if the class is ALSO re-applied to
    // the `<td>`, which is exactly how the bug would come back. This is the
    // other half: the cell's OWN classList must not carry any of the three.
    await render();

    const wrappers = [
      'admin-catalog__chips',
      'admin-catalog__counts',
      'admin-catalog__actions',
    ];
    const row = byTest('ns-row-acme-team')!;
    const cells = Array.from(row.querySelectorAll('td'));

    for (const wrapper of wrappers) {
      // Present on a div inside a cell — so this cannot pass by the class
      // having been renamed out of existence.
      const el = row.querySelector('.' + wrapper);
      expect(el).withContext(wrapper).not.toBeNull();
      expect(el!.tagName).withContext(wrapper).toBe('DIV');

      for (const cell of cells) {
        expect(cell.classList.contains(wrapper))
          .withContext(wrapper + ' on a <td>')
          .toBeFalse();
      }
    }
  });

  // === Story 36-12: the whole row is the target =============================
  //
  // EVERY spec below drives a REAL DOM interaction — a click on an actual
  // element, a keydown on an actual row. None of them calls
  // `component.onRowSelect(...)` or `component.onPrimaryActionClick(...)`.
  // This story is nothing but template wiring, and a spec that calls the
  // handler proves the handler works while saying nothing about whether the
  // row is clickable at all — which is the entire point.

  /** The `<tr>` for a namespace, by the hook 36-3 put on it. */
  function rowFor(namespace: string): HTMLTableRowElement {
    return byTest(`ns-row-${namespace}`) as HTMLTableRowElement;
  }

  /** The one `p-table` this pane renders — read for its internal selection. */
  function tableInstance(): Table {
    return fixture.debugElement.query(By.directive(Table))
      .componentInstance as Table;
  }

  it('(36-12 AC1) clicking a row CELL opens the panel on that row', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    expect(panelStub()).toBeUndefined();

    await clickRow('acme-team');

    expect(component.panelVisible).toBeTrue();
    expect(panelStub()!.namespace).toBe('acme-team');
  });

  it('(36-12 AC2) the row reaches the panel through the SAME handler Configure calls', async () => {
    // One destination, not two: the row click must not become a second way in
    // with a label or a namespace of its own.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    const primary = spyOn(component, 'onPrimaryActionClick').and.callThrough();

    await clickRow('acme-team');

    expect(primary).toHaveBeenCalledTimes(1);
    expect(component.panelNamespace).toBe('acme-team');
    expect(component.panelLabel).toBe('acme-team display');

    // Switching rows re-binds the same dialog, exactly as Configure does.
    await clickRow('contoso-product');

    expect(panelStub()!.namespace).toBe('contoso-product');
    expect(component.panelLabel).toBe('contoso-product display');
  });

  it('(36-12 AC3) a row control opens the panel exactly ONCE and selects no row', async () => {
    // What this establishes, and what it does not: PrimeNG's `handleRowClick`
    // already returns early when the click target — or its immediate parent —
    // is a BUTTON, so this spec stays green with the `stopPropagation`
    // removed. It pins the guarantee; it does not test our implementation of
    // it. See the Completion Notes.
    //
    // Re-homed onto Clone (Story 36-14): Configure was the control it clicked
    // and Clone is the one that now opens the panel from inside the cell.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    const primary = spyOn(component, 'onPrimaryActionClick').and.callThrough();

    (byTest('ns-clone-acme-team') as HTMLButtonElement).click();
    await settle();
    await settle();

    expect(primary).toHaveBeenCalledTimes(1);
    expect(panelStub()!.namespace).toBe('acme-team');
    // The row's own click path did not run: no row became the table's
    // selection.
    expect(tableInstance().selection).toBeFalsy();
  });

  it('(36-12 AC4) export does NOT open the panel', async () => {
    stubObjectUrl();
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('kind: team\n'));
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    (byTest('ns-export-acme-team') as HTMLButtonElement).click();
    await settle();
    await settle();

    expect(apiSpy.exportNamespace).toHaveBeenCalledOnceWith('acme-team', {
      all: false,
    });
    expect(component.panelVisible).toBeFalse();
    expect(panelStub()).toBeUndefined();
    expect(tableInstance().selection).toBeFalsy();
  });

  it('(36-12 AC5) delete opens the confirmation and NOTHING behind it', async () => {
    // Two stacked dialogs is the failure this AC exists to prevent: both are
    // `[closeOnEscape]="false"` and Escape is arbitrated by one document-level
    // handler that was never designed for this pairing.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    deleteBtn('acme-team').click();
    await settle();
    await settle();

    expect(byTest('delete-confirm-namespace')!.textContent!.trim()).toBe(
      'acme-team',
    );
    expect(component.panelVisible).toBeFalse();
    expect(panelStub()).toBeUndefined();
  });

  it('(36-12 AC6) a DISABLED delete opens neither dialog', async () => {
    // `HTMLElement.click()` on a disabled form control is a no-op per the HTML
    // spec, and a real user click on one dispatches no event at all — nothing
    // reaches the `<tr>`. So this is the faithful simulation, and the
    // guarantee comes from the platform rather than from our code. It is still
    // worth pinning: it reddens the day the denial is expressed as a CSS class
    // or a TypeScript early return instead of the `disabled` attribute, at
    // which point the row WOULD open under a control that just said no.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    isAdmin$.next(false);
    await render();

    const btn = deleteBtn('contoso-product');
    expect(btn.disabled).toBeTrue();

    btn.click();
    await settle();
    await settle();

    expect(byTest('delete-proceed-btn')).toBeNull();
    expect(component.panelVisible).toBeFalse();
    expect(panelStub()).toBeUndefined();
  });

  it('(36-12 AC7) clicking the SAME row twice reopens the panel', async () => {
    // THE TRAP. PrimeNG single selection is a TOGGLE with `metaKeySelection`
    // false: the second click on an already-selected row emits
    // `onRowUnselect` and NOT `onRowSelect`. An operator hits this on their
    // second interaction.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    await clickRow('acme-team');
    expect(component.panelVisible).toBeTrue();

    panelStub()!.closed.emit();
    await settle();
    expect(component.panelVisible).toBeFalse();

    await clickRow('acme-team');

    expect(component.panelVisible).toBeTrue();
    expect(panelStub()!.namespace).toBe('acme-team');
  });

  it('(36-12 AC8) every row is keyboard-reachable and Enter opens the panel', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    for (const namespace of ['acme-team', 'contoso-product']) {
      expect(rowFor(namespace).hasAttribute('tabindex'))
        .withContext(namespace)
        .toBeTrue();
    }

    // `SelectableRow.onKeyDown` switches on `event.code`, so a `key`-only
    // event reaches nothing.
    rowFor('contoso-product').dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Enter', bubbles: true }),
    );
    await settle();
    await settle();

    expect(component.panelVisible).toBeTrue();
    expect(panelStub()!.namespace).toBe('contoso-product');

    // `[pSelectableRowIndex]` is STILL bound and still meaningful — that is
    // what 36-12 was protecting here, through the roving tabindex it produced
    // (`0` on the activated row, `-1` on its neighbours).
    //
    // Story 36-14 retains no selection, and `setRowTabIndex()` short-circuits
    // to `0` for every row while `dt.selection` is falsy, so the `-1` — the
    // only half of that pair that discriminated — cannot hold any more. The
    // INTENT migrates onto the directive itself: deleting the binding leaves
    // `index` `undefined` on every row and reddens this. Every row staying at
    // `0` is a better outcome for keyboard users than a roving stop, not a
    // regression.
    // `injector.get`, not `componentInstance`: `SelectableRow` is a DIRECTIVE,
    // so `componentInstance` on its host resolves to the enclosing component
    // and every `index` reads `undefined` — green for the wrong reason if the
    // expectation were weaker than an exact array.
    expect(
      fixture.debugElement
        .queryAll(By.directive(SelectableRow))
        .map((de) => de.injector.get(SelectableRow).index),
    ).toEqual([0, 1]);
    expect(rowFor('contoso-product').getAttribute('tabindex')).toBe('0');
    expect(rowFor('acme-team').getAttribute('tabindex')).toBe('0');
  });

  it('(36-12 AC8) the row is a PrimeNG selectable row, not a hand-rolled click', async () => {
    // The marker `pSelectableRow` puts on its host. Asserted rather than
    // assumed: hover affordance, the selected-row class, `tabindex` and
    // keyboard navigation all come from that directive, and a hand-rolled
    // `(click)` on the `<tr>` would silently take all four away.
    await render();

    expect(rowFor('acme-team').getAttribute('data-p-selectable-row')).toBe(
      'true',
    );
  });

  it('(36-12 AC10) the actions cell still holds exactly three controls', async () => {
    // Still three, but not the same three: Story 36-14 removed Configure/View
    // and added Clone. The count is what this pins — a fourth control appearing
    // in this cell is a change to the row's shape, whatever it is.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    const actions = rowFor('acme-team').querySelector(
      '.admin-catalog__actions',
    )!;
    expect(actions.querySelectorAll('button').length).toBe(3);
  });

  /**
   * Does a REAL click on `control` reach the `<tr>` it sits in?
   *
   * This is what the four specs below observe, and it is the ONLY thing that
   * distinguishes our three `stopPropagation` calls from PrimeNG's own
   * two-level heuristic. `handleRowClick` returns early when the click target
   * or its immediate parent is a BUTTON, so AC3-AC6 stay green with all three
   * removed — measured, not assumed. They pin the guarantee; these pin the
   * implementation of it, which is the half that would otherwise ship
   * unexercised.
   *
   * The listener is removed before asserting so a failing expectation cannot
   * leave it attached to a later spec's DOM.
   */
  function clickReachesRow(namespace: string, control: HTMLElement): boolean {
    const row = rowFor(namespace);
    let reached = false;
    const listener = (): void => {
      reached = true;
    };
    row.addEventListener('click', listener);
    control.click();
    row.removeEventListener('click', listener);
    return reached;
  }

  it('(36-12) a click on a plain CELL does reach the row — the control for the three below', async () => {
    // Without this, all three `toBeFalse()` specs below would pass just as
    // happily with the listener never wired at all.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    expect(
      clickReachesRow('acme-team', byTest('ns-owner-acme-team')!),
    ).toBeTrue();
  });

  it('(36-12) clone stops the click from reaching the row', async () => {
    // Re-homed from Configure (Story 36-14), which removed that control and put
    // Clone in the cell in its place. Clone must join export and delete here:
    // a click that also reached the row would open the panel a second time,
    // through a second path, while the first is still settling.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    expect(
      clickReachesRow('acme-team', byTest('ns-clone-acme-team')!),
    ).toBeFalse();

    await settle();
    await settle();
  });

  it('(36-12) export stops the click from reaching the row', async () => {
    stubObjectUrl();
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('kind: team\n'));
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    expect(
      clickReachesRow('acme-team', byTest('ns-export-acme-team')!),
    ).toBeFalse();

    await settle();
  });

  it('(36-12) delete stops the click from reaching the row', async () => {
    // The dangerous one: a click that reached the row would open the config
    // panel BEHIND the confirmation, and one Escape would resolve the wrong
    // dialog.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    expect(clickReachesRow('acme-team', deleteBtn('acme-team'))).toBeFalse();
  });

  it('(36-12 AC2) a NON-OWNER row click reaches the same handler, same panel', async () => {
    // One destination, one rule — on the row the entitlement signal marks
    // `read-only`, not just on an owned one. ADR-028 §D4's amendment records
    // that the warning is a warning only: the panel is writable and the
    // server's 403 is the boundary. What this pins is that the row click never
    // grows an entitlement branch of its own, which matters more now that the
    // row click is the ONLY way in (Story 36-14).
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    isAdmin$.next(false);
    await render();

    expect(readOnlyTag('contoso-product')).not.toBeNull();
    expect(deleteBtn('contoso-product').disabled).toBeTrue();

    const primary = spyOn(component, 'onPrimaryActionClick').and.callThrough();

    await clickRow('contoso-product');

    expect(primary).toHaveBeenCalledTimes(1);
    expect(component.panelNamespace).toBe('contoso-product');
    expect(panelStub()!.namespace).toBe('contoso-product');
  });

  // === Story 36-14: no lingering selection, no Configure, and row Clone ======
  //
  // EVERY spec below drives a REAL DOM interaction. This epic has now shipped
  // six defects of one shape — a spec asserting something computed in
  // TypeScript while the TEMPLATE BINDING that produces it in a browser goes
  // unexercised — and one of them (the blank-query guard) could be deleted
  // outright with the whole suite green. So: `byTest('ns-clone-…')!.click()`,
  // never `component.onCloneRowClick(…)`.

  /** The row's Clone control, clicked for real. */
  function cloneBtn(namespace: string): HTMLButtonElement {
    return byTest(`ns-clone-${namespace}`) as HTMLButtonElement;
  }

  /**
   * Click the row's Clone and let the pane's readiness gate have its two
   * change-detection passes — the first renders the `@defer` block or re-binds
   * `[namespace]`, the second lets the gate look at the result.
   *
   * It deliberately does NOT release the panel's load: the whole point of the
   * gate is that a clone must wait for it, so every spec below releases it
   * explicitly through `finishLoad()`.
   */
  async function clickClone(namespace: string): Promise<void> {
    cloneBtn(namespace).click();
    await settle();
    await settle();
  }

  /** Release the panel's modelled load and let the gate re-evaluate. */
  async function releaseLoad(): Promise<void> {
    panelStub()!.finishLoad();
    await settle();
  }

  // --- (a) no persistent selection ------------------------------------------

  it('(36-14 AC1) a row click leaves NO selection behind — state and DOM', async () => {
    // Both halves, because either alone can be true while the operator still
    // sees a highlighted row: `selection` is the table's internal state and
    // `p-datatable-row-selected` is `SelectableRow`'s own host binding, which
    // is what actually paints. Home never needed this — selecting a row there
    // NAVIGATES AWAY — but here the list stays mounted behind the dialog, so a
    // retained selection is a highlight the operator comes back to.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    await clickRow('acme-team');

    expect(component.panelVisible).toBeTrue();
    expect(tableInstance().selection).toBeFalsy();
    expect(
      fixture.nativeElement.querySelectorAll('tr.p-datatable-row-selected')
        .length,
    ).toBe(0);
  });

  it('(36-14 AC1) the highlight is still gone after the panel closes', async () => {
    // The state the 36-12 review actually reported: the row stayed lit once the
    // operator dismissed the dialog and was looking at the list again.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    await clickRow('acme-team');
    panelStub()!.closed.emit();
    await settle();

    expect(component.panelVisible).toBeFalse();
    expect(tableInstance().selection).toBeFalsy();
    expect(rowFor('acme-team').classList).not.toContain(
      'p-datatable-row-selected',
    );
  });

  it('(36-14 AC2) pSelectableRow SURVIVES — hover host, tabindex and Enter', async () => {
    // Only the RETAINED selection goes. The directive is what gives the row its
    // hover affordance, its `tabindex` and its keyboard activation, and a
    // "cleanup" that removed it along with the highlight would take all three.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    for (const namespace of ['acme-team', 'contoso-product']) {
      expect(rowFor(namespace).getAttribute('data-p-selectable-row'))
        .withContext(namespace)
        .toBe('true');
      expect(rowFor(namespace).hasAttribute('tabindex'))
        .withContext(namespace)
        .toBeTrue();
    }

    rowFor('contoso-product').dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Enter', bubbles: true }),
    );
    await settle();
    await settle();

    expect(component.panelVisible).toBeTrue();
    expect(panelStub()!.namespace).toBe('contoso-product');
    // ...and Enter leaves no highlight either — the clear is on the handler,
    // not on the mouse path.
    expect(tableInstance().selection).toBeFalsy();
  });

  it('(36-14 AC4) clicking the same row twice still reopens the panel', async () => {
    // 36-12 AC7's trap, re-asserted under the new rule. With nothing ever
    // selected, PrimeNG's single-selection TOGGLE now always emits
    // `onRowSelect` rather than alternating with `onRowUnselect` — a change in
    // which event fires, and no change at all in what the operator gets.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    await clickRow('acme-team');
    expect(component.panelVisible).toBeTrue();
    panelStub()!.closed.emit();
    await settle();

    await clickRow('acme-team');

    expect(component.panelVisible).toBeTrue();
    expect(panelStub()!.namespace).toBe('acme-team');
    expect(tableInstance().selection).toBeFalsy();
  });

  // --- (b) the Configure/View control is gone -------------------------------

  it('(36-14 AC5) no Configure/View control exists on any row', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    isAdmin$.next(false);
    await render();

    expect(
      fixture.nativeElement.querySelectorAll('[data-test^="ns-configure-"]')
        .length,
    ).toBe(0);
  });

  it('(36-14 AC5) the label and icon helpers are GONE from the component', async () => {
    // Dead code on an entitlement path is worse than dead code anywhere else:
    // a later reader finds a `canModify`-driven label helper and reasonably
    // concludes something renders it.
    const api = component as unknown as Record<string, unknown>;

    expect(api['primaryActionLabel']).toBeUndefined();
    expect(api['primaryActionIcon']).toBeUndefined();
  });

  it('(36-14 AC6) the row click is the SOLE entry, and re-binds to the row clicked', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    const primary = spyOn(component, 'onPrimaryActionClick').and.callThrough();

    await clickRow('acme-team');
    expect(panelStub()!.namespace).toBe('acme-team');

    await clickRow('contoso-product');

    expect(primary).toHaveBeenCalledTimes(2);
    expect(panelStub()!.namespace).toBe('contoso-product');
    expect(component.panelNamespace).toBe('contoso-product');
  });

  it('(36-14 AC7) the read-only tag tracks canModify, row by row, on ONE render', async () => {
    // The tag and the delete button must never disagree: both read the same
    // predicate. Asserted on the same DOM, on two rows with opposite verdicts,
    // which is what a second expression would eventually get wrong.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    isAdmin$.next(false);
    await render();

    expect(component.canModify(component.rows[0])).toBeTrue();
    expect(readOnlyTag('acme-team')).toBeNull();
    expect(deleteBtn('acme-team').disabled).toBeFalse();

    expect(component.canModify(component.rows[1])).toBeFalse();
    expect(readOnlyTag('contoso-product')).not.toBeNull();
    expect(deleteBtn('contoso-product').disabled).toBeTrue();
  });

  it('(36-14 AC7) an ADMIN sees the tag on NO row', async () => {
    currentUser$.next({ user_id: 'u-admin', roles: ['admin'] });
    isAdmin$.next(true);
    await render();

    expect(
      fixture.nativeElement.querySelectorAll('[data-test^="ns-readonly-"]')
        .length,
    ).toBe(0);
  });

  it('(36-14 AC8) a LATE ownership resolution removes the tag WITHOUT a remount', async () => {
    // The other half of AC7b's lever: `isAdmin` never moves, only the caller's
    // identity. This is the spec that fails if the tag is computed once.
    await render();
    expect(readOnlyTag('acme-team')).not.toBeNull();

    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await settle();

    expect(readOnlyTag('acme-team')).toBeNull();
    expect(isAdmin$.value).toBeFalse();
  });

  it('(36-14 AC7) the tag does NOT join the visibility chips', async () => {
    // The hook move this story turns on: `ns-visibility-{ns}` addresses a
    // wrapper holding exactly the three visibility chips, so the read-only tag
    // is a sibling of that wrapper and not a fourth chip inside it. Get this
    // wrong and seven frozen chip assertions go red — this states the rule
    // directly rather than leaving it to be inferred from their survival.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    isAdmin$.next(false);
    await render();

    expect(chipValues('contoso-product')).toEqual([
      'public',
      'shareable',
      'team',
    ]);

    const chipsWrapper = rowFor('contoso-product').querySelector(
      '.admin-catalog__chips',
    )!;
    const tag = readOnlyTag('contoso-product')!;
    expect(chipsWrapper.contains(tag)).toBeTrue();
    expect(byTest('ns-visibility-contoso-product')!.contains(tag)).toBeFalse();
  });

  // --- (c) Clone ------------------------------------------------------------

  it('(36-14 AC10) Clone sits between export and delete, styled like them', async () => {
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    const clone = cloneBtn('acme-team');
    const del = deleteBtn('acme-team');

    expect(clone.tagName).toBe('BUTTON');
    expect(clone.getAttribute('aria-label')).toBe('Clone namespace acme-team');
    expect(clone.querySelector('.pi-copy')).not.toBeNull();
    for (const cls of ['p-button-rounded', 'p-button-secondary']) {
      expect(clone.classList.contains(cls)).withContext(cls).toBeTrue();
      // ...and the same treatment as the control beside it, so the cell cannot
      // drift into two button styles.
      expect(del.classList.contains(cls)).withContext(cls).toBeTrue();
    }
  });

  it('(36-14 AC11) Clone on row B after opening row A operates on B', async () => {
    // ***THE SPEC.*** The config dialog's `@defer` resolves ONCE, so the panel
    // instance survives every close and opening a different row only re-binds
    // `[namespace]`; the panel reloads asynchronously in its own `ngOnChanges`.
    // A Clone fired synchronously here reads the panel's BUFFER — still row A's
    // — and the operator confirms A's bundle under a name they chose for B. A
    // write, successful, silent, and wrong.
    //
    // `cloneOpenedFor` records the namespace the panel HELD at the moment it
    // was asked, which is what makes this discriminate: asserting only "the
    // modal opened" passes for the broken implementation too.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    await clickRow('acme-team');
    await releaseLoad();
    expect(panelStub()!.namespace).toBe('acme-team');
    panelStub()!.closed.emit();
    await settle();

    await clickClone('contoso-product');
    await releaseLoad();

    expect(panelStub()!.cloneOpenedFor).toEqual(['contoso-product']);
    expect(panelStub()!.cloneDialogVisible).toBeTrue();
  });

  it('(36-14 AC12) the gate waits for the LOAD, not just the re-bind', async () => {
    // The second wrong-data window, and the subtler one. `loadNamespace` clears
    // the buffer before it fetches, so mid-load `canClone` is TRUE (an empty
    // buffer is a clean one) and the modal would open on nothing at all.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    await clickRow('acme-team');
    await releaseLoad();
    panelStub()!.closed.emit();
    await settle();

    await clickClone('contoso-product');

    // Re-bound, but still loading: nothing has fired.
    expect(panelStub()!.namespace).toBe('contoso-product');
    expect(panelStub()!.loading).toBeTrue();
    expect(panelStub()!.cloneOpenedFor).toEqual([]);

    await releaseLoad();

    expect(panelStub()!.cloneOpenedFor).toEqual(['contoso-product']);
  });

  it('(36-14 AC13) a FIRST-EVER open still reaches the Clone modal', async () => {
    // No `@ViewChild` at all at click time: a synchronous `panel.onCloneClick()`
    // either throws or silently does nothing, depending on how it is written.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();
    expect(panelStub()).toBeUndefined();

    await clickClone('acme-team');

    expect(component.panelVisible).toBeTrue();
    expect(panelStub()).not.toBeUndefined();
    expect(panelStub()!.cloneOpenedFor).toEqual([]);

    await releaseLoad();

    expect(panelStub()!.cloneOpenedFor).toEqual(['acme-team']);
    expect(panelStub()!.cloneDialogVisible).toBeTrue();
  });

  it('(36-14 AC14) canClone false → Clone PRESENT, disabled, reason on hover', async () => {
    // Panel-scoped, so it blocks every row: one panel, one buffer, one clone
    // engine. The `title` says WHY rather than repeating delete's entitlement
    // wording — an operator sent looking for a permission problem would not
    // find one.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    await clickRow('acme-team');
    await releaseLoad();
    panelStub()!.canClone = false;
    await settle();

    for (const namespace of ['acme-team', 'contoso-product']) {
      const btn = cloneBtn(namespace);
      expect(btn).withContext(namespace).not.toBeNull();
      expect(btn.disabled).withContext(namespace).toBeTrue();
      expect(btn.getAttribute('title'))
        .withContext(namespace)
        .toBe(CLONE_DENIED_REASON);
    }
    expect(CLONE_DENIED_REASON).not.toBe(DELETE_DENIED_REASON);
  });

  it('(36-14 AC14) canClone true, and no panel at all, leave Clone live and TITLE-less', async () => {
    // `title` means one thing in this row — the denial reason — exactly as it
    // does on delete. A control disabled before its blocker even exists would
    // read as "you may never clone this".
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    expect(component.panel).toBeUndefined();
    expect(cloneBtn('acme-team').disabled).toBeFalse();
    expect(cloneBtn('acme-team').getAttribute('title')).toBeNull();

    await clickRow('acme-team');
    await releaseLoad();
    expect(panelStub()!.canClone).toBeTrue();

    expect(cloneBtn('acme-team').disabled).toBeFalse();
    expect(cloneBtn('acme-team').getAttribute('title')).toBeNull();
  });

  it('(36-14 AC15) Clone is NOT entitlement-gated, on the very row Delete is', async () => {
    // Two different rules on one row, asserted together on purpose: Clone
    // creates a NEW namespace, which the server permits any caller, so gating
    // it on `canModify` would take a capability the server grants. This is the
    // cheapest guard against someone tidying the two into one predicate.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    isAdmin$.next(false);
    await render();

    expect(component.canModify(component.rows[1])).toBeFalse();
    expect(readOnlyTag('contoso-product')).not.toBeNull();
    expect(deleteBtn('contoso-product').disabled).toBeTrue();

    expect(cloneBtn('contoso-product').disabled).toBeFalse();
    expect(cloneBtn('contoso-product').getAttribute('title')).toBeNull();

    await clickClone('contoso-product');
    await releaseLoad();

    expect(panelStub()!.cloneOpenedFor).toEqual(['contoso-product']);
  });

  it('(36-14 AC16) a pending clone is CANCELLED when the panel closes', async () => {
    // A trigger that outlived its dialog would fire against whichever row the
    // operator opens next — the same wrong-namespace write AC11 is about,
    // reached by a different route.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    await clickClone('acme-team');
    expect(panelStub()!.loading).toBeTrue(); // the load never settled

    clickDialogClose();
    await settle();
    expect(component.panelVisible).toBeFalse();

    await clickRow('contoso-product');
    await releaseLoad();

    expect(panelStub()!.namespace).toBe('contoso-product');
    expect(panelStub()!.cloneOpenedFor).toEqual([]);
    expect(panelStub()!.cloneDialogVisible).toBeFalse();
  });

  it('(36-14 AC17) Escape with the row-opened Clone modal up closes ONLY it', async () => {
    // 36-4's precedence, unchanged: the panel owns its own modals, reports that
    // it consumed the keystroke, and the config dialog stays exactly where it
    // is. Reached here through the ROW's Clone rather than the panel's own.
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    await clickClone('acme-team');
    await releaseLoad();
    expect(panelStub()!.cloneDialogVisible).toBeTrue();

    const confirmDiscard = spyOn(panelStub()!, 'confirmDiscard');
    pressEscape();
    await settle();

    expect(component.panelVisible).toBeTrue();
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it('(36-14 AC18) all THREE row controls stop the click, and a plain cell does not', async () => {
    // The positive control is the half that matters: without it the three
    // `toBeFalse()` reads below would pass just as happily with the listener
    // never wired at all.
    stubObjectUrl();
    apiSpy.exportNamespace.and.returnValue(Promise.resolve('kind: team\n'));
    currentUser$.next({ user_id: OWNER, roles: ['user'] });
    await render();

    expect(
      clickReachesRow('acme-team', byTest('ns-owner-acme-team')!),
    ).toBeTrue();

    for (const hook of ['ns-export', 'ns-clone', 'ns-delete']) {
      expect(clickReachesRow('acme-team', byTest(`${hook}-acme-team`)!))
        .withContext(hook)
        .toBeFalse();
    }

    await settle();
    await settle();
  });
});
