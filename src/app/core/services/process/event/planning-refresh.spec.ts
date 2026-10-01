import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { BehaviorSubject, Subject, Subscription } from 'rxjs';

import {
  AkgenticMessage,
  EVENT_MESSAGE_MODEL,
} from '../../../protocol/message.types';
import {
  findPlanningActorId,
  isPlanningUpdateReturn,
  PLANNING_ACTOR_NAME,
  PLANNING_REFRESH_DEBOUNCE_MS,
  PLANNING_UPDATE_TOOL,
  planningActorId,
  planningRefresh,
} from './planning-refresh';

const TOOL_RETURN_MODEL = 'akgentic.llm.event.ToolReturnEvent';
const TOOL_CALL_MODEL = 'akgentic.llm.event.ToolCallEvent';
const START_MODEL = 'akgentic.core.messages.orchestrator.StartMessage';

const PLANNING_ID = 'planning-actor-uuid';
const MANAGER_ID = 'manager-1';

let seq = 0;

function address(name: string, agentId: string): any {
  return {
    __actor_address__: true,
    name,
    role: name === PLANNING_ACTOR_NAME ? 'ToolActor' : 'Manager',
    agent_id: agentId,
    team_id: 'team-1',
    squad_id: 'squad-1',
    user_message: false,
  };
}

/** A tool event as the CALLING agent (`@Manager`) puts it on the wire. */
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
    sender: address('@Manager', MANAGER_ID),
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

/** The roster entry the graph builds a node from. */
function startMessage(name: string, agentId: string): AkgenticMessage {
  seq++;
  return {
    id: 'start-' + seq,
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-10-01T10:00:00Z',
    sender: address(name, agentId),
    display_type: 'other',
    content: null,
    __model__: START_MODEL,
    config: {},
    parent: null,
  } as unknown as AkgenticMessage;
}

describe('findPlanningActorId / planningActorId', () => {
  it('reads the agent_id of the #PlanningTool StartMessage', () => {
    expect(
      findPlanningActorId([
        startMessage('@Manager', MANAGER_ID),
        startMessage(PLANNING_ACTOR_NAME, PLANNING_ID),
      ]),
    ).toBe(PLANNING_ID);
  });

  it('is null for a team with no planning actor', () => {
    expect(findPlanningActorId([startMessage('@Manager', MANAGER_ID)])).toBeNull();
    expect(findPlanningActorId([])).toBeNull();
  });

  it('ignores a planning-tool message that is not a StartMessage', () => {
    const notStart = {
      ...toolEvent(PLANNING_UPDATE_TOOL),
      sender: address(PLANNING_ACTOR_NAME, PLANNING_ID),
    } as AkgenticMessage;
    expect(findPlanningActorId([notStart])).toBeNull();
  });

  it('emits the id once per distinct value, and nothing before it is known', () => {
    const log$ = new BehaviorSubject<AkgenticMessage[]>([]);
    const ids: string[] = [];
    const sub = planningActorId(log$).subscribe((id) => ids.push(id));

    log$.next([startMessage('@Manager', MANAGER_ID)]);
    expect(ids).toEqual([]);

    const start = startMessage(PLANNING_ACTOR_NAME, PLANNING_ID);
    log$.next([start]);
    log$.next([start, toolEvent(PLANNING_UPDATE_TOOL)]);
    expect(ids).toEqual([PLANNING_ID]);
    sub.unsubscribe();
  });
});

