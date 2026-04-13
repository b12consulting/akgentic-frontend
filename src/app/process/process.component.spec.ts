import { CommonModule } from '@angular/common';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { BehaviorSubject } from 'rxjs';

import { ProcessComponent } from './process.component';
import { AkgentService } from '../services/akgent.service';
import { ContextService } from '../services/context.service';
import { ActorMessageService } from '../services/message.service';
import { GraphDataService } from '../services/graph-data.service';
import { ChatService } from '../services/chat.service';
import { SelectionService } from '../services/selection.service';
import { FeedbackService } from '../services/feedback.service';
import { ToolPresenceService } from '../services/tool-presence.service';
import { ViewService } from '../view.service';
import { TeamContext } from '../models/team.interface';

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

describe('ProcessComponent', () => {
  let component: ProcessComponent;
  let fixture: ComponentFixture<ProcessComponent>;
  let toolPresenceService: ToolPresenceService;

  beforeEach(async () => {
    // Fresh presence service per test so cross-test leakage is impossible.
    const presence = new ToolPresenceService();

    const contextService = {
      currentProcessId$: new BehaviorSubject<string>(''),
      getCurrentTeam: jasmine
        .createSpy('getCurrentTeam')
        .and.callFake(async () => makeTeam()),
    };

    const messageService = {
      init: jasmine
        .createSpy('init')
        .and.returnValue(Promise.resolve()),
      messages$: new BehaviorSubject<any[]>([]),
      message$: new BehaviorSubject<any>(null),
      createAgentGraph$: new BehaviorSubject<any>(null),
      knowledgeGraph$: new BehaviorSubject<any>({ nodes: [], edges: [] }),
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
      navigate: jasmine.createSpy('navigate').and.returnValue(Promise.resolve(true)),
    };

    const activatedRoute = {
      snapshot: { params: { id: 'team-1' } },
    };

    await TestBed.configureTestingModule({
      imports: [ProcessComponent, NoopAnimationsModule],
      providers: [
        { provide: ToolPresenceService, useValue: presence },
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
          providers: [],
          schemas: [CUSTOM_ELEMENTS_SCHEMA],
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(ProcessComponent);
    component = fixture.componentInstance;
    toolPresenceService = presence;

    // Initial detectChanges without ngOnInit route resolution side effects
    // would still fire `ngOnInit` — but the `getCurrentTeam` spy returns a
    // resolved promise with a valid team so the router.navigate path is
    // not taken.
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('scenario 1 — empty init (no KG actor): KG option absent, <app-knowledge-graph> not in DOM', async () => {
    expect(toolPresenceService.hasKnowledgeGraph$.getValue()).toBe(false);

    const options = await firstValue(component.visualizationOptions$);
    expect(options.some((o) => o.value === 'knowledge-graph')).toBe(false);

    const kgEl = fixture.nativeElement.querySelector('app-knowledge-graph');
    expect(kgEl).toBeNull();
  });

  it('scenario 2 — KG presence flips to true: KG option appears and <app-knowledge-graph> mounts', async () => {
    toolPresenceService.hasKnowledgeGraph$.next(true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const options = await firstValue(component.visualizationOptions$);
    expect(options.some((o) => o.value === 'knowledge-graph')).toBe(true);

    const kgEl = fixture.nativeElement.querySelector('app-knowledge-graph');
    expect(kgEl).not.toBeNull();
  });

  it('scenario 3 — KG presence flips back to false: KG option disappears and <app-knowledge-graph> unmounts', async () => {
    toolPresenceService.hasKnowledgeGraph$.next(true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    toolPresenceService.hasKnowledgeGraph$.next(false);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const options = await firstValue(component.visualizationOptions$);
    expect(options.some((o) => o.value === 'knowledge-graph')).toBe(false);

    const kgEl = fixture.nativeElement.querySelector('app-knowledge-graph');
    expect(kgEl).toBeNull();
  });

  it('scenario 4 — active-mode reset: KG active then presence→false flips visualization mode back to team', () => {
    toolPresenceService.hasKnowledgeGraph$.next(true);
    component.setVisualizationMode('knowledge-graph');
    expect(component.currentVisualizationMode).toBe('knowledge-graph');

    toolPresenceService.hasKnowledgeGraph$.next(false);
    expect(component.currentVisualizationMode).toBe('team');
  });

  it('scenario 5 — no regression: Team / Member / Messages entries remain present under both presence states (order preserved)', async () => {
    // presence=false
    let options = await firstValue(component.visualizationOptions$);
    let labels = options.map((o) => o.value);
    expect(labels).toEqual(['team', 'member', 'messages']);

    // presence=true
    toolPresenceService.hasKnowledgeGraph$.next(true);
    options = await firstValue(component.visualizationOptions$);
    labels = options.map((o) => o.value);
    // Team, Member, (no Workspace — hasWorkspace stays false), Knowledge
    // graph, Messages — order preserved from allVisualizationOptions.
    expect(labels).toEqual(['team', 'member', 'knowledge-graph', 'messages']);
  });
});

// Small synchronous-first-emission helper for BehaviorSubject-derived
// observables (combineLatest over BehaviorSubjects replays synchronously).
function firstValue<T>(observable$: { subscribe: (fn: (v: T) => void) => { unsubscribe(): void } }): Promise<T> {
  return new Promise((resolve) => {
    const sub = observable$.subscribe((v) => {
      resolve(v);
      // Defer unsubscribe so we don't cancel the synchronous resolve path
      setTimeout(() => sub.unsubscribe(), 0);
    });
  });
}
