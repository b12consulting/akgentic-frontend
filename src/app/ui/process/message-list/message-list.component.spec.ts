import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { MessageService } from 'primeng/api';

import { NOTIFICATION_PORT } from '../../../core/notification/notification.port';
import { PrimeNgNotificationAdapter } from '../../console/notification.adapter';

import { MessageListComponent } from './message-list.component';
import { MessageLogService } from '../../../services/process/event/message-log.service';
import { AkgenticMessage, SentMessage } from '../../../protocol/message.types';

import { CategoryService } from '../../../core/ui/category.service';

import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../testing/i18n-testing';

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

/**
 * The three severity colours, READ FROM THE PALETTE rather than restated here.
 *
 * UPDATED THIS ROUND, deliberately. It used to pin three rgb literals —
 * `rgb(169, 68, 66)` / `rgb(138, 109, 59)` / `rgb(49, 112, 143)` — which were
 * the component's own `--akg-error-color` / `--akg-warning-color` /
 * `--akg-notification-color`, three hexes declared on `:host` where
 * `token-contrast.spec.ts` (which reads `:root`) could not see them and where a
 * deployment re-pointing the palette could not move them. The panel now paints
 * from `--akg-danger-fg` / `--akg-attention-fg` / `--akg-accent-fg`, all three
 * of which that spec already measures against every declared ground.
 *
 * The ASSERTION is unchanged in strength: each severity still has to resolve to
 * one specific, named colour, and the three still have to differ. What changed
 * is WHICH colour — so the expectation names the token instead of transcribing
 * its value, which is the only way this spec stops needing an edit every time
 * the palette moves while still failing if a severity is wired to the wrong
 * token.
 */
const SEVERITY_TOKEN = {
  error: '--akg-danger-fg',
  warn: '--akg-attention-fg',
  info: '--akg-accent-fg',
} as const;

/** A `:root` custom property's value, as the browser resolves it. */
function tokenColor(token: string): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved;
}

/** The expected computed colour of a severity body. */
function severityColor(severity: keyof typeof SEVERITY_TOKEN): string {
  return tokenColor(SEVERITY_TOKEN[severity]);
}

