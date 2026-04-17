/**
 * Tool registration entry point for agentman-claudeagents-mcp-server.
 *
 * This module wires up all tools across 7 category modules. It's called
 * once at server init from src/index.ts (stdio) and src/http-server.ts (HTTP).
 *
 * Tool catalog (33 tools in v0.1):
 *   Templates (2):         list_templates, get_template
 *   Agents (6):            list, get, list_versions, create, update, archive
 *   Environments (6):      list, get, create, update, archive, delete
 *   Sessions (6):          list, get, create, update, archive, delete
 *   Session events (5):    send_user_message, define_outcome, interrupt_session,
 *                          confirm_tool_use, respond_custom_tool
 *   Observation (3):       list_session_events, list_session_threads, get_thread_events
 *   Streaming (2):         wait_for_session_idle, stream_session_events
 *   Smart (3):             summarize_session, find_anomalies, run_task  ⭐ hero
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerAgentTools } from "./claudeagents/agents.js";
import { registerEnvironmentTools } from "./claudeagents/environments.js";
import { registerObservationTools } from "./claudeagents/observation.js";
import { registerSessionEventTools } from "./claudeagents/session-events.js";
import { registerSessionTools } from "./claudeagents/sessions.js";
import { registerSmartTools } from "./claudeagents/smart.js";
import { registerStreamingTools } from "./claudeagents/streaming.js";
import { registerTemplateTools } from "./claudeagents/templates.js";

/**
 * Register all claudeagents-mcp tools with the MCP server.
 *
 * @param server The McpServer instance
 * @param getAccessToken Function that returns the current Anthropic API key.
 *   In stdio mode, this is the static ANTHROPIC_API_KEY env var. In HTTP mode,
 *   it's the Bearer token from the current request.
 */
export function registerTools(
  server: McpServer,
  getAccessToken: () => string | undefined
): void {
  // Templates don't need auth (they're bundled with the package)
  registerTemplateTools(server);

  // Everything else hits the Anthropic API
  registerAgentTools(server, getAccessToken);
  registerEnvironmentTools(server, getAccessToken);
  registerSessionTools(server, getAccessToken);
  registerSessionEventTools(server, getAccessToken);
  registerObservationTools(server, getAccessToken);
  registerStreamingTools(server, getAccessToken);
  registerSmartTools(server, getAccessToken);
}
