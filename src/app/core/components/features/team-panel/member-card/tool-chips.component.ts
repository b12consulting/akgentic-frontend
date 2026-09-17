import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/**
 * The tools the team has, as a row of chips.
 *
 * A tool actor is not a colleague — it does not speak, it cannot be opened, and
 * listing it among the members would invite a click that has nowhere to go. So
 * it gets a chip: smaller than a card, and pill-shaped rather than rounded-
 * rectangular, which is the same distinction the transcript makes between a
 * turn and a tool step.
 *
 * The section disappears entirely when there are no tools. A header over an
 * empty row is a promise the pane cannot keep.
 */
@Component({
  selector: 'app-tool-chips',
  standalone: true,
  imports: [TranslatePipe],
  templateUrl: './tool-chips.component.html',
  styleUrl: './tool-chips.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolChipsComponent {
  /** Display labels, already stripped of the '#' marker and de-duped by
   *  `buildInspectorTeam`. */
  @Input({ required: true }) tools!: readonly string[];
}
