import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  Signal,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { map } from 'rxjs/operators';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';

import { TeamCreationService } from '../../../core/services/home/team-creation/team-creation.service';
import { TeamTypeCatalog } from '../../../core/services/home/team-creation/team-type-catalog.service';
import { TeamMetadataModalComponent } from '../../../core/components/features/team-list/metadata-modal/team-metadata-modal.component';
import { AuthService } from '../../../core/platform/auth/auth.service';
import { TeamCreationLauncher } from '../team-creation-launcher.service';
import { NamespaceSummary } from '../../../core/protocol/catalog.interface';

/** Which half of the wizard is on screen. */
export type CreationStep = 'type' | 'metadata';

/**
 * What the type list is showing.
 *
 * THREE STATES, and `loading` is separate from `empty` for the same reason the
 * rail keeps them apart: "you have no team types" is a claim about the account,
 * and making it while the fetch is still in flight tells a user with a slow
 * connection that they cannot create anything. Emptiness is only attributable
 * once the fetch has settled.
 */
export type CreationTypesState = 'loading' | 'empty' | 'types';

/**
 * The two-step "new agent team" wizard: choose a team type, then answer that
 * type's questions.
 *
 * ONE COMPONENT, TWO DIALOGS, NEVER BOTH. `step` decides which of the two is
 * visible, and the two conditions are each other's negation by construction —
 * `[visible]="step() === 'type'"` here, `[visible]="step() === 'metadata'"` on
 * the metadata modal. Two overlays would mean two Escape handlers and a user
 * whose first Escape dismisses an invisible dialog.
 *
 * `TeamCreationService` IS PROVIDED HERE, ON THIS COMPONENT — not on the rail,
 * not at root. That service's own doc says its captured namespace and open
 * dialog must die with their host rather than survive a navigation away and
 * back. This component lives behind an `@if` in `app.component.html`, so it is
 * created when the wizard opens and destroyed when it closes: a STRICTLY
 * SHORTER lifetime than the page that hosts the service today. The contract is
 * preserved, not stretched. Do not "simplify" this to a root provider — that is
 * precisely the cross-navigation leak the scoping exists to prevent, and it
 * would not fail a test, it would fail a user.
 *
 * THE STEP MACHINE IS `request()`'s RETURN VALUE. There is no second state
 * machine here deciding modal-or-create: that decision is the gate's, it is
 * made once, and this component only reacts to which of the three answers came
 * back. Re-deriving it — in particular testing `contractOf(ns) === null` rather
 * than its falsiness — is the documented bug that gate exists to have fixed
 * once.
 *
 * WHY THE TWO `components/home/` IMPORTS BELOW ARE LEGAL. `TeamCreationService`
 * and `TeamMetadataModalComponent` live under `components/home/` but are NOT
 * tagged `page-home`: `eslint.config.js:137-144` gives each of their folders the
 * element type `feature-team-creation`, listed AHEAD of the `page-home` pattern
 * because `eslint-plugin-boundaries` matches in order and the broader pattern
 * would otherwise swallow them. They stopped being home-page leaves the moment a
 * second surface embedded them verbatim — the same situation `feature-catalog`
 * was carved out for — and a tag is a statement about what a folder IS, so it
 * had to follow.
 *
 * The carve-out is deliberately one-directional. `feature-team-creation` may
 * depend on `core`, `shared` and `protocol` and on nothing else; it may not
 * import a page or the console. That restriction is the whole reason the
 * carve-out cannot become a `page-home <-> console` edge by the back door —
 * without it, tagging a folder out of `page-home` would be a way to launder any
 * page-to-page import through a third name.
 *
 * Do NOT resolve this by copying either symbol into `console/` — a second
 * creation gate is the duplication `TeamCreationService` exists to have removed.
 *
 * THE ADMIN "SHOW ALL TEAM TYPES" TOGGLE IS HERE BECAUSE IT USED TO BE ON THE
 * PAGE (ADR-028). Before R2 an admin could turn the management page's "show all
 * namespaces" switch on and then create a team into one of the foreign-owned
 * types it surfaced — the team-type select and the Create button both read the
 * widened list. Moving creation to the rail took the Create button away, so
 * without this toggle that was a capability SILENTLY REMOVED by a requirement
 * that never mentioned it. It is reproduced rather than dropped, with the two
 * properties the page's version had and one it did not:
 *
 *   - ADMIN-ONLY and OFF BY DEFAULT, so the firehose stays opt-in. As on the
 *     page, this is a UX affordance and NOT the security boundary: `?all=true`
 *     is honoured server-side only for admins, and a non-admin who forges it
 *     gets the ordinary owner+public list back.
 *   - THE EXTRA ROWS ARE MARKED. Creating into a namespace somebody else owns
 *     is the riskiest thing this dialog can do, and on the page it was
 *     indistinguishable from creating into your own. "Foreign" is computed as
 *     set difference — a row in the widened list that the owner-scoped list did
 *     not contain — rather than by comparing `owner` to the current user, which
 *     would need an identity mapping this client does not have and would answer
 *     wrongly for the `owner: null` rows.
 *
 * CANCEL ON STEP 2 MEANS BACK, NOT ABANDON. Dismissing the metadata modal
 * returns to the type list with the chosen type still selected; a second
 * Escape, now on step 1, closes the wizard. A wizard whose Cancel silently
 * discards the type choice as well is the complaint this shape avoids, and it
 * costs nothing: the gate's `cancel()` clears only what the gate captured.
 */
