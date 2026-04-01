import { inject, Injectable } from '@angular/core';

import { BehaviorSubject, Subscription, switchMap } from 'rxjs';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { environment } from '../../environments/environment';
import { AkgenticMessage } from '../models/message.types';

import { ApiService } from '../services/api.service';
import { ChatService } from './chat.service';
import { MessageService } from 'primeng/api';

interface KnowledgeGraphData {
  nodes: any[];
  edges: any[];
}

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
      // Fetch the contexts from the server
      const contexts = await this.apiService.getAgentContext(processId);
      Object.entries(contexts).forEach(([actor_id, data]) => {
        this.initDict(this.contextDict$, actor_id, []);
        this.contextDict$[actor_id].next(data.context);
      });

      // Fetch the states from the server
      const states = await this.apiService.getAkgentStates(processId);
      Object.entries(states).forEach(([actor_id, data]) => {
        const typedData = data as { schema: any; state: any };
        this.initDict(this.stateDict$, actor_id, null);
        this.stateDict$[actor_id].next({
          schema: typedData.schema,
          state: typedData.state,
        });
      });

      // Fetch the messages from the server (Comes from the DB, or context if no DB)
      messages = await this.apiService.getMessages(processId);
    }

    this.createAgentGraph$.next(messages);
    this.messages$.next(messages);
    this.subscribe = this.message$.subscribe((message) => {
      if (message) {
        this.messages$.next([...this.messages$.value, message]);
      }
    });

    await this.refreshKnowledgeGraph();

    // Subscribe to the webSocket to receive new messages
    const wsProtocol =
      window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    //remove http or https from the api url
    const api = environment.api.replace(/(^\w+:|^)\/\//, '');

    this.apiService
      .getWebSocketTicket()
      .pipe(
        switchMap((ticket) => {
          this.webSocket = webSocket(
            `${wsProtocol}${api}/ws/${this.processId}?ticket=${ticket}`
          );
          return this.webSocket;
        })
      )
      .subscribe({
        next: (data) => {
          if (data && data.type === 'error') {
            this.messageService.add({
              severity: 'error',
              summary: 'WebSocket Authentication Failed',
              detail:
                data.message || 'Failed to authenticate WebSocket connection',
              life: 5000,
            });
            return;
          }
          if (data && data.type === 'message') {
            if (this.paused) {
              this.messages.push(data.message);
              return;
            }
            this.message$.next(data.message);
          }
          if (data && data.type === 'llm_context') {
            this.initDict(this.contextDict$, data.agent_id, []);
            this.contextDict$[data.agent_id].next(data.context);
          }
          if (data && data.type === 'state') {
            this.initDict(this.stateDict$, data.agent_id, null);
            this.stateDict$[data.agent_id].next({
              schema: data.schema,
              state: data.state,
            });
          }
          if (data && data.type === 'tool_update') {
            this.handleToolUpdate(data);
          }
          setTimeout(() => {
            this.chatService.loadingProcess$.next(false);
          }, 250);
        },
        error: (err) => console.log(err),
        complete: () => console.log('webSocket - complete'),
      });
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
    if (payload?.tool !== 'knowledge_graph') {
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
