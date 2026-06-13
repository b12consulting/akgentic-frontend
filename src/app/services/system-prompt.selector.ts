import { inject, Injectable } from '@angular/core';
import { distinctUntilChanged, map, Observable, shareReplay } from 'rxjs';

import {
  AkgenticMessage,
  isEventMessage,
  isLlmSystemPromptEvent,
  SystemPromptPartSnapshot,
} from '../models/message.types';
import { MessageLogService } from './message-log.service';

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
// The fold allocates a fresh result array per call; it never mutates `log`.
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
 * Primary path (FR1, latest-wins): the `parts` of the LAST
 * `EventMessage(LlmSystemPromptEvent)` for `agentId`, in log order. Returns
 * `undefined` when the agent has no such event (so the caller can fall back).
 * The log is append-only and ordered — latest-wins is "last by position", not
 * a sort on `run_id`.
 */
function latestSystemPromptParts(
  log: AkgenticMessage[],
  agentId: string,
): SystemPromptPartSnapshot[] | undefined {
  let latest: SystemPromptPartSnapshot[] | undefined;
  for (const msg of log) {
    if (!isEventMessage(msg)) continue;
    const inner = (msg as { event?: unknown }).event as
      | { __model__?: string; parts?: SystemPromptPartSnapshot[] }
      | undefined;
    if (!isLlmSystemPromptEvent(inner)) continue;
    if (msg.sender?.agent_id !== agentId) continue;
    latest = inner.parts;
  }
  return latest;
}

/**
 * Fallback path (FR2): the `system-prompt` parts of the FIRST
 * `EventMessage(LlmMessageEvent)` for `agentId` (pre-event teams whose logs
 * predate `LlmSystemPromptEvent`). Mirrors the `contextDict$` seeding read in
 * `message.service.ts` (inner is the `ModelRequest`, whose `.parts` carry
 * `part_kind`). Returns `undefined` when no such message exists for the agent.
 */
function fallbackSystemPromptParts(
  log: AkgenticMessage[],
  agentId: string,
): Array<{ dynamic_ref?: string | null; content?: string }> | undefined {
  for (const msg of log) {
    if (!isEventMessage(msg)) continue;
    const inner = (msg as { event?: unknown }).event as
      | { __model__?: string; message?: { parts?: unknown[] } }
      | undefined;
    if (!inner?.__model__?.includes('LlmMessageEvent')) continue;
    if (msg.sender?.agent_id !== agentId) continue;
    const parts = (inner.message?.parts ?? []) as Array<{
      part_kind?: string;
      dynamic_ref?: string | null;
      content?: string;
    }>;
    const systemParts = parts.filter((p) => p?.part_kind === 'system-prompt');
    if (systemParts.length > 0) return systemParts;
  }
  return undefined;
}

/**
 * Pure fold over the message log producing the current head system block for
 * one agent (ADR-004 §5b step 1). Primary source: the LAST
 * `LlmSystemPromptEvent` for the agent (latest-wins, FR1). Fallback (FR2, only
 * when the agent has ZERO `LlmSystemPromptEvent`s): the system-prompt parts of
 * the FIRST `LlmMessageEvent` for the agent. Unknown/unrelated `__model__`s
 * pass through silently; never throws; allocates a fresh array per call.
 *
 * Exported so tests can import it directly (no TestBed required).
 */
export function latestSystemPromptFold(
  log: AkgenticMessage[],
  agentId: string,
): SystemPromptRow[] {
  const primary = latestSystemPromptParts(log, agentId);
  if (primary !== undefined) return mapPartsToRows(primary);
  return mapPartsToRows(fallbackSystemPromptParts(log, agentId));
}

/** Structural comparator so identical head blocks across no-op `log$` ticks do
 *  not re-emit (OnPush), while a real change emits a fresh reference (AC9). */
function rowsEqual(a: SystemPromptRow[], b: SystemPromptRow[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * SystemPromptSelector — Story 16-1 (ADR-004 §5b step 1).
 *
 * Exposes `latestSystemPrompt$(agentId)` as a pure selector over
 * `MessageLogService.log$`, mirroring `KGStateReducer.knowledgeGraph$`. NO new
 * imperative per-agent dict / `BehaviorSubject` — the head block is derived by
 * folding the unified log, preserving frontend ADR-005's two-exception
 * invariant (NFR1). `shareReplay(1)` gives late subscribers the current block
 * synchronously (AC8); the structural `distinctUntilChanged` suppresses no-op
 * re-emissions while still emitting a fresh array on real change (AC9).
 *
 * Scope: component-scoped (NOT `providedIn: 'root'`) — it injects the
 * component-scoped `MessageLogService` from `ProcessComponent.providers`.
 */
@Injectable()
export class SystemPromptSelector {
  private readonly log: MessageLogService = inject(MessageLogService);

  latestSystemPrompt$(agentId: string): Observable<SystemPromptRow[]> {
    return this.log.log$.pipe(
      map((log) => latestSystemPromptFold(log, agentId)),
      distinctUntilChanged(rowsEqual),
      shareReplay(1),
    );
  }
}
