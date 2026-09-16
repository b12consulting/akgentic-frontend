import { TestBed } from '@angular/core/testing';

import { MessageService, ToastMessageOptions } from 'primeng/api';

import { NotificationToastService } from '../../core/ui/notification-toast.service';
import { PrimeNgNotificationAdapter } from './notification.adapter';

/**
 * Story 53-1: the PrimeNG side of `NOTIFICATION_PORT`.
 *
 * The assertions below are mostly about what is NOT in the payload. Three
 * properties are deliberately absent at the call sites this adapter now serves,
 * and each omission is load-bearing: a keyed message is silently dropped by
 * `Toast.canAdd` against the app's single keyless mount, any `life` value
 * defeats `sticky: true`, and an absent `closable` is what makes PrimeNG render
 * the default close cross that a notification toast needs and a connection toast
 * must not have.
 *
 * They are therefore asserted by PROPERTY PRESENCE (`'closable' in payload`) and
 * never by value. `closable: undefined` is not equivalent to omitting `closable`
 * — it satisfies `payload.closable === undefined` while still being an own
 * property — so a value assertion would pass against an adapter that spread
 * `undefined` into every payload and quietly changed the rendering.
 */
describe('PrimeNgNotificationAdapter', () => {
  let adapter: PrimeNgNotificationAdapter;
  let messageService: jasmine.SpyObj<MessageService>;
  let notificationToast: jasmine.SpyObj<NotificationToastService>;

  /** The payload the adapter handed to `MessageService.add`, as an own-property bag. */
  function lastPayload(): ToastMessageOptions {
    expect(messageService.add).toHaveBeenCalled();
    return messageService.add.calls.mostRecent().args[0];
  }

  beforeEach(() => {
    messageService = jasmine.createSpyObj<MessageService>('MessageService', [
      'add',
      'clear',
    ]);
    notificationToast = jasmine.createSpyObj<NotificationToastService>(
      'NotificationToastService',
      ['dismiss'],
    );

    TestBed.configureTestingModule({
      providers: [
        PrimeNgNotificationAdapter,
        { provide: MessageService, useValue: messageService },
        { provide: NotificationToastService, useValue: notificationToast },
      ],
    });

    adapter = TestBed.inject(PrimeNgNotificationAdapter);
  });

  describe('notify — the four call shapes', () => {
    it('carries severity and summary for a FetchService error', () => {
      adapter.notify({ severity: 'error', summary: 'Request failed: Not Found' });

      const payload = lastPayload();
      expect(payload.severity).toBe('error');
      expect(payload.summary).toBe('Request failed: Not Found');
    });

    it('carries severity and summary for a UtilService success', () => {
      adapter.notify({ severity: 'success', summary: 'Copied to clipboard' });

      const payload = lastPayload();
      expect(payload.severity).toBe('success');
      expect(payload.summary).toBe('Copied to clipboard');
    });

    it('carries the connection toast shape, closable false included', () => {
      adapter.notify({
        severity: 'warn',
        summary: 'Connection Lost',
        detail: 'Real-time connection to the server has been lost. Updates are paused.',
        sticky: true,
        closable: false,
      });

      const payload = lastPayload();
      expect(payload.severity).toBe('warn');
      expect(payload.summary).toBe('Connection Lost');
      expect(payload.detail).toBe(
        'Real-time connection to the server has been lost. Updates are paused.',
      );
      expect(payload.sticky).toBe(true);
      expect(payload.closable).toBe(false);
    });

    it('carries the notification toast shape, data included', () => {
      adapter.notify({
        severity: 'warn',
        summary: 'Researcher - RuntimeError',
        detail: 'something went wrong',
        sticky: true,
        data: { messageId: 'msg-1', teamId: 'team-7' },
      });

      const payload = lastPayload();
      expect(payload.severity).toBe('warn');
      expect(payload.summary).toBe('Researcher - RuntimeError');
      expect(payload.detail).toBe('something went wrong');
      expect(payload.sticky).toBe(true);
      expect(payload.data).toEqual({ messageId: 'msg-1', teamId: 'team-7' });
    });
  });

  describe('notify — the three omissions, asserted by property presence', () => {
    it('omits closable entirely on the notification path', () => {
      adapter.notify({
        severity: 'info',
        summary: 'Orchestrator - Notification',
        detail: 'done',
        sticky: true,
        data: { messageId: 'msg-2', teamId: 'team-7' },
      });

      // NOT `toBeUndefined()`: an adapter spreading `closable: undefined` would
      // pass that while suppressing nothing, and the close cross depends on the
      // property being absent rather than falsy.
      expect('closable' in lastPayload()).toBe(false);
    });

    it('omits key and life on the notification path', () => {
      adapter.notify({
        severity: 'error',
        summary: 'Researcher - ValueError',
        detail: 'bad input',
        sticky: true,
        data: { messageId: 'msg-3', teamId: 'team-7' },
      });

      const payload = lastPayload();
      expect('key' in payload).toBe(false);
      expect('life' in payload).toBe(false);
    });

    it('omits key and life on the connection path', () => {
      adapter.notify({
        severity: 'warn',
        summary: 'Connection Lost',
        detail: 'Updates are paused.',
        sticky: true,
        closable: false,
      });

      const payload = lastPayload();
      expect('key' in payload).toBe(false);
      expect('life' in payload).toBe(false);
    });

    it('omits detail, sticky and data when the request carries none', () => {
      adapter.notify({ severity: 'success', summary: 'Saved' });

      const payload = lastPayload();
      expect('detail' in payload).toBe(false);
      expect('sticky' in payload).toBe(false);
      expect('data' in payload).toBe(false);
      expect('closable' in payload).toBe(false);
    });
  });

  describe('dismiss', () => {
    it('delegates to NotificationToastService, which owns the splice', () => {
      adapter.dismiss('msg-4');

      expect(notificationToast.dismiss).toHaveBeenCalledOnceWith('msg-4');
    });

    it('raises nothing and clears nothing', () => {
      adapter.dismiss('msg-5');

      expect(messageService.add).not.toHaveBeenCalled();
      expect(messageService.clear).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('empties the whole keyless container — no key argument', () => {
      adapter.clear();

      expect(messageService.clear).toHaveBeenCalledTimes(1);
      // `clear('some-key')` matches no container and would remove nothing.
      expect(messageService.clear.calls.mostRecent().args.length).toBe(0);
    });

    it('does not reach the single-toast remover', () => {
      adapter.clear();

      expect(notificationToast.dismiss).not.toHaveBeenCalled();
    });
  });
});
