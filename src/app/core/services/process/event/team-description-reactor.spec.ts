import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';

import { ApiService } from '../../../platform/http/api.service';
import { ContextService } from '../../../platform/context/context.service';
import { TeamContext } from '../../../platform/context/team.interface';
import { TeamDescriptionReactor } from './team-description-reactor';
import {
  ActorAddress,
  AkgenticMessage,
  EVENT_MESSAGE_MODEL,
} from '../../../protocol/message.types';

/**
 * Story 58-1 — the team-description reactor (AC10-AC14).
 *
 * Modelled line for line on `team-status-reactor.spec.ts`. The unit is driven
 * with a plain `Subject` standing in for `log.appended$.pipe(concatAll())`, and
 * the MINIMAL provider set is itself the dependency assertion: no
 * `IngestionService`, no `MessageLogService`, no `TeamSocket`, no `Router`.
 * `ApiService` is provided ONLY so AC14 can assert positively that nothing on
 * the event path reaches for it.
 *
 * The backend that emits this notification ships in a separate package, so the
 * frame is synthesised here from the contract: a bare `NotificationMessage`
 * (outer `__model__` ends with `.NotificationMessage`) with
 * `content_type === 'team_description'` and the new text as `content`.
 */

const NOTIFICATION_MODEL =
  'akgentic.core.messages.orchestrator.NotificationMessage';
const ERROR_MODEL = 'akgentic.core.messages.orchestrator.ErrorMessage';
const WARNING_MODEL = 'akgentic.core.messages.orchestrator.WarningMessage';
const STOP_MESSAGE_MODEL = 'akgentic.core.messages.orchestrator.StopMessage';
const START_MESSAGE_MODEL = 'akgentic.core.messages.orchestrator.StartMessage';
const TEAM_STOPPING_MODEL =
  'akgentic.core.messages.orchestrator.TeamStoppingEvent';

const DESCRIPTION = 'Drafts the quarterly report';

/** The timestamp every frame factory below stamps unless told otherwise. */
const FRAME_AT = '2026-10-02T10:00:00Z';

/**
 * A minimal cached team for the 58-2 staleness specs — the same shape as
 * `context.service.spec.ts`'s `makeTeam`, with the one field the guard reads
 * as a parameter.
 */
function makeTeam(teamId: string, updatedAt: string): TeamContext {
  return {
    team_id: teamId,
    name: `team-${teamId}`,
    status: 'running',
    created_at: '2026-10-01T10:00:00Z',
    updated_at: updatedAt,
    config_name: `team-${teamId}`,
    description: null,
  };
}

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
 * A notification-family frame: the bare base or one of its two subclasses,
 * carrying a `content_type` and a `content`. The `model` parameter is what
 * lets the AC12 specs build an `ErrorMessage` / `WarningMessage` that carries
 * the team-description `content_type` and prove it is NOT acted on.
 */
function mkNotification(
  teamId: string,
  model: string,
  contentType: string | null,
  content: string,
  timestamp: string = FRAME_AT,
): any {
  return {
    id: 'n-' + model + '-' + teamId + '-' + content + '-' + timestamp,
    parent_id: null,
    team_id: teamId,
    timestamp,
    sender: makeAddress({ team_id: teamId }),
    display_type: 'other',
    content,
    content_type: contentType,
    __model__: model,
  };
}

/** A non-notification frame — an `EventMessage` envelope with an inner payload. */
function mkEventMessage(teamId: string, innerModel: string): any {
  return {
    id: 'evt-' + innerModel,
    parent_id: null,
    team_id: teamId,
    timestamp: '2026-10-02T10:00:00Z',
    sender: makeAddress({ team_id: teamId }),
    display_type: 'other',
    content: null,
    __model__: EVENT_MESSAGE_MODEL,
    event: { __model__: innerModel },
  };
}

