import { Component, HostListener, inject, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Params, Router } from '@angular/router';

import {
  fromQueryParams,
  isFiltering,
  toQueryParams,
} from '../../core/context/home-url';
import {
  BehaviorSubject,
  firstValueFrom,
  Observable,
  Subscription,
} from 'rxjs';
import { filter, map, take } from 'rxjs/operators';

import { ApiService, MIN_FILTER_TERM_LENGTH } from '../../core/http/api.service';
import {
  NO_TEAM_FILTER,
  TeamFilter,
  titleFieldKey,
} from '../../core/context/team.interface';
import { NamespaceSummary } from '../../protocol/catalog.interface';

import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TableLazyLoadEvent } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { ToggleSwitchModule } from 'primeng/toggleswitch';

import { AuthService } from '../../core/auth/auth.service';
import { ConfigService } from '../../core/config/config.service';
import { ContextService } from '../../core/context/context.service';
import { SplitDividerComponent } from '../../shared/components/split-divider/split-divider.component';
import {
  clampSplitPercent,
  formatSplitPercent,
  parseSplitPercent,
  SPLIT_DEFAULT_PERCENT,
  SPLIT_STORAGE_KEY,
} from '../../shared/util/split-width';

// Epic 52: the process view is EMBEDDED here, beside the teams list, so that
// opening a team no longer means leaving them. NOT deferred like
// <app-namespace-panel> above: `/process/:id` in app.routes.ts imports this
// component eagerly, so it is in the initial bundle whatever this page does,
// and a defer block would only look like it was earning something.
import { ProcessComponent } from '../process/process.component';

// Listed in @Component.imports so Angular's @defer block can resolve
// <app-namespace-panel>. The `@defer (when ...)` block in the template keeps
// the component's compiled code (and its Monaco chunk) in a deferred chunk
// loaded only on first opening of the namespace-editor dialog — the initial
// home-page bundle stays Monaco-free.
import { NamespacePanelComponent } from '../catalog/namespace-panel/namespace-panel.component';
import {
  TeamMetadataModalComponent,
} from './team-metadata-modal/team-metadata-modal.component';
import { TeamFilterComponent } from './team-filter/team-filter.component';
import { TeamCreationService } from './team-creation/team-creation.service';
import {
  TeamDescriptionSave,
  TeamRowAction,
  TeamTableComponent,
} from './team-table/team-table.component';

// Classic team-list page size (Epic 28, ADR-032 §Decision 3). Bound to the
// paginator's [rows] and used as the loadTeamsPage size fallback so no magic
// 250 literal is duplicated. Server clamps size to [1, 500].
const PAGE_SIZE = 250;


@Component({
  selector: 'app-home',
  imports: [
    FormsModule,
    SelectModule,
    ButtonModule,
    CommonModule,
    DialogModule,
    ToggleSwitchModule,
    NamespacePanelComponent,
    TeamMetadataModalComponent,
    TeamFilterComponent,
    TeamTableComponent,
    SplitDividerComponent,
    ProcessComponent,
  ],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
  // ONE gate per page mount, not a root singleton. The dialog's state must die
  // with this component: a root-scoped gate would carry a captured namespace
  // and an open dialog across a navigation away and back.
  providers: [TeamCreationService],
})
export class HomeComponent {
  apiService: ApiService = inject(ApiService);
  contextService: ContextService = inject(ContextService);
  router: Router = inject(Router);
  private route: ActivatedRoute = inject(ActivatedRoute);
  authService: AuthService = inject(AuthService);
  private config = inject(ConfigService);

  /**
   * The creation gate. PUBLIC because the template binds the dialog straight to
   * it — the page renders `<app-team-metadata-modal>` but owns none of its
   * state, and both creation paths ask the gate rather than deciding for
   * themselves.
   */
  creation = inject(TeamCreationService);

  // Catalog namespaces for the team creation dropdown
  namespaces$ = new BehaviorSubject<NamespaceSummary[]>([]);
  selectedNamespace$ = new BehaviorSubject<NamespaceSummary | null>(null);
  isRefreshing = false;

  /**
   * Which metadata key the selected namespace nominates as a team's TITLE, or
   * `null` when it nominates none (Epic 53). Handed to `<app-team-table>`,
   * which asks each ROW for its own value under that key.
   *
   * DERIVED, never stored. A stored copy is a second thing to keep in step
   * with the selection, and the moment it would fall out of step — the
   * namespace panel saving a changed contract, which re-fetches and re-selects
   * — is the moment the key matters. `titleFieldKey` resolves a malformed
   * two-title contract in declaration order, so the answer is deterministic.
   */
  titleKey$: Observable<string | null> = this.selectedNamespace$.pipe(
    map((ns) => titleFieldKey(ns?.team_metadata)),
  );

