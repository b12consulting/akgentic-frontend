import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

/**
 * V2 Knowledge Graph wire types.
 *
 * These mirror the Pydantic models on the backend (ADR-024):
 * - Entity: keyed by `id` (uuid string), carries display fields (`name`,
 *   `entity_type`, `description`, `observations`) and an optional `is_root`
 *   flag the backend only sends when `True`.
 * - Relation: keyed by `id` (uuid string), carries `from_entity` / `to_entity`
 *   names (not ids — the existing `KnowledgeGraphComponent` keys ECharts
 *   source/target on names), a `relation_type`, and an optional `description`.
 *
 * Kept local to the reducer layer (not shared with the component) to avoid
 * reversing the `services/` → `process/` coupling. The component retains its
 * own compatible interface definitions; the field shapes match.
 */
export interface KnowledgeGraphEntity {
  id: string;
  name?: string;
  entity_type?: string;
  description?: string;
  observations?: any[];
  is_root?: boolean;
}

export interface KnowledgeGraphRelation {
  id: string;
  from_entity?: string;
  to_entity?: string;
  relation_type?: string;
  description?: string;
}

export interface KnowledgeGraphData {
  nodes: KnowledgeGraphEntity[];
  edges: KnowledgeGraphRelation[];
}

/**
 * Per-`tool_id` reducer state. `entities` and `relations` are id-keyed Maps
 * so every delta (add / modify / remove) is O(1). `lastSeq` starts at 0 and
 * tracks the last successfully-applied `ToolStateEvent.seq`.
 */
interface KGPerToolState {
  entities: Map<string, KnowledgeGraphEntity>;
  relations: Map<string, KnowledgeGraphRelation>;
  lastSeq: number;
}

/**
 * KGStateReducer — consumes `ToolStateEvent` envelopes carrying
 * `KnowledgeGraphStateEvent` payloads and emits immutable `KnowledgeGraphData`
 * projections onto `knowledgeGraph$`.
 *
 * Single instance spans the team's lifetime (root-provided). Replay + live
 * paths in `ActorMessageService` both call `apply(inner)` — live/replay
 * parity is guaranteed by construction (ADR-004 §Decision 5).
 *
 * Projection contract: every successful `apply()` emits a NEW `KnowledgeGraphData`
 * object (spread from the internal Maps) so downstream `OnPush` change
 * detection fires (NFR7). Two successive `apply()` calls never yield the same
 * projection reference.
 *
 * Scope: MVP emits a single combined stream across all `tool_id`s. State is
 * per-`tool_id` internally (so deletes in one tool don't evict entries from
 * another), but the projection flattens all tools into one graph. Multi-tool
 * partitioning at the projection layer is out of scope (ADR-004 §Decision 3 —
 * premature abstraction until a second stateful tool lands).
 */
@Injectable({ providedIn: 'root' })
export class KGStateReducer {
  private readonly stateByTool: Map<string, KGPerToolState> = new Map();

  private readonly projectionSubject$ = new BehaviorSubject<KnowledgeGraphData>(
    { nodes: [], edges: [] }
  );

  /**
   * Public projection stream. Wire into `ActorMessageService.knowledgeGraph$`
   * via `bind(subject$)` from the consumer. See `kg-state.reducer.spec.ts` for
   * subscription-based assertions.
   */
  readonly knowledgeGraph$: Observable<KnowledgeGraphData> =
    this.projectionSubject$.asObservable();

  /**
   * Bind the reducer's projection stream to an external `BehaviorSubject`
   * (typically `ActorMessageService.knowledgeGraph$`). Called once by the
   * message service during construction. Every future projection is piped
   * through to the bound subject.
   *
   * Using a setter-binding (Option A from AC4) avoids introducing a circular
   * DI dependency between `ActorMessageService` and `KGStateReducer`.
   */
  bind(subject$: BehaviorSubject<KnowledgeGraphData>): void {
    // Seed with current projection so late binders still see the latest state.
    subject$.next(this.projectionSubject$.getValue());
    this.projectionSubject$.subscribe((projection) => {
      subject$.next(projection);
    });
  }

