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
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';

import { NamespaceValidationReport } from '../../../models/catalog.interface';
import { ApiService } from '../../../services/api.service';

/**
 * NamespacePanelComponent — host-agnostic view of a catalog namespace YAML.
 *
 * Story 11.2 delivers the read-only scaffold: input-driven load via
 * `apiService.exportNamespace`, Monaco YAML editor mounted read-only,
 * empty/loading/error branches in the template, and a placeholder Edit
 * button whose handler is filled in by Story 11.3.
 *
 * The component is presentation-only: it has NO conditional logic on its
 * host (no references to `Router`, `ActivatedRoute`, `MAT_DIALOG_DATA`,
 * etc.). The dialog wrapper (HomeComponent) and the future deep-link
 * route (Story 11.6) mount it identically.
 *
 * Public surface contract (stable across Epic 11):
 *   - @Input() namespace: string          — required, drives the load flow.
 *   - @Output() closed: EventEmitter<void> — asks the host to dismiss.
 *   - hasUnsavedChanges(): boolean         — dirty-state predicate.
 *     Always returns false in Story 11.2 (view-only); Story 11.3 replaces
 *     the body with the real buffer-vs-serverYaml comparison.
 */
@Component({
  selector: 'app-namespace-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, NuMonacoEditorModule],
  templateUrl: './namespace-panel.component.html',
  styleUrls: ['./namespace-panel.component.scss'],
})
export class NamespacePanelComponent implements OnInit, OnChanges {
  @Input() namespace!: string;
  @Output() closed = new EventEmitter<void>();

  private apiService: ApiService = inject(ApiService);
  private messageService: MessageService = inject(MessageService);
  private destroyRef: DestroyRef = inject(DestroyRef);

  // Internal state — initial values per AC 2.
  serverYaml: string = '';
  buffer: string = '';
  mode: 'view' | 'edit' = 'view';
  lastValidation: NamespaceValidationReport | null = null;
  loading: boolean = false;

  /**
   * Destroy guard consumed by the async load flow so a late-resolving
   * promise cannot write to state on a destroyed component (AC 12).
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
   * Monaco editor options — `readOnly` is derived from `mode` so the same
   * getter serves both Story 11.2 (always view) and Story 11.3 (flips on
   * Edit click). `automaticLayout: true` is load-bearing for dialog hosting
   * (the editor otherwise renders at 0×0 when its container mounts late).
   */
  get editorOptions(): Record<string, unknown> {
    return {
      theme: 'vs',
      language: 'yaml',
      automaticLayout: true,
      readOnly: this.mode === 'view',
    };
  }

  /**
   * Dirty-state predicate — single source of truth for confirm-on-close
   * and Save-enabled checks. Always false in Story 11.2 (no edit mode
   * exists yet). Story 11.3 replaces the body with
   * `this.buffer !== this.serverYaml`. The method NAME and SIGNATURE are
   * part of Epic 11's stable surface — do not rename or retype.
   */
  hasUnsavedChanges(): boolean {
    return false;
  }

  /**
   * Placeholder Edit handler. Story 11.3 replaces the body to flip
   * `mode` to `'edit'` (and stamp `buffer` for the diff). Keep the name
   * `onEditClick` stable across Epic 11 so the template binding does
   * not need to move.
   */
  onEditClick(): void {
    // TODO Story 11.3 — flip to edit mode (set this.mode = 'edit').
    console.log('[NamespacePanel] Edit clicked — Story 11.3 activates edit.');
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
      this.mode = 'view';
      this.lastValidation = null;
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
