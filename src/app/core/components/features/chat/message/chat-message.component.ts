import { CommonModule, DatePipe } from '@angular/common';
import {
  Component,
  computed,
  EventEmitter,
  inject,
  input,
  Output,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { MarkdownModule } from 'ngx-markdown';
import { ConfigService } from '../../../../platform/config/config.service';
import {
  ChatMessage,
  ENTRY_POINT_NAME,
} from '../../../../services/process/selectors/chat-message.model';
import { isRateable } from '../../../../services/process/selectors/rateable';
import {
  AgentColours,
  NO_AGENT_COLOURS,
} from '../../../../services/process/selectors/agent-colour';
import { makeAgentNameUserFriendly } from '../../../../shared/util/util';
import { FeedbackComponent } from './feedback.component';

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

/**
 * One chat bubble: your message (rule 1), an agent's answer to you (rule 2),
 * a system announcement (rule 5), or a context-management marker (rules 6/7).
 *
 * Rules 3 and 4 — a question to a human seat, and traffic between agents —
 * render nothing here: the run-tree transcript shows them in the tree, not as
 * rows (Epic 55), and never hands them to this component.
 */
@Component({
  selector: 'app-chat-message',
  standalone: true,
  imports: [CommonModule, MarkdownModule, DatePipe, FeedbackComponent, TranslatePipe],
  templateUrl: './chat-message.component.html',
  styleUrl: './chat-message.component.scss',
})
export class ChatMessageComponent {
  /** A compaction marker (rule 6) was opened or shut. */
  @Output() toggleCollapse = new EventEmitter<ChatMessage>();
  message = input.required<ChatMessage>();
  /**
   * May a turn be rated HERE?
   *
   * Separate from `isRateable`, which answers whether the MESSAGE is the kind of
   * thing that can be rated at all. This answers whether the SURFACE offers it
   * in the bubble: the run-tree transcript draws an answer's rating controls in
   * its own action row, beside the provenance link, and turns this off there.
   *
   * Defaults to true, so a surface has to opt out deliberately rather than lose
   * the control by accident.
   */
  ratingEnabled = input<boolean>(true);

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
   * One character for the gutter.
   *
   * HONOURS `hideAgentNames`, and that is the point of the guard rather than a
   * nicety. `label` is the agent's identity — the same string the pill above
   * renders — so an initial taken from it leaks the first letter of an agent's
   * name onto every left-aligned turn in a deployment that has asked for the
   * team to read as one assistant. Hiding the pill and keeping the monogram
   * hides the name from a reader and not from an observer.
   *
   * A DOT, not an absent element. The gutter is the transcript's spine, so
   * removing the mark would leave the bubble indented against nothing. The dot
   * holds the column while saying no name.
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
}
