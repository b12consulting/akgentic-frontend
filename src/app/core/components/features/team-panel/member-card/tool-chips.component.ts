import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

const UUID_SUFFIX = /^(.+\/)([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `Workspace/<uuid>` → `Workspace/<first uuid segment>`; any other name as
 *  it is. A chip has no room for 36 characters of id, and the first segment
 *  is already unique in a team. */
export function shortToolName(name: string): string {
  const match = UUID_SUFFIX.exec(name);
  return match === null ? name : match[1] + match[2];
}

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

  protected readonly shortToolName = shortToolName;
}
