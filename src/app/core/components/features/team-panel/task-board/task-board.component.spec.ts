import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import en from '../../../../platform/i18n/locales/en.json';
import { CategoryService } from '../../../../services/category.service';
import { IngestionService } from '../../../../services/process/event/ingestion.service';
import { AgentStateValue } from '../../../../services/process/event/per-agent-specs';
import { GraphDataService } from '../../../../services/process/selectors/graph.selector';
import { PLANNING_ACTOR_NAME } from '../../../../services/process/selectors/task-board';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../../../testing/i18n-testing';
import { TASK_BOARD_HIDE_CLOSED_KEY, TaskBoardComponent } from './task-board.component';

type Node = { actorName: string; name: string; role: string; thinking?: boolean };

const ROSTER: Node[] = [
  { actorName: '@Human', name: 'human-id', role: 'Human' },
  { actorName: '@Manager', name: 'manager-id', role: 'Manager' },
  { actorName: '@Expert', name: 'expert-id', role: 'Expert' },
  { actorName: PLANNING_ACTOR_NAME, name: 'planning-id', role: 'ToolActor' },
];

function task(id: number, status: string, owner: string): Record<string, unknown> {
  return { id, status, description: `task ${id} ${'long '.repeat(20)}`, owner };
}

function plan(tasks: Record<string, unknown>[]): ReadonlyMap<string, AgentStateValue> {
  return new Map([['planning-id', { schema: {}, state: { task_list: tasks } }]]);
}

const MIXED = [
  task(4, 'abort', '@Expert'),
  task(3, 'completed', '@Manager'),
  task(2, 'pending', '@Expert'),
  task(1, 'pending', ''),
  task(5, 'started', '@Manager'),
];

