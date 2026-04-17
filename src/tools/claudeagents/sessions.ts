/**
 * Session CRUD tools (Step 3 of the Anthropic Console quickstart — CRUD only,
 * event-sending tools are in session-events.ts).
 *
 *   - claudeagent_list_sessions
 *   - claudeagent_get_session
 *   - claudeagent_create_session
 *   - claudeagent_update_session
 *   - claudeagent_archive_session
 *   - claudeagent_delete_session
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  AgentIdSchema,
  AnthropicPaginationSchema,
  EnvironmentIdSchema,
  MetadataSchema,
  MetadataUpdateSchema,
  ResponseFormatSchema,
  SessionIdSchema,
  SessionStatusSchema,
} from "../../schemas/index.js";
import {
  apiDelete,
  apiGet,
  apiPost,
  AuthExpiredError,
  formatApiError,
} from "../../services/api-client.js";
import { ListResponse, Session } from "../../types/anthropic.js";
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

const ListSessionsInputSchema = AnthropicPaginationSchema.extend({
  agent_id: AgentIdSchema.optional().describe("Filter to a specific agent"),
  agent_version: z.number().int().optional(),
  status: SessionStatusSchema.optional(),
  created_after: z
    .string()
    .datetime()
    .optional()
    .describe("ISO 8601 timestamp — only sessions created at or after this time (maps to Anthropic's created_at[gte])"),
  created_before: z
    .string()
    .datetime()
    .optional()
    .describe("ISO 8601 timestamp — only sessions created at or before this time (maps to Anthropic's created_at[lte])"),
  include_archived: z.boolean().default(false),
  order: z.enum(["asc", "desc"]).default("desc"),
  response_format: ResponseFormatSchema,
});

const SessionIdOnlyInputSchema = z.object({
  session_id: SessionIdSchema,
  response_format: ResponseFormatSchema,
});

const CreateSessionInputSchema = z.object({
  agent_id: AgentIdSchema.describe("Agent to run in this session"),
  environment_id: EnvironmentIdSchema.describe("Environment container to use"),
  title: z
    .string()
    .max(256)
    .optional()
    .describe("Human-readable title for the session"),
  metadata: MetadataSchema.optional(),
  vault_ids: z
    .array(z.string())
    .optional()
    .describe("Credential vault IDs for MCP servers that require auth"),
  response_format: ResponseFormatSchema,
});

const UpdateSessionInputSchema = z.object({
  session_id: SessionIdSchema,
  title: z.string().max(256).optional(),
  metadata: MetadataUpdateSchema.optional(),
  response_format: ResponseFormatSchema,
});

// =============================================================================
// Registration
// =============================================================================

export function registerSessionTools(
  server: McpServer,
  getAccessToken: () => string | undefined
): void {
  // ===========================================================================
  // claudeagent_list_sessions
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_list_sessions",
    description: `List agent sessions with filters.

A session is a running or completed agent instance working on a specific task. Filter by agent, status, or date range. Use this to find sessions you want to inspect, summarize, or resume.

Args:
  - agent_id (string, optional): Filter to a specific agent
  - agent_version (number, optional): Filter to a specific version
  - status ('running' | 'idle' | 'terminated' | 'rescheduling', optional)
  - created_after / created_before (ISO 8601 timestamp, optional)
  - include_archived (boolean, default: false)
  - limit (number, 1-100, default: 20)
  - page (string): Pagination cursor
  - order ('asc' | 'desc', default: 'desc')
  - response_format ('markdown' | 'json')

Returns:
  Markdown table of sessions with id, agent name, status, created_at, duration, cost, token usage, plus next_page cursor.

Examples:
  - List latest 20: {}
  - Failed sessions from yesterday: {"status": "terminated", "created_after": "2026-04-09T00:00:00Z"}
  - All sessions of one agent: {"agent_id": "agent_01abc"}`,
    inputSchema: ListSessionsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const {
        response_format,
        created_after,
        created_before,
        ...rest
      } = params;

      // Map our user-friendly names to Anthropic's bracket-notation query params.
      // Anthropic's API expects `created_at[gte]` and `created_at[lte]`.
      const query: Record<string, string | number | boolean | undefined> = {
        ...rest,
      };
      if (created_after !== undefined) query["created_at[gte]"] = created_after;
      if (created_before !== undefined) query["created_at[lte]"] = created_before;

      try {
        const data = await apiGet<ListResponse<Session>>(
          getAccessToken()!,
          "/v1/sessions",
          query
        );
        return createSuccessResponse(
          {
            total: data.data.length,
            sessions: data.data,
            next_page: data.next_page,
          },
          response_format,
          { title: "Sessions" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_list_sessions failed", { error: err });
        return createErrorResponse("API_ERROR", formatApiError(err, "list sessions"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_get_session
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_get_session",
    description: `Check a session's current status and metadata. Returns in <2 seconds.

This is the recommended polling tool for checking if a long-running agent has finished. After starting a task with claudeagent_run_task or claudeagent_send_user_message, poll this every ~30 seconds until status changes from "running" to "idle", then call claudeagent_get_session_output to retrieve the agent's response.

Key status values:
  - "running": agent is still working
  - "idle": agent finished — call get_session_output to get the result
  - "terminated": session ended with an error
  - "rescheduling": transient error, will auto-retry

Note: token usage fields show zero while status is "running" and only populate once the session reaches "idle".

Args:
  - session_id (string, required)
  - response_format ('markdown' | 'json')

Returns:
  Session status, agent info, duration stats, token usage (when complete), and outcome evaluations.

Error Handling:
  - Returns NOT_FOUND if session_id doesn't exist`,
    inputSchema: SessionIdOnlyInputSchema,
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
        const data = await apiGet<Session>(
          getAccessToken()!,
          `/v1/sessions/${encodeURIComponent(session_id)}`
        );
        return createSuccessResponse(
          data as unknown as Record<string, unknown>,
          response_format,
          { title: `Session: ${data.title ?? data.id}` }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_get_session failed", { error: err, session_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "get session"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_create_session
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_create_session",
    description: `Create a new session for an existing agent.

The session is created empty — no work happens until you send the first user message with claudeagent_send_user_message. Store the returned session_id to send messages and check status.

Recommended workflow (polling pattern — reliable for all session durations):
  1. claudeagent_create_session → get session_id
  2. claudeagent_send_user_message(session_id, text) → kick off work
  3. Wait ~30 seconds, then claudeagent_get_session(session_id) → check if status is "idle"
  4. If still "running", wait and check again
  5. When "idle", call claudeagent_get_session_output(session_id) to get the agent's response

Alternative: claudeagent_run_task does steps 1-2 in one call and returns the session_id immediately (async by default).

Args:
  - agent_id (string, required): ID of an existing agent
  - environment_id (string, required): ID of an existing environment
  - title (string, optional): Human-readable title
  - metadata (object, optional): Key-value string metadata
  - vault_ids (string[], optional): Credential vault IDs for MCP servers that require auth
  - response_format ('markdown' | 'json')

Returns:
  Markdown with the new session ID and the recommended next steps.`,
    inputSchema: CreateSessionInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { response_format, agent_id, ...rest } = params;
      const body = {
        agent: agent_id,
        ...rest,
      };
      try {
        const created = await apiPost<Session>(
          getAccessToken()!,
          "/v1/sessions",
          body
        );
        return createSuccessResponse(
          {
            session_id: created.id,
            agent_id,
            environment_id: rest.environment_id,
            status: created.status,
            title: created.title,
            created_at: created.created_at,
            next_step: `Call claudeagent_send_user_message(session_id: "${created.id}", text: "<your task>") to kick off the agent.`,
          },
          response_format,
          { title: "Session Created" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_create_session failed", { error: err, agent_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "create session"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_update_session
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_update_session",
    description: `Update a session's title or metadata.

Use this to rename a session after it's been created, or to attach additional metadata. Does not affect the session's actual state or execution.

Args:
  - session_id (string, required)
  - title (string, optional)
  - metadata (object, optional): Metadata patch (set a key to null to delete it)
  - response_format ('markdown' | 'json')`,
    inputSchema: UpdateSessionInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { session_id, response_format, ...body } = params;
      try {
        const updated = await apiPost<Session>(
          getAccessToken()!,
          `/v1/sessions/${encodeURIComponent(session_id)}`,
          body
        );
        return createSuccessResponse(
          {
            session_id: updated.id,
            title: updated.title,
            updated_at: updated.updated_at,
          },
          response_format,
          { title: "Session Updated" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_update_session failed", { error: err, session_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "update session"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_archive_session
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_archive_session",
    description: `Archive a session (soft-delete).

Archived sessions are hidden from the default list view but are still accessible by ID. Prefer this over delete_session.`,
    inputSchema: SessionIdOnlyInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { session_id, response_format } = params;
      try {
        const archived = await apiPost<Session>(
          getAccessToken()!,
          `/v1/sessions/${encodeURIComponent(session_id)}/archive`,
          {}
        );
        return createSuccessResponse(
          {
            session_id: archived.id,
            archived_at: archived.archived_at,
          },
          response_format,
          { title: "Session Archived" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_archive_session failed", { error: err, session_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "archive session"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_delete_session
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_delete_session",
    description: `Permanently delete a session.

⚠️ WARNING: This is destructive and non-reversible. Prefer claudeagent_archive_session unless you need to remove the session entirely.

Error Handling:
  - Returns CONFLICT if the session is still running`,
    inputSchema: SessionIdOnlyInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { session_id, response_format } = params;
      try {
        await apiDelete(
          getAccessToken()!,
          `/v1/sessions/${encodeURIComponent(session_id)}`
        );
        return createSuccessResponse(
          {
            success: true,
            deleted_session_id: session_id,
          },
          response_format,
          { title: "Session Deleted" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_delete_session failed", { error: err, session_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "delete session"));
      }
    },
  });
}
