import { inject, Injectable } from '@angular/core';

import { ApiService } from '../../../core/http/api.service';
import { NamespaceSummary } from '../../../protocol/catalog.interface';

/**
 * WHICH NAMESPACES A TEAM CAN BE CREATED FROM — the definition, and the fetch
 * that has already applied it.
 *
 * THE BUG THIS EXISTS TO HAVE FIXED ONCE. `GET /admin/catalog/namespaces`
 * returns every namespace this account can see, and only some of them declare
 * a team: the catalog ships "Global Library" and "Global Tools" to every
 * deployment, and `NamespaceSummary.team` is false on both. The console's
 * creation wizard rendered that list verbatim, so "choose the type of team to
 * create" offered two things that are not team types — selectable, and with
 * Create enabled behind them. The home page's dropdown, which is a namespace
 * PICKER and not a creation list, reads `team` and sections on it. Two surfaces,
 * one list, different rules; the one that was wrong was the one that creates.
 *
 * THE RULE AND THE FETCH ARE THE SAME OBJECT, deliberately. A helper that only
 * filtered would leave every creation surface one forgotten call away from the
 * same defect — which is precisely the shape the wizard was already in. There
 * is no way to ask this service for a creation list and get a library
 * namespace back. A surface that genuinely wants ALL namespaces still calls
 * `ApiService.getNamespaces()` directly, and now has to say so.
 *
 * SEPARATE FROM `TeamCreationService`, which is the creation GATE. That service
 * is documented and tested as answerable "without a page, a route or a fetch"
 * — its whole bed is the gate plus a `ContextService` spy, so that an injection
 * added to it turns that file red on purpose. Hanging an HTTP dependency off it
 * to save a file would break a property somebody chose. This is the other half:
 * the gate decides what a creation must ASK, this decides what may be created
 * at all.
 *
 * `providedIn: 'root'` because it holds NOTHING. The gate is page-provided so
 * its captured namespace and open dialog die with their host; there is no
 * equivalent state here to leak, and a per-host instance would only mean more
 * places for a stale copy of the rule to live.
 */
@Injectable({ providedIn: 'root' })
export class TeamTypeCatalog {
  private readonly apiService = inject(ApiService);

  /**
   * Can a team be made out of this namespace?
   *
   * `team` is the catalog's own answer — true for a namespace that declares a
   * team, false for a library of prompts, tools or knowledge, which has no
   * team for `createTeam` to instantiate. Compared against `true` rather than
   * coerced, so a summary from a server that omitted the field is treated as
   * "not a team type" instead of as truthy-by-accident.
   */
  isTeamType(ns: NamespaceSummary): boolean {
    return ns.team === true;
  }

  /**
   * The creatable subset of a list somebody else already has.
   *
   * For a surface holding namespaces for another reason (the management
   * dropdown holds them to drive the configuration panel and the filter bar)
   * that must nonetheless answer a creation question about them. ORDER IS
   * PRESERVED: the caller's sort is the caller's, and re-ordering here would
   * silently move whichever row a `[0]` auto-selection lands on.
   */
  teamTypesOf(namespaces: readonly NamespaceSummary[]): NamespaceSummary[] {
    return namespaces.filter((ns) => this.isTeamType(ns));
  }

  /**
   * Fetch the team types this account may create into.
   *
   * `all` forwards ADR-028's admin firehose. The ordinary call is kept
   * literally zero-argument: `?all=true` is honoured server-side only for
   * admins, and the owner-scoped list must not carry the flag at all.
   *
   * Rejections PROPAGATE. `FetchService` has already toasted, and what a
   * surface does with an unavailable list — a blank step, an empty state, a
   * retry — is a view decision that differs between them.
   */
  async loadTeamTypes(options?: { all?: boolean }): Promise<NamespaceSummary[]> {
    const namespaces =
      options?.all === true
        ? await this.apiService.getNamespaces({ all: true })
        : await this.apiService.getNamespaces();
    return this.teamTypesOf(namespaces);
  }
}
