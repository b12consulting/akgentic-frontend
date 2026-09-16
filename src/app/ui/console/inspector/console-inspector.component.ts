import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  EventEmitter,
  HostBinding,
  inject,
  Input,
  NgZone,
  OnDestroy,
  Output,
  signal,
  ViewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslatePipe } from '@ngx-translate/core';

import { InspectorSide } from '../pane-layout';
import { ViewService } from '../view.service';
import { IconButtonComponent } from '../../../core/components/primitives/icon-button/icon-button.component';
import { EmptyStateComponent } from '../../../core/components/primitives/empty-state/empty-state.component';
import {
  InspectorTabsComponent,
  VisualizationOption,
} from '../../../components/console/inspector/inspector-tabs.component';
import {
  INSPECTOR_NARROW_MAX_PX,
  inspectorTabNeedsRoom,
} from '../../../core/services/console/inspector/inspector-tabs.registry';

// Re-exported so a consumer that renders `<app-console-inspector>` has one
// import to make. `export type` rather than a bare re-export: `isolatedModules`
// is on, and a value-shaped re-export of an interface is erased to nothing at
// emit time, which fails at runtime rather than at compile time.
export type { VisualizationOption };

/**
 * The console's third pane (Epic 56): a title, a tab strip, and whatever the
 * host projects under it.
 *
 * It is a FRAME, not a container of panels. The panels stay in the host's
 * template and arrive through `<ng-content>`, for one reason that is not
 * stylistic and is not about injectors: this file lives in `components/`, the
 * presentational layer, and every one of those panels lives in `ui/`. The
 * boundary rule grants `components` no edge to `ui` at all, so this frame
 * CANNOT declare them — projection is the only shape available, and that is
 * what keeps the frame reusable by a console that brings its own panels.
 *
 * (The injector is not the obstacle. The team's services are provided on the
 * `process/:id` ROUTE, so anything rendered under that route resolves them
 * wherever it is declared. An earlier version of this note said a panel
 * declared here would "find nothing and throw"; that stopped being true when
 * the providers moved off `ProcessComponent`.)
 *
 * The consequence to remember when reading the stylesheet: projected nodes
 * carry the HOST's style-encapsulation attribute, so the rules that stack the
 * panels live in `process.component.scss`, not here.
 */
@Component({
  selector: 'app-console-inspector',
  imports: [
    TranslatePipe,
    IconButtonComponent,
    InspectorTabsComponent,
    EmptyStateComponent,
  ],
  templateUrl: './console-inspector.component.html',
  styleUrl: './console-inspector.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConsoleInspectorComponent implements AfterViewInit, OnDestroy {
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

  /* ---------------------------------------------------------------------- *
   * W17 — A NARROW PANE SAYS SO.
   *
   * The pane is the user's to size now: it can be dragged, the rail beside it
   * can be collapsed, and the window can be any width. That is precisely why a
   * panel that cannot work at 250px must ASK for room rather than draw an
   * unusable version of itself — a graph with every label clipped is not a
   * smaller graph, it is a picture the user cannot tell from a rendering fault.
   *
   * IT LIVES HERE, IN THE SHELL, AND NOT IN THE PANELS. Three panels need the
   * behaviour (`needsRoom` in the registry) and three do not; implemented in
   * each one it would be three ResizeObservers measuring three boxes that are
   * always the same width, three thresholds free to drift apart, and three
   * copies of the sentence. The shell already knows both facts the decision
   * needs — how wide it is, and which tab is showing — and it is the only place
   * that knows them for every panel at once.
   *
   * WHAT IT DELIBERATELY IS NOT: the Knowledge graph tab's "Expand" control.
   * That control opens a `p-dialog` declared inside `knowledge-graph.component`
   * and populated by that component's own state, so "reuse the idiom" would
   * mean every wide panel growing a modal of its own and the shell learning how
   * to open six of them. The idiom does not generalise; what generalises is the
   * pane the user can already widen, so the message names that.
   * ---------------------------------------------------------------------- */

  /**
   * The FRAME, not the body, and the difference is a feedback loop rather than
   * a preference.
   *
   * `.inspector__body` is the element the narrow state HIDES. Measuring it would
   * make the measurement depend on its own result: hide it, it reports 0px, 0px
   * is not narrow, show it again, it reports 250px, narrow — the pane would
   * oscillate for as long as the user sat in the band. The frame is never
   * hidden and is the same width, so it can be asked the question honestly.
   *
   * A `@ViewChild` rather than `inject(ElementRef)`: the host element would do
   * just as well, but injecting it puts an element dependency in the
   * constructor, and this component is constructed without one in its own
   * specs to assert its unbound defaults.
   */
  @ViewChild('inspectorFrame', { static: true })
  private frameRef?: ElementRef<HTMLElement>;

  private readonly zone: NgZone = inject(NgZone);

  /** The frame's measured width, or `null` until it has been measured once. */
  private readonly framePx = signal<number | null>(null);

  private frameObserver: ResizeObserver | null = null;

  /**
   * A ResizeObserver and not a `window:resize` listener, for the same reason
   * `ProcessComponent` watches its pane row: this pane changes width for
   * reasons the window knows nothing about — the divider being dragged, the
   * rail collapsing, the pane being closed — and each of those is exactly the
   * case the message exists for.
   *
   * Guarded rather than assumed. Every browser this app supports has
   * `ResizeObserver`; a test host might not, and the right behaviour without it
   * is "never narrow" (draw the panel, as today) rather than a view that throws
   * on mount.
   */
  ngAfterViewInit(): void {
    const frame = this.frameRef?.nativeElement;
    if (frame === undefined || typeof ResizeObserver === 'undefined') {
      return;
    }
    this.measure(frame);
    this.frameObserver = this.zone.runOutsideAngular(
      () =>
        new ResizeObserver(() => {
          // Created outside the zone (a drag emits these dozens of times a
          // second and none of them is an application event), but the WRITE is
          // back inside it. The signal alone would mark this view dirty; the
          // zone re-entry is what guarantees a pass actually runs, which is the
          // half that is easy to leave out and impossible to see in a spec that
          // calls `detectChanges()` by hand.
          this.zone.run(() => this.measure(frame));
        }),
    );
    this.frameObserver.observe(frame);
  }

  ngOnDestroy(): void {
    this.frameObserver?.disconnect();
    this.frameObserver = null;
  }

  private measure(frame: HTMLElement): void {
    this.framePx.set(frame.getBoundingClientRect().width);
  }

  /**
   * Narrow means MEASURED AND SMALL, which is three states and not two.
   *
   * `null` (never measured) is not narrow: an unmeasured pane must render its
   * panel, because the alternative is that a host without a ResizeObserver
   * shows the message for ever. Exactly `0` is not narrow either — that is a
   * pane that is SHUT, not one that is cramped, and the collapse transition
   * passes through every width on the way there.
   */
  readonly isNarrow = computed(() => {
    const width = this.framePx();
    return width !== null && width > 0 && width < INSPECTOR_NARROW_MAX_PX;
  });

  /**
   * Replace the projected panel with the "widen me" message?
   *
   * Three conditions, and the collapsed one is not redundant with `isNarrow`'s
   * `> 0`: collapsing is animated, so the pane spends ~180ms at every width
   * between its own and zero. Without this the user would see the graph swap
   * itself for a message on the way out of a pane they just closed.
   */
  get showNarrowNotice(): boolean {
    return (
      !this.isCollapsed &&
      this.isNarrow() &&
      inspectorTabNeedsRoom(this.mode)
    );
  }
}
