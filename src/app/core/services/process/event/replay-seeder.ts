import { inject, Injectable } from '@angular/core';

import {
  ActorAddress,
  AkgenticMessage,
  StateChangedMessage,
} from '../../../protocol/message.types';
import {
  AgentStateResponse,
  EventResponse,
} from '../../../platform/context/team.interface';
import { ApiService } from '../../../platform/http/api.service';

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
 * the two REST reads the ingestion layer folds — `getEvents`, which
 * reconstructs a stopped team's history, and `getAgentStates`, the per-agent
 * state read (Epic 56) — and turns each into `AkgenticMessage[]`.
 *
 * It PRODUCES messages and appends nothing. `MessageLogService` is deliberately
 * NOT injected: every `log.appendAll` of what it returns stays in
 * `IngestionService.init()` — the event replay because it is one of the four
 * centrally sequenced steps (dispose → reset → replay → open socket, ADR-005
 * §Decision 6), the per-agent reads because their subscriptions live in that
 * cycle's bag. Burying either inside an unsequenced unit is exactly the
 * erosion ADR-025 §2 exists to prevent. The payoff is that this whole path
 * specs against a fake `ApiService` with no WebSocket, no log and no toast
 * harness.
 *
 * A source, so it holds NOTHING between calls — no cache, no cursor, no flag.
 * Two identical `seedMessages(id, agentId)` calls must produce two identical
 * results.
 *
 * No `start` / `stop` / `ngOnDestroy`, and nothing self-wired in the
 * constructor: the two methods ARE the explicit invocation points ADR-025 §2
 * asks for. There is no subscription here whose opening moment DI could decide
 * — just awaited calls the orchestrator drives. What the rule forbids,
 * and what must never be added, is a constructor or field initializer that
 * fires either REST call.
 *
 * Component-scoped (`@Injectable()` with no `providedIn`), provided on
 * the `process/:id` route before `IngestionService`, matching every other unit in
 * this folder.
 */
@Injectable()
export class ReplaySeeder {
  private readonly api: ApiService = inject(ApiService);

  /**
   * Story 25-1 (ADR-020 §2) / Epic 56 (ADR-038 D5): fetch ONE agent's state
   * snapshot and shape it as a synthesized `StateChangedMessage`, so appending
   * it lets the registry's `stateSpec` fold it into the `state` store exactly
   * as it folds live WS frames.
   *
   * Called per agent, never at team open: by the planning refresh (the planning
   * actor, on appearance and after each write) and by the selection fetch (the
   * selected member), both held in `IngestionService.init()`'s cycle bag. An
   * older server ignores `agentId` and answers with every snapshot; all of them
   * are returned — the latest-wins fold makes that correct, merely unnarrowed.
   *
   * An empty snapshot list simply returns `[]`; the caller's `appendAll([])` is
   * a no-op (`message-log.service.ts`), so no early-return guard is needed.
   */
  async seedMessages(
    processId: string,
    agentId?: string,
  ): Promise<AkgenticMessage[]> {
    const states: AgentStateResponse[] = await this.api.getAgentStates(
      processId,
      agentId,
    );
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
