/** What the scroll model reads from its panel. Getters, because the elements
 *  come and go with the empty state. */
export interface ScrollHost {
  container(): HTMLElement | null;
  spacer(): HTMLElement | null;
  teamRunning(): boolean;
}

/** The status pill's key while following; two rules read it (label and icon). */
export const AUTO_SCROLLING_KEY = 'chat.autoScrolling';

/**
 * The chat's scroll model: ADR-016's anchor-on-send and follow-on-demand, with
 * the anchor amended for ADR-037 §D3. It is the only copy: the chat panel it
 * was first written for is gone (Epic 55).
 *
 * THE AMENDMENT. ADR-016 pins the echo once and then only resizes the spacer,
 * which works because the reply grows BELOW the anchor. Here your
 * message first sits in the not-yet-received tail, where the run it is queued
 * behind keeps growing ABOVE it, and at pick-up it is destroyed and re-created
 * in the timeline. So while the anchor is live it is RE-PINNED whenever its
 * element is a different node, or its `offsetTop` moved, since the last pin.
 * Once it has settled in the timeline the reply grows below, nothing moves, and
 * ADR-016's spacer-shrink resumes until the spacer is gone.
 *
 * Programmatic scrolls are instant under reduced motion and smooth otherwise;
 * a manual scroll ABOVE the pinned position cancels the anchor, which a pin's
 * own scroll never does.
 */
export class TranscriptScroll {
  /** Small top inset so the pinned message is not flush against the edge. */
  static readonly TOP_PAD = 8;

  /** Status-pill key above the input, or null when hidden. */
  indicatorLabel: string | null = null;

  private spacerHeight = 0;
  private following = false;
  private unseen = false;
  private prevCount = 0;
  private loaded = false;

  /** Envelope id of the message pinned to the top, while the anchor is live. */
  private anchorId: string | null = null;
  private anchorPinned = false;
  /** The node and `offsetTop` of the last pin: a change in either re-pins. */
  private pinnedEl: HTMLElement | null = null;
  private pinnedTop = 0;
  /** The `scrollTop` the last pin asked for. */
  private pinTarget = 0;

  private awaitingEcho = false;
  private sendBaselineId: string | null = null;

  private lastScrollHeight = 0;
  private lastScrollTop = 0;

  constructor(private readonly host: ScrollHost) {}

  /** A send from the main composer: arm the anchor for its echo. */
  armOnSend(latestYoursId: string | null): void {
    this.sendBaselineId = latestYoursId;
    this.awaitingEcho = true;
    this.following = false;
    this.anchorId = null;
    this.anchorPinned = false;
    this.unseen = false;
    this.indicatorLabel = null;
    this.clearSpacer();
  }

  /** A new view emission. `latestYoursId` is found with the "your message"
   *  predicate over timeline AND tail — never the `@Human` name. `messageCount`
   *  counts MESSAGE rows only (timeline messages plus tail bubbles): a trace
   *  card or a day row is not something new to read, and a pick-up moves a
   *  bubble without adding one, so neither raises "New messages". */
  onEmission(latestYoursId: string | null, messageCount: number): void {
    const grew = messageCount > this.prevCount;
    this.prevCount = messageCount;
    if (this.awaitingEcho && latestYoursId && latestYoursId !== this.sendBaselineId) {
      this.anchorId = latestYoursId;
      this.anchorPinned = false;
      this.awaitingEcho = false;
      this.following = false;
      this.unseen = false;
      this.indicatorLabel = null;
    }
    if (grew && this.loaded && !this.following) this.unseen = true;
    this.loaded = this.loaded || messageCount > 0;
  }

  /** Post-layout: pin, re-pin or resize; follow; refresh the pill. */
  afterViewChecked(): void {
    if (this.anchorId !== null) this.manageAnchor(this.anchorId);
    if (this.following && this.contentGrewSinceLastCheck()) this.scrollToBottom();
    if (this.computeIndicatorLabel() !== this.indicatorLabel) {
      queueMicrotask(() => this.updateIndicator());
    }
  }

  private manageAnchor(anchorId: string): void {
    const el = this.findMessageEl(anchorId);
    if (el === null || this.host.spacer() === null) return;
    // Wait for the spacer on the first pin: without it no room is reserved and
    // the scroll clamps short.
    const moved = el !== this.pinnedEl || el.offsetTop !== this.pinnedTop;
    if (!this.anchorPinned || moved) {
      this.pinToTop(el);
      this.anchorPinned = true;
      this.pinnedEl = el;
      this.pinnedTop = el.offsetTop;
      return;
    }
    // Settled: the reply grows below and the spacer shrinks by as much.
    this.reserveSpacer(el);
    if (this.spacerHeight === 0) this.anchorId = null;
  }

