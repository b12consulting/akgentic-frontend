import {
  Component,
  HostListener,
  inject,
  ViewChild,
  ViewChildren,
  QueryList,
  ElementRef,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { BehaviorSubject, firstValueFrom, Observable } from 'rxjs';
import { filter, map, take } from 'rxjs/operators';

import { ApiService, MIN_FILTER_TERM_LENGTH } from '../../core/http/api.service';
import { HttpError } from '../../core/http/fetch.service';
import { isRunning, TeamFilter } from '../../core/context/team.interface';
import {
  TeamMetadataPipe,
  trackMetadataEntry,
} from '../../core/context/team-metadata.pipe';
import {
  MetadataFieldDescriptor,
  NamespaceSummary,
  TeamMetadataContract,
} from '../../protocol/catalog.interface';

import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { ToggleSwitchModule } from 'primeng/toggleswitch';

import { AuthService } from '../../core/auth/auth.service';
import { ConfigService } from '../../core/config/config.service';
import { ContextService } from '../../core/context/context.service';

// Listed in @Component.imports so Angular's @defer block can resolve
// <app-namespace-panel>. The `@defer (when ...)` block in the template keeps
// the component's compiled code (and its Monaco chunk) in a deferred chunk
// loaded only on first opening of the namespace-editor dialog — the initial
// home-page bundle stays Monaco-free.
import { NamespacePanelComponent } from '../catalog/namespace-panel/namespace-panel.component';
import {
  metadataFieldLabel,
  TeamMetadataModalComponent,
} from './team-metadata-modal/team-metadata-modal.component';

// Classic team-list page size (Epic 28, ADR-032 §Decision 3). Bound to the
// paginator's [rows] and used as the loadTeamsPage size fallback so no magic
// 250 literal is duplicated. Server clamps size to [1, 500].
const PAGE_SIZE = 250;

@Component({
  selector: 'app-home',
  imports: [
    FormsModule,
    TableModule,
    SelectModule,
    ButtonModule,
    TagModule,
    CommonModule,
    DialogModule,
    InputTextModule,
    ToggleSwitchModule,
    NamespacePanelComponent,
    TeamMetadataModalComponent,
    TeamMetadataPipe,
  ],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent {
  apiService: ApiService = inject(ApiService);
  contextService: ContextService = inject(ContextService);
  router: Router = inject(Router);
  authService: AuthService = inject(AuthService);
  private config = inject(ConfigService);

  // Catalog namespaces for the team creation dropdown
  namespaces$ = new BehaviorSubject<NamespaceSummary[]>([]);
  selectedNamespace$ = new BehaviorSubject<NamespaceSummary | null>(null);
  isCreatingTeam = false;
  isRefreshing = false;
  stoppingTeams = new Set<string>();
  restoringTeams = new Set<string>();
  editingDescriptionFor: string | null = null;
  descriptionDrafts = new Map<string, string>();

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

  @ViewChildren('descriptionInput') descriptionInputs!: QueryList<ElementRef>;

  // @ViewChild on the @defer-rendered panel. The reference is `undefined`
  // until the user opens the dialog (the @defer block only mounts the child
  // when `namespacePanelVisible` flips true), so the close handler MUST
  // null-check. `{ static: false }` is the default for @ViewChild on
  // conditionally-rendered children; no explicit option needed.
  @ViewChild(NamespacePanelComponent)
  namespacePanel?: NamespacePanelComponent;

  // -----------------------------------------------------------------------
  // Team-metadata modal host state.
  //
  // The modal is purely presentational: it renders the contract and emits the
  // answers. Everything below is the host's half — which namespace the user
  // answered FOR, which creation path is waiting on the answer, and what the
  // server said if it refused.
  // -----------------------------------------------------------------------

  metadataModalVisible = false;
  metadataContract: TeamMetadataContract | null = null;

  // The namespace and its label are CAPTURED when the modal opens, never read
  // back off `selectedNamespace$`. The dropdown stays live behind the dialog,
  // so re-reading the selection in the confirm handler would create a team for
  // whatever is selected THEN — not what the header said and not what the user
  // answered.
  metadataNamespace: string | null = null;
  metadataNamespaceLabel = '';

  // The server's 422 message. Non-null keeps the modal open with an inline
  // explanation; every other failure leaves it null (FetchService has already
  // toasted, so a second message would double up).
  metadataError: string | null = null;

  // A confirmed create is in flight — locks the modal's controls. Distinct
  // from `isCreatingTeam`, which is the page's Create-button spinner and must
  // NOT turn merely because a dialog is open.
  metadataSubmitting = false;

  // A modal confirm is only meaningful while a namespace is captured; the
  // destination is always the new team's process view, so no mode is kept.
  private pendingCreation = false;

  // Expose isRunning to template
  isRunning = isRunning;

  // `trackBy` for the Metadata column's chips. See the pipe.
  trackMetadataEntry = trackMetadataEntry;

  // -----------------------------------------------------------------------
  // The filter bar (Epic 48).
  //
  // The selected namespace's contract decides which inputs exist; the terms
  // typed into them plus the narrowing toggle compose a `TeamFilter` that the
  // context service debounces and turns into one page-1 request.
  // -----------------------------------------------------------------------

  /**
   * The fields the bar currently offers an input for — a FIELD, recomputed
   * only when the selection changes, never a getter.
   *
   * A getter would return a fresh array on every change-detection cycle, which
   * `NgForOf` reads as "every item replaced" and rebuilds every input each
   * tick — losing focus and the caret mid-word. That is exactly the churn
   * Epic 47 removed from the metadata chips; do not reintroduce it here.
   */
  filterFields: MetadataFieldDescriptor[] = [];

  /** What is typed into each offered input, keyed by field key. */
  filterTerms: Record<string, string> = {};

  /** The narrowing control: on, the request carries `catalog_namespace`. */
  filterByNamespace = false;

  /** Exposed for the inputs' placeholder — one floor, named in one place. */
  readonly minFilterTermLength = MIN_FILTER_TERM_LENGTH;

  /** Labels a filter input exactly as the creation modal labels its own. */
  metadataFieldLabel = metadataFieldLabel;

  /** `trackBy` for the filter inputs — the field key is their identity. */
  trackFilterField = (_index: number, field: MetadataFieldDescriptor): string =>
    field.key;

  async ngOnInit() {
    // FIRST, and synchronously. `ContextService` is a root singleton, so a
    // filter set during an earlier visit to this page outlives the component
    // that set it: without this, navigating to a team and back would re-create
    // this component with empty inputs while the table's first `(onLazyLoad)`
    // still carried the previous visit's terms — a filtered set painted under
    // an empty form. `clearFilter` writes only the value subject, so the reset
    // itself issues NO fetch and the table's own first lazy load remains the
    // sole page-1 seed (Story 28.2).
    this.contextService.clearFilter();

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
        // Gated like every other creation path. This one runs with NO user
        // gesture, so skipping the modal here is precisely how a mandatory
        // field would go unfilled without anyone noticing: when the namespace
        // asks something, open the dialog and return — ngOnInit completes with
        // no team created, and the answer (or the cancel) decides.
        const contract = this.metadataContractOf(selected);
        if (contract) {
          this.openMetadataModal(selected, contract);
          return;
        }
        await this.createAndNavigate(selected.namespace);
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

  /**
   * Does this namespace ask anything before its team can be created?
   *
   * The ONE place the three no-ask states are collapsed. `null` (the team
   * declares no contract), `undefined` (a server predating the field omits the
   * key, and even a current server's OpenAPI leaves it out of `required`, so a
   * generated client types it possibly-undefined) and a declared contract with
   * an empty `fields` list all mean "ask nothing". GATING ON `=== null` ALONE
   * IS A BUG — the test is falsiness, plus the empty-fields collapse.
   */
  private metadataContractOf(ns: NamespaceSummary): TeamMetadataContract | null {
    const contract = ns.team_metadata;
    return contract && contract.fields.length > 0 ? contract : null;
  }

  // -----------------------------------------------------------------------
  // Filter bar behaviour (Epic 48).
  // -----------------------------------------------------------------------

  /**
   * Which fields the bar offers an input for, for a given namespace.
   *
   * ONE gate, and it is `metadataContractOf`'s — the same collapse of the
   * three no-ask states (absent key, `null`, a declared contract with an empty
   * `fields` list) the creation path already makes. Gating on `=== null` alone
   * is a bug: an older server omits the key entirely.
   *
   * Then `index` ALONE decides. `mandatory` is read not at all: the two flags
   * are independent, so reusing the modal's mandatory logic would offer a set
   * of inputs that is neither a subset nor a superset of the right one — and
   * it would look plausible on every namespace whose fields happen to be both.
   */
  private offeredFilterFields(
    ns: NamespaceSummary | null,
  ): MetadataFieldDescriptor[] {
    const contract = ns === null ? null : this.metadataContractOf(ns);
    return contract === null ? [] : contract.fields.filter((f) => f.index);
  }

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
    this.selectedNamespace$.next(ns);
    this.filterFields = this.offeredFilterFields(ns);
    this.filterTerms = {};
    if (previous === null && !this.filterByNamespace) {
      return;
    }
    this.onFilterChanged();
  }

  /** A metadata input changed. */
  onFilterTermChanged(key: string, term: string): void {
    this.filterTerms[key] = term;
    this.onFilterChanged();
  }

  /** The narrowing control was flipped. */
  onFilterNamespaceToggle(value: boolean): void {
    this.filterByNamespace = value;
    this.onFilterChanged();
  }

  /**
   * Compose the current filter from the form state.
   *
   * An input nobody has typed into contributes no entry — that is ABSENCE, not
   * a length rule. THE THREE-CHARACTER FLOOR IS NOT APPLIED HERE: it lives at
   * exactly one point, `ApiService.getTeamsPage`, where the parameter is
   * composed. A short term therefore travels into the filter model and is
   * dropped from the URL, which is what keeps the list UNFILTERED rather than
   * empty while a user is still typing. A second check here would be a second
   * thing to keep in step, and the two would eventually disagree.
   */
  private composeFilter(): TeamFilter {
    const meta: Record<string, string> = {};
    for (const field of this.filterFields) {
      const term = this.filterTerms[field.key] ?? '';
      if (term !== '') {
        meta[field.key] = term;
      }
    }
    return {
      meta,
      catalogNamespace: this.filterByNamespace
        ? (this.selectedNamespace$.value?.namespace ?? null)
        : null,
    };
  }

  /**
   * Push the composed filter at the service, and reset the paginator — a
   * filtered list has a different length, so page 4 of the old result set is
   * meaningless.
   *
   * ORDER MATTERS. The filter is handed to the service FIRST, then the
   * paginator is reset, because `p-table`'s `[first]` binding re-fires
   * `(onLazyLoad)` when the bound value changes — which issues one extra
   * `loadTeamsPage` alongside the debounced fetch. That extra request is not
   * WRONG: the service already holds the new filter by the time it runs, so it
   * asks the same question and carries the same answer. Written the other way
   * round it would ask the OLD question.
   *
   * `first` is written only when it is not already `0`, which keeps that extra
   * request to at most one per filter session; the common case — already on
   * page 1 — produces none at all.
   */
  private onFilterChanged(): void {
    this.contextService.setFilter(this.composeFilter());
    if (this.first !== 0) {
      this.first = 0;
    }
    this.currentPage = 1;
  }

  /**
   * Create and go to the new team's process view. EVERY creation path lands
   * here — with or without the metadata modal, gestured or not — because a
   * user who just created a team wants to be IN it, not looking at its row.
   * `contextService.createTeamAndNavigate` creates, seeds the team into the
   * context cache (so the process view has it before any refetch), and
   * navigates; there is no reload compensation because the home page is being
   * left behind.
   *
   * `metadata` is forwarded UNCONDITIONALLY, including when `undefined`. The
   * "attach the key only when non-empty" rule lives in exactly one place,
   * `apiService.createTeam`; forwarding `undefined` produces the same body by
   * construction.
   *
   * Rejections propagate: the modal path needs to see a 422 to keep itself
   * open, so the swallow-and-log lives in the caller.
   */
  private async createAndNavigate(
    namespace: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    await this.contextService.createTeamAndNavigate(namespace, metadata);
  }

  async createTeam() {
    const selected = this.selectedNamespace$.value;
    if (!selected) {
      console.warn('No namespace selected');
      return;
    }
    const contract = this.metadataContractOf(selected);
    if (contract) {
      // Ask first. No POST, and no spinner while the dialog is open.
      this.openMetadataModal(selected, contract);
      return;
    }
    // The spinner doubles as the double-click guard; it wraps the POST only,
    // never the dialog. Cleared in `finally` even though navigation usually
    // unmounts this page first — a rejected create must re-arm the button.
    this.isCreatingTeam = true;
    try {
      await this.createAndNavigate(selected.namespace);
    } catch (error) {
      console.error('Failed to create team:', error);
    } finally {
      this.isCreatingTeam = false;
    }
  }

  /**
   * Open the metadata dialog for `ns`, capturing the namespace AND its label
   * at open time (the dropdown stays live behind the dialog).
   *
   * Deliberately does NOT touch `isCreatingTeam`: the Create button must not
   * spin for as long as the dialog is open, nor keep spinning after Cancel.
   */
  private openMetadataModal(
    ns: NamespaceSummary,
    contract: TeamMetadataContract,
  ): void {
    this.metadataNamespace = ns.namespace;
    this.metadataNamespaceLabel = ns.name || ns.namespace;
    this.metadataContract = contract;
    this.metadataError = null;
    this.metadataSubmitting = false;
    this.pendingCreation = true;
    this.metadataModalVisible = true;
  }

  /**
   * `(confirmed)` handler. Dispatches to the same shared body the un-gated
   * branch of the originating path would have run, with the namespace captured
   * at open time.
   *
   * On success the modal closes and the host state resets. On ANY failure it
   * stays open with the user's input intact — closing on a network blip would
   * discard everything typed, and Cancel is always available, so the user is
   * never trapped.
   */
  async onMetadataConfirm(metadata: Record<string, string>): Promise<void> {
    const namespace = this.metadataNamespace;
    if (namespace === null || !this.pendingCreation) {
      return;
    }
    this.metadataSubmitting = true;
    this.metadataError = null;
    try {
      await this.createAndNavigate(namespace, metadata);
      this.closeMetadataModal();
    } catch (error) {
      this.handleMetadataCreateError(error);
    } finally {
      this.metadataSubmitting = false;
    }
  }

  /** `(cancelled)` handler. Creates nothing and leaves `isCreatingTeam` alone. */
  onMetadataCancel(): void {
    this.closeMetadataModal();
  }

  private closeMetadataModal(): void {
    this.metadataModalVisible = false;
    this.metadataContract = null;
    this.metadataNamespace = null;
    this.metadataNamespaceLabel = '';
    this.metadataError = null;
    this.pendingCreation = false;
  }

  /**
   * A rejected create keeps the modal open either way; only the 422 carries a
   * message worth rendering, because it names the offending field and the user
   * cannot correct anything without it. Every other failure has ALREADY been
   * toasted by FetchService, so nothing is added here — no second message, no
   * new error type, no retry.
   */
  private handleMetadataCreateError(error: unknown): void {
    const status = (error as { status?: number })?.status;
    if (status === 422) {
      // An extraction that comes back empty — an empty response body, which
      // `FetchService` hands over as `''`, or a `{"detail": []}` envelope —
      // must NOT become an empty alert region. `errorMessage` is rendered on
      // `!== null`, so `''` would paint an empty red box and announce an empty
      // `role="alert"`. Nothing to say means say nothing, as for any other
      // failure; the modal still stays open with the input intact.
      const message = this.metadataErrorMessage((error as HttpError).body);
      this.metadataError = message.trim() === '' ? null : message;
      return;
    }
    // Every non-422 failure has ALREADY been toasted by FetchService —
    // nothing to add here.
    this.metadataError = null;
  }

  /**
   * Extract a renderable message from an `HttpError.body`, which is the parsed
   * JSON when the server sent JSON and the raw text otherwise. Three shapes
   * reach here from the create endpoint: a bare string, a `{detail: "..."}`
   * envelope, and FastAPI/Pydantic's `{detail: [{loc, msg}, ...]}` list — the
   * one that names the offending field, rendered one line per entry as
   * "<last loc segment>: <msg>". Anything else is shown verbatim.
   */
  private metadataErrorMessage(body: unknown): string {
    if (typeof body === 'string') {
      return body;
    }
    const detail = (body as { detail?: unknown } | null)?.detail;
    if (typeof detail === 'string') {
      return detail;
    }
    if (Array.isArray(detail)) {
      return detail.map((entry) => this.metadataErrorLine(entry)).join('\n');
    }
    return JSON.stringify(body);
  }

  /** One `{loc, msg}` entry as "<field>: <msg>", or just the message. */
  private metadataErrorLine(entry: unknown): string {
    const loc = (entry as { loc?: unknown })?.loc;
    const msg = (entry as { msg?: unknown })?.msg;
    const message = typeof msg === 'string' ? msg : JSON.stringify(entry);
    const field =
      Array.isArray(loc) && loc.length > 0 ? String(loc[loc.length - 1]) : '';
    return field === '' ? message : `${field}: ${message}`;
  }

  async deleteTeam(teamId: string) {
    await this.contextService.deleteTeam(teamId);
  }

  async restoreTeam(teamId: string) {
    this.restoringTeams.add(teamId);
    try {
      await this.apiService.restoreTeam(teamId);
      // Reload the current page (REPLACE — no empty flash); no page jump.
      await this.contextService.loadTeamsPage(this.currentPage, PAGE_SIZE);
    } finally {
      this.restoringTeams.delete(teamId);
    }
  }

  isRestoring(teamId: string): boolean {
    return this.restoringTeams.has(teamId);
  }

  async stopTeam(teamId: string) {
    this.stoppingTeams.add(teamId);
    try {
      await this.contextService.stopTeamAndAwait(teamId);
    } catch (error) {
      console.error(`Failed to stop team ${teamId}:`, error);
    } finally {
      this.stoppingTeams.delete(teamId);
    }
  }

  isStopping(teamId: string): boolean {
    return this.stoppingTeams.has(teamId);
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

  onRowSelect(event: any) {
    const teamId = event.data.team_id;
    this.router.navigate(['/process', teamId]);
  }

  startEditDescription(teamId: string, currentDescription: string | null) {
    this.editingDescriptionFor = teamId;
    this.descriptionDrafts.set(teamId, currentDescription || '');

    // Focus the input field after the view updates
    setTimeout(() => {
      const input = this.descriptionInputs?.first?.nativeElement;
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }

  cancelEditDescription() {
    this.editingDescriptionFor = null;
  }

  async saveDescription(teamId: string) {
    const description = this.descriptionDrafts.get(teamId) || null;
    const trimmed = description?.trim() || null;

    try {
      // Note: updateTeamDescription is a no-op in V2 (no equivalent endpoint).
      // Description changes will not persist. This is a known limitation.
      console.warn(
        'Description editing is not available in V2 -- changes will not persist.'
      );
      await this.apiService.updateTeamDescription(teamId, trimmed);

      // Update local context optimistically. The service owns its cache and
      // writes a NEW team object through its single write path — an in-place
      // write here re-emitted nothing and left the screen stale (story 37-3).
      this.contextService.setTeamDescription(teamId, trimmed);

      this.editingDescriptionFor = null;
    } catch (error) {
      console.error('Failed to update description:', error);
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
