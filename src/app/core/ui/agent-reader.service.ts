import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

/** The identity a caller needs to move the app's selection to an agent. */
export interface AgentRef {
  /** `agent_id` — the key `AkgentService`/`SelectionService` select by. */
  agentId: string;
  /**
   * The RAW actor name, carried alongside the id because selection stores both
   * AND because the reader's composer addresses the actor by name in the URL
   * path (`/teams/{id}/message/{actorName}`). It is deliberately not the
   * friendly label: `makeAgentNameUserFriendly` is lossy, so a label cannot be
   * turned back into something the API will route on.
   */
  actorName: string;
}

/**
 * "Open the sub-agent reader on this agent" — the one bit a caller outside the
 * chat panel cannot reach.
 *
 * WHY A SERVICE AND NOT AN INPUT. The dialog is hosted inside
 * `ChatPanelComponent` because it is bound to that panel's message log, while
 * the places a user naturally asks for it from — the inspector's member cards —
 * live under `ProcessComponent`, a sibling on the far side of the split.
 * Lifting the dialog would drag the log with it; a second instance would give
 * two dialogs over the same messages with divergent expansion state. So exactly
 * one bit travels, and only that one: WHICH agent still goes through the app's
 * single `SelectionService` / `AkgentService` path, which the reader reads
 * back. That is what keeps the reader and the right-hand panel from ever
 * pointing at two different agents.
 *
 * THERE IS EXACTLY ONE OF THESE. An earlier round grew a second, near-identical
 * launcher on the inspector side; two services meant the asking control and the
 * listening host were talking past each other and the button did nothing at
 * all. Anything that wants to open the reader injects THIS — do not add a
 * parallel stream for a new caller.
 *
 * Callers: `agentReader.open({ agentId, actorName })`. Root-provided, so any
 * component can inject it without a provider of its own.
 */
@Injectable({ providedIn: 'root' })
export class AgentReaderService {
  private readonly requests = new Subject<AgentRef>();

  /**
   * Emits once per request to open the reader.
   *
   * A `Subject`, not a `BehaviorSubject`: this is an EVENT ("show it now"), and
   * a replayed last value would re-open the dialog on every fresh subscription
   * — including right after the user closed it, and on a route they have since
   * navigated away from.
   */
  readonly open$: Observable<AgentRef> = this.requests.asObservable();

  /**
   * Ask for the reader, on `agent`.
   *
   * A blank `agentId` is DROPPED rather than forwarded. The reader resolves the
   * agent by id and falls back to its "select an agent" state when it cannot;
   * forwarding an empty id would put an agent-less dialog over the team the
   * user was looking at, which is strictly worse than the click appearing to do
   * nothing.
   *
   * Asking for the same agent twice fires twice, deliberately: the user opens
   * @Expert, reads, dismisses, clicks @Expert again. Anything that de-duplicated
   * consecutive identical requests would make that second click do nothing, and
   * "the button worked once" is the worst kind of broken.
   */
  open(agent: AgentRef): void {
    if (agent.agentId.trim().length === 0) {
      return;
    }
    this.requests.next(agent);
  }
}
