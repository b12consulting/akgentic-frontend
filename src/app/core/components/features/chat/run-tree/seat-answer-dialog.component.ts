import { DatePipe } from '@angular/common';
import { Component, effect, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { MarkdownModule } from 'ngx-markdown';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { TextareaModule } from 'primeng/textarea';

import { ActorAddress } from '../../../../protocol/message.types';
import { RunMessage } from '../../../../services/process/selectors/run-graph.selector';

export interface SeatAnswer {
  content: string;
  /** The question's INNER id: the key the backend resolves human input by. */
  messageId: string;
}

/**
 * "Answer as @X" (Epic 55, ADR-037 §D4): answering a waiting human seat from
 * the node the question sits on.
 *
 * One question, one text area. It emits the trimmed answer keyed by
 * `messageId`, the question's inner id, which the host takes from the seat
 * run (ADR-037 §D4); it never keys by a run key or an envelope id. The key is
 * separate from `question` because a replay that starts mid-conversation may
 * not hold the question: the dialog then says so, and still sends.
 * Nothing is shown optimistically: the seat's node turns `answered` when its
 * reply arrives on the log.
 *
 * Every way out — Cancel, the close button, the scrim, Escape — emits
 * `visibleChange(false)` and clears the draft; only Send answer emits `send`.
 */
@Component({
  selector: 'app-seat-answer-dialog',
  standalone: true,
  imports: [
    DatePipe,
    FormsModule,
    DialogModule,
    TextareaModule,
    ButtonModule,
    MarkdownModule,
    TranslatePipe,
  ],
  templateUrl: './seat-answer-dialog.component.html',
  styleUrl: './seat-answer-dialog.component.scss',
})
export class SeatAnswerDialogComponent {
  visible = input<boolean>(false);
  seat = input<ActorAddress | null>(null);
  /** The question, when the loaded log holds it. Display only. */
  question = input<RunMessage | null>(null);
  /** The question's inner id: the answer key. Without it nothing sends. */
  messageId = input<string | null>(null);

  visibleChange = output<boolean>();
  send = output<SeatAnswer>();

  draft = '';

  constructor() {
    // The host can close the dialog too (its seat was answered elsewhere); a
    // draft never carries over to the next question.
    effect(() => {
      if (!this.visible()) this.draft = '';
    });
  }

  get canSend(): boolean {
    return this.draft.trim().length > 0 && this.messageId() !== null;
  }

  onSend(): void {
    const messageId = this.messageId();
    const content = this.draft.trim();
    if (messageId === null || !content) return;
    this.send.emit({ content, messageId });
    this.close();
  }

  onVisibleChange(value: boolean): void {
    if (!value) this.close();
  }

  close(): void {
    this.draft = '';
    this.visibleChange.emit(false);
  }
}
