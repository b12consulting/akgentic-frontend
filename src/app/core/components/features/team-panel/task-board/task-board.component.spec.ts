import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { CategoryService } from '../../../../services/category.service';
import { IngestionService } from '../../../../services/process/event/ingestion.service';
import { AgentStateValue } from '../../../../services/process/event/per-agent-specs';
import { GraphDataService } from '../../../../services/process/selectors/graph.selector';
import { PLANNING_ACTOR_NAME } from '../../../../services/process/selectors/task-board';
import { provideTranslateTesting } from '../../../../../../testing/i18n-testing';
import { TaskBoardComponent } from './task-board.component';

type Node = { actorName: string; name: string; role: string };

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

describe('TaskBoardComponent', () => {
  let fixture: ComponentFixture<TaskBoardComponent>;
  let nodes$: BehaviorSubject<Node[]>;
  let states$: BehaviorSubject<ReadonlyMap<string, AgentStateValue>>;

  beforeEach(async () => {
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
    fixture = TestBed.createComponent(TaskBoardComponent);
    fixture.detectChanges();
  });

  function host(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function text(el: Element | null): string {
    return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  it('draws nothing with no plan, and nothing for an empty one', () => {
    expect(host().querySelector('.board')).toBeNull();
    states$.next(plan([]));
    fixture.detectChanges();
    expect(host().querySelector('.board')).toBeNull();
  });

  it('draws a row per task, started → pending → completed → aborted, then by id', () => {
    states$.next(
      plan([
        task(4, 'abort', '@Expert'),
        task(3, 'completed', '@Manager'),
        task(2, 'pending', '@Expert'),
        task(1, 'pending', ''),
        task(5, 'started', '@Manager'),
      ]),
    );
    fixture.detectChanges();

    const rows = Array.from(host().querySelectorAll('.task'));
    expect(rows.map((r) => r.getAttribute('data-task-id'))).toEqual(['5', '1', '2', '3', '4']);
    expect(text(host().querySelector('.board-label'))).toBe('inspector.tasks.title 5');

    const [started, unassigned, , done, aborted] = rows;
    expect(text(started.querySelector('.task-id'))).toBe('#5');
    expect(text(started.querySelector('.chip'))).toBe('inspector.tasks.status.started');
    expect(started.querySelector('.chip')!.getAttribute('data-tone')).toBe('started');
    expect(text(started.querySelector('.owner-name'))).toBe('@Manager');
    expect(text(started.querySelector('.owner-avatar'))).toBe('M');
    // The full description rides on `title`; the row ellipsises it.
    expect(started.querySelector('.task-description')!.getAttribute('title')).toContain('task 5');
    expect(text(unassigned.querySelector('.task-owner'))).toBe('inspector.tasks.unassigned');
    // Settled work reads muted; open work does not.
    expect(done.classList).toContain('task--settled');
    expect(aborted.classList).toContain('task--settled');
    expect(started.classList).not.toContain('task--settled');
  });

  it('sums the statuses in one line of chips, in board order', () => {
    states$.next(
      plan([
        task(1, 'pending', ''),
        task(2, 'pending', ''),
        task(3, 'started', ''),
        task(4, 'completed', ''),
        task(5, 'abort', ''),
      ]),
    );
    fixture.detectChanges();

    expect(Array.from(host().querySelectorAll('.board-summary .chip')).map(text)).toEqual([
      '1 inspector.tasks.status.started',
      '2 inspector.tasks.status.pending',
      '1 inspector.tasks.status.completed',
      '1 inspector.tasks.status.abort',
    ]);
  });

  it('shows an unknown status as sent, on a neutral chip', () => {
    states$.next(plan([task(1, 'blocked', '')]));
    fixture.detectChanges();
    const chip = host().querySelector('.task .chip')!;
    expect(text(chip)).toBe('blocked');
    expect(chip.getAttribute('data-tone')).toBe('unknown');
  });

  it('follows the plan live as new states arrive', () => {
    states$.next(plan([task(1, 'pending', '@Expert')]));
    fixture.detectChanges();
    expect(host().querySelector('.task .chip')!.getAttribute('data-tone')).toBe('pending');

    states$.next(plan([task(1, 'started', '@Expert')]));
    fixture.detectChanges();
    expect(host().querySelector('.task .chip')!.getAttribute('data-tone')).toBe('started');
  });

  it('draws a person owner in the human avatar pair, not an agent colour', () => {
    states$.next(plan([task(1, 'pending', '@Human'), task(2, 'pending', '@Expert')]));
    fixture.detectChanges();
    const [human, agent] = Array.from(host().querySelectorAll('.owner-avatar'));
    expect(human.classList).toContain('owner-avatar--human');
    expect((human as HTMLElement).style.backgroundColor).toBe('');
    expect(agent.classList).not.toContain('owner-avatar--human');
  });
});
