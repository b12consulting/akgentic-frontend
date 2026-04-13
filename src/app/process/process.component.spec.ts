import { CommonModule } from '@angular/common';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { BehaviorSubject } from 'rxjs';

import { StartMessage, StopMessage } from '../models/message.types';
import { AkgentService } from '../services/akgent.service';
import { ChatService } from '../services/chat.service';
import { ContextService } from '../services/context.service';
import { FeedbackService } from '../services/feedback.service';
import { GraphDataService } from '../services/graph-data.service';
import { KGStateReducer } from '../services/kg-state.reducer';
import { MessageLogService } from '../services/message-log.service';
import { ActorMessageService } from '../services/message.service';
import { SelectionService } from '../services/selection.service';
import {
  KG_ACTOR_NAME,
  ToolPresenceService,
} from '../services/tool-presence.service';
import { TeamContext } from '../models/team.interface';
import { ViewService } from '../view.service';
import { ProcessComponent } from './process.component';

// --------------------------------------------------------------------
// Fixture helpers
// --------------------------------------------------------------------

function makeTeam(overrides: Partial<TeamContext> = {}): TeamContext {
  return {
    team_id: 'team-1',
    name: 'Demo Team',
    status: 'running',
    created_at: '2026-04-08T10:00:00Z',
    updated_at: '2026-04-08T10:00:00Z',
    config_name: 'demo',
    description: null,
    ...overrides,
  };
}

function baseSender(name: string) {
  return {
    __actor_address__: true as const,
    agent_id: 'agent-' + name,
    name,
    role: 'Tool',
    squad_id: 's1',
    user_message: false,
  };
}

function makeKgStart(id: string): StartMessage {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: new Date().toISOString(),
    sender: baseSender(KG_ACTOR_NAME),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StartMessage',
    config: {} as any,
    parent: null,
  };
}

function makeKgStop(id: string): StopMessage {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: new Date().toISOString(),
    sender: baseSender(KG_ACTOR_NAME),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StopMessage',
  };
}

