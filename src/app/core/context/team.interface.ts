/**
 * V2 Team data model — replaces ProcessContext from V1.
 * Maps to Python TeamResponse, EventResponse from akgentic.infra.server.models.
 */

import { TeamMetadataContract } from '../../protocol/catalog.interface';

// Maps to Python TeamResponse (from akgentic.infra.server.models)
export interface TeamResponse {
  team_id: string;
  name: string;
  status: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  /**
   * The team's business metadata as plain JSON, or `null` when it carries
   * none. Never includes the `__model__` tag — the server strips it at its
   * single conversion point.
   *
   * OPTIONAL *and* nullable: a server predating the release that introduced
   * the field does not send the key at all, and a current server sends
   * `null` for a team whose namespace declares no contract. Both mean the
   * same thing to every consumer — NO METADATA — so gate on falsiness.
   */
  metadata?: Record<string, unknown> | null;
  /**
   * Whether the team was doing something at the instant the server answered:
   * `true` working, `false` idle, `null` NOT KNOWN.
   *
   * OPTIONAL *and* nullable, and unlike `metadata` the three states are NOT
   * interchangeable: a server predating this field omits the key, and a
   * current server that cannot reach whatever produces the signal sends
   * `null`. Both mean UNKNOWN — which is not `false`. Gating on falsiness
   * here (`if (response.working)`) collapses absent, `null` and `false` into
   * one branch and labels every team on an older server idle. Compare
   * against `true` / `false` explicitly, or go through `teamActivity`.
   *
   * A STATUS, NOT A HEARTBEAT. It describes one instant and travels in a page
   * fetched at another, so it is already stale by the time it renders. It
   * rides the list response the page fetches anyway; nothing polls it.
   */
  working?: boolean | null;
}

// Maps to Python TeamListResponse (classic offset+total pagination, Epic 28).
// `total_count` is the total teams the user owns across ALL pages; `teams` is
// the current page. No `next_cursor` (the parked cursor approach, ADR-031).
export interface TeamListResponse {
  teams: TeamResponse[];
  total_count: number;
}

// Maps to Python EventResponse
export interface EventResponse {
  team_id: string;
  sequence: number;
  event: any;
  timestamp: string;
}

// Maps to Python EventListResponse
export interface EventListResponse {
  events: EventResponse[];
}

// Maps to Python AgentStateResponse (akgentic.infra.server.models, Story 35-1).
// `agent_id` is the agent UUID (team Epic 23) — the exact key the per-agent
// `state` store uses, so no client-side name→UUID resolution is needed.
export interface AgentStateResponse {
  agent_id: string;
  name: string | null;
  state: Record<string, unknown>;
  updated_at: string;
}

// Maps to Python AgentStateListResponse
export interface AgentStateListResponse {
  states: AgentStateResponse[];
}

// Maps to Python CreateTeamRequest (akgentic.infra.server.models)
export interface CreateTeamRequest {
  catalog_namespace: string;
  params?: Record<string, string>;
}

// Maps to Python SendMessageRequest
export interface SendMessageRequest {
  content: string;
}

// Maps to Python HumanInputRequest
export interface HumanInputRequest {
  content: string;
  message_id: string;
}

/**
 * Frontend-facing team model — slimmed down from V1 ProcessContext.
 * Only includes fields actually used by frontend components.
 */
export interface TeamContext {
  team_id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
  config_name: string;
  description?: string | null;
  /** Carried through verbatim from `TeamResponse.metadata`. See there. */
  metadata?: Record<string, unknown> | null;
  /**
   * Carried through verbatim from `TeamResponse.working`. See there —
   * especially that `null` and absent both mean UNKNOWN, not idle.
   */
  working?: boolean | null;
}

/**
 * Frontend-facing page of teams (classic offset+total pagination, Epic 28).
 * `teams` is already mapped to the `TeamContext` view model; `total_count`
 * is carried through verbatim from `TeamListResponse`.
 */
export interface TeamPage {
  teams: TeamContext[];
  total_count: number;
}

/**
 * What the team list is currently filtered by (Epic 48).
 *
 * `meta` maps a declared metadata field key to the ONE term typed into its
 * input; `catalogNamespace` narrows the list to a single namespace's teams, or
 * is `null` when the narrowing control is off.
 *
 * SINGLE TERM PER KEY BY DESIGN. The wire parameter `meta.<key>` is REPEATABLE
 * — terms within one key OR, distinct keys AND — but this UI renders exactly
 * one input per indexed field, so it can never produce a multi-term key.
 * Widening `meta` to `Record<string, string[]>` is therefore a deliberate
 * future change (it needs UI that can express a second term), not an oversight
 * to be quietly corrected.
 *
 * The term is carried VERBATIM. It is not casefolded here (the server
 * casefolds at index derivation, which is what keeps the query on an index)
 * and not regex/`LIKE`-escaped here (that is the server's query seam). The
 * client's whole contribution is `URLSearchParams` percent-encoding.
 */
