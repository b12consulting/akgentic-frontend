import { CommonModule } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  ViewChild,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { Observable, combineLatest } from 'rxjs';

import { AuthService } from '../../../core/auth/auth.service';
import { ApiService } from '../../../core/http/api.service';
import { ENTRY_KINDS, EntryKind } from '../../../protocol/catalog.interface';
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
 */
@Component({
  selector: 'app-admin-catalog-list',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    ButtonModule,
    DialogModule,
    TableModule,
    TagModule,
    ToggleSwitchModule,
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

  @ViewChild('confirmProceedBtn')
  private confirmProceedBtn?: ElementRef<HTMLButtonElement>;

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

  /** The primary action's label. Its DESTINATION never varies (AC 15). */
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
}
