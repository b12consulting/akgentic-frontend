import { CommonModule } from '@angular/common';
import {
  Component,
  DestroyRef,
  EventEmitter,
  Input,
  OnChanges,
  OnInit,
  Output,
  SimpleChanges,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { NuMonacoEditorModule } from '@ng-util/monaco-editor';
import { ConfirmationService, MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';

import { NamespaceValidationReport } from '../../../models/catalog.interface';
import { ApiService } from '../../../services/api.service';
import { HttpError } from '../../../services/fetch.service';
import {
  CloneYamlError,
  rewriteNamespaceInYaml,
} from '../../../services/yaml-clone.helper';
import { ValidationReportComponent } from './validation-report/validation-report.component';

/**
 * NamespacePanelComponent — host-agnostic view of a catalog namespace YAML.
 *
 * Story 11.2 delivered the read-only scaffold. Story 11.3 adds:
 *   - Edit / Cancel / Save action row (Edit replaced by Cancel+Save in edit mode).
 *   - `hasUnsavedChanges()` is now a real buffer-vs-serverYaml comparison.
 *   - Save flow posts directly to `apiService.importNamespace` — NO
 *     pre-save `validate` round-trip (ADR-011 D4).
 *   - 422 → populate `lastValidation` (structured) or `rawSaveError`
 *     (fallback); stay in edit mode, buffer preserved.
 *   - 5xx / 4xx (other than 401/422) → sticky error toast + in-panel Retry
 *     button; stay in edit mode, buffer preserved.
 *   - 401 → no panel-specific behaviour; the FetchService global toast
 *     surfaces the failure, the app-wide handler (if any) runs. Panel only
 *     clears `saving` in `finally`.
 *   - PrimeNG `ConfirmDialog` guards Cancel-with-dirty-buffer.
 *
 * The component remains presentation-only: no `Router`, `ActivatedRoute`,
 * `MAT_DIALOG_DATA`, etc. The dialog wrapper (HomeComponent) and the future
 * deep-link route (Story 11.6) mount it identically.
 *
 * Public surface contract (stable across Epic 11):
 *   - @Input() namespace: string          — required, drives the load flow.
 *   - @Output() closed: EventEmitter<void> — asks the host to dismiss.
 *   - @Output() saved: EventEmitter<void>  — emitted once per successful
 *     import; hosts re-fetch derived lists (e.g. HomeComponent's dropdown).
 *   - hasUnsavedChanges(): boolean         — dirty-state predicate. Returns
 *     true iff `mode === 'edit' && buffer !== serverYaml`. Story 11.6's
 *     `CanDeactivate` guard consumes the same method.
 */
@Component({
  selector: 'app-namespace-panel',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    ConfirmDialogModule,
    DialogModule,
    InputTextModule,
    NuMonacoEditorModule,
    ValidationReportComponent,
  ],
  // ConfirmationService is provided locally per PrimeNG v19 pattern — scopes
  // the confirm dialog to this component (dialog + future route both get
  // their own scoped instance).
  providers: [ConfirmationService],
  templateUrl: './namespace-panel.component.html',
  styleUrls: ['./namespace-panel.component.scss'],
})
export class NamespacePanelComponent implements OnInit, OnChanges {
  @Input() namespace!: string;
  /**
   * Story 11.5 — existing namespace identifiers, supplied by the host, used
   * by the Clone dialog's pre-flight collision check (AC 4). The panel
   * NEVER re-fetches this list itself (NFR7 — the collision check is a UX
   * courtesy, not a correctness guarantee; see ADR-011 D5
   * Collision-on-race).
   */
  @Input() existingNamespaces: string[] = [];
  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>();

  private apiService: ApiService = inject(ApiService);
  private messageService: MessageService = inject(MessageService);
  private confirmationService: ConfirmationService = inject(ConfirmationService);
  private destroyRef: DestroyRef = inject(DestroyRef);

  // Internal state — initial values per AC 2.
  serverYaml: string = '';
  buffer: string = '';
  mode: 'view' | 'edit' = 'view';
  lastValidation: NamespaceValidationReport | null = null;
  loading: boolean = false;

  // Story 11.3 — Save flow state.
  /** True while an `importNamespace` request is in flight (AC 5). */
  saving: boolean = false;

  // Story 11.4 — Validate flow state.
  /**
   * True while a `validatePersistedNamespace` or `validateNamespaceBuffer`
   * request is in flight. Independent from `saving` / `loading` — see
   * Story 11.4 Dev Notes "Why three separate flags".
   */
  validating: boolean = false;
  /**
   * Raw (non-structured) server error body surfaced by a 422 whose payload
   * is not a `NamespaceValidationReport` (AC 7 fallback branch).
   * `null` means no unstructured error pending.
   */
  rawSaveError: string | null = null;
  /**
   * Tracks the most recent Save error (non-422). When non-null, an in-panel
   * Retry button is rendered in the action row (AC 8). This implementation
   * — action-row Retry rather than in-toast Retry — is chosen because
   * PrimeNG v19's default `<p-toast>` does not surface clickable actions
   * without a custom template; the action-row button satisfies the AC's
   * "operator can retry with one click, mutation is not auto-retried".
   */
  lastSaveError: Error | null = null;

  // Story 11.5 — Clone flow state.
  /** Controls visibility of the Clone sub-dialog (AC 2, AC 3). */
  cloneDialogVisible: boolean = false;
  /**
   * Destination namespace name typed into the Clone dialog (AC 3). Two-way
   * bound via `[(ngModel)]`; reset to `''` on dialog dismiss AND on
   * successful clone (AC 3, AC 8, AC 12).
   */
  cloneDestNs: string = '';
  /**
   * True while a clone-import request is in flight (AC 8 + AC 14). Gates
   * the Confirm button (defence in depth alongside the pre-flight
   * validation) and the outer Clone button so the operator cannot
   * double-submit.
   */
  cloning: boolean = false;
  /**
   * Tracks the most recent non-HTTP / non-422 / non-401 clone error. Mirrors
   * `lastSaveError`; the field is populated on the default failure branch
   * (AC 9) but deliberately NOT surfaced via an action-row Retry button —
   * re-clicking Clone Confirm is the natural retry path.
   */
  lastCloneError: Error | null = null;

  /**
   * Destroy guard consumed by the async load + save flows so a late-resolving
   * promise cannot write to state on a destroyed component (AC 13).
   */
  private destroyed = false;
  /**
   * Monotonic counter used to discard stale `exportNamespace` responses
   * when `namespace` changes mid-flight (AC 3 re-load contract).
   */
  private loadSeq = 0;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
    });
  }

  ngOnInit(): void {
    void this.loadNamespace(this.namespace);
  }

  ngOnChanges(changes: SimpleChanges): void {
    const change = changes['namespace'];
    if (!change || change.firstChange) {
      // ngOnInit owns the first-mount load — avoid a duplicate fetch.
      return;
    }
    if (change.previousValue === change.currentValue) {
      return;
    }
    void this.loadNamespace(this.namespace);
  }

  /**
   * Monaco editor options.
   *
   * MUST be a stable object reference between mode changes. `nu-monaco-editor`
   * receives `[options]` as a signal input (reference-equality semantics) —
   * returning a fresh object every change-detection tick (the previous getter
   * implementation) fires the input on every CD, causes `updateOptions()` to
   * run repeatedly, and drives a CD / layout feedback loop that freezes the
   * tab. The field is reassigned ONLY when `mode` flips (via `setMode`).
   *
   * `automaticLayout: true` is load-bearing for dialog hosting — the editor
   * otherwise renders at 0×0 when its container mounts late.
   */
  editorOptions: Record<string, unknown> = this.buildEditorOptions();

  private buildEditorOptions(): Record<string, unknown> {
    return {
      theme: 'vs',
      language: 'yaml',
      automaticLayout: true,
      readOnly: this.mode === 'view',
    };
  }

  /**
   * Single write path for `mode` — keeps `editorOptions` in lock-step so the
   * Monaco signal input sees exactly one new reference per real mode flip.
   */
  private setMode(next: 'view' | 'edit'): void {
    if (this.mode === next) {
      return;
    }
    this.mode = next;
    this.editorOptions = this.buildEditorOptions();
  }

  /**
   * Dirty-state predicate — single source of truth for confirm-on-close
   * and Save-enabled checks. True iff the panel is in edit mode AND the
   * buffer diverges from the last server snapshot. Method NAME + SIGNATURE
   * are part of Epic 11's stable surface (Story 11.6's `CanDeactivate`
   * guard consumes the same method).
   */
  hasUnsavedChanges(): boolean {
    return this.mode === 'edit' && this.buffer !== this.serverYaml;
  }

  /**
   * Flip the panel into edit mode. Monaco's `readOnly` flips via the
   * `editorOptions` getter (derived from `mode`). Cancel / Save buttons
   * replace the Edit button in the action row.
   */
  onEditClick(): void {
    this.setMode('edit');
  }

  /**
   * Cancel the edit. Clean buffer → flip to view directly. Dirty buffer →
   * PrimeNG confirm dialog; on accept revert buffer + flip to view, on
   * reject keep state unchanged (AC 3 + AC 4).
   */
  onCancelClick(): void {
    if (this.buffer === this.serverYaml) {
      this.setMode('view');
      return;
    }
    this.confirmationService.confirm({
      message: 'Discard unsaved changes?',
      accept: () => {
        if (this.destroyed) {
          return;
        }
        this.buffer = this.serverYaml;
        this.setMode('view');
      },
      // `reject` intentionally omitted — dismissing the confirm leaves the
      // panel exactly as it was (AC 3 dismiss branch).
    });
  }

  /**
   * Save handler — posts the current buffer directly to
   * `apiService.importNamespace` (NO pre-save validate, per ADR-011 D4).
   *
   * Success (2xx): `serverYaml` snapshots the just-saved buffer, mode flips
   * to view, toast success, `saved` emits so the host refreshes derived
   * lists.
   *
   * 422: populate `lastValidation` when the body is structurally a
   * `NamespaceValidationReport`, else stash the raw body into
   * `rawSaveError` for a verbatim `<pre>` rendering. Stay in edit mode,
   * buffer preserved, saving resets.
   *
   * 401: silent at the panel level. FetchService has already surfaced a
   * global toast; the app-wide 401 handler (if any) runs. The panel only
   * clears `saving` so a subsequent click is not stuck in a spinner.
   *
   * Other (4xx/5xx/network): sticky error toast + action-row Retry button
   * so the operator can retry with one click. `importNamespace` is NEVER
   * auto-retried by the panel (AC 8).
   */
  async onSaveClick(): Promise<void> {
    if (!this.hasUnsavedChanges() || this.saving) {
      return;
    }
    // Snapshot the buffer at click time so typing during the request does
    // NOT race the success branch (AC 2.3 guidance).
    const savedBuffer = this.buffer;
    this.saving = true;
    this.rawSaveError = null;
    this.lastSaveError = null;
    // Clear any stale validation from a prior save attempt so the UI does
    // not display outdated issues while the request is in flight.
    this.lastValidation = null;
    try {
      await this.apiService.importNamespace(savedBuffer);
      if (this.destroyed) {
        return;
      }
      this.serverYaml = savedBuffer;
      this.setMode('view');
      this.saved.emit();
      this.messageService.add({
        severity: 'success',
        summary: 'Namespace saved successfully',
      });
    } catch (err) {
      if (this.destroyed) {
        return;
      }
      this.handleSaveError(err);
    } finally {
      if (!this.destroyed) {
        this.saving = false;
      }
    }
  }

  /**
   * Validate the persisted namespace (view mode). Calls
   * `apiService.validatePersistedNamespace(this.namespace)` exactly once,
   * populates `this.lastValidation` on success, never mutates
   * `serverYaml` / `mode` / `buffer` / `rawSaveError` (Validate is never
   * a Save gate — ADR-011 D3 / D4).
   */
  async onValidatePersistedClick(): Promise<void> {
    if (this.validating) {
      return;
    }
    this.validating = true;
    try {
      const report = await this.apiService.validatePersistedNamespace(
        this.namespace,
      );
      if (this.destroyed) {
        return;
      }
      this.lastValidation = report;
    } catch (err) {
      if (this.destroyed) {
        return;
      }
      this.handleValidateError(err);
    } finally {
      if (!this.destroyed) {
        this.validating = false;
      }
    }
  }

  /**
   * Validate the current edit buffer without persisting. Snapshots
   * `this.buffer` at click time (`bufferAtClick`) so Monaco's live
   * `[(ngModel)]` mutation during the in-flight request cannot race the
   * request args (mirrors Story 11.3's `savedBuffer` pattern).
   *
   * Validate never mutates `mode`, `serverYaml`, or `buffer` — the
   * handler touches only `validating` and `lastValidation`.
   */
  async onValidateBufferClick(): Promise<void> {
    if (this.validating) {
      return;
    }
    const bufferAtClick = this.buffer;
    this.validating = true;
    try {
      const report =
        await this.apiService.validateNamespaceBuffer(bufferAtClick);
      if (this.destroyed) {
        return;
      }
      this.lastValidation = report;
    } catch (err) {
      if (this.destroyed) {
        return;
      }
      this.handleValidateError(err);
    } finally {
      if (!this.destroyed) {
        this.validating = false;
      }
    }
  }

  /**
   * Parent-owned clear for the `ValidationReportComponent` output. Nulls
   * both `lastValidation` and `rawSaveError` so the sub-component emits
   * no DOM on the next CD tick (branch (a) — AC 8).
   */
  onClearValidationClick(): void {
    this.lastValidation = null;
    this.rawSaveError = null;
  }

  /**
   * Handle a rejected Validate call. 401 is silent (FetchService / the
   * app-wide handler owns the surface). Other statuses emit a non-sticky
   * error toast — re-clicking the Validate button is the natural retry,
   * so no Retry action is attached (AC 11). Validate never writes Save's
   * fallback fields (`rawSaveError`) or the current report
   * (`lastValidation` stays as it was — preserved across error paths).
   */
  private handleValidateError(err: unknown): void {
    const status = (err as { status?: number })?.status;
    if (status === 401) {
      // Silent — FetchService already fired a global toast.
      return;
    }
    // Non-sticky toast: Validate is idempotent, re-clicking is the retry.
    this.messageService.add({
      severity: 'error',
      summary: 'Validation failed',
      detail: (err as Error)?.message ?? String(err),
    });
    // Validate never writes Save's fallback fields — they belong to the
    // Save flow.
  }

  /**
   * Narrows the caught Save error into one of four branches: 401 silent,
   * 422 structured, 422 fallback, other (toast + retry).
   */
  private handleSaveError(err: unknown): void {
    const status = (err as { status?: number })?.status;
    if (status === 401) {
      // Silent at the panel — FetchService already fired a global toast and
      // the app-wide 401 handler (if any) runs. The panel does not mutate
      // `mode` / `buffer` / `lastValidation` on 401 (AC 9).
      return;
    }
    if (status === 422) {
      const body = (err as HttpError).body;
      if (this.isValidationReport(body)) {
        this.lastValidation = body;
        this.rawSaveError = null;
      } else {
        this.rawSaveError =
          typeof body === 'string' ? body : JSON.stringify(body, null, 2);
        this.lastValidation = null;
      }
      return;
    }
    // Other (4xx / 5xx / network). Record the error so the action-row
    // Retry button renders, and surface a sticky error toast.
    this.lastSaveError = err instanceof Error ? err : new Error(String(err));
    this.messageService.add({
      severity: 'error',
      summary: 'Save failed',
      detail: this.lastSaveError.message,
      sticky: true,
    });
  }

  // -------------------------------------------------------------------
  // Story 11.5 — Clone flow (AC 1–AC 12)
  // -------------------------------------------------------------------

  /**
   * Open the Clone sub-dialog (AC 2). Pure UI flip — does NOT fire a
   * network request, does NOT mutate `buffer` / `serverYaml` / `mode` /
   * `lastValidation` / `rawSaveError`. No-op when `cloning === true`
   * (defence in depth — the outer Clone button is `[disabled]` in that
   * state, so this path is unreachable in practice).
   */
  onCloneClick(): void {
    if (this.cloning) {
      return;
    }
    this.cloneDialogVisible = true;
  }

  /**
   * Cancel the Clone sub-dialog (AC 3). Resets `cloneDestNs`; does NOT
   * mutate `cloning` — an in-flight clone request keeps settling via its
   * own try/catch/finally (Story 11.4's destroy-guard idiom).
   */
  onCloneCancelClick(): void {
    this.cloneDialogVisible = false;
    this.cloneDestNs = '';
  }

  /**
   * `(visibleChange)` handler for the Clone sub-dialog. Mirrors Cancel's
   * reset: when the dialog dismisses (visible = false, e.g. ESC or the
   * close X), we zero `cloneDestNs` so the next open starts clean (AC 3).
   * `cloning` is intentionally unchanged — an in-flight request keeps
   * settling regardless of dialog visibility.
   */
  onCloneDialogVisibleChange(visible: boolean): void {
    this.cloneDialogVisible = visible;
    if (!visible) {
      this.cloneDestNs = '';
    }
  }

  /**
   * Pre-flight predicate for the Clone Confirm button (AC 4). True iff any
   * of: destNs is empty-trimmed, destNs equals the source namespace, destNs
   * already appears in `existingNamespaces` (case-sensitive), or a clone is
   * already in flight.
   */
  get cloneConfirmDisabled(): boolean {
    const trimmed = this.cloneDestNs.trim();
    if (trimmed === '') {
      return true;
    }
    if (trimmed === this.namespace) {
      return true;
    }
    if (this.existingNamespaces.includes(trimmed)) {
      return true;
    }
    return this.cloning;
  }

  /**
   * Inline validation message for the Clone dialog (AC 4). Returns `null`
   * while the destNs is an unused, non-colliding value — so the template
   * can gate the error block with `*ngIf`.
   */
  get cloneValidationError(): string | null {
    const trimmed = this.cloneDestNs.trim();
    if (trimmed === '') {
      return 'Destination namespace required';
    }
    if (trimmed === this.namespace) {
      return 'Destination must differ from source namespace';
    }
    if (this.existingNamespaces.includes(trimmed)) {
      return `Namespace '${trimmed}' already exists`;
    }
    return null;
  }

  /**
   * Clone handler — "Save As" semantics (AC 5). Captures the CURRENT buffer
   * (NOT `serverYaml`) so an operator editing mid-view and clicking Clone
   * sees their dirty edits in the rewritten bundle. Rewrites the root
   * `namespace` field via {@link rewriteNamespaceInYaml}, then reuses the
   * Save path (`apiService.importNamespace`) — no new endpoint.
   *
   * Branches (AC 8–AC 12):
   *   - `CloneYamlError` before the network call → toast + dialog stays
   *     open, `cloning` resets, `importNamespace` NEVER called.
   *   - 2xx → dismiss dialog, emit `(saved)`, switch to destNs, re-load via
   *     `loadNamespace(destNs)` (Story 11.2 contract — lands in view mode).
   *   - 401 silent (FetchService surfaces the global toast).
   *   - 422 structured → populate `lastValidation`; dialog stays open.
   *   - 422 unstructured → stash raw body in `rawSaveError`; dialog stays
   *     open.
   *   - Other (4xx / 5xx / network) → sticky error toast + `lastCloneError`;
   *     dialog stays open.
   *
   * In every failure branch: `namespace` / `serverYaml` / `buffer` / `mode`
   * are unchanged (AC 10). Destroy-guard mirrors Story 11.3's `onSaveClick`.
   */
  async onCloneConfirmClick(): Promise<void> {
    if (this.cloneConfirmDisabled) {
      return;
    }
    const destNs = this.cloneDestNs.trim();
    const sourceYaml = this.buffer;
    this.cloning = true;
    this.lastCloneError = null;
    try {
      const rewrittenYaml = rewriteNamespaceInYaml(sourceYaml, destNs);
      await this.apiService.importNamespace(rewrittenYaml);
      if (this.destroyed) {
        return;
      }
      // 2xx happy path: dismiss dialog, emit saved, switch namespace +
      // re-load. Programmatic self-writes to an @Input() field do NOT
      // trigger ngOnChanges, so we invoke loadNamespace explicitly — it
      // re-exports the bundle and flips mode to view (Story 11.2).
      this.cloneDialogVisible = false;
      this.cloneDestNs = '';
      this.saved.emit();
      this.namespace = destNs;
      // Fire-and-forget: loadNamespace owns its own loading flag and
      // destroy guard. AC 14 budgets this second fetch explicitly.
      void this.loadNamespace(destNs);
      this.messageService.add({
        severity: 'success',
        summary: `Cloned to namespace '${destNs}'`,
      });
    } catch (err) {
      if (this.destroyed) {
        return;
      }
      this.handleCloneError(err);
    } finally {
      if (!this.destroyed) {
        this.cloning = false;
      }
    }
  }

  /**
   * Narrow the caught Clone error (AC 9 + AC 11). Branch order MUST match
   * AC 11 exactly: `CloneYamlError` FIRST (client-side rewrite failure,
   * `importNamespace` never fired), then 401 silent, then 422 structured /
   * 422 unstructured, then default sticky toast.
   */
  private handleCloneError(err: unknown): void {
    if (err instanceof CloneYamlError) {
      // Client-side rewrite failure — `lastCloneError` is NOT set (that
      // field tracks server errors; the operator can fix the buffer and
      // retry). Non-sticky toast; dialog stays open.
      this.messageService.add({
        severity: 'error',
        summary: 'Clone failed',
        detail: err.message,
      });
      return;
    }
    const status = (err as { status?: number })?.status;
    if (status === 401) {
      // Silent — FetchService already fired a global toast.
      return;
    }
    if (status === 422) {
      const body = (err as HttpError).body;
      if (this.isValidationReport(body)) {
        this.lastValidation = body;
        this.rawSaveError = null;
      } else {
        this.rawSaveError =
          typeof body === 'string' ? body : JSON.stringify(body, null, 2);
        this.lastValidation = null;
      }
      return;
    }
    // Default: 4xx / 5xx / network. Sticky toast + `lastCloneError` so a
    // future story could wire an in-panel Retry-Clone button. This story
    // deliberately does NOT add a Retry button — re-clicking Clone Confirm
    // is the natural retry path, and the action row is already dense.
    this.lastCloneError = err instanceof Error ? err : new Error(String(err));
    this.messageService.add({
      severity: 'error',
      summary: 'Clone failed',
      detail: this.lastCloneError.message,
      sticky: true,
    });
  }

  /** Structural check: does `body` satisfy `NamespaceValidationReport`? */
  private isValidationReport(
    body: unknown,
  ): body is NamespaceValidationReport {
    if (body === null || typeof body !== 'object') {
      return false;
    }
    const shape = body as Record<string, unknown>;
    return (
      'ok' in shape &&
      typeof shape['ok'] === 'boolean' &&
      Array.isArray(shape['global_errors']) &&
      Array.isArray(shape['entry_issues'])
    );
  }

  /**
   * Loads the given namespace YAML via `apiService.exportNamespace`.
   * Uses a monotonic `loadSeq` so a slow response for an old namespace
   * cannot clobber a newer request's state, and a `destroyed` guard so
   * no writes land on a destroyed component.
   */
  private async loadNamespace(namespace: string): Promise<void> {
    const seq = ++this.loadSeq;
    this.loading = true;
    // Reset buffer/serverYaml at the start of each reload so the empty
    // state renders (AC 3 step 1 + AC 5) while the fetch is in flight.
    this.serverYaml = '';
    this.buffer = '';
    try {
      const yaml = await this.apiService.exportNamespace(namespace);
      if (this.destroyed || seq !== this.loadSeq) {
        return;
      }
      this.serverYaml = yaml;
      this.buffer = yaml;
      this.setMode('view');
      this.lastValidation = null;
      this.rawSaveError = null;
      this.lastSaveError = null;
    } catch (err) {
      if (this.destroyed || seq !== this.loadSeq) {
        return;
      }
      this.messageService.add({
        severity: 'error',
        summary: `Unable to load namespace '${namespace}'`,
        detail: (err as Error)?.message ?? String(err),
      });
      // Leave serverYaml = '' and buffer = '' — empty-state branch handles it.
    } finally {
      if (this.destroyed || seq !== this.loadSeq) {
        return;
      }
      this.loading = false;
    }
  }
}
