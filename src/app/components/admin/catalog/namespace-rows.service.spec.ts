import { TestBed } from '@angular/core/testing';

import { ApiService } from '../../../core/http/api.service';
import { HttpError, NetworkError } from '../../../core/http/fetch.service';
import {
  ENTRY_KINDS,
  Entry,
  EntryKind,
  NamespaceSummary,
} from '../../../protocol/catalog.interface';
import {
  ENTRIES_BY_KIND,
  EXPECTED_COUNTS,
  NAMESPACES,
  entry,
  summary,
} from './namespace-rows.fixtures';
import { NamespaceRowsService } from './namespace-rows.service';

describe('NamespaceRowsService', () => {
  let apiSpy: jasmine.SpyObj<ApiService>;
  let service: NamespaceRowsService;

  /** Resolve every kind call from a lookup, defaulting to []. */
  function serveKinds(byKind: Partial<Record<EntryKind, Entry[]>>): void {
    apiSpy.getEntries.and.callFake(async (kind: EntryKind) => byKind[kind] ?? []);
  }

  beforeEach(() => {
    apiSpy = jasmine.createSpyObj<ApiService>('ApiService', [
      'getNamespaces',
      'getEntries',
    ]);
    apiSpy.getNamespaces.and.returnValue(Promise.resolve([]));
    serveKinds({});

    TestBed.configureTestingModule({
      providers: [
        NamespaceRowsService,
        { provide: ApiService, useValue: apiSpy },
      ],
    });

    service = TestBed.inject(NamespaceRowsService);
  });

  describe('request shape (AC3, AC4)', () => {
    beforeEach(() => {
      apiSpy.getNamespaces.and.returnValue(Promise.resolve(NAMESPACES));
      serveKinds(ENTRIES_BY_KIND);
    });

    it('paints a five-namespace page with SEVEN requests, not six per namespace', async () => {
      await service.getRows();

      expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(1);
      expect(apiSpy.getEntries).toHaveBeenCalledTimes(6);
      const kinds = apiSpy.getEntries.calls.allArgs().map((args) => args[0]);
      expect(kinds.slice().sort()).toEqual([...ENTRY_KINDS].sort());
    });

    it('passes all: true to the namespaces call AND all six kind calls', async () => {
      await service.getRows({ all: true });

      expect(apiSpy.getNamespaces).toHaveBeenCalledOnceWith({ all: true });
      for (const args of apiSpy.getEntries.calls.allArgs()) {
        expect(args[1]).toEqual({ all: true });
      }
    });

    it('passes all: false to all seven calls by default', async () => {
      await service.getRows();

      expect(apiSpy.getNamespaces).toHaveBeenCalledOnceWith({ all: false });
      for (const args of apiSpy.getEntries.calls.allArgs()) {
        expect(args[1]).toEqual({ all: false });
      }
    });

    it('passes all: false to all seven calls when asked explicitly', async () => {
      await service.getRows({ all: false });

      expect(apiSpy.getNamespaces).toHaveBeenCalledOnceWith({ all: false });
      for (const args of apiSpy.getEntries.calls.allArgs()) {
        expect(args[1]).toEqual({ all: false });
      }
    });
  });

  describe('counts (AC5, AC6)', () => {
    beforeEach(() => {
      apiSpy.getNamespaces.and.returnValue(Promise.resolve(NAMESPACES));
      serveKinds(ENTRIES_BY_KIND);
    });

    it('reproduces the per-namespace, per-kind counts of the live-shaped fixture', async () => {
      const { rows } = await service.getRows();

      expect(rows.map((r) => r.namespace)).toEqual([
        'acme-team',
        'acme-coding',
        'contoso-product',
        'global',
        'global-tools',
      ]);
      for (const row of rows) {
        expect(row.counts)
          .withContext(row.namespace)
          .toEqual(EXPECTED_COUNTS[row.namespace]);
      }
    });

    it('keeps the two team-less library namespaces as rows', async () => {
      const { rows } = await service.getRows();

      const libraries = rows.filter((r) => !r.team).map((r) => r.namespace);
      expect(libraries).toEqual(['global', 'global-tools']);
      expect(rows.find((r) => r.namespace === 'global-tools')!.counts.tool).toBe(8);
    });

    it('carries ALL SIX keys on every row, zero-valued where the kind is absent', async () => {
      const { rows } = await service.getRows();

      const expectedKeys = [...ENTRY_KINDS].sort();
      for (const row of rows) {
        expect(Object.keys(row.counts).sort())
          .withContext(row.namespace)
          .toEqual(expectedKeys);
      }
    });

    it('still carries all six keys when every kind list comes back empty', async () => {
      serveKinds({});

      const { rows } = await service.getRows();

      for (const row of rows) {
        expect(Object.keys(row.counts).sort()).toEqual([...ENTRY_KINDS].sort());
        expect(Object.values(row.counts)).toEqual([0, 0, 0, 0, 0, 0]);
      }
    });

    it('carries the summary fields through onto the row', async () => {
      const { rows } = await service.getRows();

      const global = rows.find((r) => r.namespace === 'global')!;
      expect(global.name).toBe('global');
      expect(global.description).toBe('global description');
      expect(global.team).toBeFalse();
      expect(global.shareable).toBeFalse();
      expect(global.public).toBeTrue();
    });
  });

  describe('row set is decided by the namespaces response (AC7)', () => {
    it('produces no row for a namespace present only in the entry responses', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([summary('acme-team')]),
      );
      serveKinds({
        team: [entry('team', 'acme-team', 't1')],
        tool: [
          entry('tool', 'acme-team', 'k1'),
          // A tool-only namespace the picker deliberately hides.
          entry('tool', 'hidden-tools', 'k2'),
        ],
      });

      const { rows } = await service.getRows();

      expect(rows.map((r) => r.namespace)).toEqual(['acme-team']);
      expect(rows[0].counts.tool).toBe(1);
    });

    it('returns no rows at all when the namespaces list is empty', async () => {
      apiSpy.getNamespaces.and.returnValue(Promise.resolve([]));
      serveKinds(ENTRIES_BY_KIND);

      const result = await service.getRows();

      expect(result.rows).toEqual([]);
      expect(result.unavailableKinds).toEqual([]);
    });
  });

  describe('owner resolution is team → meta → null (AC8, AC9)', () => {
    /** Four namespaces, each exercising one branch of the resolution. */
    const summaries: NamespaceSummary[] = [
      summary('acme-owned'),
      summary('contoso-meta-only', { team: false }),
      summary('ownerless', { team: false }),
      summary('acme-mixed'),
    ];

    it('reads the owner off the team entry', async () => {
      apiSpy.getNamespaces.and.returnValue(Promise.resolve(summaries));
      serveKinds({
        team: [entry('team', 'acme-owned', 't1', 'acme-owner')],
      });

      const { rows } = await service.getRows();

      expect(rows.find((r) => r.namespace === 'acme-owned')!.owner).toBe(
        'acme-owner',
      );
    });

    it('falls back to the meta entry when there is no team entry', async () => {
      apiSpy.getNamespaces.and.returnValue(Promise.resolve(summaries));
      serveKinds({
        meta: [entry('meta', 'contoso-meta-only', 'm1', 'contoso-owner')],
      });

      const { rows } = await service.getRows();

      expect(rows.find((r) => r.namespace === 'contoso-meta-only')!.owner).toBe(
        'contoso-owner',
      );
    });

    it('is null when neither a team nor a meta entry exists', async () => {
      apiSpy.getNamespaces.and.returnValue(Promise.resolve(summaries));
      serveKinds({ tool: [entry('tool', 'ownerless', 'k1', 'someone-else')] });

      const { rows } = await service.getRows();

      expect(rows.find((r) => r.namespace === 'ownerless')!.owner).toBeNull();
    });

    it('never reads user_id off an arbitrary entry — the team entry anchors it', async () => {
      apiSpy.getNamespaces.and.returnValue(Promise.resolve(summaries));
      serveKinds({
        team: [entry('team', 'acme-mixed', 't1', 'acme-owner')],
        tool: [entry('tool', 'acme-mixed', 'k1', 'someone-else')],
        meta: [entry('meta', 'acme-mixed', 'm1', 'meta-owner')],
      });

      const { rows } = await service.getRows();

      expect(rows.find((r) => r.namespace === 'acme-mixed')!.owner).toBe(
        'acme-owner',
      );
    });

    it('treats an empty-string user_id on the team entry as no owner and falls through to meta', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([summary('acme-blank')]),
      );
      serveKinds({
        team: [entry('team', 'acme-blank', 't1', '')],
        meta: [entry('meta', 'acme-blank', 'm1', 'contoso-owner')],
      });

      const { rows } = await service.getRows();

      expect(rows[0].owner).toBe('contoso-owner');
    });

    it('treats a null user_id on the team entry as no owner and falls through to meta', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([summary('acme-null')]),
      );
      const teamEntry = {
        ...entry('team', 'acme-null', 't1'),
        user_id: null as unknown as string,
      };
      serveKinds({
        team: [teamEntry],
        meta: [entry('meta', 'acme-null', 'm1', 'contoso-owner')],
      });

      const { rows } = await service.getRows();

      expect(rows[0].owner).toBe('contoso-owner');
    });

    it('treats an absent user_id on BOTH anchor entries as owner null', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([summary('acme-absent')]),
      );
      const stripUserId = (e: Entry): Entry => {
        const { user_id: _dropped, ...rest } = e;
        return rest as Entry;
      };
      serveKinds({
        team: [stripUserId(entry('team', 'acme-absent', 't1'))],
        meta: [stripUserId(entry('meta', 'acme-absent', 'm1'))],
      });

      const { rows } = await service.getRows();

      expect(rows[0].owner).toBeNull();
    });

    it('takes the FIRST anchor entry in response order when a namespace has several', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([summary('acme-many')]),
      );
      serveKinds({
        team: [
          entry('team', 'acme-many', 't1', 'first-owner'),
          entry('team', 'acme-many', 't2', 'second-owner'),
        ],
      });

      const { rows } = await service.getRows();

      expect(rows[0].owner).toBe('first-owner');
    });

    it('skips a blank-user_id team entry and takes the next team entry that has one', async () => {
      apiSpy.getNamespaces.and.returnValue(
        Promise.resolve([summary('acme-skip')]),
      );
      serveKinds({
        team: [
          entry('team', 'acme-skip', 't1', ''),
          entry('team', 'acme-skip', 't2', 'second-owner'),
        ],
      });

      const { rows } = await service.getRows();

      expect(rows[0].owner).toBe('second-owner');
    });

    it('resolves the live-shaped fixture to the same owner on every row', async () => {
      apiSpy.getNamespaces.and.returnValue(Promise.resolve(NAMESPACES));
      serveKinds(ENTRIES_BY_KIND);

      const { rows } = await service.getRows();

      expect(rows.map((r) => r.owner)).toEqual([
        'anonymous',
        'anonymous',
        'anonymous',
        'anonymous',
        'anonymous',
      ]);
    });
  });

  describe('degradation (AC10, AC11)', () => {
    it('resolves with every row intact when ONE kind call rejects', async () => {
      apiSpy.getNamespaces.and.returnValue(Promise.resolve(NAMESPACES));
      apiSpy.getEntries.and.callFake(async (kind: EntryKind) => {
        if (kind === 'tool') {
          throw new HttpError('boom', 500, '');
        }
        return ENTRIES_BY_KIND[kind];
      });

      const { rows, unavailableKinds } = await service.getRows();

      expect(rows.length).toBe(5);
      expect(unavailableKinds).toEqual(['tool']);
      for (const row of rows) {
        // The failed column reads zero everywhere...
        expect(row.counts.tool).withContext(row.namespace).toBe(0);
        // ...and the other five are untouched.
        const expected = EXPECTED_COUNTS[row.namespace];
        expect(row.counts.team).toBe(expected.team);
        expect(row.counts.agent).toBe(expected.agent);
        expect(row.counts.model).toBe(expected.model);
        expect(row.counts.prompt).toBe(expected.prompt);
        expect(row.counts.meta).toBe(expected.meta);
      }
    });

    it('degrades identically on a NetworkError — never narrows on the failure subtype', async () => {
      apiSpy.getNamespaces.and.returnValue(Promise.resolve(NAMESPACES));
      apiSpy.getEntries.and.callFake(async (kind: EntryKind) => {
        if (kind === 'model') {
          throw new NetworkError('Server unreachable');
        }
        return ENTRIES_BY_KIND[kind];
      });

      const { rows, unavailableKinds } = await service.getRows();

      expect(rows.length).toBe(5);
      expect(unavailableKinds).toEqual(['model']);
      expect(rows.every((r) => r.counts.model === 0)).toBeTrue();
    });

    it('reports every failed kind when several reject', async () => {
      apiSpy.getNamespaces.and.returnValue(Promise.resolve(NAMESPACES));
      apiSpy.getEntries.and.callFake(async (kind: EntryKind) => {
        if (kind === 'team' || kind === 'meta') {
          throw new HttpError('boom', 500, '');
        }
        return ENTRIES_BY_KIND[kind];
      });

      const { rows, unavailableKinds } = await service.getRows();

      expect(rows.length).toBe(5);
      expect(unavailableKinds.slice().sort()).toEqual(['meta', 'team']);
      // Both owner anchors are gone, so every row fails closed to null.
      expect(rows.every((r) => r.owner === null)).toBeTrue();
    });

    it('leaves unavailableKinds empty when all six resolve', async () => {
      apiSpy.getNamespaces.and.returnValue(Promise.resolve(NAMESPACES));
      serveKinds(ENTRIES_BY_KIND);

      const { unavailableKinds } = await service.getRows();

      expect(unavailableKinds).toEqual([]);
    });

    it('REJECTS when the namespaces call rejects — never coalesced to an empty list', async () => {
      const failure = new HttpError('boom', 500, '');
      apiSpy.getNamespaces.and.returnValue(Promise.reject(failure));
      serveKinds(ENTRIES_BY_KIND);

      await expectAsync(service.getRows()).toBeRejectedWith(failure);
    });

    it('propagates a NetworkError on the namespaces call too', async () => {
      const failure = new NetworkError('Server unreachable');
      apiSpy.getNamespaces.and.returnValue(Promise.reject(failure));
      serveKinds(ENTRIES_BY_KIND);

      await expectAsync(service.getRows()).toBeRejectedWith(failure);
    });
  });
});