/** A plain lifecycle frame with no `content_type` at all. */
function mkLifecycle(teamId: string, model: string): any {
  return {
    id: 'life-' + model,
    parent_id: null,
    team_id: teamId,
    timestamp: '2026-10-02T10:00:00Z',
    sender: makeAddress({
      name: '@Researcher',
      role: 'Worker',
      agent_id: 'agent-7',
      team_id: teamId,
    }),
    display_type: 'other',
    content: null,
    __model__: model,
  };
}

describe('TeamDescriptionReactor (Story 58-1)', () => {
  let reactor: TeamDescriptionReactor;
  let context: jasmine.SpyObj<ContextService>;
  let api: jasmine.SpyObj<ApiService>;
  let messages$: Subject<AkgenticMessage>;

  beforeEach(() => {
    context = jasmine.createSpyObj('ContextService', [
      'setTeamDescription',
      'getCachedTeam',
      'getCurrentTeam',
      'getTeams',
    ]);
    // The honest default: this tab holds no team. A bare spy would answer
    // `undefined`, which the reactor also tolerates, but `null` is what the
    // real read returns on a miss.
    context.getCachedTeam.and.returnValue(null);
    api = jasmine.createSpyObj('ApiService', [
      'getTeam',
      'getTeams',
      'updateTeamDescription',
    ]);
    messages$ = new Subject<AkgenticMessage>();

    TestBed.configureTestingModule({
      providers: [
        TeamDescriptionReactor,
        { provide: ContextService, useValue: context },
        { provide: ApiService, useValue: api },
      ],
    });

    reactor = TestBed.inject(TeamDescriptionReactor);
  });

  // --- AC11 --------------------------------------------------------------

  it('(AC11) a team_description notification patches the envelope team with its content', () => {
    reactor.start(messages$);

    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION),
    );

    expect(context.setTeamDescription).toHaveBeenCalledOnceWith(
      'team-A',
      DESCRIPTION,
    );
  });

  it('(AC11) the id comes from the ENVELOPE, not from navigation state', () => {
    reactor.start(messages$);

    messages$.next(
      mkNotification('team-Z', NOTIFICATION_MODEL, 'team_description', DESCRIPTION),
    );

    expect(context.setTeamDescription).toHaveBeenCalledOnceWith(
      'team-Z',
      DESCRIPTION,
    );
  });

  it('(AC11) two notifications for two teams each reach the cache, in order', () => {
    reactor.start(messages$);

    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', 'First team'),
    );
    messages$.next(
      mkNotification('team-B', NOTIFICATION_MODEL, 'team_description', 'Second team'),
    );

    expect(context.setTeamDescription).toHaveBeenCalledTimes(2);
    expect(context.setTeamDescription.calls.argsFor(0)).toEqual([
      'team-A',
      'First team',
    ]);
    expect(context.setTeamDescription.calls.argsFor(1)).toEqual([
      'team-B',
      'Second team',
    ]);
  });

  it('(AC11) the content is forwarded VERBATIM — padding and emptiness included', () => {
    // This layer does not decide what `''` or surrounding space means. The
    // generator caps and truncates rather than clearing, so `''` should never
    // arrive; if it did, the table already renders `''` as its placeholder.
    reactor.start(messages$);

    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', '  padded  '),
    );
    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', ''),
    );

    expect(context.setTeamDescription.calls.argsFor(0)).toEqual([
      'team-A',
      '  padded  ',
    ]);
    expect(context.setTeamDescription.calls.argsFor(1)).toEqual(['team-A', '']);
  });

  // --- AC12 --------------------------------------------------------------
  //
  // Everything that is NOT the generated-description notification: the bare
  // base with another `content_type` (or none), the two notification SUBCLASSES
  // even when they carry the right `content_type`, and every non-notification
  // frame. The subclass cases are the ones that distinguish `isNotificationMessage`
  // (an `endsWith`) from a `.includes()` check, which would admit them.

  it('(AC12) a bare NotificationMessage with another content_type is ignored', () => {
    reactor.start(messages$);

    messages$.next(mkNotification('team-A', NOTIFICATION_MODEL, 'Info', 'fyi'));
    messages$.next(mkNotification('team-A', NOTIFICATION_MODEL, 'Budget', 'over'));

    expect(context.setTeamDescription).not.toHaveBeenCalled();
  });

  it('(AC12) a bare NotificationMessage with a NULL content_type is ignored', () => {
    // `content_type` is `string | null` upstream; `null !== 'team_description'`
    // must fall through rather than throw or match.
    reactor.start(messages$);

    messages$.next(mkNotification('team-A', NOTIFICATION_MODEL, null, DESCRIPTION));

    expect(context.setTeamDescription).not.toHaveBeenCalled();
  });

  it('(AC12) an ErrorMessage carrying content_type team_description does NOT write the cache', () => {
    // `ErrorMessage` IS a `NotificationMessage` upstream and has the same two
    // fields. A `.includes('NotificationMessage')` guard would let an error's
    // text overwrite a team's description; the `endsWith` guard does not.
    reactor.start(messages$);

    messages$.next(
      mkNotification('team-A', ERROR_MODEL, 'team_description', 'boom'),
    );

    expect(context.setTeamDescription).not.toHaveBeenCalled();
  });

  it('(AC12) a WarningMessage carrying content_type team_description does NOT write the cache', () => {
    reactor.start(messages$);

    messages$.next(
      mkNotification('team-A', WARNING_MODEL, 'team_description', 'careful'),
    );

    expect(context.setTeamDescription).not.toHaveBeenCalled();
  });

  it('(AC12) non-notification frames are ignored — EventMessage, StopMessage, StartMessage', () => {
    reactor.start(messages$);

    messages$.next(mkEventMessage('team-A', TEAM_STOPPING_MODEL));
    messages$.next(mkEventMessage('team-A', 'akgentic.llm.event.LlmUsageEvent'));
    messages$.next(mkLifecycle('team-A', STOP_MESSAGE_MODEL));
    messages$.next(mkLifecycle('team-A', START_MESSAGE_MODEL));

    expect(context.setTeamDescription).not.toHaveBeenCalled();
  });

  it('(AC12) an ignored frame among real notifications changes nothing about the real ones', () => {
    reactor.start(messages$);

    messages$.next(mkNotification('team-A', WARNING_MODEL, 'team_description', 'x'));
    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION),
    );
    messages$.next(mkLifecycle('team-A', STOP_MESSAGE_MODEL));

    expect(context.setTeamDescription).toHaveBeenCalledOnceWith(
      'team-A',
      DESCRIPTION,
    );
  });

  // --- AC13 --------------------------------------------------------------

  it('(AC13) it holds no state beyond its dependency and its subscription bag', () => {
    reactor.start(messages$);
    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION),
    );
    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION),
    );

    // A reactor that remembers something is a projection. In particular there
    // is no "unchanged" guard here — `ContextService` owns whatever guarding
    // the cache needs — which is why the SECOND identical event above is still
    // forwarded rather than swallowed.
    expect(Object.keys(reactor).sort()).toEqual(['context', 'subs']);
    expect(context.setTeamDescription).toHaveBeenCalledTimes(2);
  });

  // --- AC14 --------------------------------------------------------------

  it('(AC14) no ApiService method is called on the event path', () => {
    // Patch, never refetch. A reactor that re-read the team on every
    // notification would be the refetch-on-event the architecture forbids.
    reactor.start(messages$);

    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION),
    );

    expect(api.getTeam).not.toHaveBeenCalled();
    expect(api.getTeams).not.toHaveBeenCalled();
    expect(api.updateTeamDescription).not.toHaveBeenCalled();
  });

  it('(AC14) it FETCHES nothing through ContextService — one cache read, by the envelope id', () => {
    // Story 58-2: the reactor now READS the cache once per matching frame for
    // the staleness check, through the synchronous, fetch-free
    // `getCachedTeam`. The fetching reads stay untouched.
    reactor.start(messages$);

    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION),
    );

    expect(context.getCurrentTeam).not.toHaveBeenCalled();
    expect(context.getTeams).not.toHaveBeenCalled();
    expect(context.getCachedTeam).toHaveBeenCalledOnceWith('team-A');
  });

  // --- AC10: lifecycle ---------------------------------------------------

  it('(AC10) the constructor subscribes to nothing — no event lands before start()', () => {
    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION),
    );

    expect(context.setTeamDescription).not.toHaveBeenCalled();
    expect(messages$.observed).toBe(false);
  });

  it('(AC10) after stop() the same stream has no effect again', () => {
    reactor.start(messages$);
    reactor.stop();

    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION),
    );

    expect(context.setTeamDescription).not.toHaveBeenCalled();
    expect(messages$.observed).toBe(false);
  });

  it('(AC10) stop() is safe before any start() and safe to call twice', () => {
    expect(() => reactor.stop()).not.toThrow();

    reactor.start(messages$);
    reactor.stop();

    expect(() => reactor.stop()).not.toThrow();
    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION),
    );
    expect(context.setTeamDescription).not.toHaveBeenCalled();
  });

  it('(AC10) a stop() / start() cycle re-arms the unit', () => {
    reactor.start(messages$);
    reactor.stop();
    reactor.start(messages$);

    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION),
    );

    expect(context.setTeamDescription).toHaveBeenCalledOnceWith(
      'team-A',
      DESCRIPTION,
    );
  });
});

