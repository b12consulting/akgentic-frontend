import { TestBed } from '@angular/core/testing';
import { MessageService } from 'primeng/api';
import { Toast } from 'primeng/toast';
import { BehaviorSubject, Subject } from 'rxjs';

import { NotificationToastService } from '../../../core/ui/notification-toast.service';
import { NotificationToasts } from './notification-toasts';
import { ActorAddress, AkgenticMessage } from '../../../protocol/message.types';

/**
 * Epic 34 (ADR-025 §1) — the FR10 slice.
 *
 * Every block below drives the unit with a plain `Subject` and a
 * `BehaviorSubject<Set<string>>` instead of a fake WebSocket. The MINIMAL
 * provider set is itself the dependency assertion (as in `connection-toast.spec.ts`
 * and `process-stores.spec.ts`): no `IngestionService`, no `WebSocketSubject`,
 * no `ApiService`, no `ConfigService`, no `MessageLogService`, no
 * `PerAgentStoreRegistry`, no `ProcessStores`. Four stories' worth of behaviour
 * (31-3, 31-4, 31-5, 31-6) that previously needed the whole ingestion pipeline
 * stood up now needs a stream, and if this unit ever grows a dependency every
 * test here fails at `TestBed.inject` with `NullInjectorError`.
 *
 * The four migrated blocks carry every `expect(...)` across from
 * `ingestion.service.spec.ts` unchanged (NFR1). Only the `TestBed`, the driving
 * mechanism (`inbound$.next(...)` for `fakeSocket.next(...)`,
 * `closedIds$.next(new Set([...]))` for a `ClosedNotification` reaching the log)
 * and the object a private is reached through have changed. Specs whose subject
 * is ORCHESTRATION rather than the toast — the message log, the disconnect
 * toast, teardown, team switch, and the one spec whose point is the 16 ms frame
 * window itself — deliberately stayed behind in `ingestion.service.spec.ts`,
 * where the transport harness that gives them their meaning still exists.
 */

function makeAddress(overrides: Partial<ActorAddress> = {}): ActorAddress {
  return {
    __actor_address__: true,
    name: '@Researcher',
    role: 'Worker',
    agent_id: 'agent-1',
    team_id: 'team-1',
    squad_id: 'squad-1',
    user_message: false,
    ...overrides,
  };
}

/**
 * One frame factory for the 31-3 and 31-6 blocks: a full `BaseMessage`-shaped
 * notification-family frame.
 *
 * Story 31-6 added the last two parameters and hoisted the factory to module
 * scope so both blocks build frames the same way. `contentType` and
 * `senderRole` are what FR19's summary is computed from — the role because
 * orchestrator detection is role-based, never name-based — and both default to
 * the 31-3 values (`null` / a non-orchestrator `'Worker'`), so every call
 * written before 31-6 keeps its exact previous meaning.
 */
function mkNotification(
  id: string,
  model: string,
  senderName: string,
  content: string,
  contentType: string | null = null,
  senderRole = 'Worker',
): any {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-08-12T00:00:00Z',
    sender: makeAddress({
      name: senderName,
      role: senderRole,
      agent_id: 'agent-' + id,
    }),
    display_type: 'other',
    content,
    content_type: contentType,
    __model__: model,
  };
}

const WARNING_MODEL = 'akgentic.core.messages.orchestrator.WarningMessage';
const NOTIFICATION_MODEL =
  'akgentic.core.messages.orchestrator.NotificationMessage';
const ERROR_MODEL = 'akgentic.core.messages.orchestrator.ErrorMessage';

/**
 * The `MessageService` double, in the EXACT `{ add, clear }` shape the migrated
 * blocks used inside `ingestion.service.spec.ts` — so every `add.calls`
 * assertion carries across byte for byte.
 */
function messageServiceDouble(): any {
  return {
    add: jasmine.createSpy('add'),
    clear: jasmine.createSpy('clear'),
  };
}

// ---------------------------------------------------------------------------
// Story 31-3 — Persistent closable toast with agent-name header (AC1-AC5, AC8-AC10)
//
// The service half of the story: what `showNotificationToast` puts on the wire
// to `MessageService.add`. The DOM half (close button, keyless rendering,
// coexistence) lives in `app.component.spec.ts`, because those three facts are
// PrimeNG contracts against the app's real `<p-toast>` mount and cannot be
// observed from a spy argument.
//
// Migrated from `ingestion.service.spec.ts` by Epic 34 / story 34-5. Two specs
// stayed behind there: "the WarningMessage still reaches the message log" (its
// subject is the log feed, which this unit does not own) and "the disconnect
// toast is unchanged" (its subject is `ConnectionToast` on the WS error path).
// ---------------------------------------------------------------------------

