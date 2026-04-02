import { inject, Injectable } from '@angular/core';

import { BehaviorSubject, Subscription } from 'rxjs';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { environment } from '../../environments/environment';
import { AkgenticMessage } from '../models/message.types';
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
      // V2: use getEvents() for stopped teams -- minimal implementation (Story 1.3)
      const eventResponses: EventResponse[] =
        await this.apiService.getEvents(processId);
      messages = eventResponses
        .map((er: EventResponse) => er.event as AkgenticMessage)
        .filter(
          (evt: AkgenticMessage) =>
            evt &&
            evt.__model__ &&
            GRAPH_RELEVANT_MODELS.some((m) => evt.__model__.includes(m))
        );
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
        // V2: data is a PersistedEvent { team_id, sequence, event, timestamp }
        const event = data?.event;
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
      this.handleToolUpdate(inner);
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
