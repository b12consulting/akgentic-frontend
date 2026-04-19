import { CommonModule } from '@angular/common';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { Router } from '@angular/router';
import { BehaviorSubject, of } from 'rxjs';

import { AppComponent } from './app.component';
import { TeamContext } from './models/team.interface';
import { ApiService } from './services/api.service';
import { AuthService } from './services/auth.service';
import { ConfigService } from './services/config.service';
import { ContextService } from './services/context.service';
import { FaviconService } from './services/favicon.service';
import { ViewService } from './view.service';

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
    const apiStub = {};
    const routerStub = {
      navigate: jasmine.createSpy('navigate').and.returnValue(Promise.resolve(true)),
    };

    await TestBed.configureTestingModule({
      imports: [AppComponent, NoopAnimationsModule],
      providers: [
        { provide: ContextService, useValue: contextStub },
        { provide: ViewService, useValue: viewStub },
        { provide: AuthService, useValue: authStub },
        { provide: ConfigService, useValue: configStub },
        { provide: FaviconService, useValue: faviconStub },
        { provide: ApiService, useValue: apiStub },
        { provide: Router, useValue: routerStub },
      ],
    })
      .overrideComponent(AppComponent, {
        set: {
          imports: [CommonModule],
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

  it('(AC5) currentTeam$ emission populates processType, processConfigName, and processRunning', async () => {
    const team = makeTeam({ name: 'Alpha', config_name: 'alpha-cfg', status: 'running' });
    contextStub.currentTeam$.next(team);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.processType).toBe('Alpha');
    expect(component.processConfigName).toBe('alpha-cfg');
    expect(component.processRunning).toBe(true);
  });

  it('(AC5) currentTeam$ emitting null clears processType, processConfigName, and processRunning', async () => {
    contextStub.currentTeam$.next(makeTeam({ name: 'Beta' }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component.processType).toBe('Beta');

    contextStub.currentTeam$.next(null);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.processType).toBe('');
    expect(component.processConfigName).toBe('');
    expect(component.processRunning).toBe(false);
  });

  it('(AC5) currentTeam$ emission with stopped status keeps processRunning false', async () => {
    contextStub.currentTeam$.next(makeTeam({ status: 'stopped' }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component.processRunning).toBe(false);
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
});
