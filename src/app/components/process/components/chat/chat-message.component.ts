import { CommonModule, DatePipe } from '@angular/common';
import {
  Component,
  computed,
  EventEmitter,
  inject,
  input,
  Output,
} from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { TranslatePipe } from '@ngx-translate/core';
import { MarkdownModule } from 'ngx-markdown';
import { ConfigService } from '../../../../core/config/config.service';
import { buildPreview, ChatMessage } from '../../selectors/chat-message.model';
import { isRateable } from '../../selectors/rateable';
import { FeedbackComponent } from './feedback.component';

@Component({
  selector: 'app-chat-message',
  standalone: true,
  imports: [
    CommonModule,
    MarkdownModule,
    DatePipe,
    ButtonModule,
    FeedbackComponent,
    TranslatePipe,
  ],
  templateUrl: './chat-message.component.html',
  styleUrl: './chat-message.component.scss',
})
export class ChatMessageComponent {
  @Output() messageSelected = new EventEmitter<ChatMessage>();
  @Output() toggleCollapse = new EventEmitter<ChatMessage>();
  @Output() bubbleClicked = new EventEmitter<ChatMessage>();
  @Output() rule3Clicked = new EventEmitter<ChatMessage>();
  message = input.required<ChatMessage>();
  selected = input<boolean>(false);
  /**
   * May a turn be rated HERE?
   *
   * Separate from `isRateable`, which answers whether the MESSAGE is the kind of
   * thing that can be rated at all. This answers whether the SURFACE offers it,
   * and the two are genuinely different questions: the sub-agent reader (Epic
   * 51) renders this same component and is specified read-only — no reply, no
   * edit, no send — and submitting a rating is a send.
   *
   * Defaults to true, so the main conversation is unaffected and a new surface
   * has to opt out deliberately rather than inherit a write path by accident.
   */
  ratingEnabled = input<boolean>(true);
  notification = input<boolean>(false);

  private readonly config = inject(ConfigService);

  /**
   * Show the "@Sender ⇒ @Recipient" identity?
   *
   * A plain field, not a computed: `ConfigService` is resolved once before the
   * app renders and cannot change afterwards, so recomputing it per message
   * would cost work for a value that is fixed for the session.
   *
   * The SYSTEM label (rule 5) is deliberately NOT covered by this. It names no
   * agent — it says a message came from the system — so hiding it would remove
   * information without hiding an identity.
   */
  readonly showAgentNames = !this.config.hideAgentNames;

  /**
   * What stands in for the identity on a COLLAPSED line when names are hidden.
   *
   * The collapsed row is `[label] : preview`, and an empty bracket pair reads
   * like a rendering fault. Naming the KIND of message is the honest substitute:
   * it says what the row is without saying who.
   *
   * A translation KEY, not a sentence — the template resolves it. The agent
   * `label` beside it is deliberately NOT translated: it is a name the backend
   * chose and it has no key.
   */
  readonly collapsedFallback = computed(() =>
    this.message().rule === 3 ? 'chat.messageForYou' : 'chat.teamMessage',
  );

  readonly preview = computed(() => buildPreview(this.message().content));

  /**
   * The turn's timestamp, or `null` when the backend sent one that could not be
   * parsed.
   *
   * Angular's `DatePipe` THROWS `InvalidPipeArgumentError` on an `Invalid Date`
   * — and `classifyMessage` builds `timestamp` with `new Date(...)`, which
   * yields exactly that for a malformed string. Bound directly, one bad row
   * therefore takes down the whole transcript render, not just its own clock.
   * The pipe returns `null` for `null`, so funnelling it through here degrades
   * to "no time shown" instead (Epic 54 FR5: a malformed date from a backend is
   * a rendering question, never an error).
   */
  readonly timestampOrNull = computed(() => {
    const timestamp = this.message().timestamp;
    return Number.isFinite(timestamp?.getTime()) ? timestamp : null;
  });

  /**
   * Can this turn be rated?
   *
   * Delegated, never decided here. The rule is a list of exclusions and
   * exclusions rot in silence, so it lives in exactly one place
   * (`selectors/rateable.ts`, Epic 57 FR1) and this template asks rather than
   * re-derives. Inlining even the easy half of it — "not the user's own turn"
   * — is how the answer starts differing between surfaces.
   */
  readonly rateable = computed(() => isRateable(this.message()));

  /** True for the synthetic context-management markers (Epic 29 / ADR-010):
   *  rule 6 = compaction fold, rule 7 = clear line. */
  readonly isMarker = computed(
    () => this.message().rule === 6 || this.message().rule === 7,
  );

  /** Leading glyph for a marker row — stacked bars for a compaction fold, a
   *  trash glyph for a conversation clear. */
  readonly markerIcon = computed(() =>
    this.message().rule === 6 ? 'pi-bars' : 'pi-trash',
  );

  /** Toggle the compaction summary fold. Only rule 6 collapses; the clear
   *  marker (rule 7) is inert. Reuses the panel's `toggleCollapse` channel so
   *  the expand state persists across the pure fold's re-emissions. */
  onToggleMarker(): void {
    if (this.message().rule === 6) {
      this.toggleCollapse.emit(this.message());
    }
  }

  onToggleCollapse(): void {
    const msg = this.message();
    // Rule 5 (welcome) is behaviourally inert (ADR-011 Decision 3).
    if (msg.rule === 5) return;
    if (msg.rule === 3 || msg.rule === 4) {
      this.toggleCollapse.emit(msg);
    }
  }

  onLabelClick(): void {
    const msg = this.message();
    // Rule 5 (welcome) is behaviourally inert (ADR-011 Decision 3).
    if (msg.rule === 5) return;
    if (msg.rule !== 1) {
      this.messageSelected.emit(msg);
    }
  }

  onBubbleClick(event: Event): void {
    event.stopPropagation();
    const msg = this.message();
    // Rule 5 (welcome) is behaviourally inert (ADR-011 Decision 3).
    if (msg.rule === 5) return;
    switch (msg.rule) {
      case 1:
      case 2:
        this.bubbleClicked.emit(msg);
        break;
      case 3:
      case 4:
        this.onToggleCollapse();
        break;
    }
  }

  onOpenModal(event: Event): void {
    event.stopPropagation();
    this.rule3Clicked.emit(this.message());
  }
}
