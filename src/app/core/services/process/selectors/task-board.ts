import { AgentStateValue } from '../event/per-agent-specs';
import { PLANNING_ACTOR_NAME } from '../event/planning-refresh';

/**
 * The team's task board, read from the planning tool's own state.
 *
 * NO BACKEND CHANGE. The planning tool runs as an actor named `#PlanningTool`
 * (`akgentic.tool.planning.planning.PLANNING_ACTOR_NAME`), and its state
 * `PlanManagerState { task_list: Task[] }` is published as a
 * `StateChangedMessage` on every change. `ProcessStores.state` already keeps
 * the latest state per agent — live and on replay — keyed by `agent_id`, so
 * the board is a projection of two things the console already holds: the
 * roster (to find the actor's id by its NAME) and that store.
 *
 * Pure: no i18n, no Angular. The wire is untrusted, so every field is read
 * through a guard and a task without an `id` and `status` is dropped rather
 * than drawn half-empty.
 */

// The planning actor's name lives in the event tier, which needs it to find
// the actor's id and may not import a selector. Re-exported, one definition.
export { PLANNING_ACTOR_NAME };

/**
 * The statuses `planning_actor.py` declares (`TaskStatus`). Note `abort`, not
 * `aborted`: that is the wire value.
 * Anything else is drawn as an unknown status rather than dropped.
 */
export const TASK_STATUSES = ['pending', 'started', 'completed', 'abort'] as const;
export type KnownTaskStatus = (typeof TASK_STATUSES)[number];

/** Done or abandoned: what "Hide closed" hides. */
export function isClosedTask(task: Pick<PlanTask, 'status'>): boolean {
  return task.status === 'completed' || task.status === 'abort';
}

/** One task, as `planning_actor.Task` serialises it. */
export interface PlanTask {
  id: number;
  /** A `KnownTaskStatus`, or whatever else the wire says. */
  status: string;
  description: string;
  /** An agent name (`@Expert`), or `''` when unassigned. */
  owner: string;
  creator: string;
  dependencies: number[];
  output: string;
  /** ISO timestamp, as sent. */
  updated_at: string;
}

/** The roster fields the lookup needs: the actor's display name and its id. */
export interface PlanningRosterNode {
  actorName: string;
  name: string;
}

export function isKnownTaskStatus(status: string): status is KnownTaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(status);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseTask(value: unknown): PlanTask | null {
  const raw = asRecord(value);
  if (raw === null || typeof raw['id'] !== 'number' || typeof raw['status'] !== 'string') {
    return null;
  }
  const dependencies = Array.isArray(raw['dependencies'])
    ? raw['dependencies'].filter((d): d is number => typeof d === 'number')
    : [];
  return {
    id: raw['id'],
    status: raw['status'],
    description: asString(raw['description']),
    owner: asString(raw['owner']),
    creator: asString(raw['creator']),
    dependencies,
    output: asString(raw['output']),
    updated_at: asString(raw['updated_at']),
  };
}

/** The tasks in a planning state, parsed, by id — the order the plan was
 *  made in, which a status never reshuffles. `[]` for anything that is not a
 *  `{ task_list: [...] }`. */
export function parseTaskList(state: unknown): PlanTask[] {
  const list = asRecord(state)?.['task_list'];
  if (!Array.isArray(list)) return [];
  return list
    .map(parseTask)
    .filter((task): task is PlanTask => task !== null)
    .sort((a, b) => a.id - b.id);
}

/**
 * The board's tasks: the planning actor found by NAME on the roster, its
 * latest state read from the per-agent store by its id. `[]` when there is no
 * planning actor, no state yet, or no tasks.
 */
export function planningTasks(
  nodes: readonly PlanningRosterNode[],
  states: ReadonlyMap<string, AgentStateValue>,
): PlanTask[] {
  const actor = nodes.find((node) => node.actorName === PLANNING_ACTOR_NAME);
  if (actor === undefined) return [];
  return parseTaskList(states.get(actor.name)?.state);
}

