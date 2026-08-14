import { inject, Injectable } from '@angular/core';

import {
  ActorAddress,
  AkgenticMessage,
  StateChangedMessage,
} from '../../../protocol/message.types';
import {
  AgentStateResponse,
  EventResponse,
} from '../../../core/context/team.interface';
import { ApiService } from '../../../core/http/api.service';

/**
 * Story 25-1 (ADR-020 §2): build a synthesized `StateChangedMessage` from one
 * `AgentStateResponse` snapshot so `stateSpec` (`match: isStateChangedMessage`,
 * default key `sender.agent_id`, value `{ schema: {}, state }`) folds it into
 * the `state` store. Only `sender.agent_id` (the agent UUID, team Epic 23) and
 * `state` are read by the fold; the other type-required `BaseMessage` /
 * `ActorAddress` fields are inert placeholders. `id` is left empty so
 * `MessageLogService.appendAll` never dedups one seeded entry against another
 * (dedup only applies to truthy ids); `state` is treated as
 * `Record<string, unknown>` exactly as `EventResponse.event` is treated as
 * `AkgenticMessage` — no broad `any` cast beyond the state payload.
 */
function synthesizeStateChanged(snapshot: AgentStateResponse): StateChangedMessage {
  const sender: ActorAddress = {
    __actor_address__: true,
    agent_id: snapshot.agent_id,
    name: snapshot.name ?? '',
    role: '',
    squad_id: '',
    user_message: false,
  };
  return {
    id: '',
    parent_id: null,
    team_id: '',
    timestamp: snapshot.updated_at,
    sender,
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StateChangedMessage',
    state: snapshot.state,
  };
}

/**
 * `ReplaySeeder` — the REST replay SOURCE (Epic 34 / ADR-025 §0-§1). It owns
 * both calls that reconstruct a stopped team's history — `getAgentStates` and
 * `getEvents` — and turns each into `AkgenticMessage[]`.
 *
 * It PRODUCES messages and appends nothing. `MessageLogService` is deliberately
 * NOT injected: the two `log.appendAll` calls stay in `IngestionService.init()`
 * because they are two of the four centrally sequenced steps
 * (dispose → reset → seed → open socket, ADR-005 §Decision 6), and burying one
 * inside an unsequenced unit is exactly the erosion ADR-025 §2 exists to
 * prevent. The payoff is that this whole path specs against a fake `ApiService`
 * with no WebSocket, no log and no toast harness.
 *
 * A source, so it holds NOTHING between calls — no cache, no cursor, no flag.
 * Two identical `seedMessages(id)` calls must produce two identical results.
 *
 * No `start` / `stop` / `ngOnDestroy`, and nothing self-wired in the
 * constructor: the two methods ARE the explicit invocation points ADR-025 §2
 * asks for. There is no subscription here whose opening moment DI could decide
 * — just two awaited calls the orchestrator sequences. What the rule forbids,
 * and what must never be added, is a constructor or field initializer that
 * fires either REST call.
 *
 * Component-scoped (`@Injectable()` with no `providedIn`), provided on
 * `ProcessComponent` before `IngestionService`, matching every other unit in
 * this folder.
 */
@Injectable()
export class ReplaySeeder {
  private readonly api: ApiService = inject(ApiService);

  /**
   * Story 25-1 (ADR-020 §2): fetch per-agent state snapshots and shape them as
   * synthesized `StateChangedMessage` entries, so appending them lets the
   * registry's `stateSpec` fold them into the `state` store exactly as it folds
   * live WS frames.
   *
   * The `!running` gate that decides whether this runs at all now lives in the
   * CALLER (`IngestionService.init()`, inside its `if (!running)` block), not
   * here: this unit has no knowledge of team status. The gate matters because a
   * running — including a freshly restored, team Story 23-3 — team already
   * receives its `StateChangedMessage`(s) on the cursor-0 WS replay, which makes
   * the REST seed redundant there and `getAgentStates` a call that MUST NOT be
   * issued for it.
   *
   * An empty snapshot list simply returns `[]`; the caller's `appendAll([])` is
   * a no-op (`message-log.service.ts`), so no early-return guard is needed.
   */
  async seedMessages(processId: string): Promise<AkgenticMessage[]> {
    const states: AgentStateResponse[] = await this.api.getAgentStates(processId);
    return states.map((s) => synthesizeStateChanged(s));
  }

  /**
   * Story 6.4 / Epic 17 (ADR-014 §Decision 3): unwrap the durable event log
   * into the replay tail the registry folds exactly as it folds live WS frames.
   *
   * BOTH halves of the filter are load-bearing. `er.event as AkgenticMessage`
   * types the payload as non-nullable, which makes `!!evt` read as dead code to
   * the type-checker — it is not: the cast is a lie about wire data and the
   * guard is what makes it safe. `!!evt.__model__` drops any payload with no
   * discriminator, which nothing downstream could classify.
   */
  async replayMessages(processId: string): Promise<AkgenticMessage[]> {
    const eventResponses: EventResponse[] = await this.api.getEvents(processId);
    return eventResponses
      .map((er: EventResponse) => er.event as AkgenticMessage)
      .filter((evt) => !!evt && !!evt.__model__);
  }
}
