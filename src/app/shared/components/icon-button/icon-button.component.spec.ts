import { Component, ViewChild } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { IconButtonComponent } from './icon-button.component';

/**
 * Epic 56 — the shared icon button.
 *
 * Driven through a HOST rather than by poking the component instance, because
 * everything worth asserting here is a contract with a caller: what the button
 * announces itself as, when it emits, and when it refuses to. Setting inputs
 * directly would test the fields rather than the bindings.
 *
 * No `provideTranslateTesting()` in this file, and that is the point: `label`
 * is already-translated text, so this component must render exactly what it is
 * given and must not reach for a translation service. If it ever did, this
 * TestBed would fail to construct it.
 */
@Component({
  imports: [IconButtonComponent],
  template: `
    <app-icon-button
      [label]="label"
      [size]="size"
      [tone]="tone"
      [disabled]="disabled"
      (pressed)="presses = presses + 1"
    >
      <svg data-test="glyph" viewBox="0 0 16 16"><path d="M0 0" /></svg>
    </app-icon-button>
  `,
})
class HostComponent {
  @ViewChild(IconButtonComponent) button!: IconButtonComponent;
  label = 'Collapse sidebar';
  size: 'sm' | 'md' = 'md';
  tone: 'quiet' | 'pressed' = 'quiet';
  disabled = false;
  presses = 0;
}

describe('IconButtonComponent (Epic 56)', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  function button(): HTMLButtonElement {
    return fixture.debugElement.query(By.css('button')).nativeElement;
  }

  it('renders a real <button type="button">, not a clickable div', () => {
    // The mock's rail rows are `<div (click)>` and are keyboard-unreachable.
    // Every control built on this primitive inherits a focusable, Enter- and
    // Space-activated element instead, for free.
    expect(button().tagName).toBe('BUTTON');
    expect(button().getAttribute('type')).toBe('button');
  });

  it('publishes the label as BOTH the accessible name and the tooltip', () => {
    expect(button().getAttribute('aria-label')).toBe('Collapse sidebar');
    expect(button().getAttribute('title')).toBe('Collapse sidebar');
  });

  it('renders the label verbatim — it is copy, not a translation key', () => {
    // Guards the contract in the other direction: a future "helpful" pipe
    // inside this component would turn a caller's resolved French string into
    // a missing-key echo.
    host.label = 'Réduire la barre latérale';
    fixture.detectChanges();

    expect(button().getAttribute('aria-label')).toBe(
      'Réduire la barre latérale',
    );
  });

  it('tracks a label change on both attributes rather than freezing the first', () => {
    // A toggle relabels itself every time it flips ("Show" ↔ "Collapse"). A
    // one-shot attribute would leave a screen reader announcing the state the
    // control was in when it mounted.
    host.label = 'Show sidebar';
    fixture.detectChanges();

    expect(button().getAttribute('aria-label')).toBe('Show sidebar');
    expect(button().getAttribute('title')).toBe('Show sidebar');
  });

  it('projects the caller-supplied glyph', () => {
    expect(button().querySelector('[data-test="glyph"]')).not.toBeNull();
  });

  it('emits pressed once per click', () => {
    button().click();
    button().click();

    expect(host.presses).toBe(2);
  });

  it('emits nothing when disabled, even for a programmatic click', () => {
    host.disabled = true;
    fixture.detectChanges();

    expect(button().disabled).toBeTrue();

    button().click();
    // And past the DOM's own guard, straight at the handler — the route a
    // synthetic event or a host `.click()` would take.
    host.button.onClick();

    expect(host.presses).toBe(0);
  });

  it('carries the pressed class only for tone="pressed"', () => {
    expect(button().classList).not.toContain('icon-button--pressed');

    host.tone = 'pressed';
    fixture.detectChanges();
    expect(button().classList).toContain('icon-button--pressed');

    host.tone = 'quiet';
    fixture.detectChanges();
    expect(button().classList).not.toContain('icon-button--pressed');
  });

  it('carries the small-size class only for size="sm"', () => {
    // md is the default and must stay unmarked, so the base rule is the one
    // that supplies the chrome-sized 30px.
    expect(button().classList).not.toContain('icon-button--sm');

    host.size = 'sm';
    fixture.detectChanges();
    expect(button().classList).toContain('icon-button--sm');
  });
});
