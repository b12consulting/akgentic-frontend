import { inject, Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ConfigService } from '../../../platform/config/config.service';
import { ChatMessage } from '../selectors/chat-message.model';
import { chatFold } from '../selectors/chat.selector';
import { FetchService, HttpError } from '../../../platform/http/fetch.service';
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

  /**
   * Does this backend serve the feedback routes at all?
   *
   * `/get-feedback` and `/set-feedback` are served by NO released server tier —
   * they are absent from the community tier's OpenAPI entirely. So the honest
   * default is "assume yes, find out once, and remember the answer": a 404 is
   * this backend saying the feature does not exist here, which is a fact about
   * the deployment and not about the message being rated.
   *
   * Latched to FALSE ON 404 ONLY. A 500 or a dropped connection is a fault, not
   * an answer — latching on those would disable ratings for the session because
   * one request happened to fail, and the user would have no way to get them
   * back short of a reload.
   *
   * Without this the cost was one request and one error toast PER RATEABLE TURN,
   * every time a control mounted: a wall of "Request failed: Not Found" raised
   * by a feature nobody had touched, which is also what buried any real error
   * next to it.
   */
  private supported = true;

  /** False once the backend has told us these routes do not exist. */
  get feedbackSupported(): boolean {
    return this.supported;
  }

  async getFeedback(run_id: string): Promise<any> {
    // `silent`: the failure is expected on a backend without the routes, and
    // this service reports the absence once (above) rather than per turn.
    const response = await this.fetchService.fetch({
      url: `${this.config.api}/get-feedback?run_id=${run_id}`,
      silent: true,
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
   * The scope is one visit to the process route — this service is provided
   * there, so arriving at the view constructs a new instance and loads again.
   *
   * NOT once per TEAM. The router reuses the route when only `:id` changes, so
   * switching teams in place keeps this instance and its `pendingLoad`. That is
   * correct here — feedback is keyed by message, not by team — but it is the
   * reason this says "one visit" rather than "one team".
   */
  private pendingLoad: Promise<void> | null = null;

  async loadFeedback(): Promise<void> {
    // Asked and answered: this backend has no feedback routes, so there is
    // nothing to load and no point rediscovering that per mount.
    if (!this.supported) return;

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
    const toFeedback = (id: string, loaded: FeedbackBackend | null) =>
      loaded?.score ? this.backendFeedbackToFrontendFeedback(id, loaded) : null;

    try {
      // ONE request, awaited alone, BEFORE the fan-out below. This endpoint is
      // per-message, so a conversation of N turns costs N requests — and on a
      // backend that does not serve the route, all N are 404s. Learning that
      // from the first one makes the answer cost a single request instead of a
      // screenful, which is what the network tab actually showed.
      const [probe, ...rest] = messages;
      const probed: FeedbackBackend = await this.getFeedback(probe.id);

      const restFeedbacks = await Promise.all(
        rest.map(async (message) => {
          const feedback: FeedbackBackend = await this.getFeedback(message.id);
          return toFeedback(message.id, feedback);
        })
      );

      const feedbacks = [toFeedback(probe.id, probed), ...restFeedbacks];

      this.feedbacks$.next(feedbacks.filter((feedback) => feedback !== null));
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        // NOT a fault — the deployment does not have this feature. Latch it and
        // stop asking; the latch is deliberately NOT released, because retrying
        // is what produced a fresh wall of 404s on every control that mounted.
        this.supported = false;
        console.debug(
          '[FeedbackService] backend serves no feedback routes — ratings inert',
        );
        return;
      }
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