describe('MessageListComponent (Story 2.6, AC8)', () => {
  let component: MessageListComponent;
  let fixture: ComponentFixture<MessageListComponent>;
  let log: MessageLogService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MessageListComponent, NoopAnimationsModule],
      providers: [
        provideTranslateTesting(),
        provideHttpClient(),
        provideHttpClientTesting(),
        MessageService,
        // Story 53-1: `UtilService` reaches the toast surface through the port
        // now. The real adapter is the production wiring and is just as inert
        // as the real `MessageService` above it until something notifies.
        { provide: NOTIFICATION_PORT, useClass: PrimeNgNotificationAdapter },
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

  /**
   * Epic 56 moved this panel into the 310px inspector, and two of its sizing
   * values did not come with it.
   *
   * Both were invisible in review because both look like ordinary layout: a
   * `min-width` on a table and a `scrollHeight` in `calc()`. In a ~278px lane
   * the first is 520px of table inside it, and the second re-derives a height
   * from the WINDOW inside a pane whose height already arrives through the
   * flex chain — so the panel overflowed on both axes at once.
   */
  describe('fits the pane it was moved into', () => {
    it('asks the table for no minimum width', () => {
      log.appendAll([workerSent('s1') as AkgenticMessage]);
      fixture.detectChanges();

      // 40rem is 520px. The lane is ~278px. Asserting on the rendered table
      // rather than on the binding, because `[tableStyle]` is only one of the
      // channels that can put a width there.
      const table = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
        'table',
      );
      expect(table).not.toBeNull();
      expect(table!.style.minWidth).toBe('');
    });

    it('derives its scroll height from the pane, never from the viewport', () => {
      log.appendAll([workerSent('s1') as AkgenticMessage]);
      fixture.detectChanges();

      // `scrollHeight="flex"` is PrimeNG's "take what your box gives you". The
      // assertion is on the ABSENCE of viewport arithmetic: any `vh` in this
      // panel's inline geometry is a height measured from the wrong element.
      const scroller = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
        '.p-datatable-table-container, .p-datatable-wrapper',
      );
      expect(scroller).withContext('the scrollable body rendered').not.toBeNull();
      expect(scroller!.style.maxHeight ?? '').not.toContain('vh');
      expect(scroller!.style.height ?? '').not.toContain('vh');
    });

    it('boxes a row in its own class, not the full-width global one', () => {
      // `.card-container` is declared unencapsulated in `src/styles.scss` with a
      // hard `#e0e0e0` border and a `1rem` margin on all four sides — 32px of a
      // 278px lane spent on margin, and the last untokenised edge on the panel.
      log.appendAll([workerSent('s1') as AkgenticMessage]);
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelector('.message-card')).not.toBeNull();
      expect(host.querySelector('.card-container')).toBeNull();

      const card = host.querySelector<HTMLElement>('.message-card')!;
      const style = window.getComputedStyle(card);
      expect(style.marginLeft).toBe('0px');
      expect(style.marginRight).toBe('0px');
    });
  });

  /**
   * W7 — the panel's empty state is the inspector's shared one.
   *
   * It used to be a hand-drawn dashed box, copied by its own comment from the
   * knowledge-graph panel: a fourth empty-state idiom in a console that already
   * had one. The assertions below are about the SWAP being lossless — the same
   * two keys, still going through the translation layer — because a restyle
   * that quietly drops a sentence is indistinguishable from a restyle that
   * works.
   */
  describe('the empty pane', () => {
    it('renders the shared empty state, not a placeholder of its own', () => {
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelector('app-inspector-empty-state')).not.toBeNull();
      // The dashed box and its three bespoke type steps are gone, not restyled.
      expect(host.querySelector('.empty-section')).toBeNull();
      expect(host.querySelector('.message-placeholder')).toBeNull();
    });

    it('keeps both sentences, and keeps them as translation keys', () => {
      // No translations registered, so the loader echoes the key back — which
      // is the assertion worth making: neither line was inlined as copy while
      // the markup moved.
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelector('.empty-title')?.textContent?.trim()).toBe(
        'messageList.emptyTitle',
      );
      expect(host.querySelector('.empty-blurb')?.textContent?.trim()).toBe(
        'messageList.emptyDesc',
      );
    });

    it('gives way to the table as soon as a message lands', () => {
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          'app-inspector-empty-state',
        ),
      ).not.toBeNull();

      log.appendAll([workerSent('s1') as AkgenticMessage]);
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelector('app-inspector-empty-state')).toBeNull();
      expect(host.querySelector('.message-card')).not.toBeNull();
    });
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
        provideTranslateTesting(),
        provideHttpClient(),
        provideHttpClientTesting(),
        MessageService,
        // Story 53-1: `UtilService` reaches the toast surface through the port
        // now. The real adapter is the production wiring and is just as inert
        // as the real `MessageService` above it until something notifies.
        { provide: NOTIFICATION_PORT, useClass: PrimeNgNotificationAdapter },
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

  /**
 * The severity label of the rendered row.
 *
 * UPDATED THIS ROUND: the selector moved from `.p-fieldset-legend` to
 * `.row-legend`. The panel no longer draws a PrimeNG `<p-fieldset>` — an
 * outlined box around every notification, in a stream whose other lines had no
 * outline — and renders the legend as the console's own micro-label instead.
 * Every assertion that uses this helper is untouched, including the one that
 * requires an EMPTY legend to still be an element (NFR2).
 */
