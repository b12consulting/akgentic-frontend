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
import { TranslatePipe } from '@ngx-translate/core';
import { Button } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { Textarea } from 'primeng/textarea';
import { BehaviorSubject, Subscription } from 'rxjs';
import { UtilService } from '../../../services/utils.service';
import { IconButtonComponent } from '../../../components/common/icon-button/icon-button.component';
import { ChatMessage } from '../../../services/process/selectors/chat-message.model';
import { isRateable } from '../../../services/process/selectors/rateable';
import { Feedback, FeedbackService } from '../../../services/process/ui-state/feedback.service';

/**
 * The turn's action row: copy, and the two thumbs.
 *
 * THREE CONTROLS, NOT TWO, and they are buttons rather than bare glyphs. What
 * shipped before was a pair of `<i class="pi">` elements with a click handler:
 * no hit target beyond the 15px glyph itself, no hover ground, no focus ring,
 * no accessible name, and no way to reach either of them from the keyboard.
 * `app-icon-button` is the console's answer to all five, and using it here is
 * what makes this row the same object as the rail's and the inspector's
 * controls rather than a third thing that happens to look similar.
 *
 * WHY COPY LIVES HERE. The design draws copy in the same row as the thumbs, and
 * both are things you do TO a finished answer rather than to the conversation —
 * so they share a row, a reveal and a gate. `isRateable` is that gate, and it is
 * already exactly right for copy: the turns it excludes are the user's own words
 * (which they still have), the system's blurb, and the compaction bookkeeping.
 *
 * WHY RETRY DOES NOT. The mock's third button is a retry, and there is nothing
 * behind it: no regenerate endpoint exists on `ApiService`, and a control that
 * silently does nothing is worse than an absent one. Copy takes the third slot
 * so the row keeps the mock's geometry, and retry stays out until there is a
 * request to send. Re-sending the user's previous message from the composer is
 * NOT the same operation and must not be dressed as one.
 */
@Component({
  selector: 'app-feedback',
  standalone: true,
  imports: [
    DialogModule,
    FormsModule,
    CommonModule,
    Textarea,
    Button,
    IconButtonComponent,
    TranslatePipe,
  ],
  styleUrls: ['./feedback.component.scss'],
  template: `
    <!--
      Left-aligned under the prose, as the mock draws it. The old row ended
      flush right, which put the controls against the right edge of a bubble
      whose text starts at the left — so on a short answer they floated in
      space with nothing above them.

      Geometry only on the glyphs: the icon-button primitive owns the size, the
      stroke weight and the hover ground, so every icon in the console matches
      without each caller restating three attributes.
    -->
    <div class="action-row" *ngIf="rateable()">
      <app-icon-button
        class="action-copy"
        size="sm"
        [label]="'chat.action.copy' | translate"
        (pressed)="copy()"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h8" />
        </svg>
      </app-icon-button>

      <app-icon-button
        class="action-thumb-up"
        size="sm"
        [class.is-chosen]="(hasFeedback$ | async) && (isPositiveFeedback$ | async)"
        [tone]="
          (hasFeedback$ | async) && (isPositiveFeedback$ | async)
            ? 'pressed'
            : 'quiet'
        "
        [label]="'chat.action.rateUp' | translate"
        (pressed)="openFeedbackModal(true)"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 3 2l-1 6h4a2 2 0 0 1 2 2.4l-1.2 6A2 2 0 0 1 15.8 21H7"
          />
        </svg>
      </app-icon-button>

      <app-icon-button
        class="action-thumb-down"
        size="sm"
        [class.is-chosen]="(hasFeedback$ | async) && !(isPositiveFeedback$ | async)"
        [tone]="
          (hasFeedback$ | async) && !(isPositiveFeedback$ | async)
            ? 'pressed'
            : 'quiet'
        "
        [label]="'chat.action.rateDown' | translate"
        (pressed)="openFeedbackModal(false)"
      >
        <!-- The SAME path, rotated. A hand-drawn mirror of a stroked glyph
             never quite matches its partner's weight, and the pair sitting
             side by side is exactly where that shows. -->
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            transform="rotate(180 12 12)"
            d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 3 2l-1 6h4a2 2 0 0 1 2 2.4l-1.2 6A2 2 0 0 1 15.8 21H7"
          />
        </svg>
      </app-icon-button>
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
          <span>{{ 'chat.feedback.title' | translate }}</span>
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
        [attr.placeholder]="'chat.feedback.placeholder' | translate"
      ></textarea>
      <ng-template pTemplate="footer">
        <p-button
          pRipple
          type="button"
          icon="pi pi-times"
          (click)="onCancel()"
          [label]="'chat.feedback.cancel' | translate"
          class="p-button-text"
        ></p-button>
        <p-button
          pRipple
          type="button"
          icon="pi pi-check"
          (click)="submitFeedback()"
          [label]="'chat.feedback.submit' | translate"
        ></p-button>
      </ng-template>
    </p-dialog>
  `,
})
export class FeedbackComponent implements OnInit, OnDestroy {
  feedbackService = inject(FeedbackService);
  private readonly utils = inject(UtilService);
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

  onInputChange(comment: string): void {
    this.feedbackComment$.next(comment);
  }

  /**
   * Put the turn's text on the clipboard.
   *
   * The RAW content, not the rendered DOM. What the agent sent is markdown, and
   * a paste is nearly always headed somewhere that understands it — a ticket, a
   * chat, an editor. Scraping `innerText` off the rendered turn would strip the
   * structure the author put there and silently flatten a table into a run-on
   * line.
   */
  copy(): void {
    this.utils.copyToClipboard(this.message().content);
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
