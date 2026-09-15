import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { NavigationEnd, Router } from '@angular/router';
import { BehaviorSubject, Subject } from 'rxjs';

import { AuthService } from '../../../core/auth/auth.service';
import { ConfigService } from '../../../core/config/config.service';
import { ContextService } from '../../../core/context/context.service';
import { TeamContext } from '../../../core/context/team.interface';
import { TeamCreationLauncher } from '../../../core/ui/team-creation-launcher.service';
import { TeamCreationService } from '../../home/team-creation/team-creation.service';
import { ViewService } from '../../../core/ui/view.service';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../testing/i18n-testing';
import { ConsoleRailComponent, railListState } from './console-rail.component';

function makeTeam(overrides: Partial<TeamContext> = {}): TeamContext {
  return {
    team_id: 'team-1',
    name: 'Demo Team',
    status: 'running',
    created_at: '2026-04-19T10:00:00Z',
    updated_at: '2026-04-19T10:00:00Z',
    config_name: 'demo',
    description: null,
    ...overrides,
  };
}

describe('railListState', () => {
  it('lets rows win over a refetch — dim, do not empty', () => {
    expect(railListState(true, true, true)).toBe('rows');
  });

  it('lets a refetch win over "no teams" — a cold load is not an empty account', () => {
    expect(railListState(false, false, true)).toBe('loading');
  });

  it('blames the search only once loading and emptiness are ruled out', () => {
    expect(railListState(false, true, false)).toBe('no-results');
    expect(railListState(false, false, false)).toBe('empty');
  });
});

