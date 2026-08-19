import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';

import { ApiService } from '../../../core/http/api.service';
import { ContextService } from '../../../core/context/context.service';
import { TeamStatusReactor } from './team-status-reactor';
import {
  ActorAddress,
  AkgenticMessage,
  CLOSED_NOTIFICATION_MODEL,
  EVENT_MESSAGE_MODEL,
} from '../../../protocol/message.types';

/**
 * Story 37-2 — the team-stopping reactor (AC6-AC10).
 *
 * The unit is driven with a plain `Subject` standing in for
 * `log.appended$.pipe(concatAll())`, and the MINIMAL provider set is itself the
 * dependency assertion: no `IngestionService`, no `MessageLogService`, no
 * `TeamSocket`, no `Router`. `ApiService` is provided ONLY so AC10 can assert
 * positively that nothing on the event path reaches for it — if this unit ever
 * grows a dependency, every test here fails at `TestBed.inject` with
 * `NullInjectorError`.
 *
 * `akgentic-core` PR #136 is unmerged, so no running backend emits this event
 * yet: the envelope is synthesised here, and nothing in the production unit
 * feature-detects the server version.
 */

const TEAM_STOPPING_MODEL =
  'akgentic.core.messages.orchestrator.TeamStoppingEvent';
const STOP_MESSAGE_MODEL = 'akgentic.core.messages.orchestrator.StopMessage';

function makeAddress(overrides: Partial<ActorAddress> = {}): ActorAddress {
  return {
    __actor_address__: true,
    name: '@Orchestrator',
    role: 'Orchestrator',
    agent_id: 'orchestrator-1',
    team_id: 'team-A',
    squad_id: 'squad-1',
    user_message: false,
    ...overrides,
  };
}

/**
 * The frame the orchestrator puts on the wire when it begins tearing a team
 * down: the standard `EventMessage` envelope carrying a FIELD-LESS inner
 * payload. The inner object has exactly one key on purpose — upstream the
 * dataclass carries nothing, because the envelope already supplies `team_id`,
 * `timestamp` and `sender`.
 */
function mkEventMessage(teamId: string, innerModel: string): any {
  return {
    id: 'evt-' + innerModel,
    parent_id: null,
    team_id: teamId,
    timestamp: '2026-08-19T10:00:00Z',
    sender: makeAddress({ team_id: teamId }),
    display_type: 'other',
    content: null,
    __model__: EVENT_MESSAGE_MODEL,
    event: { __model__: innerModel },
  };
}

/** An ORDINARY agent's teardown — not the team's. AC7's regression guard. */
function mkStopMessage(teamId: string): any {
  return {
    id: 'stop-1',
    parent_id: null,
    team_id: teamId,
    timestamp: '2026-08-19T10:00:00Z',
    sender: makeAddress({
      name: '@Researcher',
      role: 'Worker',
      agent_id: 'agent-7',
      team_id: teamId,
    }),
    display_type: 'other',
    content: null,
    __model__: STOP_MESSAGE_MODEL,
  };
}

