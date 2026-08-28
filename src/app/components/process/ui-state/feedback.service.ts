import { inject, Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ConfigService } from '../../../core/config/config.service';
import { ChatMessage } from '../selectors/chat-message.model';
import { chatFold } from '../selectors/chat.selector';
import { FetchService } from '../../../core/http/fetch.service';
import { MessageLogService } from '../event/message-log.service';

export interface Feedback {
  message: ChatMessage;
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
  private readonly log: MessageLogService = inject(MessageLogService);
  private config = inject(ConfigService);

  /** Snapshot of the current derived chat message list via `chatFold` over
   *  the unified message log. Replaces the pre-refactor
   *  `chatService.messages$.value` access — the selector is now read-only
   *  (Story 6.3). */
  private currentMessages(): ChatMessage[] {
    return chatFold(this.log.snapshot()).messages;
  }

  feedbacks$: BehaviorSubject<Feedback[]> = new BehaviorSubject<Feedback[]>([]);

  async getFeedback(run_id: string): Promise<any> {
    const response = await this.fetchService.fetch({
      url: `${this.config.api}/get-feedback?run_id=${run_id}`,
    });
    return response;
  }

  async setFeedback(run_id: string, feedback: Feedback) {
    const feedback_id = await this.fetchService.fetch({
      url: `${this.config.api}/set-feedback`,
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
    const message = this.currentMessages().find(
      (m) => m.id === run_id
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

  /**
   * The one in-flight (or completed) load, or `null` if none has started.
   *
   * `loadFeedback` used to be called from nowhere at all. It is now called by
   * every rating control that mounts — one per rateable turn — and each call
   * walks the WHOLE message list issuing a request per message. Left
   * unguarded that is quadratic: a forty-turn conversation would open with
   * sixteen hundred requests for the same forty answers.
   *
   * Sharing the promise is not merely cheaper, it is also right: a message
   * that arrives after the load cannot already carry a rating from an earlier
   * visit, and the rating the user gives it in this session is pushed onto
   * `feedbacks$` by `setFeedback`.
   *
   * The scope is one process view — this service is provided by
   * `ProcessComponent`, so opening another team constructs a new instance and
   * loads again.
   */
  private pendingLoad: Promise<void> | null = null;

  async loadFeedback(): Promise<void> {
    if (this.pendingLoad) return this.pendingLoad;

    // Nothing derived yet: do NOT latch. Latching an empty load would let the
    // first control to mount win a race against the log and leave every
    // previously-given rating invisible for the rest of the session (FR8).
    const messages = this.currentMessages();
    if (messages.length === 0) return;

    this.pendingLoad = this.fetchAllFeedback(messages);
    return this.pendingLoad;
  }

  private async fetchAllFeedback(messages: ChatMessage[]): Promise<void> {
    try {
      const feedbacks = await Promise.all(
        messages.map(async (message) => {
          const feedback: FeedbackBackend = await this.getFeedback(message.id);
          if (!feedback?.score) return null;
          return this.backendFeedbackToFrontendFeedback(message.id, feedback);
        })
      );

      const filteredFeedbacks = feedbacks.filter(
        (feedback) => feedback !== null
      );

      this.feedbacks$.next(filteredFeedbacks);
    } catch (err) {
      // Release the latch so a later mount can retry. `FetchService` has
      // already raised the toast, and a conversation whose ratings failed to
      // load is still a usable conversation — so nothing is rethrown into the
      // controls' `ngOnInit`, where it would surface as an unhandled rejection
      // once per rateable turn.
      this.pendingLoad = null;
      console.debug('[FeedbackService.loadFeedback] load failed', err);
    }
  }
}
