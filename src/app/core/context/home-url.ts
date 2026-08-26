import { ParamMap, Params } from '@angular/router';

import { TeamFilter } from './team.interface';

/**
 * The teams list's query string: what it means, and how to read and write it.
 *
 * Pure and self-contained, so the mapping can be tested without a component,
 * a router or a rendered page — and so there is exactly ONE place that knows
 * what `?meta.tenant=acme&only=1&page=3` means. The bug this module was
 * extracted to fix was two places disagreeing about it.
 *
 * Parameter names mirror the API's own rather than inventing a second
 * vocabulary for the same values.
 */

/** Query-string prefix for a metadata term, matching the API's `meta.<key>`. */
const META_PREFIX = 'meta.';

/**
 * Everything the teams list keeps in its URL.
 *
 * `namespace` is the selected team TYPE, and it is a separate axis from
 * `filter.catalogNamespace`: the latter is the narrowing toggle, which is off
 * far more often than a type is selected. It has to travel regardless, because
 * a metadata term is only sent for a field the selected type declares as
 * indexed — restoring a term under the wrong type drops it silently.
 */
export interface HomeUrlState {
  filter: TeamFilter;
  page: number;
  namespace: string | null;
}

/** Is anything actually narrowing the list? */
export function isFiltering(filter: TeamFilter): boolean {
  return Object.keys(filter.meta).length > 0 || filter.catalogNamespace !== null;
}

/**
 * Render the state as query parameters — only the ones that apply.
 *
 * Nothing is emitted as `null` to clear a stale parameter, because the caller
 * REPLACES the query string rather than merging into it. Merging would need
 * every possible key named on every write, and a key forgotten there is how a
 * stale term outlives the field it belonged to.
 *
 * Page 1 is not advertised: it is what the list shows without being asked.
 */
export function toQueryParams(state: HomeUrlState): Params {
  const params: Params = {};
  if (state.page > 1) {
    params['page'] = String(state.page);
  }
  if (!isFiltering(state.filter)) {
    return params;
  }
  if (state.namespace !== null) {
    params['type'] = state.namespace;
  }
  if (state.filter.catalogNamespace !== null) {
    params['only'] = '1';
  }
  for (const [key, term] of Object.entries(state.filter.meta)) {
    params[META_PREFIX + key] = term;
  }
  return params;
}

/**
 * Read an entry URL back into state.
 *
 * `minTermLength` is the same floor the request composition uses. Applying it
 * here too is what stops a hand-edited URL from producing a form that
 * disagrees with the list it is sitting above.
 *
 * Anything malformed reads as absent rather than raising: this parses an
 * address someone may have typed, and the worst outcome of a bad one should be
 * an unfiltered list, never a broken page.
 */
export function fromQueryParams(
  params: ParamMap,
  minTermLength: number,
): HomeUrlState {
  const page = Number(params.get('page') ?? '1');
  const namespace = params.get('type') || null;

  const meta: Record<string, string> = {};
  for (const name of params.keys) {
    if (!name.startsWith(META_PREFIX)) {
      continue;
    }
    const key = name.slice(META_PREFIX.length);
    const term = params.get(name) ?? '';
    if (key !== '' && term.trim().length >= minTermLength) {
      meta[key] = term;
    }
  }

  // The toggle needs a type to narrow TO, so it cannot outlive one.
  const only = params.get('only') === '1' && namespace !== null;

  return {
    filter: { meta, catalogNamespace: only ? namespace : null },
    page: Number.isFinite(page) && page > 1 ? Math.floor(page) : 1,
    namespace,
  };
}
