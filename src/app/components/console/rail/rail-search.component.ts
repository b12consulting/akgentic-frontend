import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/**
 * The rail's search box.
 *
 * A CLIENT-SIDE FILTER OVER THE LOADED PAGE, and it has to be read that way.
 * `GET /teams` has no free-text parameter: it accepts `meta.<key>` — which
 * needs a key the namespace contract declares as indexed, and at least three
 * characters — and `catalog_namespace`. Neither can express "find the word I
 * am thinking of", so this box narrows the rows the rail already holds and
 * nothing more. That is why an empty result renders `rail.noResultsHint` and a
 * link into the management view rather than simply saying "no teams": the
 * honest answer is "not on this page", and the full list is one click away.
 *
 * Dumb by design — a value in, a value out, no service, no debounce. The
 * filtering itself lives in `railGroups`, which is pure and testable without a
 * DOM; there is no request to debounce because there is no request.
 */
@Component({
  selector: 'app-rail-search',
  imports: [TranslatePipe],
  templateUrl: './rail-search.component.html',
  styleUrl: './rail-search.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RailSearchComponent {
  /** What is in the box. One-way in; the parent owns the value. */
  @Input() value = '';

  @Output() valueChange = new EventEmitter<string>();

  /**
   * Emit on every keystroke, UNTRIMMED.
   *
   * Trimming here would make a leading space impossible to type; `railMatches`
   * normalises its own argument, so the trim happens once, where the comparison
   * is.
   */
  onInput(event: Event): void {
    this.valueChange.emit((event.target as HTMLInputElement).value);
  }
}