  // Classic paginator state (Epic 28). `rows` feeds [rows]; `first` is the
  // row offset the paginator is parked on; `currentPage` (1-based) is tracked
  // so create/restore/refresh reload the right page. The table's first
  // (onLazyLoad) seeds page 1 — ngOnInit no longer fetches the list (AC #3).
  readonly rows = PAGE_SIZE;
  first = 0;
  currentPage = 1;

  // Flips true after the table's first (onLazyLoad) page-1 load resolves. The
  // hideHome branch awaits this then reads teams$ reactively — so exactly one
  // page-1 fetch happens (the seed), never a second ngOnInit fetch (AC #3).
  private firstPageLoaded$ = new BehaviorSubject<boolean>(false);

  // Controls the Namespace Panel dialog visibility. The panel component is
  // mounted lazily via @defer in home.component.html so its Monaco-editor
  // dependency is NOT part of the initial home-page chunk.
  namespacePanelVisible: boolean = false;

  // Admin-only "show all namespaces" toggle (ADR-028).
  //
  // This is an admin-gated UX affordance, NOT the security boundary. The
  // authoritative "see all" enforcement is the infra unscoping of admin reads
  // (`?all=true` honoured server-side only when the caller's roles include
  // `admin`). A non-admin who forges the flag gets the normal owner+public
  // list back, so the toggle must never be relied upon for enforcement.
  //
  // `showAllNamespaces` is the single source of truth read inside
  // `loadNamespaces()` and forwarded to `getNamespaces`/the panel; it defaults
  // OFF so even an admin starts on the owner+public list (opt-in, never an
  // always-on firehose).
  showAllNamespaces = false;

  // Reactive admin predicate. Derived from `authService.currentUser$` (NOT a
  // one-shot eager read) because `ngOnInit` fires `checkAuth()` which resolves
  // `/auth/me` AFTER first render — reading `currentUserValue` once would miss
  // the late admin resolution. `roles` is read off the verbatim `/auth/me`
  // body (typed `any`); the optional chain yields `false` for the anonymous
  // user (no `roles`). Consumed in the template via the `async` pipe so the
  // toggle appears once the deferred admin user lands.
  isAdmin$: Observable<boolean> = this.authService.currentUser$.pipe(
    map((u) => u?.roles?.includes('admin') === true),
  );

  // @ViewChild on the @defer-rendered panel. The reference is `undefined`
  // until the user opens the dialog (the @defer block only mounts the child
  // when `namespacePanelVisible` flips true), so the close handler MUST
  // null-check. `{ static: false }` is the default for @ViewChild on
  // conditionally-rendered children; no explicit option needed.
  @ViewChild(NamespacePanelComponent)
  namespacePanel?: NamespacePanelComponent;

  // The team-metadata dialog's host state is NOT here. It belongs to
  // `TeamCreationService` — which namespace the user answered FOR, what the
  // server said if it refused, and whether the Create button is spinning. The
  // page renders the element and binds it to the gate; it owns none of it.

  // -----------------------------------------------------------------------
  // The filter bar (Epic 48).
  //
  // The selected namespace's contract decides which inputs exist; the terms
  // typed into them plus the narrowing toggle compose a `TeamFilter` that the
  // context service debounces and turns into one page-1 request.
  // -----------------------------------------------------------------------

  /**
   * The filter the form should ADOPT — set once, from the URL, on mount.
   *
   * A one-way input to `<app-team-filter>`: the form answers through its
   * `(changed)` output and this page never writes it again. Two-way binding
   * would let the page echo the form's own answer back at it.
   */
  restoredFilter: TeamFilter = NO_TEAM_FILTER;

  /**
   * Whether the filter row is on screen. **Closed by default** — the page's job
   * on arrival is to show the teams, and an empty filter panel above them is a
   * row of controls asking to be used before the list has been read.
   *
   * Showing or hiding is presentation only: it does NOT clear the filter, so a
   * collapsed row can still be narrowing the list. `hasActiveFilter` exists to
   * make that visible; see there. The default is safe against that on arrival
   * for a separate reason — `ngOnInit` clears the filter, so a freshly mounted
   * page is never both closed and filtering.
   */
  filtersVisible = false;

  // -----------------------------------------------------------------------
  // The split (Epic 52).
  //
  // The list keeps the page; opening a team puts it BESIDE the list instead of
  // navigating away from it. Two pieces of state, and they are independent:
  // WHICH team is open, and how wide the list is.
  // -----------------------------------------------------------------------

  /**
   * The team open beside the list, or `null` for a list on its own (FR7).
   *
   * The page owns the SELECTION; the embedded view owns everything about the
   * team itself. In particular this page never writes
   * `ContextService.currentProcessId$` — `ProcessComponent` publishes the id it
   * has actually opened, and two writers on that subject would leave the agent
   * tabs and the workspace following whichever wrote last (Epic 52 trap T3).
   */
  selectedTeamId: string | null = null;

