import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  inject,
  ViewChild,
} from '@angular/core';

import { ConfirmDialogService } from './confirm-dialog.service';

let nextId = 0;

/**
 * The dialog `ConfirmDialogService.confirm` opens. Mounted ONCE, at the root.
 *
 * Hand-rolled rather than a `<p-dialog>`, because the three things a
 * destructive confirm has to get right are the three a generic dialog leaves
 * to its caller:
 *
 *   - FOCUS STARTS ON CANCEL. Enter on an opened confirm answers whichever
 *     button holds focus, so the safe answer is the one under the key. Nothing
 *     here binds Enter to confirm, and nothing may.
 *   - FOCUS IS TRAPPED. Tab and Shift+Tab cycle the dialog's own buttons; the
 *     page behind is `aria-modal` and unreachable while the question is open.
 *   - EVERY WAY OUT IS "NO". Escape, a backdrop click, Cancel — only the
 *     confirm button answers yes.
 *
 * Presentational: it renders `ConfirmDialogService.current` and reports the
 * answer back through `settle`. Focus is handed back by the service, which is
 * the side that knows where it came from.
 */
@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './confirm-dialog.component.html',
  styleUrl: './confirm-dialog.component.scss',
})
export class ConfirmDialogComponent {
  readonly service = inject(ConfirmDialogService);

  private readonly id = nextId++;
  readonly headerId = `confirm-dialog-${this.id}-header`;
  readonly messageId = `confirm-dialog-${this.id}-message`;

  @ViewChild('panel') private panel?: ElementRef<HTMLElement>;

  /** Focuses Cancel the moment it renders, i.e. every time a request opens. */
  @ViewChild('cancelBtn')
  set cancelButton(ref: ElementRef<HTMLButtonElement> | undefined) {
    ref?.nativeElement.focus();
  }

  @HostListener('document:keydown.escape', ['$event'])
  onEscape(event: Event): void {
    if (this.service.current() === null) {
      return;
    }
    event.preventDefault();
    this.service.settle(false);
  }

  /** A click on the scrim itself, never one that bubbled out of the panel. */
  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.service.settle(false);
    }
  }

  /** Keep Tab inside the dialog: wrap from the last control to the first. */
  onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || !this.panel) {
      return;
    }
    const controls = Array.from(
      this.panel.nativeElement.querySelectorAll<HTMLElement>('button:not([disabled])'),
    );
    if (controls.length === 0) {
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !controls.includes(active as HTMLElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !controls.includes(active as HTMLElement))) {
      event.preventDefault();
      first.focus();
    }
  }
}
