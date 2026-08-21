import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
} from '@angular/core';
import {
  AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  ValidatorFn,
} from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';

import {
  MetadataFieldDescriptor,
  TeamMetadataContract,
} from '../../../protocol/catalog.interface';

/**
 * Compiles a declared pattern, or returns `null` when it will not compile.
 *
 * Patterns are deployment-controlled catalog data, so a malformed one is an
 * upstream mistake arriving at runtime — never a reason for this modal to
 * throw. `null` reads as "this field has no client-side check". Compiled once
 * per form build, so a keystroke never pays for a recompile.
 */
function safeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * `Validators.required`, except whitespace-only counts as blank — the same
 * trim the emission applies, so the gate and the payload cannot disagree.
 */
function requiredNonBlank(control: AbstractControl): ValidationErrors | null {
  return String(control.value ?? '').trim() === '' ? { required: true } : null;
}

/**
 * The pattern check, as a plain `ValidatorFn`.
 *
 * Deliberately NOT `Validators.pattern`, which diverges from the wire contract
 * three ways: handed a string it anchors it (`^…$`), and the server's own
 * check SEARCHES — Pydantic accepts `"123abc456"` against `[a-z]+` — so an
 * anchored client check rejects values the server accepts, the one direction
 * an advisory check must never fail; it tests the UNTRIMMED value where the
 * emission posts the trimmed one; and it treats whitespace-only as a value
 * where this contract treats it as blank. What IS adopted from the framework
 * is everything else: the value, `touched` and error state this component
 * used to track by hand now live on the `FormControl`, re-validated on every
 * keystroke exactly as Angular's own validators are.
 *
 * Blank is valid here regardless of `mandatory` — a pattern constrains a
 * value that is PRESENT; requiring one is `requiredNonBlank`'s job.
 */
function trimmedPattern(regex: RegExp): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const trimmed = String(control.value ?? '').trim();
    if (trimmed === '' || regex.test(trimmed)) {
      return null;
    }
    return { pattern: true };
  };
}

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
 *
 * STATE LIVES ON A `FormGroup`, rebuilt per contract. Angular's reactive
 * forms already track value, touched and validity per control and re-validate
 * on every keystroke, so the draft map, touched set and recorded-error set
 * this component once kept by hand are gone. The display rule is the
 * framework's own idiom: an error shows when `invalid && touched` — touched
 * is set by the first blur, so a user is never told they are wrong before
 * they have finished saying it, and from then on the message tracks every
 * keystroke and clears on the one that fixes it.
 */
