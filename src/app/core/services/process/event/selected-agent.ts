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
 * The Member panel's source: fetch the selected member's state on every
 * selection. No cache — re-selecting re-fetches — and an unselect fetches
 * nothing. `switchMap` drops a response a newer selection has superseded; a
 * failed fetch is logged and swallowed INSIDE the switch, so the next selection
 * still fetches.
 *
 * Emits the fetched messages; the caller appends them and holds the
 * subscription in its cycle bag, so a team switch drops an in-flight response.
 */
export function selectionFetch(
  selected$: Observable<string | null>,
  fetchStates: (agentId: string) => Promise<AkgenticMessage[]>,
): Observable<AkgenticMessage[]> {
  return selected$.pipe(
    filter((id: string | null): id is string => !!id),
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
