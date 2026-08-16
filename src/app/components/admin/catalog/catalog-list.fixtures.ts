import {
  ENTRY_KINDS,
  EntryKind,
  NamespaceKindCount,
  NamespaceSummary,
} from '../../../protocol/catalog.interface';

/**
 * Wire-shaped fixtures for the admin catalog pane's spec.
 *
 * The STRUCTURE is what matters and it is the live catalog's: five namespaces,
 * two of them team-less libraries, several kinds absent from several
 * namespaces. Names are placeholders (`acme` / `contoso`); they are incidental.
 *
 * Story 36-8 collapsed the seven-request composition into ONE response, so this
 * file no longer builds `Entry` objects for a client-side grouping to bucket:
 * it builds the single `NamespaceSummary[]` the server now sends, counts and
 * owner included. The five-namespace shape and its per-kind numbers survive the
 * migration deliberately — the pane must reproduce the same rows it did before.
 */

/** A complete six-key tally map, seeded at zero — never a partial one. */
export function zeroCounts(): Record<EntryKind, NamespaceKindCount> {
  const counts = {} as Record<EntryKind, NamespaceKindCount>;
  for (const kind of ENTRY_KINDS) {
    counts[kind] = { total: 0 };
  }
  return counts;
}

/**
 * A tally map from a per-kind number map — every key present, so a fixture can
 * never accidentally hand the pane a `counts` object missing a kind.
 */
export function countsOf(
  totals: Record<EntryKind, number>,
): Record<EntryKind, NamespaceKindCount> {
  const counts = zeroCounts();
  for (const kind of ENTRY_KINDS) {
    counts[kind] = { total: totals[kind] };
  }
  return counts;
}

/** One wire-shaped `NamespaceSummary`, all eight fields. */
export function summary(
  namespace: string,
  overrides: Partial<NamespaceSummary> = {},
): NamespaceSummary {
  return {
    namespace,
    name: namespace,
    description: `${namespace} description`,
    team: true,
    shareable: false,
    public: false,
    owner: 'anonymous',
    counts: zeroCounts(),
    ...overrides,
  };
}

/**
 * The per-namespace, per-kind totals the response below encodes — the table the
 * pane must render.
 */
export const EXPECTED_COUNTS: Record<string, Record<EntryKind, number>> = {
  'acme-team': { team: 1, agent: 5, tool: 0, model: 0, prompt: 1, meta: 1 },
  'acme-coding': { team: 1, agent: 6, tool: 3, model: 1, prompt: 5, meta: 1 },
  'contoso-product': { team: 1, agent: 6, tool: 3, model: 2, prompt: 5, meta: 1 },
  global: { team: 0, agent: 0, tool: 7, model: 10, prompt: 0, meta: 1 },
  'global-tools': { team: 0, agent: 0, tool: 8, model: 0, prompt: 0, meta: 1 },
};

/**
 * `GET /admin/catalog/namespaces` — the WHOLE page, in response order.
 *
 * `global` and `global-tools` are the load-bearing rows: team-less library
 * namespaces that a row set keyed off the team list would silently drop.
 */
export const NAMESPACES: NamespaceSummary[] = [
  summary('acme-team', { counts: countsOf(EXPECTED_COUNTS['acme-team']) }),
  summary('acme-coding', { counts: countsOf(EXPECTED_COUNTS['acme-coding']) }),
  summary('contoso-product', {
    counts: countsOf(EXPECTED_COUNTS['contoso-product']),
  }),
  summary('global', {
    team: false,
    public: true,
    counts: countsOf(EXPECTED_COUNTS['global']),
  }),
  summary('global-tools', {
    team: false,
    public: true,
    counts: countsOf(EXPECTED_COUNTS['global-tools']),
  }),
];
