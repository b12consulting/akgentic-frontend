import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

import { InspectorMember } from '../../../../services/console/inspector/team-panel/team-members.selector';

/**
 * One member of the team, as a row in the inspector.
 *
 * A BUTTON, not a div. The mock draws these cards as inert `<div>`s even though
 * the inspector has a Member tab whose entire purpose is to show one member in
 * detail — so the card is the obvious way in and the prototype leaves it
 * unwired and unreachable from the keyboard. The row emits its agent_id and
 * lets whoever mounts the panel decide what "select" means.
 *
 * ONE OUTPUT, one destination: `selected` means "show this member in the
 * Member tab", as it has since Epic 56. The card decides nothing about what
 * that means — the host routes it.
 *
 * Everything rendered here is pre-derived by `buildInspectorTeam`: the label,
 * the monogram, the role KEY and the depth. The card decides nothing about who
 * a member is, which is what keeps this list and the team graph in agreement.
 */
@Component({
  selector: 'app-member-card',
  standalone: true,
  imports: [TranslatePipe],
  templateUrl: './member-card.component.html',
  styleUrl: './member-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MemberCardComponent {
  @Input({ required: true }) member!: InspectorMember;

  /** Emits the member's agent_id. The card was activated. */
  @Output() selected = new EventEmitter<string>();

  onSelect(): void {
    this.selected.emit(this.member.id);
  }
}
