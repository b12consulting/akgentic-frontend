import { AkgenticMessage } from '../../../protocol/message.types';
import {
  ASSISTANT,
  at,
  EXPERT,
  HUMAN,
  MANAGER,
  processed,
  received,
  sent,
  SUPPORT,
  toolCall,
  toolReturn,
} from '../../../../../testing/run-log-builders';
import { runGraphFold, runKey } from './run-graph.selector';
import { traceDuration, traceRuns, traceSummary } from './trace-summary';

const U1 = runKey('U1', MANAGER.agent_id);

const CASE_1: AkgenticMessage[] = [
  sent('U1', HUMAN, MANAGER, null, 1),
  received('U1', MANAGER, 2),
  toolCall('t1', 'search', MANAGER, 'U1', 3),
  toolReturn('t1', 'search', MANAGER, 'U1', 4),
  sent('A1', MANAGER, HUMAN, 'U1', 5),
  processed('U1', MANAGER, 6),
  received('A1', HUMAN, 7),
  processed('A1', HUMAN, 8),
];

const CASE_3: AkgenticMessage[] = [
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
  toolReturn('t2', 'read_mailbox', MANAGER, 'Ra', 17),
  sent('A', MANAGER, HUMAN, 'Ra', 18),
  processed('Ra', MANAGER, 19),
];

describe('traceRuns', () => {
  it('counts the root, not the entry-point run that received the answer (case 1)', () => {
    const g = runGraphFold(CASE_1);
    expect(traceRuns(g, U1).map((r) => r.key)).toEqual([U1]);
  });

  it('stops at a reply of yours, which opens its own trace (case 4)', () => {
    const g = runGraphFold([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('Q', MANAGER, HUMAN, 'U1', 3),
      processed('U1', MANAGER, 4),
      received('Q', HUMAN, 5),
      processed('Q', HUMAN, 6),
      sent('U2', HUMAN, MANAGER, 'Q', 7),
      received('U2', MANAGER, 8),
    ]);
    expect(traceRuns(g, U1).map((r) => r.key)).toEqual([U1]);
    const r2 = runKey('U2', MANAGER.agent_id);
    expect(traceRuns(g, r2).map((r) => r.key)).toEqual([r2]);
  });

  it('keeps a human seat in the trace', () => {
    const g = runGraphFold([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('S', MANAGER, SUPPORT, 'U1', 3),
      processed('U1', MANAGER, 4),
      received('S', SUPPORT, 5),
      processed('S', SUPPORT, 6),
    ]);
    expect(traceRuns(g, U1).map((r) => r.agent.name)).toEqual(['@Manager', '@Support']);
  });

  it('is empty for an unknown root', () => {
    expect(traceRuns(runGraphFold(CASE_1), 'nope|nobody')).toEqual([]);
  });
});

describe('traceSummary — the four header states', () => {
  it('doneOne: "@Manager handled this in 1 run · 1 tool" (case 1)', () => {
    const s = traceSummary(runGraphFold(CASE_1), U1)!;
    expect(s.title).toBe('doneOne');
    expect(s.agents).toEqual([MANAGER]);
    expect(s.runCount).toBe(1);
    expect(s.toolCount).toBe(1);
    expect(s.start).toEqual(at(2));
    expect(s.end).toEqual(at(6));
    expect(s.runningCount).toBe(0);
    expect(s.waitingOn).toBeNull();
  });

  it('doneMany: root agent first, then the others in start order (case 3)', () => {
    const s = traceSummary(runGraphFold(CASE_3), U1)!;
    expect(s.title).toBe('doneMany');
    expect(s.agents).toEqual([MANAGER, EXPERT, ASSISTANT]);
    expect(s.runCount).toBe(4);
    expect(s.toolCount).toBe(2);
    expect(s.end).toEqual(at(19));
  });

  it('running: the latest tool of the most recently started running run', () => {
    const s = traceSummary(runGraphFold(CASE_3.slice(0, 11)), U1)!;
    expect(s.title).toBe('running');
    // De and Ra are both running; Ra started last, and its latest tool is search.
    expect(s.runningCount).toBe(2);
    expect(s.activeAgent).toEqual(MANAGER);
    expect(s.activeTool).toBe('search');
    expect(s.end).toBeNull();
  });

  it('running with no tool yet reads as "is working"', () => {
    const s = traceSummary(runGraphFold(CASE_1.slice(0, 2)), U1)!;
    expect(s.title).toBe('running');
    expect(s.activeAgent).toEqual(MANAGER);
    expect(s.activeTool).toBeNull();
  });

  it('waiting outranks running: a waiting seat is a call to action', () => {
    const g = runGraphFold([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('D1', MANAGER, EXPERT, 'U1', 3),
      sent('S', MANAGER, SUPPORT, 'U1', 4),
      processed('U1', MANAGER, 5),
      received('S', SUPPORT, 6),
      processed('S', SUPPORT, 7),
      received('D1', EXPERT, 8),
    ]);
    const s = traceSummary(g, U1)!;
    expect(s.runningCount).toBe(1);
    expect(s.waitingOn).toEqual(SUPPORT);
    expect(s.title).toBe('waiting');
  });

  it('an answered seat is no longer waiting', () => {
    const g = runGraphFold([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('S', MANAGER, SUPPORT, 'U1', 3),
      processed('U1', MANAGER, 4),
      received('S', SUPPORT, 5),
      processed('S', SUPPORT, 6),
      sent('Sa', SUPPORT, MANAGER, 'S', 7),
      received('Sa', MANAGER, 8),
      processed('Sa', MANAGER, 9),
    ]);
    const s = traceSummary(g, U1)!;
    expect(s.waitingOn).toBeNull();
    expect(s.title).toBe('doneMany');
    expect(s.runCount).toBe(3);
  });

  it('is null for an unknown root', () => {
    expect(traceSummary(runGraphFold(CASE_1), 'nope|nobody')).toBeNull();
  });
});

describe('traceDuration', () => {
  it('formats seconds, minutes and hours compactly', () => {
    expect(traceDuration(at(0), at(42))).toBe('42s');
    expect(traceDuration(at(0), at(185))).toBe('3m 05s');
    expect(traceDuration(at(0), at(3600 + 7 * 60))).toBe('1h 07m');
  });

  it('is null while the trace has no end', () => {
    expect(traceDuration(at(0), null)).toBeNull();
  });
});
