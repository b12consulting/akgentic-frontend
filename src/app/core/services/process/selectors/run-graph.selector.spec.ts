import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';

import {
  ActorAddress,
  AkgenticMessage,
  BaseMessage,
  EventMessage,
  HandledMessage,
  ProcessedMessage,
  ReceivedMessage,
  SentMessage,
  StartMessage,
  StateChangedMessage,
} from '../../../protocol/message.types';
import { MessageLogService } from '../event/message-log.service';
import {
  ancestors,
  childKeys,
  descendants,
  EMPTY_RUN_GRAPH,
  isHumanSeat,
  messageChips,
  pickedUpAt,
  Run,
  RunGraph,
  runGraphFold,
  RunGraphService,
  runGraphStep,
  RunKey,
  runKey,
  runsOf,
  runStatus,
  silent,
  traceRootOf,
} from './run-graph.selector';

// ---------------------------------------------------------------------------
// Builders: real wire shapes (message.types.ts). Timestamps are whole seconds
// from a fixed origin, so `at(n)` is both the wire string and the Date.
// ---------------------------------------------------------------------------

const ORIGIN = Date.UTC(2026, 8, 30, 10, 0, 0);
const ORCH = 'akgentic.core.messages.orchestrator';

function ts(n: number): string {
  return new Date(ORIGIN + n * 1000).toISOString();
}

function at(n: number): Date {
  return new Date(ts(n));
}

function addr(name: string, role: string, agentId: string): ActorAddress {
  return {
    __actor_address__: true,
    name,
    role,
    agent_id: agentId,
    squad_id: 'squad-1',
    user_message: false,
  };
}

const HUMAN = addr('@Human', 'Human', 'human-id');
const MANAGER = addr('@Manager', 'Manager', 'manager-id');
const LEAD = addr('@Lead', 'Manager', 'lead-id');
const EXPERT = addr('@Expert', 'Expert', 'expert-id');
const ASSISTANT = addr('@Assistant', 'Assistant', 'assistant-id');
const SUPPORT = addr('@Support', 'Human', 'support-id');

function envelope(
  id: string,
  sender: ActorAddress,
  parentId: string | null,
  t: number,
): Omit<BaseMessage, '__model__'> {
  return {
    id,
    parent_id: parentId,
    team_id: 'team-1',
    timestamp: ts(t),
    sender,
    display_type: 'other',
    content: null,
  };
}

function sent(
  id: string,
  from: ActorAddress,
  to: ActorAddress,
  parentId: string | null,
  t: number,
  innerModel = `${ORCH}.UserMessage`,
): SentMessage {
  return {
    ...envelope(`env-${id}-${to.agent_id}`, from, parentId, t),
    __model__: `${ORCH}.SentMessage`,
    message: {
      ...envelope(id, from, parentId, t),
      display_type: 'ai',
      content: `content of ${id}`,
      __model__: innerModel,
    },
    recipient: to,
  };
}

/** `parent_id === message_id`: `on_receive` sets the current message first. */
function received(id: string, agent: ActorAddress, t: number): ReceivedMessage {
  return {
    ...envelope(`rcv-${id}-${agent.agent_id}`, agent, id, t),
    __model__: `${ORCH}.ReceivedMessage`,
    message_id: id,
  };
}

function processed(id: string, agent: ActorAddress, t: number): ProcessedMessage {
  return {
    ...envelope(`proc-${id}-${agent.agent_id}`, agent, id, t),
    __model__: `${ORCH}.ProcessedMessage`,
    message_id: id,
  };
}

function handled(
  id: string,
  agent: ActorAddress,
  parentId: string,
  t: number,
): HandledMessage {
  return {
    ...envelope(`hdl-${id}-${agent.agent_id}`, agent, parentId, t),
    __model__: `${ORCH}.HandledMessage`,
    message_id: id,
  };
}

function toolCall(
  callId: string,
  toolName: string,
  agent: ActorAddress,
  parentId: string,
  t: number,
): EventMessage {
  return {
    ...envelope(`evt-call-${callId}`, agent, parentId, t),
    __model__: `${ORCH}.EventMessage`,
    event: {
      __model__: 'akgentic.llm.event.ToolCallEvent',
      run_id: 'llm-run',
      tool_name: toolName,
      tool_call_id: callId,
      arguments: '{}',
    },
  };
}

function toolReturn(
  callId: string,
  toolName: string,
  agent: ActorAddress,
  parentId: string,
  t: number,
  success = true,
): EventMessage {
  return {
    ...envelope(`evt-ret-${callId}`, agent, parentId, t),
    __model__: `${ORCH}.EventMessage`,
    event: {
      __model__: 'akgentic.llm.event.ToolReturnEvent',
      run_id: 'llm-run',
      tool_name: toolName,
      tool_call_id: callId,
      success,
    },
  };
}

function k(messageId: string, agent: ActorAddress): RunKey {
  return runKey(messageId, agent.agent_id);
}

function run(graph: RunGraph, key: RunKey): Run {
  const r = graph.runs.get(key);
  if (r === undefined) throw new Error(`no run ${key}`);
  return r;
}

function keys(graph: RunGraph): RunKey[] {
  return [...graph.runs.keys()];
}

function parentsOf(graph: RunGraph): Record<RunKey, RunKey | null> {
  const out: Record<RunKey, RunKey | null> = {};
  for (const r of graph.runs.values()) out[r.key] = r.parent_key;
  return out;
}

function rootsOf(graph: RunGraph): Record<RunKey, RunKey> {
  const out: Record<RunKey, RunKey> = {};
  for (const r of graph.runs.values()) out[r.key] = traceRootOf(graph, r.key);
  return out;
}

function silentRuns(graph: RunGraph): RunKey[] {
  return keys(graph).filter((key) => silent(graph, key));
}

