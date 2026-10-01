import { fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { BehaviorSubject, Subscription } from 'rxjs';

import { AkgenticMessage } from '../../../protocol/message.types';
import { selectionFetch } from './selected-agent';

describe('selectionFetch', () => {
  let selected$: BehaviorSubject<string | null>;
  let fetchStates: jasmine.Spy<(agentId: string) => Promise<AkgenticMessage[]>>;
  let emitted: AkgenticMessage[][];
  let sub: Subscription;
  // Stands in for the `state` store: the agents whose state it holds.
  let known: Set<string>;

  beforeEach(() => {
    selected$ = new BehaviorSubject<string | null>(null);
    fetchStates = jasmine.createSpy('fetchStates').and.resolveTo([]);
    emitted = [];
    known = new Set<string>();
  });

  afterEach(() => sub?.unsubscribe());

  function start(): void {
    sub = selectionFetch(selected$, fetchStates, (id: string) =>
      known.has(id),
    ).subscribe((m) => emitted.push(m));
  }

  /** A fetch that returns a snapshot, which the caller would store. */
  function fetchStores(): void {
    fetchStates.and.callFake((agentId: string) => {
      known.add(agentId);
      return Promise.resolve([{ id: agentId } as AkgenticMessage]);
    });
  }

  it('fetches the selection current at subscribe time', fakeAsync(() => {
    selected$.next('agent-A');
    start();
    flushMicrotasks();

    expect(fetchStates).toHaveBeenCalledOnceWith('agent-A');
    expect(emitted.length).toBe(1);
  }));

  it('a null selection fetches nothing', fakeAsync(() => {
    start();
    selected$.next(null);
    flushMicrotasks();

    expect(fetchStates).not.toHaveBeenCalled();
  }));

  it('selecting an agent whose state is already known fetches nothing', fakeAsync(() => {
    known.add('agent-A');
    start();
    selected$.next('agent-A');
    flushMicrotasks();

    expect(fetchStates).not.toHaveBeenCalled();
    expect(emitted.length).toBe(0);
  }));

  it('A, then B, then A again fetches each agent once', fakeAsync(() => {
    fetchStores();
    start();
    selected$.next('agent-A');
    flushMicrotasks();
    selected$.next('agent-B');
    flushMicrotasks();
    selected$.next('agent-A');
    flushMicrotasks();

    expect(fetchStates.calls.allArgs()).toEqual([['agent-A'], ['agent-B']]);
  }));

  it('an agent whose fetch returned no snapshot is fetched again on the next selection', fakeAsync(() => {
    start();
    selected$.next('agent-A');
    flushMicrotasks();
    selected$.next(null);
    selected$.next('agent-A');
    flushMicrotasks();

    expect(fetchStates.calls.allArgs()).toEqual([['agent-A'], ['agent-A']]);
  }));

  it('a failed fetch is logged and the next selection still fetches', fakeAsync(() => {
    const error = spyOn(console, 'error');
    let calls = 0;
    fetchStates.and.callFake(() =>
      ++calls === 1 ? Promise.reject(new Error('HTTP 500')) : Promise.resolve([]),
    );
    start();

    selected$.next('agent-A');
    flushMicrotasks();
    expect(error).toHaveBeenCalledTimes(1);
    expect(emitted.length).toBe(0);

    selected$.next('agent-B');
    flushMicrotasks();
    expect(fetchStates).toHaveBeenCalledTimes(2);
    expect(emitted.length).toBe(1);
    expect(sub.closed).toBeFalse();
  }));

  it('a newer selection supersedes an older fetch still in flight', fakeAsync(() => {
    const releases: ((m: AkgenticMessage[]) => void)[] = [];
    fetchStates.and.callFake(
      () => new Promise<AkgenticMessage[]>((r) => releases.push(r)),
    );
    const older = [{ id: 'older' } as AkgenticMessage];
    const newer = [{ id: 'newer' } as AkgenticMessage];
    start();

    selected$.next('agent-A');
    selected$.next('agent-B');
    releases[1](newer);
    releases[0](older);
    flushMicrotasks();

    expect(emitted).toEqual([newer]);
  }));

  it('unsubscribing mid-fetch drops the response', fakeAsync(() => {
    let release: (m: AkgenticMessage[]) => void = () => undefined;
    fetchStates.and.returnValue(
      new Promise<AkgenticMessage[]>((r) => {
        release = r;
      }),
    );
    start();
    selected$.next('agent-A');

    sub.unsubscribe();
    release([]);
    flushMicrotasks();

    expect(emitted.length).toBe(0);
  }));
});
