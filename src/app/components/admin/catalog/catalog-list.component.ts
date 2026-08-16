import { CommonModule } from '@angular/common';
import {
  AfterViewChecked,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  OnInit,
  ViewChild,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { Table, TableModule, TableRowSelectEvent } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { Observable, combineLatest } from 'rxjs';
import { map } from 'rxjs/operators';

import { AuthService } from '../../../core/auth/auth.service';
import { ApiService } from '../../../core/http/api.service';
import {
  ENTRY_KINDS,
  EntryKind,
  NamespaceSummary,
} from '../../../protocol/catalog.interface';
import { NamespacePanelComponent } from '../../catalog/namespace-panel/namespace-panel.component';
import { AdminSectionCounts } from '../admin-section-counts.service';

/**
 * Why a Delete control the caller may not use is DISABLED and not HIDDEN.
 *
 * Hiding it reads as "this namespace cannot be deleted", which is false — it
 * can, by its owner or by an admin. The reason travels as the native `title`
 * attribute rather than `pTooltip`: PrimeNG's tooltip binds mouse listeners on
 * the host, and a `disabled` button fires no mouse events, so a `pTooltip`
 * here would be written and never read.
 */
export const DELETE_DENIED_REASON =
  'Only the owner or an admin can delete this namespace';

/**
 * Why a blocked Clone says something DIFFERENT from a blocked Delete.
 *
 * Delete's denial is about entitlement — who you are. Clone's is not: Clone
 * creates a NEW namespace, which the server permits any caller, so it is never
 * entitlement-gated. What blocks it is the shared panel behind this list: one
 * panel, one buffer, one clone engine, and it cannot clone while it holds
 * unsaved edits. Repeating Delete's wording here would send the operator
 * looking for a permission problem that is not there.
 *
 * Travels as the native `title` for the same reason Delete's does: a disabled
 * button fires no mouse events, so `pTooltip` would be written and never read.
 */
export const CLONE_DENIED_REASON =
  'The configuration panel has unsaved changes — save or discard them before cloning';

/**
 * What the pane says it is showing, which depends on who is asking.
 *
 * An admin's list is the deployment; everyone else's is their own namespaces
 * plus whatever is shared publicly. Stating that inline is what stops an
 * ordinary user reading a short list as "the deployment is nearly empty".
 * Exported so the spec imports the strings instead of duplicating them.
 */
export const CATALOG_DESCRIPTION_ADMIN =
  'Every namespace on this deployment. Select one to edit its configuration.';

export const CATALOG_DESCRIPTION_MEMBER =
  'Namespaces you own, plus those shared publicly. Select one to edit its configuration.';

/** The filter box's placeholder — the only text that says what it filters. */
export const CATALOG_FILTER_PLACEHOLDER = 'Filter namespaces…';

/**
 * What the pane says when the FILTER is hiding everything — never when the
 * catalog is empty.
 *
 * The two are different facts and must not read alike: `No namespaces` for a
 * deployment that holds rows tells the operator their data is gone. This
 * message is deliberately incomplete on its own — the query is rendered beside
 * it, so the sentence names what is being excluded rather than leaving the
 * operator to remember what they typed.
 */
export const CATALOG_NO_MATCH_MESSAGE = 'No namespaces match';

/**
 * The kinds the Entries column RENDERS — every kind except `meta`.
 *
 * `meta` is the namespace's own `_meta` implementation entry: always 0 or 1,
 * never something an operator acts on, and pure noise in a list whose job is to
 * say how much a namespace holds. It stays on the wire and in the model (all
 * six keys) — only the column narrows.
 *
 * DERIVED from {@link ENTRY_KINDS} rather than hand-written, so a seventh kind
 * added server-side appears here without an edit. Hand-writing the five is the
 * one way this list can silently fall behind the protocol.
 */
export const SHOWN_ENTRY_KINDS: readonly EntryKind[] = ENTRY_KINDS.filter(
  (kind) => kind !== 'meta',
);

/**
 * Who is looking at the table, as one value read from the live auth streams.
 *
 * Both halves feed the per-row `canModify` predicate, and both MUST stay
 * reactive: `/auth/me` resolves AFTER first render, so a snapshot taken in the
 * constructor leaves a genuine admin looking at rows whose Delete is disabled
 * until the next navigation — on the one surface where that reads as "you may
 * not delete this".
 */
interface CatalogViewer {
  isAdmin: boolean;
  userId: string | null;
}

/**
 * The admin area's catalog pane: one row per namespace the caller can see,
 * with the actions that caller is actually entitled to (ADR-028 §D4).
 *
 * The authorization rule mirrors the server's own gate
 * (`require_namespace_owner_or_admin`): allow iff the caller owns the namespace
 * OR the caller is an admin. It is a DISJUNCTION — an ordinary user who owns a
 * namespace may delete it, and gating Delete on `isAdmin` alone would take from
 * owners a capability the server grants them.
 *
 * The rule is INVISIBLE in a local click-through: on the community tier every
 * caller is `anonymous` and every entry's `user_id` is `anonymous`, so owner
 * and caller coincide for everyone and `() => true` would look identical. The
 * specs, which construct a non-owner caller explicitly, are the only evidence.
 *
 * The client-side check mirrors the server; it does not replace it. Roles can
 * change between page load and click, so a 403 on delete is expected, handled,
 * and leaves the row exactly where it was.
 *
 * ONE request paints the whole page. `GET /admin/catalog/namespaces` returns
 * `owner` and the six-kind `counts` on every row, so the pane composes nothing:
 * no per-kind fan-out, no client-side grouping, no zero-fill and no owner
 * resolution of its own. Story 36-8 deleted all four along with the service
 * that did them, and deliberately left NO fallback — a deployment whose backend
 * predates the widened DTO is a deployment problem with a deployment fix, not a
 * version-detecting branch rotting on a data path.
 *
 * Story 36-4 made this pane a DIALOG HOST as well as a table: clicking a row
 * opens `NamespacePanelComponent` in a `p-dialog` over the list instead of
 * navigating away, so the list stays mounted behind it (which is what lets
 * `existingNamespaces` come from data already on screen and lets a save refresh
 * the table). The deep-link URL survives as a bookmark — it is simply no longer
 * reachable by clicking.
 *
 * Story 36-14 made the row click the SOLE entry to that panel: the
 * Configure/View control is gone, and with it the one place a non-owner learned
 * they were read-only before clicking. The `read-only` tag beside the
 * visibility chips is that warning, off the same `canModify` predicate. It says
 * "you may not save", not "you may not open" — the panel is writable by design
 * (ADR-028 §D4's amendment) and this story did not change that.
 *
 * That makes THREE dialog layers this pane must arbitrate between on a single
 * Escape: the delete confirmation, the config host, and the panel's own Clone /
 * confirm modals. `onEscape` below is the one handler that decides; every
 * dialog sets `[closeOnEscape]="false"` so PrimeNG never decides for it.
 */
@Component({
  selector: 'app-admin-catalog-list',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    DialogModule,
    InputTextModule,
    TableModule,
    TagModule,
    ToggleSwitchModule,
    NamespacePanelComponent,
  ],
  templateUrl: './catalog-list.component.html',
  styleUrls: ['./catalog-list.component.scss'],
})
export class CatalogListComponent implements OnInit, AfterViewChecked {
  readonly #api = inject(ApiService);
  readonly #auth = inject(AuthService);
  readonly #destroyRef = inject(DestroyRef);
  readonly #sectionCounts = inject(AdminSectionCounts);

