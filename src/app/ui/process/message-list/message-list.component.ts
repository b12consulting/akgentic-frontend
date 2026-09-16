import { CommonModule } from '@angular/common';
import { Component, inject, ViewChild } from '@angular/core';

import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { Table, TableModule } from 'primeng/table';
import { MessageService } from 'primeng/api';

import { CapitalizePipe } from '../../../shared/pipes/capitalise.pipe';
import { CategoryService } from '../../../services/category.service';
import { UtilService } from '../../../services/utils.service';

import { combineLatest, Subscription } from 'rxjs';
import { AkgentService } from '../../../services/akgent.service';
import { MessageLogService } from '../../../services/process/event/message-log.service';
import {
  ActorAddress,
  BaseMessage,
  isSentMessage,
  isWelcomeAnnouncement,
  notificationSeverity,
  NotificationSeverity,
} from '../../../protocol/message.types';
import { CopyButtonComponent } from '../../../components/common/copy-button/copy-button.component';
import { InspectorEmptyStateComponent } from '../../../components/console/inspector/inspector-empty-state.component';

/**
 * The two places a log row can be carrying its text.
 *
 * Deliberately structural and `unknown`-valued rather than one of the wire
 * unions: this is a FALLBACK path reached by whatever the fold admitted, so the
 * question it asks is "is there a string here" and not "which message is this".
 * A union would have to be widened every time the protocol grows a shape, and
 * the `typeof` guards below are what actually make the answer safe.
 */
interface CopyableRow {
  readonly content?: unknown;
  readonly message?: { readonly content?: unknown } | null;
}

/** Legend used when a notification carries no `content_type` of its own. */
const LEGEND_FALLBACK: Record<NotificationSeverity, string | null> = {
  error: null,
  warn: 'Warning',
  info: 'Notification',
};

/**
 * One end of a row's route line: the party's display name, and the colour the
 * hierarchy graph draws that party's node in.
 *
 * `color` is `null` — not `undefined`, and not a fallback hex — when the party
 * has no node in the graph yet. Rendering decides what an unplaced party looks
 * like, in the stylesheet, in tokens; this type only says whether the graph has
 * an opinion.
 */
export interface RouteParty {
  readonly name: string;
  readonly color: string | null;
}

/**
 * The route of one log line: who sent it, and who received it.
 *
 * `recipient === null` means the message went to the whole team. It is a
 * distinct case rather than an empty name, because the view says it in WORDS
 * ("@Worker to everyone") — a blank second half would read as a rendering
 * failure.
 */
export interface MessageRoute {
  readonly sender: RouteParty;
  readonly recipient: RouteParty | null;
}

