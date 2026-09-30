import { AkgenticMessage } from '../app/core/protocol/message.types';
import {
  ASSISTANT,
  EXPERT,
  handled,
  HUMAN,
  MANAGER,
  processed,
  received,
  sent,
  SUPPORT,
  toolCall,
  toolReturn,
} from './run-log-builders';

/**
 * The mockup cases of Epic 55 as logs, for the run-tree specs (the fold's own
 * spec keeps its copies). Each is the log a real team would emit, built with
 * `run-log-builders.ts`.
 */

/** Case 2 — fan-out, replies queued; @Manager runs three times and @Expert's
 *  reply triggers a run that sends nothing. */
export const CASE_2: AkgenticMessage[] = [
  sent('U1', HUMAN, MANAGER, null, 1),
  received('U1', MANAGER, 2),
  sent('De', MANAGER, EXPERT, 'U1', 3),
  sent('Da', MANAGER, ASSISTANT, 'U1', 4),
  processed('U1', MANAGER, 5),
  received('De', EXPERT, 6),
  received('Da', ASSISTANT, 7),
  sent('Re', EXPERT, MANAGER, 'De', 8),
  processed('De', EXPERT, 9),
  sent('Ra', ASSISTANT, MANAGER, 'Da', 10),
  processed('Da', ASSISTANT, 11),
  received('Re', MANAGER, 12),
  processed('Re', MANAGER, 13),
  received('Ra', MANAGER, 14),
  sent('A', MANAGER, HUMAN, 'Ra', 15),
  processed('Ra', MANAGER, 16),
];

/** Case 3 — fan-in: @Manager's run on @Assistant's reply takes in @Expert's. */
export const CASE_3: AkgenticMessage[] = [
  sent('U1', HUMAN, MANAGER, null, 1),
  received('U1', MANAGER, 2),
  sent('De', MANAGER, EXPERT, 'U1', 3),
  sent('Da', MANAGER, ASSISTANT, 'U1', 4),
  processed('U1', MANAGER, 5),
  received('De', EXPERT, 6),
  received('Da', ASSISTANT, 7),
  sent('Ra', ASSISTANT, MANAGER, 'Da', 8),
  processed('Da', ASSISTANT, 9),
  received('Ra', MANAGER, 10),
  toolCall('t1', 'search', MANAGER, 'Ra', 11),
  sent('Re', EXPERT, MANAGER, 'De', 12),
  processed('De', EXPERT, 13),
  toolReturn('t1', 'search', MANAGER, 'Ra', 14),
  toolCall('t2', 'read_mailbox', MANAGER, 'Ra', 15),
  handled('Re', MANAGER, 'Ra', 16),
  toolReturn('t2', 'read_mailbox', MANAGER, 'Ra', 17),
  sent('A', MANAGER, HUMAN, 'Ra', 18),
  processed('Ra', MANAGER, 19),
];

/** Case 4 — @Manager asks you; your reply opens a trace of its own. */
export const CASE_4: AkgenticMessage[] = [
  sent('U1', HUMAN, MANAGER, null, 1),
  received('U1', MANAGER, 2),
  sent('Q', MANAGER, HUMAN, 'U1', 3),
  processed('U1', MANAGER, 4),
  received('Q', HUMAN, 5),
  processed('Q', HUMAN, 6),
  sent('U2', HUMAN, MANAGER, 'Q', 7),
  received('U2', MANAGER, 8),
  sent('A', MANAGER, HUMAN, 'U2', 9),
  processed('U2', MANAGER, 10),
  received('A', HUMAN, 11),
  processed('A', HUMAN, 12),
];

/** Case 5, before the seat answers — a delegation chain, a waiting human seat
 *  and a failed `workspace_read`. */
