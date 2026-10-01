import { ActorAddress } from '../../../protocol/message.types';
import { HUMAN_ROLE } from './actor-kind';
import {
  descendants,
  isHumanSeat,
  Run,
  RunGraph,
  RunKey,
  runStatus,
  traceRootOf,
} from './run-graph.selector';

/**
 * The trace card header (Epic 55, ADR-037 §D8), as data.
 *
 * Pure and i18n-free: it returns counts, agents and a title KIND, and the
 * component picks the translation key. Nothing here reads the clock — a
 * running trace has `end === null`, and nothing ticks in the header.
 */

/** Which of the four §D8 header states applies, first match wins. */
export type TraceTitleKind = 'waiting' | 'running' | 'doneMany' | 'doneOne';

export interface TraceSummary {
  root: RunKey;
  /** Distinct by `agent_id`, in start order; the root's agent is first. */
  agents: ActorAddress[];
  runCount: number;
  /** Tool steps across every run of the trace. */
  toolCount: number;
  start: Date;
  /** The latest `end`, or `null` while any run is `running`. */
  end: Date | null;
  runningCount: number;
  /** The agent of the first seat run whose status is `waiting`. */
  waitingOn: ActorAddress | null;
  title: TraceTitleKind;
  /** `running` only: the agent of the most recently started running run. */
  activeAgent: ActorAddress | null;
  /** `running` only: that run's latest tool step, or `null` when it has none. */
  activeTool: string | null;
}

/** `@Human` receiving a message opens a run of its own. It is a view rule, not
 *  a fold rule, that such a run is never counted or drawn (ADR-037 §D5). */
export function isEntryPointRun(run: Run): boolean {
  return run.agent.role === HUMAN_ROLE && !isHumanSeat(run);
}

/** The runs a trace card counts: the root and every descendant still in its
 *  trace (a reply of yours further down opens its own), minus entry-point runs.
 *  Seats stay in. In start order. */
export function traceRuns(graph: RunGraph, root: RunKey): Run[] {
  const rootRun = graph.runs.get(root);
  if (rootRun === undefined) return [];
  const out: Run[] = [];
  for (const key of [root, ...descendants(graph, root)]) {
    const run = graph.runs.get(key);
    if (run === undefined || isEntryPointRun(run)) continue;
    if (key !== root && traceRootOf(graph, key) !== root) continue;
    out.push(run);
  }
  return out;
}

/** The seats among `runs` that have not answered yet, in start order. */
function waitingAmong(graph: RunGraph, runs: readonly Run[]): Run[] {
  return runs.filter((run) => isHumanSeat(run) && runStatus(graph, run.key) === 'waiting');
}

/** The waiting seats of the trace rooted at `root`, in start order. The one
 *  definition behind the header's "Waiting for @X" and the path a card reveals
 *  when it opens (ADR-037 §D4, §D6). */
export function waitingSeats(graph: RunGraph, root: RunKey): Run[] {
  return waitingAmong(graph, traceRuns(graph, root));
}

function distinctAgents(runs: readonly Run[]): ActorAddress[] {
  const seen = new Map<string, ActorAddress>();
  for (const run of runs) {
    if (!seen.has(run.agent.agent_id)) seen.set(run.agent.agent_id, run.agent);
  }
  return [...seen.values()];
}

function latestTool(run: Run): string | null {
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const step = run.steps[i];
    if (step.kind === 'tool') return step.tool_name;
  }
  return null;
}

function latestEnd(runs: readonly Run[]): Date | null {
  let end: Date | null = null;
  for (const run of runs) {
    if (run.end !== null && (end === null || run.end.getTime() > end.getTime())) {
      end = run.end;
    }
  }
  return end;
}

function titleOf(
  waitingOn: ActorAddress | null,
  runningCount: number,
  agentCount: number,
): TraceTitleKind {
  // `waiting` outranks `running`: it is a call to action, and while the card
  // is collapsed the header is the only place it shows (ADR-037 §D4).
  if (waitingOn !== null) return 'waiting';
  if (runningCount > 0) return 'running';
  return agentCount > 1 ? 'doneMany' : 'doneOne';
}

/** The header of the trace rooted at `root`, or `null` for an unknown root. */
export function traceSummary(graph: RunGraph, root: RunKey): TraceSummary | null {
  const runs = traceRuns(graph, root);
  if (runs.length === 0) return null;
  const statuses = runs.map((run) => runStatus(graph, run.key));
  const running = runs.filter((_, i) => statuses[i] === 'running');
  const agents = distinctAgents(runs);
  const waitingOn = waitingAmong(graph, runs)[0]?.agent ?? null;
  const active = running.length > 0 ? running[running.length - 1] : null;
  return {
    root,
    agents,
    runCount: runs.length,
    toolCount: runs.reduce(
      (n, run) => n + run.steps.filter((s) => s.kind === 'tool').length,
      0,
    ),
    start: runs[0].start,
    end: running.length > 0 ? null : latestEnd(runs),
    runningCount: running.length,
    waitingOn,
    title: titleOf(waitingOn, running.length, agents.length),
    activeAgent: active?.agent ?? null,
    activeTool: active ? latestTool(active) : null,
  };
}

/** `end − start` as a compact, language-neutral duration: `42s`, `3m 05s`,
 *  `1h 07m`. `null` when either end is missing. */
export function traceDuration(start: Date, end: Date | null): string | null {
  if (end === null) return null;
  const total = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  if (!Number.isFinite(total)) return null;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${pad(total % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}
