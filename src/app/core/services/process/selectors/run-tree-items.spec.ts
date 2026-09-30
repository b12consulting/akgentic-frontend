import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { AkgenticMessage } from '../../../protocol/message.types';
import {
  addr,
  ASSISTANT,
  at,
  cleared,
  compacted,
  envId,
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
  welcome,
} from '../../../../../testing/run-log-builders';
import { MessageLogService } from '../event/message-log.service';
import { ChatMessage } from './chat-message.model';
import { chatFold, ChatService } from './chat.selector';
import { RunGraph, runGraphFold, RunGraphService, RunKey, runKey } from './run-graph.selector';
import {
  buildRunTreeView,
  isYourMessage,
  MessageNotes,
  positionTime,
  provenanceOf,
  replyTarget,
  RunTreeItem,
  RunTreeService,
  RunTreeState,
  RunTreeView,
  trackRunTreeItem,
  traceItemsFor,
} from './run-tree-items';

// ---------------------------------------------------------------------------
// Helpers: fold one log through BOTH folds, as production does.
// ---------------------------------------------------------------------------

function fold(log: AkgenticMessage[]): { messages: ChatMessage[]; graph: RunGraph } {
  return { messages: chatFold(log).messages, graph: runGraphFold(log) };
}

function view(log: AkgenticMessage[]): RunTreeView {
  const { messages, graph } = fold(log);
  return buildRunTreeView(messages, graph);
}

/** The timeline as `msg:<inner id>` / `trace:<root key>` / `day:<day>`. */
function shape(v: RunTreeView): string[] {
  return v.timeline.map((item) => {
    switch (item.kind) {
      case 'message':
        return 'msg:' + item.data.message_id;
      case 'trace':
        return 'trace:' + item.rootKey;
      case 'day':
        return 'day:' + item.data.day;
    }
  });
}

function k(messageId: string, agentId: string): RunKey {
  return runKey(messageId, agentId);
}

function messageItem(v: RunTreeView, innerId: string): Extract<RunTreeItem, { kind: 'message' }> {
  const item = v.timeline.find(
    (i): i is Extract<RunTreeItem, { kind: 'message' }> =>
      i.kind === 'message' && i.data.message_id === innerId,
  );
  if (item === undefined) throw new Error(`no message row ${innerId}`);
  return item;
}

function notesOf(v: RunTreeView, innerId: string): MessageNotes {
  return messageItem(v, innerId).notes;
}

function chat(log: AkgenticMessage[], innerId: string): ChatMessage {
  const m = chatFold(log).messages.find((c) => c.message_id === innerId);
  if (m === undefined) throw new Error(`no chat message ${innerId}`);
  return m;
}

// ---------------------------------------------------------------------------
// Fixtures: the mockup cases, as log sequences of real wire shapes.
// ---------------------------------------------------------------------------

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
  sent('Re', EXPERT, MANAGER, 'De', 12),
  processed('De', EXPERT, 13),
  handled('Re', MANAGER, 'Ra', 16),
  sent('A', MANAGER, HUMAN, 'Ra', 18),
  processed('Ra', MANAGER, 19),
];

const CASE_4: AkgenticMessage[] = [
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
];

const CASE_5: AkgenticMessage[] = [
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
  sent('C', ASSISTANT, EXPERT, 'D2', 18),
  processed('D2', ASSISTANT, 19),
  received('C', EXPERT, 20),
  sent('B', EXPERT, MANAGER, 'C', 23),
  processed('C', EXPERT, 24),
  received('B', MANAGER, 25),
  processed('B', MANAGER, 28),
  sent('Sa', SUPPORT, MANAGER, 'S', 29),
  received('Sa', MANAGER, 30),
  sent('A', MANAGER, HUMAN, 'Sa', 31),
  processed('Sa', MANAGER, 32),
];

const CASE_6: AkgenticMessage[] = [
  sent('U1', HUMAN, MANAGER, null, 1),
  received('U1', MANAGER, 2),
  toolCall('t1', 'search', MANAGER, 'U1', 3),
  sent('U2', HUMAN, MANAGER, null, 4),
  handled('U2', MANAGER, 'U1', 5),
  toolReturn('t1', 'search', MANAGER, 'U1', 6),
  sent('A', MANAGER, HUMAN, 'U1', 7),
  processed('U1', MANAGER, 8),
];

