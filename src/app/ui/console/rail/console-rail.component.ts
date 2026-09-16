import { AsyncPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostBinding,
  inject,
  OnInit,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { BehaviorSubject, combineLatest, filter, map, Observable, take } from 'rxjs';

import { ConfigService } from '../../../core/platform/config/config.service';
import { ContextService } from '../../../core/platform/context/context.service';
import { TeamCreationLauncher } from '../team-creation-launcher.service';
import { ViewService } from '../../../core/services/view.service';
import { IconButtonComponent } from '../../../core/components/primitives/icon-button/icon-button.component';
import { RailFooterComponent } from './rail-footer.component';
import { SearchBoxComponent } from '../../../core/components/primitives/search-box/search-box.component';
import { RailTeamRowComponent } from './rail-team-row.component';
import { railGroups, RailTeamGroup } from '../../../core/services/console/rail/rail-teams.selector';

/**
 * What the list region is showing.
 *
 * FOUR STATES, not "rows or nothing". `no-results` and `empty` are different
 * answers to different questions — "your search matched none of the loaded
 * teams" versus "you have no teams" — and collapsing them tells a user with a
 * typo that their work has disappeared.
 */
export type RailListState = 'loading' | 'empty' | 'no-results' | 'rows';

/** Everything the list region renders, resolved in one pass. */
export interface RailListView {
  readonly state: RailListState;
  readonly groups: readonly RailTeamGroup[];
  readonly query: string;
  /** The team open in the conversation pane, or `''`. */
  readonly activeTeamId: string;
  /**
   * A refetch is running over rows already on screen.
   *
   * DIM, DO NOT EMPTY. This list is searchable, and an emptied list reads as
   * "nothing matches" — the exact answer a search exists to give — where dimmed
   * rows read as "updating". The same distinction the teams table makes.
   */
  readonly dimmed: boolean;
}

/**
 * Which of the four list states applies. Pure, and exported so the branch
 * order can be pinned without a TestBed.
 *
 * ORDER IS THE WHOLE FUNCTION. Rows win over a refetch (dim, do not empty);
 * a refetch wins over "you have no teams" (a cold load is not an empty
 * account); and only once both of those are ruled out is an empty result
 * attributable to the search.
 */
export function railListState(
  hasRows: boolean,
  hasTeams: boolean,
  loading: boolean,
): RailListState {
  if (hasRows) {
    return 'rows';
  }
  if (loading) {
    return 'loading';
  }
  return hasTeams ? 'no-results' : 'empty';
}

/**
 * The console's left rail: brand, the way to a new team, search, the teams, and
 * the account footer.
 *
 * OUTSIDE THE ROUTED COMPONENT, and therefore outside `ProcessComponent`'s
 * provider array. Everything it injects is root-scoped — a rail that reached
 * for `GraphDataService` or `MessageLogService` would throw the moment it was
 * mounted anywhere but inside a team, and would silently keep one team's state
 * alive across a switch if it did not. It reads `currentProcessId$` to
 * highlight the open team and NEVER writes it (Epic 52 trap T3):
 * `ProcessComponent` is that subject's single owner and retracts its own value
 * on destroy.
 *
 * It is a NAVIGATION surface, not a replacement for the management view. Paging,
 * filtering, namespace configuration, the description editor and the full team
 * table stay on `/`, and every empty state here offers the way there.
 *
 * The ONE exception is creating a team, and it is an exception on purpose: a
 * user who wants a new team is starting work, not managing a list, and routing
 * them out of the conversation they are reading to find a Create button was
 * never what they asked for. Even so the rail does not own the flow — it only
 * raises `TeamCreationLauncher`'s flag. See `onNewTeam`.
 */
@Component({
  selector: 'app-console-rail',
  imports: [
    AsyncPipe,
    TranslatePipe,
    IconButtonComponent,
    SearchBoxComponent,
    RailTeamRowComponent,
    RailFooterComponent,
  ],
  templateUrl: './console-rail.component.html',
  styleUrl: './console-rail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConsoleRailComponent implements OnInit {
  private readonly contextService = inject(ContextService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * The creation wizard's on/off switch — see `onNewTeam`. ONE boolean, and
   * root-scoped only because the rail and the wizard's mount in
   * `app.component.html` have no ancestor between them; none of the wizard's
   * own state is reachable through it.
   */
  private readonly launcher = inject(TeamCreationLauncher);

  /** Public because the template calls `toggleRail()` on it. Root-scoped, so
   *  the rail's own control and any future one in the chrome read the same
   *  answer. */
  readonly viewService: ViewService = inject(ViewService);

  /**
   * The deployment's OWN brand mark, or `null` when it never set one (W9c).
   *
   * `brandLogo` and NOT `logo`, and the difference is the whole feature:
   * `logo` answers "what path would we load", framework default included, and
   * drawing THAT unconditionally is how the framework's `akgent_logo.png` — a
   * raster of the wordmark this row already sets in type — ended up drawing
   * the brand twice. `brandLogo` answers "does this deployment have a mark of
   * its own", which is the question the either/or in the template is asking.
   * See `ConfigService.brandLogo` for what counts as "explicitly set".
   *
   * READ ONCE, as a field rather than a getter: `config.json` is fetched by an
   * APP_INITIALIZER before anything renders and never changes afterwards, so a
   * getter would re-answer a settled question on every change detection.
   */
  readonly brandLogo: string | null = inject(ConfigService).brandLogo;

  /**
   * Whether the rail offers a way back to the teams list.
   *
   * The SAME gate the footer used to carry (`!hideHome`), moved with the
   * control rather than re-derived: a deployment that hides the teams page must
   * not be given a row that navigates to it. The control itself moved up here
   * because a link buried under the account block, styled as small text, lost
   * every contest against the full-width Create button above it — returning to
   * your teams read as fine print while making a new one read as the point.
   */
  readonly showAllTeams: boolean = !inject(ConfigService).hideHome;

  /**
   * What is typed into the search box.
   *
   * PUBLIC and bound back into `<app-search-box [value]>`, so the box is a
   * controlled input: the rail holds the one copy of the query that the list
   * is filtered by, rather than the DOM holding a second one that happens to
   * agree.
   */
  readonly query$ = new BehaviorSubject<string>('');

  /**
   * The whole list region in one emission.
   *
   * One observable rather than four async pipes: the four states are mutually
   * exclusive by construction here, where four independent pipes could render
   * a spinner and an empty state in the same frame while the streams settled.
   */
  readonly view$: Observable<RailListView> = combineLatest([
    this.contextService.teams$,
    this.contextService.loading$,
    this.query$,
    // READ ONLY, and folded in here rather than bound per row: an async pipe on
    // every row would open one subscription per team to answer a question with
    // a single answer.
    this.contextService.currentProcessId$,
  ]).pipe(
    map(([teams, loading, query, activeTeamId]) => {
      const groups = railGroups(teams, query);
      const hasRows = groups.length > 0;
      return {
        state: railListState(hasRows, teams.length > 0, loading),
        groups,
        query,
        activeTeamId,
        // Only meaningful while rows are on screen; the `loading` state covers
        // the empty case.
        dimmed: loading && hasRows,
      };
    }),
  );

  private readonly collapsed = toSignal(this.viewService.isRailCollapsed$, {
    initialValue: false,
  });

  /**
   * Collapse is a class on the HOST, not on the inner `<aside>`: the host is
   * the flex item whose width the console row measures, so it is the only
   * element whose width a transition can animate.
   */
  @HostBinding('class.collapsed')
  get isCollapsed(): boolean {
    return this.collapsed();
  }

  /**
   * A collapsed rail is GONE, not merely invisible.
   *
   * `width: 0` with `overflow: hidden` hides the rail from a reader and from
   * nobody else: every team row, the search box and the footer's account menu
   * stay in the tab order, so a keyboard user tabbing out of the conversation
   * header falls into a dozen controls that are not on the screen, and a screen
   * reader still announces the whole list. `inert` is the one attribute that
   * takes all of that away at once.
   *
   * This is the codebase's own pattern, applied where it was missed: the
   * inspector's off-screen panels have been `[attr.inert]`-gated since Epic 56
   * (`process.component.html`) for exactly this reason, and they are hidden by
   * a translate rather than a width — a weaker kind of hidden than this one.
   *
   * `'' : null`, not a boolean: `inert` is a presence attribute, and binding
   * `false` to it would still render `inert="false"`, which is inert.
   *
   * `aria-hidden` alongside it because the two are not the same promise —
   * `inert` removes interactivity and `aria-hidden` removes the subtree from
   * the accessibility tree. A control that is unreachable but still announced
   * is a control a screen-reader user is told about and cannot use.
   */
  @HostBinding('attr.inert')
  get inertAttr(): '' | null {
    return this.collapsed() ? '' : null;
  }

  @HostBinding('attr.aria-hidden')
  get ariaHidden(): 'true' | null {
    return this.collapsed() ? 'true' : null;
  }

  /**
   * Seed page 1 — but ONLY when the management view is not the page being
   * activated.
   *
   * THE RACE THIS AVOIDS. `HomeComponent.restoreFromUrl` installs the filter
   * from the URL through `restoreFilter`, which writes the value WITHOUT
   * fetching, precisely so the table's own first `(onLazyLoad)` carries it. If
   * the rail also asked for page 1 on that mount, two direct `loadTeamsPage`
   * calls would be in flight with nothing able to order them — no `switchMap`
   * sits between them — and whichever landed last would win. Half the time
   * that is the rail's, and the user's restored filter would silently vanish
   * from a table still showing it in the filter bar.
   *
   * `/process/:id` has no such seeder, which is exactly why the rail needs one
   * there and only there. `ensureTeamsLoaded` adds a second guard of its own
   * (in flight, or already populated), so the two rules are belt and braces
   * rather than one rule written twice.
   *
   * The current URL is checked FIRST because a rail mounted after the router
   * has settled — arriving from `/login`, where the chrome is hidden — would
   * otherwise wait for a `NavigationEnd` that has already been and gone.
   */
  ngOnInit(): void {
    if (this.isProcessUrl(this.router.url)) {
      void this.contextService.ensureTeamsLoaded();
      return;
    }

    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        take(1),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => {
        if (this.isProcessUrl(event.urlAfterRedirects)) {
          void this.contextService.ensureTeamsLoaded();
        }
      });
  }

  private isProcessUrl(url: string): boolean {
    return url.startsWith('/process/');
  }

  onQueryChange(query: string): void {
    this.query$.next(query);
  }

  /**
   * "New team" opens the creation wizard. It does NOT navigate.
   *
   * THE RAIL ASKS; IT DOES NOT OWN. Creating a team means choosing a type and
   * then answering that type's questions, and all of that state — the captured
   * namespace, the contract, the error, the in-flight flag — belongs to
   * `TeamCreationService`, which is deliberately not `providedIn: 'root'` so
   * that a half-filled dialog dies with its host instead of surviving a
   * navigation away and back. The rail is the wrong host for it: the rail
   * outlives every navigation, which is exactly the lifetime that scoping rules
   * out.
   *
   * So the gate lives on `TeamCreationDialogComponent`, which is mounted in
   * `app.component.html` behind an `@if` and therefore dies when the wizard
   * closes — a shorter lifetime than the teams page gives it, not a longer one.
   * All the rail holds is `TeamCreationLauncher`, one boolean saying whether
   * that component exists. Nothing about a creation-in-progress is reachable
   * from here, which is what keeps this a request rather than a second copy of
   * the state machine.
   *
   * It used to hand over to the management view instead, because there was no
   * dialog outside that page to open. There is now, and routing away from the
   * team the user is reading in order to offer them a Create button was never
   * what they asked for.
   */
  onNewTeam(): void {
    this.launcher.open();
  }

  /** Open a team. A route change, exactly as the table's row click is. */
  onSelect(teamId: string): void {
    void this.router.navigate(['/process', teamId]);
  }

  /** "Open in teams list" — the escape hatch to everything the rail drops. */
  onManage(): void {
    void this.contextService.navigateHome();
  }

  /**
   * A row deleted its team. The row performed the delete and owns its own
   * marks; the only thing left for the rail is the case where the deleted team
   * is the one currently on screen, which would otherwise leave a conversation
   * pane bound to a team that no longer exists.
   *
   * `currentProcessId$` is READ here and never written — `ProcessComponent` is
   * its single owner and retracts its own value when this navigation destroys
   * it.
   */
  onDeleted(teamId: string): void {
    if (this.contextService.currentProcessId$.value === teamId) {
      void this.contextService.navigateHome();
    }
  }
}