@Component({
  selector: 'app-team-creation-dialog',
  imports: [DialogModule, ButtonModule, TranslatePipe, TeamMetadataModalComponent],
  templateUrl: './team-creation-dialog.component.html',
  styleUrl: './team-creation-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [TeamCreationService],
})
export class TeamCreationDialogComponent implements OnInit {
  private readonly router = inject(Router);

  /**
   * WHAT MAY BE CREATED, as opposed to what may be listed. See
   * `TeamTypeCatalog` — this dialog used to ask `ApiService` for namespaces and
   * render all of them, library entries included.
   */
  private readonly teamTypes = inject(TeamTypeCatalog);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * WHY AN OnPush COMPONENT NEEDS THIS EXPLICITLY.
   *
   * Everything this dialog renders from `TeamCreationService` — the error, the
   * in-flight flag, the contract — is a plain field behind a getter, chosen
   * deliberately there so the teams page could bind it without a
   * change-detection idiom swap. A getter notifies nobody. On a Default-strategy
   * host that costs nothing, because the tick that follows the settled promise
   * checks the view anyway; on THIS host the view is only checked when it has
   * been marked dirty, and the click that started the work marked it dirty one
   * turn too early.
   *
   * So every resumption after an `await` marks the view itself. Both of the
   * wizard's failure paths depend on it: a rejected ungated create has to
   * re-arm the primary button, and a rejected metadata create has to paint the
   * 422 the gate captured. Neither would repaint otherwise, and neither would
   * fail a test that used `fixture.detectChanges()` — that call checks the
   * component regardless of its dirty flag, which is precisely the state this
   * bug lives underneath.
   */
  private readonly cdr = inject(ChangeDetectorRef);

  /** Public: the template reads it to dismiss the whole flow. */
  readonly launcher = inject(TeamCreationLauncher);

  private readonly auth = inject(AuthService);

  /**
   * The creation gate. PUBLIC because the metadata modal binds straight to it —
   * the contract, the label, the error and the in-flight flag are all its
   * state, and copying any of them onto this component would be a second copy
   * to keep in step.
   */
  readonly creation = inject(TeamCreationService);

  readonly step = signal<CreationStep>('type');

  /**
   * The owner+public list — what every user gets, admin or not.
   *
   * Held SEPARATELY from the widened list rather than overwritten by it,
   * because it is what "foreign" is defined against: a row the widened fetch
   * returned and this one did not is, by construction, a namespace this account
   * would not otherwise see. Overwriting would destroy the only evidence of
   * that distinction the client has.
   */
  private readonly scopedNamespaces = signal<readonly NamespaceSummary[]>([]);

  /**
   * The admin-widened list, or `null` while it has never been fetched.
   *
   * `null` rather than `[]` so "not asked for yet" and "asked for, and there
   * are none" stay different states — the second is a legitimate answer and
   * would otherwise read as the first, sending the fetch again on every toggle.
   */
  private readonly allNamespaces = signal<readonly NamespaceSummary[] | null>(null);

  /** Is the admin firehose switched on? OFF by default, always. */
  readonly showAllTypes = signal(false);

  /**
   * Is this account an admin?
   *
   * Derived from `currentUser$` and NOT from a one-shot `currentUserValue`
   * read, for the same reason the management page states: `/auth/me` resolves
   * after first render, so a single read taken when the wizard opens would miss
   * the late admin resolution and hide the toggle from an admin who has one.
   */
  readonly isAdmin: Signal<boolean> = toSignal(
    this.auth.currentUser$.pipe(
      map((user: { roles?: string[] } | null) => user?.roles?.includes('admin') === true),
    ),
    { initialValue: false },
  );

  /** The rows on screen: the widened list when it is on and has arrived. */
  readonly namespaces = computed<readonly NamespaceSummary[]>(() =>
    this.showAllTypes() ? this.allNamespaces() ?? [] : this.scopedNamespaces(),
  );

  /** The chosen team type. Seeded with the first row, as the teams page does. */
  readonly selected = signal<NamespaceSummary | null>(null);

  private readonly fetching = signal(true);