export const CASE_5_PREFIX: AkgenticMessage[] = [
  sent('U1', HUMAN, MANAGER, null, 1),
  received('U1', MANAGER, 2),
  sent('D1', MANAGER, EXPERT, 'U1', 3),
  sent('S', MANAGER, SUPPORT, 'U1', 4),
  processed('U1', MANAGER, 5),
  received('S', SUPPORT, 6),
  processed('S', SUPPORT, 7),
  received('D1', EXPERT, 8),
  sent('D2', EXPERT, ASSISTANT, 'D1', 9),
  processed('D1', EXPERT, 10),
  received('D2', ASSISTANT, 11),
  toolCall('r1', 'workspace_read', ASSISTANT, 'D2', 12),
  toolReturn('r1', 'workspace_read', ASSISTANT, 'D2', 13, false),
  toolCall('l1', 'workspace_list', ASSISTANT, 'D2', 14),
  toolReturn('l1', 'workspace_list', ASSISTANT, 'D2', 15),
  toolCall('r2', 'workspace_read', ASSISTANT, 'D2', 16),
  toolReturn('r2', 'workspace_read', ASSISTANT, 'D2', 17),
  sent('C', ASSISTANT, EXPERT, 'D2', 18),
  processed('D2', ASSISTANT, 19),
  received('C', EXPERT, 20),
  toolCall('w1', 'workspace_write', EXPERT, 'C', 21),
  toolReturn('w1', 'workspace_write', EXPERT, 'C', 22),
  sent('B', EXPERT, MANAGER, 'C', 23),
  processed('C', EXPERT, 24),
  received('B', MANAGER, 25),
  toolCall('m1', 'plan', MANAGER, 'B', 26),
  toolReturn('m1', 'plan', MANAGER, 'B', 27),
  processed('B', MANAGER, 28),
];

/** The seat's answer to case 5's question, and what it triggers. */
export const CASE_5_ANSWER: AkgenticMessage[] = [
  sent('Sa', SUPPORT, MANAGER, 'S', 29),
  received('Sa', MANAGER, 30),
  sent('A', MANAGER, HUMAN, 'Sa', 31),
  processed('Sa', MANAGER, 32),
];

export const CASE_5: AkgenticMessage[] = [...CASE_5_PREFIX, ...CASE_5_ANSWER];

/** Case 5 variant — the waiting seat sits two levels below the root, under
 *  @Expert; @Manager's other branch (@Assistant, with a child of its own) is
 *  not on the seat's path. */
export const CASE_5_VARIANT: AkgenticMessage[] = [
  sent('U1', HUMAN, MANAGER, null, 1),
  received('U1', MANAGER, 2),
  sent('D1', MANAGER, EXPERT, 'U1', 3),
  sent('D2', MANAGER, ASSISTANT, 'U1', 4),
  processed('U1', MANAGER, 5),
  received('D1', EXPERT, 6),
  sent('S', EXPERT, SUPPORT, 'D1', 7),
  processed('D1', EXPERT, 8),
  received('S', SUPPORT, 9),
  processed('S', SUPPORT, 10),
  received('D2', ASSISTANT, 11),
  sent('X', ASSISTANT, EXPERT, 'D2', 12),
  processed('D2', ASSISTANT, 13),
  received('X', EXPERT, 14),
  processed('X', EXPERT, 15),
];

/** Case 6 — you add a message mid-run and @Manager takes it in. */
export const CASE_6: AkgenticMessage[] = [
  sent('U1', HUMAN, MANAGER, null, 1),
  received('U1', MANAGER, 2),
  toolCall('t1', 'search', MANAGER, 'U1', 3),
  sent('U2', HUMAN, MANAGER, null, 4),
  handled('U2', MANAGER, 'U1', 5),
  toolReturn('t1', 'search', MANAGER, 'U1', 6),
  sent('A', MANAGER, HUMAN, 'U1', 7),
  processed('U1', MANAGER, 8),
];

/** Case 7, before the follow-ups are picked up: @Expert's delegation is still
 *  unread. */
export const CASE_7_QUEUED: AkgenticMessage[] = [
  sent('U1', HUMAN, MANAGER, null, 1),
  received('U1', MANAGER, 2),
  sent('D', MANAGER, EXPERT, 'U1', 3),
  processed('U1', MANAGER, 4),
];

export const CASE_7: AkgenticMessage[] = [
  ...CASE_7_QUEUED,
  received('D', EXPERT, 5),
  sent('Re', EXPERT, MANAGER, 'D', 6),
  processed('D', EXPERT, 7),
  received('Re', MANAGER, 8),
  toolCall('t1', 'search', MANAGER, 'Re', 9),
  toolReturn('t1', 'search', MANAGER, 'Re', 12),
  sent('A1', MANAGER, HUMAN, 'Re', 13),
  processed('Re', MANAGER, 14),
];
