import { CommonModule } from '@angular/common';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { Router, RouterModule } from '@angular/router';
import { RouterTestingModule } from '@angular/router/testing';
import { MessageService } from 'primeng/api';
import { MenubarModule } from 'primeng/menubar';
import { TagModule } from 'primeng/tag';
import { BehaviorSubject, of } from 'rxjs';

import { AppComponent } from './app.component';
import { isRunning, TeamContext } from './core/context/team.interface';
import { ApiService } from './core/http/api.service';
import { AuthService } from './core/auth/auth.service';
import { ConfigService } from './core/config/config.service';
import { ContextService } from './core/context/context.service';
import { FaviconService } from './core/config/favicon.service';
import { NotificationToastService } from './core/ui/notification-toast.service';
import { ViewService } from './core/ui/view.service';

function makeTeam(overrides: Partial<TeamContext> = {}): TeamContext {
  return {
    team_id: 'team-1',
    name: 'Demo Team',
    status: 'running',
    created_at: '2026-04-19T10:00:00Z',
    updated_at: '2026-04-19T10:00:00Z',
    config_name: 'demo-config',
    description: null,
    ...overrides,
  };
}

interface ContextStub {
  currentProcessId$: BehaviorSubject<string>;
  currentTeam$: BehaviorSubject<TeamContext | null>;
  currentTeamRunning$: BehaviorSubject<boolean>;
  getCurrentTeam: jasmine.Spy;
  clear: jasmine.Spy;
}

