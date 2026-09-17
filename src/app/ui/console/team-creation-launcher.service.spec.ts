import { effect, Injector, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { TeamCreationLauncher } from './team-creation-launcher.service';

describe('TeamCreationLauncher', () => {
  let launcher: TeamCreationLauncher;
  let injector: Injector;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    launcher = TestBed.inject(TeamCreationLauncher);
    injector = TestBed.inject(Injector);
  });

  /**
   * Count how many times the flag NOTIFIES, which is a different question from
   * what it currently reads — and the one idempotence is about.
   */
  function trackNotifications(): () => number {
    const seen: boolean[] = [];
    runInInjectionContext(injector, () => {
      effect(() => {
        seen.push(launcher.isOpen());
      });
    });
    TestBed.flushEffects();
    return () => seen.length;
  }

  it('starts closed — the wizard is opt-in, never the arriving state', () => {
    expect(launcher.isOpen()).toBe(false);
  });

  it('open() raises the flag and close() lowers it', () => {
    launcher.open();
    expect(launcher.isOpen()).toBe(true);

    launcher.close();
    expect(launcher.isOpen()).toBe(false);
  });

  it('is a flag, not a counter: two opens still close on ONE close', () => {
    // A depth counter here would leave the dialog on screen after the user
    // dismissed it, because the second press would have to be un-pressed.
    launcher.open();
    launcher.open();
    launcher.close();

    expect(launcher.isOpen()).toBe(false);
  });

  it('a repeated open() notifies nobody, so the mounted dialog is not re-created', () => {
    // The `@if` in app.component.html re-evaluating would destroy and rebuild
    // TeamCreationDialogComponent — and with it the component-scoped
    // TeamCreationService — silently discarding a type the user had chosen.
    launcher.open();
    const count = trackNotifications();
    const before = count();

    launcher.open();
    launcher.open();
    TestBed.flushEffects();

    expect(count()).toBe(before);
    expect(launcher.isOpen()).toBe(true);
  });

  it('a repeated close() while closed notifies nobody either', () => {
    const count = trackNotifications();
    const before = count();

    launcher.close();
    TestBed.flushEffects();

    expect(count()).toBe(before);
  });

  it('a real transition DOES notify, so the gate is not merely inert', () => {
    // The counterpart to the two assertions above: they would both pass on a
    // signal that never notified at all.
    const count = trackNotifications();
    const before = count();

    launcher.open();
    TestBed.flushEffects();

    expect(count()).toBe(before + 1);
  });

  it('is root-scoped — the rail and the root mount share one flag', () => {
    // Two injections must be the same object, or the control that asks and the
    // gate that renders would each hold half the answer.
    expect(TestBed.inject(TeamCreationLauncher)).toBe(launcher);
  });

  it('exposes the flag read-only — only open()/close() may move it', () => {
    // `asReadonly()` strips `set`/`update`; a caller reaching past the two
    // methods is what would let dialog state accrete at root over time.
    const flag = launcher.isOpen as unknown as Record<string, unknown>;
    expect(flag['set']).toBeUndefined();
    expect(flag['update']).toBeUndefined();
  });
});
