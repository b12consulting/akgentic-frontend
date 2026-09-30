import { CommonModule } from '@angular/common';
import {
  AfterViewChecked,
  Component,
  ElementRef,
  inject,
  Input,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

import { ApiService } from '../../../../platform/http/api.service';
import { ContextService } from '../../../../platform/context/context.service';
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
import { ChatService, ThinkingState } from '../../../../services/process/selectors/chat.selector';
import { GraphDataService } from '../../../../services/process/selectors/graph.selector';
import {
  EMPTY_RUN_GRAPH,
  RunGraph,
  RunKey,
  runStatus,
  traceRootOf,
} from '../../../../services/process/selectors/run-graph.selector';
import {
  isYourMessage,
  Provenance,
  RunTreeItem,
  RunTreeService,
  RunTreeState,
  RunTreeView,
  trackRunTreeItem,
} from '../../../../services/process/selectors/run-tree-items';
import {
  traceRuns,
  TraceSummary,
  traceSummary,
} from '../../../../services/process/selectors/trace-summary';
import {
  Selectable,
  SelectionService,
} from '../../../../services/process/ui-state/selection.service';
import { TraceFoldState } from '../../../../services/process/ui-state/trace-fold-state';
import { AgentReaderService, AgentRef } from '../agent-reader.service';
import {
  ConversationModalComponent,
  ReaderSendRequest,
} from '../conversation/conversation-modal.component';
import { ChatMessageComponent } from '../message/chat-message.component';
import { ProcessUserInputComponent } from '../user-input/user-input.component';
import { TraceCardComponent, TraceRunRow } from './trace-card.component';
import { TranscriptScroll } from './transcript-scroll';

/** What a trace item renders: its header and its provisional body rows. */
interface TraceCardModel {
  summary: TraceSummary;
  rows: TraceRunRow[];
}

/**
 * The run-tree transcript (Epic 55, ADR-037 §D3, §D4, §D8, §D10), behind the
 * header's *New view* switch and beside the untouched `ChatPanelComponent`.
 *
 * - Your messages sit where an agent picked them up; the ones no agent has
 *   taken up yet wait in a "Message(s) sent" tail at the bottom.
 * - Under each, one collapsed trace card per run it opened.
 * - Agent → you bubbles render as in the legacy view, plus a provenance link.
 * - No rule-3 or rule-4 rows: they live in the tree (55-3).
 *
 * It reads the same process-scoped services as the legacy panel, so a switch
 * refetches nothing. Everything it shows is re-derived from them on each
 * emission; the only state that must outlive it — which cards are open — is in
 * the process-scoped `TraceFoldState`.
 */
@Component({
  selector: 'app-run-tree-panel',
  standalone: true,
  imports: [
    CommonModule,
    ChatMessageComponent,
    ConversationModalComponent,
    ProcessUserInputComponent,
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
  cards = new Map<RunKey, TraceCardModel>();
  private graph: RunGraph = EMPTY_RUN_GRAPH;
  private view: RunTreeView = { timeline: [], tail: [] };
  /** Rule-6 markers the reader opened; re-applied to each emission's copies. */
  private expandedMarkers = new Set<string>();

  defaultRecipient: string | null = null;
  agentColours: AgentColours = NO_AGENT_COLOURS;

  // --- the sub-agent reader, hosted as in the legacy panel (55-5 moves its
  // source to the graph) ------------------------------------------------------
  chatMessages: ChatMessage[] = [];
  thinkingStates: ThinkingState[] = [];
  pendingNotifications: Set<string> = new Set();
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
    this.subscriptions.add(
      this.chatService.thinkingAgents$.subscribe((t) => (this.thinkingStates = t)),
    );
    this.subscriptions.add(
      this.chatService.pendingNotifications$.subscribe((p) => (this.pendingNotifications = p)),
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
    this.scroll.onEmission(this.latestYoursId(), this.timeline.length + this.tail.length);
  }

  /** Re-apply the marker expand state onto COPIES: `chat$` is shared with the
   *  legacy panel, so an emitted `ChatMessage` is never mutated. */
  private applyView(): void {
    this.tail = this.view.tail;
    this.timeline = this.view.timeline.map((item) =>
      item.kind === 'message' &&
      item.data.rule === 6 &&
      this.expandedMarkers.has(item.data.id)
        ? { ...item, data: { ...item.data, collapsed: false } }
        : item,
    );
  }

  private buildCards(state: RunTreeState): Map<RunKey, TraceCardModel> {
    const cards = new Map<RunKey, TraceCardModel>();
    for (const item of state.view.timeline) {
      if (item.kind !== 'trace') continue;
      const summary = traceSummary(state.graph, item.rootKey);
      if (summary === null) continue;
      const rows = traceRuns(state.graph, item.rootKey).map((run) => ({
        key: run.key,
        agent: run.agent,
        status: runStatus(state.graph, run.key),
      }));
      cards.set(item.rootKey, { summary, rows });
    }
    return cards;
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

  /** The absorbed-message and provenance links open the card that holds the
   *  run; they never close one. 55-4 turns them into a selection. */
  openTraceOf(run: RunKey): void {
    this.folds.open(traceRootOf(this.graph, run));
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
