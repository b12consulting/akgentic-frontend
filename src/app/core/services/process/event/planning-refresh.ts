import {
  asapScheduler,
  catchError,
  concat,
  debounceTime,
  defer,
  distinctUntilChanged,
  EMPTY,
  filter,
  map,
  Observable,
  of,
  subscribeOn,
  switchMap,
} from 'rxjs';

import {
  AkgenticMessage,
  isEventMessage,
  isStartMessage,
  isToolReturnEvent,
} from '../../../protocol/message.types';

/**
 * The planning actor's name, as the tool declares it
 * (`akgentic.tool.planning.planning.PLANNING_ACTOR_NAME`). It lives in this
 * tier because the planning refresh resolves the actor's id from it, and the
 * event tier may not import a selector; `selectors/task-board.ts` re-exports it.
 */
export const PLANNING_ACTOR_NAME = '#PlanningTool';

/**
 * The planning tool's write, as the LLM sees it: `PlanningTool.get_tools()` in
 * akgentic-tool (`planning/planning.py`) exposes it under its Python function
 * name. Create, update and delete all go through this one tool.
 */
export const PLANNING_UPDATE_TOOL = 'update_planning';

/**
 * How long a burst of planning writes is allowed to settle before ONE refetch.
 * An agent that edits several tasks in a row returns several times within a
 * few hundred ms; the board only needs the state after the last one.
 */
export const PLANNING_REFRESH_DEBOUNCE_MS = 300;

/**
 * A completed, successful `update_planning` call. The return is emitted by the
 * CALLING agent, not by the planning actor, so the sender is not checked. A
 * `success: false` return is a retry prompt and changed nothing.
 */
export function isPlanningUpdateReturn(msg: AkgenticMessage): boolean {
  if (!isEventMessage(msg)) return false;
  // Bound to the guard's loose parameter type so `EventMessage.event`'s `any`
  // does not propagate into this module.
  const inner: { __model__?: string } | null | undefined = msg.event;
  return (
    isToolReturnEvent(inner) &&
    inner.tool_name === PLANNING_UPDATE_TOOL &&
    inner.success === true
  );
}

/**
 * The planning actor's agent id, read from the roster the log already holds:
 * the `StartMessage` whose sender is `#PlanningTool`. The same pair the graph
 * builds its nodes from (`name: sender.agent_id`, `actorName: sender.name`),
 * resolved here rather than imported, since the event tier may not reach the
 * graph selector. `null` while the team has no planning actor.
 */
export function findPlanningActorId(
  log: readonly AkgenticMessage[],
): string | null {
  for (const m of log) {
    if (
      isStartMessage(m) &&
      m.sender?.name === PLANNING_ACTOR_NAME &&
      m.sender.agent_id
    ) {
      return m.sender.agent_id;
    }
  }
  return null;
}

/**
 * The planning actor's id, once per distinct value. Fed the WHOLE log
 * (`MessageLogService.log$`), never the delta: on a stopped team the actor's
 * `StartMessage` arrives in the REST replay, appended before the caller
 * subscribes, and only the log's current value still carries it.
 */
export function planningActorId(
  log$: Observable<readonly AkgenticMessage[]>,
): Observable<string> {
  return log$.pipe(
    map(findPlanningActorId),
    filter((id: string | null): id is string => id !== null),
    distinctUntilChanged(),
  );
}

/**
 * The live task board's source: fetch the PLANNING ACTOR's state — and only
 * its — when the actor appears, and again whenever the log shows a planning
 * write completed.
 *
 * Why a fetch at all: the planning actor publishes its new state as a
 * `StateChangedMessage`, and the stream subscribers suppress that message, so
 * nothing else ever reaches `ProcessStores.state`. The tool RETURN is streamed,
 * and it is the moment the write is known to be done:
 * `PlanActor.update_planning` notifies before it returns.
 *
 * The id GATES the writes. Until it is known nothing is fetched and no write is
 * queued; its arrival fetches at once, and that fetch already reflects every
 * earlier write. The fetch id is always the planning actor's — the write's
 * sender is the CALLING agent and is never read.
 *
 * The write listener opens one microtask AFTER the id arrives. Fed from
 * `MessageLogService`, the id comes off `log$`, which emits a batch BEFORE
 * `appended$` hands out the same batch; listening at once would count that
 * batch's writes — already reflected in the arrival fetch — and fetch twice.
 *
 * Emits the fetched messages; the CALLER appends them, so the latest-wins
 * `state` fold overwrites the stale entry. `debounceTime` coalesces a burst of
 * writes into one fetch; `switchMap` drops an in-flight response when a newer
 * one is requested, so an older snapshot can never land after a newer one. A
 * failed fetch is logged and swallowed INSIDE the switch: an error escaping it
 * would end the subscription for the rest of the cycle, and the board would
 * silently go stale again.
 *
 * Unsubscribing drops both a pending debounce and an in-flight response, which
 * is what makes a team switch safe: the caller holds the subscription in the
 * cycle bag that every `init()` / `close()` disposes.
 */
export function planningRefresh(
  planningId$: Observable<string>,
  messages$: Observable<AkgenticMessage>,
  fetchStates: (agentId: string) => Promise<AkgenticMessage[]>,
): Observable<AkgenticMessage[]> {
  return planningId$.pipe(
    switchMap((agentId: string) =>
      concat(
        of(null),
        messages$.pipe(
          subscribeOn(asapScheduler),
          filter(isPlanningUpdateReturn),
          debounceTime(PLANNING_REFRESH_DEBOUNCE_MS),
        ),
      ).pipe(
        switchMap(() =>
          defer(() => fetchStates(agentId)).pipe(
            catchError((err: unknown) => {
              console.error('Planning state refresh failed:', err);
              return EMPTY;
            }),
          ),
        ),
      ),
    ),
  );
}
