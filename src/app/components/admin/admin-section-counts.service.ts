import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

/**
 * The rail's per-section counts, published by the panes that already hold the
 * data (Story 36-9).
 *
 * THE POINT: the rail states how much the deployment holds WITHOUT issuing a
 * request of its own. Both numbers already exist in memory — `CatalogList`'s
 * `rows` and `ApiKeyList`'s `keys` — so the shell reads them from here instead
 * of fetching them a second time.
 *
 * `null` means UNKNOWN, and unknown renders no badge at all — never `0`. The
 * two are different facts: a pane that has not been visited, a load that
 * failed, and a deployment that does not mount `/auth/**` all have no honest
 * number to show, while a namespace-less deployment genuinely has zero. The
 * community tier is the case that makes this concrete: `/auth/**` is not
 * mounted there, so the API-keys count stays absent forever, correctly.
 *
 * NOT `providedIn: 'root'`. It is registered on the admin shell's route
 * `providers`, which gives the shell and both `loadComponent` children one
 * shared instance for as long as the area is mounted — nothing under
 * `components/admin/` is a root singleton (ADR-015 §2b), and a root holder
 * would additionally survive navigation away from the area carrying stale
 * numbers into the next visit.
 */
@Injectable()
export class AdminSectionCounts {
  readonly #catalog = new BehaviorSubject<number | null>(null);
  readonly #apiKeys = new BehaviorSubject<number | null>(null);

  /** Namespaces the catalog pane loaded — the UNFILTERED row count. */
  readonly catalog$: Observable<number | null> = this.#catalog.asObservable();

  /** Keys the API-keys pane loaded. */
  readonly apiKeys$: Observable<number | null> = this.#apiKeys.asObservable();

  setCatalog(count: number | null): void {
    this.#catalog.next(count);
  }

  setApiKeys(count: number | null): void {
    this.#apiKeys.next(count);
  }
}
