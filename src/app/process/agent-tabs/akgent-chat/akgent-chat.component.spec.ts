import { SimpleChange } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { BehaviorSubject } from 'rxjs';

import { AkgentChatComponent } from './akgent-chat.component';
import { ApiService } from '../../../core/http/api.service';
import { UtilService } from '../../../core/ui/utils.service';
import { ContextService } from '../../../core/context/context.service';
import { IngestionService } from '../../../components/process/event/ingestion.service';
import { MessageLogService } from '../../../components/process/event/message-log.service';
import { PerAgentStoreRegistry } from '../../../components/process/event/per-agent-store';
import {
  SystemPromptSelector,
  SystemPromptValue,
  systemPromptMatch,
  systemPromptReduce,
} from '../../../components/process/selectors/system-prompt.selector';
import {
  AkgenticMessage,
  CommandDescriptor,
} from '../../../protocol/message.types';

/**
 * Story 15-1 (ADR-013) — member-chat `/` slash-command mention. The member
 * chat targets exactly one agent (its own `agentName`), so the `/` list is
 * unconditionally that agent's commands.
 */
describe('AkgentChatComponent — slash-command mention (Story 15-1 / 17-3)', () => {
  let component: AkgentChatComponent;
  // Story 17-3: the member chat reads `commands.snapshot(this.agentId)` keyed by
  // agent_id. The stub holds an agent_id → descriptors map + a `snapshot(id)`.
  let commandsById: Record<string, CommandDescriptor[]>;

  const HIRE: CommandDescriptor = {
    name: 'hire_member',
    description: 'Hire a new team member',
    args: [
      { name: 'role', type: 'string', required: true },
      { name: 'name', type: 'string', required: false },
    ],
    tool_card: 'TeamTool',
  };
  const ROSTER: CommandDescriptor = {
    name: 'roster',
    description: 'List the current team roster',
    args: [],
    tool_card: 'TeamTool',
  };

  beforeEach(() => {
    commandsById = {};

    TestBed.configureTestingModule({
      imports: [AkgentChatComponent],
      providers: [
        { provide: ApiService, useValue: { sendMessage: jasmine.createSpy('sendMessage').and.resolveTo(undefined) } },
        { provide: UtilService, useValue: {} },
        {
          provide: ContextService,
          useValue: {
            currentTeamRunning$: new BehaviorSubject<boolean>(true),
            currentProcessId$: new BehaviorSubject<string>('proc-1'),
          },
        },
        // Story 16-2 / Epic 17 (17-4): AkgentChatComponent injects
        // SystemPromptSelector, now a thin façade over
        // `IngestionService.systemPrompt`. Provide a stub service exposing the
        // `commands` snapshot the `/` mention reads PLUS a REAL `systemPrompt`
        // PerAgentStore (registered on a real registry over the same
        // MessageLogService) so the façade resolves against a live store.
        MessageLogService,
        PerAgentStoreRegistry,
        {
          provide: IngestionService,
          useFactory: (registry: PerAgentStoreRegistry) => ({
            commands: {
              snapshot: (id: string): CommandDescriptor[] | undefined =>
                commandsById[id],
            },
            systemPrompt: registry.register<SystemPromptValue>({
              name: 'systemPrompt',
              match: systemPromptMatch,
              reduce: systemPromptReduce,
            }),
          }),
          deps: [PerAgentStoreRegistry],
        },
        SystemPromptSelector,
      ],
    });

    const fixture = TestBed.createComponent(AkgentChatComponent);
    component = fixture.componentInstance;
    component.context$ = new BehaviorSubject<any[]>([]);
    component.agentId = 'a-mgr';
    component.agentName = '@Manager';
    fixture.detectChanges();
  });

  it('AC-4: commandItems are the panel agent\'s commands (keyed by agent_id)', () => {
    // Seed under the panel's agent_id (`component.agentId`), not the friendly name.
    commandsById['a-mgr'] = [HIRE, ROSTER];
    expect(component.commandItems.map((c) => c.name)).toEqual([
      'hire_member',
      'roster',
    ]);
  });

  it('hides internal `_`-prefixed commands from the / list', () => {
    const INTERNAL: CommandDescriptor = {
      name: '_expand_media_refs',
      description: 'Expand glob tokens into binary image content',
      args: [{ name: 'prompt', type: 'string', required: true }],
      tool_card: 'MediaTool',
    };
    commandsById['a-mgr'] = [INTERNAL, HIRE, ROSTER];
    // `_expand_media_refs` is internal — only user commands remain.
    expect(component.commandItems.map((c) => c.name)).toEqual([
      'hire_member',
      'roster',
    ]);
  });

  it('AC-6: empty / list until a CommandsAnnouncedEvent arrives for this agent', () => {
    expect(component.commandItems).toEqual([]);
    // A different agent_id's commands must not bleed into this panel.
    commandsById['a-other'] = [HIRE];
    expect(component.commandItems).toEqual([]);
  });

  it('AC-2: selectCommand inserts `/${name} ` (leading slash, trailing space)', () => {
    expect(component.selectCommand({ name: 'roster' })).toBe('/roster ');
  });

  it('mentionConfig exposes a single `/` trigger', () => {
    const triggers = component.mentionConfig.mentions.map((m) => m.triggerChar);
    expect(triggers).toEqual(['/']);
  });

  it('commandArgsHint renders required in <> and optional in []', () => {
    expect(component.commandArgsHint(HIRE.args)).toBe('<role> [name]');
    expect(component.commandArgsHint(ROSTER.args)).toBe('');
  });

  // Story 15-3 (AC-4) — tool-family ordering: the member chat's commandItems
  // order by `tool_card` then `name` (families contiguous, alphabetical
  // within), and the single `/` mentionConfig entry sets `disableSort: true`
  // so angular-mentions' label sort does not clobber that order.
  it('AC-4: orders commandItems by tool_card then name (tool families contiguous)', () => {
    const PLAN_BREAKDOWN: CommandDescriptor = {
      name: 'breakdown',
      description: 'Break a goal into tasks',
      args: [],
      tool_card: 'PlanningTool',
    };
    const PLAN_AUDIT: CommandDescriptor = {
      name: 'audit',
      description: 'Audit the current plan',
      args: [],
      tool_card: 'PlanningTool',
    };
    // Stored order: TeamTool first, PlanningTool names reversed — neither
    // tool-grouped nor globally alphabetical, so a naive sort can't fake it.
    // Seeded under the panel's agent_id (a-mgr).
    commandsById['a-mgr'] = [ROSTER, PLAN_BREAKDOWN, HIRE, PLAN_AUDIT];

    // PlanningTool family (audit, breakdown) before TeamTool family
    // (hire_member, roster); alphabetical within each family.
    expect(component.commandItems.map((c) => c.name)).toEqual([
      'audit',
      'breakdown',
      'hire_member',
      'roster',
    ]);
  });

  it('AC-4: the `/` mentionConfig entry sets disableSort === true', () => {
    const slash = component.mentionConfig.mentions.find(
      (m) => m.triggerChar === '/',
    );
    expect(slash).toBeTruthy();
    expect((slash as any).disableSort).toBeTrue();
  });
});

