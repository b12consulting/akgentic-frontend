import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { ApiKeyRevealComponent } from './api-key-reveal.component';

/**
 * Story 36-6 Task 3 — the reveal component in isolation.
 *
 * `navigator.clipboard` is NOT a plain spy-able method in every browser
 * context (it is a getter on a read-only property), so the spy is installed
 * with `Object.defineProperty` per spec and restored afterwards rather than
 * assuming `spyOn(navigator.clipboard, 'writeText')` will take.
 *
 * The sentinel is the same shape the pane-level absence specs use — it is
 * distinctive enough that a stray occurrence anywhere is unmistakable.
 */

const SENTINEL = 'ak_testkeyid_SENTINELPLAINTEXTVALUE';

describe('ApiKeyRevealComponent (Story 36-6)', () => {
  let fixture: ComponentFixture<ApiKeyRevealComponent>;
  let component: ApiKeyRevealComponent;
  let originalClipboard: PropertyDescriptor | undefined;

  beforeEach(async () => {
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

    await TestBed.configureTestingModule({
      imports: [ApiKeyRevealComponent, NoopAnimationsModule],
    }).compileComponents();

    fixture = TestBed.createComponent(ApiKeyRevealComponent);
    component = fixture.componentInstance;
    component.plaintext = SENTINEL;
    component.keyId = 'ak-acme-9';
    fixture.detectChanges();
  });

  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    } else {
      delete (navigator as unknown as Record<string, unknown>)['clipboard'];
    }
  });

  function installClipboard(
    writeText: jasmine.Spy<(text: string) => Promise<void>>,
  ): void {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  }

  function byTest(value: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-test="${value}"]`);
  }

  it('renders the plaintext value, once, with its key id beside it', () => {
    expect(byTest('api-key-reveal')).not.toBeNull();
    expect(byTest('api-key-reveal-value')?.textContent?.trim()).toBe(SENTINEL);
    expect(byTest('api-key-reveal-key-id')?.textContent).toContain('ak-acme-9');

    // Rendered ONCE: a second element carrying the value would be a second
    // place it can be scraped from, and a second place to forget to remove.
    const occurrences = (
      (fixture.nativeElement.textContent as string).match(
        new RegExp(SENTINEL, 'g'),
      ) ?? []
    ).length;
    expect(occurrences).toBe(1);
  });

  it('writes EXACTLY the input to the clipboard, and nothing else', async () => {
    const writeText = jasmine
      .createSpy<(text: string) => Promise<void>>('writeText')
      .and.returnValue(Promise.resolve());
    installClipboard(writeText);

    (byTest('api-key-reveal-copy-btn') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(SENTINEL);
    expect(byTest('api-key-reveal-copied')).not.toBeNull();
  });

  it('reports a clipboard rejection in place and keeps the value on screen', async () => {
    const writeText = jasmine
      .createSpy<(text: string) => Promise<void>>('writeText')
      .and.returnValue(Promise.reject(new Error('denied')));
    installClipboard(writeText);

    (byTest('api-key-reveal-copy-btn') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();

    // The value is still there to be selected by hand — there is no second
    // chance to fetch it from the server.
    expect(byTest('api-key-reveal-copy-failed')).not.toBeNull();
    expect(byTest('api-key-reveal-value')?.textContent?.trim()).toBe(SENTINEL);
  });

  it('emits dismissed exactly once when Done is pressed', () => {
    let emissions = 0;
    component.dismissed.subscribe(() => {
      emissions += 1;
    });

    (byTest('api-key-reveal-done-btn') as HTMLButtonElement).click();

    expect(emissions).toBe(1);
  });

  it('caches the plaintext in NO property of its own beyond the input', async () => {
    const writeText = jasmine
      .createSpy<(text: string) => Promise<void>>('writeText')
      .and.returnValue(Promise.resolve());
    installClipboard(writeText);

    (byTest('api-key-reveal-copy-btn') as HTMLButtonElement).click();
    await fixture.whenStable();

    // Copying is the operation most likely to leave a "last copied" field
    // behind. `plaintext` is the input itself and dies with the component;
    // every OTHER own property must be free of the value.
    //
    // A plain own-property scan, NOT a deep one: the component's remaining
    // fields are primitives plus an `EventEmitter`, and the emitter's internal
    // graph is cyclic — walking it would fail on the structure rather than on
    // the leak. The pane-level absence spec carries the recursive version,
    // where nested state actually exists.
    const leaked = Object.entries(component as unknown as Record<string, unknown>)
      .filter(([name]) => name !== 'plaintext')
      .filter(([, value]) => typeof value === 'string' && value.includes(SENTINEL));
    expect(leaked).toEqual([]);
  });
});