export interface TeamFilter {
  meta: Record<string, string>;
  catalogNamespace: string | null;
}

/** The unfiltered state — the value the list starts and resets to. */
export const NO_TEAM_FILTER: TeamFilter = Object.freeze({
  meta: Object.freeze({}) as Record<string, string>,
  catalogNamespace: null,
});

/**
 * STRUCTURAL equality of two filters — same keys, same terms, same namespace.
 *
 * Every keystroke builds a fresh filter object, so an identity comparison
 * suppresses nothing: this is what `distinctUntilChanged` in the filter
 * pipeline must be given, and a bare `distinctUntilChanged()` there is the bug
 * this function exists to prevent.
 */
export function teamFilterEquals(a: TeamFilter, b: TeamFilter): boolean {
  if (a === b) {
    return true;
  }
  if (a.catalogNamespace !== b.catalogNamespace) {
    return false;
  }
  const aKeys = Object.keys(a.meta);
  if (aKeys.length !== Object.keys(b.meta).length) {
    return false;
  }
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b.meta, key) && a.meta[key] === b.meta[key],
  );
}

/** Check if a team is currently running. */
export function isRunning(team: Pick<TeamContext, 'status'>): boolean {
  return team.status === 'running';
}

/**
 * What the status column says about a team.
 *
 * `'stopped'` and `'running'` are the two states the list has always had;
 * `'working'` and `'idle'` split `'running'` when — and only when — the server
 * told us which. `'running'` is therefore not a fallback that lost
 * information: it is the honest rendering of a team whose activity is UNKNOWN.
 */
export type TeamActivity = 'stopped' | 'running' | 'working' | 'idle';

/**
 * Derive the status column's state from a team's status and activity flag.
 *
 * A PURE function of exactly those two fields — the whole truth table, in one
 * place, so it can be tested without a DOM. Six rows, and the three that
 * matter most are the ones where the flag is absent or `null`:
 *
 * | status      | working   | -> state    |
 * |-------------|-----------|-------------|
 * | not running | anything  | `stopped`   |
 * | running     | `true`    | `working`   |
 * | running     | `false`   | `idle`      |
 * | running     | `null`    | `running`   |
 * | running     | absent    | `running`   |
 *
 * STOPPED IGNORES THE FLAG (FR4). Stopped is a lifecycle state and idle is a
 * momentary one; a team goes idle and busy repeatedly without ever stopping,
 * and an activity flag left on a stopped team is noise, not a third reading.
 *
 * UNKNOWN RENDERS AS TODAY (FR3). `working === true` and `=== false` are
 * matched explicitly rather than by truthiness precisely so that a server
 * predating the field cannot quietly relabel every running team `idle` — a
 * failure that would look like the whole fleet going idle at once, most
 * visibly right after a deploy.
 */
export function teamActivity(
  team: Pick<TeamContext, 'status'> & { working?: boolean | null },
): TeamActivity {
  if (!isRunning(team)) {
    return 'stopped';
  }
  if (team.working === true) {
    return 'working';
  }
  if (team.working === false) {
    return 'idle';
  }
  return 'running';
}

/**
 * Map a V2 TeamResponse to the frontend TeamContext model.
 */
export function toTeamContext(response: TeamResponse): TeamContext {
  return {
    team_id: response.team_id,
    name: response.name,
    status: response.status,
    created_at: response.created_at,
    updated_at: response.updated_at,
    // config_name is not in TeamResponse -- V2 does not return it.
    // Use team name as placeholder; future story may populate from catalog metadata.
    config_name: response.name,
    description: null,
    metadata: response.metadata ?? null,
    // `??`, not `||`: `false` is a REAL answer here (idle) and must survive
    // the mapping. Absent normalises to `null` because both spell UNKNOWN.
    working: response.working ?? null,
  };
}

/**
 * One metadata key/value pair, ready to render.
 *
 * `label` is derived from the key alone, NOT from the namespace's
 * `MetadataFieldDescriptor.description`: a team row carries no namespace, so
 * the contract that produced these values is not reachable from here. The
 * derivation is deliberately dumb — underscores and hyphens become spaces and
 * the first letter is capitalised — because a key the server chose is already
 * the most honest label available.
 */
export interface TeamMetadataEntry {
  key: string;
  label: string;
  value: string;
}

/**
 * Humanise a metadata key for display: `case_id` -> `Case id`.
 *
 * Exported because the filter bar labels its inputs with it too. A team's
 * metadata chip and the input that filters on it must read identically — two
 * humanisers would let `Case id` sit above a chip saying `CaseId` and nothing
 * would notice.
 */
