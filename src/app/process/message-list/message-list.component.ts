import { CommonModule } from '@angular/common';
import { Component, inject, ViewChild } from '@angular/core';

import { ButtonModule } from 'primeng/button';
import { FieldsetModule } from 'primeng/fieldset';
import { Table, TableModule } from 'primeng/table';
import { MessageService } from 'primeng/api';

import { CapitalizePipe } from '../../pipes/capitalise.pipe';
import { CategoryService } from '../../services/category.service';
import { UtilService } from '../../services/utils.service';

import { combineLatest, Subscription } from 'rxjs';
import { AkgentService } from '../../services/akgent.service';
import { ActorMessageService } from '../../services/message.service';
import { CopyButtonComponent } from '../copy-button/copy-button.component';

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
  messageService: ActorMessageService = inject(ActorMessageService);
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
    this.subscribe = combineLatest([
      this.messageService.messages$,
      this.categoryService.selectedSquad$,
    ]).subscribe(([messages, selectedCategories]) => {
      this.messages = messages;
      this.filteredMessages = messages.filter(
        (message) =>
          (message.__model__.includes('SentMessage') ||
            message.__model__.includes('ErrorMessage')) &&
          message.sender.role !== 'ActorSystem' &&
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

  getMessageContentKeys(message: any) {
    return Object.keys(message).filter((k) => this.messagesKeys.includes(k));
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