function legendTextOf(host: HTMLElement): string {
    const el = host.querySelector<HTMLElement>('.row-legend');
    expect(el).withContext('no .row-legend rendered').toBeTruthy();
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

  it('paints an ErrorMessage body in the palette\'s danger colour', () => {
    const host = renderOne(notification('e1', 'ErrorMessage', 'RuntimeError', 'boom'));
    expect(getComputedStyle(bodyOf(host)).color).toBe(severityColor('error'));
  });

  it('paints a WarningMessage body in the palette\'s attention colour', () => {
    const host = renderOne(notification('w1', 'WarningMessage', null, 'careful'));
    expect(getComputedStyle(bodyOf(host)).color).toBe(severityColor('warn'));
  });

  it('paints a bare NotificationMessage body in the palette\'s accent', () => {
    const host = renderOne(notification('n1', 'NotificationMessage', null, 'fyi'));
    expect(getComputedStyle(bodyOf(host)).color).toBe(severityColor('info'));
  });

  // The three must still be TELLING APART, which is the whole job of a severity
  // ramp — a palette refactor that collapsed two of them onto one token would
  // satisfy every assertion above and destroy the feature.
  it('keeps the three severities visually distinct from one another', () => {
    const painted = new Set([
      severityColor('error'),
      severityColor('warn'),
      severityColor('info'),
    ]);
    expect(painted.size).toBe(3);
  });

  // --- rendered values, not mere presence (AC #8) --------------------------

  it('renders the fixture content as the body text', () => {
    const host = renderOne(
      notification('e1', 'ErrorMessage', 'RuntimeError', 'kaboom happened'),
    );
    expect(bodyOf(host).textContent).toBe('kaboom happened');
  });

  it('shows a notification body as TEXT, markup and all', () => {
    // This branch used to be `[innerHTML]="message.content"`. `content` is
    // typed `string` on all three notification models (`message.types.ts`) —
    // there is no markup contract on it — and the strings that arrive are
    // backend error text, which routinely contains angle brackets it did not
    // mean as tags: a Python `TypeError: expected <class 'Foo'>` lost the type
    // name entirely, because the browser parsed it as an unknown element.
    //
    // The same sink is also how model output reaches the DOM as markup, since
    // an error message commonly quotes what the model produced. Pinned here so
    // that "render it as HTML" is a decision someone has to take against a
    // failing spec rather than a convenience someone restores.
    const host = renderOne(
      notification(
        'e1',
        'ErrorMessage',
        'TypeError',
        "expected <class 'Foo'>, got <b>bar</b>",
      ),
    );
    expect(bodyOf(host).textContent).toBe(
      "expected <class 'Foo'>, got <b>bar</b>",
    );
    expect(bodyOf(host).querySelector('b'))
      .withContext('the body is text, not parsed markup')
      .toBeNull();
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
      (b.textContent ?? '').includes('messageList.relaunch'),
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

// ---------------------------------------------------------------------------
// Story 31-6 — row-padding parity (AC #1, #2)
//
// The notification branch used to carry an inline `style="margin: 0.5rem 0
// 1rem"` that the SentMessage branch, rendering the very same `.text-container`
// class, did not. That one attribute WAS the whole visible difference between
// the two row heights.
//
// Asserted as COMPUTED margins on both rows rather than as the absence of the
// attribute string from the template: the AC is that the rows match, and an
// attribute-absence assertion would stay green if the same margin came back
// through a class or a stylesheet rule instead.
// ---------------------------------------------------------------------------

describe('MessageListComponent row padding (Story 31-6)', () => {
  let component: MessageListComponent;
  let fixture: ComponentFixture<MessageListComponent>;
  let log: MessageLogService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MessageListComponent, NoopAnimationsModule],
      providers: [
        provideTranslateTesting(),
        provideHttpClient(),
        provideHttpClientTesting(),
        MessageService,
        // Story 53-1: `UtilService` reaches the toast surface through the port
        // now. The real adapter is the production wiring and is just as inert
        // as the real `MessageService` above it until something notifies.
        { provide: NOTIFICATION_PORT, useClass: PrimeNgNotificationAdapter },
        MessageLogService,
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(MessageListComponent);
    component = fixture.componentInstance;
    log = TestBed.inject(MessageLogService);
  });

  /** Render one notification row and one SentMessage row together, and return
   *  the `.text-container` of each. Rendering both in the SAME fixture is the
   *  point: the comparison must be between two live rows of one table. */
  function bothBodies(
    model: 'ErrorMessage' | 'WarningMessage' | 'NotificationMessage',
  ): { notification: HTMLElement; sent: HTMLElement } {
    log.appendAll([
      notification('n1', model, null, 'notification body'),
      workerSent('s1') as AkgenticMessage,
    ]);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const bodies = Array.from(
      host.querySelectorAll<HTMLElement>('.text-container'),
    );
    const notificationBody = bodies.find((b) =>
      b.className.includes('notification-body--'),
    );
    const sentBody = bodies.find(
      (b) => !b.className.includes('notification-body--'),
    );
    expect(notificationBody).withContext('no notification body').toBeTruthy();
    expect(sentBody).withContext('no SentMessage body').toBeTruthy();
    return { notification: notificationBody!, sent: sentBody! };
  }

  it('AC #1: a WarningMessage body has the same computed margins as a SentMessage body', () => {
    const { notification: notif, sent } = bothBodies('WarningMessage');

    const a = getComputedStyle(notif);
    const b = getComputedStyle(sent);
    expect(a.marginTop).toBe(b.marginTop);
    expect(a.marginBottom).toBe(b.marginBottom);
  });

  it('AC #1: the same holds for the error and bare-notification branches', () => {
    for (const model of ['ErrorMessage', 'NotificationMessage'] as const) {
      log.reset();
      const { notification: notif, sent } = bothBodies(model);

      const a = getComputedStyle(notif);
      const b = getComputedStyle(sent);
      expect(a.marginTop).withContext(model).toBe(b.marginTop);
      expect(a.marginBottom).withContext(model).toBe(b.marginBottom);
    }
  });

  // AC #2: deleting the margin must not disturb the branch it sat in. The
  // Relaunch button keeps its own spacing on its own row — never back on
  // `.text-container`, which the buttonless warn/info branches share.
  it('AC #2: the error row still renders its Relaunch button, on a spaced row', () => {
    log.appendAll([notification('e1', 'ErrorMessage', null, 'boom')]);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const actions = host.querySelector<HTMLElement>('.notification-actions');
    expect(actions).withContext('no button row').toBeTruthy();
    expect(actions!.textContent).toContain('messageList.relaunch');

    // The gap moved HERE from the body div. Asserted as "non-zero on the button
    // row while the body has none", not as a pixel literal: the rule is `1rem`,
    // and a rem resolves against the host page's root font size, which is the
    // Karma runner's and not the app's.
    const body = host.querySelector<HTMLElement>('.text-container')!;
    expect(parseFloat(getComputedStyle(actions!).marginTop)).toBeGreaterThan(0);
    expect(parseFloat(getComputedStyle(body).marginBottom)).toBe(0);
  });

  it('AC #2: warn and info rows render no button row at all', () => {
    for (const model of ['WarningMessage', 'NotificationMessage'] as const) {
      log.reset();
      log.appendAll([notification('x1', model, null, 'body')]);
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelector('.notification-actions'))
        .withContext(model)
        .toBeNull();
    }
  });

  it('AC #2: the severity colour classes are unchanged', () => {
    log.appendAll([notification('w1', 'WarningMessage', null, 'careful')]);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const body = host.querySelector<HTMLElement>('.text-container')!;
    expect(body.className).toContain('notification-body--warn');
    expect(getComputedStyle(body).color).toBe(severityColor('warn'));
    expect(component).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// W16 — the Messages tab, redesigned as THE RAW LOG
//
// The tab was considered for removal and deliberately kept: it is the only
// place every message appears in one chronological stream, and the sub-agent
// reader is per-participant. These specs pin the three things that follow from
// calling it a log rather than a table of cards — a stamp, a route that reads
// as a sentence, and a body that is quoted rather than re-rendered — plus the
// one copy control per line that makes a log usable.
// ---------------------------------------------------------------------------

describe('MessageListComponent as the raw log (W16)', () => {
  let component: MessageListComponent;
  let fixture: ComponentFixture<MessageListComponent>;
  let log: MessageLogService;
  let categories: CategoryService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MessageListComponent, NoopAnimationsModule],
      providers: [
        provideTranslateTesting(),
        provideHttpClient(),
        provideHttpClientTesting(),
        MessageService,
        // Story 53-1: `UtilService` reaches the toast surface through the port
        // now. The real adapter is the production wiring and is just as inert
        // as the real `MessageService` above it until something notifies.
        { provide: NOTIFICATION_PORT, useClass: PrimeNgNotificationAdapter },
        MessageLogService,
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(MessageListComponent);
    component = fixture.componentInstance;
    log = TestBed.inject(MessageLogService);
    categories = TestBed.inject(CategoryService);
    // Synthetic, never the shipped copy: the assertions below are about the
    // preposition and the broadcast word REACHING the line, and the no-op
    // loader would echo the bare key for both whether they did or not.
    setTestTranslations({
      messageList: { routeTo: '<<to>>', broadcast: '<<everyone>>' },
    });
  });

  function render(...msgs: AkgenticMessage[]): HTMLElement {
    log.appendAll(msgs);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  /** Collapse the whitespace the template's line breaks introduce. */
  function prose(el: Element | null): string {
    return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  // --- the stamp -----------------------------------------------------------

  describe('stamps every line', () => {
    it('renders the wall-clock time of the message, scannable and zero-padded', () => {
      const host = render(workerSent('s1') as AkgenticMessage);

      const stamp = host.querySelector<HTMLElement>('.log-time');
      expect(stamp).withContext('no timestamp on the line').not.toBeNull();
      // The fixture is an ISO instant; the panel renders it in the reader's own
      // zone, so the DIGITS are not predictable but the SHAPE is — and the
      // shape is the point: a column that lines up under itself.
      expect(stamp!.textContent!.trim()).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it('carries the full instant in `datetime`, for anything that reads the DOM', () => {
      const host = render(workerSent('s1') as AkgenticMessage);

      expect(
        host.querySelector('.log-time')!.getAttribute('datetime'),
      ).toBe('2026-05-18T00:00:00Z');
    });

    it('shows no stamp rather than "Invalid Date" for an unreadable timestamp', () => {
      const broken = workerSent('s1') as AkgenticMessage;
      (broken as { timestamp: string }).timestamp = 'not-a-date';

      const host = render(broken);
      expect(host.querySelector('.log-time')!.textContent!.trim()).toBe('');
    });
  });

  // --- the route, as prose -------------------------------------------------

  describe('reads the route as a sentence', () => {
    it('joins sender and recipient with a TRANSLATED preposition, not an arrow', () => {
      const host = render(workerSent('s1') as AkgenticMessage);

      // The whole line, in order. `◼︎ @Worker ➔ ◼︎ @Manager` cannot satisfy this:
      // the connector has to come out of the locale files.
      expect(prose(host.querySelector('.log-route'))).toBe(
        '@Worker <<to>> @Manager',
      );
    });

    it('names the broadcast case in words rather than leaving it blank', () => {
      // A notification carries no recipient — the case that used to render as
      // the bare `messageList.broadcast` label with no preposition in front.
      const host = render(notification('n1', 'NotificationMessage', null, 'fyi'));

      expect(prose(host.querySelector('.log-route'))).toBe(
        '@Worker <<to>> <<everyone>>',
      );
    });

    it('draws one dot for a broadcast and two for a directed message', () => {
      const host = render(
        workerSent('s1') as AkgenticMessage,
        notification('n1', 'NotificationMessage', null, 'fyi'),
      );

      const rows = Array.from(host.querySelectorAll('.message-card'));
      expect(rows.length).toBe(2);
      expect(rows[0].querySelectorAll('.route-dot').length)
        .withContext('sender and recipient')
        .toBe(2);
      expect(rows[1].querySelectorAll('.route-dot').length)
        .withContext('"everyone" is a description, not a party with a node')
        .toBe(1);
    });
  });

  // --- the dot ties the line back to the graph -----------------------------

  describe('ties each party to its node in the hierarchy graph', () => {
    it('paints the dot in the colour the graph draws that agent in', () => {
      // The same array the graph itself renders from, so a line's dot and its
      // node cannot disagree.
      categories.nodes = [
        { name: 'worker-1', category: 2 },
        { name: 'manager-1', category: 0 },
      ];

      const host = render(workerSent('s1') as AkgenticMessage);
      const dots = host.querySelectorAll<HTMLElement>('.route-dot');

      expect(dots.length).toBe(2);
      expect(dots[0].style.backgroundColor)
        .withContext('sender dot')
        .toBe(toRgb(categories.COLORS[2]));
      expect(dots[1].style.backgroundColor)
        .withContext('recipient dot')
        .toBe(toRgb(categories.COLORS[0]));
    });

    it('leaves the dot to the stylesheet when the graph has not placed the agent', () => {
      // A line can arrive before its agent's node exists (or after it stops).
      // No inline colour means the neutral `--akg-dot-idle` shows through,
      // rather than the line borrowing whichever category happens to be first.
      categories.nodes = [];

      const host = render(workerSent('s1') as AkgenticMessage);
      for (const dot of Array.from(
        host.querySelectorAll<HTMLElement>('.route-dot'),
      )) {
        expect(dot.style.backgroundColor).toBe('');
      }
    });
  });

  // --- the body is QUOTED, not re-rendered ---------------------------------

  describe('quotes the payload instead of re-rendering it', () => {
    it('renders markup in a message as the characters that were sent', () => {
      const msg = workerSent('s1') as SentMessage;
      (msg.message as { content: string }).content =
        '<b>not bold</b> & <script>x</script>';

      const host = render(msg as AkgenticMessage);
      const body = host.querySelector<HTMLElement>('.text-container')!;

      // `[innerHTML]` parsed this: the <b> became an element and the text lost
      // its tags. A log that re-renders what it is quoting is not quoting it.
      expect(body.querySelector('b')).withContext('markup was parsed').toBeNull();
      expect(body.textContent).toBe('<b>not bold</b> & <script>x</script>');
    });

    it('does the same on the notification branch', () => {
      const host = render(
        notification('e1', 'ErrorMessage', 'RuntimeError', '<i>boom</i>'),
      );
      const body = host.querySelector<HTMLElement>('.text-container')!;

      expect(body.querySelector('i')).toBeNull();
      expect(body.textContent).toBe('<i>boom</i>');
    });

    it('keeps the newlines a multi-line payload depends on', () => {
      const msg = workerSent('s1') as SentMessage;
      (msg.message as { content: string }).content = 'first\n\nsecond';

      const host = render(msg as AkgenticMessage);
      const body = host.querySelector<HTMLElement>('.text-container')!;

      expect(body.textContent).toBe('first\n\nsecond');
      // Without this the two paragraphs collapse onto one line, which is what
      // made a long payload unreadable here.
      expect(getComputedStyle(body).whiteSpace).toBe('pre-wrap');
    });
  });

  // --- one copy control per line -------------------------------------------

  describe('offers one copy control per line', () => {
    it('copies the payload of an ordinary message', () => {
      const copy = spyOn(component.utilService, 'copyToClipboard');
      const host = render(workerSent('s1') as AkgenticMessage);

      host.querySelector<HTMLElement>('.log-copy')!.click();
      expect(copy).toHaveBeenCalledOnceWith('ordinary message');
    });

    it('copies the body of a notification, which had no copy control at all', () => {
      const copy = spyOn(component.utilService, 'copyToClipboard');
      const host = render(notification('e1', 'ErrorMessage', null, 'kaboom'));

      const control = host.querySelector<HTMLElement>('.log-copy');
      expect(control).withContext('no copy control on a notification').not.toBeNull();
      control!.click();
      expect(copy).toHaveBeenCalledOnceWith('kaboom');
    });

    it('yields the empty string rather than throwing for a row with no text', () => {
      expect(component.copyableText({})).toBe('');
      expect(component.copyableText(undefined)).toBe('');
    });
  });

  // --- the panel paints from the palette, not from private hexes -----------

  it('declares no private severity palette of its own', () => {
    const host = render(notification('w1', 'WarningMessage', null, 'careful'));
    const card = host.querySelector<HTMLElement>('.message-card')!;

    // These three were declared on `:host` — outside `:root`, so
    // `token-contrast.spec.ts` never measured them, and outside the reach of a
    // deployment re-pointing the palette.
    for (const dead of [
      '--akg-error-color',
      '--akg-warning-color',
      '--akg-notification-color',
    ]) {
      expect(getComputedStyle(card).getPropertyValue(dead).trim())
        .withContext(dead)
        .toBe('');
    }
  });
});

/** A hex as the browser reports it back from a computed style. */
function toRgb(color: string): string {
  const probe = document.createElement('span');
  probe.style.backgroundColor = color;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return resolved;
}