describe('TeamStatusReactor (Story 37-2)', () => {
  let reactor: TeamStatusReactor;
  let context: jasmine.SpyObj<ContextService>;
  let api: jasmine.SpyObj<ApiService>;
  let messages$: Subject<AkgenticMessage>;

  beforeEach(() => {
    context = jasmine.createSpyObj('ContextService', [
      'markStopped',
      'getCurrentTeam',
      'getTeams',
      'stopTeamAndAwait',
    ]);
    api = jasmine.createSpyObj('ApiService', [
      'getTeam',
      'getTeams',
      'stopTeam',
      'getEvents',
    ]);
    messages$ = new Subject<AkgenticMessage>();

    TestBed.configureTestingModule({
      providers: [
        TeamStatusReactor,
        { provide: ContextService, useValue: context },
        { provide: ApiService, useValue: api },
      ],
    });

    reactor = TestBed.inject(TeamStatusReactor);
  });

  // --- AC6 ---------------------------------------------------------------

  it('(AC6) a TeamStoppingEvent marks the envelope team stopped', () => {
    reactor.start(messages$);

    messages$.next(mkEventMessage('team-A', TEAM_STOPPING_MODEL));

    expect(context.markStopped).toHaveBeenCalledOnceWith('team-A');
  });

  it('(AC6) the id comes from the ENVELOPE, not from navigation state', () => {
    reactor.start(messages$);

    messages$.next(mkEventMessage('team-Z', TEAM_STOPPING_MODEL));

    expect(context.markStopped).toHaveBeenCalledOnceWith('team-Z');
  });

  it('(AC6) two stop events for two teams each reach the cache', () => {
    reactor.start(messages$);

    messages$.next(mkEventMessage('team-A', TEAM_STOPPING_MODEL));
    messages$.next(mkEventMessage('team-B', TEAM_STOPPING_MODEL));

    expect(context.markStopped).toHaveBeenCalledTimes(2);
    expect(context.markStopped.calls.argsFor(0)).toEqual(['team-A']);
    expect(context.markStopped.calls.argsFor(1)).toEqual(['team-B']);
  });

  // --- AC7 ---------------------------------------------------------------
  //
  // The difference between "the team stopped" and "an agent was fired". Getting
  // this wrong marks a healthy team dead on every agent teardown, and a
  // `StopMessage` is by far the likelier frame of the two on a live team. The
  // graph selector's removal of that agent's node stays where it is — this unit
  // never sees `StopMessage` at all.

  it('(AC7) a StopMessage for an ordinary agent does NOT touch the team cache', () => {
    reactor.start(messages$);

    messages$.next(mkStopMessage('team-A'));

    expect(context.markStopped).not.toHaveBeenCalled();
  });

  it('(AC7) a StopMessage among stop events changes nothing about the stop events', () => {
    reactor.start(messages$);

    messages$.next(mkStopMessage('team-A'));
    messages$.next(mkEventMessage('team-A', TEAM_STOPPING_MODEL));
    messages$.next(mkStopMessage('team-A'));

    expect(context.markStopped).toHaveBeenCalledOnceWith('team-A');
  });

  // --- AC8 ---------------------------------------------------------------
  //
  // `ClosedNotification` is the control on purpose: a real inner payload the app
  // already depends on. A guard that keyed on the ENVELOPE instead of the inner
  // `__model__` would fire for every `EventMessage` and go red HERE — in a spec
  // — rather than in production, where it would break dismissed-notification
  // replay by marking the team dead on every dismissal.

  it('(AC8) an EventMessage carrying a ClosedNotification does NOT touch the cache', () => {
    reactor.start(messages$);

    messages$.next(mkEventMessage('team-A', CLOSED_NOTIFICATION_MODEL));

    expect(context.markStopped).not.toHaveBeenCalled();
  });

  it('(AC8) other inner event payloads are ignored too', () => {
    reactor.start(messages$);

    for (const model of [
      'akgentic.llm.event.LlmUsageEvent',
      'akgentic.llm.event.LlmContextCompactedEvent',
      'akgentic.tool.command.CommandsAnnouncedEvent',
    ]) {
      messages$.next(mkEventMessage('team-A', model));
    }

    expect(context.markStopped).not.toHaveBeenCalled();
  });

  it('(AC8) an EventMessage with a null event payload is ignored', () => {
    reactor.start(messages$);

    const frame = mkEventMessage('team-A', TEAM_STOPPING_MODEL);
    frame.event = null;
    messages$.next(frame);

    expect(context.markStopped).not.toHaveBeenCalled();
  });

  // --- AC9 ---------------------------------------------------------------

  it('(AC9) the constructor subscribes to nothing — no event lands before start()', () => {
    messages$.next(mkEventMessage('team-A', TEAM_STOPPING_MODEL));

    expect(context.markStopped).not.toHaveBeenCalled();
    expect(messages$.observed).toBe(false);
  });

  it('(AC9) after stop() the same stream has no effect again', () => {
    reactor.start(messages$);
    reactor.stop();

    messages$.next(mkEventMessage('team-A', TEAM_STOPPING_MODEL));

    expect(context.markStopped).not.toHaveBeenCalled();
    expect(messages$.observed).toBe(false);
  });

  it('(AC9) stop() is safe before any start() and safe to call twice', () => {
    expect(() => reactor.stop()).not.toThrow();

    reactor.start(messages$);
    reactor.stop();

    expect(() => reactor.stop()).not.toThrow();
    messages$.next(mkEventMessage('team-A', TEAM_STOPPING_MODEL));
    expect(context.markStopped).not.toHaveBeenCalled();
  });

  it('(AC9) a stop() / start() cycle re-arms the unit', () => {
    reactor.start(messages$);
    reactor.stop();
    reactor.start(messages$);

    messages$.next(mkEventMessage('team-A', TEAM_STOPPING_MODEL));

    expect(context.markStopped).toHaveBeenCalledOnceWith('team-A');
  });

  // --- AC10 --------------------------------------------------------------

  it('(AC10) no ApiService method is called on the event path', () => {
    reactor.start(messages$);

    messages$.next(mkEventMessage('team-A', TEAM_STOPPING_MODEL));

    expect(api.getTeam).not.toHaveBeenCalled();
    expect(api.getTeams).not.toHaveBeenCalled();
    expect(api.stopTeam).not.toHaveBeenCalled();
    expect(api.getEvents).not.toHaveBeenCalled();
  });

  it('(AC10) it reads nothing back out of ContextService', () => {
    reactor.start(messages$);

    messages$.next(mkEventMessage('team-A', TEAM_STOPPING_MODEL));

    expect(context.getCurrentTeam).not.toHaveBeenCalled();
    expect(context.getTeams).not.toHaveBeenCalled();
    expect(context.stopTeamAndAwait).not.toHaveBeenCalled();
  });

  it('(AC10) it holds no state beyond its dependency and its subscription bag', () => {
    reactor.start(messages$);
    messages$.next(mkEventMessage('team-A', TEAM_STOPPING_MODEL));
    messages$.next(mkEventMessage('team-A', TEAM_STOPPING_MODEL));

    // A reactor that remembers something is a projection. In particular there is
    // no "already marked stopped" set here — `ContextService.markStopped` owns
    // that guard, and a second copy of it in this class is the tier smear the
    // architecture forbids. Which is why the SECOND event above is still
    // forwarded rather than swallowed.
    expect(Object.keys(reactor).sort()).toEqual(['context', 'subs']);
    expect(context.markStopped).toHaveBeenCalledTimes(2);
  });
});