  readonly typesState = computed<CreationTypesState>(() => {
    if (this.namespaces().length > 0) {
      return 'types';
    }
    return this.fetching() ? 'loading' : 'empty';
  });

  /**
   * The namespace ids the ordinary list carried, for the foreign test.
   *
   * A `Set` and not an `includes` scan, because `isForeign` is called once per
   * rendered row per change detection pass.
   */
  private readonly scopedIds = computed(
    () => new Set(this.scopedNamespaces().map((entry) => entry.namespace)),
  );

  /**
   * Would this row be invisible with the toggle off?
   *
   * That IS the definition of the extra rows, and it is the one the client can
   * answer correctly. Comparing `NamespaceSummary.owner` against the signed-in
   * user would need an identity mapping this client does not have — `owner` is
   * a catalog-side principal, not the `/auth/me` body — and would call every
   * `owner: null` row foreign or native by accident of which default it picked.
   */
  isForeign(ns: NamespaceSummary): boolean {
    return this.showAllTypes() && !this.scopedIds().has(ns.namespace);
  }

  /**
   * "Next" when the chosen type asks something, "Create" when it does not.
   *
   * The label is the ONE place the user learns which of the two the primary
   * button is about to do, and it has to agree with the gate exactly — so it
   * asks the gate rather than re-reading `team_metadata` itself. `contractOf`
   * collapses the three "ask nothing" states (`null`, `undefined`, and a
   * declared contract with no fields); a label derived from `!== null` would
   * promise a second step that never comes.
   */
  readonly primaryLabelKey = computed<string>(() => {
    const ns = this.selected();
    return ns !== null && this.creation.contractOf(ns) !== null
      ? 'common.next'
      : 'common.create';
  });

  ngOnInit(): void {
    /**
     * The SOLE owner of where a new team lands. `created$` is a plain Subject
     * with no replay, and the teams page holds its OWN `TeamCreationService`
     * instance for the `hideHome` auto-create path — two different objects,
     * one subscriber each — so no creation can be navigated to twice.
     */
    this.creation.created$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((teamId) => {
        void this.router.navigate(['/process', teamId]);
        this.launcher.close();
      });

    void this.loadNamespaces();
  }

  /**
   * The type list, asked of `TeamTypeCatalog` — never of `ApiService`.
   *
   * `loadTeamTypes()` is the fetch and the "is this a team type?" rule
   * together, which is the whole point of it living there: this dialog used to
   * call `getNamespaces()` and render whatever came back, so the two LIBRARY
   * namespaces the catalog ships to every deployment ("Global Library",
   * "Global Tools") appeared under "choose the type of team to create" and
   * could be selected and created. A creation surface that asks a
   * general-purpose namespace endpoint and filters afterwards is one forgotten
   * filter away from that bug every time; one that asks for team types cannot
   * be.
   *
   * WITHOUT `all: true`, always. The widened list is a separate, later fetch
   * behind an explicit admin gesture (`onToggleShowAll`) — never the arrival
   * state, because a wizard that opened on the firehose would make the riskiest
   * destination the default one.
   *
   * A failure leaves the list empty and logs. There is no error state of its
   * own: `FetchService` has already toasted, and the settled-empty list already
   * says the one thing the user can act on — there is nothing here to create.
   */
  private async loadNamespaces(): Promise<void> {
    try {
      const list = await this.teamTypes.loadTeamTypes();
      this.scopedNamespaces.set(list);
      this.selected.set(list[0] ?? null);
    } catch (error) {
      console.error('Failed to load team types:', error);
      this.scopedNamespaces.set([]);
      this.selected.set(null);
    } finally {
      this.fetching.set(false);
    }
  }

  /**
   * The admin toggle (ADR-028), reproduced from the management page.
   *
   * The widened list is fetched ONCE and kept: flipping the switch back and
   * forth is a view change, and re-issuing the firehose for each flip would
   * make an idle habit expensive for the one account that can afford it least.
   *
   * The SELECTION is re-seeded when the switch goes off and the chosen type is
   * no longer on screen. Left alone, the user would be looking at a list that
   * does not contain their choice while the primary button quietly still
   * pointed at it — and would create a team into a namespace the dialog had
   * stopped showing.
   */
  /**
   * The checkbox's DOM event, narrowed once here rather than with `$any` in the
   * template — a template escape hatch is an unchecked cast that no compiler
   * pass will ever look at again.
   */
  onShowAllChange(event: Event): void {
    void this.onToggleShowAll((event.target as HTMLInputElement).checked);
  }

  async onToggleShowAll(value: boolean): Promise<void> {
    this.showAllTypes.set(value);
    if (value && this.allNamespaces() === null) {
      this.fetching.set(true);
      try {
        this.allNamespaces.set(await this.teamTypes.loadTeamTypes({ all: true }));
      } catch (error) {
        console.error('Failed to load all team types:', error);
        // `[]` and not a reset to `null`: the fetch HAS settled, and leaving it
        // unfetched would re-issue it on the next flip of the switch.
        this.allNamespaces.set([]);
      } finally {
        this.fetching.set(false);
      }
    }
    this.reseedSelection();
    this.cdr.markForCheck();
  }