// ---------------------------------------------------------------------------
// Story 16-2 (ADR-004 §5b) — head system block rendered ONCE from
// `latestSystemPrompt$`, inline `system-prompt` branch removed from
// `updateContext()`. Driven through the real MessageLogService →
// SystemPromptSelector → component pipeline (log → selector → head render).
//
// Fixtures mirror the ADR-004 §5a wire JSON. The backend emitter (akgentic-llm)
// need NOT be merged/released — the event contract is frozen, so fixtures are an
// authoritative source. (Full live e2e is deferred per the story Open Questions.)
// ---------------------------------------------------------------------------

interface PartSnapshot {
  dynamic_ref: string | null;
  content: string;
}

function spSender(agentId: string) {
  return {
    __actor_address__: true as const,
    agent_id: agentId,
    name: '@' + agentId,
    role: 'Agent',
    squad_id: 's1',
    user_message: false,
  };
}

let spCounter = 0;

/** EventMessage envelope carrying a LlmSystemPromptEvent (primary path). */
function systemPromptEnvelope(
  agentId: string,
  parts: PartSnapshot[],
  contentHash = 'h-' + spCounter
): AkgenticMessage {
  return {
    id: 'sp-' + agentId + '-' + spCounter++,
    parent_id: null,
    team_id: 'team-1',
    timestamp: new Date().toISOString(),
    sender: spSender(agentId),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.EventMessage',
    event: {
      __model__: 'akgentic.llm.event.LlmSystemPromptEvent',
      run_id: 'run-' + contentHash,
      content_hash: contentHash,
      parts: parts.map((p) => ({
        __model__: 'akgentic.llm.event.SystemPromptPartSnapshot',
        ...p,
      })),
    },
  } as unknown as AkgenticMessage;
}

