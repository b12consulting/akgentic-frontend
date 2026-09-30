import { CommonModule } from '@angular/common';
import {
  AfterViewChecked,
  afterNextRender,
  Component,
  ElementRef,
  inject,
  Injector,
  Input,
  OnDestroy,
  OnInit,
  signal,
  ViewChild,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

import { ApiService } from '../../../../platform/http/api.service';
import { ContextService } from '../../../../platform/context/context.service';
import { ActorAddress } from '../../../../protocol/message.types';
import { AkgentService } from '../../../../services/akgent.service';
import { CategoryService } from '../../../../services/category.service';
import { IngestionService } from '../../../../services/process/event/ingestion.service';
import { NodeInterface } from '../../../../services/process/models/types';
import {
  defaultRecipientName,
  isAddressableAgent,
} from '../../../../services/process/selectors/actor-kind';
import {
  AgentColours,
  agentColours,
  NO_AGENT_COLOURS,
} from '../../../../services/process/selectors/agent-colour';
import {
  ChatMessage,
  ENTRY_POINT_NAME,
} from '../../../../services/process/selectors/chat-message.model';
import { ChatService } from '../../../../services/process/selectors/chat.selector';
import { GraphDataService } from '../../../../services/process/selectors/graph.selector';
import {
  EMPTY_RUN_GRAPH,
  RunGraph,
  RunKey,
  RunMessage,
  runStatus,
} from '../../../../services/process/selectors/run-graph.selector';
import {
  isYourMessage,
  MessageNotes,
  Provenance,
  RunTreeItem,
  RunTreeService,
  RunTreeState,
  RunTreeView,
  trackRunTreeItem,
} from '../../../../services/process/selectors/run-tree-items';
import { TraceSummary, traceSummary } from '../../../../services/process/selectors/trace-summary';
import { seatRevealKeys } from '../../../../services/process/selectors/trace-tree';
import {
  Selectable,
  SelectionService,
} from '../../../../services/process/ui-state/selection.service';
import {
  RunSelectionOrigin,
  RunSelectionState,
} from '../../../../services/process/ui-state/run-selection';
import { TraceFoldState } from '../../../../services/process/ui-state/trace-fold-state';
import { AgentReaderService, AgentRef } from '../agent-reader.service';
import {
  ConversationModalComponent,
  ReaderSendRequest,
} from '../conversation/conversation-modal.component';
import { ChatMessageComponent } from '../message/chat-message.component';
import { ProcessUserInputComponent } from '../user-input/user-input.component';
import { SeatAnswer, SeatAnswerDialogComponent } from './seat-answer-dialog.component';
import { TraceCardComponent } from './trace-card.component';
import { TranscriptScroll } from './transcript-scroll';

/** How long an "in chat" flash stays on a bubble. */
const FLASH_MS = 1200;

/**
 * The run-tree transcript (Epic 55, ADR-037 §D3, §D4, §D8, §D10), behind the
 * header's *New view* switch and beside the untouched `ChatPanelComponent`.
 *
 * - Your messages sit where an agent picked them up; the ones no agent has
 *   taken up yet wait in a "Message(s) sent" tail at the bottom.
 * - Under each, one collapsed trace card per run it opened.
 * - Agent → you bubbles render as in the legacy view, plus a provenance link.
 * - No rule-3 or rule-4 rows: they live in the tree, where a waiting seat is
 *   answered through its node's Answer button.
 * - A provenance link, an absorbed-message note or a tree node SELECTS a run
 *   (`RunSelectionState`), which the inspector's Run tab shows.
 *
 * It reads the same process-scoped services as the legacy panel, so a switch
 * refetches nothing. Everything it shows is re-derived from them on each
 * emission; the only state that must outlive it — which cards and nodes are
 * open — is in the process-scoped `TraceFoldState`.
 */
@Component({
  selector: 'app-run-tree-panel',
  standalone: true,
  imports: [
    CommonModule,
    ChatMessageComponent,
    ConversationModalComponent,
    ProcessUserInputComponent,
    SeatAnswerDialogComponent,
    TraceCardComponent,
    TranslatePipe,
  ],
  templateUrl: './run-tree-panel.component.html',
  styleUrl: './run-tree-panel.component.scss',
})
export class RunTreePanelComponent implements OnInit, OnDestroy, AfterViewChecked {
  @Input() processId!: string;

  @ViewChild('scrollContainer', { static: false })
  private scrollContainer?: ElementRef<HTMLElement>;

  @ViewChild('spacer', { static: false })
  private spacerRef?: ElementRef<HTMLElement>;

  readonly chatService: ChatService = inject(ChatService);
  readonly folds: TraceFoldState = inject(TraceFoldState);
  private readonly runSelection: RunSelectionState = inject(RunSelectionState);
  private readonly injector: Injector = inject(Injector);
  private readonly runTree: RunTreeService = inject(RunTreeService);
  private readonly ingestionService: IngestionService = inject(IngestionService);
  private readonly contextService: ContextService = inject(ContextService);
  private readonly apiService: ApiService = inject(ApiService);
  private readonly selectionService: SelectionService = inject(SelectionService);
  private readonly akgentService: AkgentService = inject(AkgentService);
  private readonly graphDataService: GraphDataService = inject(GraphDataService);
  private readonly agentReader: AgentReaderService = inject(AgentReaderService);
  private readonly categoryService: CategoryService = inject(CategoryService);

  readonly loadingProcess$ = this.ingestionService.loadingProcess$;

  timeline: RunTreeItem[] = [];
  tail: ChatMessage[] = [];
  tailNotes: ReadonlyMap<string, MessageNotes> = new Map();
  cards = new Map<RunKey, TraceSummary>();
  graph: RunGraph = EMPTY_RUN_GRAPH;
  /** Inner id → envelope id of the timeline's bubbles, for the tree's
   *  `@Human` rows (a bubble's `data-message-id` is its envelope id). */
  bubbleIds: ReadonlyMap<string, string> = new Map();
  /** The bubble a `@Human` row is hovering, and the one flashing. */
  highlightedBubble: string | null = null;
  flashingBubble: string | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  /** The run node a provenance click flashes. A signal: it is set after
   *  render, where a plain field would wait for an unrelated tick. */
  readonly flashingRun = signal<RunKey | null>(null);
  private nodeFlashTimer: ReturnType<typeof setTimeout> | null = null;

  // --- answering a seat from the tree --------------------------------------
  answerVisible = false;
  answerSeat: ActorAddress | null = null;
  answerQuestion: RunMessage | null = null;
  /** The seat run the open dialog answers, so an answer that lands from
   *  elsewhere closes it. */
  private answerKey: RunKey | null = null;
  private view: RunTreeView = { timeline: [], tail: [], tailNotes: new Map() };
  /** Rule-6 markers the reader opened; re-applied to each emission's copies. */
  private expandedMarkers = new Set<string>();

  defaultRecipient: string | null = null;
  agentColours: AgentColours = NO_AGENT_COLOURS;

  // --- the sub-agent reader, hosted as in the legacy panel but fed the run
  // graph: its runs, triggers and request state come from `graph` (55-5) ------
  chatMessages: ChatMessage[] = [];
  readerVisible = false;
  readerAgents: NodeInterface[] = [];
  readerSelectedAgentId: string | null = null;
  readerCanSend = false;

  readonly scroll = new TranscriptScroll({
    container: () => this.scrollContainer?.nativeElement ?? null,
    spacer: () => this.spacerRef?.nativeElement ?? null,
    teamRunning: () => this.contextService.currentTeamRunning$.value,
  });

  private readonly subscriptions = new Subscription();

  ngOnInit(): void {
    this.subscribeRoster();
    this.subscribeReader();
    this.subscriptions.add(
      this.chatService.justSent$.subscribe(() =>
        this.scroll.armOnSend(this.latestYoursId()),
      ),
    );
    this.subscriptions.add(
      this.contextService.currentTeamRunning$.subscribe((running) => {
        this.readerCanSend = running;
        this.scroll.onRunningChange(running);
      }),
    );
    this.subscriptions.add(this.runTree.state$.subscribe((s) => this.onState(s)));
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    if (this.flashTimer !== null) clearTimeout(this.flashTimer);
    if (this.nodeFlashTimer !== null) clearTimeout(this.nodeFlashTimer);
  }

  ngAfterViewChecked(): void {
    this.scroll.afterViewChecked();
  }

  private subscribeRoster(): void {
    this.subscriptions.add(
      this.graphDataService.nodes$.subscribe((nodes) => {
        this.readerAgents = nodes.filter(isAddressableAgent);
        this.defaultRecipient = defaultRecipientName(nodes, ENTRY_POINT_NAME);
        this.agentColours = agentColours(nodes, this.categoryService.COLORS);
      }),
    );
    this.subscriptions.add(
      this.akgentService.selectedAkgent$.subscribe((akgent) => {
        this.readerSelectedAgentId = akgent?.agentId ?? null;
      }),
    );
  }

  private subscribeReader(): void {
    this.subscriptions.add(this.agentReader.open$.subscribe((a) => this.openReaderOn(a)));
    this.subscriptions.add(
      this.chatService.messages$.subscribe((m) => (this.chatMessages = m)),
    );
  }

  // ---------------------------------------------------------------------------
  // The view
  // ---------------------------------------------------------------------------

  private onState(state: RunTreeState): void {
    this.graph = state.graph;
    this.view = state.view;
    this.applyView();
    this.cards = this.buildCards(state);
    this.bubbleIds = this.buildBubbleIds(state.view);
    this.closeAnsweredDialog();
    this.scroll.onEmission(this.latestYoursId(), this.timeline.length + this.tail.length);
  }

  /** Re-apply the marker expand state onto COPIES: `chat$` is shared with the
   *  legacy panel, so an emitted `ChatMessage` is never mutated. */
  private applyView(): void {
    this.tail = this.view.tail;
    this.tailNotes = this.view.tailNotes;
    this.timeline = this.view.timeline.map((item) =>
      item.kind === 'message' &&
      item.data.rule === 6 &&
      this.expandedMarkers.has(item.data.id)
        ? { ...item, data: { ...item.data, collapsed: false } }
        : item,
    );
  }

  private buildCards(state: RunTreeState): Map<RunKey, TraceSummary> {
    const cards = new Map<RunKey, TraceSummary>();
    for (const item of state.view.timeline) {
      if (item.kind !== 'trace') continue;
      const summary = traceSummary(state.graph, item.rootKey);
      if (summary !== null) cards.set(item.rootKey, summary);
    }
    return cards;
  }

  private buildBubbleIds(view: RunTreeView): Map<string, string> {
    const ids = new Map<string, string>();
    for (const item of view.timeline) {
      if (item.kind === 'message') ids.set(item.data.message_id, item.data.id);
    }
    return ids;
  }

  /** The most recently SENT message of yours, over timeline and tail, by the
   *  "your message" predicate (never the `@Human` name). Envelope id. */
  private latestYoursId(): string | null {
    const candidates = [
      ...this.view.timeline.flatMap((item) => (item.kind === 'message' ? [item.data] : [])),
      ...this.view.tail,
    ].filter((m) => isYourMessage(m, this.graph));
    let latest: ChatMessage | null = null;
    for (const m of candidates) {
      if (latest === null || m.timestamp.getTime() >= latest.timestamp.getTime()) latest = m;
    }
    return latest?.id ?? null;
  }

  get hasContent(): boolean {
    return this.timeline.length > 0 || this.tail.length > 0;
  }

  trackItem(index: number, item: RunTreeItem): string {
    return trackRunTreeItem(index, item);
  }

  provenanceKey(p: Provenance): string {
    switch (p.trigger) {
      case 'yourMessage':
        return 'chat.runTree.provenance.yourMessage';
      case 'answer':
        return 'chat.runTree.provenance.answer';
      case 'reply':
        return 'chat.runTree.provenance.reply';
    }
  }

  runsKey(count: number): string {
    return count === 1 ? 'chat.runTree.runsOne' : 'chat.runTree.runsMany';
  }

  /** Every card open goes through here or a selection, so opening a card
   *  always reveals the path to its waiting seats (ADR-037 §D6). A card that
   *  folds away under the pointer takes its `@Human` rows' highlight with it:
   *  no `mouseleave` fires for a row that is no longer there. */
  toggleTrace(root: RunKey): void {
    this.highlightedBubble = null;
    this.folds.toggle(root, seatRevealKeys(this.graph, root));
  }

  /** The provenance link, the absorbed-message note and a tree node select a
   *  run: its card opens, its path expands, the inspector shows it (§D8, §D9). */
  selectRun(key: RunKey, origin: RunSelectionOrigin): void {
    this.runSelection.select(this.graph, key, origin);
  }

  /** The provenance link also brings the run's node into view and flashes it,
   *  once the card it just opened has rendered. Fail-open: no node, no scroll. */
  selectFromProvenance(key: RunKey): void {
    this.selectRun(key, 'provenance');
    this.flashNode(key);
  }

  flashNode(key: RunKey): void {
    afterNextRender(() => this.revealNode(key), { injector: this.injector });
  }

  private revealNode(key: RunKey): void {
    const el = this.scrollContainer?.nativeElement.querySelector<HTMLElement>(
      `[data-run-key="${CSS.escape(key)}"]`,
    );
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    if (this.nodeFlashTimer !== null) clearTimeout(this.nodeFlashTimer);
    this.flashingRun.set(key);
    this.nodeFlashTimer = setTimeout(() => {
      this.flashingRun.set(null);
      this.nodeFlashTimer = null;
    }, FLASH_MS);
  }

  // ---------------------------------------------------------------------------
  // The tree's outputs
  // ---------------------------------------------------------------------------

  /** A waiting seat's Answer button: the seat and its question. */
  onAnswer(key: RunKey): void {
    const run = this.graph.runs.get(key);
    const question = run ? this.graph.messages.get(run.message_id) : undefined;
    if (run === undefined || question === undefined) return;
    if (runStatus(this.graph, key) !== 'waiting') return;
    this.answerKey = key;
    this.answerSeat = run.agent;
    this.answerQuestion = question;
    this.answerVisible = true;
  }

  /** A seat answered from elsewhere (the legacy view, another tab) while its
   *  dialog is open: close it, so a second answer is never posted. */
  private closeAnsweredDialog(): void {
    if (!this.answerVisible || this.answerKey === null) return;
    if (runStatus(this.graph, this.answerKey) !== 'waiting') this.answerVisible = false;
  }

  /** Keyed by the question's inner id. Nothing is inserted: the node turns
   *  `answered` when the seat's reply arrives on the log. */
  onSeatAnswer(answer: SeatAnswer): void {
    this.answerVisible = false;
    this.apiService
      .processHumanInput(this.processId, answer.content, answer.messageId)
      .catch((err) => console.error('Failed to send human input:', err));
  }

  onAnswerVisibleChange(visible: boolean): void {
    this.answerVisible = visible;
  }

  onHumanRowHover(bubble: string | null): void {
    this.highlightedBubble = bubble;
  }

  /** Scroll the bubble into view and flash it. A programmatic scroll may end
   *  the send pin; the reader asked to move. */
  flashBubble(bubble: string): void {
    const el = this.scrollContainer?.nativeElement.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(bubble)}"]`,
    );
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    if (this.flashTimer !== null) clearTimeout(this.flashTimer);
    this.flashingBubble = bubble;
    this.flashTimer = setTimeout(() => {
      this.flashingBubble = null;
      this.flashTimer = null;
    }, FLASH_MS);
  }

  onToggleCollapse(chatMsg: ChatMessage): void {
    if (chatMsg.rule !== 6) return;
    if (chatMsg.collapsed) this.expandedMarkers.add(chatMsg.id);
    else this.expandedMarkers.delete(chatMsg.id);
    this.applyView();
  }

  // ---------------------------------------------------------------------------
  // The reader (as in the legacy panel)
  // ---------------------------------------------------------------------------

  onMessageSelected(chatMsg: ChatMessage): void {
    this.openReaderOn({ agentId: chatMsg.sender.agent_id, actorName: chatMsg.sender.name });
  }

  onAgentSelected(agent: AgentRef): void {
    this.openReaderOn(agent);
  }

  onReaderAgentSelected(agent: AgentRef): void {
    this.selectAgent(agent.agentId, agent.actorName);
  }

  onReaderVisibleChange(visible: boolean): void {
    this.readerVisible = visible;
  }

  /** The reader's composer: the existing send path, and deliberately NOT
   *  `emitJustSent` — that pins the main transcript. */
  onReaderSend(request: ReaderSendRequest): void {
    this.apiService
      .sendMessage(this.processId, request.content, request.actorName)
      .catch((err) => console.error('Failed to send message to agent:', err));
  }

  private openReaderOn(agent: AgentRef): void {
    this.selectAgent(agent.agentId, agent.actorName);
    this.readerVisible = true;
  }

  private selectAgent(agentId: string, actorName: string): void {
    const selectable: Selectable = { type: 'message', data: { name: agentId, actorName } };
    this.selectionService.handleSelection(selectable);
  }
}