/** Two digits, for the wall-clock stamp. */
function pad(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/**
 * THE ALL-TRAFFIC LOG.
 *
 * Every other reader in the console is scoped to somebody: the chat panel is
 * the human's turns, the sub-agent reader is one participant's. This panel is
 * the only place where every message the team exchanged appears in one
 * chronological stream, which is why it survived the round that considered
 * dropping it (W16) — and it is now built as what it is, rather than as a
 * generic table of cards.
 *
 * Three things follow from "log" that did not follow from "table":
 *   - every line is STAMPED. A stream with no time on it is a list, not a log,
 *     and the stamp is the one column a reader scans down.
 *   - the route reads as a SENTENCE — `@Worker to @Manager` — not as two
 *     coloured glyphs joined by an arrow. The coloured dot stays, aria-hidden,
 *     because it ties a line back to its node in the hierarchy graph; it is now
 *     decoration beside the name instead of standing in for one.
 *   - the body is TEXT. It used to be piped through `[innerHTML]`, so model
 *     output was parsed as markup: a log that silently re-renders what it is
 *     supposed to be quoting. Whitespace is preserved in the stylesheet
 *     instead, which is what makes a multi-line payload readable here.
 */
@Component({
  selector: 'app-message-list',
  imports: [
    CommonModule,
    CapitalizePipe,
    TableModule,
    ButtonModule,
    CopyButtonComponent,
    InspectorEmptyStateComponent,
    TranslatePipe,
  ],
  templateUrl: './message-list.component.html',
  styleUrl: './message-list.component.scss',
})
export class MessageListComponent {
  @ViewChild('dataTable') dataTable!: Table;

  utilService: UtilService = inject(UtilService);
  akgentService: AkgentService = inject(AkgentService);
  messageLogService: MessageLogService = inject(MessageLogService);
  categoryService: CategoryService = inject(CategoryService);
  toastService: MessageService = inject(MessageService);

  selectedCategories: boolean[] | null = null;

  filteredMessages: any[] = [];
  messages: any[] = [];

  subscribe: Subscription = new Subscription();

  messagesKeys = ['content'];

  ngOnDestroy() {
    this.subscribe.unsubscribe();
  }

  ngOnInit(): void {
    // Story 6.4 (AC4): migrated from the deleted `messageService.messages$`
    // to the log-derived `messageLogService.messageList$` selector. The
    // `SentMessage` / `ErrorMessage` / non-`ActorSystem` conjuncts moved
    // into `messageListFold`; only the view-concern squad-category filter
    // remains below.
    this.subscribe = combineLatest([
      this.messageLogService.messageList$,
      this.categoryService.selectedSquad$,
    ]).subscribe(([messages, selectedCategories]) => {
      this.messages = messages;
      this.filteredMessages = messages.filter(
        (message) =>
          // ADR-011 Decision 4: the welcome announcement is admitted by
          // `messageListFold` but excluded from the process message-list
          // table — it belongs to the chat panel only.
          !isWelcomeAnnouncement(message) &&
          (!selectedCategories ||
            (message.sender?.squad_id &&
              selectedCategories[
                this.categoryService.squadDict[message.sender.squad_id]
              ]))
      );

      setTimeout(() => this.scroll(), 0);
      this.initialLoad = false;
    });
  }

  initialLoad = true;
  isMouseOverTable: boolean = false; // Track mouse hover state
  scroll(behavior: string = 'smooth') {
    if (!this.isMouseOverTable && this.dataTable && !this.initialLoad) {
      const body =
        this.dataTable.containerViewChild?.nativeElement.getElementsByClassName(
          'p-datatable-table-container'
        )[0];
      body.scrollTo({
        top: body.scrollHeight,
        behavior: behavior,
      });
    }
  }

  /**
   * The wall-clock stamp of a line, `HH:MM:SS` in the reader's own zone.
   *
   * Hand-formatted rather than `Intl.DateTimeFormat`: a locale-aware time is
   * the right call for prose, and the wrong one for a column the eye scans —
   * `2:04:11 PM` and `14:04:11` do not align under each other, and the
   * 12-hour form is a third longer for no information. The DATE is deliberately
   * absent: this log covers one team run.
   *
   * An unparseable stamp yields the empty string rather than `Invalid Date`.
   * A line whose time we cannot read is still a line worth showing.
   */
  formatTime(timestamp: string | null | undefined): string {
    if (!timestamp) {
      return '';
    }
    const at = new Date(timestamp);
    if (Number.isNaN(at.getTime())) {
      return '';
    }
    return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  }

  /**
   * Who sent this line and who it went to, as a pair the template renders as a
   * sentence.
   *
   * A `SentMessage` is the only shape carrying a `recipient`; every
   * notification severity is addressed to the team, so it routes to `null` and
   * the view says "everyone". That is the SAME behaviour the two-glyph header
   * had — it fell through to the broadcast branch whenever `recipient` was
   * absent — restated as one typed value instead of two template lookups.
   */
  route(message: BaseMessage): MessageRoute {
    return {
      sender: this.party(message.sender),
      recipient: isSentMessage(message) ? this.party(message.recipient) : null,
    };
  }

  /**
   * Resolve one address to its display name and its graph colour.
   *
   * The lookup is by `agent_id` against the same `CategoryService.nodes` array
   * the hierarchy graph draws from, so a line's dot and its node in the graph
   * cannot disagree. A party with no node yet — a line that arrived before its
   * agent started, or after it stopped — resolves to `null`, and the stylesheet
   * draws the neutral dot.
   */
  private party(address: ActorAddress): RouteParty {
    const node: { category?: number } | undefined =
      this.categoryService.nodes.find(
        (candidate: { name?: string }) => candidate.name === address.agent_id,
      );
    const color =
      node?.category === undefined
        ? null
        : this.categoryService.COLORS[node.category] ?? null;
    return { name: address.name, color };
  }

  /**
   * The predicate that selects the notification branch and its colour. `null`
   * means "not a notification", which sends the row down the existing
   * `SentMessage` branch.
   *
   * Story 31-6 (FR20) moved the body to `protocol/message.types.ts` so
   * `IngestionService` classifies toasts through the same function. This stays
   * as a one-line delegation because the template binds to it by name.
   */
  notificationSeverity(message: any): NotificationSeverity | null {
    return notificationSeverity(message);
  }

  /**
   * Legend for a notification row: its own `content_type` when upstream supplied
   * one, else the per-severity fallback. `error → null` is deliberate — it keeps
   * a null-`content_type` error rendering the empty legend it renders today
   * (NFR2), while warnings and notifications (whose `content_type` is always
   * `null` upstream) get the only legend they will have until a producer sets it.
   */
  notificationLegend(
    message: any,
    severity: NotificationSeverity,
  ): string | null {
    return message.content_type || LEGEND_FALLBACK[severity];
  }

  /**
   * Keys of the inner payload the non-notification branch renders. The `?? {}`
   * is load-bearing: this is the fallback branch for every row
   * `notificationSeverity` returns `null` for, and a message the fold admitted
   * without an inner `message` would otherwise throw out of change detection and
   * take the whole table down with it. An empty row is the correct degradation.
   */
  getMessageContentKeys(message: any) {
    return Object.keys(message ?? {}).filter((k) =>
      this.messagesKeys.includes(k),
    );
  }

  /**
   * What this line's Copy control puts on the clipboard.
   *
   * ONE accessor for BOTH row shapes, because the control is now one control:
   * it lives on the line's header, beside the stamp, where a reader of a log
   * expects "copy this line" to be — not buried inside whichever body branch
   * happened to render. An ordinary message carries its text on the inner
   * payload; a notification has no inner payload and carries it on `content`.
   *
   * Deliberately NOT routed through `notificationSeverity`: that reads
   * `__model__`, and this is a fallback path reached by whatever the fold
   * admitted. Asking "which text is there" instead of "which kind of row is
   * this" degrades to `''` for a row with neither, rather than throwing out of
   * change detection and taking the table with it — the same reasoning as
   * `getMessageContentKeys`' `?? {}`.
   */
  copyableText(message: CopyableRow | null | undefined): string {
    const inner = message?.message?.content;
    if (typeof inner === 'string' && inner !== '') {
      return inner;
    }
    return typeof message?.content === 'string' ? message.content : '';
  }

  relaunch(_event: any, _msg: any) {
    this.toastService.add({
      severity: 'info',
      summary: 'Not Available',
      detail: 'Relaunch is not available in V2',
      life: 3000,
    });
  }

  disableRelaunchBtn(_message: any) {
    // V2: relaunch is not available; always disabled
    return true;
  }
}