const CASE_7_PREFIX: AkgenticMessage[] = [
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

const CASE_7: AkgenticMessage[] = [
  ...CASE_7_PREFIX,
  received('U2', MANAGER, 15),
  sent('A2', MANAGER, HUMAN, 'U2', 16),
  processed('U2', MANAGER, 17),
  received('U3', MANAGER, 18),
  sent('A3', MANAGER, HUMAN, 'U3', 19),
  processed('U3', MANAGER, 20),
];

const M = MANAGER.agent_id;

// ---------------------------------------------------------------------------
// The mockup cases
// ---------------------------------------------------------------------------

describe('buildRunTreeView — case 1, direct answer', () => {
  const v = view(CASE_1);

  it('places your message at pick-up, its trace right after it, then the answer', () => {
    expect(shape(v)).toEqual(['msg:U1', `trace:${k('U1', M)}`, 'msg:A1']);
    expect(v.tail).toEqual([]);
  });

  it('positions at pick-up but the bubble keeps its send time', () => {
    const u1 = messageItem(v, 'U1');
    expect(u1.position).toEqual(at(2));
    expect(u1.data.timestamp).toEqual(at(1));
  });

  it('the answer links back to the run on your message', () => {
    expect(notesOf(v, 'A1').provenance).toEqual({
      run: k('U1', M),
      root: k('U1', M),
      agent: MANAGER,
      trigger: 'yourMessage',
      from: HUMAN,
      depth: 1,
      runsInTrace: 1,
    });
  });
});

describe('buildRunTreeView — case 3, provenance on a reply-triggered run', () => {
  it('reads "from @Manager\'s run on @Assistant\'s reply · depth 3 · 4 runs"', () => {
    const p = notesOf(view(CASE_3), 'A').provenance!;
    expect(p.run).toBe(k('Ra', M));
    expect(p.root).toBe(k('U1', M));
    expect(p.agent).toEqual(MANAGER);
    expect(p.trigger).toBe('reply');
    expect(p.from).toEqual(ASSISTANT);
    expect(p.depth).toBe(3);
    expect(p.runsInTrace).toBe(4);
  });

  it('renders no rule-4 row for any delegation or reply between agents', () => {
    expect(shape(view(CASE_3))).toEqual(['msg:U1', `trace:${k('U1', M)}`, 'msg:A']);
  });
});

describe('buildRunTreeView — case 4, your reply to a question', () => {
  const v = view(CASE_4);

  it('the question is a bubble; your reply opens its own trace', () => {
    expect(shape(v)).toEqual([
      'msg:U1',
      `trace:${k('U1', M)}`,
      'msg:Q',
      'msg:U2',
      `trace:${k('U2', M)}`,
      'msg:A',
    ]);
  });

  it('your bubble reads "replying to @Manager"', () => {
    expect(notesOf(v, 'U2').replyingTo).toEqual(MANAGER);
    expect(notesOf(v, 'U1').replyingTo).toBeUndefined();
  });

  it('the trace card continues where @Manager asked you a question', () => {
    const traces = v.timeline.filter((i) => i.kind === 'trace');
    expect(traces.map((t) => (t.kind === 'trace' ? t.continuesFrom : null))).toEqual([
      null,
      MANAGER,
    ]);
  });

  it('the answer in the reply trace is at depth 1; its chain continues past the root', () => {
    const p = notesOf(v, 'A').provenance!;
    expect(p.root).toBe(k('U2', M));
    expect(p.depth).toBe(1);
    expect(p.trigger).toBe('yourMessage');
  });
});

describe('buildRunTreeView — case 5, a seat and a delegation chain', () => {
  const v = view(CASE_5);

  it('renders no rule-3 row for the question to @Support and no rule-4 row', () => {
    expect(chat(CASE_5, 'S').rule).toBe(3);
    expect(chat(CASE_5, 'D1').rule).toBe(4);
    expect(chat(CASE_5, 'Sa').rule).toBe(4);
    expect(shape(v)).toEqual(['msg:U1', `trace:${k('U1', M)}`, 'msg:A']);
  });

  it('the seat\'s answer is not yours and opens no card', () => {
    const { graph } = fold(CASE_5);
    expect(isYourMessage(chat(CASE_5, 'Sa'), graph)).toBeFalse();
  });

  it('the answer is "on @Support\'s answer", inside the one trace', () => {
    const p = notesOf(v, 'A').provenance!;
    expect(p.trigger).toBe('answer');
    expect(p.from).toEqual(SUPPORT);
    expect(p.root).toBe(k('U1', M));
    expect(p.depth).toBe(3);
    expect(p.runsInTrace).toBe(7);
  });
});

describe('buildRunTreeView — case 6, an absorbed message', () => {
  const v = view(CASE_6);

  it('sits at the HandledMessage time and gets no trace card', () => {
    expect(shape(v)).toEqual(['msg:U1', `trace:${k('U1', M)}`, 'msg:U2', 'msg:A']);
    expect(messageItem(v, 'U2').position).toEqual(at(5));
  });

  it('carries the absorbed note naming the absorbing run', () => {
    expect(notesOf(v, 'U2').absorbedBy).toEqual({ run: k('U1', M), agent: MANAGER });
    expect(notesOf(v, 'U1').absorbedBy).toBeUndefined();
  });
});

describe('buildRunTreeView — case 7, follow-ups queued behind a busy agent', () => {
  it('before pick-up, both follow-ups sit in the tail below A1, in send order', () => {
    const v = view(CASE_7_PREFIX);
    expect(shape(v)).toEqual(['msg:U1', `trace:${k('U1', M)}`, 'msg:A1']);
    expect(v.tail.map((m) => m.message_id)).toEqual(['U2', 'U3']);
  });

  it('after pick-up, each follows the answer it did not influence, with its own trace', () => {
    const v = view(CASE_7);
    expect(shape(v)).toEqual([
      'msg:U1',
      `trace:${k('U1', M)}`,
      'msg:A1',
      'msg:U2',
      `trace:${k('U2', M)}`,
      'msg:A2',
      'msg:U3',
      `trace:${k('U3', M)}`,
      'msg:A3',
    ]);
    expect(v.tail).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Send-as, orphans, supervisors, markers, day separators
// ---------------------------------------------------------------------------

describe('buildRunTreeView — a Send-as message', () => {
  const log: AkgenticMessage[] = [
    sent('X', SUPPORT, MANAGER, null, 1),
    received('X', MANAGER, 2),
    sent('A', MANAGER, SUPPORT, 'X', 3),
    processed('X', MANAGER, 4),
  ];

  it('is classified rule 4 by the legacy fold, yet renders as yours with a trace', () => {
    expect(chat(log, 'X').rule).toBe(4);
    const v = view(log);
    expect(shape(v)).toEqual(['msg:X', `trace:${k('X', M)}`]);
    const x = messageItem(v, 'X');
    expect(x.data.rule).toBe(1);
    expect(x.data.alignment).toBe('right');
    expect(x.data.collapsed).toBeFalse();
    expect(x.data.color).toBe('var(--akg-surface)');
    expect(x.data.label).toBe(chat(log, 'X').label);
    expect(x.notes.sendAs).toEqual(SUPPORT);
  });

  it('never mutates the shared ChatMessage', () => {
    const { messages, graph } = fold(log);
    buildRunTreeView(messages, graph);
    expect(messages[0].rule).toBe(4);
    expect(messages[0].alignment).toBe('left');
  });

  it('a message of the entry point carries no "as" note', () => {
    expect(notesOf(view(CASE_1), 'U1').sendAs).toBeUndefined();
  });
});

describe('buildRunTreeView — notes on a queued message', () => {
  it('a Send-as message waiting in the tail keeps its "as" note', () => {
    const v = view([sent('X', SUPPORT, MANAGER, null, 1)]);
    expect(v.tail.map((m) => m.message_id)).toEqual(['X']);
    expect(v.tailNotes.get(envId('X', MANAGER))?.sendAs).toEqual(SUPPORT);
  });

  it('a reply to a question waiting in the tail keeps "replying to"', () => {
    // Case 4 up to `Sent U2`: nobody has taken the reply up yet.
    const v = view(CASE_4.slice(0, 7));
    expect(v.tail.map((m) => m.message_id)).toEqual(['U2']);
    expect(v.tailNotes.get(envId('U2', MANAGER))?.replyingTo).toEqual(MANAGER);
    expect(v.tailNotes.get(envId('U2', MANAGER))?.sendAs).toBeUndefined();
  });
});

describe('buildRunTreeView — orphan traces (fail-open)', () => {
  it('a run whose trigger is unknown is a trace card at its start, with no bubble', () => {
    const v = view([
      received('D', EXPERT, 1),
      toolCall('t1', 'search', EXPERT, 'D', 2),
      processed('D', EXPERT, 3),
    ]);
    expect(shape(v)).toEqual([`trace:${k('D', EXPERT.agent_id)}`]);
    const trace = v.timeline[0];
    expect(trace.kind === 'trace' ? trace.position : null).toEqual(at(1));
  });

  it('entry-point and seat runs never become orphan cards', () => {
    const v = view([received('Q', HUMAN, 1), received('S', SUPPORT, 2)]);
    expect(v.timeline).toEqual([]);
  });

  it('an orphan interleaves with bubbles by time', () => {
    const v = view([
      received('D', EXPERT, 1),
      processed('D', EXPERT, 2),
      ...CASE_1.map((m) => m),
    ]);
    expect(shape(v)).toEqual([
      `trace:${k('D', EXPERT.agent_id)}`,
      'msg:U1',
      `trace:${k('U1', M)}`,
      'msg:A1',
    ]);
  });
});

describe('buildRunTreeView — one message to two supervisors', () => {
  const LEAD = addr('@Lead', 'Manager', 'lead-id');
  const log: AkgenticMessage[] = [
    sent('U', HUMAN, MANAGER, null, 1),
    sent('U', HUMAN, LEAD, null, 1),
    received('U', LEAD, 2),
    received('U', MANAGER, 3),
  ];

  it('is one bubble with one trace per run, keyed by run, in start order', () => {
    expect(shape(view(log))).toEqual([
      'msg:U',
      `trace:${k('U', LEAD.agent_id)}`,
      `trace:${k('U', M)}`,
    ]);
  });
});

describe('buildRunTreeView — markers, welcome and day separators', () => {
  const DAY = 24 * 3600;

  it('renders the welcome and both markers as rows', () => {
    const v = view([
      welcome('W', 0),
      ...CASE_1,
      compacted('C6', MANAGER, 9),
      cleared('C7', MANAGER, 10),
    ]);
    expect(shape(v)).toEqual([
      'msg:W',
      'msg:U1',
      `trace:${k('U1', M)}`,
      'msg:A1',
      'msg:C6',
      'msg:C7',
    ]);
    const rules = v.timeline.map((i) => (i.kind === 'message' ? i.data.rule : null));
    expect(rules).toEqual([5, 1, null, 2, 6, 7]);
  });

  it('computes separators over the sorted part, from position time', () => {
    const v = view([
      sent('U1', HUMAN, MANAGER, null, 1),
      received('U1', MANAGER, DAY + 1),
      sent('A1', MANAGER, HUMAN, 'U1', DAY + 2),
      processed('U1', MANAGER, DAY + 3),
    ]);
    // Sent yesterday, picked up today: the bubble sits on today's side of the
    // rule, because it is placed by pick-up, and so no rule separates it from
    // its own trace. The first row never carries one.
    expect(shape(v).filter((s) => s.startsWith('day:'))).toEqual([]);
  });

  it('puts a day rule between two days of the timeline, never in the tail', () => {
    const v = view([
      ...CASE_1,
      sent('U2', HUMAN, MANAGER, null, DAY + 1),
      sent('A2', MANAGER, HUMAN, null, DAY + 2),
    ]);
    const s = shape(v);
    expect(s.length).toBe(5);
    expect(s[3]).toMatch(/^day:/);
    expect(s[4]).toBe('msg:A2');
    expect(v.tail.map((m) => m.message_id)).toEqual(['U2']);
  });
});

// ---------------------------------------------------------------------------
// Helpers, one by one
// ---------------------------------------------------------------------------

describe('run-tree helpers', () => {
  it('isYourMessage tests the Human ROLE, never the @Human name', () => {
    const log = [sent('X', SUPPORT, MANAGER, null, 1)];
    const { graph } = fold(log);
    expect(isYourMessage(chat(log, 'X'), graph)).toBeTrue();
    expect(isYourMessage(chat(CASE_1, 'A1'), fold(CASE_1).graph)).toBeFalse();
  });

  it('isYourMessage is false for the welcome and the markers', () => {
    const log = [welcome('W', 0), compacted('C6', HUMAN, 1), cleared('C7', HUMAN, 2)];
    const { messages, graph } = fold(log);
    expect(messages.map((m) => isYourMessage(m, graph))).toEqual([false, false, false]);
  });

  it('positionTime: pick-up for yours (null before), send time for the rest', () => {
    const { graph } = fold(CASE_7_PREFIX);
    expect(positionTime(chat(CASE_7_PREFIX, 'U1'), graph)).toEqual(at(2));
    expect(positionTime(chat(CASE_7_PREFIX, 'U2'), graph)).toBeNull();
    expect(positionTime(chat(CASE_7_PREFIX, 'A1'), graph)).toEqual(at(13));
  });

  it('traceItemsFor: one item per run your message opened; none when absorbed', () => {
    const { graph } = fold(CASE_6);
    expect(traceItemsFor(chat(CASE_6, 'U1'), graph, at(2)).map((t) => t.rootKey)).toEqual([
      k('U1', M),
    ]);
    expect(traceItemsFor(chat(CASE_6, 'U2'), graph, at(5))).toEqual([]);
  });

  it('replyTarget: the sender of the parent message, or null', () => {
    const { graph } = fold(CASE_4);
    expect(replyTarget(chat(CASE_4, 'U2'), graph)).toEqual(MANAGER);
    expect(replyTarget(chat(CASE_4, 'U1'), graph)).toBeNull();
  });

  it('provenanceOf: no link when the producing run is unknown', () => {
    const log = [sent('A', MANAGER, HUMAN, 'nowhere', 1)];
    const { graph } = fold(log);
    expect(provenanceOf(chat(log, 'A'), graph)).toBeNull();
    expect(provenanceOf(chat([sent('B', MANAGER, HUMAN, null, 1)], 'B'), graph)).toBeNull();
  });

  it('trackRunTreeItem keys a message by envelope, a trace by run, a day by date', () => {
    const v = view(CASE_1);
    expect(v.timeline.map((item, i) => trackRunTreeItem(i, item))).toEqual([
      'message:' + envId('U1', MANAGER),
      'trace:' + k('U1', M),
      'message:' + envId('A1', HUMAN),
    ]);
    expect(trackRunTreeItem(0, { kind: 'day', data: { day: '2026-09-30', label: 'x' } })).toBe(
      'day:2026-09-30',
    );
  });
});

// ---------------------------------------------------------------------------
// RunTreeService: one view per log emission (No glitch)
// ---------------------------------------------------------------------------

describe('RunTreeService', () => {
  let log: MessageLogService;
  let service: RunTreeService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [MessageLogService, ChatService, RunGraphService, RunTreeService],
    });
    log = TestBed.inject(MessageLogService);
    service = TestBed.inject(RunTreeService);
  });

  it('a send and its pick-up in one emission never show the message in the tail', () => {
    const emitted: RunTreeState[] = [];
    const sub = service.state$.subscribe((s) => emitted.push(s));
    log.appendAll([sent('U1', HUMAN, MANAGER, null, 1), received('U1', MANAGER, 2)]);
    sub.unsubscribe();
    expect(emitted.length).toBe(2);
    for (const s of emitted) expect(s.view.tail).toEqual([]);
    expect(shape(emitted[1].view)).toEqual(['msg:U1', `trace:${k('U1', M)}`]);
  });

  it('pairs the two folds of the same emission, even for a late subscriber', () => {
    log.appendAll([sent('U1', HUMAN, MANAGER, null, 1)]);
    const emitted: RunTreeState[] = [];
    const sub = service.state$.subscribe((s) => emitted.push(s));
    log.append(received('U1', MANAGER, 2));
    log.append(sent('U2', HUMAN, MANAGER, null, 3));
    sub.unsubscribe();
    expect(emitted.map((s) => s.view.tail.map((m) => m.message_id))).toEqual([
      ['U1'],
      [],
      ['U2'],
    ]);
    for (const s of emitted) {
      const inGraph = [...s.graph.messages.keys()];
      const inView = [
        ...s.view.tail.map((m) => m.message_id),
        ...s.view.timeline.flatMap((i) => (i.kind === 'message' ? [i.data.message_id] : [])),
      ];
      expect(inView.sort()).toEqual(inGraph.sort());
    }
  });

  it('a new subscriber after the last one left still gets the current state', () => {
    const first = service.state$.subscribe();
    log.appendAll([sent('U1', HUMAN, MANAGER, null, 1), received('U1', MANAGER, 2)]);
    first.unsubscribe();

    let latest: RunTreeState | undefined;
    service.state$.subscribe((s) => (latest = s)).unsubscribe();
    expect(latest).toBeDefined();
    expect(shape(latest!.view)).toEqual(['msg:U1', `trace:${k('U1', M)}`]);
    expect(latest!.graph.messages.has('U1')).toBeTrue();
  });
});

/** `state$` stops folding when nobody listens: the upstream folds are faked
 *  here so their subscription is observable. */
describe('RunTreeService — ref-counted', () => {
  it('stops running buildRunTreeView after the last unsubscribe', () => {
    const chat$ = new BehaviorSubject(chatFold([]));
    const graph$ = new BehaviorSubject(runGraphFold([]));
    TestBed.configureTestingModule({
      providers: [
        RunTreeService,
        { provide: ChatService, useValue: { chat$ } },
        { provide: RunGraphService, useValue: { graph$ } },
      ],
    });
    const service = TestBed.inject(RunTreeService);

    const a = service.state$.subscribe();
    const b = service.state$.subscribe();
    expect(chat$.observed).toBeTrue();
    a.unsubscribe();
    expect(chat$.observed).withContext('one subscriber left').toBeTrue();
    b.unsubscribe();
    expect(chat$.observed).withContext('nobody left').toBeFalse();
    expect(graph$.observed).toBeFalse();
  });
});
