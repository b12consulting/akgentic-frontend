import { ChangeDetectorRef } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { ContextService } from '../../../core/context/context.service';
import { TeamActivity, TeamContext } from '../../../core/context/team.interface';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../testing/i18n-testing';
import { RailTeamRowComponent } from './rail-team-row.component';
import { RailTeamRow } from './rail-teams.selector';

function makeTeam(overrides: Partial<TeamContext> = {}): TeamContext {
  return {
    team_id: 'team-1',
    name: 'Demo Team',
    status: 'stopped',
    created_at: '2026-04-19T10:00:00Z',
    updated_at: '2026-04-19T10:00:00Z',
    config_name: 'demo',
    description: null,
    ...overrides,
  };
}

function makeRow(
  activity: TeamActivity,
  overrides: Partial<TeamContext> = {},
): RailTeamRow {
  return { team: makeTeam(overrides), activity };
}

/** Let a macrotask turn elapse, which is when a settled promise has run. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('RailTeamRowComponent', () => {
  let fixture: ComponentFixture<RailTeamRowComponent>;
  let component: RailTeamRowComponent;
  let contextSpy: jasmine.SpyObj<ContextService>;

  const rowButton = (): HTMLButtonElement =>
    fixture.debugElement.query(By.css('button.rail-row')).nativeElement;

  const dot = (): HTMLElement | null => {
    const found = fixture.debugElement.query(By.css('.rail-row__dot'));
    return found ? (found.nativeElement as HTMLElement) : null;
  };

  /**
   * Set the inputs and repaint.
   *
   * `setInput`, NOT a field assignment: this component is the fixture's ROOT
   * and it is OnPush, so a plain write leaves the view clean and
   * `detectChanges()` repaints nothing — every assertion after the first would
   * be reading the previous render. `setInput` marks the view dirty AND runs
   * `ngOnChanges`, which is where the row's derived strings come from.
   */
  async function render(row: RailTeamRow, active = false): Promise<void> {
    fixture.componentRef.setInput('row', row);
    fixture.componentRef.setInput('active', active);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  /**
   * Repaint after a change the component made to ITSELF.
   *
   * `fixture.componentRef.changeDetectorRef` is the HOST view's ref, not the
   * component's: marking it dirty refreshes the host bindings and stops at the
   * OnPush component view, which stays clean because a direct method call —
   * unlike a DOM listener — marks nothing. The ref pulled from the component's
   * own node injector is the one that reaches the template.
   */
  function repaint(): void {
    fixture.debugElement.injector.get(ChangeDetectorRef).markForCheck();
    fixture.detectChanges();
  }

  /** The kebab's wrapper — clicked rather than calling `openMenu` directly, so
   *  the popup gets a real event with a real element to align against. */
  const menuAnchor = (): HTMLElement =>
    fixture.nativeElement.querySelector('.rail-row__menu') as HTMLElement;

  beforeEach(async () => {
    contextSpy = jasmine.createSpyObj<ContextService>('ContextService', [
      'stopTeamAndAwait',
      'restoreTeamAndAwait',
      'deleteTeam',
    ]);
    contextSpy.stopTeamAndAwait.and.returnValue(Promise.resolve());
    contextSpy.restoreTeamAndAwait.and.returnValue(Promise.resolve());
    contextSpy.deleteTeam.and.returnValue(Promise.resolve());

    await TestBed.configureTestingModule({
      imports: [RailTeamRowComponent, NoopAnimationsModule],
      providers: [
        provideTranslateTesting(),
        { provide: ContextService, useValue: contextSpy },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RailTeamRowComponent);
    component = fixture.componentInstance;
  });

  // --- The row is an activator, not a div -------------------------------

  it('renders the row as a real <button>, first in the host', async () => {
    // The prototype's rows are `<div (click)>` and are unreachable by keyboard.
    await render(makeRow('stopped'));

    const first = fixture.nativeElement.firstElementChild as HTMLElement;
    expect(first.tagName).toBe('BUTTON');
    expect(first.classList).toContain('rail-row');
    expect((first as HTMLButtonElement).type).toBe('button');
  });

  it('emits the team id on click', async () => {
    await render(makeRow('running', { team_id: 'team-42' }));
    const seen: string[] = [];
    component.selected.subscribe((id) => seen.push(id));

    rowButton().click();

    expect(seen).toEqual(['team-42']);
  });

  // --- The status dot: four states, not two -----------------------------

  it('gives each of the four activities its own dot class', async () => {
    const seen: Record<string, string> = {};
    for (const activity of ['stopped', 'running', 'working', 'idle'] as const) {
      await render(makeRow(activity));
      seen[activity] = component.dotClass;
      expect(dot()!.classList).toContain(`rail-row__dot--${activity}`);
    }

    expect(new Set(Object.values(seen)).size).toBe(4);
  });

  it('pulses only while something is actually happening', async () => {
    // The prototype pulses unconditionally, so a team stopped for a week shows
    // a live, pulsing dot.
    await render(makeRow('working'));
    expect(dot()!.classList).toContain('rail-row__dot--pulse');

    await render(makeRow('running'));
    expect(dot()!.classList).toContain('rail-row__dot--pulse');

    await render(makeRow('idle'));
    expect(dot()!.classList).not.toContain('rail-row__dot--pulse');

    await render(makeRow('stopped'));
    expect(dot()!.classList).not.toContain('rail-row__dot--pulse');
  });

  it('hedges the two "as of the last refresh" states in the dot title', async () => {
    await render(makeRow('working'));
    expect(dot()!.getAttribute('title')).toBe('team.status.workingTitle');

    await render(makeRow('idle'));
    expect(dot()!.getAttribute('title')).toBe('team.status.idleTitle');

    await render(makeRow('stopped'));
    expect(dot()!.getAttribute('title')).toBe('team.status.stopped');
  });

  // --- Active row, and the hover inversion ------------------------------

  it('marks the open team, which is what the active-hover rule keys off', async () => {
    // The colour itself is a token; what is asserted here is the class the
    // `.active:hover` rule needs in order to exist at all.
    await render(makeRow('running'), true);
    expect(rowButton().classList).toContain('active');
    expect(rowButton().getAttribute('aria-current')).toBe('true');

    await render(makeRow('running'), false);
    expect(rowButton().classList).not.toContain('active');
    expect(rowButton().getAttribute('aria-current')).toBeNull();
  });

  // --- The kebab is revealed, not permanent -----------------------------

  it('keeps the kebab hidden until the row is pointed at or focused', async () => {
    await render(makeRow('running'));
    const host = fixture.nativeElement as HTMLElement;
    expect(host.classList).not.toContain('rail-row--revealed');

    host.dispatchEvent(new Event('mouseenter'));
    fixture.detectChanges();
    expect(host.classList).toContain('rail-row--revealed');

    host.dispatchEvent(new Event('mouseleave'));
    fixture.detectChanges();
    expect(host.classList).not.toContain('rail-row--revealed');

    // Focus is the keyboard equivalent — without it the kebab would be
    // tab-reachable and invisible.
    host.dispatchEvent(new Event('focusin'));
    fixture.detectChanges();
    expect(host.classList).toContain('rail-row--revealed');
  });

  it('keeps the kebab revealed while its own menu is open', async () => {
    await render(makeRow('running'));
    menuAnchor().click();
    repaint();
    expect((fixture.nativeElement as HTMLElement).classList).toContain(
      'rail-row--revealed',
    );

    component.onMenuHide();
    repaint();
    expect((fixture.nativeElement as HTMLElement).classList).not.toContain(
      'rail-row--revealed',
    );
  });

  // --- The overflow menu ------------------------------------------------

  it('offers Stop for a running team and not Restore', async () => {
    await render(makeRow('working', { status: 'running' }));

    const items = component.buildMenuItems();
    // Stop, Delete, a separator, then the way back to the full list.
    expect(items.map((i) => i.id)).toEqual([
      'stop',
      'delete',
      undefined,
      'open-in-list',
    ]);
    expect(items.find((i) => i.id === 'restore')).toBeUndefined();
    expect(items.find((i) => i.id === 'stop')!.label).toBe('team.action.stop');
  });

  it('offers Restore for a stopped team and not Stop', async () => {
    await render(makeRow('stopped', { status: 'stopped' }));

    const items = component.buildMenuItems();
    expect(items.find((i) => i.id === 'stop')).toBeUndefined();
    expect(items.find((i) => i.id === 'restore')!.label).toBe('team.action.restore');
  });

  it('puts the management-view escape hatch last, behind a separator', async () => {
    await render(makeRow('stopped'));

    const items = component.buildMenuItems();
    expect(items[items.length - 1].id).toBe('open-in-list');
    expect(items[items.length - 1].label).toBe('rail.openInList');
    expect(items[items.length - 2].separator).toBeTrue();
  });

  it('rebuilds the model at every open, so a stopped team stops offering Stop', async () => {
    // The model is a snapshot of a language AND of a lifecycle state; built
    // once, it would offer Stop for a team that has since stopped.
    await render(makeRow('running', { status: 'running' }));
    menuAnchor().click();
    expect(component.menuItems.some((i) => i.id === 'stop')).toBeTrue();

    await render(makeRow('stopped', { status: 'stopped' }));
    menuAnchor().click();
    expect(component.menuItems.some((i) => i.id === 'stop')).toBeFalse();
    expect(component.menuItems.some((i) => i.id === 'restore')).toBeTrue();
  });

  it('routes the management item through manageRequested and does not navigate itself', async () => {
    await render(makeRow('stopped', { team_id: 'team-9' }));
    const seen: string[] = [];
    component.manageRequested.subscribe((id) => seen.push(id));

    const item = component.buildMenuItems().find((i) => i.id === 'open-in-list')!;
    item.command!({});

    expect(seen).toEqual(['team-9']);
  });

  // --- The busy marks ---------------------------------------------------

  it('marks itself busy for a stop and clears when the work settles', async () => {
    await render(makeRow('running', { team_id: 'team-7', status: 'running' }));

    component.onStop();
    expect(component.stopping).toBeTrue();
    expect(contextSpy.stopTeamAndAwait).toHaveBeenCalledOnceWith('team-7');

    await macrotask();
    expect(component.stopping).toBeFalse();
  });

  it('clears the busy mark when a stop REJECTS', async () => {
    // The case a `then(clear)` design leaves spinning forever, on the one
    // occasion the user needs to be told it did not happen.
    contextSpy.stopTeamAndAwait.and.returnValue(Promise.reject(new Error('boom')));
    await render(makeRow('running', { status: 'running' }));

    component.onStop();
    expect(component.stopping).toBeTrue();

    await macrotask();
    expect(component.stopping).toBeFalse();
  });

  it('restores through restoreTeamAndAwait, which polls to running', async () => {
    contextSpy.restoreTeamAndAwait.and.returnValue(Promise.reject(new Error('nope')));
    await render(makeRow('stopped', { team_id: 'team-3' }));

    component.onRestore();
    expect(component.restoring).toBeTrue();
    expect(contextSpy.restoreTeamAndAwait).toHaveBeenCalledOnceWith('team-3');

    await macrotask();
    expect(component.restoring).toBeFalse();
  });

  it('deletes without a busy mark — the row it would mark is gone', async () => {
    await render(makeRow('stopped', { team_id: 'team-5' }));
    const seen: string[] = [];
    component.deleteRequested.subscribe((id) => seen.push(id));

    component.onDelete();

    expect(seen).toEqual(['team-5']);
    expect(contextSpy.deleteTeam).toHaveBeenCalledOnceWith('team-5');
    expect(component.stopping).toBeFalse();
    expect(component.restoring).toBeFalse();
  });

  it('swaps the dot for a progress mark while an action is in flight', async () => {
    // Held open, so the busy state is observable: with a resolved promise the
    // mark is set and cleared inside the same turn.
    let release!: () => void;
    contextSpy.stopTeamAndAwait.and.returnValue(
      new Promise<void>((resolve) => (release = resolve)),
    );
    await render(makeRow('running', { status: 'running' }));
    expect(dot()).not.toBeNull();

    component.onStop();
    repaint();
    await fixture.whenStable();

    expect(dot()).toBeNull();
    expect(fixture.debugElement.query(By.css('.rail-row__busy'))).not.toBeNull();

    release();
    await macrotask();
  });

  // --- The two text lines -----------------------------------------------

  it('renders the declared title, falling back to the team name', async () => {
    await render(
      makeRow('stopped', { name: 'Fallback', metadata: { subject: 'Payroll run' } }),
    );
    expect(fixture.nativeElement.querySelector('.rail-row__name').textContent.trim())
      .toBe('Fallback');

    fixture.componentRef.setInput('titleKey', 'subject');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.rail-row__name').textContent.trim())
      .toBe('Payroll run');
  });

  it('builds the meta line from ONE parameterised key, never a concatenation', async () => {
    setTestTranslations({
      rail: {
        teamMeta: '<<meta:{{summary}}|{{when}}>>',
        teamMetaTimeOnly: '<<time:{{when}}>>',
      },
    });
    await render(
      makeRow('stopped', { metadata: { case_id: 'CS-4471' } }),
    );

    const meta = fixture.nativeElement.querySelector('.rail-row__meta')
      .textContent as string;
    expect(component.metaKey).toBe('rail.teamMeta');
    expect(meta).toContain('CS-4471');
    expect(meta.startsWith('<<meta:')).toBeTrue();
  });

  it('drops to the time-only key when the team carries no metadata summary', async () => {
    setTestTranslations({
      rail: {
        teamMeta: '<<meta:{{summary}}|{{when}}>>',
        teamMetaTimeOnly: '<<time:{{when}}>>',
      },
    });
    await render(makeRow('stopped', { metadata: null }));

    expect(component.summary).toBeNull();
    expect(component.metaKey).toBe('rail.teamMetaTimeOnly');
    expect(
      (fixture.nativeElement.querySelector('.rail-row__meta').textContent as string)
        .startsWith('<<time:'),
    ).toBeTrue();
  });

  it('APPENDS THE OVERFLOW MENU TO BODY, or it is clipped away', async () => {
    // The row sits inside `.rail__list`, which is `overflow-y: auto`. A
    // `[popup]` menu renders in place, and an absolutely positioned popup
    // inside a scroll container is clipped by it — so the menu opened and was
    // never visible, which from the outside is indistinguishable from a kebab
    // that does nothing. Asserted on the template contract rather than on
    // rendered geometry, because the clipping ancestor is not in this fixture.
    await render(makeRow('stopped'));
    const menu = fixture.nativeElement.querySelector('p-menu');

    expect(menu).not.toBeNull();
    expect(menu.getAttribute('appendTo'))
      .withContext('a popup left inside the rail scroll container is clipped')
      .toBe('body');
  });

  it('excludes the title field from the summary, so the row never says it twice', async () => {
    fixture.componentRef.setInput('titleKey', 'subject');
    await render(
      makeRow('stopped', { metadata: { subject: 'Payroll run', case_id: 'CS-1' } }),
    );

    expect(component.summary).toBe('CS-1');
  });

  it('formats the timestamp as a clock time today and a date otherwise', async () => {
    const today = new Date();
    today.setHours(16, 35, 0, 0);
    await render(makeRow('stopped', { created_at: today.toISOString() }));
    const todayWhen = component.when;

    await render(makeRow('stopped', { created_at: '2020-04-19T10:00:00Z' }));
    expect(component.when).not.toBe(todayWhen);
    // A day-and-month, not a clock time: "which day?" is the question a row
    // from another day is asking.
    expect(component.when).toMatch(/\d/);
    expect(component.when).not.toContain(':');
  });

  it('survives an unparseable created_at rather than blanking the row', async () => {
    await render(makeRow('stopped', { created_at: 'not-a-date' }));
    expect(component.when).toBe('');
    expect(fixture.nativeElement.querySelector('.rail-row__name')).not.toBeNull();
  });
});