@Component({
  selector: 'app-team-metadata-modal',
  imports: [CommonModule, ReactiveFormsModule, DialogModule, ButtonModule, InputTextModule],
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
   * One `FormControl` per declared field, keyed by `field.key`, rebuilt by
   * `resetDraft`. Seeded to `''` so every input has a home; those seeds never
   * reach the emitted map — `onConfirm` assigns a key only when its trimmed
   * value is non-empty, because for an indexed field the difference between
   * an absent key and `''` is the difference between no index entry and one
   * reading `"key|"`.
   */
  form = new FormGroup<Record<string, FormControl<string>>>({});

  /**
   * Re-seeds the draft whenever the contract changes OR the dialog opens, and
   * mirrors `pending` onto the form's disabled state.
   *
   * Both reseed triggers are load-bearing. Cancelling and reopening on the
   * SAME contract object fires no `contract` change, so without the `visible`
   * trigger the previous answers would still be sitting in the inputs;
   * switching to a different namespace without re-seeding would carry a stale
   * key into the next emission.
   *
   * `pending` disables through the form rather than a `[disabled]` binding —
   * the reactive-forms way, and the reason `onConfirm` reads `getRawValue()`:
   * a disabled control is excluded from `value`.
   */
  ngOnChanges(changes: SimpleChanges): void {
    const opened = changes['visible'] !== undefined && this.visible;
    if (changes['contract'] !== undefined || opened) {
      this.resetDraft();
    }
    if (this.pending) {
      this.form.disable({ emitEvent: false });
    } else if (this.form.disabled) {
      this.form.enable({ emitEvent: false });
    }
  }

  /** The declared fields, in declaration order — the server never sorts. */
  get fields(): MetadataFieldDescriptor[] {
    return this.contract?.fields ?? [];
  }

  /**
   * `description`, falling back to `key` so a label is never blank.
   *
   * A description is rendered VERBATIM — the model author wrote it as a
   * sentence and its casing is theirs. Only the fallback is adjusted: a field
   * name is an identifier, lower-case by Python convention, and `note` sitting
   * under `Service tier the team runs under.` reads as a rendering bug rather
   * than as the deliberate absence of a description. Capitalising the first
   * character is the whole adjustment; the rest of the key is left alone, so a
   * name that is deliberately cased (`caseRef`, `HTTPProxy`) is not mangled.
   */
  labelFor(field: MetadataFieldDescriptor): string {
    if (field.description) {
      return field.description;
    }
    return field.key.charAt(0).toUpperCase() + field.key.slice(1);
  }

  /**
   * Confirmation is blocked by a blank MANDATORY field or by a VISIBLE
   * pattern failure. `index` gates nothing, and a contract whose fields are
   * all optional and all match confirms with nothing typed (emitting `{}`,
   * which the API service then drops).
   *
   * A pattern failure counts only once the field is `touched`: an invalid
   * value nobody has finished typing must not silently disable the button —
   * `onConfirm` marks everything touched, so clicking Create surfaces it
   * instead.
   */
  get canConfirm(): boolean {
    return this.fields.every((field) => {
      const control = this.form.get(field.key);
      if (control === null) {
        return true;
      }
      if (control.hasError('required')) {
        return false;
      }
      return !(control.hasError('pattern') && control.touched);
    });
  }

  /**
   * The labels of the mandatory fields still blank. Rendered next to the
   * disabled confirm button: a disabled button fires no mouse events, so the
   * reason cannot live in a tooltip on the button itself.
   */
  get missingMandatoryLabels(): string[] {
    return this.fields
      .filter((field) => this.form.get(field.key)?.hasError('required') ?? false)
      .map((field) => this.labelFor(field));
  }

  /**
   * The `*ngIf` predicate for a field's message — the framework's own display
   * idiom, `invalid && touched`. Validity recomputes on every keystroke;
   * `touched` arrives with the first blur (or with `onConfirm`'s
   * `markAllAsTouched`), so the message never appears before the user has
   * finished the value once, and tracks every keystroke after.
   */
  showsPatternError(field: MetadataFieldDescriptor): boolean {
    const control = this.form.get(field.key);
    return control !== null && control.hasError('pattern') && control.touched;
  }

  /**
   * What the user reads: the constraint they violated.
   *
   * This shows the pattern, having previously shown the `description` instead
   * on the reasoning that a regex is not an error message. That was wrong, and
   * the output proved it: a description states a field's MEANING, never its
   * SHAPE, so `expected ${description}` rendered
   * `tenant: expected Slug of the tenant the team belongs to.` — ungrammatical,
   * and it told the user nothing about why their value was rejected. There is
   * no third source: if the pattern is withheld, the required format is not
   * discoverable from this form at all.
   *
   * The field is NOT named here. This message renders directly beneath its own
   * labelled input, so a `key:` prefix repeated the identification the label
   * already carries — and repeated it in the raw identifier form the label
   * deliberately avoids.
   */
  patternMessageFor(field: MetadataFieldDescriptor): string {
    return field.pattern
      ? `Must match ${field.pattern}`
      : 'Value is not in the expected format';
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
    if (this.showsPatternError(field)) {
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
   * `markAllAsTouched` is the confirm-time sweep: a value that was never
   * blurred — the last field a keyboard user fills — has never had its message
   * shown. Marking it touched renders the message and disables the button the
   * click was made on, exactly as the hand-rolled `validateAll` used to.
   *
   * Does NOT close the dialog: the host owns visibility, and on a rejected
   * create the modal must stay open with the input intact.
   */
  onConfirm(): void {
    if (!this.canConfirm) {
      return;
    }
    this.form.markAllAsTouched();
    if (this.fields.some((field) => this.form.get(field.key)?.hasError('pattern') ?? false)) {
      return;
    }
    const raw = this.form.getRawValue();
    const out: Record<string, string> = {};
    for (const field of this.fields) {
      const value = (raw[field.key] ?? '').trim();
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

  /**
   * Rebuilds the form for the current contract: one non-nullable control per
   * field, its validators fixed at build time. A pattern that will not
   * compile contributes NO validator — the field simply has no client-side
   * check — and the compile is attempted once here, never on a keystroke.
   *
   * A fresh group also discards touched state and recorded errors wholesale:
   * a reopened dialog has been touched by nobody, and a stale failure would
   * show a message for an input that is now empty while blocking a modal
   * nobody has typed into.
   */
  private resetDraft(): void {
    const controls: Record<string, FormControl<string>> = {};
    for (const field of this.fields) {
      const validators: ValidatorFn[] = [];
      if (field.mandatory) {
        validators.push(requiredNonBlank);
      }
      if (field.pattern) {
        const regex = safeRegExp(field.pattern);
        if (regex !== null) {
          validators.push(trimmedPattern(regex));
        }
      }
      controls[field.key] = new FormControl('', { nonNullable: true, validators });
    }
    this.form = new FormGroup(controls);
    if (this.pending) {
      this.form.disable({ emitEvent: false });
    }
  }
}
