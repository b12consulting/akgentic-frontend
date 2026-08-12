import { TestBed } from '@angular/core/testing';

import {
  AkgenticMessage,
  CLOSED_NOTIFICATION_MODEL,
  SentMessage,
} from '../../../protocol/message.types';
import {
  closedNotificationIdsFold,
  MessageLogService,
  messageListFold,
} from './message-log.service';

function msg(
  id: string,
  model: string = 'StartMessage',
  senderRole: string = 'Worker',
): AkgenticMessage {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-04-13T00:00:00Z',
    sender: {
      __actor_address__: true,
      name: '@X',
      role: senderRole,
      agent_id: 'a',
      team_id: 'team-1',
      squad_id: 's',
      user_message: false,
    },
    display_type: 'other',
    content: null,
    __model__: `akgentic.core.messages.orchestrator.${model}`,
  } as AkgenticMessage;
}

/** A welcome `SentMessage`: outer `ActorSystem` sender, inner `WelcomeMessage`
 *  payload with `display_type === 'other'` (ADR-011 Story 2.6). */
function welcomeSent(id: string): SentMessage {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-05-18T00:00:00Z',
    sender: {
      __actor_address__: true,
      name: '@ActorSystem',
      role: 'ActorSystem',
      agent_id: 'sys',
      team_id: 'team-1',
      squad_id: 's',
      user_message: false,
    },
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.SentMessage',
    recipient: {
      __actor_address__: true,
      name: '@Human',
      role: 'Human',
      agent_id: 'human',
      team_id: 'team-1',
      squad_id: 's',
      user_message: false,
    },
    message: {
      id: `${id}-inner`,
      parent_id: null,
      team_id: 'team-1',
      timestamp: '2026-05-18T00:00:00Z',
      sender: {
        __actor_address__: true,
        name: '@Orchestrator',
        role: 'Orchestrator',
        agent_id: 'orch',
        team_id: 'team-1',
        squad_id: 's',
        user_message: false,
      },
      display_type: 'other',
      content: 'Welcome to the agent team !',
      __model__: 'akgentic.team.messages.WelcomeMessage',
    },
  };
}

describe('MessageLogService (Story 6.1)', () => {
  let service: MessageLogService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [MessageLogService] });
    service = TestBed.inject(MessageLogService);
  });

  it('AC1: log$ emits [] on subscribe and snapshot() returns []', () => {
    let observed: AkgenticMessage[] | null = null;
    const sub = service.log$.subscribe((v) => (observed = v));
    expect(observed as AkgenticMessage[] | null).toEqual([]);
    expect(service.snapshot()).toEqual([]);
    sub.unsubscribe();
  });

  it('append: single message produces one new emission and preserves order', () => {
    const emissions: AkgenticMessage[][] = [];
    const sub = service.log$.subscribe((v) => emissions.push(v));
    service.append(msg('1'));
    service.append(msg('2'));
    // Initial [] + two appends = 3 emissions.
    expect(emissions.length).toBe(3);
    expect(emissions[0]).toEqual([]);
    expect(emissions[1].map((m) => m.id)).toEqual(['1']);
    expect(emissions[2].map((m) => m.id)).toEqual(['1', '2']);
    sub.unsubscribe();
  });

  it('appendAll: batch of N produces ONE emission with N messages in arrival order', () => {
    const emissions: AkgenticMessage[][] = [];
    const sub = service.log$.subscribe((v) => emissions.push(v));
    service.appendAll([msg('a'), msg('b'), msg('c')]);
    // Initial [] + one batch append = 2 emissions.
    expect(emissions.length).toBe(2);
    expect(emissions[1].map((m) => m.id)).toEqual(['a', 'b', 'c']);
    sub.unsubscribe();
  });

  it('appendAll: empty batch is a no-op (no emission, no snapshot change)', () => {
    const emissions: AkgenticMessage[][] = [];
    const sub = service.log$.subscribe((v) => emissions.push(v));
    service.appendAll([]);
    expect(emissions.length).toBe(1); // only the initial []
    expect(service.snapshot()).toEqual([]);
    sub.unsubscribe();
  });

  it('appendAll emits a NEW array reference (OnPush-safe, NFR3)', () => {
    const before = service.snapshot();
    service.appendAll([msg('1')]);
    const after = service.snapshot();
    expect(after).not.toBe(before);
  });

  it('reset() empties the log to [] and emits', () => {
    service.appendAll([msg('1'), msg('2')]);
    expect(service.snapshot().length).toBe(2);

    const emissions: AkgenticMessage[][] = [];
    const sub = service.log$.subscribe((v) => emissions.push(v));
    service.reset();
    // Initial ([1,2]) + post-reset ([]) = 2 emissions.
    expect(emissions.length).toBe(2);
    expect(emissions[1]).toEqual([]);
    expect(service.snapshot()).toEqual([]);
    sub.unsubscribe();
  });

  it('snapshot() returns the synchronous current value after appends', () => {
    service.append(msg('1'));
    service.appendAll([msg('2'), msg('3')]);
    expect(service.snapshot().map((m) => m.id)).toEqual(['1', '2', '3']);
  });
});

