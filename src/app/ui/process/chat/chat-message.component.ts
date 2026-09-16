import { CommonModule, DatePipe } from '@angular/common';
import {
  Component,
  computed,
  HostBinding,
  EventEmitter,
  inject,
  input,
  Output,
} from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MarkdownModule } from 'ngx-markdown';
import { ConfigService } from '../../../core/platform/config/config.service';
import {
  buildPreview,
  ChatMessage,
  ENTRY_POINT_NAME,
} from '../../../core/services/process/selectors/chat-message.model';
import { isRateable } from '../../../core/services/process/selectors/rateable';
import {
  AgentColours,
  NO_AGENT_COLOURS,
} from '../../../core/services/process/selectors/agent-colour';
import type { AgentRef } from './agent-reader.service';
import { makeAgentNameUserFriendly } from '../../../core/shared/util/util';
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
 * How long a notification has to be before the folded row marks it as cut.
 *
 * 60 is `buildPreview`'s own default — the length at which the row used to
 * truncate the string outright. Keeping the number means the ellipsis appears
 * on exactly the messages it always appeared on; what changed underneath is
 * that the row now clips by HEIGHT and shows the whole message when opened.
 *
 * AN APPROXIMATION OF THE VISUAL CLIP, deliberately. The row is cut when the
 * text wraps past one line, which depends on the pane's width, and CSS cannot
 * test for overflow — the honest alternatives are measuring the element on
 * every resize, or a length. A narrow pane can therefore clip a shorter message
 * without marking it, which errs on the side of not claiming something is
 * truncated when it is not.
 */
const NOTICE_CLIP_CHARS = 60;

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
/**
 * The stand-in substituted for `{{agent}}` so the verb can be cut around it.
 *
 * NUL. It cannot occur in translated copy, it is not a character anybody can
 * type into a locale file by accident, and it survives interpolation
 * unchanged. Any printable sentinel would eventually collide with real copy.
 */
