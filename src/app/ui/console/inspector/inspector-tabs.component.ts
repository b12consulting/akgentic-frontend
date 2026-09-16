import type { VisualizationOption } from '../../../core/services/console/inspector/inspector-tabs.registry';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  viewChildren,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/**
 * One entry in the inspector's tab strip.
 *
 * IT MOVED TO THE REGISTRY, and is re-exported here so no importer had to
 * change. The reason it was in this leaf was to keep the import graph acyclic:
 * `ProcessComponent` imports the inspector and the inspector imports these
 * tabs, so declaring it in either of those would have closed a loop, and a
 * cycle between files carrying Angular decorators works until a bundler changes
 * evaluation order.
 *
 * The registry satisfies that requirement better than this file does. It is
 * where the tab SET is already declared, it is pure data with no decorator and
 * no template, and — now that it lives under `features/` — it has no outgoing
 * edge into `components/` at all. The old arrangement had the registry
 * importing a type out of the component that renders it, which is the logic
 * tier depending on the view tier: legal only because both sat inside one
 * `boundaries` element and the edge was therefore invisible.
 */
export type { VisualizationOption } from '../../../core/services/console/inspector/inspector-tabs.registry';

/**
 * The inspector's tab strip (Epic 56).
 *
 * It replaces a `p-selectbutton`, and the replacement is not a restyle: the
 * old control announced itself as a group of buttons, so a screen reader was
 * told there were N buttons and never told which one was showing. This is a
 * real `tablist` — one `aria-selected` tab, `aria-controls` pointing at the
 * panel each one reveals, and a roving tabindex so the whole strip costs one
 * Tab stop rather than one per entry.
 *
 * The tabs are ICONS PLUS THE SELECTED TAB'S CAPTION, with the name carried on
 * every tab as `aria-label` + `title`. That is a width decision, not a style
 * one: six captions need twice the pane, none at all leaves a touch user — who
 * has no hover, and therefore no `title` — with six unnamed glyphs. The
 * arithmetic behind the one that fits is in `inspector-tabs.component.scss`.
 *
 * The mock's pills are bare `<button>`s with no role, no selected state, no
 * hover and no focus ring; only their geometry is copied here.
 *
 * STATELESS. `mode` comes in and `modeChange` goes out — the strip never
 * decides what is showing, because the thing that owns which panels EXIST
 * (`ProcessComponent`, which drops the Knowledge-graph and Workspaces entries
 * when their tools are absent, and snaps the mode back to `team` when the
 * active one disappears) also has to own which one is current. Two owners
 * would disagree exactly when a tool vanishes mid-conversation.
 */
@Component({
  selector: 'app-inspector-tabs',
  imports: [TranslatePipe],
  templateUrl: './inspector-tabs.component.html',
  styleUrl: './inspector-tabs.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InspectorTabsComponent {
  /**
   * The tabs to draw, in order. `readonly` because this component must not be
   * able to reorder or filter its host's list — that list is a derived value
   * (`visualizationOptions$`) and a mutation here would be silently discarded
   * on its next emission.
   */
  @Input({ required: true }) options!: readonly VisualizationOption[];

  /** The `value` of the tab that is currently showing. */
  @Input({ required: true }) mode!: string;

  @Output() modeChange = new EventEmitter<string>();

  /**
   * The rendered tab buttons, in `options` order, so keyboard navigation can
   * move focus as well as selection.
   *
   * Focus has to be moved imperatively: the roving tabindex only decides where
   * Tab LANDS, and an arrow key that changed the selection without moving focus
   * would leave the user's focus on a tab that is no longer selected — which is
   * precisely the state `aria-selected` says cannot happen.
   */
  private readonly tabButtons =
    viewChildren<ElementRef<HTMLButtonElement>>('tab');

  /**
   * Emitted unconditionally, including for the tab that is already current.
   *
   * Not guarded on `value !== mode`: the guard would only save a
   * `BehaviorSubject.next` with an unchanged value, and it would make Home/End
   * silently do nothing when focus is already at the end — a control that
   * sometimes does not report the user's action is harder to reason about than
   * one that reports it twice.
   */
  select(value: string): void {
    this.modeChange.emit(value);
  }

  /**
   * Arrow / Home / End move the selection, following the WAI-ARIA tabs pattern
   * for automatic activation: the strip has no expensive panels to mount (they
   * all stay mounted behind `.moved-offscreen`), so selecting on arrow rather
   * than on a separate Enter costs nothing and saves a keystroke.
   */
  onKeydown(event: KeyboardEvent): void {
    const count = this.options.length;
    if (count === 0) {
      return;
    }

    // `-1` (no match) is folded to 0 so a mode that is not in the list — the
    // instant between a tool disappearing and the host snapping the mode back —
    // still moves from a defined starting point rather than from nowhere.
    const current = Math.max(
      0,
      this.options.findIndex((option) => option.value === this.mode),
    );

    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (current + 1) % count;
        break;
      case 'ArrowLeft':
        // `+ count` before the modulo: JavaScript's `%` keeps the sign of the
        // left operand, so `-1 % 5` is `-1`, not `4`.
        next = (current - 1 + count) % count;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      default:
        return;
    }

    // Only once a key is known to be handled: preventing the default for every
    // keystroke would swallow the browser's own shortcuts.
    event.preventDefault();
    this.select(this.options[next].value);
    this.focusTab(next);
  }

  private focusTab(index: number): void {
    this.tabButtons()[index]?.nativeElement.focus();
  }
}
