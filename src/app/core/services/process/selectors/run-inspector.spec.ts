import { AkgenticMessage } from '../../../protocol/message.types';
import {
  addr,
  ASSISTANT,
  EXPERT,
  handled,
  HUMAN,
  MANAGER,
  processed,
  received,
  sent,
  SUPPORT,
  toolCall,
  toolReturn,
} from '../../../../../testing/run-log-builders';
import {
  CASE_2,
  CASE_3,
  CASE_4,
  CASE_5,
  CASE_5_PREFIX,
  CASE_7_QUEUED,
} from '../../../../../testing/run-log-cases';
import { emptyRunGraph, RunGraph, runGraphFold, runKey } from './run-graph.selector';
import {
  belongsToRun,
  buildMiniTree,
  displayedRun,
  ledgerLines,
  miniTreeRoot,
  revealKeysFor,
  runPill,
  runSteps,
} from './run-inspector';

const M = MANAGER.agent_id;
const E = EXPERT.agent_id;
const A = ASSISTANT.agent_id;
const S = SUPPORT.agent_id;
const H = HUMAN.agent_id;

function graphOf(log: AkgenticMessage[]): RunGraph {
  return runGraphFold(log);
}

describe('displayedRun', () => {
  it('shows the selected run whenever it names one', () => {
    const graph = graphOf(CASE_2);
    expect(displayedRun(graph, runKey('De', E))?.key).toBe(runKey('De', E));
  });

  it('case 2 mid-flight: with nothing selected, the latest RUNNING run', () => {
    // @Expert and @Assistant are both running; @Assistant started last.
    const graph = graphOf(CASE_2.slice(0, 7));
    expect(displayedRun(graph, null)?.key).toBe(runKey('Da', A));
  });

  it('case 2 done: with nothing running, the latest run', () => {
    expect(displayedRun(graphOf(CASE_2), null)?.key).toBe(runKey('Ra', M));
  });

  it('never falls back to an entry-point run', () => {
    // (Q, @Human) is the latest run; @Manager's is the latest one that counts.
    const graph = graphOf(CASE_4.slice(0, 6));
    expect(displayedRun(graph, null)?.key).toBe(runKey('U1', M));
  });

  it('an unknown selection falls back rather than showing nothing', () => {
    expect(displayedRun(graphOf(CASE_2), 'gone|x')?.key).toBe(runKey('Ra', M));
  });

  it('is null on an empty graph', () => {
    expect(displayedRun(emptyRunGraph(), null)).toBeNull();
    expect(displayedRun(graphOf(CASE_7_QUEUED.slice(0, 1)), null)).toBeNull();
  });
});

describe('runPill', () => {
  it('case 2: the quiet @Manager run is done · sent nothing', () => {
    const graph = graphOf(CASE_2);
    expect(runPill(graph, runKey('Re', M))).toBe('doneSilent');
    expect(runPill(graph, runKey('Ra', M))).toBe('done');
  });

  it('a running run is running', () => {
    expect(runPill(graphOf(CASE_2.slice(0, 7)), runKey('Da', A))).toBe('running');
  });

  it('case 5: the seat is waiting, then answered', () => {
    expect(runPill(graphOf(CASE_5_PREFIX), runKey('S', S))).toBe('waiting');
    expect(runPill(graphOf(CASE_5), runKey('S', S))).toBe('answered');
  });

  it('is null for an unknown key', () => {
    expect(runPill(emptyRunGraph(), 'x|y')).toBeNull();
  });
});

describe('runSteps', () => {
  it('case 5: a failed tool step, then ok ones, each offset from the start', () => {
    const graph = graphOf(CASE_5);
    const run = graph.runs.get(runKey('D2', A))!;
    expect(runSteps(graph, run)).toEqual([
      { kind: 'received', offset: '+0s' },
      { kind: 'tool', offset: '+1s', name: 'workspace_read', state: 'failed' },
      { kind: 'tool', offset: '+3s', name: 'workspace_list', state: 'ok' },
      { kind: 'tool', offset: '+5s', name: 'workspace_read', state: 'ok' },
      { kind: 'sent', offset: '+7s', to: EXPERT },
      { kind: 'processed', offset: '+8s' },
    ]);
  });

  it('case 3: @Manager took in @Expert\'s reply', () => {
    const graph = graphOf(CASE_3);
    const steps = runSteps(graph, graph.runs.get(runKey('Ra', M))!);
    expect(steps.map((s) => s.kind)).toEqual([
      'received',
      'tool',
      'tool',
      'absorbed',
      'sent',
      'processed',
    ]);
    expect(steps[3]).toEqual({ kind: 'absorbed', offset: '+6s', from: EXPERT });
  });

  it('a tool still waiting for its return is pending; a missing verdict is ok', () => {
    const graph = graphOf([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      toolCall('t1', 'search', MANAGER, 'U1', 3),
    ]);
    const run = graph.runs.get(runKey('U1', M))!;
    expect(runSteps(graph, run)[1]).toEqual({
      kind: 'tool',
      offset: '+1s',
      name: 'search',
      state: 'pending',
    });
    const ret = toolReturn('t1', 'search', MANAGER, 'U1', 4);
    delete (ret.event as { success?: boolean }).success;
    const done = graphOf([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      toolCall('t1', 'search', MANAGER, 'U1', 3),
      ret,
    ]);
    const step = runSteps(done, done.runs.get(runKey('U1', M))!)[1];
    expect(step.kind === 'tool' && step.state).toBe('ok');
  });
});

