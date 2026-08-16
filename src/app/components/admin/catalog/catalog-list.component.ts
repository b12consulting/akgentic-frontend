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
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { Observable, combineLatest } from 'rxjs';

import { AuthService } from '../../../core/auth/auth.service';
import { ApiService } from '../../../core/http/api.service';
import { ENTRY_KINDS, EntryKind } from '../../../protocol/catalog.interface';
import { NamespacePanelComponent } from '../../catalog/namespace-panel/namespace-panel.component';
import { NamespaceRow } from './namespace-row.model';
import { NamespaceRowsService } from './namespace-rows.service';

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
 * `NamespaceRowsService` is a bare `@Injectable()` (ADR-015 §2b) and is
 * provided here — component-scoped, one composition per mounted pane.
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
    TableModule,
    TagModule,
    ToggleSwitchModule,
    NamespacePanelComponent,
  ],
  providers: [NamespaceRowsService],
  templateUrl: './catalog-list.component.html',
  styleUrls: ['./catalog-list.component.scss'],
})
export class CatalogListComponent implements OnInit {
  readonly #rowsService = inject(NamespaceRowsService);
  readonly #api = inject(ApiService);
  readonly #auth = inject(AuthService);
  readonly #destroyRef = inject(DestroyRef);

  /** Iterated by the counts cell — the tuple, never a hand-written list. */
  readonly entryKinds = ENTRY_KINDS;

  readonly deleteDeniedReason = DELETE_DENIED_REASON;

  /**
   * Gates the admin-only "show all namespaces" toggle, consumed through the
   * `async` pipe so a late `/auth/me` resolution makes it appear (AC 6).
   */
  readonly isAdmin$: Observable<boolean> = this.#auth.isAdmin$;

  rows: NamespaceRow[] = [];
  unavailableKinds: EntryKind[] = [];
  loading = false;
  /** A rejected load is NOT an empty catalog — the two never render alike. */
  loadFailed = false;
  showAll = false;

  confirmDialogVisible = false;
  pendingDelete: NamespaceRow | null = null;
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
   * through here, so `all` can never diverge between them.
   */
  async loadRows(): Promise<void> {
    this.loading = true;
    this.loadFailed = false;
    try {
      const result = await this.#rowsService.getRows({ all: this.showAll });
      this.rows = result.rows;
      this.unavailableKinds = result.unavailableKinds;
    } catch {
      // FetchService already toasted (ADR-026); adding another would
      // double-report. Render the failure state — never an empty table, which
      // would assert "this deployment has no namespaces" for a request that
      // never got an answer.
      this.rows = [];
      this.unavailableKinds = [];
      this.loadFailed = true;
    } finally {
      this.loading = false;
    }
  }

  onToggleShowAll(value: boolean): void {
    this.showAll = value;
    void this.loadRows();
  }

  /**
   * THE rule, written once and read by every control in the row.
   *
   * `isAdmin || row.owner === caller` — a disjunction, mirroring
   * `_catalog_authz.require_namespace_owner_or_admin`. An unknown owner
   * (`null`) fails closed on the ownership half: denied for a non-admin,
   * still allowed for an admin.
   */
  canModify(row: NamespaceRow): boolean {
    return (
      this.#viewer.isAdmin ||
      (row.owner !== null && row.owner === this.#viewer.userId)
    );
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
  primaryActionLabel(row: NamespaceRow): string {
    return this.canModify(row) ? 'Configure' : 'View';
  }

  /** `null` when allowed, so the attribute is absent rather than empty. */
  deleteDisabledReason(row: NamespaceRow): string | null {
    return this.canModify(row) ? null : DELETE_DENIED_REASON;
  }

  /**
   * A count, or `—` when that kind's page-wide list call failed.
   *
   * Zero is rendered as the character `0`: a namespace with no tools is a fact
   * worth stating, and blanking it would be indistinguishable from the
   * unavailable case.
   */
  countLabel(row: NamespaceRow, kind: EntryKind): string {
    return this.unavailableKinds.includes(kind) ? '—' : String(row.counts[kind]);
  }

  onDeleteClick(row: NamespaceRow): void {
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
  onPrimaryActionClick(row: NamespaceRow): void {
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