describe('ProcessComponent (Story 6.2 — log-driven presence)', () => {
  let component: ProcessComponent;
  let fixture: ComponentFixture<ProcessComponent>;
  let log: MessageLogService;

  beforeEach(async () => {
    const contextService = {
      currentProcessId$: new BehaviorSubject<string>(''),
      getCurrentTeam: jasmine
        .createSpy('getCurrentTeam')
        .and.callFake(async () => makeTeam()),
    };

    const messageService = {
      init: jasmine.createSpy('init').and.returnValue(Promise.resolve()),
      messages$: new BehaviorSubject<any[]>([]),
      message$: new BehaviorSubject<any>(null),
      createAgentGraph$: new BehaviorSubject<any>(null),
      knowledgeGraphLoading$: new BehaviorSubject<boolean>(false),
    };

    const akgentService = {
      unselect: jasmine.createSpy('unselect'),
      selectedAkgent$: new BehaviorSubject<any>(null),
    };

    const graphDataService = {
      isLoading$: new BehaviorSubject<boolean>(false),
      nodes$: new BehaviorSubject<any[]>([]),
    };

    const chatService = {
      messages$: new BehaviorSubject<any[]>([]),
    };

    const selectionService = {
      handleSelection: jasmine.createSpy('handleSelection'),
    };

    const feedbackService = {};

    const viewService = {
      isRightColumnCollapsed$: new BehaviorSubject<boolean>(false),
    };

    const router = {
      navigate: jasmine
        .createSpy('navigate')
        .and.returnValue(Promise.resolve(true)),
    };

    const activatedRoute = {
      snapshot: { params: { id: 'team-1' } },
    };

    await TestBed.configureTestingModule({
      imports: [ProcessComponent, NoopAnimationsModule],
      providers: [
        // Story 6.2 (AC5): drive presence through the REAL log + selector
        // pipeline so the unit test exercises the same path the production
        // code will on home→process navigation.
        MessageLogService,
        ToolPresenceService,
        KGStateReducer,
        { provide: ContextService, useValue: contextService },
        { provide: ActorMessageService, useValue: messageService },
        { provide: AkgentService, useValue: akgentService },
        { provide: GraphDataService, useValue: graphDataService },
        { provide: ChatService, useValue: chatService },
        { provide: SelectionService, useValue: selectionService },
        { provide: FeedbackService, useValue: feedbackService },
        { provide: ViewService, useValue: viewService },
        { provide: Router, useValue: router },
        { provide: ActivatedRoute, useValue: activatedRoute },
      ],
    })
      // Swap the heavy child components out for a minimal, empty-template
      // metadata set + CUSTOM_ELEMENTS_SCHEMA so the DOM still contains the
      // `<app-knowledge-graph>` / `<app-*>` tags (we assert on them) without
      // needing to bootstrap the children's full dependency graphs.
      .overrideComponent(ProcessComponent, {
        set: {
          imports: [CommonModule],
          // Strip the component-level providers so the module-level providers
          // above (real MessageLogService + ToolPresenceService + KGStateReducer)
          // are used instead of fresh instances per-component.
          providers: [],
          schemas: [CUSTOM_ELEMENTS_SCHEMA],
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(ProcessComponent);
    component = fixture.componentInstance;
    log = TestBed.inject(MessageLogService);

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('scenario 1 — empty log: KG option absent, <app-knowledge-graph> not in DOM', async () => {
    const options = await firstValue(component.visualizationOptions$);
    expect(options.some((o) => o.value === 'knowledge-graph')).toBe(false);

    const kgEl = fixture.nativeElement.querySelector('app-knowledge-graph');
    expect(kgEl).toBeNull();
  });

  it('scenario 2 — KG StartMessage appended to log: KG option appears and <app-knowledge-graph> mounts (AC5 race fix)', async () => {
    log.append(makeKgStart('kg-start-1'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const options = await firstValue(component.visualizationOptions$);
    expect(options.some((o) => o.value === 'knowledge-graph')).toBe(true);

    const kgEl = fixture.nativeElement.querySelector('app-knowledge-graph');
    expect(kgEl).not.toBeNull();
  });

  it('scenario 3 — KG StopMessage in log: KG option disappears and <app-knowledge-graph> unmounts', async () => {
    log.append(makeKgStart('kg-start-1'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    log.append(makeKgStop('kg-stop-1'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const options = await firstValue(component.visualizationOptions$);
    expect(options.some((o) => o.value === 'knowledge-graph')).toBe(false);

    const kgEl = fixture.nativeElement.querySelector('app-knowledge-graph');
    expect(kgEl).toBeNull();
  });

  it('scenario 4 — active-mode reset: KG active then presence→false flips visualization mode back to team', () => {
    log.append(makeKgStart('kg-start-1'));
    component.setVisualizationMode('knowledge-graph');
    expect(component.currentVisualizationMode).toBe('knowledge-graph');

    log.append(makeKgStop('kg-stop-1'));
    expect(component.currentVisualizationMode).toBe('team');
  });

  it('scenario 5 — no regression: Team / Member / Messages entries remain present under both presence states (order preserved)', async () => {
    let options = await firstValue(component.visualizationOptions$);
    let labels = options.map((o) => o.value);
    expect(labels).toEqual(['team', 'member', 'messages']);

    log.append(makeKgStart('kg-start-1'));
    options = await firstValue(component.visualizationOptions$);
    labels = options.map((o) => o.value);
    expect(labels).toEqual(['team', 'member', 'knowledge-graph', 'messages']);
  });
});

// Small synchronous-first-emission helper for BehaviorSubject-derived
// observables (combineLatest over BehaviorSubjects replays synchronously).
function firstValue<T>(observable$: {
  subscribe: (fn: (v: T) => void) => { unsubscribe(): void };
}): Promise<T> {
  return new Promise((resolve) => {
    const sub = observable$.subscribe((v) => {
      resolve(v);
      setTimeout(() => sub.unsubscribe(), 0);
    });
  });
}
