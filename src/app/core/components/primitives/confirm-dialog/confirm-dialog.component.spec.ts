import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ConfirmDialogComponent } from './confirm-dialog.component';
import { ConfirmDialogService, ConfirmRequest } from './confirm-dialog.service';

function request(overrides: Partial<ConfirmRequest> = {}): ConfirmRequest {
  return {
    header: 'Delete team?',
    message: 'Delete “Research Crew”? This cannot be undone.',
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    tone: 'danger',
    ...overrides,
  };
}

describe('ConfirmDialogComponent', () => {
  let fixture: ComponentFixture<ConfirmDialogComponent>;
  let service: ConfirmDialogService;
  let trigger: HTMLButtonElement;

  const q = <T extends HTMLElement>(selector: string): T | null =>
    fixture.nativeElement.querySelector(selector) as T | null;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConfirmDialogComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ConfirmDialogComponent);
    service = TestBed.inject(ConfirmDialogService);
    fixture.detectChanges();

    // The control the user "clicked" — focus must come back here.
    trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    document.body.appendChild(trigger);
    trigger.focus();
  });

  afterEach(() => {
    service.settle(false);
    trigger.remove();
  });

  /** Wrapped, because an async function returning a bare promise would await
   *  the ANSWER and never return while the dialog is open. */
  async function open(
    overrides: Partial<ConfirmRequest> = {},
  ): Promise<{ answer: Promise<boolean> }> {
    const answer = service.confirm(request(overrides));
    fixture.detectChanges();
    await fixture.whenStable();
    return { answer };
  }

  function press(key: string, init: KeyboardEventInit = {}): void {
    const target = (document.activeElement as HTMLElement) ?? document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
    fixture.detectChanges();
  }

  it('renders nothing until a request opens', () => {
    expect(q('[data-test="confirm-dialog"]')).toBeNull();
  });

  it('is an alertdialog labelled by its header and described by its message', async () => {
    await open();
    const dialog = q<HTMLElement>('[data-test="confirm-dialog"]')!;

    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const header = document.getElementById(dialog.getAttribute('aria-labelledby')!);
    const message = document.getElementById(dialog.getAttribute('aria-describedby')!);
    expect(header?.textContent?.trim()).toBe('Delete team?');
    expect(message?.textContent).toContain('Research Crew');
  });

  it('starts focus on Cancel, never on the destructive button', async () => {
    await open();

    expect(document.activeElement).toBe(q('[data-test="confirm-cancel"]'));
  });

  it('activating the focused control on open (what Enter does) answers no', async () => {
    const { answer } = await open();
    // Nothing binds Enter; a native button activates on it, so what matters is
    // WHICH button holds focus. Activating it must be the safe answer.
    (document.activeElement as HTMLButtonElement).click();

    expect(await answer).toBeFalse();
  });

  it('Delete resolves true and closes', async () => {
    const { answer } = await open();

    q<HTMLButtonElement>('[data-test="confirm-accept"]')!.click();
    fixture.detectChanges();

    expect(await answer).toBeTrue();
    expect(q('[data-test="confirm-dialog"]')).toBeNull();
  });

  it('Escape cancels', async () => {
    const { answer } = await open();

    press('Escape');

    expect(await answer).toBeFalse();
    expect(q('[data-test="confirm-dialog"]')).toBeNull();
  });

  it('a backdrop click cancels, a click inside the panel does not', async () => {
    const { answer } = await open();
    let settled = false;
    void answer.then(() => (settled = true));

    q<HTMLElement>('[data-test="confirm-message"]')!.click();
    await Promise.resolve();
    expect(settled).toBeFalse();

    q<HTMLElement>('[data-test="confirm-backdrop"]')!.click();
    expect(await answer).toBeFalse();
  });

  it('returns focus to the triggering control on close', async () => {
    await open();
    expect(document.activeElement).not.toBe(trigger);

    press('Escape');

    expect(document.activeElement).toBe(trigger);
  });

  it('traps Tab inside the dialog in both directions', async () => {
    await open();
    const cancel = q<HTMLButtonElement>('[data-test="confirm-cancel"]')!;
    const accept = q<HTMLButtonElement>('[data-test="confirm-accept"]')!;

    accept.focus();
    press('Tab');
    expect(document.activeElement).toBe(cancel);

    press('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(accept);
  });

  it('draws the confirm button in the danger tone only when asked', async () => {
    await open();
    expect(q('[data-test="confirm-accept"]')!.classList).toContain('confirm-btn--danger');
    service.settle(false);

    await open({ tone: 'default' });
    expect(q('[data-test="confirm-accept"]')!.classList).not.toContain('confirm-btn--danger');
  });
});

describe('ConfirmDialogService', () => {
  let service: ConfirmDialogService;

  beforeEach(() => {
    service = TestBed.inject(ConfirmDialogService);
  });

  it('a second request cancels the first rather than queueing behind it', async () => {
    const first = service.confirm(request());
    const second = service.confirm(request({ header: 'Second' }));

    expect(await first).toBeFalse();
    expect(service.current()?.request.header).toBe('Second');

    service.settle(true);
    expect(await second).toBeTrue();
  });

  it('settling with nothing open is a no-op', () => {
    expect(() => service.settle(true)).not.toThrow();
    expect(service.current()).toBeNull();
  });

  it('returns focus to an explicit returnFocus over the active element', () => {
    const kebab = document.createElement('button');
    document.body.appendChild(kebab);
    void service.confirm(request({ returnFocus: kebab }));

    service.settle(false);

    expect(document.activeElement).toBe(kebab);
    kebab.remove();
  });
});
