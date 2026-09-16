import { SentMessage } from '../../../protocol/message.types';

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
  errorMessage?: string;
  /**
   * IS THIS AGENT WORKING RIGHT NOW?
   *
   * True between the `ReceivedMessage` that hands it a message and the
   * `ProcessedMessage` that says it is done. A field rather than a rendering
   * detail: it used to be readable ONLY as `itemStyle.borderColor === <red>`,
   * and the one surface that needed the fact — the tree, which the redesign
   * deleted — read it by sniffing exactly that string. Every consumer that
   * wanted liveness therefore had to know how the canvas paints it, and the
   * inspector's member list, which replaced the tree, gave up and declared
   * every present agent active.
   *
   * Optional because a node minted by `StartMessage` has done nothing yet;
   * absent reads as false everywhere.
   */
  thinking?: boolean;
}

export interface EdgeInterface {
  source: string;
  target: string;
}
