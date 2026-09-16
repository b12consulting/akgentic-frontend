import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

import { InspectorMember } from '../../../../core/services/console/inspector/team-panel/team-members.selector';
import { IconButtonComponent } from '../../../common/icon-button/icon-button.component';

/**
 * One member of the team, as a row in the inspector.
 *
 * A BUTTON, not a div. The mock draws these cards as inert `<div>`s even though
 * the inspector has a Member tab whose entire purpose is to show one member in
 * detail — so the card is the obvious way in and the prototype leaves it
 * unwired and unreachable from the keyboard. The row emits its agent_id and
 * lets whoever mounts the panel decide what "select" means.
 *
 * TWO OUTPUTS, because there are two destinations. `selected` is the row: it
 * has meant "show this member in the Member tab" since Epic 56 and still does.
 * `readRequested` is the trailing action: it means "open this member's
 * conversation", which is a dialog over everything. They are separate controls
 * rather than one click doing both, because doing both switches the tab behind
 * the dialog and strands the user there the moment they dismiss it.
 *
 * Both emit an agent_id and neither decides what happens next — the card is
 * still the wrong place to know which tab strip it is in, or which dialog is
 * mounted where.
 *
 * Everything rendered here is pre-derived by `buildInspectorTeam`: the label,
 * the monogram, the role KEY and the depth. The card decides nothing about who
 * a member is, which is what keeps this list and the team graph in agreement.
 */
@Component({
  selector: 'app-member-card',
  standalone: true,
  imports: [TranslatePipe, IconButtonComponent],
  templateUrl: './member-card.component.html',
  styleUrl: './member-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MemberCardComponent {
  @Input({ required: true }) member!: InspectorMember;

  /** Emits the member's agent_id. The row was activated. */
  @Output() selected = new EventEmitter<string>();

  /** Emits the member's agent_id. The trailing "read the conversation" action
   *  was activated. Separate from `selected` so a host can route them to two
   *  different places — which is the only reason the second control exists. */
  @Output() readRequested = new EventEmitter<string>();

  onSelect(): void {
    this.selected.emit(this.member.id);
  }

  onRead(): void {
    this.readRequested.emit(this.member.id);
  }
}
