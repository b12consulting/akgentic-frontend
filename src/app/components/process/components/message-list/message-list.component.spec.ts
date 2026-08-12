import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { MessageService } from 'primeng/api';

import { MessageListComponent } from './message-list.component';
import { MessageLogService } from '../../event/message-log.service';
import { AkgenticMessage, SentMessage } from '../../../../protocol/message.types';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function workerSent(id: string): SentMessage {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-05-18T00:00:00Z',
    sender: {
      __actor_address__: true,
      name: '@Worker',
      role: 'Worker',
      agent_id: 'worker-1',
      team_id: 'team-1',
      squad_id: 's',
      user_message: false,
    },
    display_type: 'ai',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.SentMessage',
    recipient: {
      __actor_address__: true,
      name: '@Manager',
      role: 'Manager',
      agent_id: 'manager-1',
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
        name: '@Worker',
        role: 'Worker',
        agent_id: 'worker-1',
        team_id: 'team-1',
        squad_id: 's',
        user_message: false,
      },
      display_type: 'ai',
      content: 'ordinary message',
      __model__: 'akgentic.core.messages.orchestrator.SentMessage',
    },
  };
}

/** A welcome `SentMessage`: outer `ActorSystem` sender, inner `WelcomeMessage`
 *  payload with `display_type === 'other'` (Story 2.6, ADR-011). */
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

/**
 * Story 31-2 — a notification-family row (`ErrorMessage` / `WarningMessage` /
 * bare `NotificationMessage`). All three carry the same `content_type`/`content`
 * pair and no `recipient`, so they render through the single severity branch.
 */
function notification(
  id: string,
  model: 'ErrorMessage' | 'WarningMessage' | 'NotificationMessage',
  content_type: string | null,
  content: string,
): AkgenticMessage {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-05-18T00:00:00Z',
    sender: {
      __actor_address__: true,
      name: '@Worker',
      role: 'Worker',
      agent_id: 'worker-1',
      team_id: 'team-1',
      squad_id: 's',
      user_message: false,
    },
    display_type: 'other',
    content,
    content_type,
    __model__: `akgentic.core.messages.orchestrator.${model}`,
  } as unknown as AkgenticMessage;
}

/** The three severity colours, declared once (AC #7). */
const NOTIFICATION_COLORS = {
  error: 'rgb(169, 68, 66)',
  warn: 'rgb(138, 109, 59)',
  info: 'rgb(49, 112, 143)',
} as const;

describe('MessageListComponent (Story 2.6, AC8)', () => {
  let component: MessageListComponent;
  let fixture: ComponentFixture<MessageListComponent>;
  let log: MessageLogService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MessageListComponent, NoopAnimationsModule],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        MessageService,
        // MessageLogService is component-scoped in production; provide it at
        // module level here so the test can drive the log directly.
        MessageLogService,
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(MessageListComponent);
    component = fixture.componentInstance;
    log = TestBed.inject(MessageLogService);
  });

  it('should create', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('excludes the welcome announcement from filteredMessages', () => {
    log.appendAll([welcomeSent('w1') as AkgenticMessage]);
    fixture.detectChanges();

    expect(component.filteredMessages.map((m) => m.id)).not.toContain('w1');
    expect(component.filteredMessages.length).toBe(0);
  });

  it('keeps ordinary messages while filtering out the welcome announcement', () => {
    log.appendAll([
      welcomeSent('w1') as AkgenticMessage,
      workerSent('s1') as AkgenticMessage,
    ]);
    fixture.detectChanges();

    expect(component.filteredMessages.map((m) => m.id)).toEqual(['s1']);
  });
});

// ---------------------------------------------------------------------------
// Story 31-2 — notification rendering (AC #4, #7, #8, #9, #10)
// ---------------------------------------------------------------------------

