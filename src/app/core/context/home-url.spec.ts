import { convertToParamMap } from '@angular/router';

import { fromQueryParams, isFiltering, toQueryParams } from './home-url';
import { NO_TEAM_FILTER, TeamFilter } from './team.interface';

const MIN = 3;

function filter(overrides: Partial<TeamFilter> = {}): TeamFilter {
  return { meta: {}, catalogNamespace: null, ...overrides };
}

describe('home-url', () => {
  describe('toQueryParams', () => {
    it('emits nothing for an unfiltered first page', () => {
      expect(
        toQueryParams({ filter: NO_TEAM_FILTER, page: 1, namespace: 'acme', team: null }),
      ).toEqual({});
    });

    it('does not advertise page 1, and does advertise any other page', () => {
      const state = { filter: NO_TEAM_FILTER, namespace: null, team: null };
      expect(toQueryParams({ ...state, page: 1 })).toEqual({});
      expect(toQueryParams({ ...state, page: 3 })).toEqual({ page: '3' });
    });

    it('carries the team type only when a filter depends on it', () => {
      // A term is sent only for a field the SELECTED type declares as indexed,
      // so restoring one under the wrong type drops it silently. With nothing
      // filtered the type is not load-bearing and the URL stays clean.
      expect(
        toQueryParams({ filter: NO_TEAM_FILTER, page: 1, namespace: 'acme', team: null }),
      ).toEqual({});
      expect(
        toQueryParams({
          filter: filter({ meta: { case_id: 'C-1' } }),
          page: 1,
          namespace: 'acme',
          team: null,
        }),
      ).toEqual({ type: 'acme', 'meta.case_id': 'C-1' });
    });

    it('renders the narrowing toggle and every term', () => {
      expect(
        toQueryParams({
          filter: { meta: { case_id: 'C-1', tenant: 'ac' }, catalogNamespace: 'acme' },
          page: 2,
          namespace: 'acme',
          team: null,
        }),
      ).toEqual({
        page: '2',
        type: 'acme',
        only: '1',
        'meta.case_id': 'C-1',
        'meta.tenant': 'ac',
      });
    });

    // --- the open team (Epic 52) -----------------------------------------

    it('carries the open team, on its own, with nothing else in the URL', () => {
      // The team is an axis of its own. It travels on an UNFILTERED first page
      // — where the URL is otherwise empty — which `type` / `only` / `meta.*`
      // deliberately do not.
      expect(
        toQueryParams({
          filter: NO_TEAM_FILTER,
          page: 1,
          namespace: 'acme',
          team: 'team-9',
        }),
      ).toEqual({ team: 'team-9' });
    });

    it('carries the open team alongside a filter and a page', () => {
      expect(
        toQueryParams({
          filter: filter({ meta: { case_id: 'C-1' } }),
          page: 2,
          namespace: 'acme',
          team: 'team-9',
        }),
      ).toEqual({
        page: '2',
        team: 'team-9',
        type: 'acme',
        'meta.case_id': 'C-1',
      });
    });

    it('emits nothing for a list with no team open', () => {
      expect(
        toQueryParams({
          filter: NO_TEAM_FILTER,
          page: 1,
          namespace: null,
          team: null,
        }),
      ).toEqual({});
    });
  });

  describe('fromQueryParams', () => {
    it('reads the open team', () => {
      expect(
        fromQueryParams(convertToParamMap({ team: 'team-9' }), MIN).team,
      ).toBe('team-9');
    });

    it('reads no team, and an EMPTY team, as no team', () => {
      // `?team=` names nothing. Adopting `''` would put the split on screen
      // around a process view with nothing to show.
      expect(fromQueryParams(convertToParamMap({}), MIN).team).toBeNull();
      expect(
        fromQueryParams(convertToParamMap({ team: '' }), MIN).team,
      ).toBeNull();
    });

    it('reads terms, the toggle, the type and the page', () => {
      const state = fromQueryParams(
        convertToParamMap({
          page: '3',
          type: 'acme',
          only: '1',
          'meta.case_id': 'C-1234',
        }),
        MIN,
      );

      expect(state.page).toBe(3);
      expect(state.namespace).toBe('acme');
      expect(state.filter).toEqual({
        meta: { case_id: 'C-1234' },
        catalogNamespace: 'acme',
      });
    });

    it('round-trips whatever toQueryParams produced', () => {
      const original = {
        filter: { meta: { case_id: 'C-1', tenant: 'acme' }, catalogNamespace: 'ns-1' },
        page: 4,
        namespace: 'ns-1',
        team: 'team-9',
      };

      expect(
        fromQueryParams(convertToParamMap(toQueryParams(original)), MIN),
      ).toEqual(original);
    });

    it('drops a term below the floor', () => {
      // The same floor the request composition uses, so a hand-edited URL
      // cannot produce a form that disagrees with the list above it.
      const state = fromQueryParams(
        convertToParamMap({ type: 'acme', 'meta.case_id': 'C' }),
        MIN,
      );

      expect(state.filter.meta).toEqual({});
    });

    it('ignores the toggle when no type is named — it has nothing to narrow to', () => {
      const state = fromQueryParams(convertToParamMap({ only: '1' }), MIN);

      expect(state.filter.catalogNamespace).toBeNull();
    });

    it('reads a malformed page as page 1 rather than raising', () => {
      // This parses an address someone may have typed. The worst outcome of a
      // bad one is an unfiltered first page, never a broken screen.
      for (const page of ['0', '-2', 'abc', '']) {
        expect(fromQueryParams(convertToParamMap({ page }), MIN).page).toBe(1);
      }
    });

    it('ignores an empty metadata key', () => {
      const state = fromQueryParams(convertToParamMap({ 'meta.': 'x' }), MIN);

      expect(state.filter.meta).toEqual({});
    });
  });

  describe('isFiltering', () => {
    it('is false for no filter, true for either axis', () => {
      expect(isFiltering(NO_TEAM_FILTER)).toBeFalse();
      expect(isFiltering(filter({ meta: { k: 'v' } }))).toBeTrue();
      expect(isFiltering(filter({ catalogNamespace: 'acme' }))).toBeTrue();
    });
  });
});
