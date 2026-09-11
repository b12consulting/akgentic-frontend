import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  HostBinding,
  inject,
  Input,
  Output,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslatePipe } from '@ngx-translate/core';

import { InspectorSide } from '../../../core/ui/pane-layout';
import { ViewService } from '../../../core/ui/view.service';
import { IconButtonComponent } from '../../../shared/components/icon-button/icon-button.component';
import {
  InspectorTabsComponent,
  VisualizationOption,
} from './inspector-tabs.component';

// Re-exported so a consumer that renders `<app-console-inspector>` has one
// import to make. `export type` rather than a bare re-export: `isolatedModules`
// is on, and a value-shaped re-export of an interface is erased to nothing at
// emit time, which fails at runtime rather than at compile time.
export type { VisualizationOption };

/**
 * The console's third pane (Epic 56): a title, a tab strip, and whatever the
 * host projects under it.
 *
 * It is a FRAME, not a container of panels. The five visualisation panels stay
 * in `ProcessComponent`'s template and arrive through `<ng-content>`, for one
 * reason that is not stylistic: every one of them reads a service that is
 * component-scoped on `ProcessComponent.providers` (`GraphDataService`,
 * `TokenUsageSelector`, `AgentsByIdService`, `MessageLogService`). Declared in
 * here they would resolve against this component's injector, find nothing, and
 * throw. Projected, they keep the host's injector and the ordered provider
 * array that stops one team's state reaching the next stays untouched.
 *
 * The consequence to remember when reading the stylesheet: projected nodes
 * carry the HOST's style-encapsulation attribute, so the rules that stack the
 * panels live in `process.component.scss`, not here.
 */
@Component({
  selector: 'app-console-inspector',
  imports: [TranslatePipe, IconButtonComponent, InspectorTabsComponent],
  templateUrl: './console-inspector.component.html',
  styleUrl: './console-inspector.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConsoleInspectorComponent {
  /** The tabs to offer; see `VisualizationOption`. Passed straight through. */
  @Input({ required: true }) options!: readonly VisualizationOption[];

  /** The `value` of the panel currently showing. */
  @Input({ required: true }) mode!: string;

  @Output() modeChange = new EventEmitter<string>();

  /**
   * Which side of the conversation this pane is currently on (R3).
   *
   * Presentational only: the pane is told, it does not decide. The arrangement
   * is a root-scoped, persisted preference and the host owns reading it — a
   * pane that reached for `PaneLayoutService` itself would be a second reader
   * of a value the host is already binding, and the two would disagree for one
   * change-detection cycle every time it moved.
   *
   * Defaulted to `right`, which is where every version of this console has
   * drawn it, so an unbound host renders what it always did.
   */
  @Input() side: InspectorSide = 'right';

  /**
   * The user asked for the panes to trade places.
   *
   * An OUTPUT rather than a call into the layout service, for the same reason
   * `modeChange` is one: this component holds no arrangement of its own, and a
   * pane that wrote the preference directly would be doing something its host
   * could not intercept, reorder, or decline.
   */
  @Output() swapSides = new EventEmitter<void>();

  /**
   * The swap button's copy key, which names the DESTINATION rather than the
   * current position — "Move to the left" is what pressing it does.
   *
   * Derived here rather than in the template so the inversion is stated once:
   * a pane on the right moves LEFT, and a conditional written inline invites
   * the next person to get that backwards in the `title`, the `aria-label`, or
   * the glyph's mirror independently of the other two.
   */
  get swapLabelKey(): string {
    return this.side === 'right' ? 'inspector.moveLeft' : 'inspector.moveRight';
  }

  /**
   * Public because the template calls `toggleRightColumn()` on it.
   *
   * Root-scoped on purpose: the same state has two controls by design — the
   * conversation header's Details button and this pane's own close X — and a
   * pane that owned its own flag would have to be told about the other one.
   */
  readonly viewService: ViewService = inject(ViewService);

  private readonly collapsed = toSignal(this.viewService.isRightColumnCollapsed$, {
    initialValue: false,
  });

  /**
   * Collapse is expressed as a class on the HOST rather than as a rule on the
   * inner `<aside>`, because the host is the flex item: it is the element whose
   * width the row measures, so it is the only one whose width the transition
   * can animate.
   */
  @HostBinding('class.collapsed')
  get isCollapsed(): boolean {
    return this.collapsed();
  }

  /**
   * A collapsed inspector is GONE, not merely invisible — see the same pair on
   * `ConsoleRailComponent` for the full reasoning.
   *
   * It bites harder here than on the rail, because this pane holds the tab
   * strip AND the projected panels: collapsed without `inert`, a keyboard user
   * tabs through six tab buttons and then into whichever panel is active,
   * including the graph's controls and the workspace's file tree, none of which
   * are on screen. The panels' own `inert` covers the five that are off-screen
   * and says nothing about the pane being shut.
   */
  @HostBinding('attr.inert')
  get inertAttr(): '' | null {
    return this.collapsed() ? '' : null;
  }

  @HostBinding('attr.aria-hidden')
  get ariaHidden(): 'true' | null {
    return this.collapsed() ? 'true' : null;
  }
}
