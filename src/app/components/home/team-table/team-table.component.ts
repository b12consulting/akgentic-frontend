import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  QueryList,
  ViewChildren,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import {
  TableLazyLoadEvent,
  TableModule,
  TableRowSelectEvent,
} from 'primeng/table';
import { TagModule } from 'primeng/tag';

import {
  TeamMetadataPipe,
  trackMetadataEntry,
} from '../../../core/context/team-metadata.pipe';
import { isRunning, TeamContext } from '../../../core/context/team.interface';

/** A row action the user asked for. The page performs it; the row shows it running. */
export interface TeamRowAction {
  readonly teamId: string;
  /**
   * The page hands back the work it started. The row stays busy until this
   * SETTLES — including when it rejects, which is the case a "clear when the
   * next page arrives" design leaves spinning forever.
   */
  readonly track: (work: Promise<unknown>) => void;
}

/** A description the user saved. `description` is already trimmed, `null` when empty. */
export interface TeamDescriptionSave {
  readonly teamId: string;
  readonly description: string | null;
  readonly track: (work: Promise<unknown>) => void;
}

/**
 * The teams table — its rows, its row actions and its inline description
 * editor.
 *
 * Owns what a ROW is and what it looks like while something is happening to it.
 * It owns nothing about where the rows came from: no service, no router, no
 * fetch, no page arithmetic. It takes a page of teams and reports what the user
 * did to one of them, which is why it can be tested by setting four inputs and
 * reading six outputs against a TestBed declaring no providers at all — the
 * same shape `TeamFilterComponent` uses.
 *
 * THE IN-FLIGHT MARKS LIVE HERE, and deliberately so. "This row is busy" is
 * per-row view state; the page only needs to know an action was requested. A
 * `[busyTeams]` input would put the two sets straight back on the page and make
 * the child's rendering depend on the page remembering to clear them. Instead
 * each action hands out a `track` callback: the page passes back the promise it
 * started, and the mark clears when that SETTLES — on rejection as much as on
 * success. A mark cleared only on the reload that follows a success stays lit
 * forever the one time the action actually failed.
 */
@Component({
  selector: 'app-team-table',
  imports: [
    CommonModule,
    FormsModule,
    TableModule,
    TagModule,
    ButtonModule,
    InputTextModule,
    TeamMetadataPipe,
  ],
  templateUrl: './team-table.component.html',
  styleUrl: './team-table.component.scss',
})
export class TeamTableComponent {
  /** The page of teams to render, exactly as the page received it. */
  @Input() teams: TeamContext[] = [];

  /** The server's total across all pages — the "X–Y of N" report's N. */
  @Input() totalRecords = 0;

  /** Page size. */
  @Input() rows = 0;

  /** The row offset the paginator is parked on. */
  @Input() first = 0;

  /**
   * Whether the list is being fetched.
   *
   * Drives `p-table`'s own overlay, which dims the rows already on screen
   * rather than emptying them. That distinction matters on this table more than
   * most: it is filtered, and an emptied table reads as "no team matches" —
   * the exact answer a filter exists to give — where dimmed rows read as
   * "updating". The frame, the header and the paginator all stay put.
   *
   * The DELAY that keeps a fast fetch from flickering lives in
   * `ContextService.loading$`, not here: this input is already the answer.
   */
  @Input() loading = false;

  /**
   * The `p-table`'s own lazy-load event, re-emitted VERBATIM.
   *
   * Not a page number: the page owns the arithmetic (`first / rows + 1`) and
   * the seed-does-not-write-the-URL rule that goes with it. Translating here
   * would put half of that computation on each side of the boundary.
   */
  @Output() lazyLoad = new EventEmitter<TableLazyLoadEvent>();

  /** A row was selected. The page decides that means "navigate". */
  @Output() rowSelected = new EventEmitter<string>();

  @Output() stopRequested = new EventEmitter<TeamRowAction>();
  @Output() restoreRequested = new EventEmitter<TeamRowAction>();

  /**
   * Delete carries a bare id, not a `TeamRowAction`: nothing marks a row busy
   * for a delete today, and handing out a `track` nobody calls would imply
   * otherwise.
   */
  @Output() deleteRequested = new EventEmitter<string>();

  @Output() descriptionSaved = new EventEmitter<TeamDescriptionSave>();

  /** Rows with a stop in flight. Per row, and independent of each other. */
  stoppingTeams = new Set<string>();

