import { inject, Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { CategoryService } from './category.service';
import { ActorMessageService } from './message.service';
import {
  AkgenticMessage,
  StopMessage,
  ErrorMessage,
  SentMessage,
  ReceivedMessage,
  ProcessedMessage,
  isSentMessage,
  isStartMessage,
  isStopMessage,
  isErrorMessage,
  isReceivedMessage,
  isProcessedMessage,
} from '../models/message.types';
import { EdgeInterface, NodeInterface } from '../models/types';

export const HUMAN_ROLE = 'Human';
export const ORCHESTRATOR_CLASS = 'Orchestrator';

/**
 * Helper class to build nodes/edges from messages.
 */
class GraphBuilder {
  message: AkgenticMessage;
  constructor(msg: AkgenticMessage) {
    this.message = msg;
  }

  get source() {
    return this.message.sender?.agent_id || '';
  }

  get target() {
    if (isSentMessage(this.message)) {
      return this.message.recipient?.agent_id || '';
    }
    throw new Error('Message does not have a recipient');
  }

  buildEdge(): EdgeInterface {
    if (!this.message.__model__.includes('SentMessage')) {
      throw new Error('Invalid message type for edge');
    }
    return {
      source: this.source,
      target: this.target,
    };
  }

  isNewEdge(edges: any[]) {
    return !edges.find(
      (e) => e.source === this.source && e.target === this.target
    );
  }

  buildNode(): NodeInterface {
    if (!isStartMessage(this.message)) {
      throw new Error('Invalid message type for node');
    }
    const userProxy = this.message.sender.role === HUMAN_ROLE;
    return {
      name: this.message.sender.agent_id,
      role: this.message.sender.role,
      actorName: this.message.sender.name,
      parentId: this.message.parent.agent_id,
      squadId: this.message.sender.squad_id || '',
      userMessage: this.message.sender.user_message || false,
      symbol: userProxy ? 'circle' : 'roundRect',
      category: 0,
    };
  }

  setHumanRequest(nodes: NodeInterface[]) {
    if (!isSentMessage(this.message)) return;
    if (!this.message.recipient.role.includes(HUMAN_ROLE)) return;
    if (this.message.message.display_type !== 'other') return;

    const senderId = this.message.sender?.agent_id;
    const node = nodes.find((n) => n.name === senderId);

    if (node) {
      node.humanRequests = node.humanRequests || [];
      node.humanRequests.push(this.message);
    }
  }

  unSetHumanRequest(nodes: NodeInterface[]) {
    if (!isSentMessage(this.message)) return;
    if (this.message.sender?.role !== HUMAN_ROLE) return;
    const recipientId = this.message.recipient?.agent_id;
    const parentMessageId = this.message.message.parent_id;
    const node = nodes.find((n) => n.name === recipientId);

    if (node?.humanRequests) {
      node.humanRequests = node.humanRequests.filter(
        (m: SentMessage) => m.message.id !== parentMessageId
      );
    }
  }
}

/**
 * GraphDataService centralizes the logic for:
 *  - Subscribing to incoming messages
 *  - Converting messages into nodes, edges, and categories
 *  - Exposing the data as Observables
 */
@Injectable()
export class GraphDataService {
  private readonly nodesSubject$ = new BehaviorSubject<NodeInterface[]>([]);
  private readonly edgesSubject$ = new BehaviorSubject<EdgeInterface[]>([]);
  private readonly squadSubject$ = new BehaviorSubject<any[]>([]);

  nodes$ = this.nodesSubject$.asObservable();
  edges$ = this.edgesSubject$.asObservable();
  categories$ = this.squadSubject$.asObservable();
  isLoading$: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);

  set isLoading(value: boolean) {
    this.isLoading$.next(value);
  }

  private nodes: NodeInterface[] = [];
  private edges: EdgeInterface[] = [];
  private squad: any[] = [];

  messageService: ActorMessageService = inject(ActorMessageService);
  categoryService: CategoryService = inject(CategoryService);

  constructor() {
    // Subscribe to full-chart rebuild events.
    this.messageService.createAgentGraph$.subscribe((messages) => {
      this.createAkgentGraph(messages);
    });
    // Subscribe to incremental message updates.
    this.messageService.message$.subscribe((message) => {
      this.updateAkgentGraph(message);
    });
  }

  /**
   * Create a full chart from a list of messages.
   * If messages is null or empty, use dummy data.
   */
  private createAkgentGraph(messages: AkgenticMessage[] | null) {
    if (!messages) {
      this.nodes = [];
      this.edges = [];
      this.squad = [];
      this.emitAll(); // still emit empty arrays
      return;
    }

    // Clear previous data.
    this.nodes = [];
    this.edges = [];
    this.squad = [];

    // Determine stopped nodes.
    const stoppedNodeIds = messages
      .filter((m) => isStopMessage(m))
      .map((m) => m.sender.agent_id);

    // Build nodes from StartMessage, excluding stopped nodes.
    this.nodes = messages
      .filter((m) => isStartMessage(m))
      .filter((m) => !m.sender.role.includes(ORCHESTRATOR_CLASS))
      .filter((m) => !stoppedNodeIds.includes(m.sender.agent_id))
      .map((m) => new GraphBuilder(m).buildNode());

    // Build category mapping based on squadId.
    const squadIds = [...new Set(this.nodes.map((n) => n.squadId))];
    const squadDict = squadIds.reduce((acc, squadId, index) => {
      acc[squadId] = index;
      return acc;
    }, {} as { [key: string]: number });

    // Set node categories.
    this.nodes.forEach((n) => {
      n.category = squadDict[n.squadId];
    });

    // Update CategoryService.
    this.categoryService.nodes = this.nodes;
    this.categoryService.squadDict = squadDict;

    // Build categories array.
    this.squad = squadIds.map((squadId, i) => ({
      name: `Team ${i}`,
      squadId: squadId,
      itemStyle: { color: this.categoryService.COLORS[i] },
    }));

    // Select all categories by default.
    this.categoryService.setSelectedCategory(this.squad.map(() => true));

    // Build edges from SentMessage.
    this.edges = [];
    messages
      .filter((m) => isSentMessage(m))
      .forEach((m) => {
        const builder = new GraphBuilder(m);
        if (builder.isNewEdge(this.edges)) {
          this.edges.push(builder.buildEdge());
        }
        builder.setHumanRequest(this.nodes);
        builder.unSetHumanRequest(this.nodes);
      });

    // Mark crashed nodes (ErrorMessage).
    messages
      .filter((m) => isErrorMessage(m))
      .forEach((m) => {
        const senderId = m.sender?.agent_id;
        const node = this.nodes.find((n) => n.name === senderId);
        if (node) {
          node.itemStyle = node.itemStyle || {};
          node.itemStyle.color = 'darkred';
        }
      });

    this.emitAll();
  }

  /**
   * Update the chart with a single incoming message.
   * If msg is null, do nothing.
   */
  private updateAkgentGraph(msg: AkgenticMessage | null) {
    if (!msg) {
      console.warn('updateChart received null message.');
      return;
    }
    if (isStartMessage(msg) && msg.sender.role == ORCHESTRATOR_CLASS) {
      return; // Skip orchestrator nodes
    }

    const builder = new GraphBuilder(msg);
    const selectedSquad = this.categoryService.getSelectedCategory();

    switch (msg.__model__.split('.').pop()) {
      case 'StartMessage':
        this.handleStartMessage(builder, selectedSquad);
        break;
      case 'SentMessage':
        this.handleSentMessage(builder);
        break;
      case 'ReceivedMessage':
        if (isReceivedMessage(msg)) {
          this.handleReceivedMessage(msg);
        }
        break;
      case 'ProcessedMessage':
        if (isProcessedMessage(msg)) {
          this.handleProcessedMessage(msg);
        }
        break;
      case 'StopMessage':
        if (isStopMessage(msg)) {
          this.handleStopMessage(msg);
        }
        break;
      case 'ErrorMessage':
        if (isErrorMessage(msg)) {
          this.handleErrorMessage(msg);
        }
        break;
    }
    this.emitAll();
  }

  private handleStartMessage(
    builder: GraphBuilder,
    selectedSquad: boolean[] | null
  ) {
    const node = builder.buildNode();
    this.nodes.push(node);
    const existingCat = this.squad.find((c) => c.squadId === node.squadId);
    if (existingCat && node.squadId) {
      node.category = this.categoryService.squadDict[node.squadId];
    } else if (node.squadId) {
      const newIndex = this.squad.length;
      node.category = newIndex;
      this.squad.push({
        name: `Team ${newIndex}`,
        squadId: node.squadId,
        itemStyle: { color: this.categoryService.COLORS[newIndex] },
      });
      this.categoryService.squadDict[node.squadId] = newIndex;
      if (selectedSquad) {
        selectedSquad.push(true);
        this.categoryService.setSelectedCategory(selectedSquad);
      }
    }
  }

  private handleSentMessage(builder: GraphBuilder) {
    if (builder.isNewEdge(this.edges)) {
      this.edges.push(builder.buildEdge());
    }
    builder.setHumanRequest(this.nodes);
    builder.unSetHumanRequest(this.nodes);
  }

  private handleReceivedMessage(msg: ReceivedMessage) {
    const node = this.nodes.find((n) => n.name === msg.sender?.agent_id);
    if (node) {
      node.itemStyle = node.itemStyle || {};
      node.itemStyle.borderColor = 'darkred';
      node.itemStyle.borderWidth = 3;
    }
  }

  private handleProcessedMessage(msg: ProcessedMessage) {
    const node = this.nodes.find((n) => n.name === msg.sender?.agent_id);
    if (node?.itemStyle) {
      delete node.itemStyle.borderColor;
      delete node.itemStyle.borderWidth;
    }
  }

  private handleStopMessage(msg: StopMessage) {
    const idx = this.nodes.findIndex((n) => n.name === msg.sender?.agent_id);
    if (idx !== -1) {
      this.nodes.splice(idx, 1);
    }
  }

  private handleErrorMessage(msg: ErrorMessage) {
    const node = this.nodes.find((n) => n.name === msg.sender?.agent_id);
    if (node) {
      node.itemStyle = node.itemStyle || {};
      node.itemStyle.color = 'darkred';
    }
  }

  private emitAll() {
    this.nodesSubject$.next(this.nodes);
    this.edgesSubject$.next(this.edges);
    this.squadSubject$.next(this.squad);
  }
}