describe('ConsoleRailComponent', () => {
  let fixture: ComponentFixture<ConsoleRailComponent>;
  let component: ConsoleRailComponent;

  let teams$: BehaviorSubject<TeamContext[]>;
  let loading$: BehaviorSubject<boolean>;
  let currentProcessId$: BehaviorSubject<string>;
  let events$: Subject<NavigationEnd>;
  let isRailCollapsed$: BehaviorSubject<boolean>;

  let contextSpy: jasmine.SpyObj<ContextService>;
  let routerStub: { url: string; events: Subject<NavigationEnd>; navigate: jasmine.Spy };
  let viewStub: { isRailCollapsed$: BehaviorSubject<boolean>; toggleRail: jasmine.Spy };
  /**
   * `brandLogo` and NOT `logo`: the two answer different questions, and the
   * bug W9c fixes is a surface asking the wrong one. `logo` is "what path
   * would we load", framework default included; `brandLogo` is "did this
   * deployment set a mark of its own". Stubbed as a field the specs below
   * rewrite before `render()`, because it is read once at construction.
   */
  let configStub: { hideHome: boolean; brandLogo: string | null };
  // The REAL root service, not a spy: what this suite cares about is the flag
  // the rail actually raises, and a spy would pin the call rather than the
  // effect (including that a second press is a no-op).
  let launcher: TeamCreationLauncher;

  const q = (selector: string) => fixture.debugElement.query(By.css(selector));
  const qa = (selector: string) => fixture.debugElement.queryAll(By.css(selector));
  const textOf = (selector: string): string =>
    (q(selector).nativeElement.textContent as string).trim();

  async function render(url = '/process/team-1'): Promise<void> {
    routerStub.url = url;
    await TestBed.configureTestingModule({
      imports: [ConsoleRailComponent, NoopAnimationsModule],
      providers: [
        provideTranslateTesting(),
        { provide: ContextService, useValue: contextSpy },
        { provide: Router, useValue: routerStub },
        { provide: ViewService, useValue: viewStub },
        { provide: ConfigService, useValue: configStub },
        {
          provide: AuthService,
          useValue: {
            currentUser$: new BehaviorSubject({ user_id: 'u-1', name: 'Nadia' }),
            logout: jasmine.createSpy('logout'),
          },
        },
      ],
    }).compileComponents();

    launcher = TestBed.inject(TeamCreationLauncher);
    fixture = TestBed.createComponent(ConsoleRailComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  beforeEach(() => {
    teams$ = new BehaviorSubject<TeamContext[]>([]);
    loading$ = new BehaviorSubject<boolean>(false);
    currentProcessId$ = new BehaviorSubject<string>('');
    events$ = new Subject<NavigationEnd>();
    isRailCollapsed$ = new BehaviorSubject<boolean>(false);
    configStub = { hideHome: false, brandLogo: null };

    contextSpy = jasmine.createSpyObj<ContextService>(
      'ContextService',
      [
        'ensureTeamsLoaded',
        'navigateHome',
        'stopTeamAndAwait',
        'restoreTeamAndAwait',
        'deleteTeam',
      ],
      { teams$, loading$ },
    ) as jasmine.SpyObj<ContextService>;
    contextSpy.ensureTeamsLoaded.and.returnValue(Promise.resolve());
    contextSpy.navigateHome.and.returnValue(Promise.resolve(true));
    contextSpy.deleteTeam.and.returnValue(Promise.resolve());
    // A real subject, not a spy property: the rail must be able to READ it and
    // the spec must be able to prove the rail never writes it.
    contextSpy.currentProcessId$ = currentProcessId$;

    routerStub = {
      url: '/process/team-1',
      events: events$,
      navigate: jasmine.createSpy('navigate').and.returnValue(Promise.resolve(true)),
    };
    viewStub = {
      isRailCollapsed$,
      toggleRail: jasmine.createSpy('toggleRail'),
    };
  });

  // --- The seeding race -------------------------------------------------

  it('seeds page 1 when it mounts on a process URL, which has no other seeder', async () => {
    await render('/process/team-1');
    expect(contextSpy.ensureTeamsLoaded).toHaveBeenCalledTimes(1);
  });

  it('does NOT seed on the management view — that would race the table\'s own seed', async () => {
    // HomeComponent installs the filter restored from the URL value-only, so
    // its table's first (onLazyLoad) is the request that carries it. A second,
    // unfiltered page-1 fetch from here has nothing ordering it against that
    // one, and half the time it lands last.
    await render('/');
    expect(contextSpy.ensureTeamsLoaded).not.toHaveBeenCalled();
  });

  it('seeds when the FIRST navigation resolves to a process URL', async () => {
    // Mounted before the router settled: `router.url` is still the pre-boot
    // '/', so the decision waits for the navigation that actually happened.
    await render('/');
    expect(contextSpy.ensureTeamsLoaded).not.toHaveBeenCalled();

    events$.next(new NavigationEnd(1, '/process/team-9', '/process/team-9'));
    expect(contextSpy.ensureTeamsLoaded).toHaveBeenCalledTimes(1);
  });

  it('consumes only the FIRST navigation, so later ones cannot re-seed', async () => {
    await render('/');
    events$.next(new NavigationEnd(1, '/', '/'));
    events$.next(new NavigationEnd(2, '/process/team-9', '/process/team-9'));

    expect(contextSpy.ensureTeamsLoaded).not.toHaveBeenCalled();
  });

  it('does not wait for a navigation that already happened', async () => {
    // Arriving from /login, where the chrome is hidden, the rail is created
    // after NavigationEnd has been and gone.
    await render('/process/team-4');
    expect(contextSpy.ensureTeamsLoaded).toHaveBeenCalledTimes(1);
    // And nothing is left listening for one.
    events$.next(new NavigationEnd(2, '/process/team-5', '/process/team-5'));
    expect(contextSpy.ensureTeamsLoaded).toHaveBeenCalledTimes(1);
  });

  // --- The list ---------------------------------------------------------

  it('renders a header per non-empty group and no header for an absent one', async () => {
    teams$.next([
      makeTeam({ team_id: 'a', status: 'running' }),
      makeTeam({ team_id: 'b', status: 'running' }),
    ]);
    await render();

    expect(qa('.rail__group-label').map((el) => el.nativeElement.textContent.trim()))
      .toEqual(['rail.groupRunning']);
    expect(qa('app-rail-team-row').length).toBe(2);
  });

  it('renders both headers when both groups have rows, running first', async () => {
    teams$.next([
      makeTeam({ team_id: 'a', status: 'stopped' }),
      makeTeam({ team_id: 'b', status: 'running' }),
    ]);
    await render();

    expect(qa('.rail__group-label').map((el) => el.nativeElement.textContent.trim()))
      .toEqual(['rail.groupRunning', 'rail.groupRecent']);
  });

  it('says it is loading while the list is empty and a fetch is running', async () => {
    loading$.next(true);
    await render();
    expect(textOf('.rail__notice')).toBe('rail.loading');
  });

  it('DIMS rather than empties while refetching over rows already on screen', async () => {
    // An emptied searchable list reads as "nothing matches" — the one answer a
    // search exists to give.
    teams$.next([makeTeam({ team_id: 'a' })]);
    loading$.next(true);
    await render();

    expect(qa('app-rail-team-row').length).toBe(1);
    expect(q('.rail__list').nativeElement.classList).toContain('rail__list--dimmed');
  });

  it('offers the empty state when there are no teams and nothing is loading', async () => {
    await render();
    expect(textOf('.rail__notice-title')).toBe('rail.emptyTitle');
    expect(textOf('.rail__notice-body')).toBe('rail.emptyDesc');
  });

  it('distinguishes "no match" from "no teams", and threads the query into it', async () => {
    teams$.next([makeTeam({ team_id: 'a', name: 'Alpha' })]);
    await render();
    // AFTER the TestBed is configured: `setTestTranslations` injects
    // `TranslateService`, which does not exist until the providers are in.
    setTestTranslations({ rail: { noResults: '<<none:{{query}}>>' } });

    component.onQueryChange('zzz');
    fixture.detectChanges();

    expect(textOf('.rail__notice-title')).toBe('<<none:zzz>>');
    expect(textOf('.rail__notice-body')).toBe('rail.noResultsHint');
  });

  it('links the empty search result to the management view, where the rest of the teams are', async () => {
    // The search is client-side over the loaded page; the honest next step is
    // the list that can search them all.
    teams$.next([makeTeam({ team_id: 'a', name: 'Alpha' })]);
    await render();
    component.onQueryChange('zzz');
    fixture.detectChanges();

    q('.rail__notice-link').nativeElement.click();
    expect(contextSpy.navigateHome).toHaveBeenCalledTimes(1);
  });

  it('narrows the rendered rows as the search box reports a value', async () => {
    teams$.next([
      makeTeam({ team_id: 'a', name: 'Alpha' }),
      makeTeam({ team_id: 'b', name: 'Bravo' }),
    ]);
    await render();
    expect(qa('app-rail-team-row').length).toBe(2);

    const search = q('app-rail-search');
    search.componentInstance.valueChange.emit('brav');
    fixture.detectChanges();

    expect(qa('app-rail-team-row').length).toBe(1);
  });

  // --- Navigation and the read-only subject -----------------------------

  it('opens a team by routing, exactly as the table\'s row click does', async () => {
    teams$.next([makeTeam({ team_id: 'team-77' })]);
    await render();

    q('app-rail-team-row').componentInstance.selected.emit('team-77');

    expect(routerStub.navigate).toHaveBeenCalledOnceWith(['/process', 'team-77']);
  });

  it('NEVER writes currentProcessId$ — ProcessComponent is its single owner', async () => {
    // Epic 52 trap T3: a write from outside blanks the header's team name while
    // that team is still on screen.
    teams$.next([makeTeam({ team_id: 'team-77' })]);
    await render();
    const seen: string[] = [];
    currentProcessId$.subscribe((id) => seen.push(id));

    q('app-rail-team-row').componentInstance.selected.emit('team-77');
    component.onManage();
    component.onNewTeam();

    expect(seen).toEqual(['']);
  });

  it('marks the open team active, and only that one', async () => {
    teams$.next([makeTeam({ team_id: 'a' }), makeTeam({ team_id: 'b' })]);
    currentProcessId$.next('b');
    await render();

    const rows = qa('app-rail-team-row').map((el) => el.componentInstance);
    expect(rows.map((r: { active: boolean }) => r.active)).toEqual([false, true]);
  });

  it('opens the creation wizard from "new team", and navigates NOWHERE', async () => {
    // The rail used to hand this to the management view because there was no
    // dialog outside that page to open. There is now, and the whole point is
    // that asking for a new team no longer costs the user the conversation
    // they are reading.
    await render();
    q('.rail__new-team').nativeElement.click();

    expect(launcher.isOpen()).toBe(true);
    expect(routerStub.navigate).not.toHaveBeenCalled();
    expect(contextSpy.navigateHome).not.toHaveBeenCalled();
  });

  it('asks for the wizard without owning any of it', async () => {
    // TeamCreationService is still never root-scoped: the gate lives on
    // TeamCreationDialogComponent, which dies when the dialog closes. All the
    // rail can reach is the one boolean, so no creation state can accrete on a
    // component that outlives every navigation.
    await render();

    expect(() => TestBed.inject(TeamCreationService)).toThrow();
    expect(fixture.debugElement.injector.get(TeamCreationService, null)).toBeNull();
  });

  it('leaves the wizard alone when "new team" is pressed twice', async () => {
    // Re-raising the flag must not re-create the dialog, which would destroy
    // the gate behind it and discard a type the user had already chosen.
    await render();
    q('.rail__new-team').nativeElement.click();
    q('.rail__new-team').nativeElement.click();

    expect(launcher.isOpen()).toBe(true);
  });

  it('leaves a deleted team only when it is the one on screen', async () => {
    teams$.next([makeTeam({ team_id: 'a' }), makeTeam({ team_id: 'b' })]);
    currentProcessId$.next('b');
    await render();

    component.onDeleted('a');
    expect(contextSpy.navigateHome).not.toHaveBeenCalled();

    component.onDeleted('b');
    expect(contextSpy.navigateHome).toHaveBeenCalledTimes(1);
  });

  // --- Collapse ---------------------------------------------------------

  it('collapses through the shared ViewService, not a flag of its own', async () => {
    await render();
    expect((fixture.nativeElement as HTMLElement).classList).not.toContain('collapsed');

    isRailCollapsed$.next(true);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).classList).toContain('collapsed');
  });

  it('takes a collapsed rail out of the tab order and off the a11y tree', async () => {
    // `width: 0` + `overflow: hidden` hides the rail from a reader and from
    // nobody else: every team row and the footer's account menu stay tabbable,
    // and a screen reader still announces the whole list.
    await render();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.hasAttribute('inert')).toBeFalse();
    expect(host.getAttribute('aria-hidden')).toBeNull();

    isRailCollapsed$.next(true);
    fixture.detectChanges();
    expect(host.hasAttribute('inert')).toBeTrue();
    expect(host.getAttribute('aria-hidden')).toBe('true');

    // And back: an attribute that is only ever added is a rail that never
    // comes back, which the class binding alone would not catch.
    isRailCollapsed$.next(false);
    fixture.detectChanges();
    expect(host.hasAttribute('inert')).toBeFalse();
    expect(host.getAttribute('aria-hidden')).toBeNull();
  });

  it('toggles the rail from its own control', async () => {
    await render();
    const toggle = q('app-icon-button');
    toggle.componentInstance.pressed.emit();

    expect(viewStub.toggleRail).toHaveBeenCalledTimes(1);
  });

  it('gives the collapse control an accessible name — it is icon-only', async () => {
    await render();
    expect(q('app-icon-button').componentInstance.label).toBe('chrome.collapseSidebar');
  });

  /**
   * W9c — THE BRAND MARK IS EITHER/OR, NEVER BOTH.
   *
   * The framework's default `config.logo` is `akgent_logo.png`, a raster of
   * the very wordmark this row sets in type. Drawing both put one brand on
   * screen twice on every deployment that had never configured anything, so
   * the image was dropped — which was right for the default and wrong for a
   * white-label deployment that HAS a mark (sdworx-sme ships
   * `"logo": "sdworx-logo.svg"`), because it left theirs drawn nowhere.
   *
   * The rule, implemented identically here and in the login masthead: the
   * wordmark is the default, an explicitly configured logo REPLACES it. The
   * two assertions that matter are therefore the NEGATIVE ones — that neither
   * branch leaves the other on screen.
   */
  // RELOCATED FROM rail-footer.component.spec.ts. The control is the same one
  // and calls the same `navigateHome()`; what changed is where it lives and how
  // much it looks like a control. It had been a link-styled button beneath the
  // account block, losing every contest against the full-width Create button
  // above it.
  describe('the way back to the teams list', () => {
    it('offers it as a real BUTTON, not a link', async () => {
      // Not an `<a>` without an href — that is neither focusable nor announced.
      await render();
      const row = q('.rail__nav-row');

      expect(row).not.toBeNull();
      expect(row.nativeElement.tagName).toBe('BUTTON');
      expect((row.nativeElement.textContent as string).trim()).toBe(
        'rail.allTeams',
      );

      row.nativeElement.click();
      expect(contextSpy.navigateHome).toHaveBeenCalledTimes(1);
    });

    it('sits ABOVE the search box, where the eye already is', async () => {
      // The point of the move. Asserted on document order rather than on a
      // style, because "more obvious" here means "before the list, with the
      // other navigation" — a rule a stylesheet change cannot quietly undo.
      await render();
      const host = fixture.nativeElement as HTMLElement;
      const nav = host.querySelector('.rail__nav-row');
      const search = host.querySelector('app-rail-search');

      expect(nav).not.toBeNull();
      expect(search).not.toBeNull();
      expect(
        nav!.compareDocumentPosition(search!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      )
        .withContext('the way back must precede the search and the recents')
        .toBeTruthy();
    });

    it('suppresses it on a hideHome deployment', async () => {
      // A deployment that hides the teams page must not be given a row that
      // navigates to it.
      configStub.hideHome = true;
      await render();

      expect(q('.rail__nav-row')).toBeNull();
      expect(component.showAllTeams).toBeFalse();
    });
  });

  describe('(W9c) the brand mark', () => {
    it('sets the wordmark in type when no deployment mark is configured', async () => {
      await render();

      expect(q('.rail__wordmark')).not.toBeNull();
      expect(q('.rail__logo')).toBeNull();
    });

    it('draws the deployment mark INSTEAD of the wordmark, never as well', async () => {
      configStub.brandLogo = 'sdworx-logo.svg';
      await render();

      const logo = q('.rail__logo');
      expect(logo).not.toBeNull();
      expect(logo.nativeElement.getAttribute('src')).toBe('sdworx-logo.svg');
      // The half that would otherwise draw the brand twice.
      expect(q('.rail__wordmark')).toBeNull();
    });

    /**
     * It is the only thing in the chrome identifying whose product this is,
     * which is informative rather than decorative — so not `alt=""`. It cannot
     * be the product's NAME, because the framework knows a white-label
     * deployment's mark and not its name, so it is a translated generic.
     */
    it('names the mark for a screen reader, from the catalogue', async () => {
      configStub.brandLogo = 'sdworx-logo.svg';
      await render();

      expect(q('.rail__logo').nativeElement.getAttribute('alt')).toBe(
        'chrome.brandLogoAlt',
      );
    });

    /**
     * `brandLogo`, not `logo`. A rail that read `logo` would find the
     * framework default truthy on every untouched deployment and draw the
     * image again — the exact regression this feature exists to prevent, and
     * one that no other assertion here would catch, because both getters are
     * strings on a configured deployment.
     */
    it('asks whether a mark was SET, not what path would be loaded', async () => {
      configStub = {
        hideHome: false,
        brandLogo: null,
        // What `ConfigService.logo` would answer on a deployment that
        // configured nothing at all.
        logo: 'akgent_logo.png',
      } as typeof configStub & { logo: string };
      await render();

      expect(q('.rail__logo')).toBeNull();
      expect(q('.rail__wordmark')).not.toBeNull();
    });
  });
});
