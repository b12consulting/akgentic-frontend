import { AgentStateValue } from '../event/per-agent-specs';
import {
  parseTaskList,
  PLANNING_ACTOR_NAME,
  planningTasks,
  taskStatusCounts,
} from './task-board';

function task(id: number, status: string, owner = '@Expert'): Record<string, unknown> {
  return {
    id,
    status,
    description: `task ${id}`,
    owner,
    creator: '@Manager',
    dependencies: [],
    output: '',
    updated_at: '2026-09-30T10:00:00Z',
  };
}

function states(entries: [string, unknown][]): ReadonlyMap<string, AgentStateValue> {
  return new Map(entries.map(([id, state]) => [id, { schema: {}, state }]));
}

const ROSTER = [
  { actorName: '@Manager', name: 'manager-id' },
  { actorName: PLANNING_ACTOR_NAME, name: 'planning-id' },
];

describe('task board selector', () => {
  it('finds the planning actor by NAME and reads its tasks from the state store', () => {
    const tasks = planningTasks(
      ROSTER,
      states([['planning-id', { task_list: [task(1, 'pending'), task(2, 'started')] }]]),
    );
    expect(tasks.map((t) => [t.id, t.status])).toEqual([
      [2, 'started'],
      [1, 'pending'],
    ]);
    expect(tasks[0]).toEqual({
      id: 2,
      status: 'started',
      description: 'task 2',
      owner: '@Expert',
      creator: '@Manager',
      dependencies: [],
      output: '',
      updated_at: '2026-09-30T10:00:00Z',
    });
  });

  it('ignores every other actor\'s state, even one shaped like a plan', () => {
    const tasks = planningTasks(
      ROSTER,
      states([['manager-id', { task_list: [task(9, 'pending')] }]]),
    );
    expect(tasks).toEqual([]);
  });

  it('is empty with no planning actor, no state yet, or no tasks', () => {
    const plan = states([['planning-id', { task_list: [task(1, 'pending')] }]]);
    expect(planningTasks([{ actorName: '@Manager', name: 'manager-id' }], plan)).toEqual([]);
    expect(planningTasks(ROSTER, states([]))).toEqual([]);
    expect(planningTasks(ROSTER, states([['planning-id', { task_list: [] }]]))).toEqual([]);
  });

  it('orders started → pending → completed → abort → unknown, then by id', () => {
    const tasks = parseTaskList({
      task_list: [
        task(5, 'abort'),
        task(4, 'completed'),
        task(7, 'blocked'),
        task(3, 'pending'),
        task(1, 'pending'),
        task(6, 'started'),
      ],
    });
    expect(tasks.map((t) => t.id)).toEqual([6, 1, 3, 4, 5, 7]);
  });

  it('drops a malformed task rather than drawing half of it, and fills optional fields', () => {
    const tasks = parseTaskList({
      task_list: [{ status: 'pending' }, { id: 2, status: 'pending' }, 'junk'],
    });
    expect(tasks).toEqual([
      {
        id: 2,
        status: 'pending',
        description: '',
        owner: '',
        creator: '',
        dependencies: [],
        output: '',
        updated_at: '',
      },
    ]);
    expect(parseTaskList(null)).toEqual([]);
    expect(parseTaskList({ task_list: 'nope' })).toEqual([]);
  });

  it('counts each status once, in board order, skipping the empty ones', () => {
    const tasks = parseTaskList({
      task_list: [task(1, 'pending'), task(2, 'pending'), task(3, 'completed'), task(4, 'started')],
    });
    expect(taskStatusCounts(tasks)).toEqual([
      { status: 'started', count: 1 },
      { status: 'pending', count: 2 },
      { status: 'completed', count: 1 },
    ]);
  });
});
