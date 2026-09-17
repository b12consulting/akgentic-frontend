import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
} from '@angular/core';

/**
 * The console's one icon button (Epic 56).
 *
 * The design mock draws three near-identical icon buttons — the rail toggle,
 * the header's inspector toggle, the inspector's own close — at 30px and 32px,
 * with 8px and 9px radii and 16px and 17px glyphs. Those deltas are drawing
 * noise rather than design: shipping them would spend every future reader's
 * attention hunting for a distinction that was never intended, and would give
 * three components three places to drift. One primitive with a `size` input
 * carries the real difference (in a panel vs. on the chrome) and nothing else.
 *
 * PRESENTATIONAL, deliberately. It holds no state, injects nothing, and knows
 * nothing about what it toggles: the glyph arrives through `<ng-content>` and
 * the meaning arrives through `label`. That is what lets the rail, the
 * process header and the inspector share it without any of them learning
 * about the others.
 *
 * `label` is ALREADY-TRANSLATED text, never a key. A shared primitive that
 * called `TranslatePipe` on its input would force every caller's copy through
 * one namespace and would silently render a raw key for any caller that passed
 * a name (a user's, a team's) instead. The caller owns its i18n; this owns the
 * fact that an icon-only control must carry an accessible name at all — which
 * is the mock's other omission here, where the footer gear ships as a bare
 * inert `<svg>` with no name and no role.
 */
@Component({
  selector: 'app-icon-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Inline: the whole template is one element, and a second file for it would
  // cost more to open than it says.
  template: `
    <button
      type="button"
      class="icon-button"
      [class.icon-button--sm]="size === 'sm'"
      [class.icon-button--pressed]="tone === 'pressed'"
      [attr.aria-label]="label"
      [attr.title]="label"
      [disabled]="disabled"
      (click)="onClick()"
    >
      <ng-content></ng-content>
    </button>
  `,
  styleUrl: './icon-button.component.scss',
})
export class IconButtonComponent {
  /**
   * What pressing this does, in the user's language. Becomes both the
   * accessible name and the tooltip — an icon-only control needs both, and
   * they are the same sentence, so binding them separately only invites them
   * to disagree.
   */
  @Input({ required: true }) label!: string;

  /** `sm` sits inside a panel (28px); `md` sits on the chrome (30px). */
  @Input() size: 'sm' | 'md' = 'md';

  /**
   * `pressed` is the sustained-state look for a toggle that is currently ON —
   * not a click animation. Kept as a tone rather than read from `aria-pressed`
   * because several callers here toggle a pane rather than their own state,
   * and `aria-pressed` on a control whose label already changes ("Show
   * sidebar" / "Collapse sidebar") announces the state twice.
   */
  @Input() tone: 'quiet' | 'pressed' = 'quiet';

  @Input() disabled = false;

  @Output() pressed = new EventEmitter<void>();

  onClick(): void {
    // The native `[disabled]` already stops the DOM click, but a caller can
    // reach this handler through `.click()` on the host or a synthetic event —
    // and a disabled control that still emits is the kind of bug that only
    // shows up as a double-submit.
    if (this.disabled) {
      return;
    }
    this.pressed.emit();
  }
}
