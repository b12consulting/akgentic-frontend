import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';

import {
  MetadataFieldDescriptor,
  TeamMetadataContract,
} from '../../../protocol/catalog.interface';

/**
 * Asks for the metadata a namespace's team declares, before that team is
 * created.
 *
 * PURELY PRESENTATIONAL. It injects nothing, calls no service and creates no
 * team: it renders one free-text input per declared field and emits the
 * answers. The host (`HomeComponent`) owns visibility, owns the create call,
 * and owns the error state — which is why `visible` is an `@Input()` this
 * component never writes: every dismissal channel (the X button, the
 * dismissable mask, Escape) routes to `cancelled` and the host decides.
 *
 * EVERY FIELD IS A FREE-TEXT INPUT. The descriptor carries no type by
 * decision (catalog ADR-022 §D1), so nothing here infers a control from the
 * key name or the description — no checkbox for a key called `vip`, no date
 * picker for one called `date`. The server validates in Pydantic's lax mode
 * (`"true"` reaches a `bool`, `"7"` reaches an `int`); where it does not, the
 * 422 arrives back through `errorMessage`.
 */
@Component({
  selector: 'app-team-metadata-modal',
  imports: [CommonModule, FormsModule, DialogModule, ButtonModule, InputTextModule],
  templateUrl: './team-metadata-modal.component.html',
  styleUrl: './team-metadata-modal.component.scss',
})
export class TeamMetadataModalComponent implements OnChanges {
  /** Owned by the host — this component never writes it. */
  @Input() visible = false;

  /** The contract to ask for. `null` renders nothing. */
  @Input() contract: TeamMetadataContract | null = null;

  /** Named in the header so a user who opened the wrong row can tell. */
  @Input() namespaceLabel = '';

  /** The server's 422 message, or `null` when there is nothing to show. */
  @Input() errorMessage: string | null = null;

  /** A create is in flight — locks the controls. */
  @Input() pending = false;

  @Output() confirmed = new EventEmitter<Record<string, string>>();
  @Output() cancelled = new EventEmitter<void>();

  /**
   * The draft, seeded to `''` for every declared key so each `[(ngModel)]`
   * binding has a home.
   *
   * THOSE SEEDED EMPTY STRINGS MUST NEVER REACH THE EMITTED MAP. They are a
   * binding concern only: `onConfirm` rebuilds the map from scratch and
   * assigns a key only when its trimmed value is non-empty. For an indexed
   * field the difference between an absent key and `''` is the difference
   * between no index entry and one reading `"key|"`.
   */
  values: Record<string, string> = {};

  /**
   * Re-seeds the draft whenever the contract changes OR the dialog opens.
   *
   * Both triggers are load-bearing. Cancelling and reopening on the SAME
   * contract object fires no `contract` change, so without the `visible`
   * trigger the previous answers would still be sitting in the inputs;
   * switching to a different namespace without re-seeding would carry a stale
   * key into the next emission.
   */
  ngOnChanges(changes: SimpleChanges): void {
    const opened = changes['visible'] !== undefined && this.visible;
    if (changes['contract'] !== undefined || opened) {
      this.resetDraft();
    }
  }

  /** The declared fields, in declaration order — the server never sorts. */
  get fields(): MetadataFieldDescriptor[] {
    return this.contract?.fields ?? [];
  }

  /** `description`, falling back to `key` so a label is never blank. */
  labelFor(field: MetadataFieldDescriptor): string {
    return field.description || field.key;
  }

  /** Whitespace-only counts as blank — for the gate AND for omission. */
  isBlank(key: string): boolean {
    return (this.values[key] ?? '').trim() === '';
  }

  /**
   * Confirmation is blocked only by a blank MANDATORY field. `index` gates
   * nothing, and a contract whose fields are all optional confirms with
   * nothing typed (emitting `{}`, which the API service then drops).
   */
  get canConfirm(): boolean {
    return this.fields.every((field) => !field.mandatory || !this.isBlank(field.key));
  }

  /**
   * The labels of the mandatory fields still blank. Rendered next to the
   * disabled confirm button: a disabled button fires no mouse events, so the
   * reason cannot live in a tooltip on the button itself.
   */
  get missingMandatoryLabels(): string[] {
    return this.fields
      .filter((field) => field.mandatory && this.isBlank(field.key))
      .map((field) => this.labelFor(field));
  }

  /**
   * Emits the answers as a flat map, built by OMITTING blank keys rather than
   * by assigning `undefined` — a map carrying `{a: undefined}` counts as
   * non-empty at the API service's gate and then loses the key to
   * `JSON.stringify`, producing a `"metadata":{}` body.
   *
   * Does NOT close the dialog: the host owns visibility, and on a rejected
   * create the modal must stay open with the input intact.
   */
  onConfirm(): void {
    if (!this.canConfirm) {
      return;
    }
    const out: Record<string, string> = {};
    for (const field of this.fields) {
      const value = (this.values[field.key] ?? '').trim();
      if (value !== '') {
        out[field.key] = value;
      }
    }
    this.confirmed.emit(out);
  }

  /** Emits `cancelled`; the host closes and creates nothing. */
  onCancel(): void {
    this.cancelled.emit();
  }

  /**
   * Every dismissal channel PrimeNG owns (the X button, the dismissable mask,
   * Escape) arrives here as `false` and is treated exactly like Cancel.
   */
  onVisibleChange(next: boolean): void {
    if (!next) {
      this.onCancel();
    }
  }

  private resetDraft(): void {
    const seeded: Record<string, string> = {};
    for (const field of this.fields) {
      seeded[field.key] = '';
    }
    this.values = seeded;
  }
}
