import { inject, Injectable } from '@angular/core';

import { ContextService } from '../../../core/context/context.service';
import { HttpError } from '../../../core/http/fetch.service';
import {
  NamespaceSummary,
  TeamMetadataContract,
} from '../../../protocol/catalog.interface';

/**
 * How a creation was asked for. The gate NEVER infers this — the caller says,
 * because the two call sites are not the same event and must not be averaged.
 *
 * `'gesture'` is the Create button. `'auto'` is the `hideHome` route, which
 * creates on arrival with no user gesture at all; that is exactly where a
 * mandatory field would go unanswered unnoticed, and why it gates too.
 */
export type CreationOrigin = 'gesture' | 'auto';

/** What the gate did. */
export type CreationOutcome = 'asked' | 'created' | 'failed';

/**
 * The creation gate: whether creating a team must ask something first, the
 * dialog that asks it, and the create itself.
 *
 * ONE decision for BOTH call sites. Before this service the question "does this
 * namespace ask anything?" was consulted twice — once on the Create button and
 * once on the gesture-less `hideHome` route — and each site then decided
 * modal-or-create for itself. Two copies of one question drift; they already
 * differed in one respect (the spinner). Here the difference is an ARGUMENT
 * (`origin`) rather than a duplicated `if`, so it stays visible and stays
 * testable.
 *
 * A SERVICE, not a component: this is a workflow, not a view. The only view is
 * the dialog, which is already its own purely-presentational component; what
 * was left on the page was the workflow around it. It is also why the gate can
 * be tested by providing it and a `ContextService` spy and nothing else — no
 * router, no route, no fixture.
 *
 * PROVIDED BY THE PAGE, never `providedIn: 'root'`. Today the dialog's state
 * dies with the component; a root-scoped gate would carry a captured namespace
 * and an open dialog across a navigation away and back, which is a user-visible
 * change rather than a refactor.
 */
@Injectable()
export class TeamCreationService {
  private contextService = inject(ContextService);

  // -----------------------------------------------------------------------
  // The dialog's state. Plain fields behind getters — not signals and not
  // observables: the page reads them through ordinary template bindings, they
  // hold primitives and a stable object reference, and a change-detection
  // idiom swap is a behaviour risk this extraction does not need.
  // -----------------------------------------------------------------------

  private _modalVisible = false;
  private _contract: TeamMetadataContract | null = null;

  // The namespace and its label are CAPTURED when the modal opens, never read
  // back off the page's selection. The dropdown stays live behind the dialog,
  // so re-reading the selection in the confirm handler would create a team for
  // whatever is selected THEN — not what the header said and not what the user
  // answered. The gate holds no reference to the selection at all, which is
  // what makes this structural rather than merely careful.
  private _namespace: string | null = null;
  private _namespaceLabel = '';

  // The server's 422 message. Non-null keeps the modal open with an inline
  // explanation; every other failure leaves it null (FetchService has already
  // toasted, so a second message would double up).
  private _error: string | null = null;

  // A confirmed create is in flight — locks the modal's controls. Distinct
  // from `creatingByGesture`, which is the page's Create-button spinner and
  // must NOT turn merely because a dialog is open.
  private _submitting = false;

  // A modal confirm is only meaningful while a namespace is captured; the
  // destination is always the new team's process view, so no mode is kept.
  private _pending = false;

  private _creatingByGesture = false;

  /** Is the metadata dialog open? */
  get modalVisible(): boolean {
    return this._modalVisible;
  }

  /** The contract the dialog is asking for, or `null` when it is closed. */
  get contract(): TeamMetadataContract | null {
    return this._contract;
  }

  /** Named in the dialog header, captured at open time. */
  get namespaceLabel(): string {
    return this._namespaceLabel;
  }

  /** The server's 422 message, or `null` when there is nothing to show. */
  get errorMessage(): string | null {
    return this._error;
  }

  /** A confirmed create is in flight — the dialog locks its controls. */
  get submitting(): boolean {
    return this._submitting;
  }

