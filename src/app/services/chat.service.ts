import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { Message } from '../models/types';

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
  messages$: BehaviorSubject<Message[]> = new BehaviorSubject<Message[]>([]);
  loadingProcess$: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(
    false
  );
}