/**
 * EventMessage envelope carrying a LlmMessageEvent whose inner ModelRequest
 * `message.parts` include `part_kind === 'system-prompt'` parts (fallback path,
 * pre-event teams).
 */
function llmMessageEnvelope(
  agentId: string,
  systemParts: PartSnapshot[]
): AkgenticMessage {
  return {
    id: 'llm-' + agentId + '-' + spCounter++,
    parent_id: null,
    team_id: 'team-1',
    timestamp: new Date().toISOString(),
    sender: spSender(agentId),
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.EventMessage',
    event: {
      __model__: 'akgentic.llm.event.LlmMessageEvent',
      message: {
        parts: [
          ...systemParts.map((p) => ({ part_kind: 'system-prompt', ...p })),
          { part_kind: 'user-prompt', content: 'hi' },
        ],
      },
    },
  } as unknown as AkgenticMessage;
}

/**
 * A raw context message (as fed via `context$`) whose `parts` carry both a
 * `system-prompt` and a `user-prompt` part — the run-1 double-carry. After
 * Story 16-2, `updateContext()` must drop the `system-prompt` arm and keep the
 * `user-prompt` arm.
 */
function doubleCarryContextMessage(): any {
  return {
    kind: 'request',
    parts: [
      {
        part_kind: 'system-prompt',
        dynamic_ref: 'team.roster',
        content: 'inline roster v1',
      },
      { part_kind: 'user-prompt', content: 'hello team' },
    ],
  };
}