  /**
   * The list's share of the width, as a percentage (FR5).
   *
   * A percentage rather than pixels so the split survives a window resize with
   * its proportions intact, and so a width stored on a wide monitor does not
   * come back as the whole of a narrow one.
   */
  splitPercent: number = SPLIT_DEFAULT_PERCENT;

  /** Show or hide the filter row. Never touches the filter itself. */
  toggleFilters(): void {
    this.filtersVisible = !this.filtersVisible;
  }

  /**
   * Is the list currently narrowed by anything the filter row owns?
   *
   * Read by the collapse control so a HIDDEN row that is still filtering says
   * so. Without it, collapsing the row while a term is typed leaves a filtered
   * table with its cause off screen and no way to discover it — the same class
   * of lie as a paginator reporting a total the rows do not match.
   *
   * The term test is the SAME floor the request composition uses, not merely
   * "non-empty": a one- or two-character term contributes nothing to the
   * request, so reporting it as active would be its own small lie.
   *
   * A getter is safe here where it would not be for `filterFields`: it returns
   * a boolean, and Angular compares primitives by value, so re-evaluating it
   * each cycle cannot churn the DOM.
   */
  get hasActiveFilter(): boolean {
    return isFiltering(this.contextService.filter);
  }

  async ngOnInit() {
    // FIRST, and synchronously — before the template renders and the table
    // fires its first `(onLazyLoad)`.
    //
    // `ContextService` is a root singleton, so a filter set during an earlier
    // visit outlives the component that set it. The URL is now the authority on
    // what this page shows: whatever it names is adopted, and anything it does
    // not name is cleared. Leaving the service's value in place instead would
    // paint the previous visit's filtered set under a form the URL says is
    // empty.
    //
    // Both paths write the VALUE only, so neither fetches: the table's own
    // first lazy load stays the sole page-1 seed (Story 28.2) and carries the
    // restored filter with it, because `loadTeamsPage` reads that value.
    this.restoreFromUrl();
    this.trackUrlSelection();

    // Not from the URL: a pane width is a preference of THIS browser, not a
    // property of the view being shared. Putting it in the query string would
    // impose the sender's monitor on the recipient's.
    this.restoreSplitPercent();

    await this.loadNamespaces();

    // The list is seeded by the table's first (onLazyLoad) (page 1) — NOT a
    // fetch here, which would double-seed (AC #3). The hideHome branch reads
    // the seeded list reactively below.
    if (this.config.hideHome) {
      await this.handleHideHome();
    }

    this.authService.checkAuth().subscribe();
  }

  /**
   * Classic lazy paginator load (Epic 28, ADR-032 §Decision 3). PrimeNG fires
   * (onLazyLoad) once on init (first: 0) and on every page change. Computes the
   * 1-based page from the row offset and delegates to the 28.1 data layer,
   * which REPLACES teams$ with the fetched page (one page in the DOM) and sets
   * totalCount. Tracks first/currentPage so create/restore/refresh reload the
   * right page.
   */
  async loadPage(event: TableLazyLoadEvent): Promise<void> {
    const size = event.rows ?? PAGE_SIZE;
    this.first = event.first ?? 0;
    this.currentPage = Math.floor(this.first / size) + 1;
    await this.contextService.loadTeamsPage(this.currentPage, size);
    // Not for the seed: the table's FIRST lazy load is this page arriving, not
    // the user turning to a page, and the URL already says where we are.
    if (this.firstPageLoaded$.value) {
      this.writeUrl();
    }
    this.firstPageLoaded$.next(true);
  }

  /**
   * hideHome auto-route: once the table's first page-1 seed lands, read the
   * current page reactively from teams$ (no extra fetch) and either create a
   * team (empty) or navigate to the first one. Preserves the master behavior.
   */
  private async handleHideHome(): Promise<void> {
    await firstValueFrom(this.firstPageLoaded$.pipe(filter((done) => done), take(1)));
    const teams = await firstValueFrom(this.contextService.teams$.pipe(take(1)));
    if (!teams || teams.length === 0) {
      const selected = this.selectedNamespace$.value;
      if (selected) {
        // Gated like every other creation path, and the gate is TOLD which one
        // this is. `'auto'` runs with NO user gesture, so it must still ask —
        // skipping the dialog here is precisely how a mandatory field would go
        // unfilled without anyone noticing — and it must NOT spin the Create
        // button, which nobody pressed.
        await this.creation.request(selected, 'auto');
      }
      return;
    }
    this.router.navigate(['/process', teams[0].team_id]);
  }

