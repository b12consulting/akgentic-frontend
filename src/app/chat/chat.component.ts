import { CommonModule } from '@angular/common';
import {
  Component,
  inject,
  Input,
  signal,
  WritableSignal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { BehaviorSubject } from 'rxjs';
import { Message } from '../models/types';
import { ProcessUserInputComponent } from '../process/user-input/user-input.component';
import { ChatService } from '../services/chat.service';
import { Selectable, SelectionService } from '../services/selection.service';
import { MessageListComponent } from './message-list.component';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [MessageListComponent, ProcessUserInputComponent, CommonModule],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.scss',
})
export class ChatComponent {
  @Input() processId!: string;
  @Input() loading$!: BehaviorSubject<boolean>;

  selectionService: SelectionService = inject(SelectionService);
  chatService: ChatService = inject(ChatService);

  errorMessage: WritableSignal<string | undefined> = signal(undefined);
  messages_from_service = this.chatService.messages$;
  messagesSignal = toSignal(this.messages_from_service, { requireSync: true });
  loadingProcess$ = this.chatService.loadingProcess$;

  handleMessageSelected(message: Message) {
    const selectable: Selectable = {
      type: 'message',
      data: {
        name: message.agent_id,
        actorName: message.agent_name,
        humanRequests: message.human_requests,
      },
    };

    this.selectionService.handleSelection(selectable);
  }
}