describe('AkgentChatComponent — head system block (Story 16-2)', () => {
  const AGENT = 'a-mgr';

  function setup(): {
    fixture: ComponentFixture<AkgentChatComponent>;
    component: AkgentChatComponent;
    log: MessageLogService;
  } {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AkgentChatComponent],
      providers: [
        {
          provide: ApiService,
          useValue: {
            sendMessage: jasmine
              .createSpy('sendMessage')
              .and.resolveTo(undefined),
          },
        },
        {
          provide: UtilService,
          useValue: { copyToClipboard: () => {}, formatJSON: (v: any) => v },
        },
        {
          provide: ContextService,
          useValue: {
            currentTeamRunning$: new BehaviorSubject<boolean>(true),
            currentProcessId$: new BehaviorSubject<string>('proc-1'),
          },
        },
        // Story 17-3 / Epic 17 (17-4): member chat reads
        // `commands.snapshot(agentId)`; the head block reads the
        // SystemPromptSelector façade over `IngestionService.systemPrompt`.
        // The stub exposes `commands` PLUS a REAL `systemPrompt` PerAgentStore
        // (registered on a real registry over the same MessageLogService) so the
        // head block renders from the actual log-driven fold.
        MessageLogService,
        PerAgentStoreRegistry,
        {
          provide: IngestionService,
          useFactory: (registry: PerAgentStoreRegistry) => ({
            commands: {
              snapshot: (_id: string): CommandDescriptor[] | undefined =>
                undefined,
            },
            systemPrompt: registry.register<SystemPromptValue>({
              name: 'systemPrompt',
              match: systemPromptMatch,
              reduce: systemPromptReduce,
            }),
          }),
          deps: [PerAgentStoreRegistry],
        },
        SystemPromptSelector,
        // PrimeNG p-fieldset registers a synthetic animation listener.
        provideNoopAnimations(),
      ],
    });

    const log = TestBed.inject(MessageLogService);
    const fixture = TestBed.createComponent(AkgentChatComponent);
    const component = fixture.componentInstance;
    component.context$ = new BehaviorSubject<any[]>([]);
    component.agentId = AGENT;
    component.agentName = '@' + AGENT;
    return { fixture, component, log };
  }

  /** All rendered head-block card headers, e.g. "System : roster". */
  function headHeaders(
    fixture: ComponentFixture<AkgentChatComponent>
  ): string[] {
    const el: HTMLElement = fixture.nativeElement;
    return Array.from(
      el.querySelectorAll('.head-system-container .card-header')
    ).map((n) => (n.textContent ?? '').trim());
  }

  /** Rendered head-block content bodies, in order. */
  function headBodies(
    fixture: ComponentFixture<AkgentChatComponent>
  ): string[] {
    const el: HTMLElement = fixture.nativeElement;
    return Array.from(
      el.querySelectorAll('.head-system-container .text-container')
    ).map((n) => (n.textContent ?? '').trim());
  }

  it('AC1 latest-wins: head fieldset shows the LAST event\'s rows', () => {
    const { fixture, component, log } = setup();
    log.appendAll([
      systemPromptEnvelope(AGENT, [
        { dynamic_ref: 'team.roster', content: 'roster v1' },
      ]),
      systemPromptEnvelope(AGENT, [
        { dynamic_ref: 'team.roster', content: 'roster v2' },
        { dynamic_ref: null, content: 'backstory' },
      ]),
    ]);
    fixture.detectChanges();

    expect(headHeaders(fixture)).toEqual([
      'System : roster',
      'System : System',
    ]);
    expect(headBodies(fixture)).toEqual(['roster v2', 'backstory']);
    // No system row leaked into the conversation table.
    expect(component.context.some((m) => m.type === 'system')).toBeFalse();
  });

  it('regression: switching agentId (component reused) rebinds the head block to the new agent', () => {
    const { fixture, component, log } = setup();
    const OTHER = 'b-other';
    log.appendAll([
      systemPromptEnvelope(AGENT, [{ dynamic_ref: null, content: 'A backstory' }]),
      systemPromptEnvelope(OTHER, [{ dynamic_ref: null, content: 'B backstory' }]),
    ]);
    fixture.detectChanges();
    expect(headBodies(fixture)).toEqual(['A backstory']);

    // The agent-tabs dropdown REUSES this component when switching members, so
    // ngOnInit does not re-run — ngOnChanges must re-point systemPrompt$ at the
    // new agent. Without the fix the head block stays pinned to 'A backstory'.
    component.agentId = OTHER;
    component.ngOnChanges({ agentId: new SimpleChange(AGENT, OTHER, false) });
    fixture.detectChanges();

    expect(headBodies(fixture)).toEqual(['B backstory']);
  });

  it('AC2 single source: updateContext() emits NO system row from a system-prompt part', () => {
    const { component } = setup();
    component.updateContext([doubleCarryContextMessage()]);
    // The user-prompt arm still produces a human row...
    expect(component.context.some((m) => m.type === 'human')).toBeTrue();
    // ...but the system-prompt arm is gone — no system row from updateContext.
    expect(component.context.some((m) => m.type === 'system')).toBeFalse();
  });

  it('AC2 untouched arms: tool-call / tool-return / text parts still render', () => {
    const { component } = setup();
    component.updateContext([
      {
        parts: [
          {
            part_kind: 'tool-call',
            tool_name: 'search',
            args: '{"q":"x"}',
            tool_call_id: 't1',
          },
          {
            part_kind: 'tool-return',
            content: 'result-x',
            tool_call_id: 't1',
          },
          { part_kind: 'text', content: 'final answer' },
        ],
      },
    ]);
    const types = component.context.map((m) => m.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('ai');
    // tool_call result merged from the tool-return.
    const toolCall = component.context.find((m) => m.type === 'tool_call');
    expect(toolCall.result).toBe('result-x');
  });

  it('AC3 no duplicate: run-1 double-carry renders the system block exactly once (at the head)', () => {
    const { fixture, component, log } = setup();
    // Same rendering carried in BOTH the first LlmMessageEvent (→ context$)
    // AND a LlmSystemPromptEvent (→ selector).
    log.appendAll([
      llmMessageEnvelope(AGENT, [
        { dynamic_ref: 'team.roster', content: 'roster' },
      ]),
      systemPromptEnvelope(AGENT, [
        { dynamic_ref: 'team.roster', content: 'roster' },
      ]),
    ]);
    component.context$.next([doubleCarryContextMessage()]);
    fixture.detectChanges();

    // Head block renders once.
    expect(headHeaders(fixture)).toEqual(['System : roster']);
    // And there is no second system block inside the conversation rows.
    const el: HTMLElement = fixture.nativeElement;
    const allSystemHeaders = Array.from(
      el.querySelectorAll('.card-header')
    ).filter((n) => (n.textContent ?? '').includes('System :'));
    expect(allSystemHeaders.length).toBe(1);
  });

  it('AC5 old-team fallback: no LlmSystemPromptEvent → head block from first LlmMessageEvent system parts', () => {
    const { fixture, component, log } = setup();
    log.appendAll([
      llmMessageEnvelope(AGENT, [
        { dynamic_ref: 'team.roster', content: 'legacy roster' },
      ]),
    ]);
    // The same first message also seeds the conversation context (double-carry).
    component.context$.next([doubleCarryContextMessage()]);
    fixture.detectChanges();

    expect(headHeaders(fixture)).toEqual(['System : roster']);
    expect(headBodies(fixture)).toEqual(['legacy roster']);
    // Still no inline duplicate.
    expect(component.context.some((m) => m.type === 'system')).toBeFalse();
  });

  it('AC7 REST/WS parity: batch appendAll and per-message append render identical head rows', () => {
    const fixtureEvents = (): AkgenticMessage[] => [
      llmMessageEnvelope(AGENT, [
        { dynamic_ref: 'team.roster', content: 'legacy' },
      ]),
      systemPromptEnvelope(AGENT, [
        { dynamic_ref: 'team.roster', content: 'roster v1' },
        { dynamic_ref: 'current_date', content: 'day 1' },
      ]),
      systemPromptEnvelope(AGENT, [
        { dynamic_ref: 'team.roster', content: 'roster v2' },
        { dynamic_ref: 'current_date', content: 'day 2' },
      ]),
    ];

    // REST: single batch.
    const rest = setup();
    rest.log.appendAll(fixtureEvents());
    rest.fixture.detectChanges();
    const restHead = headHeaders(rest.fixture).concat(headBodies(rest.fixture));

    // WS: per-message.
    const ws = setup();
    for (const ev of fixtureEvents()) ws.log.append(ev);
    ws.fixture.detectChanges();
    const wsHead = headHeaders(ws.fixture).concat(headBodies(ws.fixture));

    expect(restHead).toEqual(wsHead);
    // Latest-wins: roster v2 / day 2.
    expect(headBodies(rest.fixture)).toEqual(['roster v2', 'day 2']);
  });

  it('AC8 empty/absent: no system parts → no head fieldset, no throw', () => {
    const { fixture, component, log } = setup();
    // A log with only an unrelated event — no system parts for the agent.
    log.append({
      id: 'u1',
      parent_id: null,
      team_id: 'team-1',
      timestamp: new Date().toISOString(),
      sender: spSender(AGENT),
      display_type: 'other',
      content: null,
      __model__: 'akgentic.core.messages.orchestrator.EventMessage',
      event: { __model__: 'akgentic.llm.event.ToolStateEvent' },
    } as unknown as AkgenticMessage);
    expect(() => fixture.detectChanges()).not.toThrow();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('.head-system-container .card-header').length).toBe(
      0
    );
    expect(component.context.some((m) => m.type === 'system')).toBeFalse();
  });
});
