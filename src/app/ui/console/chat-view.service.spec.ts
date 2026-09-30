import { TestBed } from '@angular/core/testing';

import { CHAT_VIEW_STORAGE_KEY, ChatViewService } from './chat-view.service';

describe('ChatViewService', () => {
  /** Built lazily: the constructor reads storage, so a spec arranges the store
   *  (or a throwing one) BEFORE the service exists. */
  function service(): ChatViewService {
    return TestBed.inject(ChatViewService);
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    localStorage.removeItem(CHAT_VIEW_STORAGE_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(CHAT_VIEW_STORAGE_KEY);
  });

  it('defaults to the legacy view when nothing is stored', () => {
    expect(service().newView()).toBeFalse();
  });

  it('starts on the new view when "true" is stored', () => {
    localStorage.setItem(CHAT_VIEW_STORAGE_KEY, 'true');
    expect(service().newView()).toBeTrue();
  });

  it('reads an unknown stored value as legacy', () => {
    localStorage.setItem(CHAT_VIEW_STORAGE_KEY, 'yes please');
    expect(service().newView()).toBeFalse();
  });

  it('reads a refused store as legacy, without throwing', () => {
    spyOn(Storage.prototype, 'getItem').and.throwError('SecurityError');
    expect(() => service()).not.toThrow();
    expect(service().newView()).toBeFalse();
  });

  it('toggling flips the view and writes the key', () => {
    const s = service();
    s.toggle();
    expect(s.newView()).toBeTrue();
    expect(localStorage.getItem(CHAT_VIEW_STORAGE_KEY)).toBe('true');
    s.toggle();
    expect(s.newView()).toBeFalse();
    expect(localStorage.getItem(CHAT_VIEW_STORAGE_KEY)).toBe('false');
  });

  it('a refused write keeps the choice for this visit', () => {
    const s = service();
    spyOn(Storage.prototype, 'setItem').and.throwError('QuotaExceededError');
    expect(() => s.toggle()).not.toThrow();
    expect(s.newView()).toBeTrue();
  });
});
