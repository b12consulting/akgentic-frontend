import { AsyncPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { Observable } from 'rxjs';

import {
  ModelTokenTotals,
  TeamTokenTotals,
  TokenUsageSelector,
} from '../../../../features/process/selectors/token-usage.selector';
import { TokenCountPipe } from '../../../../shared/pipes/token-count.pipe';

/**
 * What this team has spent, in three numbers.
 *
 * BARE `inject`, never a local `providers` entry: `TokenUsageSelector` is
 * component-scoped on `ProcessComponent` and re-providing it here would create
 * a SECOND selector over an empty store, so the panel would sit at zero while
 * the transcript ran. The shared-instance expectation is pinned in this
 * component's own spec (it used to be pinned by `tree.component.spec.ts`, which
 * went with the tree).
 *
 * `totalCacheWrite` is on `TeamTokenTotals` and is DELIBERATELY not shown:
 * OpenAI reports cache READS only, so the write figure is structurally zero and
 * a permanently-zero row reads as a bug in the meter rather than an absence in
 * the data.
 *
 * `teamByModel$` — the per-model breakdown — DOES live here now. It used to
 * hang off the team tree's footer as a popover, and the tree is gone from the
 * hierarchy tab (W6: that tab is the graph and nothing else), so this card was
 * the only remaining surface that answers "where is the spend going". Moving it
 * rather than deleting it is the point: the three totals above say how much, and
 * only this says what it was spent on.
 *
 * There is no null guard. `teamTotals$` sums an empty map to zeros and is never
 * undefined, so all-zero IS the empty state and a "no data yet" branch would be
 * a second way of saying nothing has happened.
 */
@Component({
  selector: 'app-usage-panel',
  standalone: true,
  imports: [AsyncPipe, TranslatePipe, TokenCountPipe],
  templateUrl: './usage-panel.component.html',
  styleUrl: './usage-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UsagePanelComponent {
  private readonly tokenUsage = inject(TokenUsageSelector);

  readonly totals$: Observable<TeamTokenTotals> = this.tokenUsage.teamTotals$;

  /**
   * One entry per model the team has actually run, sorted by spend. Empty for a
   * team that has not run one yet — the template omits the whole block in that
   * case rather than drawing a rule under nothing.
   */
  readonly byModel$: Observable<ModelTokenTotals[]> =
    this.tokenUsage.teamByModel$;
}
