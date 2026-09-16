import { AsyncPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { map, Observable } from 'rxjs';

import { TranslatePipe } from '@ngx-translate/core';

import { ContextService } from '../../../core/platform/context/context.service';
import { TeamMetadataPipe } from '../../../core/platform/context/team-metadata.pipe';
import { ViewService } from '../view.service';
import { IconButtonComponent } from '../../../components/common/icon-button/icon-button.component';

/**
 * The conversation's own title bar (Epic: console redesign, B3).
 *
 * It replaces the p-menubar's left half — the team name, its run state, Clear
 * and Details — and it lives INSIDE `ProcessComponent` rather than in the app
 * shell. That placement is not cosmetic: the redesign's third pane, the
 * inspector, can only resolve `ProcessComponent`'s component-scoped providers
 * from inside that injector, so the header sits beside it rather than above it.
 *
 * NO INPUTS AND NO OUTPUTS, deliberately. Everything it renders comes from
 * root-scoped state (`ContextService`, `ViewService`), so the entire contract
 * with its host is the selector. That is what lets `ProcessComponent` reference
 * `<app-conversation-header>` without either side knowing anything else about
 * the other, and it is why this seam needed no handshake beyond the tag.
 *
 * IT CARRIES THE TEAM'S BUSINESS METADATA, beside the name, as the menubar it
 * replaces did. An earlier pass dropped the chips on the stated grounds that
 * they had moved to the inspector's Team tab — they had not, and that is worth
 * recording rather than quietly correcting: `buildInspectorTeam` derives the
 * roster, the tool list and the spend from `nodes$`, and never reads `metadata`
 * at all, so the facts were not relocated, they were deleted, and the comment
 * that said otherwise sent a reader looking for a feature that did not exist.
 *
 * They belong here rather than in a pane. In this product a team is usually
 * opened FOR something — a case id, a tenant, a payroll run — so "am I in the
 * right conversation?" is a question asked on arrival and answered by the
 * header. An answer one click into a collapsible pane is an answer to a
 * different question.
 */
@Component({
  selector: 'app-conversation-header',
  imports: [AsyncPipe, TranslatePipe, IconButtonComponent, TeamMetadataPipe],
  templateUrl: './conversation-header.component.html',
  styleUrl: './conversation-header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConversationHeaderComponent {
  readonly contextService: ContextService = inject(ContextService);
  readonly viewService: ViewService = inject(ViewService);

  /**
   * Is a team open at all?
   *
   * READ ONLY off `currentProcessId$` — `ProcessComponent` is that subject's
   * single writer, and the redesign keeps it that way (a header that blanked
   * the id when it lost its team would fight the component that owns it).
   * `''` is the closed state, so this is the one place that spelling is
   * interpreted; the template asks for a boolean.
   */
  readonly teamOpen$: Observable<boolean> = this.contextService.currentProcessId$.pipe(
    map((processId) => processId !== ''),
  );

  /**
   * The inspector's state as a control reads it, not as it is stored.
   *
   * `ViewService` stores COLLAPSED because that is what the pane binds to; a
   * button labelled "Details" is pressed when the pane is OPEN. Inverting once
   * here keeps every binding in the template positive — `aria-expanded`, the
   * pressed background, and the label key all read the same way round, which is
   * the shape that stops one of the three drifting out of step with the others.
   */
  readonly inspectorOpen$: Observable<boolean> =
    this.viewService.isRightColumnCollapsed$.pipe(map((collapsed) => !collapsed));

  /**
   * Discard the open team and go back to the list.
   *
   * The id is read at click time rather than bound, so the handler cannot act
   * on a team that stopped being the open one between render and click. Not
   * awaited: `clear()` ends in a navigation, and there is nothing left here to
   * do with its completion — the same posture the menubar's Clear item had.
   */
  clear(): void {
    void this.contextService.clear(this.contextService.currentProcessId$.value);
  }
}
