import { formatDate } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  HostBinding,
  HostListener,
  inject,
  Input,
  LOCALE_ID,
  OnChanges,
  Output,
  ViewChild,
} from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MenuItem } from 'primeng/api';
import { Menu, MenuModule } from 'primeng/menu';

import { ContextService } from '../../../core/platform/context/context.service';
import { TeamTitlePipe } from '../../../core/platform/context/team-metadata.pipe';
import {
  isRunning,
  metadataEntries,
  TeamActivity,
} from '../../../core/platform/context/team.interface';
import { IconButtonComponent } from '../../../core/components/primitives/icon-button/icon-button.component';
import { RailTeamRow } from '../../../core/services/console/rail/rail-teams.selector';

/** Which `team.status.*` key describes each activity, including its "as of the
 *  last refresh" hedge. Frozen because it is a lookup table, not state. */
const ACTIVITY_TITLE_KEY: Readonly<Record<TeamActivity, string>> = Object.freeze({
  stopped: 'team.status.stopped',
  running: 'team.status.running',
  working: 'team.status.workingTitle',
  idle: 'team.status.idleTitle',
});

/**
 * One team in the rail.
 *
 * A REAL BUTTON, not a `<div (click)>`. The prototype's rows are divs and are
 * therefore unreachable by keyboard and invisible to assistive technology,
 * while the prototype's own tool-fold header — the same interaction, three
 * panes to the right — is a button. This follows the one it got right.
 *
 * THE IN-FLIGHT MARKS LIVE HERE, and they are not lifted to a `[busy]` input.
 * "This row has a stop running" is per-row view state; hoisting it puts a set
 * of ids on the rail and makes the row's rendering depend on the rail
 * remembering to clear them. `team-table.component.ts` documents that mistake
 * at length. The mark clears when the work SETTLES — rejection included, which
 * is the case a "clear when the next list arrives" design leaves spinning
 * forever, precisely on the one occasion the user needs to know it failed.
 *
 * The row calls `ContextService` itself for the same reason it holds the mark:
 * the mark and the promise it tracks cannot live on opposite sides of a
 * component boundary without a callback threading them back together. The
 * outputs are still emitted, as NOTIFICATIONS — the rail reacts to a delete of
 * the team it is showing, and to nothing else. `ContextService` is root-scoped,
 * so nothing here reaches into `ProcessComponent`'s team-scoped injector.
 */
