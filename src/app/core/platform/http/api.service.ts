import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../auth/auth.service';
import { ConfigService } from '../config/config.service';
import { FetchService } from './fetch.service';
import {
  TeamContext,
  TeamFilter,
  TeamPage,
  TeamResponse,
  TeamListResponse,
  EventResponse,
  EventListResponse,
  AgentStateResponse,
  AgentStateListResponse,
  toTeamContext,
} from '../context/team.interface';
import {
  Entry,
  NamespaceSummary,
  NamespaceValidationReport,
} from '../../protocol/catalog.interface';
import {
  CLOSED_NOTIFICATION_MODEL,
  EVENT_MESSAGE_MODEL,
} from '../../protocol/message.types';

/**
 * How many characters a metadata filter term must have before it is sent
 * (Epic 48).
 *
 * A UX affordance, not a correctness guard: the server already treats an empty
 * term as no term (its index entry `"key|"` prefix-matches everything for that
 * key). The floor exists so that a list of thousands is not repainted on the
 * first letter. It lives at EXACTLY ONE POINT — where the parameter is
 * composed, just below — and nothing above or below it re-decides whether a
 * term is meaningful. A second, disagreeing check in the component, the
 * context service or the template is the bug this constant is placed here to
 * prevent.
 */
export const MIN_FILTER_TERM_LENGTH = 3;

@Injectable({
  providedIn: 'root',
})
export class ApiService {
  fetchService: FetchService = inject(FetchService);
  authService: AuthService = inject(AuthService);
  router: Router = inject(Router);
  private config = inject(ConfigService);

  private get apiUrl(): string { return this.config.api; }

  // --- Team CRUD (AC1) ---

  async getTeams(): Promise<TeamContext[]> {
    const response: TeamListResponse = await this.fetchService.fetch({
      url: `${this.apiUrl}/teams`,
    });
    // The coalescing covers a genuinely empty or 204 body ONLY. A failed
    // request never lands here — it throws (ADR-026) — so an empty list now
    // means the server really has no teams, not that we could not ask.
    const teams = response?.teams ?? [];
    return teams.map(toTeamContext);
  }

  /**
   * Classic offset+total page of teams (Epic 28). Issues `GET /teams?page&size`
   * — bare `/teams` when both args are omitted (server applies its defaults:
   * page 1 / size 250). A provided arg is appended even if it equals the
   * server default. Maps `teams` via `toTeamContext` and carries `total_count`
   * through; a missing/empty body yields `teams: []`, `total_count: 0`.
   *
   * `filter` (Epic 48) appends the metadata query, in a fixed order — `page`,
   * `size`, then `meta.*`, then `catalog_namespace`:
   *
   *   - one `meta.<key>=<term>` per entry of `filter.meta`, via `append` and
   *     not `set`, because the parameter is repeatable on the wire (terms
   *     within one key OR, distinct keys AND) even though this client's UI
   *     never produces a second term for one key;
   *   - `catalog_namespace=<identifier>` only when `filter.catalogNamespace`
   *     is non-null — an off narrowing control leaves the parameter ABSENT
   *     from the URL, never empty and never `null`.
   *
   * THE THREE-CHARACTER FLOOR IS APPLIED HERE AND NOWHERE ELSE, on the trimmed
   * term. The trimmed value is what both the floor check and the emitted
   * parameter see, so the two cannot disagree: a leading space is never an
   * intentional prefix, and one rule that cannot contradict itself is worth
   * more than the trailing-space power user nobody has.
   *
   * The term is otherwise untouched — not casefolded (the server casefolds at
   * index derivation) and not regex/`LIKE`-escaped (the server's query seam
   * owns that). `URLSearchParams` percent-encoding is this client's whole
   * contribution, so `50%` and `a.b` travel verbatim to the server's problem.
   *
   * An absent or empty filter contributes NOTHING, so `getTeamsPage(1, 250)`
   * issues byte for byte the URL it issued before Epic 48.
   */
  async getTeamsPage(
    page?: number,
    size?: number,
    filter?: TeamFilter,
  ): Promise<TeamPage> {
    const params = new URLSearchParams();
    if (page !== undefined) {
      params.set('page', String(page));
    }
    if (size !== undefined) {
      params.set('size', String(size));
    }
    if (filter !== undefined) {
      for (const [key, term] of Object.entries(filter.meta)) {
        const trimmed = term.trim();
        if (trimmed.length >= MIN_FILTER_TERM_LENGTH) {
          params.append(`meta.${key}`, trimmed);
        }
      }
      if (filter.catalogNamespace !== null) {
        params.set('catalog_namespace', filter.catalogNamespace);
      }
    }
    const query = params.toString();
    const url = query ? `${this.apiUrl}/teams?${query}` : `${this.apiUrl}/teams`;

    const response: TeamListResponse = await this.fetchService.fetch({ url });
    // Empty/204 body only — a failed request throws rather than reaching here
    // (ADR-026), so an empty page is a real empty page.
    const teams = (response?.teams ?? []).map(toTeamContext);
    return { teams, total_count: response?.total_count ?? 0 };
  }

