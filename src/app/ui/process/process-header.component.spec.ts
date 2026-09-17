import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { BehaviorSubject } from 'rxjs';

import { ProcessHeaderComponent } from './process-header.component';
import { ContextService } from '../../core/platform/context/context.service';
import { TeamContext } from '../../core/platform/context/team.interface';
import { ViewService } from '../console/view.service';
import { provideTranslateTesting } from '../../../testing/i18n-testing';

function makeTeam(overrides: Partial<TeamContext> = {}): TeamContext {
  return {
    team_id: 'team-1',
    name: 'Payroll intake',
    status: 'running',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    config_name: 'standard',
    ...overrides,
  };
}

describe('ProcessHeaderComponent', () => {
  let fixture: ComponentFixture<ProcessHeaderComponent>;

  // The header reads root state and writes to it through two service methods,
  // so the doubles are subjects the spec drives directly plus spies on the two
  // writes. Nothing here stubs a rendering decision — every assertion below
  // goes through the DOM the component actually produced.
  let currentTeam$: BehaviorSubject<TeamContext | null>;
  let currentTeamRunning$: BehaviorSubject<boolean>;
  let currentProcessId$: BehaviorSubject<string>;
  let isRailCollapsed$: BehaviorSubject<boolean>;
  let isRightColumnCollapsed$: BehaviorSubject<boolean>;
  let clearSpy: jasmine.Spy;
  let toggleRailSpy: jasmine.Spy;

  beforeEach(async () => {
    currentTeam$ = new BehaviorSubject<TeamContext | null>(null);
    currentTeamRunning$ = new BehaviorSubject<boolean>(false);
    currentProcessId$ = new BehaviorSubject<string>('');
    isRailCollapsed$ = new BehaviorSubject<boolean>(false);
    isRightColumnCollapsed$ = new BehaviorSubject<boolean>(false);
    clearSpy = jasmine.createSpy('clear').and.returnValue(Promise.resolve());
    toggleRailSpy = jasmine.createSpy('toggleRail');

    await TestBed.configureTestingModule({
      imports: [ProcessHeaderComponent],
      providers: [
        provideTranslateTesting(),
        {
          provide: ContextService,
          useValue: {
            currentTeam$,
            currentTeamRunning$,
            currentProcessId$,
            clear: clearSpy,
          },
        },
        {
          provide: ViewService,
          useValue: {
            isRailCollapsed$,
            isRightColumnCollapsed$,
            toggleRail: toggleRailSpy,
            // The real method flips the subject, and the label / aria-expanded
            // specs below depend on that: a bare spy would prove the click was
            // wired without proving the control re-renders from the new state.
            toggleRightColumn: () =>
              isRightColumnCollapsed$.next(!isRightColumnCollapsed$.value),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ProcessHeaderComponent);
    fixture.detectChanges();
  });

  /** Open a team: both the id and the cached team, the way the real services
   *  emit them, so no spec accidentally asserts a half-open state. */
  function openTeam(team: TeamContext = makeTeam(), running = true): void {
    currentProcessId$.next(team.team_id);
    currentTeam$.next(team);
    currentTeamRunning$.next(running);
    fixture.detectChanges();
  }

  function title(): string {
    return fixture.nativeElement.querySelector('.team-name').textContent.trim();
  }

  function clearButton(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('.header-action--quiet');
  }

  function detailsButton(): HTMLButtonElement | null {
    return fixture.nativeElement.querySelector('.header-action--framed');
  }

  it('should create', () => {
    expect(fixture.componentInstance).toBeTruthy();
  });

  describe('title', () => {
    it('falls back to the untitled key when no team is open', () => {
      // The no-op translate loader echoes keys, so this asserts the KEY reached
      // the template — never the copy behind it.
      expect(title()).toBe('conversation.untitled');
    });

    it('renders the open team name, which is not copy and is not translated', () => {
      openTeam(makeTeam({ name: 'Payroll intake' }));

      expect(title()).toBe('Payroll intake');
    });
  });

  /**
   * The team's business metadata — five specs ported from the menubar this
   * header replaces (Epic 47).
   *
   * They were deleted with the menubar and nothing took them over, which is how
   * a feature disappears without a failure: the chips stopped rendering, the
   * component's own doc comment said they had moved to the inspector's Team
   * tab, and `buildInspectorTeam` had never read `metadata` in its life. Ported
   * verbatim in intent, re-pointed at this component's class names.
   */
  describe('business metadata', () => {
    function chips(): HTMLElement[] {
      return Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('.team-meta'),
      );
    }

    it('renders one chip per metadata field, label and value', () => {
      openTeam(makeTeam({ metadata: { case_id: 'C-1234', tenant: 'acme' } }));

      const rendered = chips();
      expect(rendered.length).toBe(2);
      // `case_id` -> `Case id`: the humaniser is shared with the filter bar, so
      // a chip and the input that filters on it always read identically.
      expect(rendered[0].textContent).toContain('Case id');
      expect(rendered[0].textContent).toContain('C-1234');
      expect(rendered[1].textContent).toContain('Tenant');
      expect(rendered[1].textContent).toContain('acme');
    });

    it('does not rebuild the chips on a change-detection cycle', () => {
      // The reported bug this pipe exists for: the chips visibly churned in
      // devtools on every tick. `metadataEntries` returns a FRESH array of FRESH
      // objects per call, so calling it straight from the binding hands the
      // differ all-new identities each cycle and it destroys and recreates every
      // chip.
      //
      // Asserted on NODE IDENTITY, not on rendered text: a rebuilt chip renders
      // exactly the same text, so text is blind to this. `toBe` is the whole
      // test — the node must be the same node.
      openTeam(makeTeam({ metadata: { tenant: 'acme', tier: 'gold' } }));

      const before = chips();
      expect(before.length).toBe(2);

      fixture.detectChanges();
      fixture.detectChanges();
      fixture.detectChanges();

      const after = chips();
      expect(after.length).toBe(2);
      expect(after[0]).toBe(before[0]);
      expect(after[1]).toBe(before[1]);
    });

    it('renders no chip at all when the team carries none', () => {
      // Both wire spellings of "no metadata" — an explicit null here, an absent
      // key in the spec below — must produce no container and no placeholder,
      // not an empty one.
      openTeam(makeTeam({ metadata: null }));
      expect(chips().length).toBe(0);
    });

    it('renders no chip when the team has no metadata key at all', () => {
      openTeam(makeTeam());
      expect(chips().length).toBe(0);
    });

    it('drops the chips when the team is closed', () => {
      openTeam(makeTeam({ metadata: { tenant: 'acme' } }));
      expect(chips().length).toBe(1);

      currentProcessId$.next('');
      currentTeam$.next(null);
      fixture.detectChanges();

      // A closed conversation has no team, so it has no facts about one. The
      // chips must not survive as the last team's, which is what a binding that
      // cached the entries rather than reading the live team would do.
      expect(chips().length).toBe(0);
    });
  });

  describe('status pill', () => {
    it('is absent entirely when no team is open', () => {
      // Not "present but neutral": a conversation with no team has no run state
      // to report, and an empty pill is a claim that it does.
      expect(fixture.nativeElement.querySelector('.status-pill')).toBeNull();
    });

    it('reports a running team with the accent ground and a live, pulsing dot', () => {
      openTeam(makeTeam(), true);

      expect(fixture.nativeElement.querySelector('.status-pill--running')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.status-dot--live')).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('.status-pill').textContent.trim(),
      ).toBe('team.status.running');
    });

    it('gives a STOPPED team neither the pulse nor the accent ground', () => {
      // The regression guard for the prototype's defect: in the mock the green
      // ground, the green dot and the pulse are unconditional, so a stopped team
      // renders a pulsing live indicator. All three must be gated, and this is
      // the assertion that stays red if any one of them stops being.
      openTeam(makeTeam({ status: 'stopped' }), false);

      expect(fixture.nativeElement.querySelector('.status-pill--stopped')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.status-pill--running')).toBeNull();
      expect(fixture.nativeElement.querySelector('.status-dot--live')).toBeNull();
      expect(
        fixture.nativeElement.querySelector('.status-pill').textContent.trim(),
      ).toBe('team.status.stopped');
    });

    it('follows the run state flipping under an already-open team', () => {
      openTeam(makeTeam(), true);
      currentTeamRunning$.next(false);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.status-dot--live')).toBeNull();
      expect(fixture.nativeElement.querySelector('.status-pill--stopped')).not.toBeNull();
    });
  });

  describe('Clear', () => {
    it('is disabled while no team is open', () => {
      expect(clearButton().disabled).toBeTrue();
    });

    it('clears the OPEN team by id once a team is open', () => {
      openTeam(makeTeam({ team_id: 'team-42' }));

      clearButton().click();

      expect(clearButton().disabled).toBeFalse();
      expect(clearSpy).toHaveBeenCalledOnceWith('team-42');
    });

    it('passes the id as of the click, not as of the render', () => {
      // `clear()` reads `currentProcessId$.value` at click time. Binding the id
      // instead would let a team switch between render and click send the
      // deletion to the team that just left the screen.
      openTeam(makeTeam({ team_id: 'team-first' }));
      currentProcessId$.next('team-second');

      clearButton().click();

      expect(clearSpy).toHaveBeenCalledOnceWith('team-second');
    });
  });

  describe('Details', () => {
    it('is absent while no team is open', () => {
      expect(detailsButton()).toBeNull();
    });

    it('reads as expanded and offers to hide while the inspector is open', () => {
      openTeam();

      expect(detailsButton()!.getAttribute('aria-expanded')).toBe('true');
      expect(detailsButton()!.textContent!.trim()).toBe('chrome.hideDetails');
      expect(detailsButton()!.classList).toContain('is-open');
    });

    it('toggles the inspector and flips its own label and aria-expanded with it', () => {
      openTeam();

      detailsButton()!.click();
      fixture.detectChanges();

      expect(isRightColumnCollapsed$.value).toBeTrue();
      expect(detailsButton()!.getAttribute('aria-expanded')).toBe('false');
      expect(detailsButton()!.textContent!.trim()).toBe('chrome.showDetails');
      expect(detailsButton()!.classList).not.toContain('is-open');

      detailsButton()!.click();
      fixture.detectChanges();

      expect(isRightColumnCollapsed$.value).toBeFalse();
      expect(detailsButton()!.getAttribute('aria-expanded')).toBe('true');
    });

    it('points at the inspector element rather than describing it', () => {
      openTeam();

      expect(detailsButton()!.getAttribute('aria-controls')).toBe('console-inspector');
    });
  });

  describe('show-sidebar', () => {
    it('is absent while the rail is visible, because it would reveal nothing', () => {
      expect(fixture.debugElement.query(By.css('app-icon-button'))).toBeNull();
    });

    it('appears once the rail collapses, and toggles it back', () => {
      isRailCollapsed$.next(true);
      fixture.detectChanges();

      const button = fixture.debugElement.query(By.css('app-icon-button'));
      expect(button).not.toBeNull();

      // Driven through the declared output rather than through whatever element
      // the shared button renders internally: the contract this header depends
      // on is `label` in and `pressed` out, and a spec that reached for the
      // inner <button> would fail the day that component restyles.
      button.triggerEventHandler('pressed');

      expect(toggleRailSpy).toHaveBeenCalledTimes(1);
    });

    it('gives the button an accessible name, which the mock never does', () => {
      isRailCollapsed$.next(true);
      fixture.detectChanges();

      const button = fixture.debugElement.query(By.css('app-icon-button'));
      // The no-op loader echoes the key, so this asserts the key was threaded
      // into the shared button's required `label` input.
      expect(button.componentInstance.label).toBe('chrome.showSidebar');
    });
  });
});
