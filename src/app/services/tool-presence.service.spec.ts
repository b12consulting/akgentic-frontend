import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import {
  AkgenticMessage,
  StartMessage,
  StopMessage,
} from '../models/message.types';
import {
  KG_ACTOR_NAME,
  KGPresenceMessageSource,
  ToolPresenceService,
} from './tool-presence.service';

// ---------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------

function baseSender(name: string) {
  return {
    __actor_address__: true as const,
    agent_id: 'agent-' + name,
    name,
    role: 'Agent',
    squad_id: 's1',
    user_message: false,
  };
}

function makeStartMessage(senderName: string): StartMessage {
  return {
    id: 'start-' + senderName,
    parent_id: null,
    team_id: 'team-1',
    timestamp: new Date().toISOString(),
    sender: baseSender(senderName),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StartMessage',
    config: {} as any,
    parent: null,
  };
}

function makeStopMessage(senderName: string): StopMessage {
  return {
    id: 'stop-' + senderName,
    parent_id: null,
    team_id: 'team-1',
    timestamp: new Date().toISOString(),
    sender: baseSender(senderName),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StopMessage',
  };
}

function makeSource(): {
  source: KGPresenceMessageSource;
  createAgentGraph$: BehaviorSubject<AkgenticMessage[] | null>;
  message$: BehaviorSubject<AkgenticMessage | null>;
} {
  const createAgentGraph$ = new BehaviorSubject<AkgenticMessage[] | null>(null);
  const message$ = new BehaviorSubject<AkgenticMessage | null>(null);
  return {
    source: { createAgentGraph$, message$ },
    createAgentGraph$,
    message$,
  };
}

describe('ToolPresenceService', () => {
  let service: ToolPresenceService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [ToolPresenceService] });
    service = TestBed.inject(ToolPresenceService);
  });

  it('(1) initial — hasKnowledgeGraph$ is false before any message', () => {
    expect(service.hasKnowledgeGraph$.getValue()).toBe(false);
  });

  it('(2) detection on live StartMessage for #KnowledgeGraphTool', () => {
    const { source, message$ } = makeSource();
    service.bindTo(source);
    expect(service.hasKnowledgeGraph$.getValue()).toBe(false);

    message$.next(makeStartMessage(KG_ACTOR_NAME));
    expect(service.hasKnowledgeGraph$.getValue()).toBe(true);
  });

  it('(3) detection on replay batch via createAgentGraph$', () => {
    const { source, createAgentGraph$ } = makeSource();
    service.bindTo(source);
    expect(service.hasKnowledgeGraph$.getValue()).toBe(false);

    createAgentGraph$.next([makeStartMessage(KG_ACTOR_NAME)]);
    expect(service.hasKnowledgeGraph$.getValue()).toBe(true);
  });

  it('(4) irrelevant sender ignored — stays false', () => {
    const { source, message$ } = makeSource();
    service.bindTo(source);

    message$.next(makeStartMessage('@Support'));
    message$.next(makeStartMessage('#VectorStoreTool'));
    expect(service.hasKnowledgeGraph$.getValue()).toBe(false);
  });

  it('(5) StopMessage for KG actor flips presence back to false', () => {
    const { source, message$ } = makeSource();
    service.bindTo(source);

    message$.next(makeStartMessage(KG_ACTOR_NAME));
    expect(service.hasKnowledgeGraph$.getValue()).toBe(true);

    message$.next(makeStopMessage(KG_ACTOR_NAME));
    expect(service.hasKnowledgeGraph$.getValue()).toBe(false);
  });

  it('(6) resetForTeam() flips presence back to false on team switch', () => {
    const { source, message$ } = makeSource();
    service.bindTo(source);

    message$.next(makeStartMessage(KG_ACTOR_NAME));
    expect(service.hasKnowledgeGraph$.getValue()).toBe(true);

    service.resetForTeam();
    expect(service.hasKnowledgeGraph$.getValue()).toBe(false);
  });

  it('(7) redundant StartMessages do not emit true twice (distinct values only)', () => {
    const { source, message$ } = makeSource();
    service.bindTo(source);

    const emissions: boolean[] = [];
    service.hasKnowledgeGraph$.subscribe((v) => emissions.push(v));

    message$.next(makeStartMessage(KG_ACTOR_NAME));
    message$.next(makeStartMessage(KG_ACTOR_NAME));

    // Expected emissions from the subscription above:
    //   [false (initial replay), true (first KG start)]
    // The second KG StartMessage must NOT produce a third emission.
    expect(emissions).toEqual([false, true]);
  });
});