// ---------------------------------------------------------------------------
// Story 6.4 (AC4) — messageList$ selector
// ---------------------------------------------------------------------------

describe('messageListFold (Story 6.4, AC4)', () => {
  it('empty log → []', () => {
    expect(messageListFold([])).toEqual([]);
  });

  // Story 31-2 (AC #3): the allowlist grew from two entries to four. The
  // negative half still proves the fold is an allowlist and not a passthrough.
  it('filters to the notification family and SentMessage only', () => {
    const log: AkgenticMessage[] = [
      msg('s1', 'SentMessage'),
      msg('st1', 'StartMessage'),
      msg('e1', 'ErrorMessage'),
      msg('w1', 'WarningMessage'),
      msg('n1', 'NotificationMessage'),
      msg('sc1', 'StateChangedMessage'),
      msg('ev1', 'EventMessage'),
      msg('r1', 'ReceivedMessage'),
    ];
    const out = messageListFold(log);
    expect(out.map((m) => m.id)).toEqual(['s1', 'e1', 'w1', 'n1']);
  });

  // The fold must admit exactly what `notificationSeverity` can classify: a model
  // admitted here but classifiable by nothing falls through to the component's
  // `SentMessage` branch and reads a payload it does not have. The leading dot on
  // the `.NotificationMessage` allowlist entry is what holds that line, so assert
  // the rejection — admission alone would pass with or without the dot.
  it('rejects a suffix-colliding sibling the render predicate cannot classify', () => {
    expect(messageListFold([msg('n1', 'NotificationMessage')]).map((m) => m.id))
      .toEqual(['n1']);
    expect(messageListFold([msg('x1', 'FooNotificationMessage')])).toEqual([]);
  });

  it('excludes ActorSystem senders', () => {
    const log: AkgenticMessage[] = [
      msg('s1', 'SentMessage', 'ActorSystem'),
      msg('s2', 'SentMessage', 'Worker'),
      msg('e1', 'ErrorMessage', 'ActorSystem'),
    ];
    const out = messageListFold(log);
    expect(out.map((m) => m.id)).toEqual(['s2']);
  });

  // Story 31-2 (AC #3): the newly admitted types get no exemption from the
  // ActorSystem exclusion — only the welcome announcement has one.
  it('excludes ActorSystem-sender warnings and notifications too', () => {
    const log: AkgenticMessage[] = [
      msg('w1', 'WarningMessage', 'ActorSystem'),
      msg('n1', 'NotificationMessage', 'ActorSystem'),
      msg('w2', 'WarningMessage', 'Worker'),
    ];
    expect(messageListFold(log).map((m) => m.id)).toEqual(['w2']);
  });

  it('FR11 passthrough: messages with missing/unknown __model__ are silently excluded (no throw)', () => {
    const unknown = { ...msg('x1', 'SentMessage'), __model__: undefined as any };
    const empty = { ...msg('x2', 'SentMessage'), __model__: '' as any };
    const good = msg('x3', 'SentMessage');
    expect(() => messageListFold([unknown, empty, good])).not.toThrow();
    const out = messageListFold([unknown, empty, good]);
    expect(out.map((m) => m.id)).toEqual(['x3']);
  });

  it('preserves arrival order across a mixed log', () => {
    const log: AkgenticMessage[] = [
      msg('a', 'SentMessage'),
      msg('b', 'StartMessage'),
      msg('c', 'ErrorMessage'),
      msg('d', 'SentMessage'),
    ];
    expect(messageListFold(log).map((m) => m.id)).toEqual(['a', 'c', 'd']);
  });

  // Story 2.6 (AC2) — welcome announcement exception
  it('admits the welcome announcement despite its ActorSystem outer sender', () => {
    const out = messageListFold([welcomeSent('w1')]);
    expect(out.map((m) => m.id)).toEqual(['w1']);
  });

  it('still excludes ordinary ActorSystem-sender messages alongside an admitted welcome', () => {
    const log: AkgenticMessage[] = [
      welcomeSent('w1'),
      msg('s1', 'SentMessage', 'ActorSystem'),
      msg('s2', 'SentMessage', 'Worker'),
    ];
    expect(messageListFold(log).map((m) => m.id)).toEqual(['w1', 's2']);
  });
});

