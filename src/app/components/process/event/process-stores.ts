import { inject, Injectable } from '@angular/core';

import { CommandDescriptor } from '../../../protocol/message.types';
import {
  AgentStateValue,
  AgentTokenUsage,
  commandsSpec,
  contextSpec,
  stateSpec,
  systemPromptSpec,
  SystemPromptValue,
  tokenUsageSpec,
} from './per-agent-specs';
import {
  PerAgentStore,
  PerAgentStoreRegistry,
} from './per-agent-store';

/**
 * `ProcessStores` — the projection-tier declaration surface (Epic 34 /
 * ADR-025 §1). It declares the five folds over `MessageLogService.log$` and
 * exposes nothing else; `IngestionService` re-exports the same instances so
 * the surface consumers read is unchanged.
 *
 * A PROJECTION, not a source and not a reactor: it writes nothing to the log,
 * reads no stream of its own, and owns no lifecycle. There is deliberately no
 * `start` / `stop` / `init` / `ngOnDestroy` here — the single `log$`
 * subscription and its `processedCount` cursor belong to
 * `PerAgentStoreRegistry`, which also owns the shrink-detect reset, so reset
 * stays ONE code path.
 *
 * Registration happens in the field initializers below, at construction time.
 * That is required rather than forbidden: consumers call `state.forAgent(id)`
 * without calling anything first, so deferring registration into a `start()`
 * would be a silent behaviour change dressed up as lifecycle compliance.
 * `register()` starts the REGISTRY's subscription, not one owned by this unit,
 * and `log$` is a `BehaviorSubject` — a late registration still sees the
 * current log — so construction order relative to `init()` is not load-bearing.
 *
 * Component-scoped (`@Injectable()` with no `providedIn`), provided on
 * `ProcessComponent` alongside the registry it wraps: root scope would leak
 * per-agent state across team switches.
 */
@Injectable()
export class ProcessStores {
  /**
   * Epic 17 (ADR-014): component-scoped registry that folds `log$` into the
   * per-agent `state` / `context` maps (single subscription, O(Δ), automatic
   * replay + reset). Provided on `ProcessComponent` alongside
   * `MessageLogService`. Owns the maps the deleted dicts used to hold.
   */
  private readonly registry: PerAgentStoreRegistry =
    inject(PerAgentStoreRegistry);

  /**
   * Epic 17 (ADR-014 §5): per-agent latest `{ schema, state }` derived from
   * `StateChangedMessage`. Replaces the bespoke `stateDict$`. Default key
   * `sender.agent_id`; `schema` is an empty object literal exactly as before
   * (V2 sends an empty schema; raw state rendered as JSON). Read via
   * `state.forAgent(id)`.
   */
  readonly state: PerAgentStore<AgentStateValue> =
    this.registry.register<AgentStateValue>(stateSpec);

  /**
   * Epic 17 (ADR-014 §5): per-agent ordered conversation array derived by
   * appending each `LlmMessageEvent` envelope's inner `message`. Replaces the
   * bespoke `contextDict$`. Default key `sender.agent_id`; the append is
   * O(Δ)/frame (the registry walks only `log.slice(processedCount)` and
   * `appendWith` concats once per new message). Read via `context.forAgent(id)`.
   */
  readonly context: PerAgentStore<unknown[]> =
    this.registry.register<unknown[]>(contextSpec);

  /**
   * Epic 17 (ADR-014 §5): per-agent slash-command store derived from
   * `CommandsAnnouncedEvent` riding the `EventMessage` passthrough. Replaces
   * the bespoke `commandsByAgent$`. Default key `sender.agent_id` (ADR-013
   * keying fix — the emitting agent is the outer sender, so
   * `sender.agent_id === inner.agent.agent_id`, ADR-014 §2), so a fired/re-hired
   * display-name reuse can never serve the wrong agent's commands. `replaceWith`
   * gives the same replace-on-re-announce semantics the backend relies on (the
   * full list is re-emitted on change). Read via `commands.forAgent(id)` /
   * `commands.snapshot(id)` by the `/` mention consumers.
   */
  readonly commands: PerAgentStore<CommandDescriptor[]> =
    this.registry.register<CommandDescriptor[]>(commandsSpec);

  /**
   * Epic 17 (ADR-014 §5): per-agent system-prompt head block derived from
   * `LlmSystemPromptEvent` (primary, latest-wins, FR1) with a first
   * `LlmMessageEvent` system-part fallback (FR2). Replaces the bespoke
   * `SystemPromptSelector` `log$` fold — the selector is now a thin façade that
   * delegates to `systemPrompt.forAgent(id)`. The reducer is a custom one
   * (`systemPromptReduce`) because the precedence is "latest primary OR first
   * fallback", not a stock factory; `match` (`systemPromptMatch`) admits BOTH
   * `LlmSystemPromptEvent` and `LlmMessageEvent` inners so both reach the
   * reducer. Default key `sender.agent_id`. Read via the façade or directly via
   * `systemPrompt.forAgent(id)` (value `{ rows, hasPrimary }`; the façade
   * projects `.rows`).
   */
  readonly systemPrompt: PerAgentStore<SystemPromptValue> =
    this.registry.register<SystemPromptValue>(systemPromptSpec);

  /**
   * Epic 26 (ADR-022 §Decision 2): per-agent token-usage derived from
   * `LlmUsageEvent` riding the `EventMessage` passthrough. Default key
   * `sender.agent_id` (the agent that ran the model). Folded by the same
   * component-scoped registry as `state` / `context` / `commands` /
   * `systemPrompt` — replay + reset for free. Read via `tokenUsage.forAgent(id)`
   * (per-agent) and `tokenUsage.all$` (the `TokenUsageSelector.teamTotals$` sum).
   */
  readonly tokenUsage: PerAgentStore<AgentTokenUsage> =
    this.registry.register<AgentTokenUsage>(tokenUsageSpec);
}