export function metadataKeyLabel(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Render one metadata value as a single line of text. */
function metadataValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * A team's metadata as a display-ordered list of pairs — `[]` when it carries
 * none (both wire spellings, and an empty object).
 *
 * Keys arrive in the order the server serialised them, which is the order the
 * declared model lists them, so nothing is sorted here.
 *
 * Entries whose value is absent (`null`, `undefined`, or an empty/whitespace
 * string) are DROPPED. An unanswered optional field is not information, and
 * rendering it as an empty chip reads as a value that failed to load.
 *
 * TAKES THE METADATA RECORD, NOT THE TEAM. `TeamMetadataPipe` memoises on its
 * input reference, and `metadata` is the reference that survives the team
 * rewrites that do not touch it — `_upsertTeam({ ...team, status })` builds a
 * NEW team object while carrying the SAME nested metadata object. Keying the
 * memo on the team would recompute (and re-render) on every status change.
 *
 * NEVER CALL THIS DIRECTLY FROM A TEMPLATE. A function call in a binding runs
 * on every change-detection cycle and returns a fresh array of fresh objects,
 * which `NgForOf` reads as "every item replaced" — it destroys and rebuilds
 * every chip each tick. Go through the pipe.
 *
 * `excludeKey` REMOVES one key from the result, and exists for exactly one
 * caller: a surface that renders the title field somewhere of its own (Epic
 * 53). The title is an ordinary metadata key, so a surface that promotes it to
 * a heading and does NOT exclude it here shows the same value twice in the
 * same row — which reads as duplicated data rather than as a layout slip. A
 * surface that renders no title passes nothing and sees today's behaviour.
 */
export function metadataEntries(
  metadata: Record<string, unknown> | null | undefined,
  excludeKey?: string | null,
): TeamMetadataEntry[] {
  if (!metadata) {
    return [];
  }
  return Object.entries(metadata)
    .filter(([key]) => key !== excludeKey)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => ({
      key,
      label: metadataKeyLabel(key),
      value: metadataValue(value),
    }))
    .filter((entry) => entry.value.trim() !== '');
}

/**
 * Which metadata key a namespace's contract nominates as the team's TITLE, or
 * `null` when it nominates none.
 *
 * THE SINGLE PLACE that question is answered. `is_title` is documented as "at
 * most one field", but that is a server-side rule and a malformed contract can
 * declare two. Resolving in DECLARATION ORDER — `fields` arrives in the order
 * the model declares them, always, and `Array.prototype.find` walks it in that
 * order — makes the malformed case DETERMINISTIC: the same contract yields the
 * same title on every render, on every machine, in every browser. Resolving it
 * by walking the metadata object's own keys instead would make the answer
 * depend on the shape of one team's data rather than on the contract.
 *
 * Takes the CONTRACT rather than the `NamespaceSummary` that holds it, so the
 * two spellings of "this namespace declares nothing" — an absent key and an
 * explicit `null` — collapse at the one boundary that has to know about them.
 */
export function titleFieldKey(
  contract: TeamMetadataContract | null | undefined,
): string | null {
  const field = contract?.fields.find((f) => f.is_title === true);
  return field?.key ?? null;
}

/**
 * One team's title: the value its metadata carries under `titleKey`, rendered
 * as a single line of text — or `null` when there is no title to show.
 *
 * `null` covers every "no title" state, and they are not the same thing:
 * the namespace nominates no field (`titleKey` is `null`), the team predates
 * the contract and carries no metadata at all, the key is simply unanswered,
 * or — the one that is easy to miss — GENERATION RAN AND RETURNED `""`. An
 * empty string is not a title; a blank heading over a row is strictly worse
 * than the team type, because it looks like a value that failed to load. Every
 * one of those falls back, by the same rule `metadataEntries` already applies
 * to a chip.
 *
 * The value is TEXT and is rendered as text. It is generated, which makes it
 * untrusted: it goes through interpolation, never `innerHTML`, and nothing
 * here builds markup for a caller to hand to a sanitiser bypass.
 *
 * Truncation is NOT applied here. Where to cut depends on the width of the
 * surface, which only the surface knows; the display layer ellipsises in CSS
 * and keeps the full string in a tooltip, so nothing is silently lost.
 */
export function teamTitle(
  metadata: Record<string, unknown> | null | undefined,
  titleKey: string | null | undefined,
): string | null {
  if (!metadata || !titleKey) {
    return null;
  }
  const raw = metadata[titleKey];
  if (raw === null || raw === undefined) {
    return null;
  }
  const text = metadataValue(raw);
  return text.trim() === '' ? null : text;
}
