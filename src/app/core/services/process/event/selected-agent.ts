import { InjectionToken } from '@angular/core';
import {
  catchError,
  defer,
  EMPTY,
  filter,
  Observable,
  switchMap,
} from 'rxjs';

import { AkgenticMessage } from '../../../protocol/message.types';

/**
 * The selected member's agent id, `null` when none is selected.
 *
 * A token rather than `AkgentService` itself because the event tier may not
 * import the `services` tier. `PROCESS_PROVIDERS` binds it to
 * `AkgentService.selectedAkgent$`, a `BehaviorSubject`, so a subscriber
 * receives the current selection at once. Deliberately no root default: a
 * missing provider must fail at injection, not silently lose every member's
 * backstory.
 */
export const SELECTED_AGENT_ID = new InjectionToken<Observable<string | null>>(
  'SELECTED_AGENT_ID',
);

/**
 * The Member panel's source: fetch the selected member's state once per agent
 * per team cycle. A selection for which `isKnown` holds — its state is already
 * in the `state` store — fetches nothing, and an unselect fetches nothing. The
 * store is the record: it is cleared on every team switch, and a fetch that
 * returned no snapshot (or was cancelled) leaves it empty, so the next
 * selection of that agent fetches again. The planning actor is kept fresh by
 * `planningRefresh`, not here.
 *
 * `switchMap` drops a response a newer selection has superseded; a failed
 * fetch is logged and swallowed INSIDE the switch, so the next selection still
 * fetches.
 *
 * Emits the fetched messages; the caller appends them and holds the
 * subscription in its cycle bag, so a team switch drops an in-flight response.
 */
export function selectionFetch(
  selected$: Observable<string | null>,
  fetchStates: (agentId: string) => Promise<AkgenticMessage[]>,
  isKnown: (agentId: string) => boolean,
): Observable<AkgenticMessage[]> {
  return selected$.pipe(
    filter((id: string | null): id is string => !!id),
    filter((id: string) => !isKnown(id)),
    switchMap((agentId: string) =>
      defer(() => fetchStates(agentId)).pipe(
        catchError((err: unknown) => {
          console.error('Selected agent state fetch failed:', err);
          return EMPTY;
        }),
      ),
    ),
  );
}
