import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/**
 * An empty pane, as ONE shape.
 *
 * A pane can be empty for a different reason each time — nothing selected, no
 * messages yet, nothing started — and each reason wants its own sentence. What
 * none of them wants is its own layout: three panes that centre a glyph and a
 * sentence at three different sizes read as three unfinished screens rather
 * than one quiet one.
 *
 * Copy comes in as KEYS, not text, so a caller can supply the sentence without
 * this component owning a dictionary of them. `blurbKey` is optional because
 * some states are self-evident from the title and a second line of reassurance
 * is then just noise.
 */
@Component({
  selector: 'app-empty-state',
  standalone: true,
  imports: [TranslatePipe],
  templateUrl: './empty-state.component.html',
  styleUrl: './empty-state.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmptyStateComponent {
  /** i18n key for the headline. Required: an empty state with no sentence is
   *  indistinguishable from a pane that failed to render. */
  @Input({ required: true }) titleKey!: string;

  /** i18n key for the supporting line, or `null` to omit the ELEMENT entirely —
   *  not to render it empty. An empty element keeps its margin and leaves a
   *  hole under the title. */
  @Input() blurbKey: string | null = null;
}