  /**
   * Dispatch a `ToolStateEvent` inner payload.
   *
   * Event shape (envelope already stripped by `ActorMessageService`):
   * ```
   * {
   *   __model__: 'akgentic.tool.messages.ToolStateEvent',
   *   tool_id: string,
   *   seq: number,
   *   payload: {
   *     __model__: 'akgentic.tool.messages.KnowledgeGraphStateEvent',
   *     entities_added, entities_modified, entities_removed,
   *     relations_added, relations_modified, relations_removed,
   *   }
   * }
   * ```
   *
   * AC3 semantics:
   * 1. Payload dispatch (FR11) — unknown `payload.__model__`s are logged via
   *    `console.debug` and return without mutation or projection emission.
   * 2. Seq-gap log (FR10) — if `prev !== 0 && curr !== prev + 1` emit a
   *    `console.warn`, but APPLY the event anyway (ADR-004 §Decision 6).
   * 3. Upserts — `entities_added ∪ entities_modified` (and the same for
   *    relations) `set()` into the id-keyed Map.
   * 4. Deletes — `entities_removed` (list of uuid strings) `delete()` from
   *    the Map. Missing ids are a no-op (matches backend cascade redundancy).
   * 5. Seq advance — `state.lastSeq = curr` unconditionally after apply.
   * 6. Projection emission — a fresh `{nodes, edges}` object is emitted
   *    (even for no-op empty-collections events, per the contract "every
   *    apply emits").
   */
  apply(toolStateEvent: any): void {
    const tool_id: string | undefined = toolStateEvent?.tool_id;
    const seq: number = toolStateEvent?.seq ?? 0;
    const payload = toolStateEvent?.payload;

    // Step 1: payload dispatch (FR11).
    if (!payload?.__model__?.includes('KnowledgeGraphStateEvent')) {
      console.debug('[KGStateReducer] unknown payload', {
        tool_id,
        model: payload?.__model__,
      });
      return;
    }

    if (!tool_id) {
      // Defensive: without tool_id we can't partition state. Drop quietly.
      console.debug('[KGStateReducer] missing tool_id', { seq });
      return;
    }

    const state = this.getOrCreateState(tool_id);

    // Step 2: seq-gap log (FR10).
    const prev = state.lastSeq;
    if (prev !== 0 && seq !== prev + 1) {
      console.warn('[KGStateReducer] seq gap', {
        prev_seq: prev,
        event_seq: seq,
        tool_id,
      });
    }

    // Steps 3 + 4: apply deltas.
    this.applyEntityDeltas(state, payload);
    this.applyRelationDeltas(state, payload);

    // Step 5: seq advance (unconditional).
    state.lastSeq = seq;

    // Step 6: projection emission (new object reference on every apply).
    this.emitProjection();
  }

  /**
   * Clear all per-tool state. Called by `ActorMessageService.init()` on team
   * load so a second team does not inherit the first team's KG state.
   * Emits a fresh empty projection so downstream consumers see the reset.
   */
  resetForTeam(): void {
    this.stateByTool.clear();
    this.emitProjection();
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  private getOrCreateState(tool_id: string): KGPerToolState {
    let state = this.stateByTool.get(tool_id);
    if (!state) {
      state = {
        entities: new Map<string, KnowledgeGraphEntity>(),
        relations: new Map<string, KnowledgeGraphRelation>(),
        lastSeq: 0,
      };
      this.stateByTool.set(tool_id, state);
    }
    return state;
  }

  private applyEntityDeltas(state: KGPerToolState, payload: any): void {
    const added: KnowledgeGraphEntity[] = payload.entities_added ?? [];
    const modified: KnowledgeGraphEntity[] = payload.entities_modified ?? [];
    const removed: string[] = payload.entities_removed ?? [];

    for (const entity of added) {
      state.entities.set(entity.id, entity);
    }
    for (const entity of modified) {
      state.entities.set(entity.id, entity);
    }
    for (const id of removed) {
      state.entities.delete(id);
    }
  }

  private applyRelationDeltas(state: KGPerToolState, payload: any): void {
    const added: KnowledgeGraphRelation[] = payload.relations_added ?? [];
    // `relations_modified` is always empty on the wire today (ADR-024 §1b —
    // `ManageGraph` has no relation-update op). Code path retained for
    // forward-compat; exercised by a unit test so it does not rot.
    const modified: KnowledgeGraphRelation[] = payload.relations_modified ?? [];
    const removed: string[] = payload.relations_removed ?? [];

    for (const relation of added) {
      state.relations.set(relation.id, relation);
    }
    for (const relation of modified) {
      state.relations.set(relation.id, relation);
    }
    for (const id of removed) {
      state.relations.delete(id);
    }
  }

  /**
   * Compute and emit a fresh `KnowledgeGraphData` by flattening every
   * per-tool state Map into a single nodes/edges projection.
   */
  private emitProjection(): void {
    const nodes: KnowledgeGraphEntity[] = [];
    const edges: KnowledgeGraphRelation[] = [];
    for (const state of this.stateByTool.values()) {
      for (const entity of state.entities.values()) {
        nodes.push(entity);
      }
      for (const relation of state.relations.values()) {
        edges.push(relation);
      }
    }
    this.projectionSubject$.next({ nodes, edges });
  }
}
