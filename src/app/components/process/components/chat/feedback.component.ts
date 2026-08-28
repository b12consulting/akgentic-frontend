import { CommonModule } from '@angular/common';
import {
  Component,
  computed,
  HostBinding,
  inject,
  input,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Button } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { Textarea } from 'primeng/textarea';
import { BehaviorSubject, Subscription } from 'rxjs';
import { ChatMessage } from '../../selectors/chat-message.model';
import { isRateable } from '../../selectors/rateable';
import { Feedback, FeedbackService } from '../../ui-state/feedback.service';

@Component({
  selector: 'app-feedback',
  standalone: true,
  imports: [DialogModule, FormsModule, CommonModule, Textarea, Button],
  styleUrls: ['./feedback.component.scss'],
  template: `
    <div class="feedback-icons" *ngIf="rateable()">
      <i
        class="pi pi-thumbs-up"
        [class.selected]="
          (hasFeedback$ | async) && (isPositiveFeedback$ | async)
        "
        (click)="openFeedbackModal(true)"
      ></i>
      <i
        class="pi pi-thumbs-down"
        [class.selected]="
          (hasFeedback$ | async) && !(isPositiveFeedback$ | async)
        "
        (click)="openFeedbackModal(false)"
      ></i>
    </div>

    <p-dialog
      [visible]="(displayModal$ | async) ?? false"
      [modal]="true"
      [style]="{ width: '50vw' }"
      [draggable]="false"
      [resizable]="false"
      (visibleChange)="onCancel()"
    >
      <ng-template pTemplate="header">
        <div class="modal-header">
          <span>Feedback</span>
          <div class="modal-selected-thumb">
            <i
              *ngIf="isPositiveFeedback$ | async"
              class="pi pi-thumbs-up selected"
            ></i>
            <i
              *ngIf="!(isPositiveFeedback$ | async)"
              class="pi pi-thumbs-down selected"
            ></i>
          </div>
        </div>
      </ng-template>

      <textarea
        pTextarea
        rows="10"
        style="width: 100%"
        [ngModel]="feedbackComment$ | async"
        (ngModelChange)="onInputChange($event)"
        placeholder="Enter your feedback here..."
      ></textarea>
      <ng-template pTemplate="footer">
        <p-button
          pRipple
          type="button"
          icon="pi pi-times"
          (click)="onCancel()"
          label="Cancel"
          class="p-button-text"
        ></p-button>
        <p-button
          pRipple
          type="button"
          icon="pi pi-check"
          (click)="submitFeedback()"
          label="Submit"
        ></p-button>
      </ng-template>
    </p-dialog>
  `,
})
export class FeedbackComponent implements OnInit, OnDestroy {
  feedbackService = inject(FeedbackService);
  message = input.required<ChatMessage>();

  /**
   * The rule, asked — never restated. This guard used to read
   * `message().rule !== 1`, which was the whole rating policy expressed as a
   * magic number inside a template. `isRateable` is the one home for it
   * (Epic 57 FR1); the host that renders this component asks the same
   * question before instantiating it, so both agree by construction.
   */
  readonly rateable = computed(() => isRateable(this.message()));

  displayModal$ = new BehaviorSubject<boolean>(false);
  feedbackComment$ = new BehaviorSubject<string>('');
  isPositiveFeedback$ = new BehaviorSubject<boolean>(false);
  hasFeedback$ = new BehaviorSubject<boolean>(false);
  selectedThumb$ = new BehaviorSubject<'up' | 'down' | null>(null);

  /**
   * Marks the host as already-rated so the conversation can keep the control
   * visible for this turn while hiding it on every other one (FR8 + NFR2).
   * A getter rather than a stored flag: `hasFeedback$` is the single source
   * and change detection reads this on every pass.
   */
  @HostBinding('class.rated')
  get rated(): boolean {
    return this.hasFeedback$.value;
  }

  private feedbackSubscription?: Subscription;

  async ngOnInit(): Promise<void> {
    // Subscribe BEFORE loading. `feedbacks$` is a BehaviorSubject so ordering
    // is not strictly required today, but a load that resolves between the
    // await and the subscribe would drop this message's existing rating and
    // FR8 would fail intermittently and invisibly.
    //
    // Reading the rating out of the SERVICE, keyed by message id, is what
    // makes it survive the chat list re-emitting: this component is rebuilt
    // whenever its message row is, and any state it held privately would be
    // gone — looking exactly like a rating that failed to save.
    this.feedbackSubscription = this.feedbackService.feedbacks$.subscribe(
      (feedbacks) => {
        const feedback = feedbacks.find(
          (f) => f.message.id === this.message().id,
        );
        if (feedback) {
          this.hasFeedback$.next(true);
          this.isPositiveFeedback$.next(feedback.isPositive);
          this.feedbackComment$.next(feedback.comment);
        }
      },
    );
    await this.feedbackService.loadFeedback();
  }

  ngOnDestroy(): void {
    this.feedbackSubscription?.unsubscribe();
  }

  onInputChange(event: any) {
    this.feedbackComment$.next(event);
  }

  openFeedbackModal(isPositive: boolean) {
    this.displayModal$.next(true);
    this.isPositiveFeedback$.next(isPositive);
    this.selectedThumb$.next(isPositive ? 'up' : 'down');
  }

  submitFeedback() {
    this.hasFeedback$.next(true);
    const feedback: Feedback = {
      message: this.message(),
      isPositive: this.isPositiveFeedback$.value,
      comment: this.feedbackComment$.value,
    };
    const msgId = this.message().id;
    if (!msgId) {
      console.error('No id found in message');
      this.displayModal$.next(false);
      return;
    }
    this.feedbackService.setFeedback(msgId, feedback);
    this.displayModal$.next(false);
  }

  onCancel() {
    this.displayModal$.next(false);
  }
}