describe('AppComponent (Story 10-2 — reactive currentTeam$ subscription)', () => {
  let fixture: ComponentFixture<AppComponent>;
  let component: AppComponent;
  let contextStub: ContextStub;
  let viewStub: { isRightColumnCollapsed$: BehaviorSubject<boolean>; toggleRightColumn: jasmine.Spy };
  let authStub: { currentUser$: BehaviorSubject<any>; checkAuth: jasmine.Spy; logout: jasmine.Spy };
  let configStub: { logo: string; hideLogin: boolean; favicon: string; hideHome: boolean };
  let apiStub: { getTeam: jasmine.Spy; getTeams: jasmine.Spy };

  beforeEach(async () => {
    contextStub = {
      currentProcessId$: new BehaviorSubject<string>(''),
      currentTeam$: new BehaviorSubject<TeamContext | null>(null),
      currentTeamRunning$: new BehaviorSubject<boolean>(false),
      getCurrentTeam: jasmine.createSpy('getCurrentTeam'),
      clear: jasmine.createSpy('clear'),
    };

    viewStub = {
      isRightColumnCollapsed$: new BehaviorSubject<boolean>(false),
      toggleRightColumn: jasmine.createSpy('toggleRightColumn'),
    };

    authStub = {
      currentUser$: new BehaviorSubject<any>({ name: 'Alice', user_id: 'u-1' }),
      checkAuth: jasmine.createSpy('checkAuth').and.returnValue(of(true)),
      logout: jasmine.createSpy('logout'),
    };

    configStub = {
      logo: 'logo.png',
      hideLogin: true,
      favicon: 'favicon.ico',
      hideHome: false,
    };

    const faviconStub = { setFavicon: jasmine.createSpy('setFavicon') };
    apiStub = {
      getTeam: jasmine.createSpy('getTeam'),
      getTeams: jasmine.createSpy('getTeams'),
    };

    await TestBed.configureTestingModule({
      imports: [AppComponent, NoopAnimationsModule, RouterTestingModule],
      providers: [
        { provide: ContextService, useValue: contextStub },
        { provide: ViewService, useValue: viewStub },
        { provide: AuthService, useValue: authStub },
        { provide: ConfigService, useValue: configStub },
        { provide: FaviconService, useValue: faviconStub },
        { provide: ApiService, useValue: apiStub },
      ],
    })
      .overrideComponent(AppComponent, {
        set: {
          imports: [CommonModule, MenubarModule, TagModule, RouterModule],
          schemas: [CUSTOM_ELEMENTS_SCHEMA],
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(AppComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  // Drive both `currentTeam$` and `currentTeamRunning$` consistently so the
  // template bindings (which read `| async` from both) see the same state.
  // In production `ContextService` derives `currentTeamRunning$` from
  // `currentTeam$`; the stub must emulate that derivation.
  async function emitTeam(team: TeamContext | null): Promise<void> {
    contextStub.currentTeam$.next(team);
    contextStub.currentTeamRunning$.next(team !== null && isRunning(team));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function headerTagValues(): string[] {
    const nodes = fixture.nativeElement.querySelectorAll('p-tag');
    return Array.from(nodes).map(
      (n: any) => n.getAttribute('value') || '',
    );
  }

  // --- AC5 — AppComponent drops getCurrentTeam fetch -------------------

  it('(AC5) AppComponent never calls contextService.getCurrentTeam on currentProcessId$ emissions', async () => {
    contextStub.currentProcessId$.next('team-1');
    await fixture.whenStable();
    fixture.detectChanges();

    contextStub.currentProcessId$.next('team-2');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(contextStub.getCurrentTeam).not.toHaveBeenCalled();
  });

  it('(AC9 10.6) header renders name/config_name/Running tag when currentTeam$ emits a running team', async () => {
    const team = makeTeam({ name: 'Alpha', config_name: 'alpha-cfg', status: 'running' });
    await emitTeam(team);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Alpha');
    expect(text).toContain('alpha-cfg');
    const tags = headerTagValues();
    expect(tags).toContain('Running');
    expect(tags).not.toContain('Stopped');
  });

  it('(AC9 10.6) header renders Stopped tag when currentTeam$ emits a stopped team', async () => {
    const team = makeTeam({ name: 'Beta', config_name: 'beta-cfg', status: 'stopped' });
    await emitTeam(team);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Beta');
    expect(text).toContain('beta-cfg');
    const tags = headerTagValues();
    expect(tags).toContain('Stopped');
    expect(tags).not.toContain('Running');
  });

  it('(AC9 10.6) header metadata block is hidden when currentTeam$ emits null', async () => {
    // Seed then clear so transitions exercise both branches.
    await emitTeam(makeTeam({ name: 'Gamma' }));
    expect(
      fixture.nativeElement.querySelector('.process-type'),
    ).not.toBeNull();

    await emitTeam(null);

    expect(fixture.nativeElement.querySelector('.process-type')).toBeNull();
  });

  // --- AC11 — REST call count invariant --------------------------------

  it('(AC11) sequence of currentProcessId$ + currentTeam$ emissions triggers zero getCurrentTeam calls', async () => {
    contextStub.currentProcessId$.next('team-1');
    contextStub.currentTeam$.next(makeTeam({ team_id: 'team-1' }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(contextStub.getCurrentTeam).not.toHaveBeenCalled();
  });

  // --- AC12 — Right-column toggle emits zero REST calls ---------------

  it('(AC12) toggling isRightColumnCollapsed$ rebuilds the menubar but does not call getCurrentTeam', async () => {
    contextStub.currentProcessId$.next('team-1');
    contextStub.currentTeam$.next(makeTeam({ team_id: 'team-1' }));
    await fixture.whenStable();
    fixture.detectChanges();

    viewStub.isRightColumnCollapsed$.next(true);
    await fixture.whenStable();
    fixture.detectChanges();
    viewStub.isRightColumnCollapsed$.next(false);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(contextStub.getCurrentTeam).not.toHaveBeenCalled();
    // The menubar rebuild populates `items`; verify the array was produced.
    expect(component.items).toBeDefined();
  });

  // --- AC10 — Subscription lifecycle ------------------------------------

  it('(AC10) 3 mount/unmount cycles leave zero residual observers on currentTeam$', async () => {
    // The first fixture (from beforeEach) still has an active subscription
    // until we destroy it below. Create and destroy 3 more fixtures first.
    for (let i = 0; i < 3; i++) {
      const f = TestBed.createComponent(AppComponent);
      f.detectChanges();
      await f.whenStable();
      f.detectChanges();
      f.destroy();
    }
    fixture.destroy();
    expect(contextStub.currentTeam$.observed).toBeFalse();
  });

  // --- Story 10-3 — decouple AppComponent from isRightColumnCollapsed$ ---

  it('(AC2) right-column toggle does not call contextService.getCurrentTeam or apiService.getTeam', async () => {
    const team = makeTeam({ team_id: 'team-A', name: 'Alpha' });
    contextStub.currentProcessId$.next('team-A');
    contextStub.currentTeam$.next(team);
    await fixture.whenStable();
    fixture.detectChanges();

    contextStub.getCurrentTeam.calls.reset();
    apiStub.getTeam.calls.reset();

    viewStub.isRightColumnCollapsed$.next(true);
    await fixture.whenStable();
    fixture.detectChanges();
    viewStub.isRightColumnCollapsed$.next(false);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(contextStub.getCurrentTeam).not.toHaveBeenCalled();
    expect(apiStub.getTeam).not.toHaveBeenCalled();
  });

  it('(AC2) right-column toggle rebuilds items with a new Hide/Show details label', async () => {
    contextStub.currentProcessId$.next('team-A');
    await fixture.whenStable();
    fixture.detectChanges();
    viewStub.isRightColumnCollapsed$.next(false);
    await fixture.whenStable();
    fixture.detectChanges();
    const expandedLabel = component.items?.find(
      (i) => i.label === 'Hide details' || i.label === 'Show details',
    )?.label;
    expect(expandedLabel).toBe('Hide details');

    viewStub.isRightColumnCollapsed$.next(true);
    await fixture.whenStable();
    fixture.detectChanges();
    const collapsedLabel = component.items?.find(
      (i) => i.label === 'Hide details' || i.label === 'Show details',
    )?.label;
    expect(collapsedLabel).toBe('Show details');
  });

  it('(AC3) currentUser$ change does not call getCurrentTeam or getTeam', async () => {
    contextStub.currentProcessId$.next('team-A');
    await fixture.whenStable();
    fixture.detectChanges();

    contextStub.getCurrentTeam.calls.reset();
    apiStub.getTeam.calls.reset();

    authStub.currentUser$.next({ name: 'Bob', user_id: 'u-2' });
    await fixture.whenStable();
    fixture.detectChanges();
    authStub.currentUser$.next(null);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(contextStub.getCurrentTeam).not.toHaveBeenCalled();
    expect(apiStub.getTeam).not.toHaveBeenCalled();
  });

  it('(AC3) username dropdown is present when currentUser$ has a name and absent when null', async () => {
    authStub.currentUser$.next({ name: 'Alice', user_id: 'u-1' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component.items?.some((i) => i.label === 'Alice')).toBeTrue();

    authStub.currentUser$.next(null);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component.items?.some((i) => i.label === 'Alice')).toBeFalse();
  });

  it('(AC5) on destroy, zero residual observers on currentTeam$, currentProcessId$, currentUser$, and isRightColumnCollapsed$', async () => {
    fixture.destroy();
    expect(contextStub.currentTeam$.observed).toBeFalse();
    expect(contextStub.currentProcessId$.observed).toBeFalse();
    expect(authStub.currentUser$.observed).toBeFalse();
    expect(viewStub.isRightColumnCollapsed$.observed).toBeFalse();
  });

  // --- Story 10-4 — header renders new team after reload-free flow ------

  it('(AC5 10.4) AppComponent header renders new team after create + navigate sequence with zero REST calls', async () => {
    // Starting state: no process, no team.
    contextStub.currentProcessId$.next('');
    await emitTeam(null);

    expect(fixture.nativeElement.querySelector('.process-type')).toBeNull();

    contextStub.getCurrentTeam.calls.reset();
    apiStub.getTeam.calls.reset();

    // Simulate the exact sequence produced by createTeamAndNavigate followed by
    // ProcessComponent.ngOnInit: _context$ mutation (driving currentTeam$) then
    // currentProcessId$ flipping to the new id.
    const newTeam = makeTeam({
      team_id: 'new',
      name: 'Alpha',
      config_name: 'cfg-alpha',
      status: 'running',
    });
    await emitTeam(newTeam);
    contextStub.currentProcessId$.next('new');
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Alpha');
    expect(text).toContain('cfg-alpha');
    expect(headerTagValues()).toContain('Running');
    expect(contextStub.getCurrentTeam).not.toHaveBeenCalled();
    expect(apiStub.getTeam).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Story 31-3 — notification toast rendering against the real <p-toast> mount
//
// Three facts about the notification toast are PrimeNG contracts, not service
// state, and are invisible to a `MessageService.add` spy:
//   - a message without `closable: false` renders a close button (AC6)
//   - a message with a `key` is REJECTED by the app's keyless mount (AC7)
//   - two messages coexist rather than replacing one another (AC8)
//
// This block therefore does NOT use `.overrideComponent(...)` like the suite
// above: that override swaps AppComponent's imports for a CUSTOM_ELEMENTS_SCHEMA
// stub set, under which `<p-toast>` is an inert unknown element and every
// assertion below would pass vacuously. AppComponent's own ToastModule import
// stands here, and a REAL MessageService is provided.
// ---------------------------------------------------------------------------

describe('AppComponent — notification toast rendering (Story 31-3)', () => {
  let fixture: ComponentFixture<AppComponent>;
  let messageService: MessageService;
  let apiStub: {
    getTeam: jasmine.Spy;
    getTeams: jasmine.Spy;
    emitClosedNotification: jasmine.Spy;
  };

  beforeEach(async () => {
    const contextStub: ContextStub = {
      currentProcessId$: new BehaviorSubject<string>(''),
      currentTeam$: new BehaviorSubject<TeamContext | null>(null),
      currentTeamRunning$: new BehaviorSubject<boolean>(false),
      getCurrentTeam: jasmine.createSpy('getCurrentTeam'),
      clear: jasmine.createSpy('clear'),
    };

    apiStub = {
      getTeam: jasmine.createSpy('getTeam'),
      getTeams: jasmine.createSpy('getTeams'),
      emitClosedNotification: jasmine
        .createSpy('emitClosedNotification')
        .and.resolveTo(undefined),
    };

    await TestBed.configureTestingModule({
      imports: [AppComponent, NoopAnimationsModule, RouterTestingModule],
      providers: [
        MessageService,
        { provide: ContextService, useValue: contextStub },
        {
          provide: ViewService,
          useValue: {
            isRightColumnCollapsed$: new BehaviorSubject<boolean>(false),
            toggleRightColumn: jasmine.createSpy('toggleRightColumn'),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUser$: new BehaviorSubject<any>({
              name: 'Alice',
              user_id: 'u-1',
            }),
            checkAuth: jasmine.createSpy('checkAuth').and.returnValue(of(true)),
            logout: jasmine.createSpy('logout'),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            logo: 'logo.png',
            hideLogin: true,
            favicon: 'favicon.ico',
            hideHome: false,
          },
        },
        {
          provide: FaviconService,
          useValue: { setFavicon: jasmine.createSpy('setFavicon') },
        },
        { provide: ApiService, useValue: apiStub },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AppComponent);
    messageService = TestBed.inject(MessageService);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  /** The shape `IngestionService.showNotificationToast` produces. */
  function notificationToast(
    summary: string,
    detail = 'over limit',
  ): Record<string, unknown> {
    return { severity: 'warn', summary, detail, sticky: true };
  }

  function toasts(): HTMLElement[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('.p-toast-message'),
    );
  }

  async function flush(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('AC6: a notification toast renders with a close button', async () => {
    messageService.add(notificationToast('Alpha'));
    await flush();

    const rendered = toasts();
    expect(rendered.length).toBe(1);
    expect(rendered[0].querySelector('.p-toast-summary')?.textContent?.trim())
      .toBe('Alpha');
    expect(rendered[0].querySelector('button.p-toast-close-button'))
      .not.toBeNull();
  });

  it('AC6 (contrast): a closable:false toast renders NO close button', async () => {
    // The disconnect-toast shape. Proves the assertion above is live rather
    // than passing because every toast happens to have a close button.
    messageService.add({ ...notificationToast('Connection Lost'), closable: false });
    await flush();

    const rendered = toasts();
    expect(rendered.length).toBe(1);
    expect(rendered[0].querySelector('button.p-toast-close-button')).toBeNull();
  });

  it('AC7: a keyless message renders; the same message with a key renders nothing', async () => {
    messageService.add(notificationToast('Alpha'));
    await flush();
    expect(toasts().length).toBe(1);

    messageService.clear();
    await flush();
    expect(toasts().length).toBe(0);

    // `<p-toast>` in app.component.html has no key, and PrimeNG's `canAdd`
    // admits a message only when `this.key === message.key`. A keyed message
    // is silently dropped — the invisibility regression this guards.
    messageService.add({ ...notificationToast('Alpha'), key: 'notification-x' });
    await flush();
    expect(toasts().length).toBe(0);
  });

  it('AC8: two keyless messages coexist — neither replaces the other', async () => {
    messageService.add(notificationToast('Alpha', 'first'));
    messageService.add(notificationToast('Beta', 'second'));
    await flush();

    const summaries = toasts().map((t) =>
      t.querySelector('.p-toast-summary')?.textContent?.trim(),
    );
    expect(summaries.length).toBe(2);
    expect(summaries).toContain('Alpha');
    expect(summaries).toContain('Beta');
  });

  // -------------------------------------------------------------------------
  // Story 31-4 (AC #4, #5, #6) — the close round trip, proven at the DOM.
  //
  // Driven by clicking the real `button.p-toast-close-button` rather than
  // calling `onToastClose` directly: the whole point is that the `(onClose)`
  // binding on the app's single `<p-toast>` is wired and that PrimeNG re-emits
  // `data` verbatim. Calling the handler would pass with the binding deleted.
  // -------------------------------------------------------------------------

  function closeFirstToast(): void {
    const button = toasts()[0].querySelector(
      'button.p-toast-close-button',
    ) as HTMLButtonElement;
    button.click();
  }

  it('AC4: clicking close issues exactly one POST with that toast\'s messageId and teamId', async () => {
    messageService.add({
      ...notificationToast('Alpha'),
      data: { messageId: 'w-1', teamId: 'team-1' },
    });
    await flush();
    expect(toasts().length).toBe(1);

    closeFirstToast();
    await flush();

    expect(apiStub.emitClosedNotification).toHaveBeenCalledTimes(1);
    expect(apiStub.emitClosedNotification).toHaveBeenCalledWith(
      'team-1',
      'w-1',
    );
  });

  it('AC4: closing one of two toasts reports only that toast\'s id', async () => {
    messageService.add({
      ...notificationToast('Alpha', 'first'),
      data: { messageId: 'w-1', teamId: 'team-1' },
    });
    messageService.add({
      ...notificationToast('Beta', 'second'),
      data: { messageId: 'w-2', teamId: 'team-1' },
    });
    await flush();
    expect(toasts().length).toBe(2);

    closeFirstToast();
    await flush();

    expect(apiStub.emitClosedNotification).toHaveBeenCalledTimes(1);
    expect(apiStub.emitClosedNotification).toHaveBeenCalledWith(
      'team-1',
      'w-1',
    );
  });

  it('AC5: closing a toast with no data issues ZERO POSTs', async () => {
    messageService.add(notificationToast('Alpha'));
    await flush();

    closeFirstToast();
    await flush();

    expect(apiStub.emitClosedNotification).not.toHaveBeenCalled();
  });

  it('AC5: closing a toast with data but no messageId issues ZERO POSTs', async () => {
    messageService.add({
      ...notificationToast('Alpha'),
      data: { teamId: 'team-1' },
    });
    await flush();

    closeFirstToast();
    await flush();

    expect(apiStub.emitClosedNotification).not.toHaveBeenCalled();
  });

  it('AC5: closing a toast with a messageId but no teamId issues ZERO POSTs', async () => {
    messageService.add({
      ...notificationToast('Alpha'),
      data: { messageId: 'w-1' },
    });
    await flush();

    closeFirstToast();
    await flush();

    expect(apiStub.emitClosedNotification).not.toHaveBeenCalled();
  });

  it('AC6: a rejected POST is caught and logged, and nothing escapes the handler', async () => {
    // The rejection is asserted through `console.error` rather than a
    // `window.unhandledrejection` listener: Zone.js intercepts rejections in
    // Karma, so that listener never fires and cannot tell a handled rejection
    // from an unhandled one — deleting the terminal `.catch` left it green.
    // The log call is the observable proof that the promise IS terminated.
    const reason = new Error('409 team stopped');
    apiStub.emitClosedNotification.and.returnValue(Promise.reject(reason));
    const consoleError = spyOn(console, 'error');

    messageService.add({
      ...notificationToast('Alpha'),
      data: { messageId: 'w-1', teamId: 'team-1' },
    });
    await flush();

    expect(() => closeFirstToast()).not.toThrow();
    await flush();
    // Give the microtask queue a turn so the `.catch` callback has run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(apiStub.emitClosedNotification).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to record notification dismissal:',
      reason,
    );
  });

  it('AC6: a rejected POST still removes the toast from the DOM', async () => {
    apiStub.emitClosedNotification.and.returnValue(
      Promise.reject(new Error('409 team stopped')),
    );

    messageService.add({
      ...notificationToast('Alpha'),
      data: { messageId: 'w-1', teamId: 'team-1' },
    });
    await flush();
    expect(toasts().length).toBe(1);

    closeFirstToast();
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();

    expect(toasts().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Story 31-5 — removing one on-screen toast, against the real <p-toast> mount
//
// Two things can only be settled here, against real PrimeNG:
//
//   1. WHY the mechanism is what it is. `MessageService` offers `add` and
//      `clear(key)` and nothing else, and neither can take down a single toast
//      on the app's shared keyless mount. The first two specs below run that
//      claim rather than asserting it in a comment — they are the evidence for
//      the design, and they fail loudly if a PrimeNG upgrade ever changes it.
//   2. That splicing `Toast.messages` through `NotificationToastService` really
//      does remove the rendered element, leaving its neighbours in place.
//
// Like the 31-3 block above, this one keeps AppComponent's own ToastModule
// import and a REAL MessageService — under the `.overrideComponent(...)` stub
// set used by the first suite in this file `<p-toast>` is an inert unknown
// element and every assertion here would pass vacuously.
// ---------------------------------------------------------------------------

describe('AppComponent — single-toast removal (Story 31-5)', () => {
  let fixture: ComponentFixture<AppComponent>;
  let messageService: MessageService;
  let notificationToast: NotificationToastService;

  beforeEach(async () => {
    const contextStub: ContextStub = {
      currentProcessId$: new BehaviorSubject<string>(''),
      currentTeam$: new BehaviorSubject<TeamContext | null>(null),
      currentTeamRunning$: new BehaviorSubject<boolean>(false),
      getCurrentTeam: jasmine.createSpy('getCurrentTeam'),
      clear: jasmine.createSpy('clear'),
    };

    await TestBed.configureTestingModule({
      imports: [AppComponent, NoopAnimationsModule, RouterTestingModule],
      providers: [
        MessageService,
        { provide: ContextService, useValue: contextStub },
        {
          provide: ViewService,
          useValue: {
            isRightColumnCollapsed$: new BehaviorSubject<boolean>(false),
            toggleRightColumn: jasmine.createSpy('toggleRightColumn'),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUser$: new BehaviorSubject<any>({
              name: 'Alice',
              user_id: 'u-1',
            }),
            checkAuth: jasmine.createSpy('checkAuth').and.returnValue(of(true)),
            logout: jasmine.createSpy('logout'),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            logo: 'logo.png',
            hideLogin: true,
            favicon: 'favicon.ico',
            hideHome: false,
          },
        },
        {
          provide: FaviconService,
          useValue: { setFavicon: jasmine.createSpy('setFavicon') },
        },
        {
          provide: ApiService,
          useValue: {
            getTeam: jasmine.createSpy('getTeam'),
            getTeams: jasmine.createSpy('getTeams'),
            emitClosedNotification: jasmine
              .createSpy('emitClosedNotification')
              .and.resolveTo(undefined),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AppComponent);
    messageService = TestBed.inject(MessageService);
    notificationToast = TestBed.inject(NotificationToastService);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  function notificationToastFor(
    messageId: string,
    summary: string,
  ): Record<string, unknown> {
    return {
      severity: 'warn',
      summary,
      detail: 'over limit',
      sticky: true,
      data: { messageId, teamId: 'team-1' },
    };
  }

  function summaries(): (string | undefined)[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('.p-toast-message'),
    ).map((t) =>
      (t as HTMLElement)
        .querySelector('.p-toast-summary')
        ?.textContent?.trim(),
    );
  }

  async function flush(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  // --- why MessageService alone cannot do this (Task 1 evidence) -----------

  it('MessageService.clear(key) removes NOTHING from the app\'s keyless mount', async () => {
    messageService.add(notificationToastFor('w-1', 'Alpha'));
    await flush();
    expect(summaries().length).toBe(1);

    // The obvious-looking `key: 'notification-<id>'` + `clear(that key)` design.
    // PrimeNG matches a clear against the CONTAINER's key, not a message's, and
    // this container has none — so the toast survives untouched.
    messageService.clear('notification-w-1');
    await flush();

    expect(summaries()).toEqual(['Alpha']);
  });

  it('MessageService.clear() with no key removes EVERY toast, not just one', async () => {
    // The other half of the same point: the only clear that bites is the
    // blanket one, which would take the disconnect toast down with it.
    messageService.add(notificationToastFor('w-1', 'Alpha'));
    messageService.add({ severity: 'warn', summary: 'Connection Lost', sticky: true });
    await flush();
    expect(summaries().length).toBe(2);

    messageService.clear();
    await flush();

    expect(summaries()).toEqual([]);
  });

  // --- what the story actually does ---------------------------------------

  it('dismiss() removes exactly the matching toast from the DOM', async () => {
    messageService.add(notificationToastFor('w-1', 'Alpha'));
    messageService.add(notificationToastFor('w-2', 'Beta'));
    await flush();
    expect(summaries()).toEqual(['Alpha', 'Beta']);

    notificationToast.dismiss('w-1');
    await flush();

    expect(summaries()).toEqual(['Beta']);
  });

  it('dismiss() leaves the disconnect toast standing', async () => {
    messageService.add(notificationToastFor('w-1', 'Alpha'));
    messageService.add({
      severity: 'warn',
      summary: 'Connection Lost',
      sticky: true,
      closable: false,
    });
    await flush();

    notificationToast.dismiss('w-1');
    await flush();

    expect(summaries()).toEqual(['Connection Lost']);
  });

  it('dismiss() for an unknown id leaves every toast on screen', async () => {
    messageService.add(notificationToastFor('w-1', 'Alpha'));
    await flush();

    notificationToast.dismiss('w-9');
    await flush();

    expect(summaries()).toEqual(['Alpha']);
  });

  it('AppComponent registers its mount, so dismiss() reaches a real container', async () => {
    // Guards the `ngAfterViewInit` wiring specifically: without the register
    // call the service holds null and every dismiss above would pass by doing
    // nothing at all to an empty screen.
    messageService.add(notificationToastFor('w-1', 'Alpha'));
    await flush();

    notificationToast.dismiss('w-1');
    await flush();

    expect(summaries()).toEqual([]);
  });

  it('a wire-driven dismissal POSTs nothing back, while a user click still does', async () => {
    // The echo-loop guard. `dismiss()` splices `Toast.messages` directly, which
    // deliberately does NOT go through `Toast.onMessageClose` and so never fires
    // the `(onClose)` binding that `AppComponent.onToastClose` POSTs from. Route
    // the removal through PrimeNG's own close path instead and every closure
    // replayed off the wire would emit a fresh `ClosedNotification` for a
    // notification that is already closed — the client answering the server's
    // echo with another echo.
    const emit = TestBed.inject(ApiService)
      .emitClosedNotification as jasmine.Spy;

    messageService.add(notificationToastFor('w-1', 'Alpha'));
    await flush();

    notificationToast.dismiss('w-1');
    await flush();

    expect(summaries()).toEqual([]);
    expect(emit).not.toHaveBeenCalled();

    // Contrast, so the assertion above cannot pass because nothing ever POSTs:
    // the same toast closed by hand DOES record the dismissal (Story 31-4).
    messageService.add(notificationToastFor('w-2', 'Beta'));
    await flush();
    (
      fixture.nativeElement.querySelector(
        'button.p-toast-close-button',
      ) as HTMLButtonElement
    ).click();
    await flush();

    expect(emit).toHaveBeenCalledOnceWith('team-1', 'w-2');
  });

  it('destroying AppComponent unregisters the mount', async () => {
    messageService.add(notificationToastFor('w-1', 'Alpha'));
    await flush();

    fixture.destroy();

    // A dismissal arriving after teardown must not splice a dead container.
    expect(() => notificationToast.dismiss('w-1')).not.toThrow();
    expect((notificationToast as any).toast).toBeNull();
  });
});
