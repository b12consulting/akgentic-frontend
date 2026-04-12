import { inject, Injectable } from '@angular/core';

import { BehaviorSubject, Subscription } from 'rxjs';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { environment } from '../../environments/environment';
import { buildPreview } from '../models/chat-message.model';
import {
  AkgenticMessage,
  isReceivedMessage,
  isSentMessage,
} from '../models/message.types';
import { EventResponse } from '../models/team.interface';

import { ApiService } from '../services/api.service';
import { ChatService } from './chat.service';
import { MessageService } from 'primeng/api';

interface KnowledgeGraphData {
  nodes: any[];
  edges: any[];
}

/** V2 message types that feed the agent graph and message list. */
const GRAPH_RELEVANT_MODELS = [
  'StartMessage',
  'SentMessage',
  'StopMessage',
  'ErrorMessage',
  'UserMessage',
  'ResultMessage',
];

@Injectable()
export class ActorMessageService {
  apiService: ApiService = inject(ApiService);
  chatService: ChatService = inject(ChatService);
  messageService: MessageService = inject(MessageService);

  webSocket: WebSocketSubject<any> = new WebSocketSubject({ url: '' });

  createAgentGraph$: BehaviorSubject<AkgenticMessage[] | null> =
    new BehaviorSubject<AkgenticMessage[] | null>(null);

  messages$: BehaviorSubject<AkgenticMessage[]> = new BehaviorSubject<
    AkgenticMessage[]
  >([]);
  message$: BehaviorSubject<AkgenticMessage | null> =
    new BehaviorSubject<AkgenticMessage | null>(null);

  contextDict$: { [key: string]: BehaviorSubject<any[]> } = {};
  stateDict$: { [key: string]: BehaviorSubject<any> } = {};

  knowledgeGraph$: BehaviorSubject<KnowledgeGraphData> =
    new BehaviorSubject<KnowledgeGraphData>({ nodes: [], edges: [] });
  knowledgeGraphLoading$: BehaviorSubject<boolean> =
    new BehaviorSubject<boolean>(false);

  subscribe: Subscription = new Subscription();
  paused: boolean = false;
  messages: AkgenticMessage[] = [];

  processId: string = '';

  private knowledgeGraphSnapshot: KnowledgeGraphData = {
    nodes: [],
    edges: [],
  };