  /** Keep the selection on a row that is actually on screen. */
  private reseedSelection(): void {
    const rows = this.namespaces();
    const chosen = this.selected();
    if (chosen !== null && rows.some((row) => row.namespace === chosen.namespace)) {
      return;
    }
    this.selected.set(rows[0] ?? null);
  }

  onSelectType(ns: NamespaceSummary): void {
    this.selected.set(ns);
  }

  /**
   * A TYPE WAS CLICKED — that IS the choice, so go on to the next step.
   *
   * Picking a type and then confirming the pick was two gestures for one
   * decision: the list is single-select, the primary button is enabled the
   * moment anything is selected, and there is nothing to review in between.
   * Clicking a row now selects it AND does what the button would have done.
   *
   * ONLY FOR A POINTER, and this is the whole subtlety. Native radios are what
   * give this group arrow-key navigation for free, and arrow-keying through a
   * radio group fires a `click` on each radio it lands on — so advancing from
   * the raw event would make the FIRST arrow press leave the step, and a
   * keyboard user could never reach the second option. `detail` is the
   * discriminator the DOM already provides: it counts the clicks in a pointer
   * activation and is 0 for one the browser synthesised, which covers both
   * arrow-key navigation and Space on a focused radio.
   *
   * So the two routes stay different on purpose, and both are the conventional
   * shape: pointer picks and proceeds in one gesture; keyboard arrows to a
   * choice and confirms with the button, which keeps its Next / Create label
   * and stays the only thing that commits.
   *
   * The button is NOT removed. It is what a keyboard user activates, it is what
   * carries the spinner while an ungated create is in flight, and it is what
   * says which of the two things is about to happen.
   */
  onTypeActivated(ns: NamespaceSummary, event: MouseEvent): void {
    // Selection first and unconditionally: a synthesised click still means the
    // row was chosen, it just must not also commit.
    this.selected.set(ns);
    if (event.detail === 0) {
      return;
    }
    void this.onPrimary();
  }

  /** Is this the chosen type? Compared by namespace id, never by reference. */
  isSelected(ns: NamespaceSummary): boolean {
    return this.selected()?.namespace === ns.namespace;
  }

  /**
   * The primary button, for both of the things it can be.
   *
   * The gate decides; this only routes its three answers. `'failed'` has no
   * branch on purpose — the gate has already logged it and `FetchService` has
   * already toasted it, so the correct behaviour is to leave step 1 exactly as
   * it is, with the chosen type intact and the button re-armed.
   */
  async onPrimary(): Promise<void> {
    const ns = this.selected();
    if (ns === null || this.creation.creatingByGesture) {
      return;
    }
    const outcome = await this.creation.request(ns, 'gesture');
    if (outcome === 'asked') {
      this.step.set('metadata');
    }
    // 'created' is handled by the `created$` subscription, which owns the
    // destination; 'failed' deliberately falls through to "stay on step 1".
    //
    // Marked on EVERY outcome, not only on 'failed'. `step` is a signal and
    // marks the view by itself, but `creation.creatingByGesture` — the button's
    // spinner and its disabled state — is a getter that does not, and it has
    // just gone back to false on all three paths.
    this.cdr.markForCheck();
  }

  /**
   * Every dismissal channel of step 1 — Cancel, the X, Escape, the mask.
   *
   * The `step() !== 'type'` guard is the defence against a spurious emission
   * while the wizard is advancing: were PrimeNG ever to report `false` because
   * its `visible` input went false under it, the wizard would close itself on
   * the way to step 2 instead of opening it.
   */
  onTypeDialogVisibleChange(visible: boolean): void {
    if (visible || this.step() !== 'type') {
      return;
    }
    this.launcher.close();
  }

  /**
   * Step 2 was dismissed. BACK, not abandon — see the class doc. The gate's
   * captured namespace is released (it is re-captured on the next `request`),
   * while `selected` is left alone, which is what makes the type list come back
   * with the user's choice still on it.
   */
  onMetadataCancelled(): void {
    this.creation.cancel();
    this.step.set('type');
  }

  /**
   * Step 2 was confirmed. The gate owns the create and its error handling.
   *
   * `finally` rather than `then`: the modal has to repaint on the failure path
   * above all — that is where `errorMessage` appears and `submitting` goes back
   * to false — and a `then` would skip exactly that case were `confirm` ever to
   * reject rather than swallow.
   */
  onMetadataConfirmed(metadata: Record<string, string>): void {
    void this.creation.confirm(metadata).finally(() => this.cdr.markForCheck());
  }
}
