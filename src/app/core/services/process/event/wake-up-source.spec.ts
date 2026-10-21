import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { Subscription } from 'rxjs';

import {
  WAKE_UP_COALESCE_MS,
  WAKE_UP_HIDDEN_MS,
  WakeUpSource,
} from './wake-up-source';

describe('WakeUpSource (Story 63-1)', () => {
  let doc: Document;
  let visibility: DocumentVisibilityState;
  let emissions: number;
  let sub: Subscription | null;

  /** Build the unit with its visibility seam pointed at `visibility`. */
  function source(): WakeUpSource {
    const unit = TestBed.inject(WakeUpSource);
    spyOn<any>(unit, 'visibilityState').and.callFake(() => visibility);
    return unit;
  }

  function listen(unit: WakeUpSource): void {
    sub = unit.wake$.subscribe(() => emissions++);
  }

  function hide(): void {
    visibility = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
  }

  function show(): void {
    visibility = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
  }

  function online(): void {
    doc.defaultView!.dispatchEvent(new Event('online'));
  }

  /** The event names a listener spy was called with. */
  function eventNames(spy: jasmine.Spy): string[] {
    return spy.calls.allArgs().map((args: unknown[]) => args[0] as string);
  }

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(0));
    TestBed.configureTestingModule({ providers: [WakeUpSource] });
    doc = TestBed.inject(DOCUMENT);
    visibility = 'visible';
    emissions = 0;
    sub = null;
  });

  afterEach(() => {
    sub?.unsubscribe();
    jasmine.clock().uninstall();
  });

  it('a page shown after the full hidden floor emits once', () => {
    listen(source());
    hide();
    jasmine.clock().tick(WAKE_UP_HIDDEN_MS);
    show();

    expect(emissions).toBe(1);
  });

  it('a page shown one millisecond short of the floor emits nothing', () => {
    listen(source());
    hide();
    jasmine.clock().tick(WAKE_UP_HIDDEN_MS - 1);
    show();

    expect(emissions).toBe(0);
  });

  it('a page already hidden at subscribe time counts its hide from then', () => {
    visibility = 'hidden';
    listen(source());
    jasmine.clock().tick(WAKE_UP_HIDDEN_MS);
    show();

    expect(emissions).toBe(1);
  });

  it('a second show without a hide in between emits nothing', () => {
    listen(source());
    hide();
    jasmine.clock().tick(WAKE_UP_HIDDEN_MS);
    show();
    jasmine.clock().tick(WAKE_UP_HIDDEN_MS);
    show();

    expect(emissions).toBe(1);
  });

  it('online emits every time, with no floor', () => {
    listen(source());
    online();
    jasmine.clock().tick(WAKE_UP_COALESCE_MS);
    online();

    expect(emissions).toBe(2);
  });

  it('online and a wake-up within the coalesce window emit once', () => {
    listen(source());
    hide();
    jasmine.clock().tick(WAKE_UP_HIDDEN_MS);
    online();
    jasmine.clock().tick(WAKE_UP_COALESCE_MS - 1);
    show();

    expect(emissions).toBe(1);
  });

  it('construction alone adds no listener', () => {
    const docAdd = spyOn(doc, 'addEventListener').and.callThrough();
    const winAdd = spyOn(doc.defaultView!, 'addEventListener').and.callThrough();

    const unit = source();
    expect(eventNames(docAdd)).not.toContain('visibilitychange');
    expect(eventNames(winAdd)).not.toContain('online');

    // The spies are live: the same unit, once subscribed, does add them.
    listen(unit);
    expect(eventNames(docAdd)).toContain('visibilitychange');
    expect(eventNames(winAdd)).toContain('online');
  });

  it('unsubscribing removes both listeners, and a later event emits nothing', () => {
    const docRemove = spyOn(doc, 'removeEventListener').and.callThrough();
    const winRemove = spyOn(doc.defaultView!, 'removeEventListener').and.callThrough();
    listen(source());

    sub!.unsubscribe();
    hide();
    jasmine.clock().tick(WAKE_UP_HIDDEN_MS);
    show();
    jasmine.clock().tick(WAKE_UP_COALESCE_MS);
    online();

    expect(eventNames(docRemove)).toContain('visibilitychange');
    expect(eventNames(winRemove)).toContain('online');
    expect(emissions).toBe(0);
  });
});
