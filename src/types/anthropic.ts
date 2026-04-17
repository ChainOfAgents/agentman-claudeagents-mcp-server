/**
 * TypeScript interfaces for Anthropic Managed Agents API responses.
 *
 * These mirror the shapes documented at
 * https://platform.claude.com/docs/en/api/beta/{agents,environments,sessions}
 *
 * They're deliberately loose (many fields typed as `Record<string, unknown>`
 * or `unknown`) because the Managed Agents API is in beta and the shapes
 * may change. Prefer safe property access over strict destructuring.
 */

// =============================================================================
// Pagination envelope
// =============================================================================

/**
 * Standard list response envelope used by /v1/agents, /v1/sessions, etc.
 */
export interface ListResponse<T> {
  data: T[];
  next_page: string | null;
}

// =============================================================================
// Agent
// =============================================================================

export interface Agent {
  id: string;
  type: "agent";
  name: string;
  description?: string | null;
  model: string | ModelConfig;
  system?: string | null;
  tools?: unknown[];
  mcp_servers?: unknown[];
  skills?: unknown[];
  callable_agents?: CallableAgent[];
  metadata?: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
  version: number;
}

export interface ModelConfig {
  id: string;
  speed?: "standard" | "fast";
}

export interface CallableAgent {
  type: "agent";
  id: string;
  version: number;
}

// =============================================================================
// Environment
// =============================================================================

export interface Environment {
  id: string;
  type: "environment";
  name: string;
  description?: string | null;
  config: CloudConfig;
  metadata?: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
}

export interface CloudConfig {
  type: "cloud";
  networking: UnrestrictedNetwork | LimitedNetwork;
  packages?: PackageConfig;
}

export interface UnrestrictedNetwork {
  type: "unrestricted";
}

export interface LimitedNetwork {
  type: "limited";
  allow_mcp_servers: boolean;
  allow_package_managers: boolean;
  allowed_hosts: string[];
}

export interface PackageConfig {
  type?: "packages";
  apt?: string[];
  cargo?: string[];
  gem?: string[];
  go?: string[];
  npm?: string[];
  pip?: string[];
}

// =============================================================================
// Session
// =============================================================================

export interface Session {
  id: string;
  type: "session";
  status: SessionStatus;
  agent: Agent | { id: string; version: number };
  environment_id: string;
  title?: string | null;
  metadata?: Record<string, string>;
  resources?: unknown[];
  vault_ids?: string[];
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
  usage?: SessionUsage;
  stats?: SessionStats;
  outcome_evaluations?: OutcomeEvaluation[];
}

export type SessionStatus = "running" | "idle" | "rescheduling" | "terminated";

export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

export interface SessionStats {
  active_seconds: number;
  duration_seconds: number;
}

export interface OutcomeEvaluation {
  id: string;
  outcome_id: string;
  result: "satisfied" | "needs_revision" | "max_iterations_reached" | "failed" | "interrupted";
  explanation?: string;
  iteration: number;
  usage?: SessionUsage;
}

// =============================================================================
// Events (SSE stream and historical)
// =============================================================================

/**
 * Base event type — all events share these fields.
 */
export interface SessionEventBase {
  id: string;
  type: string;
  processed_at: string | null;
  session_thread_id?: string;
}

/**
 * The events API is a union of many discriminated types.
 * We use a loose shape because the set of types is large and evolving.
 */
export interface SessionEvent extends SessionEventBase {
  content?: unknown;
  name?: string;
  tool_use_id?: string;
  model_usage?: SessionUsage;
  error?: {
    type: string;
    message: string;
  };
  stop_reason?: string;
  [key: string]: unknown;
}

// =============================================================================
// Thread (multi-agent)
// =============================================================================

export interface SessionThread {
  id: string;
  session_id: string;
  agent_name: string;
  agent_id: string;
  status: SessionStatus;
  created_at: string;
}
