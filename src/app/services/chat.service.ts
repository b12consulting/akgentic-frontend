import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ChatMessage } from '../models/chat-message.model';

// [CUSTOM] Chat body and chat answer interfaces should be customized according to your API.
export interface ChatBody {
  message: string;
}

export interface ChatAnswer {
  messages: {
    kwargs: {
      content: string;
    };
  }[];
}

@Injectable()
export class ChatService {
  messages$: BehaviorSubject<ChatMessage[]> = new BehaviorSubject<ChatMessage[]>(
    []
  );
  loadingProcess$: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(
    false
  );
  replyContext$: BehaviorSubject<ChatMessage | null> =
    new BehaviorSubject<ChatMessage | null>(null);

  setReplyContext(message: ChatMessage | null): void {
    this.replyContext$.next(message);
  }

  clearReplyContext(): void {
    this.replyContext$.next(null);
  }
}
