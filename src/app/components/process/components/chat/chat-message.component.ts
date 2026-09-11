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
import { makeAgentNameUserFriendly } from '../../../../shared/util/util';
import { FeedbackComponent } from './feedback.component';

/**
 * How much of a pending request the folded callout shows.
 *
 * The shared `buildPreview` default is 60 — one clipped line, which is what a
 * row of metadata can carry. A request is not metadata: it is a question the
 * user is being asked, and sixty characters of it is reliably the polite
 * preamble and none of the question. This is the budget for "enough to answer
 * or to decide to open it", not for the whole message; the expanded bubble is
 * still where the full text (and its markdown) lives.
 */
const REQUEST_PREVIEW_CHARS = 240;

/**
 * The longest rule-5 announcement that can still be a CAPTION.
 *
 * Rule 5 is "the system said something", and two very different things arrive
 * under it: a three-word status line ("Team started"), and a team's WELCOME
 * MESSAGE, which the catalog lets a deployment author as multi-paragraph
 * markdown — "General Team" ships one. The divider treatment below (a centred
 * caption between two hairlines) is built for the first and destroys the
 * second: a flex row collapses its newlines, `white-space: nowrap` refuses to
 * wrap it, and the overflow is simply clipped.
 *
 * WHY 80. The caption is one un-wrapped line inside a chat panel the user can
 * narrow to a few hundred pixels (the pane is draggable). At the caption's
 * 11.5px that is already about the most that fits in a comfortable panel, and
 * far more than fits in a narrow one — past it the row is not "a long caption",
 * it is a caption that is being cut off. The exact number is a judgement, but
 * the SIDE it errs on is not: over-estimating truncates a team's welcome, while
 * under-estimating shows a slightly-too-long status line as a small block,
 * which loses nothing.
 */
const SYSTEM_CAPTION_MAX_CHARS = 80;

/**
 * Markdown, in text short enough to otherwise pass as a caption.
 *
 * A caption is INTERPOLATED — it has to be, since a divider is an inline row —
 * so any markdown in it reaches the user as its own source. `**Welcome**` is
 * eleven characters and would clear the length test comfortably. These markers
 * are the ones that carry no meaning in a plain status line: a heading, an
 * emphasis run, code, a quote, a link, or a leading list bullet.
 *
 * `-` is matched ONLY as a leading bullet: a hyphen mid-sentence is punctuation
 * ("Team started - 3 agents"), and treating that as markdown would push
 * ordinary announcements into the block treatment for nothing.
 */
