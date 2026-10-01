import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { Subject, Subscription } from 'rxjs';

import {
  AkgenticMessage,
  EVENT_MESSAGE_MODEL,
} from '../../../protocol/message.types';
import {
  isPlanningUpdateReturn,
  PLANNING_REFRESH_DEBOUNCE_MS,
  PLANNING_UPDATE_TOOL,
  planningRefresh,
} from './planning-refresh';

const TOOL_RETURN_MODEL = 'akgentic.llm.event.ToolReturnEvent';
const TOOL_CALL_MODEL = 'akgentic.llm.event.ToolCallEvent';

let seq = 0;

/** A tool event as the CALLING agent puts it on the wire. */
function toolEvent(
  toolName: string,
  model: string = TOOL_RETURN_MODEL,
  success = true,
): AkgenticMessage {
  seq++;
  return {
    id: 'evt-' + seq,
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-10-01T10:00:00Z',
    sender: {
      __actor_address__: true,
      name: '@Manager',
      role: 'Manager',
      agent_id: 'manager-1',
      team_id: 'team-1',
      squad_id: 'squad-1',
      user_message: false,
    },
    display_type: 'other',
    content: null,
    __model__: EVENT_MESSAGE_MODEL,
    event: {
      __model__: model,
      run_id: 'run-1',
      tool_name: toolName,
      tool_call_id: 'call-' + seq,
      success,
    },
  } as AkgenticMessage;
}

describe('planningRefresh', () => {
  let messages$: Subject<AkgenticMessage>;
  let fetchStates: jasmine.Spy<() => Promise<AkgenticMessage[]>>;
  let emitted: AkgenticMessage[][];
  let sub: Subscription;

  beforeEach(() => {
    messages$ = new Subject<AkgenticMessage>();
    fetchStates = jasmine.createSpy('fetchStates').and.resolveTo([]);
    emitted = [];
  });

  afterEach(() => sub?.unsubscribe());

  function start(): void {
    sub = planningRefresh(messages$, fetchStates).subscribe((m) =>
      emitted.push(m),
    );
  }

  it('the trigger is the tool name akgentic-tool exposes', () => {
    expect(PLANNING_UPDATE_TOOL).toBe('update_planning');
  });

  it('one planning return fetches once, after the debounce', fakeAsync(() => {
    start();
    messages$.next(toolEvent(PLANNING_UPDATE_TOOL));

    tick(PLANNING_REFRESH_DEBOUNCE_MS - 1);
    expect(fetchStates).not.toHaveBeenCalled();
    tick(1);
    flushMicrotasks();

    expect(fetchStates).toHaveBeenCalledTimes(1);
    expect(emitted.length).toBe(1);
  }));

  it('a burst of three returns fetches once', fakeAsync(() => {
    start();
    messages$.next(toolEvent(PLANNING_UPDATE_TOOL));
    tick(50);
    messages$.next(toolEvent(PLANNING_UPDATE_TOOL));
    tick(50);
    messages$.next(toolEvent(PLANNING_UPDATE_TOOL));
    tick(PLANNING_REFRESH_DEBOUNCE_MS);
    flushMicrotasks();

    expect(fetchStates).toHaveBeenCalledTimes(1);
  }));

  it('other tool returns fetch nothing', fakeAsync(() => {
    start();
    messages$.next(toolEvent('workspace_write'));
    messages$.next(toolEvent('get_planning_task'));
    tick(PLANNING_REFRESH_DEBOUNCE_MS * 2);
    flushMicrotasks();

    expect(fetchStates).not.toHaveBeenCalled();
  }));

  it('the CALL event and a failed return fetch nothing', fakeAsync(() => {
    start();
    messages$.next(toolEvent(PLANNING_UPDATE_TOOL, TOOL_CALL_MODEL));
    messages$.next(toolEvent(PLANNING_UPDATE_TOOL, TOOL_RETURN_MODEL, false));
    tick(PLANNING_REFRESH_DEBOUNCE_MS * 2);
    flushMicrotasks();

    expect(fetchStates).not.toHaveBeenCalled();
  }));

  it('a non-event message is not a planning return', () => {
    expect(
      isPlanningUpdateReturn({
        __model__: 'akgentic.core.messages.orchestrator.StateChangedMessage',
      } as AkgenticMessage),
    ).toBeFalse();
  });

  it('a failed fetch is logged and the next write still refetches', fakeAsync(() => {
    const error = spyOn(console, 'error');
    // Rejected lazily: an eagerly built rejected promise is "unhandled" before
    // the refresh ever subscribes to it.
    let calls = 0;
    fetchStates.and.callFake(() =>
      ++calls === 1 ? Promise.reject(new Error('HTTP 500')) : Promise.resolve([]),
    );
    start();

    messages$.next(toolEvent(PLANNING_UPDATE_TOOL));
    tick(PLANNING_REFRESH_DEBOUNCE_MS);
    flushMicrotasks();
    expect(error).toHaveBeenCalledTimes(1);
    expect(emitted.length).toBe(0);

    messages$.next(toolEvent(PLANNING_UPDATE_TOOL));
    tick(PLANNING_REFRESH_DEBOUNCE_MS);
    flushMicrotasks();
    expect(fetchStates).toHaveBeenCalledTimes(2);
    expect(emitted.length).toBe(1);
  }));

  it('a fetch that throws synchronously does not end the stream', fakeAsync(() => {
    spyOn(console, 'error');
    fetchStates.and.callFake(() => {
      throw new Error('boom');
    });
    start();

    messages$.next(toolEvent(PLANNING_UPDATE_TOOL));
    tick(PLANNING_REFRESH_DEBOUNCE_MS);
    flushMicrotasks();

    expect(sub.closed).toBeFalse();
  }));

  it('unsubscribing mid-fetch drops the response', fakeAsync(() => {
    let release: (m: AkgenticMessage[]) => void = () => undefined;
    fetchStates.and.returnValue(
      new Promise<AkgenticMessage[]>((r) => {
        release = r;
      }),
    );
    start();
    messages$.next(toolEvent(PLANNING_UPDATE_TOOL));
    tick(PLANNING_REFRESH_DEBOUNCE_MS);
    expect(fetchStates).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
    release([]);
    flushMicrotasks();

    expect(emitted.length).toBe(0);
  }));

  it('a newer fetch supersedes an older one still in flight', fakeAsync(() => {
    const releases: ((m: AkgenticMessage[]) => void)[] = [];
    fetchStates.and.callFake(
      () => new Promise<AkgenticMessage[]>((r) => releases.push(r)),
    );
    const older = [toolEvent('older')];
    const newer = [toolEvent('newer')];
    start();

    messages$.next(toolEvent(PLANNING_UPDATE_TOOL));
    tick(PLANNING_REFRESH_DEBOUNCE_MS);
    messages$.next(toolEvent(PLANNING_UPDATE_TOOL));
    tick(PLANNING_REFRESH_DEBOUNCE_MS);
    expect(fetchStates).toHaveBeenCalledTimes(2);

    releases[1](newer);
    releases[0](older);
    flushMicrotasks();

    expect(emitted).toEqual([newer]);
  }));
});