/**
 * Story 58-2 — the replay staleness guard (AC5-AC8).
 *
 * The persisted `team_description` frame is replayed on a stopped team's REST
 * history and on a restored team's cursor-0 replay, and it always carries the
 * GENERATED text. Once the owner has edited, that text is stale. The reactor
 * compares the frame's `timestamp` with the cached team's `updated_at` (read
 * through `getCachedTeam`) and drops a frame that is strictly older. The spy
 * returns whatever team each spec needs; nothing here is fetched.
 */
describe('TeamDescriptionReactor — Story 58-2 (replay staleness guard)', () => {
  const OLDER_CACHE = '2026-10-02T09:00:00Z';
  const NEWER_CACHE = '2026-10-02T10:00:01Z';
  const EQUAL_CACHE = FRAME_AT;
  const EDITED = 'Edited by the owner';

  let reactor: TeamDescriptionReactor;
  let context: jasmine.SpyObj<ContextService>;
  let api: jasmine.SpyObj<ApiService>;
  let messages$: Subject<AkgenticMessage>;

  beforeEach(() => {
    context = jasmine.createSpyObj('ContextService', [
      'setTeamDescription',
      'getCachedTeam',
      'getCurrentTeam',
      'getTeams',
    ]);
    context.getCachedTeam.and.returnValue(null);
    api = jasmine.createSpyObj('ApiService', [
      'getTeam',
      'getTeams',
      'updateTeamDescription',
    ]);
    messages$ = new Subject<AkgenticMessage>();

    TestBed.configureTestingModule({
      providers: [
        TeamDescriptionReactor,
        { provide: ContextService, useValue: context },
        { provide: ApiService, useValue: api },
      ],
    });

    reactor = TestBed.inject(TeamDescriptionReactor);
  });

  it('(AC8) a LIVE frame — cached updated_at OLDER than the frame — is applied', () => {
    context.getCachedTeam.and.returnValue(makeTeam('team-A', OLDER_CACHE));
    reactor.start(messages$);

    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION, FRAME_AT),
    );

    expect(context.setTeamDescription).toHaveBeenCalledOnceWith('team-A', DESCRIPTION);
  });

  it('(AC8) a REPLAYED frame — cached updated_at NEWER than the frame (edited after generation) — is dropped, with no refetch', () => {
    // The owner edited after the generator wrote: the cached team already
    // holds the edit and carries the edit's stamp. The replayed generated
    // frame is older, so it must not reach the cache — and nothing may go to
    // the server to find that out.
    context.getCachedTeam.and.returnValue({
      ...makeTeam('team-A', NEWER_CACHE),
      description: EDITED,
    });
    reactor.start(messages$);

    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION, FRAME_AT),
    );

    expect(context.setTeamDescription).not.toHaveBeenCalled();
    expect(api.getTeam).not.toHaveBeenCalled();
    expect(api.getTeams).not.toHaveBeenCalled();
    expect(api.updateTeamDescription).not.toHaveBeenCalled();
  });

  it('(AC8) a replayed frame EQUAL to updated_at is applied — equal is not stale', () => {
    context.getCachedTeam.and.returnValue(makeTeam('team-A', EQUAL_CACHE));
    reactor.start(messages$);

    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION, FRAME_AT),
    );

    expect(context.setTeamDescription).toHaveBeenCalledOnceWith('team-A', DESCRIPTION);
  });

  it('(AC8) a cached team with an EMPTY updated_at applies the frame', () => {
    context.getCachedTeam.and.returnValue(makeTeam('team-A', ''));
    reactor.start(messages$);

    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION, FRAME_AT),
    );

    expect(context.setTeamDescription).toHaveBeenCalledOnceWith('team-A', DESCRIPTION);
  });

  it('(AC5, AC8) an UNKNOWN team (getCachedTeam → null) is forwarded unchanged', () => {
    // The no-phantom-row guard lives in `setTeamDescription`, not here: the
    // reactor must not grow a second copy of it.
    context.getCachedTeam.and.returnValue(null);
    reactor.start(messages$);

    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION, FRAME_AT),
    );

    expect(context.setTeamDescription).toHaveBeenCalledOnceWith('team-A', DESCRIPTION);
  });

  it('(AC8) a stale frame followed by a fresh one for the same team → exactly one call, with the fresh content', () => {
    // The guard is per frame, not per team: dropping the stale replayed line
    // must not suppress the live frame that follows it.
    context.getCachedTeam.and.returnValue(makeTeam('team-A', NEWER_CACHE));
    reactor.start(messages$);

    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION, FRAME_AT),
    );
    messages$.next(
      mkNotification(
        'team-A',
        NOTIFICATION_MODEL,
        'team_description',
        EDITED,
        '2026-10-02T10:00:02Z',
      ),
    );

    expect(context.setTeamDescription).toHaveBeenCalledOnceWith('team-A', EDITED);
  });

  it('(AC6) an IGNORED frame never reads the cache', () => {
    // The read sits AFTER the two existing guards: another content_type, a
    // null content_type, the two notification subclasses, and every
    // non-notification frame fall through before it.
    context.getCachedTeam.and.returnValue(makeTeam('team-A', OLDER_CACHE));
    reactor.start(messages$);

    messages$.next(mkNotification('team-A', NOTIFICATION_MODEL, 'Info', 'fyi'));
    messages$.next(mkNotification('team-A', NOTIFICATION_MODEL, null, DESCRIPTION));
    messages$.next(mkNotification('team-A', ERROR_MODEL, 'team_description', 'boom'));
    messages$.next(mkNotification('team-A', WARNING_MODEL, 'team_description', 'careful'));
    messages$.next(mkEventMessage('team-A', TEAM_STOPPING_MODEL));
    messages$.next(mkLifecycle('team-A', STOP_MESSAGE_MODEL));

    expect(context.getCachedTeam).not.toHaveBeenCalled();
    expect(context.setTeamDescription).not.toHaveBeenCalled();
  });

  it('(AC7) it still holds no state beyond its dependency and its subscription bag', () => {
    context.getCachedTeam.and.returnValue(makeTeam('team-A', OLDER_CACHE));
    reactor.start(messages$);
    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION, FRAME_AT),
    );

    // A cache read per frame is not memory: the staleness decision is taken
    // from what `ContextService` holds, and nothing is kept here between
    // frames.
    expect(Object.keys(reactor).sort()).toEqual(['context', 'subs']);
  });

  it('(AC7) a bare spy answering undefined is tolerated — the frame is forwarded', () => {
    context.getCachedTeam.and.returnValue(undefined as unknown as null);
    reactor.start(messages$);

    messages$.next(
      mkNotification('team-A', NOTIFICATION_MODEL, 'team_description', DESCRIPTION, FRAME_AT),
    );

    expect(context.setTeamDescription).toHaveBeenCalledOnceWith('team-A', DESCRIPTION);
  });
});
