import { CommonModule } from '@angular/common';
import {
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
import { TableModule } from 'primeng/table';
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
 * Story 36-4 made this pane a DIALOG HOST as well as a table: the row's
 * primary action opens `NamespacePanelComponent` in a `p-dialog` over the list
 * instead of navigating away, so the list stays mounted behind it (which is
 * what lets `existingNamespaces` come from data already on screen and lets a
 * save refresh the table). The deep-link URL survives as a bookmark — it is
 * simply no longer reachable by clicking.
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
export class CatalogListComponent implements OnInit {
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
  readonly filterPlaceholder = CATALOG_FILTER_PLACEHOLDER;

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
   * Recompute `filteredRows` from `rows` and the current needle.
   *
   * Matches case-insensitively against BOTH the identifier and the display
   * name: an operator who knows a namespace by either should find it by
   * either. Every path that rebuilds `rows` must come through here — a load, a
   * filter keystroke, and the delete-success path, which otherwise leaves a
   * deleted row standing in the filtered view.
   */
  #applyFilter(): void {
    const needle = this.filterText.trim().toLowerCase();
    this.filteredRows =
      needle === ''
        ? this.rows
        : this.rows.filter(
            (row) =>
              row.namespace.toLowerCase().includes(needle) ||
              row.name.toLowerCase().includes(needle),
          );
  }

  /**
   * True iff the filter is hiding every loaded row.
   *
   * A DIFFERENT fact from an empty catalog, and rendered differently: "no
   * namespaces match this filter" is about the box the operator just typed in,
   * while `catalog-empty` claims the deployment holds nothing at all.
   */
  get filterHidesEverything(): boolean {
    return this.rows.length > 0 && this.filteredRows.length === 0;
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

  /**
   * The primary action's LABEL. Its destination never varies — both Configure
   * and View open the same panel, on the same namespace, in the same dialog.
   *
   * `View` is a label and not a mode. The panel's editor is writable by design
   * and exposes no read-only input; adding one would be an edit inside
   * `components/catalog/namespace-panel/`, which this pane does not make. A
   * non-owner may therefore open the panel and type — the panel's Save-time
   * owner-or-admin preflight and the server's 403 are the real boundary, and
   * always were.
   */
  primaryActionLabel(row: NamespaceSummary): string {
    return this.canModify(row) ? 'Configure' : 'View';
  }

  /**
   * The icon beside that label. The control keeps its text — Configure-vs-View
   * IS the entitlement affordance, and it is where a non-owner learns they are
   * read-only before clicking — so this reinforces the label rather than
   * replacing it.
   */
  primaryActionIcon(row: NamespaceSummary): string {
    return this.canModify(row) ? 'pi pi-cog' : 'pi pi-eye';
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
   * The row's primary action: open the panel over the list, on THIS row's
   * namespace. Not a navigation — the list must stay mounted behind the dialog
   * for `existingNamespaces` and the `(saved)` refresh to mean anything.
   */
  onPrimaryActionClick(row: NamespaceSummary): void {
    this.panelNamespace = row.namespace;
    this.panelLabel = row.name === '' ? row.namespace : row.name;
    this.panelVisible = true;
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
