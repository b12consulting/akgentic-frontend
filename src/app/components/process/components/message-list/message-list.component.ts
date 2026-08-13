import { CommonModule } from '@angular/common';
import { Component, inject, ViewChild } from '@angular/core';

import { ButtonModule } from 'primeng/button';
import { FieldsetModule } from 'primeng/fieldset';
import { Table, TableModule } from 'primeng/table';
import { MessageService } from 'primeng/api';

import { CapitalizePipe } from '../../../../shared/pipes/capitalise.pipe';
import { CategoryService } from '../../../../core/ui/category.service';
import { UtilService } from '../../../../core/ui/utils.service';

import { combineLatest, Subscription } from 'rxjs';
import { AkgentService } from '../../../../core/ui/akgent.service';
import { MessageLogService } from '../../event/message-log.service';
import {
  isWelcomeAnnouncement,
  notificationSeverity,
  NotificationSeverity,
} from '../../../../protocol/message.types';
import { CopyButtonComponent } from '../../../../shared/components/copy-button/copy-button.component';

/** Legend used when a notification carries no `content_type` of its own. */
const LEGEND_FALLBACK: Record<NotificationSeverity, string | null> = {
  error: null,
  warn: 'Warning',
  info: 'Notification',
};

@Component({
  selector: 'app-message-list',
  imports: [
    CommonModule,
    CapitalizePipe,
    TableModule,
    FieldsetModule,
    ButtonModule,
    CopyButtonComponent,
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

  getSenderColor(message: any) {
    const nodes = this.categoryService.nodes.find(
      (n) => n.name == message.sender.agent_id
    );
    return { color: this.categoryService.COLORS[nodes?.category] };
  }

  getRecipientColor(message: any) {
    const nodes = this.categoryService.nodes.find(
      (n) => n.name == message.recipient.agent_id
    );
    return { color: this.categoryService.COLORS[nodes?.category] };
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