describe('revealKeysFor', () => {
  it('case 5: the ancestors inside the trace, root included, and the run', () => {
    expect(revealKeysFor(graphOf(CASE_5), runKey('C', E))).toEqual([
      runKey('D2', A),
      runKey('D1', E),
      runKey('U1', M),
      runKey('C', E),
    ]);
  });

  it('case 4: stops at the trace root, never climbs into the asker\'s trace', () => {
    expect(revealKeysFor(graphOf(CASE_4), runKey('U2', M))).toEqual([runKey('U2', M)]);
  });

  it('an unknown key reveals only itself', () => {
    expect(revealKeysFor(emptyRunGraph(), 'x|y')).toEqual(['x|y']);
  });
});

describe('buildMiniTree', () => {
  it('case 5: the path is bold down the delegation chain, the run displayed', () => {
    const rows = buildMiniTree(graphOf(CASE_5), runKey('B', M));
    // Children in start order: the seat started before @Expert did.
    expect(rows.map((r) => [r.key, r.depth, r.onPath, r.displayed, r.kind])).toEqual([
      [runKey('U1', M), 0, true, false, 'agent'],
      [runKey('S', S), 1, false, false, 'seat'],
      [runKey('Sa', M), 2, false, false, 'agent'],
      [runKey('D1', E), 1, true, false, 'agent'],
      [runKey('D2', A), 2, true, false, 'agent'],
      [runKey('C', E), 3, true, false, 'agent'],
      [runKey('B', M), 4, true, true, 'agent'],
    ]);
  });

  it('an off-path node carries what folding it hides', () => {
    const rows = buildMiniTree(graphOf(CASE_5), runKey('B', M));
    const seat = rows.find((r) => r.key === runKey('S', S))!;
    expect(seat.childCount).toBe(1);
    expect(seat.foldedRuns).toBe(1);
    expect(seat.foldedAgents).toEqual([MANAGER]);
    const top = rows[0];
    expect(top.foldedRuns).toBe(6);
    expect(top.foldedAgents).toEqual([SUPPORT, EXPERT, ASSISTANT, MANAGER]);
  });

  it('case 4: continues across your reply — the entry point is a node with the reply under it', () => {
    const rows = buildMiniTree(graphOf(CASE_4), runKey('U2', M));
    expect(rows.map((r) => [r.key, r.depth, r.kind, r.onPath])).toEqual([
      [runKey('U1', M), 0, 'agent', true],
      [runKey('Q', H), 1, 'entry', true],
      [runKey('U2', M), 2, 'agent', true],
      [runKey('A', H), 3, 'entry', false],
    ]);
    // Entry-point runs are never counted as runs a fold hides.
    expect(rows[0].foldedRuns).toBe(1);
  });

  it('is the CONNECTED tree only, not every trace', () => {
    const log = [
      ...CASE_7_QUEUED,
      sent('U9', HUMAN, EXPERT, null, 20),
      received('U9', EXPERT, 21),
    ];
    const rows = buildMiniTree(graphOf(log), runKey('U1', M));
    expect(rows.map((r) => r.key)).toEqual([runKey('U1', M)]);
  });

  it('a replay starting mid-conversation: an unresolved parent is its own top', () => {
    const graph = graphOf([
      sent('D', MANAGER, EXPERT, 'unseen', 1),
      received('D', EXPERT, 2),
      sent('X', EXPERT, ASSISTANT, 'D', 3),
      received('X', ASSISTANT, 4),
    ]);
    const rows = buildMiniTree(graph, runKey('X', A));
    expect(rows.map((r) => [r.key, r.depth])).toEqual([
      [runKey('D', E), 0],
      [runKey('X', A), 1],
    ]);
  });

  it('is empty for an unknown key', () => {
    expect(buildMiniTree(emptyRunGraph(), 'x|y')).toEqual([]);
  });

  it('a row carries its status mark, its short id, and its leaves; the root line names you', () => {
    const graph = graphOf([
      sent('U1-0123456789', HUMAN, MANAGER, null, 1),
      received('U1-0123456789', MANAGER, 2),
      sent('D', MANAGER, EXPERT, 'U1-0123456789', 3),
    ]);
    const rows = buildMiniTree(graph, runKey('U1-0123456789', M));
    expect(rows.length).toBe(1);
    expect(rows[0].pill).toBe('running');
    expect(rows[0].shortId).toBe('U1-01234');
    // @Expert never picked it up: a queued leaf, not a row.
    expect(rows[0].leaves).toEqual([{ kind: 'queued', recipient: EXPERT }]);
    expect(miniTreeRoot(graph, rows)).toEqual({
      from: HUMAN,
      fromYou: true,
      to: MANAGER,
      shortId: 'U1-01234',
    });
  });

  it('a fold says when something under it is still running', () => {
    const rows = buildMiniTree(graphOf(CASE_2.slice(0, 7)), runKey('Da', A));
    expect(rows[0].foldedLive).toBeTrue();
    expect(buildMiniTree(graphOf(CASE_2), runKey('Ra', M))[0].foldedLive).toBeFalse();
  });
});