  /**
   * Iterated by the counts cell — DERIVED from the protocol tuple, never a
   * hand-written list. `meta` is excluded; see {@link SHOWN_ENTRY_KINDS}.
   */
  readonly shownEntryKinds = SHOWN_ENTRY_KINDS;

  readonly deleteDeniedReason = DELETE_DENIED_REASON;
  readonly cloneDeniedReason = CLONE_DENIED_REASON;
  readonly filterPlaceholder = CATALOG_FILTER_PLACEHOLDER;
  readonly noMatchMessage = CATALOG_NO_MATCH_MESSAGE;

  /**
   * Gates the admin-only "show all namespaces" toggle, consumed through the
   * `async` pipe so a late `/auth/me` resolution makes it appear (AC 6).
   */
  readonly isAdmin$: Observable<boolean> = this.#auth.isAdmin$;

  /**
   * What the pane says it is showing. Off the same stream as everything else
   * role-driven here, so a late `/auth/me` rewrites it in place rather than
   * leaving an admin told they are looking at their own namespaces.
   */
  readonly description$: Observable<string> = this.#auth.isAdmin$.pipe(
    map((isAdmin) =>
      isAdmin ? CATALOG_DESCRIPTION_ADMIN : CATALOG_DESCRIPTION_MEMBER,
    ),
  );

  /** Every row the ONE request returned — the rail's count reads this. */
  rows: NamespaceSummary[] = [];
  /**
   * The subset the table renders. A FIELD, recomputed by `#applyFilter()`, and
   * deliberately not a getter: `p-table` treats a new array reference as new
   * input and re-processes its whole value, so a getter allocating per change
   * detection would re-run that on every pass.
   */
  filteredRows: NamespaceSummary[] = [];
  /** The filter box's raw text; matching is on its trimmed, lowered form. */
  filterText = '';
  loading = false;
  /** A rejected load is NOT an empty catalog — the two never render alike. */
  loadFailed = false;
  showAll = false;
  /** True while an export is in flight — the single-flight gate reads it. */
  exporting = false;

  confirmDialogVisible = false;
  pendingDelete: NamespaceSummary | null = null;
  deleting = false;

  /** Whether the namespace-configuration dialog is open (Story 36-4). */
  panelVisible = false;
  /** The identifier bound to the panel's `[namespace]` input. */
  panelNamespace = '';
  /** The dialog header's display name; falls back to the identifier. */
  panelLabel = '';

  @ViewChild('confirmProceedBtn')
  private confirmProceedBtn?: ElementRef<HTMLButtonElement>;

  /**
   * The one `p-table` this pane renders — held ONLY so the row selection can be
   * cleared the moment it is made (Story 36-14).
   *
   * Optional and must stay so: the table lives inside the "rows loaded and not
   * all filtered away" branch, so it is absent while loading, on a failed load,
   * on an empty catalog and in the no-match state.
   */
  @ViewChild(Table)
  table?: Table;

  /**
   * The hosted panel, resolved once the `@defer` block has actually rendered —
   * i.e. NOT before the first change-detection pass after `panelVisible` flips
   * true. Every read must stay optional: the close flow runs on a pane whose
   * dialog was never opened, and "not mounted" means "nothing to discard".
   *
   * `@defer` resolves ONCE. After that the panel instance SURVIVES a close, so
   * switching rows only re-binds `[namespace]` and the panel's own `ngOnChanges`
   * reloads it — nothing here remounts or resets it by hand. It also means an
   * abandoned dirty buffer is cleared by `confirmDiscard()`'s Proceed branch and
   * by nothing else, which is why the close flow must route through it rather
   * than just flipping `panelVisible`.
   */
  @ViewChild(NamespacePanelComponent)
  panel?: NamespacePanelComponent;

  /**
   * Seeded closed: until the streams say otherwise the viewer is a non-admin
   * owning nothing, so the first paint denies rather than grants.
   */
  #viewer: CatalogViewer = { isAdmin: false, userId: null };

  /**
   * The namespace a row-Clone was requested for, held until the shared panel is
   * actually showing it (Story 36-14). `null` means no clone is pending.
   *
   * It exists because the panel behind this list is REUSED: `@defer` resolves
   * once, so opening a different row only re-binds `[namespace]` and the panel
   * reloads asynchronously in its own `ngOnChanges`. A Clone fired synchronously
   * after opening would run against whatever namespace the panel last held — and
   * `onCloneClick()` reads the panel's BUFFER, so the operator would name a
   * destination for row B and get row A's bundle written under it. Mid-load is
   * no better: the panel clears its buffer first, so the same click would clone
   * nothing at all. See `ngAfterViewChecked` for the gate that closes both.
   */
  #pendingClone: string | null = null;

  constructor() {
    combineLatest([this.#auth.isAdmin$, this.#auth.currentUser$])
      .pipe(takeUntilDestroyed(this.#destroyRef))
      .subscribe(([isAdmin, user]) => {
        this.#viewer = { isAdmin, userId: user?.user_id ?? null };
      });
  }

  ngOnInit(): void {
    void this.loadRows();
  }

  /**
   * The ONE path that loads rows — `ngOnInit`, the toggle and Refresh all come
   * through here, so `all` can never diverge between them — and now exactly ONE
   * request, whose rows are rendered verbatim. Nothing is derived here: `owner`
   * and `counts` arrive on the response and are neither recomputed nor coerced.
   */
  async loadRows(): Promise<void> {
    this.loading = true;
    this.loadFailed = false;
    try {
      this.rows = await this.#api.getNamespaces({ all: this.showAll });
      // The rail states what the deployment holds, so it reads the LOADED
      // count, never the filtered one.
      this.#sectionCounts.setCatalog(this.rows.length);
    } catch {
      // FetchService already toasted (ADR-026); adding another would
      // double-report. Render the failure state — never an empty table, which
      // would assert "this deployment has no namespaces" for a request that
      // never got an answer.
      this.rows = [];
      // ...and for the same reason the rail goes back to UNKNOWN rather than
      // to `0`: a badge reading `0` would make the same false claim in the
      // margin that the empty table would make in the middle of the page.
      this.#sectionCounts.setCatalog(null);
      this.loadFailed = true;
    } finally {
      this.#applyFilter();
      this.loading = false;
    }
  }

  onToggleShowAll(value: boolean): void {
    this.showAll = value;
    void this.loadRows();
  }

  /**
   * The filter box. Client-side over rows ALREADY IN MEMORY — typing issues no
   * request, which is the whole point of Story 36-8's single load.
   */
  onFilterChange(value: string): void {
    this.filterText = value;
    this.#applyFilter();
  }

  /**
   * Empty the box and put every loaded row back — the no-match state's way out.
   *
   * Re-applies through the SAME private method every other path uses rather
   * than assigning `filteredRows` itself: a second copy of the reset is a
   * second place for the rule to drift. Setting `filterText` is what puts the
   * box back to empty too — it is `[ngModel]`-bound, so the field is the
   * control's value, and resetting only the internal state would leave the
   * operator reading a query that no longer applies.
   */
  onClearFilter(): void {
    this.filterText = '';
    this.#applyFilter();
  }

  /**
   * Recompute `filteredRows` from `rows` and the current query.
   *
   * The query is split on whitespace into TERMS, and a row matches iff EVERY
   * term matches AT LEAST ONE field — AND across terms, OR across the four
   * fields the row already carries. So `marie ingestion` finds the namespace
   * marie owns whose description mentions ingestion, and neither term alone
   * suffices. A single term degrades to the old behaviour over a wider field
   * set, which is why nothing an operator already learned stops working.
   *
   * Every path that rebuilds `rows` must come through here — a load, a filter
   * keystroke, the clear control, and the delete-success path, which otherwise
   * leaves a deleted row standing in the filtered view.
   */
  #applyFilter(): void {
    const terms = this.filterText
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term !== '');
    // NOT `terms[0] === ''`: an empty term matches every string, so a blank
    // query has to produce NO terms rather than one empty one.
    this.filteredRows =
      terms.length === 0
        ? this.rows
        : this.rows.filter((row) => this.#matchesAllTerms(row, terms));
  }

  /**
   * The four fields a query is matched against, in one readable place.
   *
   * `description` is matched but rendered in no column — the namespace cell's
   * `title` is what makes such a match explicable rather than mysterious.
   * `owner` is nullable and coerced to `''`, which both keeps the row out of a
   * non-empty term's results and stops an unowned namespace throwing.
   *
   * Substring matching, never a `RegExp` built from the query: an operator
   * typing `(` would otherwise throw, and escaping is a bug factory this
   * feature does not need.
   */
  #matchesAllTerms(row: NamespaceSummary, terms: string[]): boolean {
    const fields = [
      row.namespace,
      row.name,
      row.description,
      row.owner ?? '',
    ].map((field) => field.toLowerCase());
    return terms.every((term) => fields.some((field) => field.includes(term)));
  }

  /**
   * True iff the filter is hiding every loaded row.
   *
   * A DIFFERENT fact from an empty catalog, and rendered differently: the
   * no-match state is about the box the operator just typed in — and names
   * what they typed — while `catalog-empty` claims the deployment holds
   * nothing at all.
   */
  get filterHidesEverything(): boolean {
    return this.rows.length > 0 && this.filteredRows.length === 0;
  }

  /** The query as it was MATCHED, which is what the no-match state names. */
  get trimmedFilter(): string {
    return this.filterText.trim();
  }

  /**
   * THE rule, written once and read by every control in the row.
   *
   * `isAdmin || row.owner === caller` — a disjunction, mirroring
   * `_catalog_authz.require_namespace_owner_or_admin`. An unknown owner
   * (`null`) fails closed on the ownership half: denied for a non-admin,
   * still allowed for an admin.
   */
  canModify(row: NamespaceSummary): boolean {
    return this.#viewer.isAdmin || this.isOwnedByViewer(row);
  }

  /**
   * The ownership half of the rule, ALONE — the `you` chip's predicate.
   *
   * Extracted from `canModify` rather than written a second time: an admin who
   * is not the owner must get no `you` chip, so the chip needs this half
   * without the disjunction, and two copies of an equality drift.
   *
   * The `owner !== null` guard is load-bearing. Drop it and `null === null`
   * hands every unowned namespace to every caller who also has no `user_id`.
   */
  isOwnedByViewer(row: NamespaceSummary): boolean {
    return row.owner !== null && row.owner === this.#viewer.userId;
  }

  /** `null` when allowed, so the attribute is absent rather than empty. */
  deleteDisabledReason(row: NamespaceSummary): string | null {
    return this.canModify(row) ? null : DELETE_DENIED_REASON;
  }

  /**
   * A count, read off the NESTED tally — `counts[kind].total`, never
   * `counts[kind]`.
   *
   * No unavailable branch: with one request there is no per-column failure to
   * degrade to, so `—` has nothing left to mean. A whole-load failure is a
   * different fact and still has `loadFailed`.
   *
   * Zero is rendered as the character `0`: a namespace with no tools is a fact
   * worth stating, and blanking it would now be indistinguishable from nothing
   * at all.
   */
  countLabel(row: NamespaceSummary, kind: EntryKind): string {
    return String(row.counts[kind].total);
  }

  /** True for a kind this namespace holds none of — rendered dimmed, never hidden. */
  isZeroCount(row: NamespaceSummary, kind: EntryKind): boolean {
    return row.counts[kind].total === 0;
  }

  /**
   * The `Σ` total: the sum of the kinds the column SHOWS.
   *
   * It excludes `meta` for the same reason the column does — a total that
   * counted a kind the row does not display would not add up on inspection,
   * and an operator checking the arithmetic would conclude the numbers are
   * wrong rather than that one is hidden.
   */
  shownTotal(row: NamespaceSummary): number {
    return SHOWN_ENTRY_KINDS.reduce(
      (total, kind) => total + row.counts[kind].total,
      0,
    );
  }

  /**
   * Export this namespace as YAML and hand it to the browser as a download.
   *
   * `all` is threaded exactly as `loadRows()` threads it, so an admin looking
   * at "show all" can export a namespace they do not own — the flag that made
   * the row visible is the flag that makes it readable.
   *
   * The re-entrancy guard is the TypeScript early return, NOT a `[disabled]`
   * attribute: a disabled attribute does not stop a keyboard-driven activation
   * (epic 33's lesson), and two overlapping exports would race two downloads
   * of the same name.
   *
   * A rejection leaves the row untouched and raises NO toast of its own —
   * `FetchService` already surfaced the server's message (ADR-026).
   */
  async onExportClick(row: NamespaceSummary): Promise<void> {
    if (this.exporting) {
      return;
    }
    this.exporting = true;
    try {
      const yaml = await this.#api.exportNamespace(row.namespace, {
        all: this.showAll,
      });
      this.#download(`${row.namespace}.yaml`, yaml);
    } catch {
      // Deliberately empty: the row survives and the toast is not ours.
    } finally {
      this.exporting = false;
    }
  }

  /**
   * Hand `text` to the browser as a file named `filename`.
   *
   * Its own method so the export flow has a seam a spec can observe: the
   * object URL is created and REVOKED around a single synthetic click, and a
   * spec asserts both halves rather than letting a real navigation happen.
   */
  #download(filename: string, text: string): void {
    const url = URL.createObjectURL(
      new Blob([text], { type: 'application/yaml' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    // Revoked immediately: the click has already handed the blob to the
    // download, and an un-revoked object URL leaks its buffer for the life of
    // the document.
    URL.revokeObjectURL(url);
  }

  onDeleteClick(row: NamespaceSummary): void {
    this.pendingDelete = row;
    this.confirmDialogVisible = true;
  }

  /** Focus Proceed so Enter confirms and Escape (below) cancels. */
  onConfirmDialogShow(): void {
    this.confirmProceedBtn?.nativeElement.focus();
  }

  onConfirmVisibleChange(visible: boolean): void {
    this.confirmDialogVisible = visible;
    if (!visible) {
      this.pendingDelete = null;
    }
  }

  onDeleteCancel(): void {
    this.confirmDialogVisible = false;
    this.pendingDelete = null;
  }

  /**
   * Delete the pending namespace, then drop THAT row and nothing else — no
   * page re-fetch, so every other row's counts and chips are untouched.
   *
   * On any rejection the row stays and this stays SILENT: `FetchService` has
   * already raised the server's message as an error toast (ADR-026), so a
   * second one here would report the same failure twice. A 403 despite
   * `canModify` is legitimate — roles can change between page load and click,
   * and the server is the boundary.
   */
  async onDeleteProceed(): Promise<void> {
    const row = this.pendingDelete;
    if (row === null || this.deleting) {
      return;
    }
    this.deleting = true;
    try {
      await this.#api.deleteNamespace(row.namespace);
      this.rows = this.rows.filter((r) => r.namespace !== row.namespace);
      // The filtered view is derived, so it must be rebuilt here too — without
      // this the deleted row survives in the table whenever a filter is on.
      this.#applyFilter();
      this.#sectionCounts.setCatalog(this.rows.length);
    } catch {
      // Deliberately empty: the row survives and the toast is not ours.
    } finally {
      this.deleting = false;
      this.confirmDialogVisible = false;
      this.pendingDelete = null;
    }
  }

  // --- The configuration dialog host (Story 36-4) ---------------------------

  /**
   * THE one way into the panel: open it over the list, on THIS row's namespace.
   * Not a navigation — the list must stay mounted behind the dialog for
   * `existingNamespaces` and the `(saved)` refresh to mean anything.
   *
   * Story 36-14 removed the Configure/View control, so the row click and the
   * row's Clone are now its only two callers, and both come through here.
   */
  onPrimaryActionClick(row: NamespaceSummary): void {
    if (this.#pendingClone !== null && this.#pendingClone !== row.namespace) {
      // A Clone was waiting on a DIFFERENT row and the operator has moved on.
      // Firing it now would clone whatever this open is about instead.
      this.#pendingClone = null;
    }
    this.panelNamespace = row.namespace;
    this.panelLabel = row.name === '' ? row.namespace : row.name;
    this.panelVisible = true;
  }

  /**
   * A click (or Enter) anywhere on the row that is not one of its own controls
   * — Story 36-12, so the whole row is the target and not just a button at the
   * far right of it.
   *
   * It DELEGATES, then CLEARS the selection (Story 36-14). Home gets the second
   * half for free because selecting a row there navigates away; here the list
   * stays mounted behind the dialog, so a retained selection is a highlighted
   * row the operator comes back to and cannot get rid of. The clear is
   * synchronous on purpose: PrimeNG emits `onRowSelect` BEFORE it calls
   * `tableService.onSelectionChange()`, so the notification it is about to fire
   * already carries the cleared value and the rows un-highlight in the same
   * pass.
   *
   * What is deliberately kept is `pSelectableRow` itself — hover affordance,
   * `tabindex` and Enter/Space activation are the directive's, and only the
   * RETAINED state goes.
   *
   * Bound to BOTH `(onRowSelect)` and `(onRowUnselect)` — see the template for
   * why single selection being a toggle makes that necessary rather than
   * defensive.
   *
   * `data` is narrowed rather than cast: the array branch and `undefined` are
   * both unreachable in single-selection mode, and a bare `as` here would
   * survive a mode change as a lie.
   */
  onRowSelect(event: TableRowSelectEvent<NamespaceSummary>): void {
    const row = event.data;
    if (row === undefined || Array.isArray(row)) {
      return;
    }
    this.onPrimaryActionClick(row);
    if (this.table !== undefined) {
      this.table.selection = null;
    }
  }

  /**
   * The row's Clone: a SHORTCUT into the panel's own Clone, never a second
   * implementation of it. The collision list, the destination-name suggestions
   * and the clone gating all belong to `NamespacePanelComponent` and stay there
   * (ADR-028 §D8), so this pane gains no clone client of its own.
   *
   * It opens the panel through the one entry above and records the request. It
   * MUST NOT call `panel.onCloneClick()` here: on a first-ever open there is no
   * panel yet, and on any later one the panel is still showing the previous
   * row. `ngAfterViewChecked` fires it once the panel is genuinely on this row.
   *
   * Not gated on `canModify`: Clone creates a NEW namespace, which the server
   * permits any caller. Gating it would take a capability the server grants —
   * the same mistake as gating Delete on `isAdmin` alone.
   */
  onCloneRowClick(row: NamespaceSummary): void {
    this.onPrimaryActionClick(row);
    this.#pendingClone = row.namespace;
  }

  /**
   * Whether the row Clone is live. PANEL-scoped, and therefore the same on
   * every row: there is one panel, one buffer and one clone engine behind this
   * list, and it cannot clone while it holds unsaved edits or is mid-clone.
   *
   * `true` when no panel exists yet — nothing is blocking, and a control
   * disabled before its blocker exists reads as "you may never clone this".
   */
  get canCloneRow(): boolean {
    return this.panel === undefined || this.panel.canClone;
  }

  /** `null` when allowed, so the attribute is absent rather than empty. */
  get cloneDisabledReason(): string | null {
    return this.canCloneRow ? null : CLONE_DENIED_REASON;
  }

  /**
   * The readiness gate for a pending row-Clone — all THREE conditions, because
   * each closes a window in which the clone runs against the wrong data:
   *
   *   1. the panel instance exists      — else there is nothing to call at all
   *   2. `panel.namespace === pending`  — else it still holds the PREVIOUS row,
   *      and `onCloneClick()` derives its suggestions from that row's buffer
   *   3. `panel.loading === false`      — else the panel has already cleared its
   *      buffer for the incoming load and would clone an empty bundle
   *
   * `ngAfterViewChecked` rather than a timer: the panel's load resolves as a
   * promise, and every resolution is followed by a change-detection pass, so
   * this runs exactly when there is something new to look at. A `setTimeout`
   * loop would spin against specs that drive change detection by hand.
   *
   * The call itself is deferred to a microtask: the child's template has
   * already been checked in this pass, so opening its modal synchronously here
   * would raise `ExpressionChangedAfterItHasBeenCheckedError`.
   */
  ngAfterViewChecked(): void {
    const pending = this.#pendingClone;
    if (pending === null) {
      return;
    }
    const panel = this.panel;
    if (panel === undefined || panel.namespace !== pending || panel.loading) {
      return;
    }
    this.#pendingClone = null;
    queueMicrotask(() => this.#firePendingClone());
  }

  /**
   * Fire the clone, re-checking at the moment it actually happens. The panel
   * can go dirty — or the operator can close the dialog — between the gate
   * opening and this microtask running, and a Clone modal over a dismissed
   * dialog is worse than no Clone at all.
   */
  #firePendingClone(): void {
    const panel = this.panel;
    if (panel === undefined || !this.panelVisible || !panel.canClone) {
      return;
    }
    panel.onCloneClick();
  }

  /**
   * Dirty-close guard for BOTH dismissal channels (the X and the dismissable
   * mask), and the flow Escape delegates to once no secondary modal wants the
   * keystroke.
   *
   * `[(visible)]` is split into `[visible]` + `(visibleChange)` precisely so
   * this can intercept a dismissal: on a dirty panel it RE-ASSERTS visibility
   * to hold the dialog open while the panel's own confirm modal runs, and
   * closes only when that resolves `true`. A clean panel — or one that was
   * never mounted — closes immediately and is never asked.
   */
  onPanelVisibleChange(visible: boolean): void {
    if (visible) {
      // Opening: the primary-action handler already set the flag. No-op.
      return;
    }
    // A Clone still waiting on a load is abandoned here, not held: the operator
    // dismissed the dialog, and a trigger that outlived the close would fire
    // against whichever row they open next.
    this.#pendingClone = null;
    const panel = this.panel;
    if (!panel || !panel.hasUnsavedChanges()) {
      this.panelVisible = false;
      return;
    }
    this.panelVisible = true;
    void panel.confirmDiscard().then((discard) => {
      if (discard) {
        this.panelVisible = false;
      }
    });
  }

  /**
   * The panel's own `(closed)`. It closes unconditionally — the panel raises it
   * only once it is satisfied there is nothing to lose — but it must drop a
   * pending Clone for the same reason the dismissal channels do.
   */
  onPanelClosed(): void {
    this.#pendingClone = null;
    this.panelVisible = false;
  }

  /**
   * The panel's `(saved)`. Re-runs the pane's ONE load path, which refreshes
   * the table and `existingNamespaces` together — they are the same data, so
   * one call keeps them from disagreeing.
   */
  onPanelSaved(): void {
    void this.loadRows();
  }

  /**
   * The Clone modal's collision list, DERIVED from the rows already on screen.
   *
   * A getter, not a copied array: a field would be a second source of truth for
   * data the table is already rendering, and would go stale the moment a row is
   * deleted. Opening the dialog therefore issues no request of its own.
   */
  get existingNamespaces(): string[] {
    return this.rows.map((r) => r.namespace);
  }

  /**
   * True iff a DESTRUCTIVE request is in flight. Reads (`validating`,
   * `loading`) are deliberately excluded: an operator may dismiss the dialog
   * while a Validate is mid-flight, and widening this to cover reads would
   * silently take that away.
   *
   * Drives `[closable]` / `[dismissableMask]` and the first branch of
   * `onEscape` — all three dismissal channels lock together or not at all.
   */
  get isWriteInFlight(): boolean {
    return this.panel?.saving === true || this.panel?.cloning === true;
  }

  /**
   * THE Escape handler for this pane — one keystroke, exactly one action.
   *
   * It must be DOCUMENT-level. PrimeNG teleports each dialog to `<body>` as a
   * sibling overlay, so a keydown inside one does not bubble through this
   * pane's element tree, and a dialog-scoped handler would simply not see it.
   * For the same reason PrimeNG's own `closeOnEscape` is off on every dialog
   * here: it registers ONE document listener PER DIALOG, so an inner modal
   * calling `stopPropagation()` cannot stop an outer dialog's listener — they
   * are siblings on `document`, not parent and child. Coordination has to be
   * ours, in one place.
   *
   * Priority order, first match wins:
   *   1. a write is in flight while the config dialog is open → NOTHING. All
   *      dismissal channels are locked together (`isWriteInFlight`).
   *   2. the delete confirmation is open → cancel only it, issue no request.
   *   3. the config dialog is open and the panel consumed the keystroke (its
   *      confirm modal, else its Clone modal) → stop; the config dialog stays.
   *   4. the config dialog is open and no secondary modal is → the same close
   *      flow as the X, so a dirty buffer still routes through `confirmDiscard`.
   *   5. nothing open → nothing happens.
   *
   * Branch 2 is not observable today: the config host is modal, so the row's
   * Delete cannot be clicked while it is open and the two never coexist. It is
   * ordered anyway — that makes the handler total instead of accidentally
   * correct, and costs one `if`. Deleting it because the states "cannot"
   * overlap is exactly the reasoning a fourth dialog would invalidate.
   */
  @HostListener('document:keydown.escape', ['$event'])
  onEscape(event: Event): void {
    if (this.panelVisible && this.isWriteInFlight) {
      return;
    }
    if (this.confirmDialogVisible) {
      this.onDeleteCancel();
      event.preventDefault();
      return;
    }
    if (!this.panelVisible) {
      return;
    }
    if (this.panel?.handleSecondaryEscape() === true) {
      event.preventDefault();
      return;
    }
    this.onPanelVisibleChange(false);
    event.preventDefault();
  }
}
