import { TestBed } from '@angular/core/testing';
import { Toast } from 'primeng/toast';

import { NotificationToastService } from './notification-toast.service';

// ---------------------------------------------------------------------------
// Story 31-5 — single-toast removal (unit level)
//
// The service in isolation: given a container holding N toasts, `dismiss(id)`
// takes out the one whose `data.messageId` matches and nothing else. The
// PrimeNG half of the contract — that splicing `Toast.messages` really does
// remove the rendered element, and that a keyed message would not have rendered
// in the first place — is pinned against the real `<p-toast>` mount in
// `app.component.spec.ts`.
// ---------------------------------------------------------------------------

/** A stand-in for the app's `<p-toast>`, exposing just the two published
 *  members `NotificationToastService` touches. */
function fakeToast(
  messages: Record<string, unknown>[] | null,
): { instance: Toast; markForCheck: jasmine.Spy } {
  const markForCheck = jasmine.createSpy('markForCheck');
  return {
    instance: { messages, cd: { markForCheck } } as unknown as Toast,
    markForCheck,
  };
}

function toast(messageId: string, summary = 'Alpha'): Record<string, unknown> {
  return {
    severity: 'warn',
    summary,
    detail: 'over limit',
    sticky: true,
    data: { messageId, teamId: 'team-1' },
  };
}

describe('NotificationToastService (Story 31-5)', () => {
  let service: NotificationToastService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(NotificationToastService);
  });

  it('removes the toast whose data.messageId matches, and only that one', () => {
    const messages = [toast('w-1', 'Alpha'), toast('w-2', 'Beta')];
    const { instance } = fakeToast(messages);
    service.register(instance);

    service.dismiss('w-1');

    expect(messages.length).toBe(1);
    expect((messages[0]['data'] as { messageId: string }).messageId).toBe('w-2');
  });

  it('marks the OnPush container for check so the splice reaches the DOM', () => {
    const { instance, markForCheck } = fakeToast([toast('w-1')]);
    service.register(instance);

    service.dismiss('w-1');

    expect(markForCheck).toHaveBeenCalledTimes(1);
  });

  it('leaves toasts that carry no data untouched', () => {
    // The disconnect toast and every `FetchService` error toast look like this.
    const bare = { severity: 'warn', summary: 'Connection Lost' };
    const messages = [bare, toast('w-1')];
    const { instance } = fakeToast(messages);
    service.register(instance);

    service.dismiss('w-1');

    expect(messages).toEqual([bare]);
  });

  it('is a no-op for an id with no toast on screen', () => {
    const messages = [toast('w-1')];
    const { instance, markForCheck } = fakeToast(messages);
    service.register(instance);

    expect(() => service.dismiss('never-shown')).not.toThrow();
    expect(messages.length).toBe(1);
    expect(markForCheck).not.toHaveBeenCalled();
  });

  it('is a no-op when no mount is registered', () => {
    expect(() => service.dismiss('w-1')).not.toThrow();
  });

  it('is a no-op when the registered mount has been unregistered', () => {
    const messages = [toast('w-1')];
    const { instance } = fakeToast(messages);
    service.register(instance);
    service.register(null);

    service.dismiss('w-1');

    expect(messages.length).toBe(1);
  });

  it('is a no-op when the container holds no messages yet', () => {
    // PrimeNG leaves `messages` null until the first `add`, and nulls it again
    // on `clear()`.
    const { instance } = fakeToast(null);
    service.register(instance);

    expect(() => service.dismiss('w-1')).not.toThrow();
  });

  it('removes only the first match when an id somehow appears twice', () => {
    const messages = [toast('w-1', 'Alpha'), toast('w-1', 'Duplicate')];
    const { instance } = fakeToast(messages);
    service.register(instance);

    service.dismiss('w-1');

    expect(messages.length).toBe(1);
    expect(messages[0]['summary']).toBe('Duplicate');
  });
});
