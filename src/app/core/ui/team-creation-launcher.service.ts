import { Injectable, signal } from '@angular/core';

/**
 * Whether the team-creation wizard is on screen. ONE boolean, and deliberately
 * nothing else.
 *
 * IT EXISTS BECAUSE THE ASKER AND THE DIALOG CANNOT SEE EACH OTHER. The control
 * that asks for a new team is in the rail; the dialog is mounted in
 * `app.component.html`, a sibling of the shell, because the rail is `inert` +
 * `aria-hidden` when collapsed and a dialog inside an inert subtree is a dialog
 * nobody can use. Two components with no ancestor relationship need a
 * root-scoped fact between them, and "is the wizard open" is that fact.
 *
 * WHAT IT MUST NEVER GROW. Not the chosen namespace, not the metadata contract,
 * not the error message, not the in-flight flag — none of the wizard's state.
 * `TeamCreationService` is component-scoped precisely so a captured namespace
 * and a half-filled dialog die with their host rather than surviving a
 * navigation away and back (see that service's class doc). A root service that
 * carried any of it would reintroduce exactly the cross-navigation leak that
 * scoping was designed to prevent, through a different door. The wizard's state
 * lives on `TeamCreationDialogComponent`, which is created and destroyed with
 * the dialog; this service only says whether that component exists.
 *
 * A signal rather than a `BehaviorSubject` because its one consumer is an `@if`
 * in a template, where a signal reads without an async pipe and without a
 * subscription to leak.
 */
@Injectable({ providedIn: 'root' })
export class TeamCreationLauncher {
  private readonly _isOpen = signal(false);

  /** Is the wizard mounted? Read by the `@if` gate in `app.component.html`. */
  readonly isOpen = this._isOpen.asReadonly();

  /**
   * Ask for the wizard.
   *
   * IDEMPOTENT, and it matters: a second press while the dialog is already open
   * must not re-create the component, because re-creating it would destroy the
   * `TeamCreationService` behind it and silently discard a type the user had
   * already chosen. Setting a signal to the value it already holds notifies
   * nobody, so the `@if` never re-evaluates and the dialog is left alone.
   */
  open(): void {
    this._isOpen.set(true);
  }

  /** Dismiss the wizard. The dialog component — and its gate — dies with it. */
  close(): void {
    this._isOpen.set(false);
  }
}
