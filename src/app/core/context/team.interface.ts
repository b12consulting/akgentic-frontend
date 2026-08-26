/**
 * V2 Team data model — replaces ProcessContext from V1.
 * Maps to Python TeamResponse, EventResponse from akgentic.infra.server.models.
 */

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

/** Check if a team is currently running. */
export function isRunning(team: TeamContext): boolean {
  return team.status === 'running';
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

/** Humanise a metadata key for display: `case_id` -> `Case id`. */
function metadataLabel(key: string): string {
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
 */
export function metadataEntries(
  metadata: Record<string, unknown> | null | undefined,
): TeamMetadataEntry[] {
  if (!metadata) {
    return [];
  }
  return Object.entries(metadata)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => ({
      key,
      label: metadataLabel(key),
      value: metadataValue(value),
    }))
    .filter((entry) => entry.value.trim() !== '');
}