describe('planningRefresh', () => {
  let planningId$: Subject<string>;
  let messages$: Subject<AkgenticMessage>;
  let fetchStates: jasmine.Spy<(agentId: string) => Promise<AkgenticMessage[]>>;
  let emitted: AkgenticMessage[][];
  let sub: Subscription;

  beforeEach(() => {
    planningId$ = new Subject<string>();
    messages$ = new Subject<AkgenticMessage>();
    fetchStates = jasmine.createSpy('fetchStates').and.resolveTo([]);
    emitted = [];
  });

  afterEach(() => sub?.unsubscribe());

  function start(): void {
    sub = planningRefresh(planningId$, messages$, fetchStates).subscribe((m) =>
      emitted.push(m),
    );
  }

  /** Start, announce the planning id, and settle its arrival fetch. */
  function startKnown(): void {
    start();
    planningId$.next(PLANNING_ID);
    flushMicrotasks();
    fetchStates.calls.reset();
    emitted = [];
  }

  it('the trigger is the tool name akgentic-tool exposes', () => {
    expect(PLANNING_UPDATE_TOOL).toBe('update_planning');
  });

  it('the arrival of the planning id fetches at once, for that id', fakeAsync(() => {
    start();
    planningId$.next(PLANNING_ID);

    // Immediate — not debounced.
    expect(fetchStates).toHaveBeenCalledOnceWith(PLANNING_ID);
    flushMicrotasks();
    expect(emitted.length).toBe(1);
  }));

  it('no planning actor → nothing is ever fetched', fakeAsync(() => {
    start();
    messages$.next(toolEvent(PLANNING_UPDATE_TOOL));
    tick(PLANNING_REFRESH_DEBOUNCE_MS * 2);
    flushMicrotasks();

    expect(fetchStates).not.toHaveBeenCalled();
  }));

  it('one planning return fetches once, after the debounce', fakeAsync(() => {
    startKnown();
    messages$.next(toolEvent(PLANNING_UPDATE_TOOL));

    tick(PLANNING_REFRESH_DEBOUNCE_MS - 1);
    expect(fetchStates).not.toHaveBeenCalled();
    tick(1);
    flushMicrotasks();

    expect(fetchStates).toHaveBeenCalledTimes(1);
    expect(emitted.length).toBe(1);
  }));

  it('the fetch id is the planning actor, never the write\'s sender', fakeAsync(() => {
    startKnown();
    // The return is emitted by `@Manager` (MANAGER_ID), the calling agent.
    messages$.next(toolEvent(PLANNING_UPDATE_TOOL));
    tick(PLANNING_REFRESH_DEBOUNCE_MS);
    flushMicrotasks();

    expect(fetchStates.calls.allArgs()).toEqual([[PLANNING_ID]]);
  }));

  it('a write before the id is known is neither queued nor lost: one fetch on arrival', fakeAsync(() => {
    start();
    messages$.next(toolEvent(PLANNING_UPDATE_TOOL));
    tick(PLANNING_REFRESH_DEBOUNCE_MS * 2);
    flushMicrotasks();
    expect(fetchStates).not.toHaveBeenCalled();

    planningId$.next(PLANNING_ID);
    tick(PLANNING_REFRESH_DEBOUNCE_MS * 2);
    flushMicrotasks();

    expect(fetchStates).toHaveBeenCalledOnceWith(PLANNING_ID);
  }));

  it('a burst of three returns fetches once', fakeAsync(() => {
    startKnown();
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
    startKnown();
    messages$.next(toolEvent('workspace_write'));
    messages$.next(toolEvent('get_planning_task'));
    tick(PLANNING_REFRESH_DEBOUNCE_MS * 2);
    flushMicrotasks();

    expect(fetchStates).not.toHaveBeenCalled();
  }));

  it('the CALL event and a failed return fetch nothing', fakeAsync(() => {
    startKnown();
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
    startKnown();
    const error = spyOn(console, 'error');
    // Rejected lazily: an eagerly built rejected promise is "unhandled" before
    // the refresh ever subscribes to it.
    let calls = 0;
    fetchStates.and.callFake(() =>
      ++calls === 1 ? Promise.reject(new Error('HTTP 500')) : Promise.resolve([]),
    );

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

  it('a failed arrival fetch does not end the stream', fakeAsync(() => {
    spyOn(console, 'error');
    fetchStates.and.callFake(() => Promise.reject(new Error('HTTP 500')));
    start();
    planningId$.next(PLANNING_ID);
    flushMicrotasks();

    fetchStates.and.resolveTo([]);
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
    planningId$.next(PLANNING_ID);

    messages$.next(toolEvent(PLANNING_UPDATE_TOOL));
    tick(PLANNING_REFRESH_DEBOUNCE_MS);
    flushMicrotasks();

    expect(sub.closed).toBeFalse();
  }));

  it('unsubscribing mid-fetch drops the response', fakeAsync(() => {
    startKnown();
    let release: (m: AkgenticMessage[]) => void = () => undefined;
    fetchStates.and.returnValue(
      new Promise<AkgenticMessage[]>((r) => {
        release = r;
      }),
    );
    messages$.next(toolEvent(PLANNING_UPDATE_TOOL));
    tick(PLANNING_REFRESH_DEBOUNCE_MS);
    expect(fetchStates).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
    release([]);
    flushMicrotasks();

    expect(emitted.length).toBe(0);
  }));

  it('unsubscribing drops a pending debounce', fakeAsync(() => {
    startKnown();
    messages$.next(toolEvent(PLANNING_UPDATE_TOOL));
    sub.unsubscribe();
    tick(PLANNING_REFRESH_DEBOUNCE_MS * 2);
    flushMicrotasks();

    expect(fetchStates).not.toHaveBeenCalled();
  }));

  it('a newer fetch supersedes an older one still in flight', fakeAsync(() => {
    startKnown();
    const releases: ((m: AkgenticMessage[]) => void)[] = [];
    fetchStates.and.callFake(
      () => new Promise<AkgenticMessage[]>((r) => releases.push(r)),
    );
    const older = [toolEvent('older')];
    const newer = [toolEvent('newer')];

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

  it('end to end over a log: the same id re-emitted fetches no more', fakeAsync(() => {
    const log$ = new BehaviorSubject<AkgenticMessage[]>([]);
    sub = planningRefresh(planningActorId(log$), messages$, fetchStates).subscribe(
      (m) => emitted.push(m),
    );
    const start = startMessage(PLANNING_ACTOR_NAME, PLANNING_ID);

    log$.next([start]);
    log$.next([start, toolEvent('noise')]);
    log$.next([start, toolEvent('noise'), toolEvent('more noise')]);
    flushMicrotasks();

    expect(fetchStates).toHaveBeenCalledOnceWith(PLANNING_ID);
  }));
});