  async getTeam(teamId: string): Promise<TeamContext> {
    const response: TeamResponse = await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}`,
    });
    return toTeamContext(response);
  }

  /**
   * Create a team from a catalog namespace.
   *
   * `metadata` carries the answers to the metadata contract that namespace's
   * team declares (`NamespaceSummary.team_metadata`) — a flat key→value map
   * whose keys are the declared field keys. The client never names a type and
   * never sends a `__model__` tag: the server resolves the declared type from
   * the namespace itself.
   *
   * THE `metadata` KEY IS ATTACHED ONLY WHEN THE OBJECT IS PRESENT AND HAS AT
   * LEAST ONE ENTRY. An empty object contributes nothing, because `{}` is
   * truthy in JavaScript and a bare `if (metadata)` would send `"metadata":{}`.
   *
   * The no-metadata body is the pinned legacy shape —
   * `{"catalog_namespace":"<ns>","params":{}}`, byte for byte, with the two
   * keys in that order and no third key. Every namespace shipped today
   * declares no metadata, so every existing deployment travels this path. The
   * base object is built first and `metadata` assigned onto it afterwards
   * precisely so key insertion order puts the new key LAST and leaves the
   * first two exactly where they were; do not restructure this into a spread.
   */
  async createTeam(
    namespace: string,
    metadata?: Record<string, string>,
  ): Promise<TeamResponse> {
    const payload: {
      catalog_namespace: string;
      params: Record<string, unknown>;
      metadata?: Record<string, string>;
    } = { catalog_namespace: namespace, params: {} };

    if (metadata && Object.keys(metadata).length > 0) {
      payload.metadata = metadata;
    }

    return await this.fetchService.fetch({
      url: `${this.apiUrl}/teams`,
      options: {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      },
    });
  }

  async deleteTeam(teamId: string): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}`,
      options: { method: 'DELETE' },
      successMessage: 'Team deleted successfully',
    });
  }

  async stopTeam(teamId: string): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}/stop`,
      options: { method: 'POST' },
      successMessage: 'Team stopped successfully',
    });
  }

  async restoreTeam(teamId: string): Promise<TeamResponse> {
    return await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}/restore`,
      options: { method: 'POST' },
      successMessage: 'Team restored successfully',
    });
  }

  // --- Messaging (AC2) ---

  async sendMessage(
    teamId: string,
    content: string,
    agentName?: string | null
  ): Promise<void> {
    if (agentName) {
      return this.sendMessageTo(teamId, content, agentName);
    }
    await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}/message`,
      options: {
        method: 'POST',
        body: JSON.stringify({ content }),
        headers: { 'Content-Type': 'application/json' },
      },
    });
  }

  async sendMessageTo(
    teamId: string,
    content: string,
    agentName: string
  ): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}/message/${agentName}`,
      options: {
        method: 'POST',
        body: JSON.stringify({ content }),
        headers: { 'Content-Type': 'application/json' },
      },
    });
  }

  async sendMessageFromTo(
    teamId: string,
    senderName: string,
    recipientName: string,
    content: string
  ): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}/message/from/${senderName}/to/${recipientName}`,
      options: {
        method: 'POST',
        body: JSON.stringify({ content }),
        headers: { 'Content-Type': 'application/json' },
      },
    });
  }

  /** V2 processHumanInput: sends human input for a specific message in a team. */
  async processHumanInput(
    teamId: string,
    content: string,
    messageId: string
  ): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}/human-input`,
      options: {
        method: 'POST',
        body: JSON.stringify({ content, message_id: messageId }),
        headers: { 'Content-Type': 'application/json' },
      },
    });
  }

  /**
   * Record that the user dismissed a notification toast (Story 31-4).
   *
   * Posts a `ClosedNotification` domain event to the generic
   * `POST /teams/{teamId}/notification` route, which decodes any
   * `__model__`-tagged payload and publishes it through
   * `Orchestrator.emitMessage` — so the dismissal is both persisted and
   * streamed back to every subscriber, including this client. That echo (not
   * local optimistic state) is what feeds the closed-ids fold.
   *
   * TWO nested `__model__` tags are required: the `EventMessage` envelope, then
   * the `ClosedNotification` dataclass inside `event`. Only those two keys are
   * sent — every other `Message` field is defaulted server-side, and
   * `Orchestrator.emitMessage` overwrites `sender` / `team_id` / `parent_id` via
   * `Message.init` regardless of what the client sends, so naming them would be
   * misleading rather than defensive.
   *
   * No `successMessage`: a dismissal is not worth a success toast. A non-OK
   * response rejects with `HttpError` (and `FetchService` raises its own error
   * toast) — the caller catches it rather than adding a second one.
   */
  async emitClosedNotification(teamId: string, messageId: string): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}/notification`,
      options: {
        method: 'POST',
        body: JSON.stringify({
          message: {
            __model__: EVENT_MESSAGE_MODEL,
            event: {
              __model__: CLOSED_NOTIFICATION_MODEL,
              message_id: messageId,
            },
          },
        }),
        headers: { 'Content-Type': 'application/json' },
      },
    });
  }

  // --- Events (AC3) ---

  async getEvents(teamId: string): Promise<EventResponse[]> {
    const response: EventListResponse = await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}/events`,
    });
    // Empty/204 body only — a failed request throws (ADR-026). This site is why
    // the ADR exists: it used to render "this team has no events" for a browser
    // that never reached the server.
    return response?.events ?? [];
  }

  // --- Agent states (ADR-020 §2) ---

  /**
   * Per-agent state snapshots for a team — the read-path that seeds the
   * `state` store on init so the backstory head-block renders for STOPPED
   * teams (the durable event log carries no `StateChangedMessage`, ADR-013).
   * Mirrors `getEvents`: hits `GET /teams/{teamId}/agent-states` and unwraps
   * the `states` list, defaulting to `[]` when the body is absent/empty.
   * Each item's `agent_id` is the agent UUID (team Epic 23), so the caller
   * can key the `state` store directly with no name→UUID resolution.
   */
  async getAgentStates(teamId: string): Promise<AgentStateResponse[]> {
    const response: AgentStateListResponse = await this.fetchService.fetch({
      url: `${this.apiUrl}/teams/${teamId}/agent-states`,
    });
    // Empty/204 body only — a failed request throws (ADR-026), so an empty
    // snapshot list means the team genuinely has no per-agent state yet.
    return response?.states ?? [];
  }

  // --- Catalog ---

  /**
   * List catalog namespaces (flat summary) — powers the home-screen team
   * creation dropdown. Consumes catalog Story 16.6's `GET /catalog/namespaces`
   * endpoint, which returns `NamespaceSummary[]` directly (always a list,
   * even when empty).
   *
   * The optional `all` flag appends `?all=true`, the admin-only "see all"
   * lever: it surfaces every tenant's namespaces (not just owner+public).
   * `all=true` is honoured server-side ONLY for callers whose roles include
   * `admin`; a non-admin (or anonymous) caller sending it is silently treated
   * as the normal owner+public list (no error, no privilege grant). The flag
   * is therefore a convenience surface, not the authorization boundary — the
   * infra unscoping of admin reads is the boundary.
   */
  async getNamespaces(opts?: { all?: boolean }): Promise<NamespaceSummary[]> {
    const url = opts?.all
      ? `${this.apiUrl}/admin/catalog/namespaces?all=true`
      : `${this.apiUrl}/admin/catalog/namespaces`;
    return await this.fetchService.fetch({ url });
  }

  /**
   * Export a catalog namespace as raw YAML text.
   *
   * Hits `GET /admin/catalog/namespace/{namespace}/export` which returns
   * `application/yaml` — the response is consumed as text (not JSON).
   *
   * The optional `all` flag appends `?all=true` so an admin can open a
   * foreign-owned namespace surfaced by the home "show all" list. As with
   * `getNamespaces`, `all=true` is honoured server-side only for admins (the
   * `/admin/catalog/*` mount unscopes admin GETs); a non-admin sending it gets
   * the normal owner-scoped read. It widens reads only — never writes.
   */
  async exportNamespace(
    namespace: string,
    opts?: { all?: boolean },
  ): Promise<string> {
    const base = `${this.apiUrl}/admin/catalog/namespace/${namespace}/export`;
    const url = opts?.all ? `${base}?all=true` : base;
    return await this.fetchService.fetch({
      url,
      responseType: 'text',
    });
  }

  /**
   * Import (persist) a catalog namespace from YAML text.
   *
   * Hits `POST /admin/catalog/namespace/import`. The YAML is sent verbatim
   * as the request body with `Content-Type: application/yaml` — it is NOT
   * JSON-stringified or wrapped in any envelope. The response is parsed as
   * `Entry[]`.
   */
  async importNamespace(yaml: string): Promise<Entry[]> {
    return await this.fetchService.fetch({
      url: `${this.apiUrl}/admin/catalog/namespace/import`,
      options: {
        method: 'POST',
        body: yaml,
        headers: { 'Content-Type': 'application/yaml' },
      },
    });
  }

  /**
   * Validate a persisted catalog namespace by name.
   *
   * Hits `GET /admin/catalog/namespace/{namespace}/validate` and returns
   * the structured `NamespaceValidationReport`.
   */
  async validatePersistedNamespace(
    namespace: string
  ): Promise<NamespaceValidationReport> {
    return await this.fetchService.fetch({
      url: `${this.apiUrl}/admin/catalog/namespace/${namespace}/validate`,
    });
  }

  /**
   * Validate an in-memory YAML buffer against catalog invariants without
   * persisting it.
   *
   * Hits `POST /admin/catalog/namespace/validate` with the YAML verbatim as
   * the request body and `Content-Type: application/yaml`. Returns a
   * `NamespaceValidationReport`.
   */
  async validateNamespaceBuffer(
    yaml: string
  ): Promise<NamespaceValidationReport> {
    return await this.fetchService.fetch({
      url: `${this.apiUrl}/admin/catalog/namespace/validate`,
      options: {
        method: 'POST',
        body: yaml,
        headers: { 'Content-Type': 'application/yaml' },
      },
    });
  }

  /**
   * Delete a catalog namespace and all its entries.
   *
   * Hits `DELETE /admin/catalog/namespace/{namespace}` (ADR-028 §Decision 5).
   * A `204` resolves with no body (FetchService returns `undefined` for
   * 204 / empty-body responses). NO `successMessage` is passed — the panel
   * owns the success toast / live-region announcement so the messaging stays
   * consistent with the Clone flow. Non-2xx responses reject with an
   * `HttpError` carrying `.status` / `.body` so the caller can branch on
   * `403` (not-authorized), `409`/`422` (inbound-reference blocker), etc.
   */
  async deleteNamespace(namespace: string): Promise<void> {
    await this.fetchService.fetch({
      url: `${this.apiUrl}/admin/catalog/namespace/${namespace}`,
      options: { method: 'DELETE' },
    });
  }

  /** No-op stub: description editing is not available in V2. */
  async updateTeamDescription(
    _teamId: string,
    _description: string | null
  ): Promise<void> {
    console.warn('updateTeamDescription is not available in V2');
  }
}