  /**
   * Load catalog namespaces for the dropdown. Shared by initial load and the
   * 2xx save branch so the fetch and error handling live in one place.
   *
   * Reconciles the current selection against the freshly-fetched list,
   * comparing on the stable `namespace` identifier (NOT object reference —
   * every fetch returns new objects — and NOT the display `name`, which two
   * summaries may share). If the current selection is no longer present (e.g.
   * it was just deleted), re-select the first remaining namespace, or `null`
   * when the list is empty. If it is still present, leave the subject
   * untouched to avoid a gratuitous dropdown flicker on an unrelated refresh.
   * A `null` current selection is "not present", so a non-empty list still
   * auto-selects `namespaces[0]`.
   */
  private async loadNamespaces(): Promise<void> {
    try {
      // Forward the admin "show all" flag through the single load path so
      // every caller (initial, save, clone, delete, refresh, toggle) stays
      // consistent and the selection reconciliation below runs on every
      // re-fetch. `all=true` is honoured server-side only for admins; for
      // everyone else it is a no-op (normal owner+public list).
      const namespaces = await this.apiService.getNamespaces({
        all: this.showAllNamespaces,
      });
      this.namespaces$.next(namespaces);
      // The URL named a team type: select THAT one rather than defaulting to
      // the first, and keep the terms restored beside it. An ordinary selection
      // clears them — correctly, since they belong to the contract being left —
      // but here the terms and the namespace arrived together and describe each
      // other. Consumed once: a later refresh reconciles normally.
      if (this.restoreNamespace !== null) {
        const named = this.restoreNamespace;
        this.restoreNamespace = null;
        const match = namespaces.find((n) => n.namespace === named) ?? null;
        if (match !== null) {
          // The form derives the fields it offers from this input and keeps the
          // terms restored beside it — an adopted value outranks a namespace
          // change arriving in the same cycle.
          this.selectedNamespace$.next(match);
          return;
        }
        // The URL named a namespace this user cannot see, or that no longer
        // exists. Its terms cannot be offered, so drop the whole filter rather
        // than leave the list narrowed by something the form cannot show.
        this.restoredFilter = NO_TEAM_FILTER;
        this.filtersVisible = false;
        this.contextService.clearFilter();
        this.writeUrl();
      }
      const current = this.selectedNamespace$.value;
      const stillExists =
        current != null && namespaces.some((n) => n.namespace === current.namespace);
      if (!stillExists) {
        // Through `applyNamespaceSelection`, not a bare `.next(...)`, so a
        // re-selection here clears the terms belonging to the contract that
        // just went away — the same treatment the dropdown gets (Epic 48).
        this.applyNamespaceSelection(namespaces.length > 0 ? namespaces[0] : null);
      }
    } catch (error) {
      console.error('Failed to load namespaces:', error);
    }
  }

  // -----------------------------------------------------------------------
  // Filter bar behaviour (Epic 48).
  // -----------------------------------------------------------------------

  /**
   * The `(ngModelChange)` handler for the namespace dropdown. The dropdown and
   * the auto-select inside `loadNamespaces()` are the only two ways the
   * selection moves, and both route through `applyNamespaceSelection`.
   */
  onNamespaceSelected(ns: NamespaceSummary | null): void {
    this.applyNamespaceSelection(ns);
  }

  /**
   * The single seam every namespace change passes through.
   *
   * NO-OPS when the `namespace` IDENTIFIER is unchanged. `loadNamespaces()`
   * re-fetches on every save, clone, delete and refresh, and each fetch
   * returns NEW objects for the same namespaces — comparing references would
   * clear the user's terms on an unrelated refresh.
   *
   * On a real change the offered fields are recomputed from the new contract
   * and the terms are dropped: a term belongs to the contract that offered it,
   * and carrying it across would leave the table showing a set filtered by the
   * previous contract's keys beneath an empty form.
   *
   * The FIRST selection of the page's lifetime issues no fetch — but ONLY
   * while the narrowing control is off. There are then no terms to drop and
   * nothing to narrow by, so the filter it would compose is the empty one
   * `ngOnInit` has just cleared, and emitting it would fetch page 1 a second
   * time, racing the table's own `(onLazyLoad)` seed with an identical
   * request.
   *
   * The narrowing control is part of that condition and not an assumption.
   * `catalogNamespace` is composed from the SELECTED namespace, so with no
   * selection the toggle composes `null` however it is set. A user who lands
   * on a page with no team types, flips the toggle on, and then gets a
   * selection — the panel saves one, or a refresh returns one — would
   * otherwise be left with the toggle reading ON above a list that is not
   * narrowed, and no further event to reconcile them.
   */
  private applyNamespaceSelection(ns: NamespaceSummary | null): void {
    const previous = this.selectedNamespace$.value;
    if ((previous?.namespace ?? null) === (ns?.namespace ?? null)) {
      return;
    }
    // Nothing more to do here: `<app-team-filter>` takes the selection as an
    // input, recomputes the fields it offers, clears the terms belonging to the
    // contract being left, and answers through `(changed)` — which lands in
    // `onFilterChanged` like every other filter change.
    this.selectedNamespace$.next(ns);
  }