  /** Rows with a restore in flight. */
  restoringTeams = new Set<string>();

  /** The one row whose description is being edited, if any. */
  editingDescriptionFor: string | null = null;

  /** What is typed into the editor, kept per row so a re-open finds it. */
  descriptionDrafts = new Map<string, string>();

  /**
   * DECLARED HERE, beside the `#descriptionInput` markup it resolves against.
   *
   * `@ViewChildren` queries the template of the component it is declared in. On
   * the page — where the markup no longer lives — it resolves to nothing and
   * the focus call below silently becomes a no-op, while every assertion about
   * the saved text goes on passing. The focus spec is the only thing that sees
   * it.
   */
  @ViewChildren('descriptionInput') descriptionInputs!: QueryList<ElementRef>;

  /** Exposed to the row template. */
  isRunning = isRunning;

  /** `trackBy` for the Metadata column's chips. See the pipe. */
  trackMetadataEntry = trackMetadataEntry;

  /** Re-emit the paginator's own event, untranslated. */
  onLazyLoad(event: TableLazyLoadEvent): void {
    this.lazyLoad.emit(event);
  }

  /**
   * PrimeNG types `data` as `TeamContext | TeamContext[] | undefined` because a
   * table can select many rows. This one is `selectionMode="single"`, so the
   * array arm never arrives — but it is narrowed rather than cast away: cast,
   * an array would read `team_id` as `undefined` and navigate the page to
   * `/process/undefined` instead of doing nothing.
   */
  onRowSelect(event: TableRowSelectEvent<TeamContext>): void {
    const row = event.data;
    if (row === undefined || Array.isArray(row)) {
      return;
    }
    this.rowSelected.emit(row.team_id);
  }

  onStop(teamId: string): void {
    this.stopRequested.emit({
      teamId,
      track: (work) => this.mark(this.stoppingTeams, teamId, work),
    });
  }

  onRestore(teamId: string): void {
    this.restoreRequested.emit({
      teamId,
      track: (work) => this.mark(this.restoringTeams, teamId, work),
    });
  }

  onDelete(teamId: string): void {
    this.deleteRequested.emit(teamId);
  }

  isStopping(teamId: string): boolean {
    return this.stoppingTeams.has(teamId);
  }

  isRestoring(teamId: string): boolean {
    return this.restoringTeams.has(teamId);
  }

  /** Open the inline editor for ONE row, pre-filled with its description. */
  startEditDescription(teamId: string, currentDescription: string | null): void {
    this.editingDescriptionFor = teamId;
    this.descriptionDrafts.set(teamId, currentDescription || '');

    // Focus the input field after the view updates.
    setTimeout(() => {
      const input = this.descriptionInputs?.first?.nativeElement;
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }

  /** Close the editor without emitting. The draft survives for a re-open. */
  cancelEditDescription(): void {
    this.editingDescriptionFor = null;
  }

  /**
   * Emit the saved description, ALREADY TRIMMED and `null` when empty.
   *
   * The rule travels with the draft rather than staying on the page, so the
   * value that reaches the API and the value the cache is told about are the
   * same one by construction.
   *
   * The editor stays open until the page's work settles: closing on emit would
   * discard the typed text the moment the save failed, which is the one moment
   * the user needs it back.
   */
  saveDescription(teamId: string): void {
    const trimmed = (this.descriptionDrafts.get(teamId) ?? '').trim() || null;
    this.descriptionSaved.emit({
      teamId,
      description: trimmed,
      track: (work) => {
        void work.then(
          () => this.closeEditor(teamId),
          () => {
            // Left open, with the draft intact. The rejection is consumed here
            // so a failed save is not also an unhandled rejection.
          },
        );
      },
    });
  }

  /**
   * Add the mark, and remove it when the work SETTLES — both outcomes.
   *
   * `then(clear, clear)` rather than a `finally`: it consumes the rejection as
   * well, so a failed action clears its spinner without also surfacing as an
   * unhandled promise rejection. The page has already logged it.
   */
  private mark(marks: Set<string>, teamId: string, work: Promise<unknown>): void {
    marks.add(teamId);
    const clear = (): void => {
      marks.delete(teamId);
    };
    void work.then(clear, clear);
  }

  /** Close the editor, but only if it is still the row that was saved. */
  private closeEditor(teamId: string): void {
    if (this.editingDescriptionFor === teamId) {
      this.editingDescriptionFor = null;
    }
  }
}