  async init(processId: string, running: boolean): Promise<void> {
    this.processId = processId;
    let messages: AkgenticMessage[] = [];

    this.chatService.loadingProcess$.next(true);

    if (!running) {
      // V2: use getEvents() for stopped teams
      const eventResponses: EventResponse[] =
        await this.apiService.getEvents(processId);

      // Reconstruct stateDict$ and contextDict$ from persisted events.
      // Events arrive sorted by sequence (ascending) from the API.
      // - StateChangedMessage: later events overwrite earlier (keeps latest state per agent)
      // - LlmMessageEvent: messages appended in chronological order (ordered context)
      const latestStates: { [agentId: string]: any } = {};
      const contextArrays: { [agentId: string]: any[] } = {};

      for (const er of eventResponses) {
        const evt = er.event;
        if (!evt || !evt.__model__) continue;

        if (evt.__model__.includes('StateChangedMessage')) {
          const agentId = evt.sender?.agent_id;
          if (agentId) {
            latestStates[agentId] = evt.state;
          }
        } else if (evt.__model__.includes('EventMessage')) {
          const inner = evt.event;
          if (inner?.__model__?.includes('LlmMessageEvent')) {
            const agentId = evt.sender?.agent_id;
            if (agentId && inner.message) {
              if (!contextArrays[agentId]) contextArrays[agentId] = [];
              contextArrays[agentId].push(inner.message);
            }
          }
        }
      }

      for (const [agentId, state] of Object.entries(latestStates)) {
        this.initDict(this.stateDict$, agentId, null);
        this.stateDict$[agentId].next({ schema: {}, state });
      }

      for (const [agentId, msgs] of Object.entries(contextArrays)) {
        this.initDict(this.contextDict$, agentId, []);
        this.contextDict$[agentId].next(msgs);
      }

      // Filter graph-relevant messages for the agent graph and message list
      messages = eventResponses
        .map((er: EventResponse) => er.event as AkgenticMessage)
        .filter(
          (evt: AkgenticMessage) =>
            evt &&
            evt.__model__ &&
            GRAPH_RELEVANT_MODELS.some((m) => evt.__model__.includes(m))
        );

      // Story 4-8: seed thinking-bubble lifecycle from replayed envelopes AND
      // from replayed EventMessage (tool events) in order, so the final
      // `thinkingAgents$` state is consistent with the live path (AC10).
      for (const er of eventResponses) {
        const evt = er.event as AkgenticMessage | undefined;
        if (!evt || !evt.__model__) continue;
        if (evt.__model__.includes('EventMessage')) {
          this.dispatchToolEventToThinking(evt as any);
          continue;
        }
        this.applyThinkingLifecycle(evt);
      }
    }

    this.createAgentGraph$.next(messages);
    this.messages$.next(messages);
    this.subscribe = this.message$.subscribe((message) => {
      if (message) {
        this.messages$.next([...this.messages$.value, message]);
      }
    });

    // V2: connect directly -- no ticket needed (community tier, AC8)
    const wsProtocol =
      window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    const api = environment.api.replace(/(^\w+:|^)\/\//, '');

    this.webSocket = webSocket(`${wsProtocol}${api}/ws/${this.processId}`);
    this.chatService.loadingProcess$.next(false);

    this.webSocket.subscribe({
      next: (data: any) => {
        // V2: data is a raw Message with __model__ discriminator
        const event = data;
        if (!event || !event.__model__) return;

        if (event.__model__.includes('StateChangedMessage')) {
          const agentId = event.sender?.agent_id;
          if (agentId) {
            this.initDict(this.stateDict$, agentId, null);
            this.stateDict$[agentId].next({
              schema: {},
              state: event.state,
            });
          }
        } else if (event.__model__.includes('EventMessage')) {
          this.handleEventMessage(event);
        } else if (event.__model__.includes('ErrorMessage')) {
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: event.exception_value,
            life: 5000,
          });
          this.message$.next(event);
        } else {
          // Story 4-8: observe raw envelopes for thinking-bubble lifecycle.
          this.applyThinkingLifecycle(event as AkgenticMessage);
          // All other messages: forward to message$ for graph + message list
          if (this.paused) {
            this.messages.push(event);
            return;
          }
          this.message$.next(event);
        }
      },
      error: (err: any) => {
        console.error('WebSocket error:', err);
        this.messageService.add({
          severity: 'error',
          summary: 'Connection Error',
          detail: 'WebSocket connection failed. Real-time updates unavailable.',
          life: 5000,
        });
      },
      complete: () => console.log('webSocket - complete'),
    });
  }

  /**
   * Handle V2 EventMessage: delegates to LlmMessageEvent or ToolCallEvent handlers.
   */
  private handleEventMessage(event: any): void {
    const inner = event.event;
    if (inner?.__model__?.includes('LlmMessageEvent')) {
      const agentId = event.sender?.agent_id;
      if (agentId) {
        this.initDict(this.contextDict$, agentId, []);
        const current = this.contextDict$[agentId].getValue();
        this.contextDict$[agentId].next([...current, inner.message]);
      }
    } else if (inner?.__model__?.includes('ToolCallEvent')) {
      // Legacy knowledge_graph snapshot path — preserved unchanged (ADR-004).
      this.handleToolUpdate(inner);
    }
    // Story 4-8: route tool events into ChatService for the thinking bubble.
    this.dispatchToolEventToThinking(event);
  }

  /**
   * Story 4-8: Convert an EventMessage carrying a ToolCallEvent or
   * ToolReturnEvent into ChatService.appendToolCall / markToolDone. Unknown
   * inner __model__ values are silently ignored (no regression — matches
   * existing behaviour).
   */
  private dispatchToolEventToThinking(event: any): void {
    const inner = event?.event;
    const agentId = event?.sender?.agent_id;
    if (!inner || !agentId) return;
    if (inner.__model__?.includes('ToolCallEvent')) {
      this.chatService.appendToolCall(agentId, {
        tool_call_id: inner.tool_call_id,
        tool_name: inner.tool_name,
        arguments_preview: buildPreview(inner.arguments, 60),
        done: false,
      });
    } else if (inner.__model__?.includes('ToolReturnEvent')) {
      this.chatService.markToolDone(agentId, inner.tool_call_id);
    }
  }

  /**
   * Story 4-8 (AC3): Single dispatch point for thinking-bubble lifecycle.
   * Called from BOTH the live WebSocket branch and the replay-seeding loop
   * so live-vs-replay parity (AC10) is guaranteed by construction.
   */
  private applyThinkingLifecycle(msg: AkgenticMessage): void {
    if (isReceivedMessage(msg)) {
      this.chatService.beginThinking({
        agent_id: msg.sender.agent_id,
        agent_name: msg.sender.name,
        start_time: new Date(msg.timestamp),
        anchor_message_id: msg.message.id,
      });
      return;
    }
    if (isSentMessage(msg) && msg.sender.role !== 'ActorSystem') {
      this.chatService.finaliseOrDiscard(msg.sender.agent_id);
    }
  }

  backwardClicked() {
    this.messages = [...this.messages$.value, ...this.messages];
    this.messages$.next([]);
    this.createAgentGraph$.next(null);
  }

  backClicked() {
    const currentMessages = this.messages$.value;
    if (currentMessages.length > 0) {
      const lastMessage = currentMessages[currentMessages.length - 1];
      this.messages.unshift(lastMessage);
      this.messages$.next(currentMessages.slice(0, -1));
      this.createAgentGraph$.next(null);
      this.createAgentGraph$.next(this.messages$.value);
    }
  }

  pauseClicked() {
    this.paused = true;
  }

  playClicked() {
    this.paused = false;
    this.forwardClicked();
  }

  nextClicked() {
    const msg = this.messages.shift();
    if (msg) {
      this.message$.next(msg);
    }
  }

  forwardClicked() {
    while (this.messages.length > 0) {
      this.nextClicked();
    }
  }

  controlStatus() {
    return [
      this.messages$.value.length + this.messages.length,
      this.messages$.value.length,
    ];
  }

  initDict(
    dict: { [key: string]: BehaviorSubject<any[]> },
    key: string,
    defaultValue: any
  ) {
    if (dict[key]) return;
    dict[key] = new BehaviorSubject<any>(defaultValue);
  }

  async refreshKnowledgeGraph(): Promise<void> {
    if (!this.processId) return;
    this.knowledgeGraphLoading$.next(true);
    try {
      const graph = await this.apiService.getKnowledgeGraphData(this.processId);
      this.knowledgeGraphSnapshot = this.normalizeKnowledgeGraph(graph);
      this.knowledgeGraph$.next(this.knowledgeGraphSnapshot);
    } catch (error) {
      console.error('Error loading knowledge graph data:', error);
      this.knowledgeGraph$.next({ nodes: [], edges: [] });
    } finally {
      this.knowledgeGraphLoading$.next(false);
    }
  }

  private handleToolUpdate(payload: any): void {
    if (payload?.tool !== 'knowledge_graph' && payload?.tool_name !== 'knowledge_graph') {
      return;
    }

    if (payload.data) {
      this.knowledgeGraphSnapshot = this.normalizeKnowledgeGraph(payload.data);
    }

    this.knowledgeGraph$.next(this.knowledgeGraphSnapshot);
  }

  private normalizeKnowledgeGraph(data: any): KnowledgeGraphData {
    if (!data) {
      return { nodes: [], edges: [] };
    }

    if ('nodes' in data && 'edges' in data) {
      return {
        nodes: Array.isArray(data.nodes) ? data.nodes : [],
        edges: Array.isArray(data.edges) ? data.edges : [],
      };
    }

    if ('entities' in data || 'relations' in data) {
      return {
        nodes: Array.isArray(data.entities) ? data.entities : [],
        edges: Array.isArray(data.relations) ? data.relations : [],
      };
    }

    return { nodes: [], edges: [] };
  }

  ngOnDestroy() {
    this.subscribe.unsubscribe();
    this.webSocket.unsubscribe();
  }
}
