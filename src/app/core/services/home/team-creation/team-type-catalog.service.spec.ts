import { TestBed } from '@angular/core/testing';

import { ApiService } from '../../../platform/http/api.service';
import { NamespaceSummary } from '../../../protocol/catalog.interface';
import { TeamTypeCatalog } from './team-type-catalog.service';

/**
 * A namespace summary. `team` DEFAULTS TO FALSE, matching the two rows the
 * catalog ships to every deployment ("Global Library", "Global Tools") — the
 * ones that started this. A fixture defaulting the other way would make the
 * filter untestable by accident, since every list would already be creatable.
 */
function ns(namespace: string, overrides: Partial<NamespaceSummary> = {}): NamespaceSummary {
  return {
    namespace,
    name: namespace,
    description: '',
    team: false,
    shareable: false,
    public: false,
    owner: null,
    counts: {},
    ...overrides,
  };
}

function teamNs(namespace: string): NamespaceSummary {
  return ns(namespace, { team: true });
}

describe('TeamTypeCatalog', () => {
  let apiSpy: jasmine.SpyObj<ApiService>;
  let catalog: TeamTypeCatalog;

  beforeEach(() => {
    apiSpy = jasmine.createSpyObj<ApiService>('ApiService', ['getNamespaces']);
    apiSpy.getNamespaces.and.returnValue(Promise.resolve([]));

    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: apiSpy }],
    });
    catalog = TestBed.inject(TeamTypeCatalog);
  });

  describe('isTeamType', () => {
    it('accepts a namespace that declares a team', () => {
      expect(catalog.isTeamType(teamNs('agent-team-v1'))).toBeTrue();
    });

    it('REJECTS a library namespace', () => {
      // "Global Library" / "Global Tools": prompts, tools and knowledge, with
      // no team for `createTeam` to instantiate.
      expect(catalog.isTeamType(ns('global-library'))).toBeFalse();
    });

    it('treats a summary with no `team` field at all as NOT a team type', () => {
      // A server that predates the field, or a row this client assembled
      // itself. Coercing would make the missing field truthy-by-accident on
      // the one side where being wrong means offering an uncreatable type.
      const partial = { ...ns('mystery') } as Partial<NamespaceSummary>;
      delete partial.team;
      expect(catalog.isTeamType(partial as NamespaceSummary)).toBeFalse();
    });
  });

  describe('teamTypesOf', () => {
    it('keeps only the team-declaring rows', () => {
      const list = [ns('global-library'), teamNs('agent-team-v1'), ns('global-tools')];

      expect(catalog.teamTypesOf(list).map((n) => n.namespace)).toEqual([
        'agent-team-v1',
      ]);
    });

    it('PRESERVES the caller\'s order', () => {
      // A caller's sort is the caller's: re-ordering here would silently move
      // whichever row a `[0]` auto-selection lands on.
      const list = [teamNs('zeta'), ns('lib'), teamNs('alpha')];

      expect(catalog.teamTypesOf(list).map((n) => n.namespace)).toEqual([
        'zeta',
        'alpha',
      ]);
    });

    it('does not mutate the list it was handed', () => {
      const list = [teamNs('alpha'), ns('lib')];
      catalog.teamTypesOf(list);

      expect(list.map((n) => n.namespace)).toEqual(['alpha', 'lib']);
    });
  });

  describe('loadTeamTypes', () => {
    it('returns ONLY the team types the endpoint listed', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([ns('global-library'), teamNs('agent-team-v1'), ns('global-tools')]),
      );

      const list = await catalog.loadTeamTypes();

      expect(list.map((n) => n.namespace)).toEqual(['agent-team-v1']);
    });

    it('asks for the owner-scoped list with NO arguments at all', async () => {
      // `?all=true` is honoured server-side only for admins, so the ordinary
      // read must not carry the flag — not even as `{ all: false }`.
      await catalog.loadTeamTypes();

      expect(apiSpy.getNamespaces).toHaveBeenCalledWith();
    });

    it('forwards the admin firehose, and filters that too', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([ns('someones-library'), teamNs('someones-team')]),
      );

      const list = await catalog.loadTeamTypes({ all: true });

      expect(apiSpy.getNamespaces).toHaveBeenCalledWith({ all: true });
      expect(list.map((n) => n.namespace)).toEqual(['someones-team']);
    });

    it('PROPAGATES a failed fetch rather than reporting an empty catalog', async () => {
      // "There are no team types" is a claim about the account. A swallowed
      // rejection would make an unreachable server say it.
      apiSpy.getNamespaces.and.returnValue(Promise.reject(new Error('boom')));

      await expectAsync(catalog.loadTeamTypes()).toBeRejected();
    });
  });
});
