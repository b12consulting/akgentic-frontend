import { inject, Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { environment } from '../../environments/environment';
import { Message } from '../models/types';
import { ChatService } from './chat.service';
import { FetchService } from './fetch.service';

export interface Feedback {
  message: Message;
  isPositive: boolean;
  comment: string;
  feedback_id?: string;
}

export interface FeedbackBackend {
  comment: string;
  score?: number;
}

@Injectable()
export class FeedbackService {
  fetchService: FetchService = inject(FetchService);
  chatService: ChatService = inject(ChatService);

  feedbacks$: BehaviorSubject<Feedback[]> = new BehaviorSubject<Feedback[]>([]);

  async getFeedback(run_id: string): Promise<any> {
    const response = await this.fetchService.fetch({
      url: `${environment.api}/get-feedback?run_id=${run_id}`,
    });
    return response;
  }

  async setFeedback(run_id: string, feedback: Feedback) {
    const feedback_id = await this.fetchService.fetch({
      url: `${environment.api}/set-feedback`,
      options: {
        method: 'POST',
        body: JSON.stringify({
          feedback: this.frontendFeedbackToBackendFeedback(feedback),
          run_id,
        }),
        headers: { 'Content-Type': 'application/json' },
      },
    });

    feedback.feedback_id = feedback_id;

    this.feedbacks$.next([...this.feedbacks$.value, feedback]);
  }

  backendFeedbackToFrontendFeedback(
    run_id: string,
    feedback: FeedbackBackend
  ): Feedback | null {
    const message = this.chatService.messages$.value.find(
      (m) => m.run_id === run_id
    );
    if (!message) return null;

    return {
      message: message,
      isPositive: feedback.score === 1,
      comment: feedback.comment,
    };
  }

  frontendFeedbackToBackendFeedback(feedback: Feedback): FeedbackBackend {
    return {
      comment: feedback.comment,
      score: feedback.isPositive ? 1 : 0,
    };
  }

  async loadFeedback() {
    const messagesWithRunId = this.chatService.messages$.value.filter(
      (m) => m.run_id
    );

    const feedbacks = await Promise.all(
      messagesWithRunId.map(async (message) => {
        const feedback: FeedbackBackend = await this.getFeedback(
          message.run_id!
        );
        if (!feedback?.score) return null;
        return this.backendFeedbackToFrontendFeedback(
          message.run_id!,
          feedback
        );
      })
    );

    const filteredFeedbacks = feedbacks.filter((feedback) => feedback !== null);

    this.feedbacks$.next(filteredFeedbacks);
  }
}
