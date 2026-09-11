import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  Input,
  signal,
} from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { map, Observable } from 'rxjs';

import {
  clampRailWidth,
  RAIL_DEFAULT_WIDTH_PX,
  railBounds,
  railPercentOf,
  railWidthFromPercent,
} from '../../core/ui/pane-layout';
import { PaneLayoutService } from '../../core/ui/pane-layout.service';
import { SplitDividerComponent } from '../../shared/components/split-divider/split-divider.component';
import { ConsoleRailComponent } from './rail/console-rail.component';

/**
 * The console's outer frame (Epic 56).
 *
 * It is one flex row: the team rail, the boundary you can drag, then everything
 * else. It learns nothing about which route is open.
 *
 * WHY THE SPLIT IS HERE AND NOT WHERE THE MOCK DRAWS IT. The design shows
 * rail | conversation | inspector as three siblings. They cannot be siblings in
 * this app: the inspector reads `GraphDataService`, `TokenUsageSelector`,
 * `AgentsByIdService` and `MessageLogService`, all of which are
 * component-scoped on `ProcessComponent.providers` — the ordered array that is
 * the only thing stopping one team's state leaking into the next after a team
 * switch. An inspector mounted out here would resolve none of them and would
 * throw `NullInjectorError` on first render. So the shell splits at a different
 * seam than the picture does: the rail is out here, where it survives
 * navigation, and the conversation + inspector row is assembled INSIDE
 * `ProcessComponent`, inside that injector. The result is visually identical
 * and the provider contract is untouched.
 *
 * THE SAME SEAM DECIDES WHICH BOUNDARY LIVES WHERE (W8b). There are two, and
 * each one has to sit in the flex row whose items it separates: the
 * conversation/inspector divider is bound in `process.component.html`, and the
 * rail's is bound here, because the rail is a flex item of THIS row and of no
 * other. That is the only thing the two have separately — the component
 * (`app-split-divider`), the preference object, the storage key and the
 * two-channel write contract are all shared. A second divider implementation,
 * or a second key, would be two answers to "how wide are the panes" that
 * nothing keeps in agreement.
 *
 * SO THIS COMPONENT IS NO LONGER STATELESS, and the state it holds is
 * specifically the one thing no pure module can: HOW WIDE THIS ROW IS. The
 * rail's width is a preference in pixels; the divider speaks percentages of a
 * measured element; the conversion between them needs a number only the DOM
 * has. `PaneLayoutService` deliberately does not take that measurement — it
 * already holds a different row's width for the inspector, and one field
 * holding whichever of two unrelated rows reported last is a bug with no
 * symptom until a bound comes out wrong.
 *
 * `chromeVisible` rather than an injected `AuthService`: whether the frame is
 * furnished is a decision about the ROUTE (login renders bare), and the host
 * already holds both halves of it — the session and the deployment's
 * `hideLogin`. A shell that recomputed it would be a second place for the
 * answer to live, and the two would eventually disagree.
 */
