/**
 * Catalog data models — map to catalog-service DTOs.
 */

/**
 * One kind's entry tally for one namespace — an OBJECT, never a bare number.
 *
 * Mirrors the server's `NamespaceKindCount`. The nesting is deliberate: a
 * second tally (an `imported` count) is wanted later, and the object shape
 * makes that an ADDITIVE field instead of a breaking reshape of a response
 * this client already parses. Flattening it here to `number` would force
 * exactly the migration the shape was chosen to avoid.
 */
export interface NamespaceKindCount {
  total: number;
}

/**
 * Flat summary of a catalog namespace, returned by `GET /catalog/namespaces`.
 *
 * Maps to the catalog backend's `NamespaceSummary` DTO (catalog Story 16.6):
 * a purpose-built, picker-friendly shape — no `Entry` envelope, no payload,
 * no user/parent/model metadata.
 *
 * All EIGHT fields the server pins are declared here, in its declaration
 * order: the original six, then `owner` and `counts`, both folded onto this
 * DTO server-side so the admin catalog pane paints from ONE request instead of
 * composing seven client-side. Every field is REQUIRED, not optional: the
 * server always sends them, and an optional field would reintroduce the
 * absent-vs-false (and absent-vs-zero) ambiguity that renders a public
 * namespace as private, or an empty namespace as uncounted.
 *
 * * `team` — a `kind="team"` entry exists (false for team-less libraries).
 * * `shareable` — the `kind="meta"` entry's `payload.shareable` is `true`.
 * * `public` — the `kind="meta"` entry's `payload.public` is `true`.
 * * `owner` — the `kind="team"` entry's `user_id`, falling back to the
 *   `kind="meta"` entry's, `null` when neither carries one. This is the same
 *   ownership anchor the server's own owner-or-admin gate resolves, so a
 *   client-side "can I modify this?" check cannot disagree with the gate that
 *   will actually answer the request. `null` reads as "unknown owner" and must
 *   fail closed.
 * * `counts` — per-kind entry tallies. ALWAYS carries all six
 *   {@link ENTRY_KINDS} keys, zero-valued where the namespace holds none of
 *   that kind, so a consumer never has to distinguish an absent key from a
 *   zero. Tallied through the server's visibility-filtered listing, so the
 *   numbers agree with what this caller could actually list.
 */
export interface NamespaceSummary {
  namespace: string;
  name: string;
  description: string;
  team: boolean;
  shareable: boolean;
  public: boolean;
  owner: string | null;
  counts: Record<EntryKind, NamespaceKindCount>;
}

/**
 * The six catalog entry kinds, as a runtime tuple.
 *
 * Mirrors the server-side `EntryKind` literal at
 * `packages/akgentic-catalog/src/akgentic/catalog/models/entry.py`:
 * `Literal["team", "agent", "tool", "model", "prompt", "meta"]`.
 *
 * `team`, `agent`, `tool` keep v1 semantics; `model` and `prompt` are new in
 * v2 (promoted to first-class so they can be referenced via the ref-sentinel
 * mechanism); `meta` carries the namespace's own metadata entry.
 *
 * Callers that need to iterate the kinds (the admin catalog's counts cell, a
 * fixture seeding every key at zero) use this tuple, and `EntryKind` is derived
 * from it — so the runtime list and the type can never disagree.
 */
export const ENTRY_KINDS = [
  'team',
  'agent',
  'tool',
  'model',
  'prompt',
  'meta',
] as const;

/** One catalog entry kind — derived from {@link ENTRY_KINDS}. */
export type EntryKind = (typeof ENTRY_KINDS)[number];

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