@Component({
  selector: 'app-rail-team-row',
  imports: [MenuModule, TranslatePipe, TeamTitlePipe, IconButtonComponent],
  templateUrl: './rail-team-row.component.html',
  styleUrl: './rail-team-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RailTeamRowComponent implements OnChanges {
  private readonly contextService = inject(ContextService);
  private readonly translate = inject(TranslateService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly locale = inject(LOCALE_ID);

  @Input({ required: true }) row!: RailTeamRow;

  /** Whether this is the team currently open in the conversation pane. */
  @Input() active = false;

  /**
   * Which metadata key holds the team's TITLE, or `null` when none does.
   *
   * A KEY, not a title — the row reads its own value out of its own metadata.
   * The rail passes `null` today because a `TeamContext` carries no namespace
   * and the rail has no namespace selection to borrow one from; the input
   * exists so wiring it later is one binding rather than a redesign.
   */
  @Input() titleKey: string | null = null;

  @Output() selected = new EventEmitter<string>();
  /**
   * The row DELETED a team; it has already done the work.
   *
   * A notification, not a request — the name is inherited from the management
   * view's table, where the parent performs the call. Here the row performs it,
   * because the busy mark and the promise it tracks cannot live on opposite
   * sides of a component boundary. The rail listens so it can stop showing a
   * team that no longer exists.
   *
   * Stop and restore have no equivalent output, deliberately. They had one
   * during the build and nothing ever bound it: the rail's rows re-render off
   * `ContextService` either way, and the conversation pane already reacts to
   * `currentTeamRunning$`. An output nobody consumes advertises a seam that is
   * not there, so the surface is narrowed to the two events that have a reader.
   */
  @Output() deleteRequested = new EventEmitter<string>();
  @Output() manageRequested = new EventEmitter<string>();

  @ViewChild(Menu) private menu?: Menu;

  /** A stop is in flight for this row. */
  stopping = false;

  /** A restore is in flight for this row. */
  restoring = false;

  /** The overflow menu's model, rebuilt at every open. See `openMenu`. */
  menuItems: MenuItem[] = [];

  private menuOpen = false;
  private pointerInside = false;
  private focusInside = false;

  /**
   * The row's second line, resolved ONCE per input change.
   *
   * `metadataEntries` returns fresh objects on every call, so reading it from
   * a binding would rebuild this string every change-detection cycle. It is
   * not in a binding: `ngOnChanges` is the only thing that recomputes it.
   */
  summary: string | null = null;

  /** The row's timestamp, already formatted. See `computeWhen`. */
  when = '';

  ngOnChanges(): void {
    const metadata = this.row?.team.metadata;
    // The title field is EXCLUDED: the name line above already renders it, and
    // a summary repeating it reads as duplicated data rather than as a layout
    // slip.
    this.summary = metadataEntries(metadata, this.titleKey)[0]?.value ?? null;
    this.when = this.computeWhen();
  }

  /** Reveal the kebab. Forty rows each wearing a permanent kebab is forty
   *  pieces of furniture — the same argument `chat-message.component.scss`
   *  makes about the feedback control. */
  @HostBinding('class.rail-row--revealed')
  get revealed(): boolean {
    return this.pointerInside || this.focusInside || this.menuOpen;
  }

  @HostListener('mouseenter')
  onMouseEnter(): void {
    this.pointerInside = true;
  }

  @HostListener('mouseleave')
  onMouseLeave(): void {
    this.pointerInside = false;
  }

  @HostListener('focusin')
  onFocusIn(): void {
    this.focusInside = true;
  }

  @HostListener('focusout')
  onFocusOut(): void {
    this.focusInside = false;
  }

  /**
   * The status dot's modifier class — one per activity, all four distinct.
   *
   * FOUR STATES, NOT TWO. `working` is optional AND nullable on the wire, so
   * absent and `null` both mean UNKNOWN — never idle — and the prototype's
   * unconditional green fill plus pulse would put a live, pulsing dot beside a
   * team that has been stopped for a week.
   */
  get dotClass(): string {
    return `rail-row__dot--${this.row.activity}`;
  }

  /** Whether the dot pulses: only while something is actually happening. */
  get dotPulses(): boolean {
    return this.row.activity === 'running' || this.row.activity === 'working';
  }

  get statusTitleKey(): string {
    return ACTIVITY_TITLE_KEY[this.row.activity];
  }

  get isRunning(): boolean {
    return isRunning(this.row.team);
  }

  /** The meta line is ONE key with parameters, never a `+ ' · ' +` splice: the
   *  separator is punctuation in one language and not in the next, and a
   *  concatenation gives a translator no way to move it. */
  get metaKey(): 'rail.teamMeta' | 'rail.teamMetaTimeOnly' {
    return this.summary === null ? 'rail.teamMetaTimeOnly' : 'rail.teamMeta';
  }

  onSelect(): void {
    this.selected.emit(this.row.team.team_id);
  }

  /**
   * Open the overflow menu, rebuilding its model first.
   *
   * REBUILT AT EVERY OPEN, on purpose. `MenuItem.label` is a resolved string,
   * so a model built once in the constructor is a snapshot of one language and
   * of one lifecycle state — it would offer Stop for a team that has since
   * stopped. Building it here means both questions are asked at the moment the
   * user asks them, and no `onLangChange` subscription is needed to keep it
   * honest.
   */
  openMenu(event: Event): void {
    this.menuItems = this.buildMenuItems();
    this.menuOpen = true;
    this.menu?.toggle(event);
  }

  onMenuHide(): void {
    this.menuOpen = false;
  }

  /** The overflow menu's model for the row's CURRENT state. Separate from
   *  `openMenu` so the ordering and the two lifecycle gates can be asserted
   *  without a PrimeNG overlay. */
  buildMenuItems(): MenuItem[] {
    const teamId = this.row.team.team_id;
    const items: MenuItem[] = [];

    if (this.isRunning) {
      items.push({
        id: 'stop',
        label: this.translate.instant('team.action.stop'),
        icon: 'pi pi-stop-circle',
        command: () => this.onStop(),
      });
    } else {
      items.push({
        id: 'restore',
        label: this.translate.instant('team.action.restore'),
        icon: 'pi pi-play',
        command: () => this.onRestore(),
      });
    }

    items.push({
      id: 'delete',
      label: this.translate.instant('team.action.delete'),
      icon: 'pi pi-trash',
      command: () => this.onDelete(),
    });

    items.push({ separator: true });

    items.push({
      id: 'open-in-list',
      label: this.translate.instant('rail.openInList'),
      icon: 'pi pi-list',
      command: () => this.manageRequested.emit(teamId),
    });

    return items;
  }

  onStop(): void {
    const teamId = this.row.team.team_id;
    this.stopping = true;
    // `restoreTeamAndAwait`'s sibling: it polls until the cache agrees, so the
    // mark clears when the team has actually stopped rather than when the POST
    // returned.
    this.track(this.contextService.stopTeamAndAwait(teamId), () => {
      this.stopping = false;
    });
  }

  onRestore(): void {
    const teamId = this.row.team.team_id;
    this.restoring = true;
    // `restoreTeamAndAwait`, NOT `apiService.restoreTeam` + a page reload —
    // the await polls to running, so the row stops claiming to be busy at the
    // moment the team is usable.
    this.track(this.contextService.restoreTeamAndAwait(teamId), () => {
      this.restoring = false;
    });
  }

  /**
   * Delete carries no busy mark, and deliberately so: the row it would mark is
   * removed from the list by the same call, so the mark has nothing left to
   * describe. No confirmation either — matching the management view, which has
   * never had one. Adding one belongs in both places at once, not here alone.
   */
  onDelete(): void {
    const teamId = this.row.team.team_id;
    this.deleteRequested.emit(teamId);
    void this.contextService.deleteTeam(teamId).catch(() => {
      // Already surfaced by `FetchService`'s error toast. Consumed so a failed
      // delete is not also an unhandled rejection.
    });
  }

  /**
   * Clear a mark when its work SETTLES — `then(clear, clear)`, not `then(clear)`.
   *
   * A rejected stop is exactly the case a success-only clear strands: the
   * spinner spins forever on the one occasion the user needs to be told the
   * action did not happen.
   */
  private track(work: Promise<unknown>, clear: () => void): void {
    const settle = (): void => {
      clear();
      // OnPush: the promise resolves outside any binding, so nothing would
      // repaint without this.
      this.cdr.markForCheck();
    };
    void work.then(settle, settle);
  }

  /**
   * The timestamp: a clock time for something created TODAY, a date otherwise.
   *
   * A row is 268px wide and the meta line shares it with a summary, so the
   * format has to earn its characters: "16:35" answers "when today?" and
   * "Apr 19" answers "which day?", and neither needs the other's half.
   *
   * Formatted in TS rather than by `DatePipe` in the template because the
   * result is a translation PARAMETER — the separator between it and the
   * summary belongs to the sentence, not to a `+ ' · ' +` in the markup.
   */
  private computeWhen(): string {
    const raw = this.row?.team.created_at;
    if (!raw) {
      return '';
    }
    const created = new Date(raw);
    if (Number.isNaN(created.getTime())) {
      // A server that sent something unparseable should not blank the row.
      return '';
    }
    const now = new Date();
    const sameDay =
      created.getFullYear() === now.getFullYear() &&
      created.getMonth() === now.getMonth() &&
      created.getDate() === now.getDate();
    return formatDate(created, sameDay ? 'shortTime' : 'MMM d', this.locale);
  }
}