const AGENT_SLOT = '\u0000';

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
  @Output() rule3Clicked = new EventEmitter<ChatMessage>();
  /**
   * A NAMED PARTY on this turn was clicked — not the turn, a person on it.
   *
   * Separate from `messageSelected`, which reports the turn and lets the host
   * derive its SENDER. A notification row names two parties and either can be
   * the one you want to read, so the party has to travel with the event; a
   * host deriving it from the message could only ever guess which half was
   * clicked.
   */
  @Output() agentSelected = new EventEmitter<AgentRef>();
  message = input.required<ChatMessage>();
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

  /**
   * The agent a message goes to when the user names nobody.
   *
   * Passed IN rather than derived here: it is a fact about the team's shape,
   * which lives on the graph, and a turn has no business holding the graph to
   * answer a question about itself. The panel resolves it once per emission
   * through the same `defaultRecipientName` the composer routes on.
   *
   * Null while the roster is still empty, which reads as "no default known" and
   * makes `ownRecipient` fall silent rather than guess.
   */
  defaultRecipient = input<string | null>(null);

  /**
   * WHO THE USER SENT THIS TO, when that is worth saying — otherwise null.
   *
   * Two identical "Hello" bubbles three minutes apart went to two different
   * agents and rendered the same, so the only way to tell them apart was to
   * read the REPLY underneath and reason backwards. That inference is not just
   * awkward, it is wrong exactly when the team does the interesting thing: ask
   * @Manager, watch @Manager delegate, and the reply carries @Expert.
   *
   * NOT ON EVERY TURN. The composer's "Send to" is optional, and an empty one
   * routes to the entry supervisor — so on most turns the user chose nobody and
   * naming the recipient would caption an ordinary message with "nothing
   * unusual happened here". A label that appears on everything is a label
   * nobody reads by the fourth turn, which would cost exactly the turns this
   * exists for. So: shown when the recipient is not the default, silent when
   * it is.
   *
   * A broadcast needs no special case — the composer sends one message per
   * recipient, so each bubble already carries a single, real addressee.
   */
  readonly ownRecipient = computed<string | null>(() => {
    const msg = this.message();
    if (msg.rule !== 1) return null;

    const recipient = msg.recipient?.name;
    if (!recipient || recipient === ENTRY_POINT_NAME) return null;

    // NO ROSTER YET IS NOT "NOT THE DEFAULT". Until the graph arrives there is
    // nothing to compare against, and treating unknown as different would
    // caption every turn on the surface for as long as startup takes — the one
    // outcome this whole rule exists to avoid.
    const fallback = this.defaultRecipient();
    if (fallback === null || recipient === fallback) return null;

    return makeAgentNameUserFriendly(recipient);
  });

  /**
   * THE TEAM'S COLOUR LOOKUP, passed in rather than derived.
   *
   * An agent's colour is a fact about the ROSTER — which agent was discovered
   * first — and a turn does not hold the roster. The panel resolves it once per
   * roster change and hands the same lookup to every row, exactly as it does
   * `defaultRecipient`, so every turn on the surface agrees and the graph and
   * the member list agree with them.
   *
   * Defaults to the empty lookup, not to null: a row rendered before the roster
   * arrives asks the same question and gets "no colour", which is the resting
   * appearance this surface already had.
   */
  agentColours = input<AgentColours>(NO_AGENT_COLOURS);

  private readonly translate = inject(TranslateService);

  /**
   * The colour of whoever SPOKE, or null.
   *
   * Drives the speaker mark and the name pill. Null on the user's own turn and
   * on a tool's — the lookup withholds both — and a null background is no
   * background, which is what those two had before.
   */
  readonly senderColour = computed<string | null>(() =>
    this.agentColours().of(this.message().sender?.name),
  );

  /** The colour of the party the message was addressed TO, or null. */
  readonly recipientColour = computed<string | null>(() =>
    this.agentColours().of(this.message().recipient?.name),
  );

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


  /**
   * The two folds, told apart once.
   *
   * Rules 3 and 4 arrive collapsed and shared one row until Epic 58. They are
   * not the same kind of thing — rule 3 is `recipient.role === 'Human'` with a
   * named seat, i.e. an agent BLOCKED waiting on the user, and rule 4 is the
   * classifier's fall-through, i.e. ambient traffic nobody is waiting on. The
   * predicates live here rather than in two template expressions so the pair
   * stays mutually exclusive by construction: a message cannot render as both.
   *
   * METHODS, NOT `computed()`, AND THAT IS LOAD-BEARING.
   *
   * `collapsed` is TOGGLED IN PLACE by the panel — `chatMsg.collapsed =
   * !chatMsg.collapsed` — so the object's identity never changes. A signal
   * input does not notify on a mutated property, so a `computed()` over it is
   * memoised on the value `collapsed` had at first render and never
   * recalculates.
   *
   * That made opening a fold show BOTH rows. The expanded bubble's `*ngIf`
   * reads `message().collapsed` directly, and a template expression is
   * re-evaluated on every change-detection pass whether or not a signal fired —
   * so the bubble appeared while the folded line, gated on the stale computed,
   * stayed exactly where it was. The two halves of a pair that is supposed to
   * be mutually exclusive were reading the same field through two mechanisms
   * with different staleness.
   *
   * A method is re-evaluated per pass like the template expression beside it,
   * which is what makes the pair exclusive again. The deeper fix is for the
   * panel to replace the message rather than mutate it; until it does, nothing
   * in this component may memoise anything derived from `collapsed`.
   */
  isRequestFold(): boolean {
    return this.message().rule === 3 && this.message().collapsed;
  }

  /**
   * RULE 4 IS ALWAYS THIS ROW — open or shut.
   *
   * It used to SWAP: the folded line was replaced by a full bubble with an
   * avatar, a name pill and a markdown body. Two rows for one message, each a
   * different shape and a different height, which is what every attempt at
   * animating the change ran aground on — during a swap both are in flow, so
   * their heights add, and the transcript either dipped, bulged, or jumped.
   *
   * A notification does not need a second shape. Everything the bubble added is
   * already on this row except the words themselves, and the words are only
   * missing because they are ELLIPSED. So opening it reveals the text in place:
   * same row, same indent, same subject and verb, same clock. The only thing
   * that changes is how much of the sentence is shown, and the row grows by
   * however many lines that takes.
   *
   * `collapsed` therefore no longer selects between two renderings — it selects
   * between clipped and whole — the row renders the WHOLE message either way
   * and `.notice-text` clips it by height.
   */
  isNoticeFold(): boolean {
    return this.message().rule === 4;
  }

  /**
   * Is there more of this notification than the folded row can show?
   *
   * Drives the ellipsis, which was appearing on EVERY folded row — including
   * ones whose message fits in full, where it claimed a truncation that had not
   * happened. See `NOTICE_CLIP_CHARS` for why this is a length rather than a
   * measurement.
   */
  isNoticeClipped(): boolean {
    return (this.message().content?.length ?? 0) > NOTICE_CLIP_CHARS;
  }


  /**
   * A QUIET ONE-LINE ROW, announced on the host so the list can space it.
   *
   * The transcript's gap is uniform — `gap` cannot tell a paragraph from a
   * one-liner — and a run of folded notices at turn spacing reads as a list of
   * unrelated events rather than as one agent working. The list closes
   * consecutive quiet rows up to nothing (`.quiet-line + .quiet-line`), and
   * that rule needs to know which rows are which.
   *
   * ON THE HOST, and that is the point rather than an implementation detail.
   * The class the panel matches has to be on the element the panel actually
   * has as a child, which is `<app-chat-message>` — `.collapsed-notice` is
   * inside this component's encapsulation, where a selector written in the
   * panel's stylesheet cannot reach it without `::ng-deep`. The component that
   * knows its own rule states the fact; the list decides what to do about it.
   */
  @HostBinding('class.quiet-line') get isQuietLine(): boolean {
    return this.isNoticeFold();
  }


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

  /**
   * THE NOTIFICATION ROW'S VERB, SPLIT AROUND THE NAME IT CARRIES.
   *
   * The row reads "@Manager contacted @Expert", and both names are now
   * controls: hovering one tints it in that agent's colour, clicking it opens
   * that agent's reader. The recipient is inside a translated sentence
   * (`contacted {{agent}}`), so it has to come out of the string to be an
   * element of its own.
   *
   * SPLIT ON A SENTINEL, NOT ON THE NAME. Interpolating the real name and then
   * splitting the result on it breaks the moment a name occurs twice, or occurs
   * inside the verb, or the locale decorates it. Substituting one character
   * that cannot appear in copy and cutting there is exact — and, unlike a pair
   * of `…Before` / `…After` keys, it holds for a language that puts the name in
   * the MIDDLE of the phrase (Dutch does: "heeft @X gecontacteerd"). Only
   * `en`/`fr` ship today and both happen to end with it; the next locale added
   * must not be a rewrite of this component.
   *
   * GETTERS, NOT `computed()`, for the same reason `isNoticeFold` is a method:
   * a template expression re-evaluates every change-detection pass, so a
   * language change is picked up. `translate.instant` read inside a `computed`
   * would memoise the phrase in whichever language was active at first render.
   */
  private noticeVerb(): readonly [string, string] {
    const rendered: string = this.translate.instant('chat.notice.contacted', {
      agent: AGENT_SLOT,
    });
    const cut = rendered.indexOf(AGENT_SLOT);
    // A locale that dropped the placeholder still has to render SOMETHING
    // rather than a blank verb: the whole phrase goes before the name, which
    // reads as an ordinary sentence with the name appended.
    if (cut === -1) return [rendered, ''];
    return [rendered.slice(0, cut), rendered.slice(cut + AGENT_SLOT.length)];
  }

  get noticeVerbBefore(): string {
    return this.noticeVerb()[0];
  }

  get noticeVerbAfter(): string {
    return this.noticeVerb()[1];
  }

  /**
   * Whether a named party on this row can be OPENED.
   *
   * THE COLOUR IS THE AFFORDANCE. A party has a colour exactly when it is an
   * agent on the roster — the lookup withholds one from the tools, from the
   * human, and from an actor that is not a member at all — which is precisely
   * the set whose conversation there is something to read. So the tint and the
   * click are gated on the same fact, and a `#NotificationTool` in the subject
   * position is drawn plain and does nothing, without a second rule saying so.
   */
  isSenderOpenable(): boolean {
    return this.senderColour() !== null;
  }

  isRecipientOpenable(): boolean {
    return this.recipientColour() !== null;
  }

  onSenderClick(event: Event): void {
    event.stopPropagation();
    const { sender } = this.message();
    if (!this.isSenderOpenable() || !sender?.agent_id) return;
    this.agentSelected.emit({
      agentId: sender.agent_id,
      actorName: sender.name,
    });
  }

  onRecipientClick(event: Event): void {
    event.stopPropagation();
    const { recipient } = this.message();
    if (!this.isRecipientOpenable() || !recipient?.agent_id) return;
    this.agentSelected.emit({
      agentId: recipient.agent_id,
      actorName: recipient.name,
    });
  }

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

  /**
   * Whether this turn can be clicked shut, which is the only thing clicking a
   * turn has ever usefully done.
   *
   * Rules 3 and 4 are the only turns that COLLAPSE. Rules 1 and 2 are the
   * conversation itself — an agent's answer and the user's own words — and
   * there is nothing to open or close about them.
   *
   * IT DRIVES THE CURSOR, and that is the point of it existing separately from
   * the guard inside `onToggleCollapse`. Rules 1 and 2 used to answer a click
   * here by emitting `bubbleClicked`, which the panel recorded as
   * `selectedMessageId`, which drew `border: 2px solid var(--primary-color)` —
   * a custom property this application defines nowhere, so the declaration was
   * invalid and nothing appeared. The click was already harmless; what the
   * user saw was the POINTER, promising a result that did not exist.
   *
   * The rest of that chain — the output, the panel's state, the
   * background-click and Escape handlers that cleared it, the CSS rule — is
   * deleted rather than left dormant, so nobody has to work out later which
   * half of a selection feature was the real one.
   */
  isCollapsible(): boolean {
    const rule = this.message().rule;
    return rule === 3 || rule === 4;
  }

  onOpenModal(event: Event): void {
    event.stopPropagation();
    this.rule3Clicked.emit(this.message());
  }
}