  /**
   * The filter form answered.
   *
   * The single place a user-driven filter change is applied: it installs the
   * filter, returns to page 1 and mirrors both into the URL. Every route into a
   * changed filter — a keystroke, the narrowing toggle, Reset, a namespace
   * switch — arrives here, so none of them can forget one of the three.
   *
   * ORDER MATTERS. The filter reaches the service FIRST, then the paginator is
   * reset, because `p-table`'s `[first]` binding re-fires `(onLazyLoad)` when
   * the bound value changes — which issues one extra `loadTeamsPage` alongside
   * the debounced fetch. That extra request is not WRONG: the service already
   * holds the new filter by the time it runs, so it asks the same question and
   * carries the same answer. Written the other way round it would ask the OLD
   * question.
   *
   * `first` is written only when it is not already `0`, which keeps that extra
   * request to at most one per filter session; the common case — already on
   * page 1 — produces none at all.
   */
  onFilterChanged(filter: TeamFilter): void {
    this.contextService.setFilter(filter);
    if (this.first !== 0) {
      this.first = 0;
    }
    this.currentPage = 1;
    // After the page reset, never before: the URL must not advertise a page
    // the filter change has just abandoned.
    this.writeUrl();
  }

  // --- URL persistence (Story 48.2) --------------------------------------
  //
  // The filter and page live in the query string, so a filtered view can be
  // shared, bookmarked, and survives a refresh or a trip to a team and back.
  // What the parameters MEAN lives in `home-url.ts`; this pair is only the
  // wiring between that mapping and the page.

  /**
   * The team type the URL is about.
   *
   * Falls back to the type the URL named while the namespace list is still
   * loading. Without that fallback the seed write below drops `type` during
   * the restore window, and with it every metadata term on the next visit.
   */
  private currentNamespace(): string | null {
    return this.selectedNamespace$.value?.namespace ?? this.restoreNamespace;
  }

  /**
   * Mirror the current state into the URL, and remember it for the navigations
   * that mean "back to my list".
   *
   * Reads the filter from the SERVICE, never from the form. The service value
   * is authoritative from the first synchronous moment of `ngOnInit`, whereas
   * the form is empty until the namespace list resolves — so deriving the URL
   * from the form wrote a blank one during the restore window and threw the
   * restored filter away. One source of truth is the whole fix.
   *
   * `replaceUrl` because this runs on every keystroke: a history entry per
   * character would make Back useless for anything else.
   */
  private rememberQueryParams(): Params {
    const queryParams = toQueryParams({
      filter: this.contextService.filter,
      page: this.currentPage,
      namespace: this.currentNamespace(),
      team: this.selectedTeamId,
    });
    // Remembered because the navigations that mean "back to my list" run when
    // this route is no longer active and its parameters are already gone.
    this.contextService.homeQueryParams = queryParams;
    return queryParams;
  }