function absorbedMap(graph: RunGraph): Record<string, RunKey> {
  const out: Record<string, RunKey> = {};
  for (const m of graph.messages.values()) {
    if (m.absorbed_by !== null) out[m.id] = m.absorbed_by;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transitions (AC 3)
// ---------------------------------------------------------------------------

describe('runGraphStep — transitions', () => {
  it('SentMessage records the INNER message, keyed by the inner id', () => {
    const g = runGraphStep(EMPTY_RUN_GRAPH, sent('U1', HUMAN, MANAGER, null, 1));
    expect([...g.messages.keys()]).toEqual(['U1']);
    const m = g.messages.get('U1')!;
    expect(m.sender).toEqual(HUMAN);
    expect(m.recipient).toEqual(MANAGER);
    expect(m.parent_id).toBeNull();
    expect(m.timestamp).toEqual(at(1));
    expect(m.content).toBe('content of U1');
    expect(m.absorbed_by).toBeNull();
    expect(g.messages.has('env-U1-manager-id')).toBeFalse();
  });

  it('SentMessage appends a sent step to run (message.parent_id, sender)', () => {
    const g = runGraphFold([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('D1', MANAGER, EXPERT, 'U1', 3),
    ]);
    expect(run(g, k('U1', MANAGER)).steps[1]).toEqual({
      kind: 'sent',
      at: at(3),
      message_id: 'D1',
      recipient: EXPERT,
    });
  });

  it('ReceivedMessage opens run (message_id, sender) with status running', () => {
    const g = runGraphFold([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
    ]);
    expect(run(g, k('U1', MANAGER))).toEqual({
      key: k('U1', MANAGER),
      message_id: 'U1',
      agent: MANAGER,
      trigger_id: 'U1',
      parent_key: null,
      start: at(2),
      end: null,
      steps: [{ kind: 'received', at: at(2) }],
      status: 'running',
    });
  });

  it('ToolCallEvent appends a tool step to run (parent_id, sender)', () => {
    const g = runGraphFold([
      received('U1', MANAGER, 2),
      toolCall('t1', 'search', MANAGER, 'U1', 3),
    ]);
    expect(run(g, k('U1', MANAGER)).steps[1]).toEqual({
      kind: 'tool',
      at: at(3),
      tool_call_id: 't1',
      tool_name: 'search',
      done: false,
      success: null,
    });
  });

  it('ToolReturnEvent marks the step with that tool_call_id done and records success', () => {
    const g = runGraphFold([
      received('U1', MANAGER, 2),
      toolCall('t1', 'search', MANAGER, 'U1', 3),
      toolCall('t2', 'read', MANAGER, 'U1', 4),
      toolReturn('t1', 'search', MANAGER, 'U1', 5, false),
    ]);
    const steps = run(g, k('U1', MANAGER)).steps;
    expect(steps[1]).toEqual(
      jasmine.objectContaining({ tool_call_id: 't1', done: true, success: false }),
    );
    expect(steps[2]).toEqual(
      jasmine.objectContaining({ tool_call_id: 't2', done: false, success: null }),
    );
  });

  it('HandledMessage sets absorbed_by and appends an absorbed step', () => {
    const g = runGraphFold([
      received('U1', MANAGER, 2),
      sent('U2', HUMAN, MANAGER, null, 3),
      handled('U2', MANAGER, 'U1', 4),
    ]);
    expect(g.messages.get('U2')!.absorbed_by).toBe(k('U1', MANAGER));
    expect(run(g, k('U1', MANAGER)).steps[1]).toEqual({
      kind: 'absorbed',
      at: at(4),
      message_id: 'U2',
    });
  });

  it('ProcessedMessage closes run (message_id, sender)', () => {
    const g = runGraphFold([received('U1', MANAGER, 2), processed('U1', MANAGER, 5)]);
    const r = run(g, k('U1', MANAGER));
    expect(r.status).toBe('done');
    expect(r.end).toEqual(at(5));
    expect(r.steps[r.steps.length - 1]).toEqual({ kind: 'processed', at: at(5) });
  });

  it('runGraphFold is deterministic', () => {
    const log = [
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      processed('U1', MANAGER, 3),
    ];
    expect(runGraphFold(log)).toEqual(runGraphFold(log));
  });
});

// ---------------------------------------------------------------------------
// Passthrough (AC 4): the SAME reference
// ---------------------------------------------------------------------------

describe('runGraphStep — passthrough returns the same reference', () => {
  const base = runGraphFold([
    sent('U1', HUMAN, MANAGER, null, 1),
    received('U1', MANAGER, 2),
  ]);

  it('StartMessage', () => {
    const start: StartMessage = {
      ...envelope('start-1', MANAGER, null, 0),
      __model__: `${ORCH}.StartMessage`,
      config: {
        name: '@Manager',
        role: 'Manager',
        user_id: 'u',
        user_email: 'u@example.com',
        squad_id: 'squad-1',
        orchestrator: MANAGER,
      },
      parent: null,
    };
    expect(runGraphStep(base, start)).toBe(base);
  });

  it('StateChangedMessage', () => {
    const msg: StateChangedMessage = {
      ...envelope('sc-1', MANAGER, 'U1', 3),
      __model__: `${ORCH}.StateChangedMessage`,
      state: { phase: 'x' },
    };
    expect(runGraphStep(base, msg)).toBe(base);
  });

  it('an EventMessage with a non-tool inner event', () => {
    const msg: EventMessage = {
      ...envelope('evt-1', MANAGER, 'U1', 3),
      __model__: `${ORCH}.EventMessage`,
      event: { __model__: 'akgentic.llm.event.LlmMessageEvent' },
    };
    expect(runGraphStep(base, msg)).toBe(base);
  });

  it('a ToolStateEvent (out of scope: its parent_id is unverified)', () => {
    const msg: EventMessage = {
      ...envelope('evt-3', MANAGER, 'U1', 3),
      __model__: `${ORCH}.EventMessage`,
      event: {
        __model__: 'akgentic.tool.event.ToolStateEvent',
        tool_call_id: 't1',
        tool_name: 'search',
      },
    };
    expect(runGraphStep(base, msg)).toBe(base);
  });

  it('an EventMessage with no event', () => {
    const msg = {
      ...envelope('evt-2', MANAGER, 'U1', 3),
      __model__: `${ORCH}.EventMessage`,
    } as EventMessage;
    expect(runGraphStep(base, msg)).toBe(base);
  });

  it('a message with no __model__', () => {
    const msg = { ...envelope('x', MANAGER, 'U1', 3) } as AkgenticMessage;
    expect(runGraphStep(base, msg)).toBe(base);
  });

  it('a tool return for an unknown run', () => {
    expect(runGraphStep(base, toolReturn('t9', 'x', EXPERT, 'U1', 3))).toBe(base);
  });

  it('a tool return with an unknown tool_call_id on a known run', () => {
    expect(runGraphStep(base, toolReturn('t9', 'x', MANAGER, 'U1', 3))).toBe(base);
  });

  it('a tool call for an unknown run', () => {
    expect(runGraphStep(base, toolCall('t1', 'x', MANAGER, 'Z', 3))).toBe(base);
  });

  it('a duplicate ReceivedMessage for an already-open key', () => {
    expect(runGraphStep(base, received('U1', MANAGER, 9))).toBe(base);
  });

  it('a ProcessedMessage for an unknown run', () => {
    expect(runGraphStep(base, processed('Z', MANAGER, 3))).toBe(base);
  });

  it('a second ProcessedMessage for a closed run', () => {
    const closed = runGraphStep(base, processed('U1', MANAGER, 3));
    expect(runGraphStep(closed, processed('U1', MANAGER, 4))).toBe(closed);
  });

  it('a HandledMessage whose run is unknown', () => {
    expect(runGraphStep(base, handled('U1', EXPERT, 'U1', 3))).toBe(base);
  });

  it('a HandledMessage whose message is unknown', () => {
    expect(runGraphStep(base, handled('Z', MANAGER, 'U1', 3))).toBe(base);
  });

  it('a repeat inner id whose sending run is unknown', () => {
    expect(runGraphStep(base, sent('U1', HUMAN, LEAD, null, 3))).toBe(base);
  });

  it('a ReceivedMessage with no sender, and a SentMessage with no inner message', () => {
    const noSender = { ...received('U2', MANAGER, 3), sender: undefined };
    expect(runGraphStep(base, noSender as unknown as ReceivedMessage)).toBe(base);
    const noInner = { ...sent('U2', HUMAN, MANAGER, null, 3), message: undefined };
    expect(runGraphStep(base, noInner as unknown as SentMessage)).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// Helpers (AC 5)
// ---------------------------------------------------------------------------

describe('run graph helpers', () => {
  // U1 → (U1,Manager) → (D1,Expert) → (D2,Assistant); plus a sibling (S,Support).
  const tree = runGraphFold([
    sent('U1', HUMAN, MANAGER, null, 1),
    received('U1', MANAGER, 2),
    sent('D1', MANAGER, EXPERT, 'U1', 3),
    sent('S', MANAGER, SUPPORT, 'U1', 4),
    received('D1', EXPERT, 5),
    received('S', SUPPORT, 6),
    sent('D2', EXPERT, ASSISTANT, 'D1', 7),
    received('D2', ASSISTANT, 8),
  ]);

  it('ancestors: parent first, root last, excluding the key', () => {
    expect(ancestors(tree, k('D2', ASSISTANT))).toEqual([
      k('D1', EXPERT),
      k('U1', MANAGER),
    ]);
    expect(ancestors(tree, k('D1', EXPERT))).toEqual([k('U1', MANAGER)]);
    expect(ancestors(tree, k('U1', MANAGER))).toEqual([]);
  });

  it('descendants: in runs insertion order, excluding the key', () => {
    expect(descendants(tree, k('U1', MANAGER))).toEqual([
      k('D1', EXPERT),
      k('S', SUPPORT),
      k('D2', ASSISTANT),
    ]);
    expect(descendants(tree, k('D1', EXPERT))).toEqual([k('D2', ASSISTANT)]);
    expect(descendants(tree, k('D2', ASSISTANT))).toEqual([]);
  });

  it('ancestors and traceRootOf terminate on a cycle', () => {
    const a = run(tree, k('D1', EXPERT));
    const b = run(tree, k('D2', ASSISTANT));
    const cyclic: RunGraph = {
      messages: new Map(),
      runs: new Map([
        [a.key, { ...a, parent_key: b.key }],
        [b.key, { ...b, parent_key: a.key }],
      ]),
    };
    expect(ancestors(cyclic, a.key)).toEqual([b.key]);
    // a → b → (a, visited): the walk stops on the last run it reached.
    expect(traceRootOf(cyclic, a.key)).toBe(b.key);
    expect(descendants(cyclic, a.key)).toEqual([b.key]);
  });

  it('descendants follows runs insertion order, not tree depth', () => {
    // (D2,Assistant) starts before its uncle (S,Support): a breadth-first walk
    // would list S first.
    const g = runGraphFold([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('D1', MANAGER, EXPERT, 'U1', 3),
      sent('S', MANAGER, SUPPORT, 'U1', 4),
      received('D1', EXPERT, 5),
      sent('D2', EXPERT, ASSISTANT, 'D1', 6),
      received('D2', ASSISTANT, 7),
      received('S', SUPPORT, 8),
    ]);
    expect(descendants(g, k('U1', MANAGER))).toEqual([
      k('D1', EXPERT),
      k('D2', ASSISTANT),
      k('S', SUPPORT),
    ]);
    expect(descendants(g, k('nope', MANAGER))).toEqual([]);
  });

  it('traceRootOf uses the Human ROLE: a Send-as sender not named @Human opens a trace', () => {
    const alice = addr('@Alice', 'Human', 'alice-id');
    const g = runGraphFold([
      sent('U1', alice, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('D1', MANAGER, EXPERT, 'U1', 3),
      received('D1', EXPERT, 4),
      sent('R1', EXPERT, MANAGER, 'D1', 5),
      received('R1', MANAGER, 6),
    ]);
    // (R1,Manager) → (D1,Expert) → (U1,Manager): the walk must stop at the
    // run triggered by @Alice, not run on to the top.
    expect(traceRootOf(g, k('R1', MANAGER))).toBe(k('U1', MANAGER));
    expect(traceRootOf(g, k('D1', EXPERT))).toBe(k('U1', MANAGER));
  });

  it('traceRootOf: a run whose parent is unresolved is its own root (fail-open)', () => {
    const g = runGraphFold([
      // Replay beginning mid-conversation: D1 was sent by a run we never saw.
      sent('D1', MANAGER, EXPERT, 'X', 1),
      received('D1', EXPERT, 2),
      // And a run whose trigger we never saw at all.
      received('D9', ASSISTANT, 3),
    ]);
    expect(run(g, k('D1', EXPERT)).parent_key).toBe(k('X', MANAGER));
    expect(ancestors(g, k('D1', EXPERT))).toEqual([]);
    expect(traceRootOf(g, k('D1', EXPERT))).toBe(k('D1', EXPERT));
    expect(run(g, k('D9', ASSISTANT)).parent_key).toBeNull();
    expect(traceRootOf(g, k('D9', ASSISTANT))).toBe(k('D9', ASSISTANT));
  });

  it('messageChips groups sent steps by recipient in first-send order', () => {
    const g = runGraphFold([
      received('U1', MANAGER, 1),
      sent('A1', MANAGER, HUMAN, 'U1', 2),
      sent('D1', MANAGER, EXPERT, 'U1', 3),
      sent('A2', MANAGER, HUMAN, 'U1', 4),
    ]);
    expect(messageChips(g, k('U1', MANAGER))).toEqual([
      { recipient: HUMAN, count: 2 },
      { recipient: EXPERT, count: 1 },
    ]);
    expect(messageChips(g, k('nope', MANAGER))).toEqual([]);
  });

  it('silent: done, no sent step, not Human-role', () => {
    const g = runGraphFold([
      received('R1', MANAGER, 1),
      processed('R1', MANAGER, 2),
      received('R2', MANAGER, 3),
      sent('A', MANAGER, HUMAN, 'R2', 4),
      processed('R2', MANAGER, 5),
      received('R3', MANAGER, 6),
      received('A', HUMAN, 7),
      processed('A', HUMAN, 8),
    ]);
    expect(silent(g, k('R1', MANAGER))).toBeTrue();
    expect(silent(g, k('R2', MANAGER))).toBeFalse(); // sent something
    expect(silent(g, k('R3', MANAGER))).toBeFalse(); // still running
    expect(silent(g, k('A', HUMAN))).toBeFalse(); // Human-role
    expect(silent(g, k('nope', HUMAN))).toBeFalse();
  });

  it('isHumanSeat: Human role, not the entry point', () => {
    const g = runGraphFold([received('S', SUPPORT, 1), received('Q', HUMAN, 2)]);
    expect(isHumanSeat(run(g, k('S', SUPPORT)))).toBeTrue();
    expect(isHumanSeat(run(g, k('Q', HUMAN)))).toBeFalse();
    expect(isHumanSeat(run(tree, k('U1', MANAGER)))).toBeFalse();
  });

  it('runStatus: a seat goes waiting → answered; other runs report the stored status', () => {
    const prefix = [
      received('U1', MANAGER, 1),
      sent('S', MANAGER, SUPPORT, 'U1', 2),
      received('S', SUPPORT, 3),
      processed('S', SUPPORT, 4),
    ];
    const waiting = runGraphFold(prefix);
    expect(runStatus(waiting, k('S', SUPPORT))).toBe('waiting');
    expect(runStatus(waiting, k('U1', MANAGER))).toBe('running');
    const answered = runGraphFold([...prefix, sent('Sa', SUPPORT, MANAGER, 'S', 5)]);
    expect(runStatus(answered, k('S', SUPPORT))).toBe('answered');
    expect(runStatus(answered, k('nope', SUPPORT))).toBeNull();
  });

  it('pickedUpAt is null for an unknown or unread message', () => {
    expect(pickedUpAt(tree, 'nope')).toBeNull();
    const g = runGraphFold([sent('U1', HUMAN, MANAGER, null, 1)]);
    expect(pickedUpAt(g, 'U1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The seven mockup cases (AC 6)
// ---------------------------------------------------------------------------

describe('case 1 — direct answer', () => {
  const g = runGraphFold([
    sent('U1', HUMAN, MANAGER, null, 1),
    received('U1', MANAGER, 2),
    toolCall('t1', 'search', MANAGER, 'U1', 3),
    toolReturn('t1', 'search', MANAGER, 'U1', 4),
    sent('A1', MANAGER, HUMAN, 'U1', 5),
    processed('U1', MANAGER, 6),
    received('A1', HUMAN, 7),
    processed('A1', HUMAN, 8),
  ]);

  it('runs, parents, roots, silence, absorption, pick-up', () => {
    expect(keys(g)).toEqual([k('U1', MANAGER), k('A1', HUMAN)]);
    expect(parentsOf(g)).toEqual({
      [k('U1', MANAGER)]: null,
      [k('A1', HUMAN)]: k('U1', MANAGER),
    });
    expect(rootsOf(g)).toEqual({
      [k('U1', MANAGER)]: k('U1', MANAGER),
      [k('A1', HUMAN)]: k('U1', MANAGER),
    });
    expect(absorbedMap(g)).toEqual({});
    expect(silentRuns(g)).toEqual([]);
    expect(pickedUpAt(g, 'U1')).toEqual(at(2));
  });
});

describe('case 2 — fan-out, replies queued; @Manager runs 3 times', () => {
  const g = runGraphFold([
    sent('U1', HUMAN, MANAGER, null, 1),
    received('U1', MANAGER, 2),
    sent('De', MANAGER, EXPERT, 'U1', 3),
    sent('Da', MANAGER, ASSISTANT, 'U1', 4),
    processed('U1', MANAGER, 5),
    received('De', EXPERT, 6),
    received('Da', ASSISTANT, 7),
    sent('Re', EXPERT, MANAGER, 'De', 8),
    processed('De', EXPERT, 9),
    sent('Ra', ASSISTANT, MANAGER, 'Da', 10),
    processed('Da', ASSISTANT, 11),
    received('Re', MANAGER, 12),
    processed('Re', MANAGER, 13),
    received('Ra', MANAGER, 14),
    sent('A', MANAGER, HUMAN, 'Ra', 15),
    processed('Ra', MANAGER, 16),
  ]);

  it('runs, parents, roots, silence, absorption, pick-up', () => {
    expect(keys(g)).toEqual([
      k('U1', MANAGER),
      k('De', EXPERT),
      k('Da', ASSISTANT),
      k('Re', MANAGER),
      k('Ra', MANAGER),
    ]);
    // Edges come from parent_id only: each reply-triggered run hangs under
    // the replier's run, not under an inferred join.
    expect(parentsOf(g)).toEqual({
      [k('U1', MANAGER)]: null,
      [k('De', EXPERT)]: k('U1', MANAGER),
      [k('Da', ASSISTANT)]: k('U1', MANAGER),
      [k('Re', MANAGER)]: k('De', EXPERT),
      [k('Ra', MANAGER)]: k('Da', ASSISTANT),
    });
    for (const root of Object.values(rootsOf(g))) expect(root).toBe(k('U1', MANAGER));
    expect(absorbedMap(g)).toEqual({});
    expect(silentRuns(g)).toEqual([k('Re', MANAGER)]);
    expect(pickedUpAt(g, 'U1')).toEqual(at(2));
  });
});

describe('case 3 — fan-in by absorption in a reply-triggered run', () => {
  const g = runGraphFold([
    sent('U1', HUMAN, MANAGER, null, 1),
    received('U1', MANAGER, 2),
    sent('De', MANAGER, EXPERT, 'U1', 3),
    sent('Da', MANAGER, ASSISTANT, 'U1', 4),
    processed('U1', MANAGER, 5),
    received('De', EXPERT, 6),
    received('Da', ASSISTANT, 7),
    sent('Ra', ASSISTANT, MANAGER, 'Da', 8),
    processed('Da', ASSISTANT, 9),
    received('Ra', MANAGER, 10),
    toolCall('t1', 'search', MANAGER, 'Ra', 11),
    sent('Re', EXPERT, MANAGER, 'De', 12),
    processed('De', EXPERT, 13),
    toolReturn('t1', 'search', MANAGER, 'Ra', 14),
    toolCall('t2', 'read_mailbox', MANAGER, 'Ra', 15),
    handled('Re', MANAGER, 'Ra', 16),
    toolReturn('t2', 'read_mailbox', MANAGER, 'Ra', 17),
    sent('A', MANAGER, HUMAN, 'Ra', 18),
    processed('Ra', MANAGER, 19),
  ]);

  it('runs, parents, roots, silence, absorption, pick-up', () => {
    expect(keys(g)).toEqual([
      k('U1', MANAGER),
      k('De', EXPERT),
      k('Da', ASSISTANT),
      k('Ra', MANAGER),
    ]);
    expect(parentsOf(g)).toEqual({
      [k('U1', MANAGER)]: null,
      [k('De', EXPERT)]: k('U1', MANAGER),
      [k('Da', ASSISTANT)]: k('U1', MANAGER),
      // The join adds no edge: R2 stays under the run that triggered it.
      [k('Ra', MANAGER)]: k('Da', ASSISTANT),
    });
    for (const root of Object.values(rootsOf(g))) expect(root).toBe(k('U1', MANAGER));
    expect(absorbedMap(g)).toEqual({ Re: k('Ra', MANAGER) });
    expect([...g.runs.values()].some((r) => r.message_id === 'Re')).toBeFalse();
    expect(run(g, k('Ra', MANAGER)).steps).toContain({
      kind: 'absorbed',
      at: at(16),
      message_id: 'Re',
    });
    expect(silentRuns(g)).toEqual([]);
    expect(pickedUpAt(g, 'U1')).toEqual(at(2));
    expect(pickedUpAt(g, 'Re')).toEqual(at(16));
  });
});

describe('case 4 — Manager asks you a question; your reply continues', () => {
  const g = runGraphFold([
    sent('U1', HUMAN, MANAGER, null, 1),
    received('U1', MANAGER, 2),
    sent('Q', MANAGER, HUMAN, 'U1', 3),
    processed('U1', MANAGER, 4),
    received('Q', HUMAN, 5),
    processed('Q', HUMAN, 6),
    sent('U2', HUMAN, MANAGER, 'Q', 7),
    received('U2', MANAGER, 8),
    sent('A', MANAGER, HUMAN, 'U2', 9),
    processed('U2', MANAGER, 10),
    received('A', HUMAN, 11),
    processed('A', HUMAN, 12),
  ]);
  const R2 = k('U2', MANAGER);

  it('runs, parents, roots, silence, absorption, pick-up', () => {
    expect(keys(g)).toEqual([k('U1', MANAGER), k('Q', HUMAN), R2, k('A', HUMAN)]);
    expect(parentsOf(g)).toEqual({
      [k('U1', MANAGER)]: null,
      [k('Q', HUMAN)]: k('U1', MANAGER),
      [R2]: k('Q', HUMAN),
      [k('A', HUMAN)]: R2,
    });
    // Your reply opens its own trace: its trigger's sender is Human-role.
    expect(rootsOf(g)).toEqual({
      [k('U1', MANAGER)]: k('U1', MANAGER),
      [k('Q', HUMAN)]: k('U1', MANAGER),
      [R2]: R2,
      [k('A', HUMAN)]: R2,
    });
    expect(ancestors(g, R2)).toEqual([k('Q', HUMAN), k('U1', MANAGER)]);
    expect(absorbedMap(g)).toEqual({});
    expect(silentRuns(g)).toEqual([]);
    expect(pickedUpAt(g, 'U1')).toEqual(at(2));
    expect(pickedUpAt(g, 'U2')).toEqual(at(8));
  });

  it('the entry-point run is not a human seat and not silent', () => {
    expect(isHumanSeat(run(g, k('Q', HUMAN)))).toBeFalse();
    expect(silent(g, k('Q', HUMAN))).toBeFalse();
    expect(runStatus(g, k('Q', HUMAN))).toBe('done');
  });
});

describe('case 5 — delegation chain, a human seat, a failed tool', () => {
  const beforeAnswer: AkgenticMessage[] = [
    sent('U1', HUMAN, MANAGER, null, 1),
    received('U1', MANAGER, 2),
    sent('D1', MANAGER, EXPERT, 'U1', 3),
    sent('S', MANAGER, SUPPORT, 'U1', 4),
    processed('U1', MANAGER, 5),
    received('S', SUPPORT, 6),
    processed('S', SUPPORT, 7),
    received('D1', EXPERT, 8),
    sent('D2', EXPERT, ASSISTANT, 'D1', 9),
    processed('D1', EXPERT, 10),
    received('D2', ASSISTANT, 11),
    toolCall('r1', 'workspace_read', ASSISTANT, 'D2', 12),
    toolReturn('r1', 'workspace_read', ASSISTANT, 'D2', 13, false),
    toolCall('l1', 'workspace_list', ASSISTANT, 'D2', 14),
    toolReturn('l1', 'workspace_list', ASSISTANT, 'D2', 15),
    toolCall('r2', 'workspace_read', ASSISTANT, 'D2', 16),
    toolReturn('r2', 'workspace_read', ASSISTANT, 'D2', 17),
    sent('C', ASSISTANT, EXPERT, 'D2', 18),
    processed('D2', ASSISTANT, 19),
    received('C', EXPERT, 20),
    toolCall('w1', 'workspace_write', EXPERT, 'C', 21),
    toolReturn('w1', 'workspace_write', EXPERT, 'C', 22),
    sent('B', EXPERT, MANAGER, 'C', 23),
    processed('C', EXPERT, 24),
    received('B', MANAGER, 25),
    toolCall('m1', 'plan', MANAGER, 'B', 26),
    toolReturn('m1', 'plan', MANAGER, 'B', 27),
    processed('B', MANAGER, 28),
  ];
  const g = runGraphFold([
    ...beforeAnswer,
    sent('Sa', SUPPORT, MANAGER, 'S', 29),
    received('Sa', MANAGER, 30),
    sent('A', MANAGER, HUMAN, 'Sa', 31),
    processed('Sa', MANAGER, 32),
  ]);
  const SEAT = k('S', SUPPORT);

  it('the parent of every run', () => {
    expect(parentsOf(g)).toEqual({
      [k('U1', MANAGER)]: null,
      [SEAT]: k('U1', MANAGER),
      [k('D1', EXPERT)]: k('U1', MANAGER),
      [k('D2', ASSISTANT)]: k('D1', EXPERT),
      [k('C', EXPERT)]: k('D2', ASSISTANT),
      [k('B', MANAGER)]: k('C', EXPERT),
      [k('Sa', MANAGER)]: SEAT,
    });
    expect(ancestors(g, k('B', MANAGER)).length).toBe(4);
  });

  it('every run shares the root (U1,Manager); the seat answer continues the trace', () => {
    for (const root of Object.values(rootsOf(g))) expect(root).toBe(k('U1', MANAGER));
  });

  it('a failed tool is not a failed run', () => {
    const r = run(g, k('D2', ASSISTANT));
    expect(r.steps.find((s) => s.kind === 'tool' && s.tool_call_id === 'r1')).toEqual(
      jasmine.objectContaining({ done: true, success: false }),
    );
    expect(r.status).toBe('done');
  });

  it('silence, the seat, absorption, pick-up', () => {
    expect(silentRuns(g)).toEqual([k('B', MANAGER)]);
    expect(isHumanSeat(run(g, SEAT))).toBeTrue();
    expect(silent(g, SEAT)).toBeFalse();
    expect(absorbedMap(g)).toEqual({});
    expect(pickedUpAt(g, 'U1')).toEqual(at(2));
  });

  it('the seat is waiting on the prefix and answered once its reply arrives', () => {
    expect(runStatus(runGraphFold(beforeAnswer), SEAT)).toBe('waiting');
    expect(runStatus(g, SEAT)).toBe('answered');
  });
});

describe('case 6 — you add a message mid-run and it is absorbed', () => {
  const g = runGraphFold([
    sent('U1', HUMAN, MANAGER, null, 1),
    received('U1', MANAGER, 2),
    toolCall('t1', 'search', MANAGER, 'U1', 3),
    sent('U2', HUMAN, MANAGER, null, 4),
    handled('U2', MANAGER, 'U1', 5),
    toolReturn('t1', 'search', MANAGER, 'U1', 6),
    sent('A', MANAGER, HUMAN, 'U1', 7),
    processed('U1', MANAGER, 8),
  ]);

  it('runs, parents, roots, silence, absorption, pick-up', () => {
    expect(keys(g)).toEqual([k('U1', MANAGER)]);
    expect(parentsOf(g)).toEqual({ [k('U1', MANAGER)]: null });
    expect(rootsOf(g)).toEqual({ [k('U1', MANAGER)]: k('U1', MANAGER) });
    expect(absorbedMap(g)).toEqual({ U2: k('U1', MANAGER) });
    expect(silentRuns(g)).toEqual([]);
    expect(pickedUpAt(g, 'U1')).toEqual(at(2));
    expect(pickedUpAt(g, 'U2')).toEqual(at(5));
  });
});

describe('case 7 — two follow-ups queued, each answered in its own later run', () => {
  const beforePickUp: AkgenticMessage[] = [
    sent('U1', HUMAN, MANAGER, null, 1),
    received('U1', MANAGER, 2),
    sent('D', MANAGER, EXPERT, 'U1', 3),
    processed('U1', MANAGER, 4),
    received('D', EXPERT, 5),
    sent('Re', EXPERT, MANAGER, 'D', 6),
    processed('D', EXPERT, 7),
    received('Re', MANAGER, 8),
    toolCall('t1', 'search', MANAGER, 'Re', 9),
    sent('U2', HUMAN, MANAGER, null, 10),
    sent('U3', HUMAN, MANAGER, null, 11),
    toolReturn('t1', 'search', MANAGER, 'Re', 12),
    sent('A1', MANAGER, HUMAN, 'Re', 13),
    processed('Re', MANAGER, 14),
  ];
  const g = runGraphFold([
    ...beforePickUp,
    received('U2', MANAGER, 15),
    sent('A2', MANAGER, HUMAN, 'U2', 16),
    processed('U2', MANAGER, 17),
    received('U3', MANAGER, 18),
    sent('A3', MANAGER, HUMAN, 'U3', 19),
    processed('U3', MANAGER, 20),
  ]);
  const R3 = k('U2', MANAGER);
  const R4 = k('U3', MANAGER);

  it('runs, parents, roots, silence, absorption', () => {
    expect(keys(g)).toEqual([k('U1', MANAGER), k('D', EXPERT), k('Re', MANAGER), R3, R4]);
    expect(parentsOf(g)).toEqual({
      [k('U1', MANAGER)]: null,
      [k('D', EXPERT)]: k('U1', MANAGER),
      [k('Re', MANAGER)]: k('D', EXPERT),
      [R3]: null,
      [R4]: null,
    });
    expect(rootsOf(g)).toEqual({
      [k('U1', MANAGER)]: k('U1', MANAGER),
      [k('D', EXPERT)]: k('U1', MANAGER),
      [k('Re', MANAGER)]: k('U1', MANAGER),
      [R3]: R3,
      [R4]: R4,
    });
    expect(absorbedMap(g)).toEqual({});
    expect(silentRuns(g)).toEqual([]);
  });

  it('the follow-ups are not picked up until their own ReceivedMessage', () => {
    const prefix = runGraphFold(beforePickUp);
    expect(pickedUpAt(prefix, 'U1')).toEqual(at(2));
    expect(pickedUpAt(prefix, 'U2')).toBeNull();
    expect(pickedUpAt(prefix, 'U3')).toBeNull();

    const a1 = g.messages.get('A1')!.timestamp;
    expect(pickedUpAt(g, 'U2')).toEqual(run(g, R3).start);
    expect(pickedUpAt(g, 'U2')!.getTime()).toBeGreaterThan(a1.getTime());
    expect(pickedUpAt(g, 'U3')).toEqual(run(g, R4).start);
    expect(pickedUpAt(g, 'U3')!.getTime()).toBeGreaterThan(a1.getTime());
  });
});

// ---------------------------------------------------------------------------
// Two supervisors (AC 7): the message id alone is not a run key
// ---------------------------------------------------------------------------

describe('two supervisors receive one inner message', () => {
  const g = runGraphFold([
    sent('M', HUMAN, MANAGER, null, 1),
    sent('M', HUMAN, LEAD, null, 1),
    received('M', MANAGER, 2),
    received('M', LEAD, 3),
    sent('D1', MANAGER, EXPERT, 'M', 4),
    sent('D2', LEAD, EXPERT, 'M', 5),
    received('D1', EXPERT, 6),
    received('D2', EXPERT, 7),
  ]);

  it('opens two runs under distinct keys, each parenting its own delegation', () => {
    expect(keys(g)).toEqual([
      k('M', MANAGER),
      k('M', LEAD),
      k('D1', EXPERT),
      k('D2', EXPERT),
    ]);
    expect(run(g, k('D1', EXPERT)).parent_key).toBe(k('M', MANAGER));
    expect(run(g, k('D2', EXPERT)).parent_key).toBe(k('M', LEAD));
    expect(pickedUpAt(g, 'M')).toEqual(at(2));
  });

  it('keeps the first record of a repeated inner id', () => {
    expect(g.messages.get('M')!.recipient).toEqual(MANAGER);
  });
});

// ---------------------------------------------------------------------------
// Late tool return (AC 8) and cancel absorbed (AC 9)
// ---------------------------------------------------------------------------

describe('a tool return that lands after its run closed', () => {
  it('marks the step done on the closed run and drops nothing', () => {
    const g = runGraphFold([
      received('U1', MANAGER, 1),
      toolCall('t1', 'search', MANAGER, 'U1', 2),
      processed('U1', MANAGER, 3),
      toolReturn('t1', 'search', MANAGER, 'U1', 4),
    ]);
    const r = run(g, k('U1', MANAGER));
    expect(r.status).toBe('done');
    expect(r.end).toEqual(at(3));
    expect(r.steps.map((s) => s.kind)).toEqual(['received', 'tool', 'processed']);
    expect(r.steps[1]).toEqual(
      jasmine.objectContaining({ tool_call_id: 't1', done: true, success: true }),
    );
  });
});

describe('a cancel absorbed through HandledMessage', () => {
  const CANCEL = 'akgentic.core.messages.message.CancelMessage';

  function cancelLog(): { log: AkgenticMessage[]; reads: () => number } {
    let count = 0;
    const cancel = sent('X', HUMAN, MANAGER, null, 3);
    Object.defineProperty(cancel.message, '__model__', {
      get: () => {
        count += 1;
        return CANCEL;
      },
    });
    return {
      log: [
        sent('U1', HUMAN, MANAGER, null, 1),
        received('U1', MANAGER, 2),
        cancel,
        handled('X', MANAGER, 'U1', 4),
        processed('U1', MANAGER, 5),
      ],
      reads: () => count,
    };
  }

  it('is an ordinary absorbed step, and the fold never reads the inner __model__', () => {
    const { log, reads } = cancelLog();
    const g = runGraphFold(log);
    expect(g.messages.get('X')!.absorbed_by).toBe(k('U1', MANAGER));
    expect(run(g, k('U1', MANAGER)).steps).toContain({
      kind: 'absorbed',
      at: at(4),
      message_id: 'X',
    });
    expect(reads()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RunGraphService (AC 10)
// ---------------------------------------------------------------------------

describe('RunGraphService (selector over log$)', () => {
  let log: MessageLogService;
  let service: RunGraphService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [MessageLogService, RunGraphService],
    });
    log = TestBed.inject(MessageLogService);
    service = TestBed.inject(RunGraphService);
  });

  it('emits the empty graph for an empty log', async () => {
    const g = await firstValueFrom(service.graph$);
    expect(g.runs.size).toBe(0);
    expect(g.messages.size).toBe(0);
  });

  it('re-emits a folded graph when the log changes', () => {
    const emitted: RunGraph[] = [];
    const sub = service.graph$.subscribe((g) => emitted.push(g));
    log.append(sent('U1', HUMAN, MANAGER, null, 1));
    log.append(received('U1', MANAGER, 2));
    sub.unsubscribe();
    const last = emitted[emitted.length - 1];
    expect(emitted.length).toBeGreaterThan(1);
    expect(last.runs.has(k('U1', MANAGER))).toBeTrue();
    expect(last.messages.has('U1')).toBeTrue();
  });

  it('shares one fold between subscribers', () => {
    log.append(received('U1', MANAGER, 2));
    const first: RunGraph[] = [];
    const second: RunGraph[] = [];
    const a = service.graph$.subscribe((g) => first.push(g));
    const b = service.graph$.subscribe((g) => second.push(g));
    a.unsubscribe();
    b.unsubscribe();
    expect(second[0]).toBe(first[first.length - 1]);
  });
});

// ---------------------------------------------------------------------------
// Fold hygiene and the per-graph index (the epic's deferred findings)
// ---------------------------------------------------------------------------

describe('fold hygiene', () => {
  it('a caller writing into EMPTY_RUN_GRAPH cannot reach a fold', () => {
    const runs = EMPTY_RUN_GRAPH.runs as Map<RunKey, Run>;
    const stray = run(runGraphFold([received('X', MANAGER, 1)]), k('X', MANAGER));
    runs.set(stray.key, stray);
    try {
      expect(runGraphFold([]).runs.size).toBe(0);
      expect(keys(runGraphFold([received('U1', MANAGER, 2)]))).toEqual([k('U1', MANAGER)]);
    } finally {
      runs.delete(stray.key);
    }
    expect(Object.isFrozen(EMPTY_RUN_GRAPH)).toBeTrue();
  });

  it('a tool return without `success` records null, never undefined', () => {
    const bare = toolReturn('t1', 'search', MANAGER, 'U1', 3);
    delete (bare.event as { success?: boolean }).success;
    const g = runGraphFold([received('U1', MANAGER, 1), toolCall('t1', 'search', MANAGER, 'U1', 2), bare]);
    expect(run(g, k('U1', MANAGER)).steps[1]).toEqual(
      jasmine.objectContaining({ done: true, success: null }),
    );
  });
});

describe('the per-graph index', () => {
  const g = runGraphFold([
    sent('M', HUMAN, MANAGER, null, 1),
    sent('M', HUMAN, LEAD, null, 1),
    received('M', MANAGER, 2),
    received('M', LEAD, 3),
    sent('D1', MANAGER, EXPERT, 'M', 4),
    received('D1', EXPERT, 5),
  ]);

  it('runsOf lists every run a message triggered, in start order', () => {
    expect(runsOf(g, 'M').map((r) => r.key)).toEqual([k('M', MANAGER), k('M', LEAD)]);
    expect(runsOf(g, 'nope')).toEqual([]);
  });

  it('childKeys lists the resolved children of a run', () => {
    expect(childKeys(g, k('M', MANAGER))).toEqual([k('D1', EXPERT)]);
    expect(childKeys(g, k('M', LEAD))).toEqual([]);
  });

  it('never goes stale: a later graph sees the runs added since', () => {
    expect(childKeys(g, k('D1', EXPERT))).toEqual([]);
    const next = runGraphStep(
      runGraphStep(g, sent('D2', EXPERT, ASSISTANT, 'D1', 6)),
      received('D2', ASSISTANT, 7),
    );
    expect(childKeys(next, k('D1', EXPERT))).toEqual([k('D2', ASSISTANT)]);
    expect(childKeys(g, k('D1', EXPERT))).toEqual([]);
  });
});
