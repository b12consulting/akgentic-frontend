import {
  catchError,
  debounceTime,
  defer,
  EMPTY,
  filter,
  Observable,
  switchMap,
} from 'rxjs';

import {
  AkgenticMessage,
  isEventMessage,
  isToolReturnEvent,
} from '../../../protocol/message.types';

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
 * The live task board's source: re-read the agent states whenever the log
 * shows a planning write completed.
 *
 * Why a refetch at all: the planning actor publishes its new state as a
 * `StateChangedMessage`, and the stream subscribers suppress that message (see
 * step (c) of `IngestionService.init()`), so after the open-time seed nothing
 * else ever reaches `ProcessStores.state`. The tool RETURN is streamed, and it
 * is the moment the write is known to be done: `PlanActor.update_planning`
 * notifies before it returns.
 *
 * Emits the fetched messages; the CALLER appends them, exactly as it appends
 * the open-time seed, so the latest-wins `state` fold overwrites the stale
 * entry. `debounceTime` coalesces a burst into one fetch; `switchMap` drops an
 * in-flight response when a newer one is requested, so an older snapshot can
 * never land after a newer one. A failed fetch is logged and swallowed INSIDE
 * the switch: an error escaping it would end the subscription for the rest of
 * the cycle, and the board would silently go stale again.
 *
 * Unsubscribing drops both a pending debounce and an in-flight response, which
 * is what makes a team switch safe: the caller holds the subscription in the
 * cycle bag that every `init()` / `close()` disposes.
 */
export function planningRefresh(
  messages$: Observable<AkgenticMessage>,
  fetchStates: () => Promise<AkgenticMessage[]>,
): Observable<AkgenticMessage[]> {
  return messages$.pipe(
    filter(isPlanningUpdateReturn),
    debounceTime(PLANNING_REFRESH_DEBOUNCE_MS),
    switchMap(() =>
      defer(fetchStates).pipe(
        catchError((err: unknown) => {
          console.error('Planning state refresh failed:', err);
          return EMPTY;
        }),
      ),
    ),
  );
}