  private writeUrl(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: this.rememberQueryParams(),
      replaceUrl: true,
    });
  }

  /**
   * Adopt the filter and page the URL names, once, on mount.
   *
   * Reads the SNAPSHOT deliberately: this restores an entry state rather than
   * tracking navigations. Subscribing would feed this component its own
   * `writeUrl` output and loop.
   *
   * The filter is installed as a VALUE and does not fetch, so the table's own
   * first lazy load carries it — `loadTeamsPage` reads that value. Going
   * through `setFilter` would issue a second page-1 request racing that seed,
   * and the seed is a direct call rather than a trip through the debounced
   * pipeline, so nothing could order the two.
   */
  private restoreFromUrl(): void {
    const state = fromQueryParams(
      this.route.snapshot.queryParamMap,
      MIN_FILTER_TERM_LENGTH,
    );

    this.currentPage = state.page;
    this.first = (state.page - 1) * this.rows;
    this.restoredFilter = state.filter;
    this.restoreNamespace = state.namespace;
    // Epic 52: the open team is part of the entry state, so a shared link, a
    // bookmark and a reload all come back to the view that was actually on
    // screen. A team the URL names but that no longer exists is not resolved
    // here — the embedded view fetches it and reports back through
    // `(teamUnavailable)`, so there is exactly one place that decides whether a
    // team can be shown.
    this.selectedTeamId = state.team;
    this.contextService.restoreFilter(state.filter);

    // The row opens iff it has something to show for itself. Hidden while
    // filtering is the state the collapse control warns about, and it would
    // otherwise be the arrival state of every shared link. A page number alone
    // does not open it — paging is not filtering.
    this.filtersVisible = isFiltering(state.filter);

    // Remember without navigating: the address bar already says this. Arriving
    // and changing nothing is the common case for a shared link, and it is the
    // one path where no write ever runs — so recording only on write would
    // leave the logo replaying nothing.
    this.rememberQueryParams();
  }

  /**
   * Keep the open team in step with the URL, for as long as this page lives
   * (Epic 52).
   *
   * The filter and the page above are restored from the SNAPSHOT and never
   * tracked — subscribing would feed this component its own `writeUrl` output.
   * The open team is tracked, and the difference is not an inconsistency:
   *
   *  - It CANNOT loop. `writeUrl` composes `team` from `selectedTeamId`, so
   *    every emission this page causes arrives holding the value it already
   *    has, and the guard below returns. There is no such guard available for
   *    the filter, whose restore has to rebuild a form.
   *
   *  - It has to be tracked, or the URL becomes write-only for the selection.
   *    Query-string changes on THIS route do not rebuild this component, so
   *    `router.navigate(['/'])` — the Home menu item — would drop `?team` while
   *    the pane went on showing it. A URL that disagrees with the screen is
   *    worse than one that says less, and this page's URL is the thing Epic 48
   *    built for sharing.
   */
  private urlSub: Subscription | null = null;

  private trackUrlSelection(): void {
    this.urlSub = this.route.queryParamMap.subscribe((params) => {
      const team = params.get('team') || null;
      if (team === this.selectedTeamId) {
        return;
      }
      this.selectedTeamId = team;
    });
  }

  ngOnDestroy(): void {
    this.urlSub?.unsubscribe();
    this.urlSub = null;
  }

  /**
   * The team type the URL named, pending the namespace list arriving.
   *
   * Consumed once by `loadNamespaces`, which selects it INSTEAD of defaulting
   * to the first entry — and, unlike an ordinary selection, without clearing
   * the terms restored beside it.
   */
  private restoreNamespace: string | null = null;

  /**
   * The Create button's handler. The no-selection guard is the PAGE's — the
   * dropdown is the page's control and an empty one is not a creation the gate
   * should ever hear about. Everything past it belongs to the gate: whether
   * this team type asks something first, the dialog if it does, the POST if it
   * does not, and the spinner while that POST runs.
   */
  async createTeam(): Promise<void> {
    const selected = this.selectedNamespace$.value;
    if (!selected) {
      console.warn('No namespace selected');
      return;
    }
    await this.creation.request(selected, 'gesture');
  }

  async deleteTeam(teamId: string) {
    await this.contextService.deleteTeam(teamId);
  }

  /**
   * `(restoreRequested)` handler. The table asked; the page performs, and hands
   * the work straight back so the row it came from stays busy for exactly as
   * long as it runs — rejection included. Nothing here knows which row is
   * marked; that is the table's business.
   */
  onRestoreRequested(action: TeamRowAction): void {
    action.track(this.restoreTeam(action.teamId));
  }

  /** `(stopRequested)` handler. As `onRestoreRequested`. */
  onStopRequested(action: TeamRowAction): void {
    action.track(this.stopTeam(action.teamId));
  }

  /**
   * LOGS, then re-throws. The row clears its mark either way, so the rejection
   * is not what unwinds the spinner — but the table CONSUMES it (`then(clear,
   * clear)`), so without this `console.error` a failed restore leaves no trace
   * anywhere: the spinner stops, nothing changes on screen, and nothing is
   * reported. Every action on this page logs its own failure; that is the rule,
   * and whether it also re-throws depends only on whether the row needs to know
   * (`saveDescription` does — it is holding the user's text; these two do not).
   */
  async restoreTeam(teamId: string) {
    try {
      await this.apiService.restoreTeam(teamId);
      // Reload the current page (REPLACE — no empty flash); no page jump.
      await this.contextService.loadTeamsPage(this.currentPage, PAGE_SIZE);
    } catch (error) {
      console.error(`Failed to restore team ${teamId}:`, error);
      throw error;
    }
  }

  /**
   * LOGS and RESOLVES. Nothing downstream needs the rejection: the row clears
   * its mark on either outcome and there is no on-screen state to preserve, so
   * absorbing it here keeps the one caller's contract simple.
   *
   * It is NOT absorbed to avoid an unhandled rejection — the table's `track`
   * consumes both arms, so re-throwing would surface nowhere either. The
   * difference between this and `restoreTeam` is a caller's need, not a hazard;
   * what must never differ is that both LOG.
   */
  async stopTeam(teamId: string) {
    try {
      await this.contextService.stopTeamAndAwait(teamId);
    } catch (error) {
      console.error(`Failed to stop team ${teamId}:`, error);
    }
  }

  async refreshContext() {
    this.isRefreshing = true;
    try {
      // Reload the current page (REPLACE — no empty flash); no page jump.
      await this.contextService.loadTeamsPage(this.currentPage, PAGE_SIZE);
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * `(rowSelected)` handler. A row was picked; this page decides that means
   * OPEN IT BESIDE THE LIST (Epic 52 FR3) rather than navigate to it.
   *
   * The router call this replaced is the whole problem the epic exists for:
   * working a list of teams — the thing the filter bar was built to make
   * possible — meant a round trip through the router per team and losing the
   * filtered list each time.
   */
  onRowSelect(teamId: string) {
    if (this.selectedTeamId === teamId) {
      return;
    }
    this.selectedTeamId = teamId;
    this.writeUrl();
  }

  /** Close the open team; the list takes the full width again (FR7). */
  closeTeam(): void {
    if (this.selectedTeamId === null) {
      return;
    }
    this.selectedTeamId = null;
    this.writeUrl();
  }

  /**
   * `(teamUnavailable)` handler: the embedded view fetched the selected team
   * and there was none.
   *
   * A URL naming a deleted team is the ordinary way to arrive here — a
   * bookmark, or a link from someone who cleaned up afterwards — and the only
   * honest answer is to drop the selection. Leaving it would show an empty
   * pane with no way to tell it from a team that has simply said nothing yet.
   */
  onTeamUnavailable(): void {
    this.closeTeam();
  }

  /**
   * `(percentChange)` from the divider: move the panes, do not persist yet.
   *
   * Clamped HERE as well as inside the divider. That is not belt-and-braces: it
   * is what makes "`splitPercent` is always a width this page would lay out"
   * true of the field itself, rather than a property of whoever last wrote to
   * it. The value reaches the DOM as a `flex-basis` and the storage as a
   * string, and neither has an opinion about 1000%.
   */
  onSplitPercent(percent: number): void {
    this.splitPercent = clampSplitPercent(percent);
  }

  /**
   * `(commit)` from the divider: the drag ended, or a key was pressed. THIS is
   * what persists, so one drag costs one write instead of one per frame.
   */
  onSplitCommit(percent: number): void {
    this.onSplitPercent(percent);
    this.storeSplitPercent(this.splitPercent);
  }

  /**
   * Adopt the stored split width, or the default when there is none.
   *
   * Wrapped, because `localStorage` is not merely a map: reading it throws
   * outright when the browser blocks storage for the origin. A remembered pane
   * width is not worth a page that fails to render, so a refusal reads as "no
   * preference stored".
   */
  private restoreSplitPercent(): void {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(SPLIT_STORAGE_KEY);
    } catch {
      raw = null;
    }
    this.splitPercent = parseSplitPercent(raw) ?? SPLIT_DEFAULT_PERCENT;
  }

  /** As `restoreSplitPercent`: a refused write costs the preference, nothing more. */
  private storeSplitPercent(percent: number): void {
    try {
      localStorage.setItem(SPLIT_STORAGE_KEY, formatSplitPercent(percent));
    } catch {
      /* storage unavailable — the width still applies for this visit */
    }
  }

  /**
   * `(descriptionSaved)` handler. The table has already trimmed the draft and
   * turned an empty one into `null`; the page performs the write and hands the
   * work back, so the editor closes on success and stays open — with the typed
   * text — on failure.
   */
  onDescriptionSaved(save: TeamDescriptionSave): void {
    save.track(this.saveDescription(save.teamId, save.description));
  }

  /**
   * Persist a description, already trimmed by the caller.
   *
   * RE-THROWS after logging rather than swallowing. The failure is not this
   * page's alone to absorb any more: the table is holding an open editor with
   * the user's text in it, and a resolved promise would tell it the save
   * succeeded and take the text away.
   */
  async saveDescription(teamId: string, description: string | null) {
    try {
      // Note: updateTeamDescription is a no-op in V2 (no equivalent endpoint).
      // Description changes will not persist. This is a known limitation.
      console.warn(
        'Description editing is not available in V2 -- changes will not persist.'
      );
      await this.apiService.updateTeamDescription(teamId, description);

      // Update local context optimistically. The service owns its cache and
      // writes a NEW team object through its single write path — an in-place
      // write here re-emitted nothing and left the screen stale (story 37-3).
      this.contextService.setTeamDescription(teamId, description);
    } catch (error) {
      console.error('Failed to update description:', error);
      throw error;
    }
  }

  /**
   * Dialog dirty-close guard (ADR-018).
   *
   * The `p-dialog` binding is split into `[visible]` + `(visibleChange)` so
   * this handler can intercept close attempts (the X button / dismissable
   * mask; Esc is handled by `onConfigDialogEscape`). When the user dismisses
   * the dialog and the panel reports unsaved changes, re-assert
   * `namespacePanelVisible = true` to keep the dialog open while the panel's
   * `confirmDiscard()` modal runs. On Proceed (resolve `true`) flip visibility
   * to false; on Cancel/dismiss (resolve `false`) leave the dialog open with
   * the buffer intact.
   *
   * `this.namespacePanel` may be `undefined` (the panel is mounted lazily
   * via @defer) — when it is not mounted there is nothing to discard, so
   * the close proceeds without a confirm.
   */
  onNamespacePanelVisibleChange(visible: boolean): void {
    if (visible) {
      // The dialog is being opened — the Edit button click already flipped
      // `namespacePanelVisible = true`. No-op.
      return;
    }
    const panel = this.namespacePanel;
    if (!panel || !panel.hasUnsavedChanges()) {
      this.namespacePanelVisible = false;
      return;
    }
    // Dirty panel — re-assert visibility to keep the dialog open while the
    // panel's custom confirm modal runs. Proceed closes; Cancel/dismiss keeps
    // it open.
    this.namespacePanelVisible = true;
    void panel.confirmDiscard().then((discard) => {
      if (discard) {
        this.namespacePanelVisible = false;
      }
    });
  }

  /**
   * Single coordinated Escape handler for the config dialog (ADR-018).
   *
   * All three dialogs (this host config dialog + the panel's Clone + confirm
   * modals) set `[closeOnEscape]="false"`, so PrimeNG's per-dialog
   * document-level Esc listeners never fire and cannot cascade. Instead this
   * ONE document-level handler coordinates Escape while the config dialog is
   * open. A document listener (not a `<p-dialog>`-scoped one) is load-bearing:
   * a secondary modal is teleported to `<body>` as a SIBLING overlay, so its
   * keydown does not bubble to the config dialog element — only a
   * document-level handler sees Escape regardless of which overlay has focus.
   *
   * Exactly ONE action per Escape, in priority order:
   *   1. delegate to `panel.handleSecondaryEscape()` — if a secondary modal
   *      (confirm, then Clone) is open it closes ONLY the topmost one and
   *      returns `true`; we stop there.
   *   2. otherwise (no secondary panel open) run the config panel's own close
   *      flow (`onNamespacePanelVisibleChange(false)`), which routes a dirty
   *      buffer through `confirmDiscard()`.
   *
   * Inactive unless the config dialog is open; a write-in-flight suppresses
   * Escape entirely.
   */
  @HostListener('document:keydown.escape', ['$event'])
  onConfigDialogEscape(event: Event): void {
    if (!this.namespacePanelVisible || this.isWriteInFlight) {
      return;
    }
    const panel = this.namespacePanel;
    if (panel?.handleSecondaryEscape() === true) {
      // A secondary modal consumed the Escape — do not also close the config
      // panel. Prevent the default so nothing else acts on this keystroke.
      event.preventDefault();
      return;
    }
    this.onNamespacePanelVisibleChange(false);
  }

  /**
   * `(saved)` output handler. Re-fetches namespaces so any summary-metadata
   * changes (e.g. renamed description) propagate to the dropdown. Shares
   * `loadNamespaces()` with `ngOnInit` to keep the fetch logic in one place.
   */
  async onNamespaceSaved(): Promise<void> {
    await this.loadNamespaces();
  }

  /**
   * Admin "show all namespaces" toggle handler. Flips the component flag and
   * re-runs the single `loadNamespaces()` path so the `all` flag flows through
   * it (the toggle never calls `getNamespaces` directly — that keeps every
   * load path consistent and preserves the stale-selection reconciliation on
   * the re-fetch). Turning on requests `?all=true` (admin firehose); turning
   * off restores the normal owner+public list.
   */
  async onToggleShowAll(value: boolean): Promise<void> {
    this.showAllNamespaces = value;
    await this.loadNamespaces();
  }

  /**
   * Pure derivation of namespace identifiers from the synchronous current
   * value of `namespaces$`. Supplied to the panel via `[existingNamespaces]`
   * for the Clone dialog's pre-flight collision check. Getter instead of a
   * dedicated stream because BehaviorSubject exposes `.value` synchronously;
   * no pipe / async needed.
   */
  get namespaceIdentifiers(): string[] {
    return (this.namespaces$.value ?? []).map((n) => n.namespace);
  }

  /**
   * Write-in-flight predicate. True iff the panel is currently saving OR
   * cloning. Reads (validate / load) are NON-destructive and intentionally
   * excluded so the operator can dismiss the dialog while a Validate request
   * is mid-flight.
   *
   * Used by the dialog's `[closable]` / `[dismissableMask]` bindings and by
   * the coordinated `onConfigDialogEscape` handler to lock all dismissal
   * channels during an in-flight write. (`[closeOnEscape]` is always `false` —
   * Escape is owned by `onConfigDialogEscape`.) The panel's destroyed-guard
   * absorbs late resolutions; this gate just prevents the operator from
   * hitting that race in the first place.
   */
  get isWriteInFlight(): boolean {
    return (
      this.namespacePanel?.saving === true ||
      this.namespacePanel?.cloning === true
    );
  }

  /**
   * Namespace label for the dialog header. Resolves (selectedNamespace.name ??
   * selectedNamespace.namespace ?? 'Namespace'). Wrapped in a getter so the
   * dialog's `<ng-template pTemplate="header">` block can render it alongside
   * the conditional dirty indicator without two async pipes.
   */
  get namespaceLabel(): string {
    const selected = this.selectedNamespace$.value;
    if (selected === null) {
      return 'Namespace';
    }
    return selected.name ?? selected.namespace ?? 'Namespace';
  }

  visible = false;
}