describe('MessageListComponent notification rendering (Story 31-2)', () => {
  let component: MessageListComponent;
  let fixture: ComponentFixture<MessageListComponent>;
  let log: MessageLogService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MessageListComponent, NoopAnimationsModule],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        MessageService,
        MessageLogService,
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(MessageListComponent);
    component = fixture.componentInstance;
    log = TestBed.inject(MessageLogService);
  });

  /** Render exactly one message and return the host element. */
  function renderOne(msg: AkgenticMessage): HTMLElement {
    log.appendAll([msg]);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function bodyOf(host: HTMLElement): HTMLElement {
    const el = host.querySelector<HTMLElement>('.text-container');
    expect(el).withContext('no .text-container rendered').toBeTruthy();
    return el!;
  }

  function legendTextOf(host: HTMLElement): string {
    const el = host.querySelector<HTMLElement>('.p-fieldset-legend');
    expect(el).withContext('no .p-fieldset-legend rendered').toBeTruthy();
    return (el!.textContent ?? '').trim();
  }

  // --- notificationSeverity predicate (AC #4) ------------------------------

  describe('notificationSeverity', () => {
    it('maps each notification model to its severity, and everything else to null', () => {
      expect(
        component.notificationSeverity(notification('e', 'ErrorMessage', null, '')),
      ).toBe('error');
      expect(
        component.notificationSeverity(
          notification('w', 'WarningMessage', null, ''),
        ),
      ).toBe('warn');
      expect(
        component.notificationSeverity(
          notification('n', 'NotificationMessage', null, ''),
        ),
      ).toBe('info');
      expect(component.notificationSeverity(workerSent('s1'))).toBeNull();
    });
  });

  // --- notificationLegend fallback (AC #9) ---------------------------------

  describe('notificationLegend', () => {
    it('falls back to Warning / Notification, but never on the error path', () => {
      expect(
        component.notificationLegend(
          notification('w', 'WarningMessage', null, ''),
          'warn',
        ),
      ).toBe('Warning');
      expect(
        component.notificationLegend(
          notification('n', 'NotificationMessage', null, ''),
          'info',
        ),
      ).toBe('Notification');
      // NFR2: a null-`content_type` error keeps today's empty legend.
      expect(
        component.notificationLegend(
          notification('e', 'ErrorMessage', null, ''),
          'error',
        ),
      ).toBeNull();
    });

    it('prefers a present content_type over the fallback', () => {
      expect(
        component.notificationLegend(
          notification('w', 'WarningMessage', 'usage_limit', ''),
          'warn',
        ),
      ).toBe('usage_limit');
    });
  });

  // --- computed colour, one spec per severity (AC #7) ----------------------

  it('renders an ErrorMessage body in pastel red', () => {
    const host = renderOne(notification('e1', 'ErrorMessage', 'RuntimeError', 'boom'));
    expect(getComputedStyle(bodyOf(host)).color).toBe(NOTIFICATION_COLORS.error);
  });

  it('renders a WarningMessage body in pastel yellow', () => {
    const host = renderOne(notification('w1', 'WarningMessage', null, 'careful'));
    expect(getComputedStyle(bodyOf(host)).color).toBe(NOTIFICATION_COLORS.warn);
  });

  it('renders a bare NotificationMessage body in pastel blue', () => {
    const host = renderOne(notification('n1', 'NotificationMessage', null, 'fyi'));
    expect(getComputedStyle(bodyOf(host)).color).toBe(NOTIFICATION_COLORS.info);
  });

  // --- rendered values, not mere presence (AC #8) --------------------------

  it('renders the fixture content as the body text', () => {
    const host = renderOne(
      notification('e1', 'ErrorMessage', 'RuntimeError', 'kaboom happened'),
    );
    expect(bodyOf(host).textContent).toBe('kaboom happened');
  });

  it('renders a non-null error content_type as the legend, capitalized', () => {
    const host = renderOne(
      notification('e1', 'ErrorMessage', 'RuntimeError', 'boom'),
    );
    // CapitalizePipe upper-cases the first character only, then swaps `_` for a
    // space — 'RuntimeError' passes through unchanged.
    expect(legendTextOf(host)).toBe('RuntimeError');
  });

  // --- legend fallback on the rendered row (AC #9) -------------------------

  it('renders the Warning legend for a null-content_type warning', () => {
    const host = renderOne(notification('w1', 'WarningMessage', null, 'careful'));
    expect(legendTextOf(host)).toBe('Warning');
  });

  it('renders the Notification legend for a bare notification', () => {
    const host = renderOne(notification('n1', 'NotificationMessage', null, 'fyi'));
    expect(legendTextOf(host)).toBe('Notification');
  });

  it('renders an EMPTY legend for a null-content_type error (NFR2, unchanged)', () => {
    const host = renderOne(notification('e1', 'ErrorMessage', null, 'boom'));
    expect(legendTextOf(host)).toBe('');
  });

  // --- Relaunch affordance is error-only (AC #10) --------------------------

  function relaunchButton(host: HTMLElement): HTMLElement | null {
    return Array.from(host.querySelectorAll<HTMLElement>('button')).find((b) =>
      (b.textContent ?? '').includes('Relaunch'),
    ) ?? null;
  }

  it('keeps the Relaunch button on the error row', () => {
    const host = renderOne(notification('e1', 'ErrorMessage', 'RuntimeError', 'boom'));
    expect(relaunchButton(host)).toBeTruthy();
  });

  it('renders no Relaunch button on warning or notification rows', () => {
    const warn = renderOne(notification('w1', 'WarningMessage', null, 'careful'));
    expect(relaunchButton(warn)).toBeNull();

    log.reset();
    const info = renderOne(notification('n1', 'NotificationMessage', null, 'fyi'));
    expect(relaunchButton(info)).toBeNull();
  });

  // --- the two branches are mutually exclusive (AC #4) ---------------------

  it('renders each of the three severities through the notification branch only', () => {
    const models = ['ErrorMessage', 'WarningMessage', 'NotificationMessage'] as const;
    for (const model of models) {
      log.reset();
      const host = renderOne(notification('x1', model, null, 'body'));
      const bodies = host.querySelectorAll('.text-container');
      // Two bodies would mean the `SentMessage` branch fired as well.
      expect(bodies.length).withContext(model).toBe(1);
      expect(bodies[0].className).withContext(model).toContain('notification-body--');
    }
  });

  // A row the fold admits but `notificationSeverity` cannot classify takes the
  // fallback branch, which reads an inner payload it has no reason to carry.
  // Degrading to an empty row beats throwing out of change detection and losing
  // the whole table.
  it('yields no content keys for a message with no inner payload', () => {
    expect(component.getMessageContentKeys(undefined)).toEqual([]);
    expect(component.getMessageContentKeys(null)).toEqual([]);
  });

  it('renders a SentMessage through the non-notification branch exactly once', () => {
    const host = renderOne(workerSent('s1') as AkgenticMessage);

    const bodies = host.querySelectorAll('.text-container');
    expect(bodies.length).toBe(1);
    expect(bodies[0].textContent).toBe('ordinary message');
    // No severity class: the notification branch did not also fire.
    expect(host.querySelectorAll('[class*="notification-body--"]').length).toBe(0);
  });
});