describe('MessageLogService.messageList$ (Story 6.4, AC4)', () => {
  let service: MessageLogService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [MessageLogService] });
    service = TestBed.inject(MessageLogService);
  });

  it('emits [] on subscribe when log is empty', () => {
    let observed: AkgenticMessage[] | null = null;
    const sub = service.messageList$.subscribe((v) => (observed = v));
    expect(observed as AkgenticMessage[] | null).toEqual([]);
    sub.unsubscribe();
  });

  it('emits the filtered slice when the log changes', () => {
    const emissions: AkgenticMessage[][] = [];
    const sub = service.messageList$.subscribe((v) => emissions.push(v));

    // Initial [] from the seed log.
    expect(emissions.length).toBe(1);
    expect(emissions[0]).toEqual([]);

    // A non-relevant message still triggers a log$ emission; the filter
    // produces a fresh [] (new reference) so distinctUntilChanged passes
    // through (default reference comparison). This is intentional — OnPush
    // consumers rely on a new reference to re-evaluate (NFR3).
    service.append(msg('st1', 'StartMessage'));
    expect(emissions[emissions.length - 1]).toEqual([]);

    // Append a relevant message — slice now contains the SentMessage.
    service.append(msg('s1', 'SentMessage'));
    const last = emissions[emissions.length - 1];
    expect(last.map((m) => m.id)).toEqual(['s1']);

    sub.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Story 31-4 (AC #7, #8) — closedNotificationIdsFold
//
// The fold is the durable half of the dismissal round trip: an id it collects
// is an id `IngestionService` will refuse to re-toast. It is a pure function
// over the log, so live-streamed and replayed `ClosedNotification`s are
// indistinguishable to it — which is exactly why a dismissal survives a reload.
// ---------------------------------------------------------------------------

/** An `EventMessage` envelope carrying a `ClosedNotification` inner event. */
function closedNotification(id: string, messageId: string): AkgenticMessage {
  return {
    ...msg(id, 'EventMessage'),
    event: { __model__: CLOSED_NOTIFICATION_MODEL, message_id: messageId },
  } as AkgenticMessage;
}

/** An `EventMessage` envelope carrying some OTHER inner event. */
function usageEvent(id: string): AkgenticMessage {
  return {
    ...msg(id, 'EventMessage'),
    event: {
      __model__: 'akgentic.llm.event.LlmUsageEvent',
      input_tokens: 10,
      output_tokens: 2,
    },
  } as AkgenticMessage;
}

describe('closedNotificationIdsFold (Story 31-4, AC #7/#8)', () => {
  it('empty log → empty set', () => {
    expect(closedNotificationIdsFold([]).size).toBe(0);
  });

  it('one ClosedNotification → that message_id', () => {
    const out = closedNotificationIdsFold([closedNotification('e1', 'w-1')]);
    expect(Array.from(out)).toEqual(['w-1']);
  });

  it('collects several distinct ids in the order they arrived', () => {
    const out = closedNotificationIdsFold([
      closedNotification('e1', 'w-1'),
      closedNotification('e2', 'w-2'),
    ]);
    expect(Array.from(out)).toEqual(['w-1', 'w-2']);
  });

  it('duplicate message_ids collapse to one entry', () => {
    const out = closedNotificationIdsFold([
      closedNotification('e1', 'w-1'),
      closedNotification('e2', 'w-1'),
    ]);
    expect(out.size).toBe(1);
    expect(out.has('w-1')).toBeTrue();
  });

  it('an EventMessage carrying another inner event contributes nothing', () => {
    expect(closedNotificationIdsFold([usageEvent('e1')]).size).toBe(0);
  });

  it('a plain SentMessage contributes nothing', () => {
    expect(closedNotificationIdsFold([msg('s1', 'SentMessage')]).size).toBe(0);
  });

  it('does not throw on a missing __model__ or a null inner event', () => {
    const noModel = {
      ...msg('x1', 'EventMessage'),
      __model__: undefined as any,
    } as AkgenticMessage;
    const nullEvent = {
      ...msg('x2', 'EventMessage'),
      event: null,
    } as AkgenticMessage;
    expect(() =>
      closedNotificationIdsFold([noModel, nullEvent]),
    ).not.toThrow();
    expect(closedNotificationIdsFold([noModel, nullEvent]).size).toBe(0);
  });

  it('picks the ClosedNotifications out of a mixed log', () => {
    const out = closedNotificationIdsFold([
      msg('s1', 'SentMessage'),
      closedNotification('e1', 'w-1'),
      usageEvent('e2'),
      msg('w1', 'WarningMessage'),
      closedNotification('e3', 'w-2'),
    ]);
    expect(Array.from(out).sort()).toEqual(['w-1', 'w-2']);
  });
});

describe('MessageLogService.closedNotificationIds$ (Story 31-4, AC #7)', () => {
  let service: MessageLogService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [MessageLogService] });
    service = TestBed.inject(MessageLogService);
  });

  it('emits an empty set synchronously on subscribe', () => {
    let observed: Set<string> | null = null;
    const sub = service.closedNotificationIds$.subscribe((v) => (observed = v));
    expect((observed as Set<string> | null)?.size).toBe(0);
    sub.unsubscribe();
  });

  it('re-emits when a ClosedNotification lands', () => {
    const emissions: Set<string>[] = [];
    const sub = service.closedNotificationIds$.subscribe((v) =>
      emissions.push(v),
    );

    service.append(closedNotification('e1', 'w-1'));

    expect(emissions.length).toBe(2);
    expect(Array.from(emissions[1])).toEqual(['w-1']);
    sub.unsubscribe();
  });

  // Without `distinctUntilChanged(sameIdSet)` the fold's fresh Set per log
  // emission would push a new value on EVERY unrelated frame.
  it('does NOT re-emit for frames that change no dismissal id', () => {
    const emissions: Set<string>[] = [];
    const sub = service.closedNotificationIds$.subscribe((v) =>
      emissions.push(v),
    );

    service.append(msg('s1', 'SentMessage'));
    service.append(usageEvent('e1'));
    service.append(msg('s2', 'SentMessage'));

    expect(emissions.length).toBe(1);
    sub.unsubscribe();
  });

  // AC #7: replay-seeded and live-appended logs are indistinguishable — the
  // property that makes a dismissal survive a reload.
  it('a replay-seeded log yields the same set as a live-appended one', () => {
    const replayed = TestBed.inject(MessageLogService);
    replayed.appendAll([
      closedNotification('e1', 'w-1'),
      closedNotification('e2', 'w-2'),
    ]);

    const live = new MessageLogService();
    live.append(closedNotification('e1', 'w-1'));
    live.append(closedNotification('e2', 'w-2'));

    expect(Array.from(closedNotificationIdsFold(replayed.snapshot())).sort())
      .toEqual(Array.from(closedNotificationIdsFold(live.snapshot())).sort());
  });

  it('reset() empties the set again (team switch clears dismissals)', () => {
    service.append(closedNotification('e1', 'w-1'));
    let observed: Set<string> | null = null;
    const sub = service.closedNotificationIds$.subscribe((v) => (observed = v));
    expect((observed as Set<string> | null)?.size).toBe(1);

    service.reset();

    expect((observed as Set<string> | null)?.size).toBe(0);
    sub.unsubscribe();
  });
});
