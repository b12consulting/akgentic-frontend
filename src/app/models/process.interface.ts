// libs/akgentic/akgentic/core/akgent_address_impl.py -> serialize()
export interface ActorAddress {
  __actor_address__: boolean;
  address: string;
  name: string;
  role: string;
  agent_id: string;
  squad_id?: string;
}

// backend/server/models/process.py
export interface ProcessContext {
  id: string;
  name: string;
  description?: string | null;
  created_at: string;
  orchestrator: ActorAddress;
  user_proxy: ActorAddress | null;
  user_proxy_class: string | null;
  user_id: string;
  user_email: string;
  config_name: string;
  params: ProcessParams;
  running: boolean; // Added dynamically in /processes endpoint only
}

export interface ProcessParams {
  workspace: boolean;
  knowledge_graph: boolean;
}

export type ProcessContextArray = ProcessContext[];