describe('TaskBoardComponent', () => {
  let fixture: ComponentFixture<TaskBoardComponent>;
  let nodes$: BehaviorSubject<Node[]>;
  let states$: BehaviorSubject<ReadonlyMap<string, AgentStateValue>>;

  async function mount(): Promise<void> {
    nodes$ = new BehaviorSubject<Node[]>(ROSTER);
    states$ = new BehaviorSubject<ReadonlyMap<string, AgentStateValue>>(new Map());
    await TestBed.configureTestingModule({
      imports: [TaskBoardComponent],
      providers: [
        provideTranslateTesting(),
        { provide: GraphDataService, useValue: { nodes$ } },
        { provide: IngestionService, useValue: { state: { all$: states$ } } },
        { provide: CategoryService, useValue: { COLORS: ['#101010', '#202020'] } },
      ],
    }).compileComponents();
    setTestTranslations(en);
    fixture = TestBed.createComponent(TaskBoardComponent);
    fixture.detectChanges();
  }

  beforeEach(() => localStorage.removeItem(TASK_BOARD_HIDE_CLOSED_KEY));
  afterEach(() => localStorage.removeItem(TASK_BOARD_HIDE_CLOSED_KEY));

  function host(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function text(el: Element | null): string {
    return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  function show(tasks: Record<string, unknown>[]): void {
    states$.next(plan(tasks));
    fixture.detectChanges();
  }

  function ids(): (string | null)[] {
    return Array.from(host().querySelectorAll('.task')).map((r) => r.getAttribute('data-task-id'));
  }

  it('draws nothing with no plan, and nothing for an empty one', async () => {
    await mount();
    expect(host().querySelector('.board')).toBeNull();
    show([]);
    expect(host().querySelector('.board')).toBeNull();
  });

  it('orders the rows by id, whatever their status', async () => {
    await mount();
    show(MIXED);
    expect(ids()).toEqual(['1', '2', '3', '4', '5']);
    expect(text(host().querySelector('.board-label'))).toBe('Tasks 5');
  });

  it('marks each row with one glyph for its status, named for assistive tech', async () => {
    await mount();
    show([...MIXED, task(6, 'blocked', '')]);
    const glyphs = Array.from(host().querySelectorAll('.task-glyph')).map((g) => [
      // Class order is the renderer's, not ours: compare the set.
      [...g.querySelector('i')!.classList]
        .filter((c) => c !== 'glyph')
        .sort()
        .join(' '),
      g.getAttribute('aria-label'),
    ]);
    expect(glyphs).toEqual([
      // Pending: the plain ring, greyed by the stylesheet's glyph-pending.
      ['glyph-pending pi pi-circle', 'pending'],
      ['glyph-pending pi pi-circle', 'pending'],
      ['pi pi-check', 'done'],
      ['pi pi-times', 'aborted'],
      // Started: a still spinner while its owner is idle (see the spin spec).
      ['pi pi-spinner', 'started'],
      // An unknown status: a neutral "?", named as sent.
      ['pi pi-question', 'blocked'],
    ]);
  });

  it('spins a started task only while its owner is processing a message', async () => {
    await mount();
    show([task(1, 'started', '@Manager'), task(2, 'started', '@Expert')]);
    const spinning = (): (string | null)[] =>
      Array.from(host().querySelectorAll('.task'))
        .filter((row) => row.querySelector('.glyph')!.classList.contains('pi-spin'))
        .map((row) => row.getAttribute('data-task-id'));

    // Nobody is working: both started tasks keep a still spinner.
    expect(spinning()).toEqual([]);

    // @Expert picks up a message: only its task spins.
    nodes$.next(ROSTER.map((n) => (n.actorName === '@Expert' ? { ...n, thinking: true } : n)));
    fixture.detectChanges();
    expect(spinning()).toEqual(['2']);

    // Back to idle: the spin stops.
    nodes$.next(ROSTER);
    fixture.detectChanges();
    expect(spinning()).toEqual([]);
  });

  it('is monochrome: no chip anywhere, closed rows muted', async () => {
    await mount();
    show(MIXED);
    expect(host().querySelector('.chip')).toBeNull();
    const closed = Array.from(host().querySelectorAll('.task--closed')).map((r) =>
      r.getAttribute('data-task-id'),
    );
    expect(closed).toEqual(['3', '4']);
  });

  it('heads the card with the title, the count and the toggle — no status summary', async () => {
    await mount();
    show(MIXED);
    const head = host().querySelector('.board-head')!;
    expect(head.querySelector('.board-summary, .summary-item')).toBeNull();
    expect(head.querySelector('.glyph')).toBeNull();
    expect(text(head.querySelector('.board-label'))).toBe('Tasks 5');
    expect(head.querySelector('.board-toggle')).not.toBeNull();
  });

  it('sets each #id with equal space to the glyph and to the description', async () => {
    await mount();
    host().style.display = 'block';
    host().style.width = '320px';
    show([task(1, 'pending', '@Expert'), task(12, 'started', '@Manager')]);

    for (const row of Array.from(host().querySelectorAll('.task'))) {
      const glyph = row.querySelector('.task-glyph')!.getBoundingClientRect();
      const id = row.querySelector('.task-id')!.getBoundingClientRect();
      const description = row.querySelector('.task-description')!.getBoundingClientRect();
      const before = id.left - glyph.right;
      const after = description.left - id.right;
      expect(Math.abs(before - after))
        .withContext(`#${row.getAttribute('data-task-id')}: ${before}px | ${after}px`)
        .toBeLessThanOrEqual(1);
    }
  });

  it('gives the owner mark and the status glyph the arrow cursor, not the hand', async () => {
    await mount();
    show(MIXED);
    const row = host().querySelector('.task[data-task-id="5"]')!;
    expect(getComputedStyle(row.querySelector('.owner-avatar')!).cursor).toBe('default');
    expect(getComputedStyle(row.querySelector('.task-glyph')!).cursor).toBe('default');
    // Neither is a keyboard stop: they only explain themselves on hover.
    expect(row.querySelector('.owner-avatar')!.hasAttribute('tabindex')).toBeFalse();
    expect(row.querySelector('.task-glyph')!.hasAttribute('tabindex')).toBeFalse();
  });

  it('shows the owner as its avatar only, the name in its title and label, at any width', async () => {
    await mount();
    show(MIXED);
    const row = host().querySelector('.task[data-task-id="5"]')!;
    const avatar = row.querySelector('.owner-avatar')!;
    expect(avatar.getAttribute('title')).toBe('Owner: @Manager');
    expect(avatar.getAttribute('aria-label')).toBe('Owner: @Manager');
    // No name anywhere in the row's visible text.
    expect(text(row)).not.toContain('@Manager');
    for (const width of [480, 240]) {
      (host() as HTMLElement).style.width = `${width}px`;
      fixture.detectChanges();
      expect(host().textContent).not.toContain('@Manager');
      expect(host().textContent).not.toContain('@Expert');
    }

    const nobody = host().querySelector('.task[data-task-id="1"] .owner-avatar')!;
    expect(nobody.classList).toContain('owner-avatar--none');
    expect(nobody.getAttribute('title')).toBe('unassigned');
    expect(text(nobody)).toBe('');
  });

  it('"Hide closed" hides done and aborted tasks, and remembers the choice', async () => {
    await mount();
    show(MIXED);
    const toggle = host().querySelector<HTMLButtonElement>('.board-toggle')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    toggle.click();
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(ids()).toEqual(['1', '2', '5']);
    // The header still counts the whole plan.
    expect(text(host().querySelector('.board-label'))).toBe('Tasks 5');
    expect(localStorage.getItem(TASK_BOARD_HIDE_CLOSED_KEY)).toBe('true');

    // A fresh board reads the choice back.
    fixture.destroy();
    TestBed.resetTestingModule();
    await mount();
    show(MIXED);
    expect(ids()).toEqual(['1', '2', '5']);
  });

  it('says "All tasks closed" rather than an empty card when everything is hidden', async () => {
    localStorage.setItem(TASK_BOARD_HIDE_CLOSED_KEY, 'true');
    await mount();
    show([task(1, 'completed', ''), task(2, 'abort', '')]);
    expect(host().querySelector('.board')).not.toBeNull();
    expect(host().querySelector('.board-list')).toBeNull();
    expect(text(host().querySelector('.board-closed'))).toBe('All tasks closed');
  });

  it('follows the plan live as new states arrive', async () => {
    await mount();
    show([task(1, 'pending', '@Expert')]);
    expect(host().querySelector('.task')!.getAttribute('data-status')).toBe('pending');
    show([task(1, 'started', '@Expert')]);
    expect(host().querySelector('.task')!.getAttribute('data-status')).toBe('started');
  });

  it('draws a person owner in the human avatar pair, not an agent colour', async () => {
    await mount();
    show([task(1, 'pending', '@Human'), task(2, 'pending', '@Expert')]);
    const [human, agent] = Array.from(host().querySelectorAll('.owner-avatar'));
    expect(human.classList).toContain('owner-avatar--human');
    expect((human as HTMLElement).style.backgroundColor).toBe('');
    expect(agent.classList).not.toContain('owner-avatar--human');
  });
});