  /** Template `(scroll)`. A measurable upward move is the user's. */
  onScroll(): void {
    const c = this.host.container();
    if (!c) return;
    const movedUp = c.scrollTop < this.lastScrollTop - 2;
    this.lastScrollTop = c.scrollTop;
    if (this.anchorId !== null && movedUp && c.scrollTop < this.pinTarget - 2) {
      this.anchorId = null;
    }
    if (this.anchorId === null && !this.newestMessageBelowFold()) {
      this.following = true;
    } else if (this.following && movedUp) {
      this.following = false;
    }
    this.updateIndicator();
  }

  /** Pill click: jump to the bottom and follow. Cancels the anchor. */
  jumpToLatest(): void {
    this.following = true;
    this.unseen = false;
    this.indicatorLabel = AUTO_SCROLLING_KEY;
    this.anchorId = null;
    this.clearSpacer();
    this.scrollToBottom();
  }

  get indicatorIcon(): string {
    return this.indicatorLabel === AUTO_SCROLLING_KEY ? 'pi-sync' : 'pi-arrow-down';
  }

  /** Leave follow mode when the team stops: nothing is left to follow. */
  onRunningChange(running: boolean): void {
    if (!running) this.following = false;
    this.updateIndicator();
  }

  // -------------------------------------------------------------------------
  // Scroll primitives
  // -------------------------------------------------------------------------

  /** Reserve the spacer, then scroll the anchor's top to the viewport top.
   *  `offsetTop` is relative to `.chat-container`, which the anchor and the
   *  scroll container share, so the container's own `offsetTop` is removed. */
  private pinToTop(anchorEl: HTMLElement): void {
    const c = this.host.container();
    if (!c) return;
    this.reserveSpacer(anchorEl);
    const top = Math.max(
      0,
      anchorEl.offsetTop - (c.offsetTop ?? 0) - TranscriptScroll.TOP_PAD,
    );
    this.pinTarget = top;
    c.scrollTo({ top, behavior: this.scrollBehavior() });
  }

  private scrollToBottom(): void {
    const c = this.host.container();
    if (c) c.scrollTo({ top: c.scrollHeight, behavior: this.scrollBehavior() });
  }

  private scrollBehavior(): ScrollBehavior {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth';
  }

  /** Reserve just enough below the anchor that the pinned position is the
   *  bottom-most scroll. Real content below the anchor is
   *  `spacer.offsetTop - anchor.offsetTop`, the spacer being the last child. */
  private reserveSpacer(anchorEl: HTMLElement): void {
    const c = this.host.container();
    const spacer = this.host.spacer();
    if (!c || !spacer) {
      this.spacerHeight = 0;
      return;
    }
    const realBelow = spacer.offsetTop - anchorEl.offsetTop;
    const padBottom = parseFloat(getComputedStyle(c).paddingBottom) || 0;
    const reserve = c.clientHeight - realBelow - TranscriptScroll.TOP_PAD - padBottom;
    this.spacerHeight = Math.max(0, Math.min(c.clientHeight, reserve));
    spacer.style.minHeight = this.spacerHeight + 'px';
  }

  private clearSpacer(): void {
    this.spacerHeight = 0;
    const spacer = this.host.spacer();
    if (spacer) spacer.style.minHeight = '0px';
  }

  private findMessageEl(id: string): HTMLElement | null {
    return (
      this.host.container()?.querySelector<HTMLElement>('[data-message-id="' + id + '"]') ??
      null
    );
  }

  /** The end of the list (the spacer's position) is below the viewport. */
  private newestMessageBelowFold(): boolean {
    const c = this.host.container();
    const spacer = this.host.spacer();
    if (!c || !spacer) return false;
    const messagesBottom = spacer.offsetTop - (c.offsetTop ?? 0);
    return messagesBottom > c.scrollTop + c.clientHeight + 4;
  }

  private computeIndicatorLabel(belowFold = this.newestMessageBelowFold()): string | null {
    if (this.following && this.host.teamRunning()) return AUTO_SCROLLING_KEY;
    if (!belowFold) return null;
    return this.unseen ? 'chat.newMessages' : 'chat.messages';
  }

  private updateIndicator(): void {
    const belowFold = this.newestMessageBelowFold();
    if (!belowFold) this.unseen = false;
    this.indicatorLabel = this.computeIndicatorLabel(belowFold);
  }

  private contentGrewSinceLastCheck(): boolean {
    const c = this.host.container();
    if (!c) return false;
    const changed = c.scrollHeight !== this.lastScrollHeight;
    this.lastScrollHeight = c.scrollHeight;
    return changed;
  }
}
