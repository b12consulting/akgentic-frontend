import {
  EntryKind,
  NamespaceSummary,
} from '../../../protocol/catalog.interface';

/**
 * One row of the admin catalog table: a `NamespaceSummary` plus the two facts
 * the server does not yet send — who owns the namespace, and how many entries
 * of each kind it holds.
 *
 * The field list is EXACTLY the summary's six fields plus `owner` and `counts`,
 * and deliberately nothing more. `akgentic-catalog` ADR-021 folds both onto
 * `NamespaceSummary` server-side; when that lands, this interface becomes the
 * DTO verbatim and the composing service is deleted rather than migrated. A
 * stray extra field here would turn that deletion back into a migration — so
 * page-level state (which kinds failed to load) rides on
 * {@link NamespaceRowsResult} instead of on the row.
 */
export interface NamespaceRow extends NamespaceSummary {
  /**
   * `user_id` of the namespace's `kind="team"` entry, falling back to its
   * `kind="meta"` entry, `null` when neither carries one.
   *
   * This mirrors the server's own ownership anchor (`require_namespace_owner_
   * or_admin`), so a client-side "can I modify this?" gate cannot disagree with
   * the gate that will actually answer the request. `null` therefore reads as
   * "unknown owner" and must fail closed.
   */
  owner: string | null;

  /**
   * Entry count per kind. ALWAYS carries all six `ENTRY_KINDS` keys, zero-valued
   * where the namespace holds none of that kind — a consumer must never have to
   * distinguish an absent key from a zero.
   *
   * A kind whose list call failed reads `0` here too; the page-level
   * `unavailableKinds` on {@link NamespaceRowsResult} is what tells a renderer
   * to show "—" rather than a confident "0".
   */
  counts: Record<EntryKind, number>;
}

/**
 * What one page load of the admin catalog yields: the rows, plus which kinds
 * could not be counted.
 *
 * `unavailableKinds` is a PAGE-level fact, not a per-row one — the kind calls
 * are one request each across all namespaces, so a failure blanks that column
 * everywhere at once. Keeping it here leaves `counts` as a total
 * `Record<EntryKind, number>` with no "unknown" member.
 */
export interface NamespaceRowsResult {
  rows: NamespaceRow[];
  unavailableKinds: EntryKind[];
}
