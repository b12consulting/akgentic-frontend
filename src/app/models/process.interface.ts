/**
 * @deprecated Use TeamContext from './team.interface' instead.
 * This file is kept temporarily for backward compatibility with components
 * that still reference ProcessContext (Story 1.2 will migrate them).
 */

import { TeamContext } from './team.interface';

/**
 * Backward-compatible alias for TeamContext.
 * Adds V1 fields (id, running, description, params) so that
 * un-migrated components continue to compile and work at runtime.
 * Story 1.2 will remove this file entirely.
 */
export interface ProcessContext extends TeamContext {
  /** @deprecated Use team_id */
  id: string;
  /** @deprecated Use isRunning(team) helper */
  running: boolean;
  /** @deprecated Removed in V2 */
  params: ProcessParams;
}

export type ProcessContextArray = ProcessContext[];

// Legacy stub -- no V2 equivalent
export interface ProcessParams {
  workspace: boolean;
  knowledge_graph: boolean;
}

export interface ActorAddress {
  __actor_address__: boolean;
  address: string;
  name: string;
  role: string;
  agent_id: string;
  squad_id?: string;
}