  /**
   * True only while an UNGATED create issued BY A GESTURE is in flight — the
   * Create button's spinner and its double-submit guard. An `auto` creation
   * never turns it: the button is not what asked, and a spinner on a control
   * nobody pressed is a lie. THIS getter is where the two call sites stay
   * visibly different.
   */
  get creatingByGesture(): boolean {
    return this._creatingByGesture;
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
  contractOf(ns: NamespaceSummary): TeamMetadataContract | null {
    const contract = ns.team_metadata;
    return contract && contract.fields.length > 0 ? contract : null;
  }

  /**
   * The single decision, for BOTH call sites.
   *
   *   `'asked'`   — the dialog is now open; nothing was created.
   *   `'created'` — the team was created and the app is navigating to it.
   *   `'failed'`  — an ungated create rejected; logged here.
   *
   * The contract is consulted ONCE, whatever the origin. A gate that skipped
   * the question for `'auto'` would let a mandatory field go unanswered on the
   * one route where nobody is watching.
   */
  async request(ns: NamespaceSummary, origin: CreationOrigin): Promise<CreationOutcome> {
    const contract = this.contractOf(ns);
    if (contract) {
      // Ask first. No POST, and no spinner while the dialog is open.
      this.openMetadataModal(ns, contract);
      return 'asked';
    }
    // The spinner doubles as the double-click guard; it wraps the POST only,
    // never the dialog. Cleared in `finally` even though navigation usually
    // unmounts the page first — a rejected create must re-arm the button.
    //
    // ONLY for a gesture. The button is not what asked on the `hideHome`
    // route, and a control nobody pressed must not report itself busy.
    const gestured = origin === 'gesture';
    if (gestured) {
      this._creatingByGesture = true;
    }
    try {
      await this.createAndNavigate(ns.namespace);
      return 'created';
    } catch (error) {
      console.error('Failed to create team:', error);
      return 'failed';
    } finally {
      if (gestured) {
        this._creatingByGesture = false;
      }
    }
  }

  /**
   * `(confirmed)` handler. Dispatches to the same shared body the un-gated
   * branch of the originating path would have run, with the namespace captured
   * at open time.
   *
   * On success the modal closes and the state resets. On ANY failure it stays
   * open with the user's input intact — closing on a network blip would discard
   * everything typed, and Cancel is always available, so the user is never
   * trapped.
   */
  async confirm(metadata: Record<string, string>): Promise<void> {
    const namespace = this._namespace;
    if (namespace === null || !this._pending) {
      return;
    }
    this._submitting = true;
    this._error = null;
    try {
      await this.createAndNavigate(namespace, metadata);
      this.closeMetadataModal();
    } catch (error) {
      this.handleMetadataCreateError(error);
    } finally {
      this._submitting = false;
    }
  }

  /** `(cancelled)` handler. Creates nothing and leaves the spinner alone. */
  cancel(): void {
    this.closeMetadataModal();
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

  /**
   * Open the metadata dialog for `ns`, capturing the namespace AND its label
   * at open time (the dropdown stays live behind the dialog).
   *
   * PRIVATE. `request` is the only way in: a public opener would let a caller
   * open the dialog without asking the gate whether it should — which is the
   * duplication this service exists to remove, reintroduced through a
   * different door.
   *
   * Deliberately does NOT touch `_creatingByGesture`: the Create button must
   * not spin for as long as the dialog is open, nor keep spinning after Cancel.
   */
  private openMetadataModal(
    ns: NamespaceSummary,
    contract: TeamMetadataContract,
  ): void {
    this._namespace = ns.namespace;
    this._namespaceLabel = ns.name || ns.namespace;
    this._contract = contract;
    this._error = null;
    this._submitting = false;
    this._pending = true;
    this._modalVisible = true;
  }

  private closeMetadataModal(): void {
    this._modalVisible = false;
    this._contract = null;
    this._namespace = null;
    this._namespaceLabel = '';
    this._error = null;
    this._pending = false;
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
      this._error = message.trim() === '' ? null : message;
      return;
    }
    // Every non-422 failure has ALREADY been toasted by FetchService —
    // nothing to add here.
    this._error = null;
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
}
