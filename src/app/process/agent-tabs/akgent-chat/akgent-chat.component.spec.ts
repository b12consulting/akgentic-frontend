import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { AkgentChatComponent } from './akgent-chat.component';
import { ApiService } from '../../../services/api.service';
import { UtilService } from '../../../services/utils.service';
import { ContextService } from '../../../services/context.service';
import { ActorMessageService } from '../../../services/message.service';
import { CommandDescriptor } from '../../../models/message.types';

/**
 * Story 15-1 (ADR-013) — member-chat `/` slash-command mention. The member
 * chat targets exactly one agent (its own `agentName`), so the `/` list is
 * unconditionally that agent's commands.
 */
describe('AkgentChatComponent — slash-command mention (Story 15-1)', () => {
  let component: AkgentChatComponent;
  let commandsByAgentSubject: BehaviorSubject<
    Record<string, CommandDescriptor[]>
  >;

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
    commandsByAgentSubject = new BehaviorSubject<
      Record<string, CommandDescriptor[]>
    >({});

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
        {
          provide: ActorMessageService,
          useValue: { commandsByAgent$: commandsByAgentSubject },
        },
      ],
    });

    const fixture = TestBed.createComponent(AkgentChatComponent);
    component = fixture.componentInstance;
    component.context$ = new BehaviorSubject<any[]>([]);
    component.agentId = 'a-mgr';
    component.agentName = '@Manager';
    fixture.detectChanges();
  });

  it('AC-2: commandItems are the panel agent\'s commands', () => {
    commandsByAgentSubject.next({ '@Manager': [HIRE, ROSTER] });
    expect(component.commandItems.map((c) => c.name)).toEqual([
      'hire_member',
      'roster',
    ]);
  });

  it('AC-6: empty / list until a CommandsAnnouncedEvent arrives for this agent', () => {
    expect(component.commandItems).toEqual([]);
    commandsByAgentSubject.next({ '@Other': [HIRE] });
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
});