describe('NotificationToasts — Story 31-3 (notification toast)', () => {
  let toasts: NotificationToasts;
  let msgService: any;
  let inbound$: Subject<AkgenticMessage>;
  let closedIds$: BehaviorSubject<Set<string>>;

  const WARNING = WARNING_MODEL;
  const NOTIFICATION = NOTIFICATION_MODEL;
  const ERROR = ERROR_MODEL;

  function addArgs(): any[] {
    return msgService.add.calls.allArgs().map((a: any[]) => a[0]);
  }

  beforeEach(() => {
    inbound$ = new Subject<AkgenticMessage>();
    closedIds$ = new BehaviorSubject<Set<string>>(new Set<string>());

    TestBed.configureTestingModule({
      providers: [
        NotificationToasts,
        { provide: MessageService, useValue: messageServiceDouble() },
      ],
    });
    toasts = TestBed.inject(NotificationToasts);
    msgService = TestBed.inject(MessageService);
  });

  /** The orchestrator's `start()` call, which every frame below arrives after. */
  function start(): void {
    toasts.start(inbound$.asObservable(), closedIds$.asObservable());
  }

  it('AC2/AC3/AC4/AC5: a WarningMessage raises one warn toast headed by the sender name', () => {
    start();

    inbound$.next(
      mkNotification('w-1', WARNING, '@Researcher', 'token budget exceeded'),
    );

    expect(msgService.add).toHaveBeenCalledTimes(1);
    const arg = addArgs()[0];
    expect(arg.severity).toBe('warn');
    expect(arg.summary).toBe('@Researcher');
    expect(arg.detail).toBe('token budget exceeded');
    expect(arg.sticky).toBeTrue();
    expect(arg.data.messageId).toBe('w-1');
  });

  it('AC4: the toast carries no `life` — it is permanent until dismissed', () => {
    start();

    inbound$.next(mkNotification('w-1', WARNING, '@Researcher', 'over limit'));

    expect(addArgs()[0].life).toBeUndefined();
  });

  it('AC6: the toast does NOT set closable:false (the ConnectionToast trap)', () => {
    start();

    inbound$.next(mkNotification('w-1', WARNING, '@Researcher', 'over limit'));

    // `closable` must be absent (PrimeNG default true). Anything other than
    // `undefined` here means the disconnect toast was copy-pasted.
    expect(addArgs()[0].closable).toBeUndefined();
  });

  it('AC7: the toast carries no `key` — the keyless mount would reject a keyed message', () => {
    start();

    inbound$.next(mkNotification('w-1', WARNING, '@Researcher', 'over limit'));

    expect(addArgs()[0].key).toBeUndefined();
  });

  // Story 31-6 (AC #10) supersedes 31-3's AC2 here: the literal `'Agent'`
  // fallback is gone with the `event.sender?.name ?? 'Agent'` expression that
  // produced it. A nameless sender contributes no name part, and with a null
  // `content_type` nothing survives to head the toast — so the per-severity
  // fallback does, which for a warning is `'Warning'`.
  it('AC #10: a sender without a name falls back to the per-severity header', () => {
    start();

    const frame = mkNotification('w-1', WARNING, '@X', 'over limit');
    delete frame.sender.name;
    inbound$.next(frame);

    expect(addArgs()[0].summary).toBe('Warning');
  });

  it('AC5: a bare NotificationMessage raises an info toast, never warn', () => {
    start();

    inbound$.next(mkNotification('n-1', NOTIFICATION, '@Planner', 'heads up'));

    expect(msgService.add).toHaveBeenCalledTimes(1);
    const arg = addArgs()[0];
    expect(arg.severity).toBe('info');
    expect(arg.summary).toBe('@Planner');
    expect(arg.detail).toBe('heads up');
    expect(arg.sticky).toBeTrue();
  });

  it('AC5: a WarningMessage never yields severity "info"', () => {
    start();

    inbound$.next(mkNotification('w-1', WARNING, '@Researcher', 'over limit'));

    expect(addArgs().filter((c) => c.severity === 'info').length).toBe(0);
  });

  it('AC8: two WarningMessages with different ids produce two toasts with distinct data.messageId', () => {
    start();

    inbound$.next(mkNotification('w-1', WARNING, '@Alpha', 'first'));
    inbound$.next(mkNotification('w-2', WARNING, '@Beta', 'second'));

    expect(msgService.add).toHaveBeenCalledTimes(2);
    const ids = addArgs().map((c) => c.data.messageId);
    expect(ids).toEqual(['w-1', 'w-2']);
    expect(ids[0]).not.toBe(ids[1]);
  });

  // Story 31-6 (AC #3) — REWRITTEN in place. This spec pinned 31-3's AC10, the
  // deliberate non-regression that kept `ErrorMessage` on its pre-existing
  // 5-second toast (`summary: 'Error'`, `life: 5000`). 31-6 reverses that
  // decision on purpose, so the old expectations are obsolete rather than
  // broken. Its "and no warn/info toast" half survives untouched: it is exactly
  // the assertion that catches an error being classified as `'info'`.
  it('AC #3: an ErrorMessage raises exactly one STICKY error toast and no warn/info toast', () => {
    start();

    inbound$.next(mkNotification('e-1', ERROR, '@Researcher', 'boom'));

    expect(msgService.add).toHaveBeenCalledTimes(1);
    const arg = addArgs()[0];
    expect(arg.severity).toBe('error');
    expect(arg.summary).toBe('@Researcher');
    expect(arg.detail).toBe('boom');
    expect(arg.sticky).toBeTrue();
    // The three omissions the whole family shares — `life` above all, which
    // silently defeats `sticky: true`.
    expect(arg.life).toBeUndefined();
    expect(arg.key).toBeUndefined();
    expect(arg.closable).toBeUndefined();
    // FR18 is free precisely because this field is present on the error path
    // too: `AppComponent.onToastClose` reads nothing else.
    expect(arg.data).toEqual({ messageId: 'e-1', teamId: 'team-1' });
    expect(
      addArgs().filter((c) => c.severity === 'warn' || c.severity === 'info')
        .length,
    ).toBe(0);
  });

  it('AC10: unrelated frame types raise no toast at all', () => {
    start();

    for (const model of [
      'akgentic.core.messages.orchestrator.SentMessage',
      'akgentic.core.messages.orchestrator.StartMessage',
      'akgentic.core.messages.orchestrator.StateChangedMessage',
      'akgentic.core.messages.orchestrator.EventMessage',
    ]) {
      inbound$.next(mkNotification('x-1', model, '@Researcher', 'inert'));
    }

    expect(msgService.add).not.toHaveBeenCalled();
  });

  // Story 31-4 (AC #3/#4): the toast now also carries the team id, so
  // `AppComponent.onToastClose` can address the dismissal POST without reading
  // navigation state.
  it('31-4: the toast carries data.teamId alongside data.messageId', () => {
    start();

    inbound$.next(mkNotification('w-1', WARNING, '@Researcher', 'over limit'));

    expect(addArgs()[0].data).toEqual({ messageId: 'w-1', teamId: 'team-1' });
  });
});

