import { inject, Injectable } from '@angular/core';
import { distinctUntilChanged, map, Observable, shareReplay } from 'rxjs';

import { AgentTokenUsage } from '../event/per-agent-specs';
import { IngestionService } from '../event/ingestion.service';

/** Headline team-wide totals (ADR-022 §Decision 2/4, extended by ADR-024
 *  §Decision 1): Σ sent / Σ received / Σ cache read / Σ cache write. */
export interface TeamTokenTotals {
  totalSent: number;
  totalReceived: number;
  totalCacheRead: number;
  totalCacheWrite: number;
}

/** Structural equality of two totals (NFR / OnPush): the summed object is a
 *  fresh reference each frame, so the default reference comparator would never
 *  suppress no-op re-emissions. */
function totalsEqual(a: TeamTokenTotals, b: TeamTokenTotals): boolean {
  return (
    a.totalSent === b.totalSent &&
    a.totalReceived === b.totalReceived &&
    a.totalCacheRead === b.totalCacheRead &&
    a.totalCacheWrite === b.totalCacheWrite
  );
}

/** Pure Σ over every agent's usage (ADR-022 §Decision 2): the team total is a
 *  DERIVATION, never a separately stored aggregate. An empty map yields zeros. */
function sumTotals(all: ReadonlyMap<string, AgentTokenUsage>): TeamTokenTotals {
  let totalSent = 0;
  let totalReceived = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  for (const usage of all.values()) {
    totalSent += usage.totalSent;
    totalReceived += usage.totalReceived;
    totalCacheRead += usage.totalCacheRead;
    totalCacheWrite += usage.totalCacheWrite;
  }
  return { totalSent, totalReceived, totalCacheRead, totalCacheWrite };
}

/** Team totals for ONE model — the same figures as `TeamTokenTotals`, tagged
 *  with the model they belong to. */
export interface ModelTokenTotals extends TeamTokenTotals {
  modelName: string;
}

/** Group the team's usage by model and sum each group, reading each agent's
 *  `perModel` split so an agent that switched model mid-session (ADR-018)
 *  contributes to EVERY model it ran on, in the right proportion.
 *
 *  This used to group each agent's cumulative totals under its `lastModelName`,
 *  which credited all of an agent's earlier tokens to whatever model it happened
 *  to be on now — exact only while an agent kept one model for life, which
 *  runtime model switching ended. Agents that have not run a model yet have an
 *  empty `perModel` and contribute nothing. Sorted by sent desc (then name) for
 *  a stable, deterministic render order. */
function groupByModel(
  all: ReadonlyMap<string, AgentTokenUsage>,
): ModelTokenTotals[] {
  const byModel = new Map<string, ModelTokenTotals>();
  for (const usage of all.values()) {
    for (const [modelName, share] of usage.perModel) {
      if (modelName === '') continue;
      const g = byModel.get(modelName);
      if (g) {
        g.totalSent += share.totalSent;
        g.totalReceived += share.totalReceived;
        g.totalCacheRead += share.totalCacheRead;
        g.totalCacheWrite += share.totalCacheWrite;
      } else {
        byModel.set(modelName, {
          modelName,
          totalSent: share.totalSent,
          totalReceived: share.totalReceived,
          totalCacheRead: share.totalCacheRead,
          totalCacheWrite: share.totalCacheWrite,
        });
      }
    }
  }
  return Array.from(byModel.values()).sort(
    (a, b) => b.totalSent - a.totalSent || a.modelName.localeCompare(b.modelName),
  );
}

/** Structural equality of two per-model lists (OnPush): the grouped array is a
 *  fresh reference each frame, so a structural comparator suppresses no-op
 *  re-emissions. Order is deterministic (`groupByModel` sorts), so positional
 *  comparison is sound. */
function modelListEqual(a: ModelTokenTotals[], b: ModelTokenTotals[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      x.modelName === y.modelName &&
      x.totalSent === y.totalSent &&
      x.totalReceived === y.totalReceived &&
      x.totalCacheRead === y.totalCacheRead &&
      x.totalCacheWrite === y.totalCacheWrite
    );
  });
}

/**
 * TokenUsageSelector — Epic 26 / Story 26-1 (ADR-022 §Decision 2).
 *
 * Thin read surface over the `tokenUsage` `PerAgentStore` owned by
 * `IngestionService` (registered on the single `PerAgentStoreRegistry` alongside
 * `state` / `context` / `commands` / `systemPrompt`). Holds NO state of its own.
 *
 * - `perAgent$(agentId)` is a façade over `tokenUsage.forAgent(id)`, mirroring
 *   `SystemPromptSelector`. It passes the store's `undefined` (never-run agent)
 *   THROUGH unchanged (ADR-022 §Open Question 2): the data layer stays faithful,
 *   and the member-chat pill (Story 26.2) owns the neutral empty-state render.
 *   `forAgent` already applies a reference `distinctUntilChanged` +
 *   `shareReplay({ bufferSize: 1, refCount: true })` with lazy current-value
 *   replay, so no extra pipeline is needed here.
 * - `teamTotals$` is a PURE sum over `tokenUsage.all$` (Σ every agent's
 *   `totalSent` / `totalReceived` / `totalCacheRead` / `totalCacheWrite`) — NOT
 *   a separately stored aggregate. Because
 *   `ProcessComponent` + its scoped registry are destroyed/recreated on every
 *   team switch, `all$` holds exactly the CURRENT team's agents, so the total is
 *   correct by construction with no team-id bookkeeping. The sum is a fresh
 *   reference each frame, so it needs a STRUCTURAL `distinctUntilChanged`
 *   (`totalsEqual`) to suppress no-op frames, plus `shareReplay` for OnPush.
 *
 * Scope: component-scoped (NOT `providedIn: 'root'`) — it injects the
 * component-scoped `IngestionService` from `ProcessComponent.providers`.
 */
@Injectable()
export class TokenUsageSelector {
  private readonly ingestion: IngestionService = inject(IngestionService);

  readonly teamTotals$: Observable<TeamTokenTotals> =
    this.ingestion.tokenUsage.all$.pipe(
      map(sumTotals),
      distinctUntilChanged(totalsEqual),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

  /** Per-model breakdown of the team's usage (feeds the team-footer popover):
   *  Σ per model, sorted sent-desc. Same scoping/derivation guarantees as
   *  `teamTotals$` — pure over the scoped `all$`, structural dedupe, shareReplay. */
  readonly teamByModel$: Observable<ModelTokenTotals[]> =
    this.ingestion.tokenUsage.all$.pipe(
      map(groupByModel),
      distinctUntilChanged(modelListEqual),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

  perAgent$(agentId: string): Observable<AgentTokenUsage | undefined> {
    return this.ingestion.tokenUsage.forAgent(agentId);
  }
}
