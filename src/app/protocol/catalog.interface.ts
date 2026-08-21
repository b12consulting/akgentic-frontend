/**
 * Catalog data models — map to catalog-service DTOs.
 */

/**
 * One declared field of a team's metadata contract.
 *
 * Mirrors the catalog backend's `MetadataFieldDescriptor` DTO. All four
 * properties are always emitted — none is optional on the wire:
 *
 * - `description` is `""` when the field declares none; the key is always
 *   present, so a consumer never has to distinguish absent from empty.
 * - `index` marks the field as filterable server-side.
 * - `mandatory` means required *and* not nullable.
 */
export interface MetadataFieldDescriptor {
  key: string;
  description: string;
  index: boolean;
  mandatory: boolean;
}

/**
 * The metadata contract a namespace's team declares — the questions that must
 * be answered before that team can be created.
 *
 * Mirrors the catalog backend's `TeamMetadataContract` DTO. `type` is the
 * declared dotted path, verbatim; `fields` arrives in declaration order,
 * always, so a renderer can lay the form out without sorting.
 */
export interface TeamMetadataContract {
  type: string;
  fields: MetadataFieldDescriptor[];
}

/**
 * How many entries of one kind a namespace holds.
 *
 * A one-field object, NOT a bare integer — the wire shape is
 * `{"team": {"total": 1}, "agent": {"total": 7}, …}`. The server wraps the
 * count deliberately so a future per-kind field (a breakdown, a cap) can be
 * added without reshaping a response consumers already parse. Typing the
 * enclosing record as `Record<string, number>` would compile and then be
 * wrong at runtime: `counts.team` is an object, and arithmetic on it is `NaN`.
 */
export interface NamespaceKindCount {
  total: number;
}

/**
 * Flat summary of a catalog namespace, returned by `GET /catalog/namespaces`.
 *
 * Maps to the catalog backend's `NamespaceSummary` DTO: a purpose-built,
 * picker-friendly shape — no `Entry` envelope and no payload. It is no longer
 * a bare name/description triple: the row carries ownership (`owner`),
 * visibility (`shareable`, `public`), whether it declares a team (`team`), a
 * per-kind entry census (`counts`), and the team's metadata contract
 * (`team_metadata`).
 *
 * Field order below follows the wire order.
 *
 * `counts` keys on `string` rather than on `EntryKind` deliberately: all six
 * kinds are always present (zero-valued where the namespace holds none of
 * that kind), and a `string` key costs nothing while not going stale when a
 * seventh kind is added server-side.
 */
export interface NamespaceSummary {
  namespace: string;
  name: string;
  description: string;
  team: boolean;
  shareable: boolean;
  public: boolean;
  owner: string | null;
  counts: Record<string, NamespaceKindCount>;
  /**
   * The metadata contract this namespace's team declares, or `null` when it
   * declares none — the state of every namespace shipped today.
   *
   * OPTIONAL *and* nullable, for two independent reasons, both real:
   *
   * 1. a server predating the catalog release that introduced this field does
   *    not send the key at all;
   * 2. even against a current server the field carries a default, so FastAPI
   *    leaves it out of OpenAPI's `required` list and a generated client
   *    types it possibly-`undefined` — although the server does emit the key
   *    on every row.
   *
   * CONSEQUENCE FOR EVERY CONSUMER: `undefined` and `null` MEAN THE SAME
   * THING — the team declares no contract. A consumer that gates on
   * `=== null` alone is broken; gate on falsiness, or on both states.
   *
   * A declared contract whose `fields` list is empty is a THIRD, distinct
   * state (a type is declared and it has no fields). This client is free to
   * collapse it onto "ask nothing", but that collapse belongs to the consumer,
   * not to this type.
   */
  team_metadata?: TeamMetadataContract | null;
}

/**
 * The five catalog entry kinds.
 *
 * Mirrors the server-side `EntryKind` literal at
 * `packages/akgentic-catalog/src/akgentic/catalog/models/entry.py`:
 * `Literal["team", "agent", "tool", "model", "prompt"]`.
 *
 * `team`, `agent`, `tool` keep v1 semantics; `model` and `prompt` are new in
 * v2 (promoted to first-class so they can be referenced via the ref-sentinel
 * mechanism).
 */
export type EntryKind = 'team' | 'agent' | 'tool' | 'model' | 'prompt';

/**
 * Unified v2 catalog entry — mirrors the server's Pydantic `Entry` model at
 * `packages/akgentic-catalog/src/akgentic/catalog/models/entry.py`.
 *
 * Field names are translated verbatim (snake_case), matching the wire shape
 * — no camelCase rewriting.
 *
 */
export interface Entry {
  id: string;
  kind: EntryKind;
  namespace: string;
  user_id: string;
  model_type: string;
  description: string;
  payload: Record<string, unknown>;
}

/**
 * Per-entry validation issue — mirrors the server's `EntryValidationIssue`
 * at `packages/akgentic-catalog/src/akgentic/catalog/validation.py`.
 */
export interface EntryValidationIssue {
  entry_id: string;
  kind: EntryKind;
  errors: string[];
}

/**
 * Namespace-level validation report — mirrors the server's
 * `NamespaceValidationReport` at
 * `packages/akgentic-catalog/src/akgentic/catalog/validation.py`.
 *
 * `ok` is a derived invariant on the server: true iff `global_errors` is
 * empty AND every `entry_issues[].errors` list is empty. Clients can branch
 * on `ok` alone — no need to re-check the two lists.
 *
 * `namespace` is nullable because the server returns `null` when the bundle
 * is empty (no entries to derive a namespace from).
 */
export interface NamespaceValidationReport {
  namespace: string | null;
  ok: boolean;
  global_errors: string[];
  entry_issues: EntryValidationIssue[];
}
