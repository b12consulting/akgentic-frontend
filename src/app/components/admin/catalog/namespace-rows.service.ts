import { Injectable, inject } from '@angular/core';

import { ApiService } from '../../../core/http/api.service';
import {
  ENTRY_KINDS,
  Entry,
  EntryKind,
} from '../../../protocol/catalog.interface';
import { NamespaceRow, NamespaceRowsResult } from './namespace-row.model';

/**
 * Kinds consulted, in order, to resolve a namespace's owner.
 *
 * This mirrors the server's `require_namespace_owner_or_admin`, which reads the
 * `kind="team"` entry's `user_id` and falls back to `kind="meta"`. Reading
 * `user_id` off an arbitrary entry is the tempting shortcut and it is wrong: a
 * namespace's tools can carry a different `user_id` than its team.
 */
const OWNER_ANCHOR_KINDS: readonly EntryKind[] = ['team', 'meta'];

/**
 * One kind's entries, bucketed by namespace in response order.
 *
 * Grouping once per kind is what keeps the composition linear in the size of
 * the catalog. Re-scanning a kind's flat list for every namespace instead is
 * correct but quadratic, and this page is exactly where that bites: `all: true`
 * hands an admin every tenant's namespaces AND every tenant's entries at once,
 * on the browser's main thread.
 */
type EntriesByNamespace = Map<string, Entry[]>;

/**
 * Bucket one kind's flat response by namespace, PRESERVING response order
 * inside each bucket — the owner anchor reads the first entry of a bucket, so
 * the order is load-bearing, not incidental.
 */
function groupByNamespace(entries: Entry[]): EntriesByNamespace {
  const byNamespace: EntriesByNamespace = new Map();
  for (const entry of entries) {
    const bucket = byNamespace.get(entry.namespace);
    if (bucket) {
      bucket.push(entry);
    } else {
      byNamespace.set(entry.namespace, [entry]);
    }
  }
  return byNamespace;
}

/**
 * Composes the admin catalog's `NamespaceRow` list out of the catalog endpoints
 * that already exist — no new server surface (ADR-028 §D6).
 *
 * SEVEN requests paint the whole page, regardless of how many namespaces there
 * are: one `GET /admin/catalog/namespaces` for the row set, plus ONE
 * `GET /admin/catalog/{kind}` per kind, each returning every namespace's entries
 * of that kind, grouped client-side. A per-namespace loop would be 30+ calls on
 * a five-namespace catalog and would grow with it.
 *
 * All seven leave together and are awaited separately — the kind calls do not
 * queue behind the namespaces round trip, so the pane costs one round trip to
 * paint rather than two.
 *
 * The spine propagates, the columns degrade: the namespaces call is awaited on
 * its own and allowed to reject (there is no row set to degrade to), while the
 * six kind calls are gathered with `Promise.allSettled` so one 500 costs one
 * column instead of the page.
 *
 * Component-scoped by design (ADR-015 §2b) — a bare `@Injectable()` provided by
 * the pane that consumes it, never a root singleton.
 */
@Injectable()
export class NamespaceRowsService {
  readonly #api = inject(ApiService);

  /**
   * Load one page's worth of rows.
   *
   * `opts.all` is threaded to ALL SEVEN calls, so the entries counted are drawn
   * from the same visibility scope as the row list. Mixing the two would count
   * over a wider set than the rows came from. The flag is honoured server-side
   * for admins only and silently ignored otherwise.
   *
   * Rejects if the namespaces call rejects — an empty result would assert "this
   * deployment has no namespaces" for a request that never got an answer.
   */
  async getRows(opts?: { all?: boolean }): Promise<NamespaceRowsResult> {
    const all = opts?.all ?? false;

    // Issue all seven, then await them separately. `allSettled` never rejects,
    // so a rejecting namespaces call cannot leave the gather unhandled.
    const summariesPending = this.#api.getNamespaces({ all });
    const kindsPending = Promise.allSettled(
      ENTRY_KINDS.map((kind) => this.#api.getEntries(kind, { all })),
    );

    const summaries = await summariesPending;
    const settled = await kindsPending;

    const entriesByKind = new Map<EntryKind, EntriesByNamespace>();
    const unavailableKinds: EntryKind[] = [];
    ENTRY_KINDS.forEach((kind, i) => {
      const outcome = settled[i];
      if (outcome.status === 'fulfilled') {
        entriesByKind.set(kind, groupByNamespace(outcome.value));
      } else {
        entriesByKind.set(kind, new Map());
        unavailableKinds.push(kind);
      }
    });

    // The namespaces response — not the entries — decides which rows exist, in
    // its order. Entries for a namespace absent from it are grouped and
    // discarded, mirroring the server's own discovery rule.
    const rows = summaries.map((summary) => ({
      ...summary,
      owner: this.#resolveOwner(summary.namespace, entriesByKind),
      counts: this.#countsFor(summary.namespace, entriesByKind),
    }));

    return { rows, unavailableKinds };
  }

  /**
   * Entry counts for one namespace, seeded at zero from `ENTRY_KINDS` — never
   * from the keys the responses happened to contain, so every row carries all
   * six keys whether or not the namespace holds entries of that kind.
   */
  #countsFor(
    namespace: string,
    entriesByKind: Map<EntryKind, EntriesByNamespace>,
  ): Record<EntryKind, number> {
    const counts = {} as Record<EntryKind, number>;
    for (const kind of ENTRY_KINDS) {
      counts[kind] = entriesByKind.get(kind)?.get(namespace)?.length ?? 0;
    }
    return counts;
  }

  /**
   * Owner of one namespace: the first `team` entry carrying a usable `user_id`,
   * else the first such `meta` entry, else `null`.
   *
   * An entry whose `user_id` is empty, null or absent does not carry an owner,
   * so it never short-circuits the fallback. Where a namespace holds several
   * entries of an anchor kind, response order decides — deterministically.
   */
  #resolveOwner(
    namespace: string,
    entriesByKind: Map<EntryKind, EntriesByNamespace>,
  ): string | null {
    for (const kind of OWNER_ANCHOR_KINDS) {
      const owner = (entriesByKind.get(kind)?.get(namespace) ?? []).find(
        (entry) => !!entry.user_id,
      )?.user_id;
      if (owner) {
        return owner;
      }
    }
    return null;
  }
}
