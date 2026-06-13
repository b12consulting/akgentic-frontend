import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import {
  AkgenticMessage,
  EventMessage,
  isEventMessage,
  isLlmSystemPromptEvent,
  SystemPromptPartSnapshot,
} from '../models/message.types';
import { ActorMessageService } from './message.service';

/**
 * One rendered row of the trace head system block. Mirrors the shape the
 * `AkgentChatComponent` already produces for `part_kind === 'system-prompt'`
 * parts (`akgent-chat.component.ts` label/mapping) so Story 16-2 can render it
 * with no shape change: `name` is the human label, `content` the rendered text.
 */
export interface SystemPromptRow {
  type: 'system';
  name: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Module-scope pure helpers (ADR-005 §Decision 4; ADR-004 §5b).
//
// These are the SINGLE implementation of the system-prompt mapping + part
// extraction logic. They are shared by the `systemPromptReduce` per-message
// reducer (registered on the `systemPrompt` PerAgentStore in
// `ActorMessageService`, Epic 17 / ADR-014) — there is no longer a whole-log
// fold. Each maps to a fresh array; none mutates its input; none throws.
// ---------------------------------------------------------------------------

/**
 * Label for a system-prompt block — reuses the exact logic from
 * `akgent-chat.component.ts`: the trailing segment of the pydantic-ai
 * `dynamic_ref` (e.g. `team.roster` → `roster`), or `'System'` for static parts
 * (`dynamic_ref` null/empty). Defensive: never throws on null/undefined.
 */
export function systemPromptLabel(
  dynamic_ref: string | null | undefined,
): string {
  return dynamic_ref ? (dynamic_ref.split('.').pop() ?? 'System') : 'System';
}

/**
 * Map a list of rendered parts (either `SystemPromptPartSnapshot` from a
 * `LlmSystemPromptEvent`, or pydantic-ai `SystemPromptPart`s from a
 * `LlmMessageEvent` fallback — both expose `dynamic_ref` + `content`) to render
 * rows. Defensive reads only: a missing/empty `parts` yields `[]`, a part with
 * no `content` contributes an empty string rather than throwing. Always returns
 * a freshly-allocated array (OnPush safety, AC9).
 */
function mapPartsToRows(
  parts: ReadonlyArray<{ dynamic_ref?: string | null; content?: string }>
    | null
    | undefined,
): SystemPromptRow[] {
  return (parts ?? []).map((p) => ({
    type: 'system' as const,
    name: systemPromptLabel(p?.dynamic_ref),
    content: p?.content ?? '',
  }));
}

/**
 * Primary-path extraction (FR1): if `msg` is an
 * `EventMessage(LlmSystemPromptEvent)`, return its `parts` (possibly undefined
 * for a malformed event); otherwise `undefined`. Latest-wins is applied by the
 * reducer (the LAST such event replaces the value), so this only reads ONE
 * message's parts.
 */
function systemPromptEventParts(
  msg: AkgenticMessage,
): SystemPromptPartSnapshot[] | undefined {
  if (!isEventMessage(msg)) return undefined;
  const inner = (msg as EventMessage).event as
    | { __model__?: string; parts?: SystemPromptPartSnapshot[] }
    | undefined;
  if (!isLlmSystemPromptEvent(inner)) return undefined;
  return inner.parts;
}

/**
 * Fallback-path extraction (FR2): if `msg` is an
 * `EventMessage(LlmMessageEvent)` whose inner `message.parts` contain
 * `part_kind === 'system-prompt'` entries, return those system parts; otherwise
 * `undefined`. Mirrors the pre-event seeding read in `message.service.ts`
 * (inner is the `ModelRequest`, whose `.parts` carry `part_kind`).
 */
function llmMessageSystemParts(
  msg: AkgenticMessage,
): Array<{ dynamic_ref?: string | null; content?: string }> | undefined {
  if (!isEventMessage(msg)) return undefined;
  const inner = (msg as EventMessage).event as
    | { __model__?: string; message?: { parts?: unknown[] } }
    | undefined;
  if (!inner?.__model__?.includes('LlmMessageEvent')) return undefined;
  const parts = (inner.message?.parts ?? []) as Array<{
    part_kind?: string;
    dynamic_ref?: string | null;
    content?: string;
  }>;
  const systemParts = parts.filter((p) => p?.part_kind === 'system-prompt');
  return systemParts.length > 0 ? systemParts : undefined;
}

/**
 * Per-agent reduced value for the `systemPrompt` store (Epic 17 / ADR-014). The
 * incremental reducer cannot be a stock factory because the precedence is
 * "latest primary OR first fallback" — it must remember whether a primary
 * (`LlmSystemPromptEvent`) has ever been seen for the agent so a later
 * `LlmMessageEvent` cannot clobber a primary, and a second `LlmMessageEvent`
 * cannot overwrite an earlier fallback.
 *
 * - `rows`       — the rendered head block (what the façade exposes).
 * - `hasPrimary` — true once any `LlmSystemPromptEvent` has been folded for the
 *                  agent (primary supersedes fallback from that point on).
 */
export interface SystemPromptValue {
  rows: SystemPromptRow[];
  hasPrimary: boolean;
}

/**
 * Incremental per-message reducer (the store's `(prev, msg) => next` contract,
 * ADR-014 §Decision 1 custom reducer) that reproduces EXACTLY the precedence of
 * the old whole-log fold:
 *
 *   1. Primary (latest-wins, FR1): a `LlmSystemPromptEvent` always replaces the
 *      value with its parts and marks `hasPrimary` — the LAST one wins.
 *   2. Fallback (FR2, ONLY while `!hasPrimary`): the FIRST `LlmMessageEvent`
 *      with system parts captures the value; once captured, later
 *      `LlmMessageEvent`s do NOT overwrite it (first-wins fallback). A
 *      `LlmMessageEvent` never overrides a primary.
 *   3. Anything else (unrelated inner, no system parts) → passthrough `prev`.
 *
 * Malformed/empty parts map to `[]` without throwing (defensive `mapPartsToRows`).
 * Returns a FRESH `rows` array on real change (OnPush safety).
 */
export function systemPromptReduce(
  prev: SystemPromptValue | undefined,
  msg: AkgenticMessage,
): SystemPromptValue | undefined {
  const primary = systemPromptEventParts(msg);
  if (primary !== undefined) {
    return { rows: mapPartsToRows(primary), hasPrimary: true };
  }
  // Primary already established → a message-event fallback never overrides it.
  if (prev?.hasPrimary) return prev;
  // Fallback already captured → first-wins; later message events do not replace.
  if (prev !== undefined) return prev;
  const fallback = llmMessageSystemParts(msg);
  if (fallback !== undefined) {
    return { rows: mapPartsToRows(fallback), hasPrimary: false };
  }
  return prev;
}

/**
 * `match` predicate for the `systemPrompt` spec: admit BOTH inner model types
 * so both reach `systemPromptReduce` (the reducer — not `match` — decides
 * primary-vs-fallback). Any `EventMessage` whose inner is a
 * `LlmSystemPromptEvent` OR a `LlmMessageEvent` is folded.
 */
export function systemPromptMatch(msg: AkgenticMessage): boolean {
  if (!isEventMessage(msg)) return false;
  return (
    systemPromptEventParts(msg) !== undefined ||
    llmMessageSystemParts(msg) !== undefined
  );
}

/**
 * SystemPromptSelector — Story 16-1 (ADR-004 §5b step 1), thin façade since
 * Epic 17 / Story 17-4 (ADR-014).
 *
 * `latestSystemPrompt$(agentId)` now DELEGATES to the `systemPrompt`
 * `PerAgentStore` instance owned by `ActorMessageService` (registered on the
 * single `PerAgentStoreRegistry` alongside `state` / `context` / `commands`).
 * The selector holds NO per-agent state of its own and no `log$` fold pipeline —
 * the latest-wins + FR2 fallback + row-mapping logic lives in
 * `systemPromptReduce`. `forAgent` already applies a reference
 * `distinctUntilChanged` + `shareReplay({ bufferSize: 1, refCount: true })` with
 * a lazy current-value replay, covering the late-subscriber + no-op-suppression
 * + fresh-array-on-change semantics the head block relies on. The façade
 * coalesces the store's `undefined` (agent never folded) to `[]` so the
 * head-block consumer always receives `SystemPromptRow[]`, never `undefined`
 * (AC-4 parity with the old fold's `[]`-for-no-rows contract).
 *
 * Scope: component-scoped (NOT `providedIn: 'root'`) — it injects the
 * component-scoped `ActorMessageService` from `ProcessComponent.providers`.
 */
@Injectable()
export class SystemPromptSelector {
  private readonly messageService: ActorMessageService =
    inject(ActorMessageService);

  latestSystemPrompt$(agentId: string): Observable<SystemPromptRow[]> {
    return this.messageService.systemPrompt
      .forAgent(agentId)
      .pipe(map((value) => value?.rows ?? []));
  }
}
