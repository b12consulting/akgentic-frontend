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
   * The keys whose CURRENT value failed the pattern their descriptor declares.
   *
   * A plain recorded result, never a computed one. `canConfirm` folds this in
   * and Angular re-evaluates that getter on every change-detection cycle —
   * which includes every keystroke — so running a regex to answer it would put
   * a catastrophic-backtracking pattern on the typing path. The regex runs on
   * blur and inside `onConfirm()` only; everything the template asks reads
   * what those two recorded.
   */
  patternErrors = new Set<string>();

  /**
   * Compiled patterns, keyed on the pattern string, `null` for one that would
   * not compile.
   *
   * Memoised so a failed compile is attempted exactly once and the try/catch
   * has exactly one home. Keyed on the string rather than on the field key
   * because two fields declaring the same pattern are the same regex.
   */
  private readonly compiled = new Map<string, RegExp | null>();

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
   * Confirmation is blocked by a blank MANDATORY field or by a RECORDED
   * pattern failure. `index` gates nothing, and a contract whose fields are
   * all optional and all match confirms with nothing typed (emitting `{}`,
   * which the API service then drops).
   *
   * READS the recorded failures — never runs a regex. See `patternErrors`.
   */
  get canConfirm(): boolean {
    return (
      this.fields.every((field) => !field.mandatory || !this.isBlank(field.key)) &&
      !this.anyPatternError()
    );
  }

  /** True once a declared field is carrying a recorded pattern failure. */
  private anyPatternError(): boolean {
    return this.fields.some((field) => this.patternErrors.has(field.key));
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
   * Compiles a declared pattern, or returns `null` when it will not compile.
   *
   * Patterns are deployment-controlled catalog data, so a malformed one is an
   * upstream mistake arriving at runtime — never a reason for this modal to
   * throw. `null` travels all the way out to the callers, which read it as
   * "this field has no client-side check"; no caller ever dereferences it, so
   * the guard covers the whole use rather than just the constructor.
   */
  private compile(pattern: string): RegExp | null {
    const memoised = this.compiled.get(pattern);
    if (memoised !== undefined) {
      return memoised;
    }
    let regex: RegExp | null;
    try {
      regex = new RegExp(pattern);
    } catch {
      regex = null;
    }
    this.compiled.set(pattern, regex);
    return regex;
  }

  /**
   * Whether a field has no complaint about `trimmed`.
   *
   * Three ways to have nothing to say: the field declares no pattern
   * (`undefined`, `null` and `''` are all "no pattern"), the pattern would not
   * compile, or the value is absent — `pattern` constrains a value that is
   * PRESENT and never makes a field mandatory, which is `mandatory`'s job.
   *
   * NOT anchored here. `RegExp.test` searches, and so does the server's own
   * check; wrapping the pattern in `^…$` would reject values the server
   * accepts, which is the one direction a client-side check must never fail.
   */
  private matches(field: MetadataFieldDescriptor, trimmed: string): boolean {
    const pattern = field.pattern;
    if (!pattern || trimmed === '') {
      return true;
    }
    const regex = this.compile(pattern);
    return regex === null || regex.test(trimmed);
  }

  /** Records or clears one field's failure, against its TRIMMED value. */
  private recordPattern(field: MetadataFieldDescriptor): void {
    // The trimmed value is the string that would be POSTED, so it is the
    // string that must be checked: `"  acme  "` posts as `"acme"`, and
    // rejecting the padded form would reject exactly what the server accepts.
    const trimmed = (this.values[field.key] ?? '').trim();
    if (this.matches(field, trimmed)) {
      this.patternErrors.delete(field.key);
    } else {
      this.patternErrors.add(field.key);
    }
  }

  /** Every declared field at once — the gate `onConfirm` runs. */
  private validateAll(): void {
    for (const field of this.fields) {
      this.recordPattern(field);
    }
  }

  /**
   * The moment the user is told: leaving a field validates it.
   *
   * Blur rather than input, because a pattern can backtrack catastrophically
   * and per-keystroke evaluation would hang the tab.
   */
  onFieldBlur(field: MetadataFieldDescriptor): void {
    this.recordPattern(field);
  }

  /**
   * Writes the draft and clears that field's recorded failure. Runs NO regex.
   *
   * The clear is what unblocks the user, not a nicety: a recorded failure
   * disables the Create button, a disabled button fires no events, so a user
   * who corrects a flagged value cannot click anything to blur the field they
   * just fixed. Clearing on input costs one set delete.
   */
  onFieldInput(field: MetadataFieldDescriptor, value: string): void {
    this.values[field.key] = value;
    this.patternErrors.delete(field.key);
  }

  /** The `*ngIf` predicate for a field's message — a recorded-state read. */
  hasPatternError(key: string): boolean {
    return this.patternErrors.has(key);
  }

  /**
   * What the user reads. NEVER the pattern itself — a regex is not an error
   * message. The field's `description` says what is expected; `key` names the
   * field, and is always present and unique where a description may be empty.
   *
   * Built from `key` and `description` separately rather than from
   * `labelFor()`, which already falls back to the key and would otherwise
   * render the description twice.
   */
  patternMessageFor(field: MetadataFieldDescriptor): string {
    const expected = field.description
      ? `expected ${field.description}`
      : 'value is not in the expected format';
    return `${field.key}: ${expected}`;
  }

  /**
   * The input's `aria-describedby`, as the space-separated token LIST it is —
   * an indexed field carrying a failure is described by two elements.
   *
   * `null` rather than `''` when there is nothing to name: Angular removes the
   * attribute entirely on `null`, where `''` would leave an empty
   * `aria-describedby` in the DOM.
   */
  describedByFor(field: MetadataFieldDescriptor): string | null {
    const tokens: string[] = [];
    if (field.index) {
      tokens.push(`metadata-index-${field.key}`);
    }
    if (this.hasPatternError(field.key)) {
      tokens.push(`metadata-pattern-error-${field.key}`);
    }
    return tokens.length > 0 ? tokens.join(' ') : null;
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
    // The gate of record. `canConfirm` reads what blur happened to record, so
    // a value that was never blurred — the last field a keyboard user fills —
    // has never been looked at. Validating here catches it; the click then
    // renders the message and disables the button it was made on.
    this.validateAll();
    if (this.anyPatternError()) {
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
    // The recorded failures belong to the draft that is being thrown away.
    // Kept, they would show a message for an input that is now empty and —
    // since they fold into `canConfirm` — block a modal nobody has typed into.
    this.patternErrors = new Set<string>();
  }
}
