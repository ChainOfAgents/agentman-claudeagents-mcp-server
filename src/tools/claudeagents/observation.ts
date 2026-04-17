/**
 * Session observation tools (non-streaming).
 *
 *   - claudeagent_list_session_events
 *   - claudeagent_list_session_threads
 *   - claudeagent_get_thread_events
 *
 * The streaming observation tools (wait_for_session_idle, stream_session_events)
 * are in streaming.ts because they require MCP progress notification handling
 * and the SSE apiStream helper.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  AnthropicPaginationSchema,
  ResponseFormatSchema,
  SessionIdSchema,
  ThreadIdSchema,
} from "../../schemas/index.js";
import {
  apiGet,
  AuthExpiredError,
  formatApiError,
} from "../../services/api-client.js";
import { ListResponse, SessionEvent, SessionThread } from "../../types/anthropic.js";
import { logger } from "../../utils/logger.js";
import {
  createErrorResponse,
  createSuccessResponse,
  registerTool,
  requireAuth,
} from "../shared.js";

// =============================================================================
// Input schemas
// =============================================================================

const ListSessionEventsInputSchema = z.object({
  session_id: SessionIdSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe("Max events to return (1-500, default: 100)"),
  page: z.string().optional(),
  order: z.enum(["asc", "desc"]).default("asc"),
  type: z
    .string()
    .optional()
    .describe(
      "Filter to specific event types (comma-separated). " +
      "E.g., 'agent.message' for just the agent's responses, " +
      "'agent.message,agent.tool_use' for responses + tool calls. " +
      "Useful to skip large tool_result events that consume the response budget."
    ),
  exclude_type: z
    .string()
    .optional()
    .describe(
      "Exclude specific event types (comma-separated). " +
      "E.g., 'agent.tool_result,agent.thinking' to skip large web fetches and thinking blocks."
    ),
  response_format: ResponseFormatSchema,
});

const ListSessionThreadsInputSchema = z.object({
  session_id: SessionIdSchema,
  response_format: ResponseFormatSchema,
});

const GetThreadEventsInputSchema = AnthropicPaginationSchema.extend({
  session_id: SessionIdSchema,
  thread_id: ThreadIdSchema,
  response_format: ResponseFormatSchema,
});

// =============================================================================
// Registration
// =============================================================================

export function registerObservationTools(
  server: McpServer,
  getAccessToken: () => string | undefined
): void {
  // ===========================================================================
  // claudeagent_list_session_events
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_list_session_events",
    description: `Retrieve the full event history of a session.

Events include user messages, agent messages, tool calls, tool results, thinking, session status changes, and errors. This is the primary debugging tool — use it to understand what happened in a session after it finished.

For live streaming of events as they arrive (rather than batch retrieval), use claudeagent_stream_session_events.

Args:
  - session_id (string, required)
  - limit (number, 1-500, default: 100)
  - page (string): Pagination cursor from a previous response
  - order ('asc' | 'desc', default: 'asc'): 'asc' shows oldest first (natural timeline), 'desc' shows most recent first
  - type (string, optional): Comma-separated event types to include. E.g., 'agent.message' or 'agent.message,agent.tool_use'. Filters client-side after fetching.
  - exclude_type (string, optional): Comma-separated event types to exclude. E.g., 'agent.tool_result,agent.thinking' to skip large payloads.
  - response_format ('markdown' | 'json')

Returns:
  Markdown timeline of events with type, timestamp, and content (long messages are truncated). Structured JSON in json format.

Tip: To get just the agent's text responses without large tool results, use:
  type='agent.message'
Or to see everything except tool results and thinking:
  exclude_type='agent.tool_result,agent.thinking'

For just the agent's final output text, prefer claudeagent_get_session_output instead.

Error Handling:
  - Returns NOT_FOUND if session_id doesn't exist`,
    inputSchema: ListSessionEventsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { session_id, limit, page, order, type, exclude_type, response_format } = params;
      try {
        // Fetch more than requested if filtering client-side, to fill the limit
        const fetchLimit = (type || exclude_type) ? Math.min(limit * 3, 500) : limit;
        const data = await apiGet<ListResponse<SessionEvent>>(
          getAccessToken()!,
          `/v1/sessions/${encodeURIComponent(session_id)}/events`,
          { limit: fetchLimit, page, order }
        );

        // Apply client-side type filters
        let filteredEvents = data.data;
        if (type) {
          const includeTypes = new Set(type.split(",").map((t) => t.trim()));
          filteredEvents = filteredEvents.filter((e) => includeTypes.has(e.type));
        }
        if (exclude_type) {
          const excludeTypes = new Set(exclude_type.split(",").map((t) => t.trim()));
          filteredEvents = filteredEvents.filter((e) => !excludeTypes.has(e.type));
        }

        // Apply the requested limit after filtering
        const finalEvents = filteredEvents.slice(0, limit);

        return createSuccessResponse(
          {
            session_id,
            total: finalEvents.length,
            total_before_filter: data.data.length,
            events: finalEvents,
            next_page: data.next_page,
            ...(type ? { type_filter: type } : {}),
            ...(exclude_type ? { exclude_type_filter: exclude_type } : {}),
          },
          response_format,
          { title: `Session Events: ${session_id}` }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_list_session_events failed", { error: err, session_id });
        return createErrorResponse(
          "API_ERROR",
          formatApiError(err, "list session events")
        );
      }
    },
  });

  // ===========================================================================
  // claudeagent_list_session_threads
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_list_session_threads",
    description: `For multi-agent sessions, list the sub-agent threads spawned by the coordinator.

Each thread is an isolated sub-agent working on a delegated task with its own conversation context. Single-agent sessions will return an empty list (or just the primary thread).

Args:
  - session_id (string, required)
  - response_format ('markdown' | 'json')

Returns:
  Markdown table of threads with id, agent_name, status, created_at.`,
    inputSchema: ListSessionThreadsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { session_id, response_format } = params;
      try {
        const data = await apiGet<ListResponse<SessionThread>>(
          getAccessToken()!,
          `/v1/sessions/${encodeURIComponent(session_id)}/threads`
        );
        return createSuccessResponse(
          {
            session_id,
            total: data.data.length,
            threads: data.data,
          },
          response_format,
          { title: `Session Threads: ${session_id}` }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_list_session_threads failed", { error: err, session_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "list session threads"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_get_thread_events
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_get_thread_events",
    description: `Retrieve events from a specific sub-agent thread in a multi-agent session.

Use this to drill into what a specific sub-agent was doing when the session-level event list is too coarse. For single-agent sessions, use claudeagent_list_session_events instead.

Args:
  - session_id (string, required)
  - thread_id (string, required)
  - limit (number, 1-100, default: 20)
  - page (string): Pagination cursor`,
    inputSchema: GetThreadEventsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { session_id, thread_id, limit, page, response_format } = params;
      try {
        const data = await apiGet<ListResponse<SessionEvent>>(
          getAccessToken()!,
          `/v1/sessions/${encodeURIComponent(session_id)}/threads/${encodeURIComponent(thread_id)}/events`,
          { limit, page }
        );
        return createSuccessResponse(
          {
            session_id,
            thread_id,
            total: data.data.length,
            events: data.data,
            next_page: data.next_page,
          },
          response_format,
          { title: `Thread Events: ${thread_id}` }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_get_thread_events failed", {
          error: err,
          session_id,
          thread_id,
        });
        return createErrorResponse("API_ERROR", formatApiError(err, "get thread events"));
      }
    },
  });
}