describe('the event log', () => {
  it('case 3: the run\'s own lines, including the absorbed message\'s', () => {
    const run = graphOf(CASE_3).runs.get(runKey('Ra', M))!;
    const lines = ledgerLines(CASE_3, run, 'run');
    expect(lines.map((l) => [l.index, l.kind, l.detail])).toEqual([
      [7, 'SentMessage', '→ @Manager · content of Ra'],
      [9, 'ReceivedMessage', 'Ra'],
      [10, 'ToolCallEvent', 'search'],
      [13, 'ToolReturnEvent', 'search ✓'],
      [14, 'ToolCallEvent', 'read_mailbox'],
      [15, 'HandledMessage', 'took in Re'],
      [16, 'ToolReturnEvent', 'read_mailbox ✓'],
      [17, 'SentMessage', '→ @Human · content of A'],
      [18, 'ProcessedMessage', 'Ra'],
    ]);
    expect(lines.every((l) => l.own)).toBeTrue();
    expect(lines[1].sender).toBe('@Manager');
  });

  it('a failed tool return reads ✕', () => {
    const run = graphOf(CASE_5).runs.get(runKey('D2', A))!;
    const details = ledgerLines(CASE_5, run, 'run').map((l) => l.detail);
    expect(details).toContain('workspace_read ✕');
  });

  it('whole team: every line, the run\'s own marked', () => {
    const run = graphOf(CASE_3).runs.get(runKey('Ra', M))!;
    const lines = ledgerLines(CASE_3, run, 'team');
    expect(lines.length).toBe(CASE_3.length);
    expect(lines.filter((l) => l.own).length).toBe(9);
    expect(lines[0].own).toBeFalse();
  });

  it('two supervisors: two runs of one message id never share lines (Trap 1)', () => {
    const LEAD = addr('@Lead', 'Manager', 'lead-id');
    const log: AkgenticMessage[] = [
      sent('U1', HUMAN, MANAGER, null, 1),
      sent('U1', HUMAN, LEAD, null, 1),
      received('U1', MANAGER, 2),
      received('U1', LEAD, 3),
      toolCall('m1', 'plan', MANAGER, 'U1', 4),
      toolCall('l1', 'plan', LEAD, 'U1', 5),
      sent('D1', MANAGER, EXPERT, 'U1', 6),
      sent('D2', LEAD, ASSISTANT, 'U1', 7),
      handled('X', LEAD, 'U1', 8),
      processed('U1', MANAGER, 9),
      processed('U1', LEAD, 10),
    ];
    const graph = graphOf(log);
    const mine = ledgerLines(log, graph.runs.get(runKey('U1', M))!, 'run').map((l) => l.index);
    const lead = ledgerLines(log, graph.runs.get(runKey('U1', 'lead-id'))!, 'run').map(
      (l) => l.index,
    );
    expect(mine).toEqual([0, 2, 4, 6, 9]);
    expect(lead).toEqual([1, 3, 5, 7, 8, 10]);
  });

  it('belongsToRun keeps a delegate\'s own run lines out of its parent\'s', () => {
    const graph = graphOf(CASE_2);
    const parent = graph.runs.get(runKey('U1', M))!;
    // @Expert's `received('De')` names the message the parent sent, not the parent.
    expect(belongsToRun(CASE_2[5], parent)).toBeFalse();
    expect(belongsToRun(CASE_2[2], parent)).toBeTrue();
  });
});
