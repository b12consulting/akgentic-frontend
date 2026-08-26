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
import { InputTextModule } from 'primeng/inputtext';
import { ToggleSwitchModule } from 'primeng/toggleswitch';

import {
  metadataKeyLabel,
  NO_TEAM_FILTER,
  TeamFilter,
} from '../../../core/context/team.interface';
import { MIN_FILTER_TERM_LENGTH } from '../../../core/http/api.service';
import {
  MetadataFieldDescriptor,
  NamespaceSummary,
} from '../../../protocol/catalog.interface';

/**
 * The teams-list filter form.
 *
 * Owns the QUESTION — which fields are offered, what is typed into them, and
 * what filter that adds up to. It owns nothing about the answer: no service, no
 * router, no page number, no fetch. Those belong to the page that hosts it,
 * which is why this component can be tested by setting two inputs and reading
 * one output.
 *
 * The split matters beyond tidiness. Composing the filter used to live beside
 * the code that mirrored it into the URL, and the two derived it from different
 * places — the form here, the service there — which is precisely how a URL
 * written during the form's loading window came out blank.
 */
@Component({
  selector: 'app-team-filter',
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    InputTextModule,
    ToggleSwitchModule,
  ],
  templateUrl: './team-filter.component.html',
  styleUrl: './team-filter.component.scss',
})
export class TeamFilterComponent implements OnChanges {
  /**
   * The team type whose contract decides which fields are offered, and what
   * "this team type only" narrows to.
   */
  @Input() namespace: NamespaceSummary | null = null;

  /**
   * A filter to ADOPT, rather than one this form produced — the restore path.
   *
   * Adopting never emits: the value came from outside, so echoing it back
   * would be this component answering its own question.
   */
  @Input() value: TeamFilter = NO_TEAM_FILTER;

  /** The user changed the filter. Never fired for an adopted `value`. */
  @Output() changed = new EventEmitter<TeamFilter>();

  /**
   * The offered fields, in the contract's declaration order.
   *
   * A FIELD recomputed on change, never a getter: a getter would hand `NgForOf`
   * a fresh array every cycle and rebuild the inputs mid-keystroke, taking
   * focus and the caret with them.
   */
  fields: MetadataFieldDescriptor[] = [];

  /** What is typed into each input, keyed by field key. Raw, unfloored. */
  terms: Record<string, string> = {};

  /** The narrowing toggle. */
  narrowToNamespace = false;

  /** Whether the form is on screen. The host renders the control that flips it. */
  @Input() visible = false;

  readonly minTermLength = MIN_FILTER_TERM_LENGTH;

  /**
   * Labels an input by its KEY, humanised the same way the table's metadata
   * chips humanise it, so a chip and the input that filters on it read the same
   * word. The declared description is a sentence written for the creation form;
   * it goes in the input's title instead.
   */
  metadataKeyLabel = metadataKeyLabel;

  /** `trackBy` for the inputs — the field key is their identity. */
  trackField = (_index: number, field: MetadataFieldDescriptor): string =>
    field.key;

  /**
   * Two rules, in this order, and the order is the whole subtlety.
   *
   * An adopted `value` WINS over a namespace change in the same cycle: on a
   * restore both arrive together, and the terms belong to the type that came
   * with them.
   *
   * A namespace change otherwise clears the terms, because they belong to the
   * contract being left — but only when there WAS one. Arriving at the first
   * real selection is not a change of mind, and treating it as one is what
   * would wipe a restored filter the moment the namespace list resolved.
   */
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['namespace']) {
      this.fields = this.offeredFields();
    }

    if (changes['value']) {
      this.adopt(this.value);
      return;
    }

    const change = changes['namespace'];
    if (change === undefined) {
      return;
    }

    if (change.previousValue != null) {
      // A real change of type: the terms belong to the contract being left.
      this.terms = {};
      this.emit();
      return;
    }

    // The FIRST real selection. Terms present here were restored and belong to
    // it, so nothing is cleared — but the narrowing toggle must still be
    // honoured: flipped on before a type existed, it composed `null`, and
    // without this the switch would read ON above a list nothing had narrowed.
    if (this.narrowToNamespace) {
      this.emit();
    }
  }

  /** A metadata input changed. */
  onTermChanged(key: string, term: string): void {
    this.terms[key] = term;
    this.emit();
  }

  /** The narrowing toggle was flipped. */
  onNarrowToggle(value: boolean): void {
    this.narrowToNamespace = value;
    this.emit();
  }

  /**
   * Is anything here actually narrowing the list?
   *
   * Reads the composed filter rather than the raw terms, so it applies the same
   * floor the request does. A one- or two-character term contributes nothing to
   * the request, and reporting it as active would be its own small lie.
   */
  get isNarrowing(): boolean {
    const filter = this.compose();
    return (
      Object.keys(filter.meta).length > 0 || filter.catalogNamespace !== null
    );
  }

  /**
   * Clear everything this form owns, in one action.
   *
   * Goes through the same path a keystroke does, so the reset fetches, resets
   * the page and rewrites the URL exactly as any other change would. A reset
   * that wrote its state directly would be a second way to change the filter,
   * and the two would drift.
   */
  reset(): void {
    if (!this.isNarrowing) {
      return;
    }
    this.terms = {};
    this.narrowToNamespace = false;
    this.emit();
  }

  /**
   * The filter this form currently expresses.
   *
   * The floor is applied HERE, so a term too short to narrow anything never
   * reaches the filter at all. Every consumer downstream — the request, the
   * URL, the "is anything filtered" question — then agrees by construction,
   * instead of each applying the rule and one of them forgetting.
   *
   * The raw `terms` keep the short value, because the user typed it and the
   * input must go on showing it.
   */
  private compose(): TeamFilter {
    const meta: Record<string, string> = {};
    for (const field of this.fields) {
      const term = (this.terms[field.key] ?? '').trim();
      if (term.length >= this.minTermLength) {
        meta[field.key] = term;
      }
    }
    return {
      meta,
      catalogNamespace: this.narrowToNamespace
        ? (this.namespace?.namespace ?? null)
        : null,
    };
  }

  private emit(): void {
    this.changed.emit(this.compose());
  }

  /** Adopt a filter from outside, without answering back. */
  private adopt(filter: TeamFilter): void {
    this.terms = { ...filter.meta };
    this.narrowToNamespace = filter.catalogNamespace !== null;
  }

  /**
   * Only fields the contract marks `index: true`.
   *
   * A filter on any other key returns an empty page with no error, which is
   * indistinguishable from "no team matches" — so an unindexed field is never
   * offered. `index` and `mandatory` are unrelated: a mandatory field need not
   * be indexed, and reusing the creation form's rule would offer the wrong set.
   */
  private offeredFields(): MetadataFieldDescriptor[] {
    const contract = this.namespace?.team_metadata;
    // Falsiness, not `=== null`: a server predating the field omits the key
    // entirely, and even a current server's OpenAPI leaves it out of `required`
    // so a generated client types it possibly-undefined. A declared contract
    // with an empty `fields` list is the third no-ask state and collapses here
    // too.
    if (!contract || contract.fields.length === 0) {
      return [];
    }
    return contract.fields.filter((f) => f.index);
  }
}
