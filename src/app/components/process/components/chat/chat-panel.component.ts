import { CommonModule } from '@angular/common';
import {
  AfterViewChecked,
  Component,
  ElementRef,
  HostListener,
  inject,
  Input,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { combineLatest, Subscription } from 'rxjs';

import { ChatMessage, ENTRY_POINT_NAME } from '../../selectors/chat-message.model';
import { ActorAddress } from '../../../../protocol/message.types';
import { ApiService } from '../../../../core/http/api.service';
import { ChatService, ThinkingState } from '../../selectors/chat.selector';
import { IngestionService } from '../../event/ingestion.service';
import { Selectable, SelectionService } from '../../ui-state/selection.service';
import {
  AnsweredRequest,
  ChatHumanModalComponent,
  HumanModalReply,
} from './chat-human-modal.component';
import { ChatMessageComponent } from './chat-message.component';
import { ChatThinkingComponent } from './chat-thinking.component';
import { ProcessUserInputComponent } from '../user-input/user-input.component';

/** Discriminated-union item rendered inline in the chat panel. */
export type DisplayItem =
  | { kind: 'message'; data: ChatMessage }
  | { kind: 'thinking'; data: ThinkingState };

@Component({
  selector: 'app-chat-panel',
  standalone: true,
  imports: [
    CommonModule,
    ChatMessageComponent,
    ChatThinkingComponent,
    ChatHumanModalComponent,
    ProcessUserInputComponent,
  ],
  templateUrl: './chat-panel.component.html',
  styleUrl: './chat-panel.component.scss',
})
export class ChatPanelComponent implements OnInit, OnDestroy, AfterViewChecked {
  @Input() processId!: string;

  @ViewChild('scrollContainer', { static: false })
  private scrollContainer!: ElementRef;

  chatService: ChatService = inject(ChatService);
  ingestionService: IngestionService = inject(IngestionService);
  selectionService: SelectionService = inject(SelectionService);
  apiService: ApiService = inject(ApiService);

  chatMessages: ChatMessage[] = [];
  thinkingStates: ThinkingState[] = [];
  displayItems: DisplayItem[] = [];
  // Epic 18 (ADR-015 §2): spinner state now lives on IngestionService.
  loadingProcess$ = this.ingestionService.loadingProcess$;

  // Modal state for Rule 3 notification dialog
  modalVisible = false;
  modalAgentPair: { sender: ActorAddress; recipient: ActorAddress } | null = null;
  modalPendingMessages: ChatMessage[] = [];
  modalAnsweredMessages: AnsweredRequest[] = [];

  private subscription!: Subscription;
  private lastScrollHeight = 0;
  // Story 4.4: hover-aware auto-scroll lock. `isHovered` short-circuits the
  // scroll in ngAfterViewChecked while the user's pointer is over the panel.
  // `owedScroll` is set ONLY from the messages$ / mount / anchor paths (a
  // programmatic scroll suppressed by hover) — never from ngAfterViewChecked
  // height changes — so collapse/expand toggles during hover do NOT queue a
  // spurious catch-up.
  private isHovered = false;
  // Story 19-2 (ADR-016 §Decision 4 item 4): typed hover owed-action. Records
  // WHICH programmatic scroll was deferred by the hover lock so `mouseleave`
  // replays the correct one (the boolean `pendingCatchUpScroll` is retired).
  // The `'follow-tail'` member is added in Story 19-3.
  private owedScroll: 'top-anchor' | 'mount-bottom' | null = null;
  private expandedMessageIds = new Set<string>();
  /** Story 4-8: per-bubble expansion state (mirrors expandedMessageIds
   *  pattern; persists across thinkingAgents$ re-emissions). */
  private thinkingExpanded = new Set<string>();
  selectedMessageId: string | null = null;
  private notificationSubscription!: Subscription;
  pendingNotifications: Set<string> = new Set();

  // ---------------------------------------------------------------------------
  // Story 19-1 (ADR-016) — top-anchor primitive.
  // `justSentKey` is the send-origin timestamp emitted by user-input on send;
  // `anchorMessageId` is the OUTER `ChatMessage.id` of the matched user message
  // (the `data-message-id` lookup key). `anchorScrollDone` latches the single
  // top-anchor per turn (AC #2). `spacerHeight` drives the trailing spacer that
  // reserves room to park the turn at top (AC #3). `lastAnchorOffsetTop` caches
  // the anchored element's own geometry to discriminate its own height changes
  // (re-pin, AC #5) from answer-below growth (must NOT move the view).
  // ---------------------------------------------------------------------------
  private justSentSubscription!: Subscription;
  private justSentKey: string | null = null;
  private anchorMessageId: string | null = null;
  private anchorScrollDone = false;
  spacerHeight = 0;
  private lastAnchorOffsetTop: number | null = null;
  /** Small top inset (px) so the parked message isn't flush to the edge —
   *  echoes the `.message-list` 0.5rem/1rem padding rhythm (ADR-016 §Decision 3). */
  private readonly anchorTopPadding = 8;

  // ---------------------------------------------------------------------------
  // Story 19-2 (ADR-016 §Decision 4) — explicit scroll-mode state machine.
  // `scrollMode` is the SINGLE source of truth for "what the viewport is
  // allowed to do", replacing the implicit `shouldScrollToBottom` boolean:
  //   - `idle`      : the view never moves on its own (no autoscroll).
  //   - `anchored`  : a turn is parked at top; turn-triggered growth fills the
  //                   space below the anchor without moving the scroll.
  //   - `following` : 19-3 placeholder — the transitions can target it but
  //                   NOTHING enters it in this story (tail/indicator are 19-3).
  // ---------------------------------------------------------------------------
  private scrollMode: 'idle' | 'anchored' | 'following' = 'idle';
  /** ADR-016 §Decision 7 — one-shot instant scroll-to-bottom on mount, latched
   *  so it never re-fires on subsequent emissions / view-checks / growth. */
  private hasDoneInitialScroll = false;
  /** ADR-016 §Decision 4 "critical" — set around every programmatic `scrollTop`/
   *  `scrollTo` write so the resulting `scroll` event is not mistaken for the
   *  user scrolling away. A smooth `scrollTo` dispatches `scroll` events across
   *  many animation frames (macrotasks) — long after a microtask checkpoint —
   *  so the flag is cleared on a TRAILING debounce: each programmatic-origin
   *  `scroll` re-arms the timer and the flag only drops once the events stop
   *  arriving (the animation has settled). This is the documented top regression
   *  risk (§Consequences): a microtask clear would close the window before the
   *  async `scroll` fired and the anchor would release itself on its own write. */
  private isProgrammaticScroll = false;
  /** Trailing-debounce handle that clears `isProgrammaticScroll` once the
   *  programmatic `scroll` events stop arriving. */
  private programmaticScrollTimer: ReturnType<typeof setTimeout> | null = null;
  /** ms of `scroll`-event silence after which a programmatic write is considered
   *  settled — comfortably outlasts the smooth-scroll animation's frame cadence
   *  while staying short enough that a genuine user scroll is not swallowed. */
  private readonly programmaticScrollSettleMs = 150;
  /** Reused near-bottom threshold (px) — the constant from the retired
   *  `checkShouldAutoScroll`. Drives anchor-release classification (and, in
   *  19-3, the indicator + follow-exit) so they stay consistent. */
  private readonly nearBottomThreshold = 100;

  ngOnInit(): void {
    this.notificationSubscription = this.chatService.pendingNotifications$.subscribe(
      (pending) => {
        this.pendingNotifications = pending;
        this.recomputeModalInputs();
      }
    );
    // Story 19-1 (AC #1/#2): a new just-sent signal starts a fresh turn —
    // record the send-origin key and reset the per-anchor latch so the next
    // matching emission can fire exactly one top-anchor.
    this.justSentSubscription = this.chatService.justSent$.subscribe((key) => {
      this.justSentKey = key;
      this.anchorMessageId = null;
      this.anchorScrollDone = false;
      this.lastAnchorOffsetTop = null;
      // AC #3: spacer is 0 until the new turn is actually anchored.
      this.spacerHeight = 0;
      // Story 19-2 (AC #3): re-anchor on send. The latch reset above is the
      // anchor's own bookkeeping; routing it through the state field makes the
      // transition read as `anchored/idle → (send) → anchored`. The actual
      // `anchored` set happens when `applyAnchorScroll` fires in
      // `maybeAnchorTurn()` once the matched element renders.
      this.scrollMode = 'idle';
    });
    // Story 4-8: merge chat messages + thinking states into a single sorted
    // displayItems array. Either stream re-triggers rebuild.
    // Story 6.4 (AC3): subscription migrated from the deleted
    // `messageService.messages$` onto `chatService.messages$` — classification
    // is owned by `chatFold` (Story 6.3); the component is a presenter.
    this.subscription = combineLatest([
      this.chatService.messages$,
      this.chatService.thinkingAgents$,
    ]).subscribe(([classified, thinkingStates]) => {
      const previousLength = this.chatMessages.length;
      // Preserve per-user expand state across re-emissions (Rule 3 / Rule 4).
      for (const chatMsg of classified) {
        if (
          (chatMsg.rule === 3 || chatMsg.rule === 4) &&
          this.expandedMessageIds.has(chatMsg.id)
        ) {
          chatMsg.collapsed = false;
        }
      }

      this.chatMessages = classified;
      this.thinkingStates = thinkingStates;
      this.displayItems = this.buildDisplayItems(classified, thinkingStates);
      // Story 19-1 (AC #2): resolve the anchor id from the first user-originated
      // message at/after the send time. Once resolved, the actual scroll runs
      // post-layout in ngAfterViewChecked (offsetTop must be read post-layout).
      this.resolveAnchorMessageId();
      // Story 19-2 (AC #6): if a new message arrived while the user is hovering
      // the panel, remember WHICH scroll is owed on mouseleave (typed). The
      // `mount-bottom` catch-up preserves the pre-existing "only catch up if
      // the user was near the bottom at arrival time" intent.
      if (this.isHovered && classified.length > previousLength) {
        this.recordOwedScrollDuringHover();
      }
      this.recomputeModalInputs();
    });
  }

  onToggleCollapse(chatMsg: ChatMessage): void {
    if (chatMsg.rule !== 3 && chatMsg.rule !== 4) return;
    chatMsg.collapsed = !chatMsg.collapsed;
    if (chatMsg.collapsed) {
      this.expandedMessageIds.delete(chatMsg.id);
    } else {
      this.expandedMessageIds.add(chatMsg.id);
    }
  }

  /**
   * Post-layout orchestrator (Story 19-2). Public method coordinates; private
   * helpers implement. Order: keep `lastScrollHeight` fresh → drive the anchor
   * (Story 19-1, AC #2/#5) and detect natural scroll-off release (AC #3) →
   * one-shot mount scroll (AC #4). NO default autoscroll — the legacy
   * per-emission bottom re-pin is retired (AC #1).
   */
  ngAfterViewChecked(): void {
    // Always evaluate hasContentChanged() so lastScrollHeight stays fresh —
    // even while hovered — otherwise a collapse/expand during hover would
    // leave a stale lastScrollHeight that spuriously fires a scroll later. The
    // return value no longer gates an autoscroll (AC #1) but keeps the
    // discrimination geometry current.
    this.hasContentChanged();
    // Story 19-1/19-2: the top-anchor runs once per turn (AC #2) and re-pins
    // only on the anchor element's own height change (AC #5); 19-2 also
    // releases to idle on natural scroll-off (AC #3) and sets `scrollMode`.
    this.maybeAnchorTurn();
    this.maybeMountScroll();
  }

  /**
   * AC #4 — one-shot INSTANT scroll-to-bottom on the first view-settle with a
   * laid-out, non-empty backlog. Latched by `hasDoneInitialScroll` so it never
   * re-fires. Anchor precedence: if a turn is already anchored (a send arrived
   * before mount settled), the anchor owns the first frame and the mount scroll
   * is skipped. After mount the panel stays `idle` (it does not start tailing).
   */
  private maybeMountScroll(): void {
    if (this.hasDoneInitialScroll || this.anchorMessageId !== null) return;
    if (!this.scrollContainer) return;
    const el = this.scrollContainer.nativeElement;
    if (el.scrollHeight <= 0) return; // not laid out yet — retry next pass
    this.hasDoneInitialScroll = true;
    if (this.isHovered) {
      // Story 4.4: defer the programmatic mount scroll until mouseleave.
      this.owedScroll = 'mount-bottom';
      return;
    }
    this.scrollToBottom();
  }

  onMouseEnter(): void {
    this.isHovered = true;
  }

  onMouseLeave(): void {
    this.isHovered = false;
    // Story 19-2 (AC #6): replay the typed owed scroll, then clear it.
    const owed = this.owedScroll;
    this.owedScroll = null;
    if (owed === 'top-anchor') {
      // Re-run the anchor scroll once layout settles. `maybeAnchorTurn()` is
      // idempotent (latched) so it re-pins via the resolved element.
      queueMicrotask(() => this.maybeAnchorTurn());
    } else if (owed === 'mount-bottom') {
      // queueMicrotask defers the scroll until after the current event-loop
      // tick so Angular can finish any change detection triggered by the
      // isHovered = false assignment before we read scrollHeight.
      queueMicrotask(() => this.scrollToBottom());
    }
  }

  /**
   * AC #6 — record WHICH programmatic scroll the hover lock deferred. A
   * `top-anchor` is owed whenever an active turn's anchor scroll is suppressed
   * by hover; a `mount-bottom` is owed for the deferred mount catch-up, gated
   * by the pre-existing "user was near the bottom at arrival" intent. The
   * `top-anchor` kind wins because parking the turn at top is the dominant
   * behavior (mirrors 19-1).
   */
  private recordOwedScrollDuringHover(): void {
    if (this.anchorMessageId !== null) {
      this.owedScroll = 'top-anchor';
      return;
    }
    if (this.isNearBottom()) {
      this.owedScroll = 'mount-bottom';
    }
  }

  /**
   * AC #3/#5 — `scroll` event handler bound via the template `(scroll)`
   * binding (Open Question 2: template binding chosen — smaller, testable
   * surface, no manual teardown). Programmatic writes (the anchor write, the
   * mount-bottom write) are ignored via `isProgrammaticScroll` (primary guard);
   * the near-bottom threshold is the secondary safety net. A GENUINE user
   * scroll that moves the position measurably above the near-bottom frame while
   * anchored releases the anchor to `idle`.
   */
  onScroll(): void {
    if (this.isProgrammaticScroll) {
      // Still settling a programmatic write: this `scroll` is one of the
      // animation's own frames. Re-arm the trailing debounce and ignore it —
      // do NOT classify it as a user exit (the anchor must not release itself).
      this.armProgrammaticScrollSettle();
      return;
    }
    if (this.scrollMode !== 'anchored') return;
    if (!this.isNearBottom()) {
      this.releaseAnchor();
    }
  }

  hasNotification(chatMsg: ChatMessage): boolean {
    // `pendingNotifications` holds inner `BaseMessage.id` values so that
    // `reply.parent_id` (also inner) clears the correct entry. Using the
    // outer envelope `chatMsg.id` here would never match, which was the
    // root cause of the "hand icon never disappears in chat" regression.
    return chatMsg.rule === 3 && this.pendingNotifications.has(chatMsg.message_id);
  }

  ngOnDestroy(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
    if (this.notificationSubscription) {
      this.notificationSubscription.unsubscribe();
    }
    if (this.justSentSubscription) {
      this.justSentSubscription.unsubscribe();
    }
    if (this.programmaticScrollTimer !== null) {
      clearTimeout(this.programmaticScrollTimer);
      this.programmaticScrollTimer = null;
    }
  }

  /**
   * Bubble click updates the visual selection highlight only. Routing is
   * driven exclusively by the Send-to dropdown in `user-input.component`
   * (see Story 4-11 / ADR-002 Revision Log 2026-04-13 — Decision 3
   * superseded). The former `chatService.setReplyContext(...)` call was
   * retired because it silently overrode the dropdown selection.
   */
  onBubbleClicked(chatMsg: ChatMessage): void {
    this.selectedMessageId = chatMsg.id;
  }

  /**
   * Open the Rule 3 modal with every still-unanswered message from the same
   * agent pair as the clicked bubble. Story 4-7 will replace the
   * last-message fallback (modal emits one reply per send) with per-request
   * reply inputs; this story only changes the notification tracking data
   * model from `Map<pairKey, ChatMessage[]>` to `Set<id>`.
   */
  onRule3Clicked(chatMsg: ChatMessage): void {
    const pair = { sender: chatMsg.sender, recipient: chatMsg.recipient };
    const pendingForPair = this.computePendingForPair(pair);
    const answeredForPair = this.computeAnsweredForPair(pair);

    if (pendingForPair.length === 0 && answeredForPair.length === 0) return;

    this.modalAgentPair = pair;
    this.modalPendingMessages = pendingForPair;
    this.modalAnsweredMessages = answeredForPair;
    this.modalVisible = true;
  }

  onModalReply(reply: HumanModalReply): void {
    // Modal stays open across replies (Story 4-7 AC3) — the next messages$
    // emission will reclassify pending/answered via recomputeModalInputs().
    this.apiService
      .processHumanInput(this.processId, reply.content, reply.messageId)
      .catch((err) => console.error('Failed to send human input:', err));
  }

  onModalVisibleChange(visible: boolean): void {
    this.modalVisible = visible;
    if (!visible) {
      this.modalAgentPair = null;
      this.modalPendingMessages = [];
      this.modalAnsweredMessages = [];
    }
  }

  /**
   * Re-derive modalPendingMessages and modalAnsweredMessages from the current
   * chatMessages + pendingNotifications when the modal is open. Auto-closes
   * the modal when both lists become empty (clean-exit condition).
   */
  private recomputeModalInputs(): void {
    if (this.modalAgentPair === null) return;
    const pendingForPair = this.computePendingForPair(this.modalAgentPair);
    const answeredForPair = this.computeAnsweredForPair(this.modalAgentPair);
    this.modalPendingMessages = pendingForPair;
    this.modalAnsweredMessages = answeredForPair;
    if (pendingForPair.length === 0 && answeredForPair.length === 0) {
      this.modalVisible = false;
      this.modalAgentPair = null;
    }
  }

  private computePendingForPair(
    pair: { sender: ActorAddress; recipient: ActorAddress },
  ): ChatMessage[] {
    return this.chatMessages.filter(
      (m) =>
        m.rule === 3 &&
        m.sender.name === pair.sender.name &&
        m.recipient.name === pair.recipient.name &&
        this.pendingNotifications.has(m.message_id),
    );
  }

  private computeAnsweredForPair(
    pair: { sender: ActorAddress; recipient: ActorAddress },
  ): AnsweredRequest[] {
    return this.chatMessages
      .filter(
        (m) =>
          m.rule === 3 &&
          m.sender.name === pair.sender.name &&
          m.recipient.name === pair.recipient.name &&
          !this.pendingNotifications.has(m.message_id),
      )
      .map((request) => {
        // Reply's `parent_id` is the original's INNER id (`message_id`),
        // not its outer envelope `id`.
        const reply =
          this.chatMessages.find((r) => r.parent_id === request.message_id) ?? null;
        return reply ? { request, reply } : null;
      })
      .filter((x): x is AnsweredRequest => x !== null);
  }

  onBackgroundClick(): void {
    this.selectedMessageId = null;
  }

  @HostListener('document:keydown.escape')
  onEscapePress(): void {
    this.selectedMessageId = null;
  }

  onMessageSelected(chatMsg: ChatMessage): void {
    const selectable: Selectable = {
      type: 'message',
      data: {
        name: chatMsg.sender.agent_id,
        actorName: chatMsg.sender.name,
      },
    };
    this.selectionService.handleSelection(selectable);
  }

  trackById(_index: number, item: ChatMessage): string {
    return item.id;
  }

  /**
   * Story 4-8: Stable tracking key for the mixed display list — preserves
   * DOM nodes across ephemeral → persistent transitions of a thinking
   * bubble (the `anchor_message_id` is constant across the finalise flip).
   */
  trackByDisplayItem(_: number, item: DisplayItem): string {
    return (
      item.kind +
      ':' +
      (item.kind === 'message' ? item.data.id : item.data.anchor_message_id)
    );
  }

  isThinkingExpanded(state: ThinkingState): boolean {
    return this.thinkingExpanded.has(state.anchor_message_id);
  }

  onToggleThinkingExpanded(anchorId: string): void {
    if (this.thinkingExpanded.has(anchorId)) {
      this.thinkingExpanded.delete(anchorId);
    } else {
      this.thinkingExpanded.add(anchorId);
    }
  }

  /**
   * Story 4-8 (AC5): Merge chat messages and thinking states into a single
   * chronologically sorted list.
   *   - Primary key: timestamp / start_time (ms).
   *   - Tie-break (same ms): message BEFORE thinking (so the triggering
   *     ReceivedMessage visually precedes its own bubble).
   */
  private buildDisplayItems(
    messages: ChatMessage[],
    thinking: ThinkingState[],
  ): DisplayItem[] {
    const items: DisplayItem[] = [];
    for (const m of messages) items.push({ kind: 'message', data: m });
    for (const t of thinking) items.push({ kind: 'thinking', data: t });
    items.sort((a, b) => {
      const ta =
        a.kind === 'message' ? a.data.timestamp.getTime() : a.data.start_time.getTime();
      const tb =
        b.kind === 'message' ? b.data.timestamp.getTime() : b.data.start_time.getTime();
      if (ta !== tb) return ta - tb;
      // Tie-break: messages before thinking bubbles.
      if (a.kind === b.kind) return 0;
      return a.kind === 'message' ? -1 : 1;
    });
    return items;
  }

  /**
   * Story 19-2 — distance (px) from the bottom of the scroll container. The
   * 100px near-bottom threshold from the retired `checkShouldAutoScroll` lives
   * in `isNearBottom()` below; both reuse this single geometry read.
   */
  private distanceFromBottom(): number {
    if (!this.scrollContainer) return 0;
    const el = this.scrollContainer.nativeElement;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }

  /**
   * Story 19-2 (AC #3/#5) — true when the viewport is within the reused
   * near-bottom threshold of the bottom. Anchor-release, the mount catch-up
   * intent, and (19-3) the indicator/follow-exit all key off this constant so
   * they stay consistent.
   */
  private isNearBottom(): boolean {
    if (!this.scrollContainer) return true;
    return this.distanceFromBottom() <= this.nearBottomThreshold;
  }

  private hasContentChanged(): boolean {
    if (!this.scrollContainer) return false;
    const currentScrollHeight = this.scrollContainer.nativeElement.scrollHeight;
    const changed = currentScrollHeight !== this.lastScrollHeight;
    this.lastScrollHeight = currentScrollHeight;
    return changed;
  }

  /**
   * Instant jump to the bottom. Used by the one-shot mount scroll (AC #4) and,
   * in 19-3, by follow mode. The write is PROGRAMMATIC: it is bracketed by the
   * `isProgrammaticScroll` guard (AC #5) so the resulting `scroll` event is not
   * mistaken for a user scroll-away. Mount is instant regardless (FR8).
   */
  private scrollToBottom(): void {
    if (!this.scrollContainer) return;
    try {
      const el = this.scrollContainer.nativeElement;
      this.beginProgrammaticScroll();
      el.scrollTop = el.scrollHeight;
    } catch (err) {
      console.warn('Could not scroll to bottom:', err);
    }
  }

  /**
   * AC #5 — open the programmatic-scroll guard window around a `scrollTop`/
   * `scrollTo` write. A smooth `scrollTo` dispatches its `scroll` events across
   * many later animation frames, so the flag is NOT cleared on a microtask
   * (that window closes before the first async `scroll` fires, letting the
   * anchor release itself — §Consequences top regression risk). Instead the
   * flag is cleared on a TRAILING debounce: it is armed here and re-armed by
   * every programmatic-origin `scroll` in `onScroll`, dropping only once the
   * events stop (the animation has settled). A genuine user scroll arriving
   * after settle is then classified normally.
   */
  private beginProgrammaticScroll(): void {
    this.isProgrammaticScroll = true;
    this.armProgrammaticScrollSettle();
  }

  /** Re-arm the trailing debounce that clears the programmatic-scroll guard
   *  once `scroll` events stop arriving (the programmatic animation settled). */
  private armProgrammaticScrollSettle(): void {
    if (this.programmaticScrollTimer !== null) {
      clearTimeout(this.programmaticScrollTimer);
    }
    this.programmaticScrollTimer = setTimeout(() => {
      this.isProgrammaticScroll = false;
      this.programmaticScrollTimer = null;
    }, this.programmaticScrollSettleMs);
  }

  /**
   * AC #3 — release the anchor to `idle`: stop re-pinning and clear ALL anchor
   * bookkeeping so `maybeAnchorTurn()` no longer fires until the next send.
   */
  private releaseAnchor(): void {
    this.scrollMode = 'idle';
    this.anchorMessageId = null;
    this.anchorScrollDone = false;
    this.lastAnchorOffsetTop = null;
    this.spacerHeight = 0;
  }

  // ---------------------------------------------------------------------------
  // Story 19-1 (ADR-016) — top-anchor primitive helpers.
  // ---------------------------------------------------------------------------

  /**
   * AC #2 — resolve `anchorMessageId` (the OUTER `ChatMessage.id`, the
   * `data-message-id` lookup key) from the first user-originated (Rule 1)
   * message at/after the send time. Keyed by send ORIGIN (timestamp), not by
   * content (ADR-016 §Decision 1). No-op once an id is resolved for the turn so
   * frame-batched / de-dup re-emits do not re-resolve. The actual scroll is
   * latched separately by `anchorScrollDone` in `maybeAnchorTurn()`.
   */
  private resolveAnchorMessageId(): void {
    if (this.justSentKey === null || this.anchorMessageId !== null) return;
    const sentAt = Number(this.justSentKey);
    const match = this.chatMessages.find(
      (m) =>
        m.sender.name === ENTRY_POINT_NAME &&
        (Number.isNaN(sentAt) || m.timestamp.getTime() >= sentAt),
    );
    if (match) {
      this.anchorMessageId = match.id;
    }
  }

  /**
   * AC #2/#4/#5 (19-1) + AC #3 (19-2) — drive the top-anchor from the
   * post-layout pass. Fires the single first-anchor once the matched element
   * renders (sets `scrollMode = 'anchored'`), then re-pins only on the anchored
   * element's OWN offset change (late layout). 19-2 additions: a hover defer
   * (owe a `top-anchor` replay), and natural scroll-off release to `idle` when
   * answer growth pushes the anchor above the fold. Downstream answer growth
   * does not move the view (it does not change the anchor's `offsetTop`).
   */
  private maybeAnchorTurn(): void {
    if (this.anchorMessageId === null) return;
    const anchorEl = this.resolveAnchorElement(this.anchorMessageId);
    if (!anchorEl) return; // not yet rendered — retry on next emission (AC #4)

    // Story 4.4 hover lock: defer the programmatic anchor write until mouseleave.
    if (this.isHovered) {
      this.owedScroll = 'top-anchor';
      return;
    }

    if (!this.anchorScrollDone) {
      this.applyAnchorScroll(anchorEl);
      this.anchorScrollDone = true;
      this.scrollMode = 'anchored';
      return;
    }
    // Natural scroll-off (AC #3): the answer grew tall enough that the anchored
    // message scrolled above the top of the viewport — release, do NOT re-pin.
    // Disjoint from the AC #5 re-pin below (Open Question 4): scroll-off is
    // "anchor above the fold" (offsetTop − scrollTop < topPadding), re-pin is
    // "anchor's OWN offsetTop changed".
    if (this.isAnchorScrolledOff(anchorEl)) {
      this.releaseAnchor();
      return;
    }
    // Anchor stability (AC #5): re-pin only on the anchor's OWN geometry change.
    if (anchorEl.offsetTop !== this.lastAnchorOffsetTop) {
      this.applyAnchorScroll(anchorEl);
    }
  }

  /**
   * AC #3 (Open Question 4) — true when the anchored element has scrolled above
   * the top of the viewport (answer growth pushed it off the fold). Uses the
   * cached geometry vs the live container `scrollTop`, not a brittle per-frame
   * heuristic. Distinct from the AC #5 re-pin (which keys off the anchor's OWN
   * `offsetTop` change, not its position relative to the scroll position).
   */
  private isAnchorScrolledOff(anchorEl: HTMLElement): boolean {
    if (!this.scrollContainer) return false;
    const container = this.scrollContainer.nativeElement;
    return anchorEl.offsetTop - container.scrollTop < this.anchorTopPadding;
  }

  /** Resolve the anchored element inside the scroll container via
   *  `data-message-id` (ADR-016 §Decision 3). Returns null if not yet rendered. */
  private resolveAnchorElement(id: string): HTMLElement | null {
    if (!this.scrollContainer) return null;
    return (
      this.scrollContainer.nativeElement.querySelector(
        '[data-message-id="' + id + '"]',
      ) ?? null
    );
  }

  /**
   * AC #3/#4/#6 — single post-layout read→write task. Reads `offsetTop` /
   * `clientHeight` / `scrollHeight` first, derives the trailing spacer height,
   * writes the spacer height, then writes `scrollTop` (smooth unless reduced
   * motion is requested). No read after the writes — no thrash (NFR2).
   */
  private applyAnchorScroll(anchorEl: HTMLElement): void {
    if (!this.scrollContainer) return;
    const container = this.scrollContainer.nativeElement;
    // --- reads (post-layout) ---
    const offsetTop: number = anchorEl.offsetTop;
    // --- derive + write spacer (AC #3) ---
    this.recomputeSpacerHeight(offsetTop);
    // --- write scroll (AC #4/#6) ---
    // Story 19-2 (AC #5): the anchor write is PROGRAMMATIC — bracket it so the
    // resulting `scroll` event does not release the anchor as a user-exit.
    const top = offsetTop - this.anchorTopPadding;
    this.beginProgrammaticScroll();
    container.scrollTo({
      top,
      behavior: this.prefersReducedMotion() ? 'auto' : 'smooth',
    });
    this.lastAnchorOffsetTop = offsetTop;
  }

  /**
   * AC #3 — trailing spacer height. `0` when no turn is anchored; otherwise
   * `max(0, min(viewport, viewport − heightOfAnchoredTurnAndBelow))`, where the
   * "below" term is measured against the spacer-excluded content
   * (`scrollHeight − spacerHeight − offsetTop`, Open Question 3 option (a)).
   * Collapses toward `0` as the answer fills the viewport; capped at the
   * viewport so short conversations show no dead space.
   */
  private recomputeSpacerHeight(anchorOffsetTop: number): void {
    if (!this.scrollContainer || this.anchorMessageId === null) {
      this.spacerHeight = 0;
      return;
    }
    const container = this.scrollContainer.nativeElement;
    const viewportHeight: number = container.clientHeight;
    const scrollHeight: number = container.scrollHeight;
    const heightOfAnchoredTurnAndBelow =
      scrollHeight - this.spacerHeight - anchorOffsetTop;
    this.spacerHeight = Math.max(
      0,
      Math.min(viewportHeight, viewportHeight - heightOfAnchoredTurnAndBelow),
    );
  }

  /** AC #6 — true when the user has requested reduced motion. */
  private prefersReducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
}
