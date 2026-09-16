import { inject, Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ConfigService } from '../platform/config/config.service';

/**
 * Which of the console's two side panes are collapsed.
 *
 * ROOT-SCOPED, and that is the whole design. Each pane has more than one
 * control — the inspector is toggled by the conversation header's Details
 * button AND by its own close X, and the rail by a control in the rail and one
 * in the header — so the state cannot live on either pane, or the two controls
 * would each own half of it. One subject per pane, as many controls as the
 * design wants, and every control reads the same answer.
 *
 * Both subjects are seeded from `ConfigService` in the constructor rather than
 * in their initialisers: the value is a deployment's decision, and a literal in
 * the initialiser would flash the framework default for one change-detection
 * cycle before the real one landed.
 */
@Injectable({
  providedIn: 'root',
})
export class ViewService {
  private config = inject(ConfigService);

  isRightColumnCollapsed$ = new BehaviorSubject<boolean>(false);

  /**
   * The team rail (Epic 56). Beside `isRightColumnCollapsed$` rather than
   * folded into one "collapsed panes" object, because they are toggled
   * independently and a shared object would wake every subscriber of one pane
   * whenever the other moved.
   */
  isRailCollapsed$ = new BehaviorSubject<boolean>(false);

  constructor() {
    this.isRightColumnCollapsed$.next(this.config.initRightPanelCollapsed);
    this.isRailCollapsed$.next(this.config.initRailCollapsed);
  }

  toggleRightColumn(): void {
    this.isRightColumnCollapsed$.next(!this.isRightColumnCollapsed$.value);
  }

  toggleRail(): void {
    this.isRailCollapsed$.next(!this.isRailCollapsed$.value);
  }
}