@Component({
  selector: 'app-console-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, ConsoleRailComponent, SplitDividerComponent],
  templateUrl: './console-shell.component.html',
  styleUrl: './console-shell.component.scss',
})
export class ConsoleShellComponent implements AfterViewInit {
  private readonly layout = inject(PaneLayoutService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly translate = inject(TranslateService);

  /**
   * Show the app chrome (currently: the team rail).
   *
   * Defaults to FALSE. An unbound shell renders the bare page, which is the
   * safe failure: a login screen that briefly shows the signed-out user a rail
   * full of somebody's teams is a leak, whereas a missed rail is a missing
   * affordance.
   */
  @Input() chromeVisible = false;

  /**
   * The element the rail's share is measured against — this component's own
   * host, which is the flex row the rail is an item of.
   *
   * Passed to the divider rather than discovered by it, for the reason stated
   * in `split-divider.component.ts`: a divider that reached for
   * `parentElement` would start measuring the wrong box the day someone
   * wrapped either side of it.
   */
  readonly hostEl: HTMLElement = inject(ElementRef<HTMLElement>).nativeElement;

  /**
   * The measured width of this row, or `null` until something has measured it.
   *
   * `null` IS RENDERED AS "NO DIVIDER", not as a guess. Every percentage the
   * divider would be handed is a ratio against this number, so a drag started
   * before the first layout would be a drag against an invented row — it would
   * move, and it would move to the wrong place. A boundary that appears one
   * frame late is not a defect anybody can see; one that is wrong for that
   * frame writes a width the user never chose.
   */
  private readonly trackWidth = signal<number | null>(null);

  /**
   * The RAIL separator's accessible name.
   *
   * Its OWN key, not the one the conversation/inspector divider carries. There
   * are two splitters on this screen now, and a screen-reader user meeting
   * "Pane width" twice cannot tell which one the focus is on — which is the
   * whole value the name was supposed to add.
   *
   * A STREAM AND AN ASYNC PIPE, not `TranslatePipe`. Two specs outside this
   * component's own suite — `app.component.spec.ts` and this file's — mount the
   * shell with its imports overridden down to `CommonModule` so that the rail
   * is stubbed, and a `| translate` in the template would stop compiling in
   * both. `stream` also re-emits on a language change, which `instant` would
   * not.
   */
  readonly dividerLabel$: Observable<string> = this.translate
    .stream('console.railWidthLabel')
    .pipe(map((value) => String(value)));

  /**
   * A drag is in progress, so the rail must not animate its own width.
   *
   * The rail carries `transition: width` for the collapse gesture, which is the
   * right behaviour for a toggle and exactly wrong for a drag: the pane would
   * trail the pointer by the transition's duration and never quite arrive. Same
   * bargain, and the same class name, as the inspector's `.resizing`.
   */
  railResizing = false;

  /**
   * The rail's boundary exists only when there is a rail and a measured row.
   *
   * COLLAPSE IS NOT ASKED ABOUT HERE, and that is deliberate rather than an
   * omission. A collapsed rail must have no draggable edge — with the pane
   * pinned at zero a drag moves nothing on screen and would still rewrite the
   * stored width — but the answer already exists on the element next door, as
   * the `.collapsed` class the rail puts on its own host, and the stylesheet
   * takes it from there with an adjacent-sibling rule. `display: none` is the
   * same guarantee as `*ngIf` for this purpose: no hit area, no tab stop, no
   * pointer events, no drag.
   *
   * The alternative — subscribing to `ViewService.isRailCollapsed$` here —
   * would make the shell an observer of pane state, which is the one thing
   * `app.component.spec.ts` pins the frame NOT to be: a subscription up here
   * is invisible until it wakes the app on every change. One CSS rule buys the
   * same behaviour with no subscription at all.
   */
  get railDividerVisible(): boolean {
    return this.chromeVisible && this.trackWidth() !== null;
  }

  /**
   * The width the rail is actually drawn at: the stored preference, capped to
   * what fits in the row as measured.
   *
   * THE CAP IS APPLIED HERE AND NOT IN THE STORE. A window too narrow for the
   * preference borrows the difference and gives it back when it grows; a cap
   * written through to storage would mean that opening the console once on a
   * small screen permanently narrows a rail widened on a large one.
   */
  get railWidthCss(): string {
    // Straight from the preference, NOT via `railPercent`. A round trip
    // through the divider's frame would quantise to a tenth of the row — a
    // pixel and a half on a 1440px window — so the rail would settle a pixel
    // or two away from where it was dropped, every time.
    return `${clampRailWidth(this.layout.railWidth(), this.trackWidth())}px`;
  }

  /** The same width in the only frame `app-split-divider` understands. */
  get railPercent(): number {
    return railPercentOf(this.layout.railWidth(), this.trackWidth());
  }

  get railMinPercent(): number {
    return railBounds(this.trackWidth()).min;
  }

  get railMaxPercent(): number {
    return railBounds(this.trackWidth()).max;
  }

  /** What a double-click restores: the rail's designed width, not a bound. */
  get railDefaultPercent(): number {
    return railPercentOf(RAIL_DEFAULT_WIDTH_PX, this.trackWidth());
  }

  /**
   * Measure once now, and again whenever the row changes size.
   *
   * A RESIZE OBSERVER RATHER THAN A WINDOW LISTENER, because this row is not
   * always the window: it is the window minus whatever chrome the deployment
   * puts around it, and the iframe this app is embedded in resizes without the
   * window ever firing anything.
   */
  ngAfterViewInit(): void {
    this.measure();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => this.measure());
    observer.observe(this.hostEl);
    this.destroyRef.onDestroy(() => observer.disconnect());
  }

  private measure(): void {
    const width = this.hostEl.getBoundingClientRect().width;
    this.trackWidth.set(Number.isFinite(width) && width > 0 ? width : null);
  }

  /** The pointer moved. Lay out; store nothing. */
  onRailPercent(percent: number): void {
    this.railResizing = true;
    this.layout.setRailWidth(railWidthFromPercent(percent, this.trackWidth()));
  }

  /** The drag ended, or one key was pressed. Settled, so it persists. */
  onRailCommit(percent: number): void {
    this.railResizing = false;
    this.layout.commitRailWidth(railWidthFromPercent(percent, this.trackWidth()));
  }
}
