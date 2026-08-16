import {
  Entry,
  EntryKind,
  NamespaceSummary,
} from '../../../protocol/catalog.interface';

/**
 * Wire-shaped fixtures for the `NamespaceRowsService` spec.
 *
 * The STRUCTURE is what matters and it is the live catalog's: five namespaces,
 * two of them team-less libraries, several kinds absent from several
 * namespaces. Names are placeholders (`acme` / `contoso`); they are incidental.
 *
 * Entries are built as full `Entry` objects, exactly as they arrive over the
 * wire, so the spec exercises the same grouping path as production rather than
 * a pre-digested shape.
 */

/** One wire-shaped `Entry`. */
export function entry(
  kind: EntryKind,
  namespace: string,
  id: string,
  userId = 'anonymous',
): Entry {
  return {
    id,
    kind,
    namespace,
    user_id: userId,
    model_type: `${kind}Model`,
    description: `${kind} ${id}`,
    payload: {},
  };
}

/** `n` wire-shaped entries of one kind for one namespace. */
export function entries(
  kind: EntryKind,
  namespace: string,
  n: number,
  userId = 'anonymous',
): Entry[] {
  return Array.from({ length: n }, (_, i) =>
    entry(kind, namespace, `${namespace}-${kind}-${i + 1}`, userId),
  );
}

/** One wire-shaped `NamespaceSummary`. */
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
    ...overrides,
  };
}

/**
 * `GET /admin/catalog/namespaces` — the row set, in response order.
 *
 * `global` and `global-tools` are the load-bearing rows: team-less library
 * namespaces that a composition keyed off the team list would silently drop.
 */
export const NAMESPACES: NamespaceSummary[] = [
  summary('acme-team'),
  summary('acme-coding'),
  summary('contoso-product'),
  summary('global', { team: false, public: true }),
  summary('global-tools', { team: false, public: true }),
];

/**
 * The per-namespace, per-kind counts the fixture below encodes — the table
 * `getRows` must reproduce.
 */
export const EXPECTED_COUNTS: Record<string, Record<EntryKind, number>> = {
  'acme-team': { team: 1, agent: 5, tool: 0, model: 0, prompt: 1, meta: 1 },
  'acme-coding': { team: 1, agent: 6, tool: 3, model: 1, prompt: 5, meta: 1 },
  'contoso-product': { team: 1, agent: 6, tool: 3, model: 2, prompt: 5, meta: 1 },
  global: { team: 0, agent: 0, tool: 7, model: 10, prompt: 0, meta: 1 },
  'global-tools': { team: 0, agent: 0, tool: 8, model: 0, prompt: 0, meta: 1 },
};

/**
 * `GET /admin/catalog/{kind}` — one flat list per kind, spanning every
 * namespace, exactly as the server returns it.
 */
export const ENTRIES_BY_KIND: Record<EntryKind, Entry[]> = {
  team: [
    ...entries('team', 'acme-team', 1),
    ...entries('team', 'acme-coding', 1),
    ...entries('team', 'contoso-product', 1),
  ],
  agent: [
    ...entries('agent', 'acme-team', 5),
    ...entries('agent', 'acme-coding', 6),
    ...entries('agent', 'contoso-product', 6),
  ],
  tool: [
    ...entries('tool', 'acme-coding', 3),
    ...entries('tool', 'contoso-product', 3),
    ...entries('tool', 'global', 7),
    ...entries('tool', 'global-tools', 8),
  ],
  model: [
    ...entries('model', 'acme-coding', 1),
    ...entries('model', 'contoso-product', 2),
    ...entries('model', 'global', 10),
  ],
  prompt: [
    ...entries('prompt', 'acme-team', 1),
    ...entries('prompt', 'acme-coding', 5),
    ...entries('prompt', 'contoso-product', 5),
  ],
  meta: [
    ...entries('meta', 'acme-team', 1),
    ...entries('meta', 'acme-coding', 1),
    ...entries('meta', 'contoso-product', 1),
    ...entries('meta', 'global', 1),
    ...entries('meta', 'global-tools', 1),
  ],
};
