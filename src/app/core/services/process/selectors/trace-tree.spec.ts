import { AkgenticMessage } from '../../../protocol/message.types';
import {
  addr,
  ASSISTANT,
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
import {
  CASE_2,
  CASE_3,
  CASE_4,
  CASE_5,
  CASE_5_PREFIX,
  CASE_5_VARIANT,
  CASE_6,
  CASE_7,
  CASE_7_QUEUED,
} from '../../../../../testing/run-log-cases';
import { Run, RunGraph, runGraphFold, RunKey, runKey } from './run-graph.selector';
import { traceSummary, waitingSeats } from './trace-summary';
import {
  answeredAfter,
  buildTraceTree,
  excerpt,
  liveTool,
  seatRevealKeys,
  toolChips,
  tookInCount,
  trackTraceChild,
  TraceRunNode,
  TraceTreeChild,
} from './trace-tree';

const k = (id: string, agent: { agent_id: string }): RunKey => runKey(id, agent.agent_id);
const ROOT = k('U1', MANAGER);

/** The tree as indented lines: one per row, two spaces per level. */
function shape(child: TraceTreeChild, depth = 0): string[] {
  const pad = '  '.repeat(depth);
  switch (child.kind) {
    case 'run':
      return [
        `${pad}${child.run.agent.name} ${child.status}${child.silent ? ' silent' : ''}`,
        ...child.children.flatMap((c) => shape(c, depth + 1)),
      ];
    case 'human':
      return [`${pad}@Human from ${child.from.name}`];
    case 'queued':
      return [`${pad}→ ${child.recipient.name} queued`];
    case 'absorbed':
      return [`${pad}→ ${child.recipient.name} absorbed by ${child.by.name}`];
    case 'join':
      return [`${pad}⤵ ${child.phrase} ${child.from.name}`];
  }
}

function tree(log: AkgenticMessage[], root: RunKey = ROOT): TraceRunNode {
  const t = buildTraceTree(runGraphFold(log), root);
  if (t === null) throw new Error('no tree');
  return t;
}

function find(node: TraceRunNode, key: RunKey): TraceRunNode {
  if (node.key === key) return node;
  for (const c of node.children) {
    if (c.kind !== 'run') continue;
    try {
      return find(c, key);
    } catch {
      // not in this branch
    }
  }
  throw new Error('no node ' + key);
}

function run(g: RunGraph, key: RunKey): Run {
  const r = g.runs.get(key);
  if (r === undefined) throw new Error('no run ' + key);
  return r;
}

describe('buildTraceTree', () => {
  it('case 2: three @Manager runs, each reply-triggered run under its replier', () => {
    expect(shape(tree(CASE_2))).toEqual([
      '@Manager done',
      '  @Expert done',
      '    @Manager done silent',
      '  @Assistant done',
      '    @Manager done',
      '      @Human from @Manager',
    ]);
  });

  it('case 3: the join shows on both sides', () => {
    const t = tree(CASE_3);
    expect(shape(t)).toEqual([
      '@Manager done',
      '  @Expert done',
      '    → @Manager absorbed by @Manager',
      '  @Assistant done',
      '    @Manager done',
      '      ⤵ reply @Expert',
      '      @Human from @Manager',
    ]);
    const ra = find(t, k('Ra', MANAGER));
    expect(ra.tookIn).toBe(1);
    expect(ra.toolChips).toEqual([
      { name: 'search', count: 1, failed: false, summary: '' },
      { name: 'read_mailbox', count: 1, failed: false, summary: '' },
    ]);
  });

  it('case 4: the @Human row is drawn, the entry-point run is never descended', () => {
    const t = tree(CASE_4);
    expect(shape(t)).toEqual(['@Manager done', '  @Human from @Manager']);
    const row = t.children[0];
    expect(row.kind === 'human' && row.messageId).toBe('Q');
    expect(row.kind === 'human' && row.excerpt).toBe('content of Q');
    // Your reply opens its own card; the entry-point run is not a tree root.
    expect(shape(tree(CASE_4, k('U2', MANAGER)))).toEqual([
      '@Manager done',
      '  @Human from @Manager',
    ]);
    expect(buildTraceTree(runGraphFold(CASE_4), k('Q', HUMAN))).toBeNull();
  });

  it('case 5, prefix: depth, a waiting seat, and a failed tool on a done run', () => {
    const t = tree(CASE_5_PREFIX);
    expect(shape(t)).toEqual([
      '@Manager done',
      '  @Expert done',
      '    @Assistant done',
      '      @Expert done',
      '        @Manager done silent',
      '  @Support waiting',
    ]);
    const assistant = find(t, k('D2', ASSISTANT));
    expect(assistant.status).toBe('done');
    expect(assistant.toolChips).toEqual([
      { name: 'workspace_read', count: 1, failed: true, summary: '' },
      { name: 'workspace_list', count: 1, failed: false, summary: '' },
      { name: 'workspace_read', count: 1, failed: false, summary: '' },
    ]);
    const seat = find(t, k('S', SUPPORT));
    expect(seat.seat).toBeTrue();
    expect(seat.silent).toBeFalse();
    expect(seat.answeredAfterMs).toBeNull();
  });

  it('case 5, full: the seat is answered and its answer continues the tree', () => {
    const t = tree(CASE_5);
    const seat = find(t, k('S', SUPPORT));
    expect(seat.status).toBe('answered');
    // Received at 6, answered at 29.
    expect(seat.answeredAfterMs).toBe(23_000);
    expect(shape(seat)).toEqual(['@Support answered', '  @Manager done', '    @Human from @Manager']);
  });

  it('case 6: your absorbed message is a join row on @Manager\'s run', () => {
    const t = tree(CASE_6);
    expect(shape(t)).toEqual(['@Manager done', '  ⤵ yours @Human', '  @Human from @Manager']);
    expect(t.tookIn).toBe(1);
  });

  it('case 7: a queued leaf on the prefix becomes a run node once read', () => {
    expect(shape(tree(CASE_7_QUEUED))).toEqual(['@Manager done', '  → @Expert queued']);
    expect(shape(tree(CASE_7))).toEqual([
      '@Manager done',
      '  @Expert done',
      '    @Manager done',
      '      @Human from @Manager',
    ]);
  });

  it('the case 5 variant: a seat two levels below the root', () => {
    expect(shape(tree(CASE_5_VARIANT))).toEqual([
      '@Manager done',
      '  @Expert done',
      '    @Support waiting',
      '  @Assistant done',
      '    @Expert done silent',
    ]);
  });

  it('two supervisors: children keyed by run key stay apart', () => {
    const LEAD = addr('@Lead', 'Manager', 'lead-id');
    const log = [
      sent('M', HUMAN, MANAGER, null, 1),
      sent('M', HUMAN, LEAD, null, 1),
      received('M', MANAGER, 2),
      received('M', LEAD, 3),
      sent('D1', MANAGER, EXPERT, 'M', 4),
      sent('D2', LEAD, EXPERT, 'M', 5),
      received('D1', EXPERT, 6),
      received('D2', EXPERT, 7),
    ];
    const manager = tree(log, k('M', MANAGER));
    const lead = tree(log, k('M', LEAD));
    expect(shape(manager)).toEqual(['@Manager running', '  @Expert running']);
    expect(shape(lead)).toEqual(['@Lead running', '  @Expert running']);
    expect((manager.children[0] as TraceRunNode).key).toBe(k('D1', EXPERT));
    expect((lead.children[0] as TraceRunNode).key).toBe(k('D2', EXPERT));
  });

  it('an unresolved child is queued: sent, not read, not absorbed', () => {
    const t = tree([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('D', MANAGER, EXPERT, 'U1', 3),
    ]);
    expect(t.children).toEqual([{ kind: 'queued', messageId: 'D', recipient: EXPERT }]);
  });

  it('fail-open: a child run no sent step produced still hangs under its parent', () => {
    // D's `sent` frame reached the log before the parent run opened, so no
    // step records it; the child run still names its parent.
    const t = tree([
      sent('U1', HUMAN, MANAGER, null, 1),
      sent('D', MANAGER, EXPERT, 'U1', 2),
      received('U1', MANAGER, 3),
      received('D', EXPERT, 4),
    ]);
    expect(shape(t)).toEqual(['@Manager running', '  @Expert running']);
  });

  it('is null for an unknown root', () => {
    expect(buildTraceTree(runGraphFold(CASE_2), 'nope')).toBeNull();
  });

  it('carries the trigger, and none on a mid-conversation replay', () => {
    expect(tree(CASE_2).trigger?.id).toBe('U1');
    const t = tree([received('U1', MANAGER, 1)]);
    expect(t.trigger).toBeUndefined();
  });

  it('message chips are the run\'s sends grouped by recipient', () => {
    expect(tree(CASE_2).messageChips).toEqual([
      { recipient: EXPERT, count: 1 },
      { recipient: ASSISTANT, count: 1 },
    ]);
  });

  it('tracks runs by run key and every other row by kind and message id', () => {
    const t = tree(CASE_3);
    expect(trackTraceChild(t)).toBe(ROOT);
    const expert = t.children[0] as TraceRunNode;
    expect(trackTraceChild(expert.children[0])).toBe(`absorbed:Re:${MANAGER.agent_id}`);
    const ra = find(t, k('Ra', MANAGER));
    expect(ra.children.map(trackTraceChild)).toEqual([
      `join:Re:${k('Ra', MANAGER)}`,
      'human:A',
    ]);
  });

  it('one message id sent to two recipients gives two leaves with distinct keys', () => {
    const t = tree([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, 2),
      sent('D', MANAGER, EXPERT, 'U1', 3),
      sent('D', MANAGER, ASSISTANT, 'U1', 3),
    ]);
    expect(shape(t)).toEqual(['@Manager running', '  → @Expert queued', '  → @Assistant queued']);
    const keys = t.children.map(trackTraceChild);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('trace-tree helpers', () => {
  const g5 = runGraphFold(CASE_5_PREFIX);

  it('toolChips groups by name and splits failures', () => {
    const r = run(
      runGraphFold([
        received('U1', MANAGER, 1),
        toolCall('a', 'web_search', MANAGER, 'U1', 2),
        toolCall('b', 'web_search', MANAGER, 'U1', 3),
        toolCall('c', 'read', MANAGER, 'U1', 4),
        toolReturn('c', 'read', MANAGER, 'U1', 5, false),
      ]),
      k('U1', MANAGER),
    );
    expect(toolChips(r)).toEqual([
      { name: 'web_search', count: 2, failed: false, summary: '' },
      { name: 'read', count: 1, failed: true, summary: '' },
    ]);
  });

  it('tookInCount counts absorbed steps', () => {
    expect(tookInCount(run(runGraphFold(CASE_6), ROOT))).toBe(1);
    expect(tookInCount(run(g5, ROOT))).toBe(0);
  });

  it('liveTool names the last step when it is a tool, only while running', () => {
    const log = [received('U1', MANAGER, 1), toolCall('a', 'search', MANAGER, 'U1', 2)];
    expect(liveTool(run(runGraphFold(log), ROOT))).toBe('search');
    const after = [...log, sent('D', MANAGER, EXPERT, 'U1', 3)];
    expect(liveTool(run(runGraphFold(after), ROOT))).toBeNull();
    expect(liveTool(run(runGraphFold([received('U1', MANAGER, 1)]), ROOT))).toBeNull();
    const done = [...log, processed('U1', MANAGER, 3)];
    expect(liveTool(run(runGraphFold(done), ROOT))).toBeNull();
  });

  it('excerpt collapses whitespace and cuts at 140 characters', () => {
    expect(excerpt('  a\n\n b\t c ')).toBe('a b c');
    expect(excerpt('x'.repeat(200)).length).toBe(140);
    expect(excerpt(null)).toBe('');
    // An emoji straddling the cut is kept whole, never half a surrogate pair.
    expect(excerpt('x'.repeat(139) + '😀tail')).toBe('x'.repeat(139) + '😀');
  });

  it('answeredAfter is the first send less the start, or null', () => {
    const g = runGraphFold(CASE_5);
    expect(answeredAfter(run(g, k('S', SUPPORT)))).toBe(23_000);
    expect(answeredAfter(run(g5, k('S', SUPPORT)))).toBeNull();
  });

  it('waitingSeats lists the trace\'s unanswered seats, in start order', () => {
    expect(waitingSeats(g5, ROOT).map((r) => r.key)).toEqual([k('S', SUPPORT)]);
    expect(waitingSeats(runGraphFold(CASE_5), ROOT)).toEqual([]);
    expect(waitingSeats(g5, 'nope')).toEqual([]);
  });

  it('seatRevealKeys: the seat\'s ancestors up to the root, the seat excluded', () => {
    expect(seatRevealKeys(g5, ROOT)).toEqual([ROOT]);
    expect(seatRevealKeys(runGraphFold(CASE_5_VARIANT), ROOT)).toEqual([k('D1', EXPERT), ROOT]);
    expect(seatRevealKeys(runGraphFold(CASE_5), ROOT)).toEqual([]);
  });
});

describe('the waiting header (AC 6)', () => {
  it('case 5 prefix reads "Waiting for @Support"; the answer flips it off waiting', () => {
    const before = traceSummary(runGraphFold(CASE_5_PREFIX), ROOT);
    expect(before?.title).toBe('waiting');
    expect(before?.waitingOn).toEqual(SUPPORT);
    const after = traceSummary(runGraphFold(CASE_5), ROOT);
    expect(after?.title).not.toBe('waiting');
    expect(after?.waitingOn).toBeNull();
  });

  it('a seat two levels below the root drives it too', () => {
    const s = traceSummary(runGraphFold(CASE_5_VARIANT), ROOT);
    expect(s?.title).toBe('waiting');
    expect(s?.waitingOn).toEqual(SUPPORT);
  });
});
