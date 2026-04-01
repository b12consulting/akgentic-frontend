import { SentMessage } from './message.types';

export interface Message {
  id: string;
  content: string;
  sender: 'human' | 'ai';
  type: 'question' | 'final' | 'intermediate';
  timestamp: Date;
  agent_name: string;
  agent_id: string;
  human_id?: string;
  human_requests?: SentMessage[];
  alreadyAnswered?: boolean;
  send_to?: string;
  run_id?: string;
}

export interface ChatMessageInterface {
  name: string;
  actorName: string;
  humanRequests?: SentMessage[];
}

export interface NodeInterface {
  name: string;
  role: string;
  actorName: string;
  parentId: string;
  squadId: string;
  symbol: string;
  category: number;
  userMessage: boolean;
  itemStyle?: any;
  humanRequests?: SentMessage[];
  alreadyAnswered?: boolean;
}

export interface EdgeInterface {
  source: string;
  target: string;
}