// ---------------------------------------------------------------------------
// Story 31-6 — errors join the notification family; shared severity; summary
//
// Two separable contracts, both observed through `MessageService.add`:
//
//   * the SEVERITY the toast is raised at (AC #5), which is the story's silent
//     failure mode. Widening `showNotificationToast` to admit errors made the
//     old `isWarningMessage(event) ? 'warn' : 'info'` expression wrong without
//     making anything fail: an error simply rendered blue. The three assertions
//     below are the guard, and the mutation check in the Dev Agent Record is
//     what proves they are a guard and not decoration.
//   * the SUMMARY the toast is headed by (AC #7-#11) — `"{name} - {type}"` with
//     either half droppable, which is four join cases plus the role-vs-name
//     pair.
//
// Migrated by story 34-5. Three specs stayed in `ingestion.service.spec.ts`:
// the two AC #14 log-and-messageList$ ones and the AC #15 disconnect toast.
// ---------------------------------------------------------------------------

describe('NotificationToasts — Story 31-6 (error parity, severity, summary)', () => {
  let toasts: NotificationToasts;
  let msgService: any;
  let inbound$: Subject<AkgenticMessage>;
  let closedIds$: BehaviorSubject<Set<string>>;

  function addArgs(): any[] {
    return msgService.add.calls.allArgs().map((a: any[]) => a[0]);
  }

  beforeEach(() => {
    inbound$ = new Subject<AkgenticMessage>();
    closedIds$ = new BehaviorSubject<Set<string>>(new Set<string>());

    TestBed.configureTestingModule({
      providers: [
        NotificationToasts,
        { provide: MessageService, useValue: messageServiceDouble() },
      ],
    });
    toasts = TestBed.inject(NotificationToasts);
    msgService = TestBed.inject(MessageService);
  });

  function start(): void {
    toasts.start(inbound$.asObservable(), closedIds$.asObservable());
  }

  /** Push one frame and return the single `MessageService.add` argument. */
  function toastFor(frame: any): any {
    inbound$.next(frame);
    expect(msgService.add).toHaveBeenCalledTimes(1);
    return addArgs()[0];
  }

  // --- AC #5: the severity partition, one assertion per member -------------

  it('AC #5: an ErrorMessage is raised at severity "error"', () => {
    start();

    expect(
      toastFor(mkNotification('e-1', ERROR_MODEL, '@Researcher', 'boom'))
        .severity,
    ).toBe('error');
  });

  it('AC #5: a WarningMessage is raised at severity "warn"', () => {
    start();

    expect(
      toastFor(mkNotification('w-1', WARNING_MODEL, '@Researcher', 'careful'))
        .severity,
    ).toBe('warn');
  });

  it('AC #5: a bare NotificationMessage is raised at severity "info"', () => {
    start();

    expect(
      toastFor(mkNotification('n-1', NOTIFICATION_MODEL, '@Planner', 'fyi'))
        .severity,
    ).toBe('info');
  });

  // The mutation target, stated as its own spec. Restoring
  // `isWarningMessage(event) ? 'warn' : 'info'` in `showNotificationToast`
  // sends an ErrorMessage to `'info'` — `isWarningMessage` is false for it —
  // and turns THIS red while every other severity spec stays green.
  it('AC #5: an ErrorMessage NEVER yields severity "info"', () => {
    start();

    inbound$.next(mkNotification('e-1', ERROR_MODEL, '@Researcher', 'boom'));

    expect(addArgs().filter((c) => c.severity === 'info').length).toBe(0);
    expect(addArgs()[0].severity).not.toBe('info');
  });

  // --- AC #4: one dispatch, no second `messageService.add` in the handler --

  it('AC #4: all three severities route through the one toast method', () => {
    start();
    // Epic 34 / story 34-5: the METHOD NAME is unchanged, so this reaches the
    // same private it always did — only the object it reaches into moved from
    // `IngestionService` to this unit.
    const shown = spyOn<any>(toasts, 'showNotificationToast').and.callThrough();

    inbound$.next(mkNotification('e-1', ERROR_MODEL, '@A', 'boom'));
    inbound$.next(mkNotification('w-1', WARNING_MODEL, '@B', 'careful'));
    inbound$.next(mkNotification('n-1', NOTIFICATION_MODEL, '@C', 'fyi'));

    // Three frames, three calls to the shared method, three toasts: no branch
    // in the WS handler raised a toast of its own.
    expect(shown).toHaveBeenCalledTimes(3);
    expect(msgService.add).toHaveBeenCalledTimes(3);
    expect(shown.calls.allArgs().map((a: any[]) => a[1])).toEqual([
      'error',
      'warn',
      'info',
    ]);
  });

  // --- AC #7-#10: the four join cases --------------------------------------

  it('AC #7: name and content_type are joined by exactly " - "', () => {
    start();

    const arg = toastFor(
      mkNotification('e-1', ERROR_MODEL, '@Researcher', 'boom', 'ValueError'),
    );

    expect(arg.summary).toBe('@Researcher - ValueError');
  });

  it('AC #8: an orchestrator sender contributes no name and no leading separator', () => {
    start();

    const arg = toastFor(
      mkNotification(
        'n-1',
        NOTIFICATION_MODEL,
        '@Orchestrator',
        'fyi',
        'Info',
        'Orchestrator',
      ),
    );

    expect(arg.summary).toBe('Info');
  });

  it('AC #9: a null content_type contributes no type and no trailing separator', () => {
    start();

    const arg = toastFor(
      mkNotification('w-1', WARNING_MODEL, '@Researcher', 'careful', null),
    );

    expect(arg.summary).toBe('@Researcher');
  });

  it('AC #9: an EMPTY-string content_type is dropped exactly as null is', () => {
    start();

    const arg = toastFor(
      mkNotification('w-1', WARNING_MODEL, '@Researcher', 'careful', ''),
    );

    expect(arg.summary).toBe('@Researcher');
  });

  it('AC #10: orchestrator + null content_type falls back per severity', () => {
    start();

    for (const [id, model, expected] of [
      ['e-1', ERROR_MODEL, 'Error'],
      ['w-1', WARNING_MODEL, 'Warning'],
      ['n-1', NOTIFICATION_MODEL, 'Notification'],
    ] as const) {
      msgService.add.calls.reset();
      const arg = toastFor(
        mkNotification(id, model, '@Orchestrator', 'body', null, 'Orchestrator'),
      );
      expect(arg.summary).withContext(model).toBe(expected);
    }
  });

  it('AC #10: a missing sender falls back per severity rather than throwing', () => {
    start();

    const frame = mkNotification('e-1', ERROR_MODEL, '@Researcher', 'boom');
    delete frame.sender;

    expect(toastFor(frame).summary).toBe('Error');
  });

  // The fallback is NOT `LEGEND_FALLBACK`, whose `error → null` would render a
  // blank toast header. Pinned as its own assertion because reusing that table
  // is the tempting shortcut and it fails only on the error path.
  it('AC #10: the error fallback is a real string, never null or empty', () => {
    start();

    const summary = toastFor(
      mkNotification('e-1', ERROR_MODEL, '@Orch', 'boom', null, 'Orchestrator'),
    ).summary;

    expect(summary).toBe('Error');
    expect(summary).not.toBeNull();
    expect(summary.length).toBeGreaterThan(0);
  });

  // --- AC #11: role-based detection, both directions -----------------------

  it('AC #11: the orchestrator is detected by role even when its name is NOT @Orchestrator', () => {
    start();

    const arg = toastFor(
      mkNotification(
        'n-1',
        NOTIFICATION_MODEL,
        '@TeamLead',
        'fyi',
        'Info',
        'Orchestrator',
      ),
    );

    // A name-based implementation would keep '@TeamLead' and produce
    // '@TeamLead - Info'.
    expect(arg.summary).toBe('Info');
  });

  it('AC #11: a NON-orchestrator role keeps its name even when it is named @Orchestrator', () => {
    start();

    const arg = toastFor(
      mkNotification(
        'w-1',
        WARNING_MODEL,
        '@Orchestrator',
        'careful',
        'Budget',
        'Researcher',
      ),
    );

    // A name-based implementation would drop the name and produce 'Budget'.
    expect(arg.summary).toBe('@Orchestrator - Budget');
  });

  // --- AC #15: the untouched neighbours ------------------------------------

  it('AC #15: inert frame types still raise no toast at all', () => {
    start();

    for (const model of [
      'akgentic.core.messages.orchestrator.SentMessage',
      'akgentic.core.messages.orchestrator.StartMessage',
      'akgentic.core.messages.orchestrator.StateChangedMessage',
      'akgentic.core.messages.orchestrator.EventMessage',
    ]) {
      inbound$.next(mkNotification('x-1', model, '@Researcher', 'inert'));
    }

    expect(msgService.add).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Story 31-4 — closed-notification suppression
//
// The sequencing that used to be load-bearing HERE — every 31-4 sequence ticked
// past the 16 ms `bufferTime` window so a `ClosedNotification` reached the log
// before a later frame could be suppressed — is expressed directly now: the
// closure arrives as an emission on `closedIds$`, which is exactly what the log
// fold produced then. The window itself has NOT gone away and is NOT this unit's
// (see the AC3(a) spec left in `ingestion.service.spec.ts`).
//
// Migrated by story 34-5. Five specs stayed behind: the three log /
// messageList$ ones, the `getEvents` REST-replay one, and the ngOnDestroy
// teardown one — all orchestration rather than toast.
// ---------------------------------------------------------------------------

describe('NotificationToasts — Story 31-4 (closed-notification suppression)', () => {
  let toasts: NotificationToasts;
  let msgService: any;
  let inbound$: Subject<AkgenticMessage>;
  let closedIds$: BehaviorSubject<Set<string>>;

  const WARNING = 'akgentic.core.messages.orchestrator.WarningMessage';
  const ERROR = 'akgentic.core.messages.orchestrator.ErrorMessage';

  /** Story 31-6 added the `model` parameter: the suppressor is keyed on the id
   *  alone and never inspects `__model__`, so the same specs must hold for an
   *  ErrorMessage now that errors toast through the same method (AC #13). */
  function mkWarning(id: string, content: string, model = WARNING): any {
    return {
      id,
      parent_id: null,
      team_id: 'team-1',
      timestamp: '2026-08-12T00:00:00Z',
      sender: makeAddress({ name: '@Researcher', agent_id: 'agent-' + id }),
      display_type: 'other',
      content,
      content_type: null,
      __model__: model,
    };
  }

  function addArgs(): any[] {
    return msgService.add.calls.allArgs().map((a: any[]) => a[0]);
  }

  beforeEach(() => {
    inbound$ = new Subject<AkgenticMessage>();
    closedIds$ = new BehaviorSubject<Set<string>>(new Set<string>());

    TestBed.configureTestingModule({
      providers: [
        NotificationToasts,
        { provide: MessageService, useValue: messageServiceDouble() },
      ],
    });
    toasts = TestBed.inject(NotificationToasts);
    msgService = TestBed.inject(MessageService);
  });

  function start(): void {
    toasts.start(inbound$.asObservable(), closedIds$.asObservable());
  }

  /** The closure reaching the log, i.e. `closedNotificationIds$` re-emitting. */
  function close(...ids: string[]): void {
    closedIds$.next(new Set(ids));
  }

  it('AC9: a WarningMessage whose id was closed raises ZERO toasts', () => {
    start();

    close('w-1');

    inbound$.next(mkWarning('w-1', 'token budget exceeded'));

    expect(msgService.add).not.toHaveBeenCalled();
  });

  it('AC9: a WarningMessage whose id was NOT closed still raises exactly one toast with the full 31-3 property set', () => {
    start();

    close('some-other-id');

    inbound$.next(mkWarning('w-1', 'token budget exceeded'));

    expect(msgService.add).toHaveBeenCalledTimes(1);
    const arg = addArgs()[0];
    expect(arg.severity).toBe('warn');
    expect(arg.summary).toBe('@Researcher');
    expect(arg.detail).toBe('token budget exceeded');
    expect(arg.sticky).toBeTrue();
    expect(arg.key).toBeUndefined();
    expect(arg.closable).toBeUndefined();
    expect(arg.life).toBeUndefined();
    expect(arg.data).toEqual({ messageId: 'w-1', teamId: 'team-1' });
  });

  it('AC9: only the matching id is suppressed — a sibling warning still toasts', () => {
    start();

    close('w-1');

    inbound$.next(mkWarning('w-1', 'suppressed'));
    inbound$.next(mkWarning('w-2', 'still shown'));

    expect(msgService.add).toHaveBeenCalledTimes(1);
    expect(addArgs()[0].data.messageId).toBe('w-2');
  });

  it('AC9: a closure for an id that never toasts is inert', () => {
    start();

    close('never-seen');

    expect(msgService.add).not.toHaveBeenCalled();
  });

  // Story 31-6 (AC #13) — the error half of the suppressor, proven with error
  // fixtures rather than warning ones. No production code was added to reach
  // this: `closedNotificationIds.has(event.id)` never looked at `__model__`, so
  // routing errors through `showNotificationToast` covered them for free.
  it('AC #13: an ErrorMessage whose id was closed raises ZERO toasts', () => {
    start();

    close('e-1');

    inbound$.next(mkWarning('e-1', 'boom', ERROR));

    expect(msgService.add).not.toHaveBeenCalled();
  });

  it('AC #13: an ErrorMessage whose id was NOT closed still raises its sticky error toast', () => {
    start();

    close('some-other-id');

    inbound$.next(mkWarning('e-1', 'boom', ERROR));

    expect(msgService.add).toHaveBeenCalledTimes(1);
    const arg = addArgs()[0];
    expect(arg.severity).toBe('error');
    expect(arg.sticky).toBeTrue();
    expect(arg.life).toBeUndefined();
    expect(arg.data).toEqual({ messageId: 'e-1', teamId: 'team-1' });
  });
});

// ---------------------------------------------------------------------------
// Story 31-5 — a ClosedNotification takes its toast back off the screen
//
// Story 31-4 stopped a dismissed warning from toasting when the closure was
// already known. It could not help when the closure arrives SECOND, which is
// exactly what a reload does: history replays from cursor 0, so the older
// `WarningMessage` lands before its newer `ClosedNotification`, and until this
// story nothing ever removed the toast that opened in between. It stayed, every
// reload, for ever.
//
// These specs therefore assert against toasts that are ON SCREEN, not against
// `MessageService.add` call counts — a count cannot tell "never raised" apart
// from "raised and then removed", and the whole story lives in that difference.
// `FakeToastContainer` stands in for the app's `<p-toast>`: it mirrors the two
// PrimeNG behaviours the app depends on (a keyless mount admits only keyless
// messages; a no-arg `clear()` empties it), both of which are pinned against
// the real mount in `app.component.spec.ts`.
//
// Migrated by story 34-5 with its harness INTACT: the real `MessageService`, the
// real root `NotificationToastService` and the real `FakeToastContainer` mount.
// Substituting a `dismiss` spy here would assert that a call was made rather
// than that the toast left the screen, which is the whole story — a toast mount
// is not a transport harness. Five specs stayed in `ingestion.service.spec.ts`:
// the one-replay-frame spec (its subject is the 16 ms window), the disconnect
// toast, messageList$, the destroy teardown and the team switch.
// ---------------------------------------------------------------------------

/** Minimal stand-in for the app's single keyless `<p-toast>`. */
class FakeToastContainer {
  messages: any[] = [];
  cd = { markForCheck: jasmine.createSpy('markForCheck') };

  constructor(messageService: MessageService) {
    messageService.messageObserver.subscribe((m: any) => {
      const incoming = Array.isArray(m) ? m : [m];
      // PrimeNG's `Toast.canAdd`: `this.key === message.key`. This mount has no
      // key, so a keyed message is silently dropped.
      this.messages.push(...incoming.filter((x) => x.key === undefined));
    });
    messageService.clearObserver.subscribe((key: any) => {
      if (!key) this.messages = [];
    });
  }

  summaries(): string[] {
    return this.messages.map((m) => m.summary);
  }

  messageIds(): (string | undefined)[] {
    return this.messages.map((m) => m.data?.messageId);
  }
}

describe('NotificationToasts — Story 31-5 (reactive toast removal)', () => {
  let toasts: NotificationToasts;
  let messageService: MessageService;
  let toastContainer: FakeToastContainer;
  let inbound$: Subject<AkgenticMessage>;
  let closedIds$: BehaviorSubject<Set<string>>;

  const WARNING = 'akgentic.core.messages.orchestrator.WarningMessage';
  const ERROR = 'akgentic.core.messages.orchestrator.ErrorMessage';

  /** Story 31-6 added the `model` parameter: removal is addressed by
   *  `data.messageId` and never by `__model__`, so an error toast comes off the
   *  screen by the same path a warning does (AC #13). */
  function mkWarning(
    id: string,
    content = 'token budget exceeded',
    model = WARNING,
  ): any {
    return {
      id,
      parent_id: null,
      team_id: 'team-1',
      timestamp: '2026-08-13T00:00:00Z',
      sender: makeAddress({ name: '@Researcher', agent_id: 'agent-' + id }),
      display_type: 'other',
      content,
      content_type: null,
      __model__: model,
    };
  }

  beforeEach(() => {
    inbound$ = new Subject<AkgenticMessage>();
    closedIds$ = new BehaviorSubject<Set<string>>(new Set<string>());

    TestBed.configureTestingModule({
      providers: [NotificationToasts, MessageService],
    });
    messageService = TestBed.inject(MessageService);
    toastContainer = new FakeToastContainer(messageService);
    TestBed.inject(NotificationToastService).register(
      toastContainer as unknown as Toast,
    );

    toasts = TestBed.inject(NotificationToasts);
  });

  function start(): void {
    toasts.start(inbound$.asObservable(), closedIds$.asObservable());
  }

  /** The closure reaching the log, i.e. `closedNotificationIds$` re-emitting. */
  function close(...ids: string[]): void {
    closedIds$.next(new Set(ids));
  }

  // --- AC #4: the reload regression, written as "one THEN zero" -------------

  it('AC #4: replaying WarningMessage(X) then ClosedNotification(X) leaves zero toasts', () => {
    start();

    inbound$.next(mkWarning('w-1'));
    // ONE: the toast really did open. Without this the spec would also pass
    // against a build where the warning never toasted at all — which would hide
    // a regression in 31-2 / 31-3 rather than prove 31-5.
    expect(toastContainer.messageIds()).toEqual(['w-1']);

    close('w-1');

    // THEN ZERO.
    expect(toastContainer.messages).toEqual([]);
  });

  // Story 31-6 (AC #13) — the same reload regression, with an ErrorMessage.
  // Before 31-6 an error toast drained itself in five seconds, so it had no
  // dismissal to survive; now it is sticky, and this is what stops a dismissed
  // error coming back on every reload for ever.
  it('AC #13: replaying ErrorMessage(X) then ClosedNotification(X) leaves zero toasts', () => {
    start();

    inbound$.next(mkWarning('e-1', 'boom', ERROR));
    // ONE: the error toast really did open, at severity 'error'.
    expect(toastContainer.messageIds()).toEqual(['e-1']);
    expect(toastContainer.messages[0].severity).toBe('error');

    close('e-1');

    // THEN ZERO.
    expect(toastContainer.messages).toEqual([]);
  });

  it('AC #13: a dismissed error does not take its warning neighbour with it', () => {
    start();

    inbound$.next(mkWarning('e-1', 'boom', ERROR));
    inbound$.next(mkWarning('w-1', 'careful'));
    expect(toastContainer.messageIds()).toEqual(['e-1', 'w-1']);

    close('e-1');

    expect(toastContainer.messageIds()).toEqual(['w-1']);
  });

  // --- AC #3: order independence, both directions --------------------------

  it('AC #3a: WarningMessage(X) then ClosedNotification(X) — removed reactively', () => {
    start();

    inbound$.next(mkWarning('w-1'));
    expect(toastContainer.messageIds()).toEqual(['w-1']);

    close('w-1');

    expect(toastContainer.messages).toEqual([]);
  });

  it('AC #3b: ClosedNotification(X) then WarningMessage(X) — suppressed, never shown', () => {
    start();

    close('w-1');

    inbound$.next(mkWarning('w-1'));

    expect(toastContainer.messages).toEqual([]);
  });

  // --- AC #2 / AC #5: only the matching toast goes ---------------------------

  it('AC #2: a sibling notification toast survives its neighbour being dismissed', () => {
    start();

    inbound$.next(mkWarning('w-1', 'first'));
    inbound$.next(mkWarning('w-2', 'second'));
    expect(toastContainer.messageIds()).toEqual(['w-1', 'w-2']);

    close('w-1');

    expect(toastContainer.messageIds()).toEqual(['w-2']);
  });

  it('AC #5: an undismissed warning stays, and unrelated closures do not touch it', () => {
    start();

    inbound$.next(mkWarning('y-1'));
    close('some-other-id');
    close('some-other-id', 'another-id');

    expect(toastContainer.messageIds()).toEqual(['y-1']);
  });

  // --- AC #6: live path unchanged -------------------------------------------

  it('AC #6: a live WarningMessage still toasts immediately', () => {
    start();

    inbound$.next(mkWarning('w-1', 'over limit'));

    expect(toastContainer.messages.length).toBe(1);
    expect(toastContainer.messages[0]).toEqual(
      jasmine.objectContaining({
        severity: 'warn',
        summary: '@Researcher',
        detail: 'over limit',
        sticky: true,
        data: { messageId: 'w-1', teamId: 'team-1' },
      }),
    );
  });

  it('AC #6: the round-trip closure for a toast the user already closed is inert', () => {
    start();

    inbound$.next(mkWarning('w-1'));
    inbound$.next(mkWarning('w-2'));
    // The user clicks the close cross: PrimeNG splices the entry itself, then
    // `AppComponent.onToastClose` POSTs and the backend echoes the closure back.
    toastContainer.messages.splice(0, 1);

    expect(() => {
      close('w-1');
    }).not.toThrow();

    // No double-removal: the neighbour is still there.
    expect(toastContainer.messageIds()).toEqual(['w-2']);
  });

  // --- AC #8 / AC #9: hygiene ------------------------------------------------

  it('AC #8: removal issues no blanket clear', () => {
    start();
    const clearSpy = spyOn(messageService, 'clear').and.callThrough();

    inbound$.next(mkWarning('w-1'));
    close('w-1');

    expect(clearSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Story 34-5 — the lifecycle and scoping this extraction ADDS
//
// Nothing below is migrated. These are the guarantees that did not exist while
// the surface lived in `IngestionService`: an explicit start/stop pair replacing
// a field-initializer subscription, a per-cycle dismissal cache, and a component
// scope that no existing spec would notice the loss of.
// ---------------------------------------------------------------------------

describe('NotificationToasts — explicit lifecycle (AC2, AC9)', () => {
  let toasts: NotificationToasts;
  let msgService: any;
  let dismiss: jasmine.Spy;
  let inbound$: Subject<AkgenticMessage>;

  beforeEach(() => {
    inbound$ = new Subject<AkgenticMessage>();
    dismiss = jasmine.createSpy('dismiss');

    TestBed.configureTestingModule({
      providers: [
        NotificationToasts,
        { provide: MessageService, useValue: messageServiceDouble() },
        {
          provide: NotificationToastService,
          useValue: { dismiss, register: jasmine.createSpy('register') },
        },
      ],
    });
    toasts = TestBed.inject(NotificationToasts);
    msgService = TestBed.inject(MessageService);
  });

  function emptyIds(): BehaviorSubject<Set<string>> {
    return new BehaviorSubject<Set<string>>(new Set<string>());
  }

  it('AC2: construction alone subscribes to nothing and raises nothing', () => {
    // The defect being removed: this subscription used to be a FIELD
    // INITIALIZER, so merely constructing the service opened it — which is also
    // why the class had to document that `notificationToast` be declared above
    // it. Resolving the unit must now be inert.
    inbound$.next(
      mkNotification('w-1', WARNING_MODEL, '@Researcher', 'over limit'),
    );

    expect(msgService.add).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('AC2: stop() before any start() does not throw', () => {
    expect(() => toasts.stop()).not.toThrow();
    expect(() => toasts.stop()).not.toThrow();
  });

  it('AC2: after stop(), a frame on the same stream raises nothing', () => {
    toasts.start(inbound$.asObservable(), emptyIds().asObservable());
    toasts.stop();

    inbound$.next(
      mkNotification('w-1', WARNING_MODEL, '@Researcher', 'over limit'),
    );

    expect(msgService.add).not.toHaveBeenCalled();
  });

  it('AC2: a stop()/start() re-init cycle raises exactly ONE toast per event', () => {
    // The double-dispatch guard. A second live subscription on the same stream
    // would toast every notification twice — visible to the user, invisible to
    // every assertion that only checks a toast's CONTENT.
    toasts.start(inbound$.asObservable(), emptyIds().asObservable());
    toasts.stop();
    toasts.start(inbound$.asObservable(), emptyIds().asObservable());

    inbound$.next(
      mkNotification('w-1', WARNING_MODEL, '@Researcher', 'over limit'),
    );

    expect(msgService.add).toHaveBeenCalledTimes(1);
  });

  it('AC9: stop() clears the dismissal cache, so a replayed closure dismisses again', () => {
    // The subscription changed lifetime with this extraction: service-lifetime
    // before, per-init-cycle now. The two are equivalent ONLY because `stop()`
    // resets the cache — it stands in for the empty emission `log.reset()` used
    // to produce. Drop the reset and the second cycle's ids are no longer NEW,
    // so `dismiss(...)` is silently skipped and a toast that should come down
    // stays up with nothing failing.
    toasts.start(
      inbound$.asObservable(),
      new BehaviorSubject<Set<string>>(new Set(['x'])).asObservable(),
    );
    expect(dismiss).toHaveBeenCalledTimes(1);

    toasts.stop();
    toasts.start(
      inbound$.asObservable(),
      new BehaviorSubject<Set<string>>(new Set(['x'])).asObservable(),
    );

    expect(dismiss).toHaveBeenCalledTimes(2);
    expect(dismiss.calls.allArgs()).toEqual([['x'], ['x']]);
  });

  it('AC8: only ids NEW to the set are dismissed, never the whole set again', () => {
    const closedIds$ = emptyIds();
    toasts.start(inbound$.asObservable(), closedIds$.asObservable());

    closedIds$.next(new Set(['a']));
    closedIds$.next(new Set(['a', 'b']));
    closedIds$.next(new Set(['a', 'b']));

    expect(dismiss.calls.allArgs()).toEqual([['a'], ['b']]);
  });
});

describe('NotificationToasts — the toast payload is exactly five keys (AC7)', () => {
  it('AC7: no sixth property, and `data` carries exactly messageId and teamId', () => {
    const msgService = messageServiceDouble();
    TestBed.configureTestingModule({
      providers: [
        NotificationToasts,
        { provide: MessageService, useValue: msgService },
      ],
    });
    const toasts = TestBed.inject(NotificationToasts);
    const inbound$ = new Subject<AkgenticMessage>();
    toasts.start(
      inbound$.asObservable(),
      new BehaviorSubject<Set<string>>(new Set<string>()).asObservable(),
    );

    inbound$.next(
      mkNotification('w-1', WARNING_MODEL, '@Researcher', 'over limit'),
    );

    // The KEY SET, not `objectContaining`: three of this payload's properties
    // are defined by their ABSENCE (`key` is dropped by the keyless mount,
    // `closable` is the disconnect toast's opposite, `life` defeats `sticky`),
    // and a containment assertion cannot see an added property at all.
    const payload = msgService.add.calls.mostRecent().args[0];
    expect(Object.keys(payload).sort()).toEqual([
      'data',
      'detail',
      'severity',
      'sticky',
      'summary',
    ]);
    expect(Object.keys(payload.data).sort()).toEqual(['messageId', 'teamId']);
  });
});

describe('NotificationToasts — component-scoped, never root-provided (AC12)', () => {
  it('is NOT reachable from an injector that does not provide it', () => {
    TestBed.resetTestingModule();
    // `MessageService` IS available here, and `NotificationToastService` is
    // root-provided, so the injection can only fail on `NotificationToasts`
    // itself. Give the class `providedIn: 'root'` and this injection SUCCEEDS
    // instead — and one dismissal cache would then be shared across every team
    // the user visits, silently suppressing the next team's toasts. On story
    // 34-1 that exact mutation left the ENTIRE suite green, because every other
    // `TestBed` provides the class explicitly.
    TestBed.configureTestingModule({
      providers: [
        { provide: MessageService, useValue: messageServiceDouble() },
      ],
    });

    expect(() => TestBed.inject(NotificationToasts)).toThrowError(
      /No provider/,
    );
  });
});