const MARKDOWN_MARKERS = /[#*`>[\]]|^\s*[-+]\s/;

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
  /**
   * May a rule-3 request be ANSWERED here?
   *
   * The twin of `ratingEnabled`, and it exists for the same reason: replying
   * opens the human-input modal, which only the main conversation hosts. The
   * sub-agent reader renders this component to REPORT a request's state, not to
   * act on it, so it turns the control off rather than shipping a button whose
   * click reaches nothing.
   *
   * It is NOT `notification()`. That signal says whether the request is still
   * outstanding — a fact about the message — and using it to hide the control
   * is what made an unbound input read as "already answered".
   */
  replyEnabled = input<boolean>(true);
  /**
   * Is this rule-3 request still WAITING on a human?
   *
   * A fact about the message, so every surface that renders a request must bind
   * it. The collapsed request fold states the answer in words ("Pending" /
   * "Answered") and recedes when it is false, so leaving it at its default no
   * longer means "say nothing" — it means "claim this was answered".
   */
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
  /**
   * One character for the gutter.
   *
   * HONOURS `hideAgentNames`, and that is the point of the guard rather than a
   * nicety. `label` is the agent's identity — the same string the pill above
   * renders — so an initial taken from it leaks the first letter of an agent's
   * name onto every left-aligned turn in a deployment that has asked for the
   * team to read as one assistant. Hiding the pill and keeping the monogram
   * hides the name from a reader and not from an observer.
   *
   * A DOT, not an absent element. The gutter is the transcript's spine: the
   * activity fold indents by exactly `--akg-avatar-gutter` to line up under the
   * agent that did the work, so removing the mark would leave the fold indented
   * against nothing. The dot holds the column while saying no name.
   *
   * The same fallback covers a message with no label at all, which is why the
   * two cases share one expression rather than being tested separately.
   */
  readonly avatarInitial = computed<string>(() => {
    if (!this.showAgentNames) {
      return '\u00b7';
    }
    const label = (this.message().label ?? '').replace(/^@/, '').trim();
    return label ? label.slice(0, 1).toUpperCase() : '\u00b7';
  });

  readonly collapsedFallback = computed(() =>
    this.message().rule === 3 ? 'chat.messageForYou' : 'chat.teamMessage',
  );

  readonly preview = computed(() => buildPreview(this.message().content));

  /**
   * The two folds, told apart once.
   *
   * Rules 3 and 4 arrive collapsed and shared one row until Epic 58. They are
   * not the same kind of thing — rule 3 is `recipient.role === 'Human'` with a
   * named seat, i.e. an agent BLOCKED waiting on the user, and rule 4 is the
   * classifier's fall-through, i.e. ambient traffic nobody is waiting on. The
   * predicates live here rather than in two template expressions so the pair
   * stays mutually exclusive by construction: a message cannot render as both.
   */
  readonly isRequestFold = computed(
    () => this.message().rule === 3 && this.message().collapsed,
  );

  readonly isNoticeFold = computed(
    () => this.message().rule === 4 && this.message().collapsed,
  );

  /**
   * The two parties, separately.
   *
   * `label` pre-joins them as `@A ⇒ @B`, which is exactly the "bracket soup"
   * both folds are moving away from — a joined string can only be rendered as
   * one run of text, so the sender can never be weighted differently from the
   * recipient and neither can be dropped. Reading the addresses gives each half
   * its own slot; `makeAgentNameUserFriendly` is the same normaliser `buildLabel`
   * applies, so the names read identically to the pill above a turn.
   *
   * Optional-chained because the synthetic context markers (rules 6/7) carry no
   * real addresses. They never reach these branches today, and a fold that
   * throws on a message shape it does not render would be a poor way to find out
   * if that ever changes.
   */
  readonly senderName = computed(() =>
    makeAgentNameUserFriendly(this.message().sender?.name ?? ''),
  );

  readonly recipientName = computed(() =>
    makeAgentNameUserFriendly(this.message().recipient?.name ?? ''),
  );

  /** The question, long enough to be a question. See `REQUEST_PREVIEW_CHARS`. */
  readonly requestText = computed(() =>
    buildPreview(this.message().content, REQUEST_PREVIEW_CHARS),
  );

  /**
   * Leading glyph for the ambient row.
   *
   * A `#` sigil is how the backend names a TOOL rather than an agent, so the
   * two kinds of ambient traffic — a tool reporting and an agent handing off —
   * are distinguishable without reading the name. Both are quiet; only the
   * glyph differs.
   */
  readonly noticeIcon = computed(() =>
    (this.message().sender?.name ?? '').startsWith('#') ? 'pi-bell' : 'pi-comment',
  );

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

  /**
   * Is this rule-5 message a CAPTION, or an announcement with a body?
   *
   * TWO SHAPES FOR ONE RULE, told apart once. "Team started" is chrome and gets
   * the divider it was designed for. A team's welcome message is CONTENT — it
   * is authored as markdown by the deployment, it is the first thing a user
   * reads, and it arrived interpolated into a nowrap span inside a flex row:
   * raw markup, newlines collapsed, clipped at the panel's edge. It gets a
   * block that wraps and goes through the same `ngx-markdown` path every agent
   * turn already uses.
   *
   * Three tests, all of them about whether the text CAN be a caption rather
   * than about what the message means: a caption is one line (no newline), it
   * is short (`SYSTEM_CAPTION_MAX_CHARS`), and it is plain (no markdown, which
   * an interpolated caption would leak as source). Any of them failing is
   * enough — a welcome fails all three, and anything that fails even one is
   * something the divider cannot render honestly.
   *
   * Trimmed first, so a status line with a trailing newline — which the divider
   * renders perfectly well — is not promoted to a block by whitespace alone.
   */
  readonly isSystemCaption = computed<boolean>(() => {
    const text = (this.message().content ?? '').trim();
    return (
      !text.includes('\n') &&
      text.length <= SYSTEM_CAPTION_MAX_CHARS &&
      !MARKDOWN_MARKERS.test(text)
    );
  });

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
