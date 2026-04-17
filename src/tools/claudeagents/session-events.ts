/**
 * Session event-send tools — the tools that actually make agents do work.
 *
 *   - claudeagent_send_user_message
 *   - claudeagent_define_outcome
 *   - claudeagent_interrupt_session
 *   - claudeagent_confirm_tool_use
 *   - claudeagent_respond_custom_tool
 *
 * All of these POST to /v1/sessions/{id}/events with a specific event type.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  FileUploadSpecSchema,
  ResponseFormatSchema,
  SessionIdSchema,
  ThreadIdSchema,
  ToolUseIdSchema,
} from "../../schemas/index.js";
import {
  apiPost,
  AuthExpiredError,
  formatApiError,
} from "../../services/api-client.js";
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

const SendUserMessageInputSchema = z.object({
  session_id: SessionIdSchema,
  text: z
    .string()
    .min(1)
    .describe("The user message text — what the agent should do"),
  files: z
    .array(FileUploadSpecSchema)
    .optional()
    .describe("Optional file attachments (name, content_base64, mime_type)"),
  response_format: ResponseFormatSchema,
});

// Note: we validate the "rubric_text XOR rubric_file_id" rule inside the
// handler rather than using z.refine(), because refine produces ZodEffects
// which doesn't satisfy our ZodObject constraint in registerTool.
const DefineOutcomeInputSchema = z.object({
  session_id: SessionIdSchema,
  description: z
    .string()
    .min(1)
    .max(2000)
    .describe("What the session should achieve (1-2 sentences)"),
  rubric_text: z
    .string()
    .min(1)
    .optional()
    .describe("Inline markdown rubric — mutually exclusive with rubric_file_id"),
  rubric_file_id: z
    .string()
    .optional()
    .describe("File ID of a previously-uploaded rubric — mutually exclusive with rubric_text"),
  max_iterations: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(3)
    .describe("Maximum revision iterations before the agent stops (default: 3, max: 20)"),
  response_format: ResponseFormatSchema,
});

const InterruptSessionInputSchema = z.object({
  session_id: SessionIdSchema,
  reason: z.string().optional(),
  response_format: ResponseFormatSchema,
});

const ConfirmToolUseInputSchema = z.object({
  session_id: SessionIdSchema,
  tool_use_id: ToolUseIdSchema,
  result: z.enum(["allow", "deny"]),
  session_thread_id: ThreadIdSchema.optional(),
  response_format: ResponseFormatSchema,
});

const RespondCustomToolInputSchema = z.object({
  session_id: SessionIdSchema,
  tool_use_id: ToolUseIdSchema,
  result: z
    .any()
    .describe("The tool result — must match the tool's expected output schema"),
  session_thread_id: ThreadIdSchema.optional(),
  response_format: ResponseFormatSchema,
});

// =============================================================================
// Helper — POST an event to a session
// =============================================================================

async function postSessionEvent(
  accessToken: string,
  sessionId: string,
  event: Record<string, unknown>
): Promise<unknown> {
  return apiPost(
    accessToken,
    `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
    { events: [event] }
  );
}

// =============================================================================
// Registration
// =============================================================================

export function registerSessionEventTools(
  server: McpServer,
  getAccessToken: () => string | undefined
): void {
  // ===========================================================================
  // claudeagent_send_user_message
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_send_user_message",
    description: `Send a user message to a session.

This is what actually kicks off agent work. The agent reads the message, uses its tools, and generates a response. For long-running work, pair this with claudeagent_wait_for_session_idle to block until the agent finishes, then call claudeagent_summarize_session to get the result — OR just call claudeagent_run_task which does all of that in one tool call.

Args:
  - session_id (string, required)
  - text (string, required): The user message text
  - files (array, optional): File attachments, each with {name, content_base64, mime_type}
  - response_format ('markdown' | 'json')

Returns:
  Markdown confirming the message was sent.

Examples:
  - Simple question: {"session_id": "sesn_abc", "text": "What's the weather in Tokyo?"}
  - With a file: {"session_id": "sesn_abc", "text": "Analyze this CSV", "files": [{"name": "data.csv", "content_base64": "...", "mime_type": "text/csv"}]}

Error Handling:
  - Returns NOT_FOUND if session_id doesn't exist
  - Returns CONFLICT if the session is already terminated`,
    inputSchema: SendUserMessageInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { session_id, text, files, response_format } = params;

      // Build content blocks
      const content: Record<string, unknown>[] = [{ type: "text", text }];
      if (files && files.length > 0) {
        for (const file of files) {
          content.push({
            type: "document",
            source: {
              type: "base64",
              media_type: file.mime_type ?? "application/octet-stream",
              data: file.content_base64,
            },
            name: file.name,
          });
        }
      }

      try {
        await postSessionEvent(getAccessToken()!, session_id, {
          type: "user.message",
          content,
        });
        return createSuccessResponse(
          {
            session_id,
            status: "sent",
            message_preview: text.slice(0, 200),
            files_attached: files?.length ?? 0,
            next_step: `Call claudeagent_wait_for_session_idle(session_id: "${session_id}") to watch the agent work, or claudeagent_summarize_session once it finishes.`,
          },
          response_format,
          { title: "Message Sent" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_send_user_message failed", { error: err, session_id });
        return createErrorResponse(
          "API_ERROR",
          formatApiError(err, "send user message")
        );
      }
    },
  });

  // ===========================================================================
  // claudeagent_define_outcome
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_define_outcome",
    description: `Define an outcome for a session — a description plus a rubric the grader will evaluate against.

The session runs in outcome-oriented mode, iterating until the rubric is satisfied or max_iterations is hit. This is an alternative to claudeagent_send_user_message when you want the agent to self-correct toward a measurable goal.

You must provide either rubric_text (inline markdown) or rubric_file_id (from a previously-uploaded file). Not both.

Args:
  - session_id (string, required)
  - description (string, required): What the session should achieve
  - rubric_text (string, optional): Inline markdown rubric
  - rubric_file_id (string, optional): File ID of a previously-uploaded rubric
  - max_iterations (number, default: 3, max: 20)
  - response_format ('markdown' | 'json')

Examples:
  - Inline rubric: {"session_id": "sesn_abc", "description": "Build a DCF model for Costco in .xlsx", "rubric_text": "# DCF Model Rubric\\n\\n## Revenue Projections\\n- Uses last 5 years..."}
  - File-based rubric: {"session_id": "sesn_abc", "description": "...", "rubric_file_id": "file_01..."}

Error Handling:
  - Returns INVALID_PARAMS if neither rubric_text nor rubric_file_id is provided
  - Returns NOT_FOUND if session_id doesn't exist`,
    inputSchema: DefineOutcomeInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { session_id, description, rubric_text, rubric_file_id, max_iterations, response_format } = params;

      // Enforce XOR: exactly one of rubric_text or rubric_file_id must be provided
      if (!rubric_text && !rubric_file_id) {
        return createErrorResponse(
          "INVALID_PARAMS",
          "Must provide either rubric_text (inline markdown) or rubric_file_id (from the Files API)."
        );
      }
      if (rubric_text && rubric_file_id) {
        return createErrorResponse(
          "INVALID_PARAMS",
          "Provide either rubric_text OR rubric_file_id, not both."
        );
      }

      const rubric = rubric_text
        ? { type: "text", content: rubric_text }
        : { type: "file", file_id: rubric_file_id! };

      try {
        await postSessionEvent(getAccessToken()!, session_id, {
          type: "user.define_outcome",
          description,
          rubric,
          max_iterations,
        });
        return createSuccessResponse(
          {
            session_id,
            status: "outcome_defined",
            description,
            max_iterations,
            next_step: `The agent will start working on the outcome immediately. Call claudeagent_wait_for_session_idle(session_id: "${session_id}") to watch its progress, or claudeagent_get_session to check iteration status.`,
          },
          response_format,
          { title: "Outcome Defined" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_define_outcome failed", { error: err, session_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "define outcome"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_interrupt_session
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_interrupt_session",
    description: `Stop a running session mid-execution.

The agent halts after its current step and the session transitions to idle. Use this to cancel work that's no longer needed, costing too much, or taking too long.

Args:
  - session_id (string, required)
  - reason (string, optional): Human-readable reason for the interruption
  - response_format ('markdown' | 'json')

Error Handling:
  - Returns CONFLICT if the session is already idle or terminated`,
    inputSchema: InterruptSessionInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { session_id, reason, response_format } = params;
      try {
        await postSessionEvent(getAccessToken()!, session_id, {
          type: "user.interrupt",
          ...(reason ? { reason } : {}),
        });
        return createSuccessResponse(
          {
            session_id,
            status: "interrupt_sent",
            reason: reason ?? null,
          },
          response_format,
          { title: "Session Interrupt Sent" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_interrupt_session failed", { error: err, session_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "interrupt session"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_confirm_tool_use
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_confirm_tool_use",
    description: `Respond to a tool confirmation request from an agent.

When an agent tries to use a tool that requires confirmation (per the agent's permission policy), the session pauses and emits an event with the tool_use_id. Call this tool to allow or deny the tool call so the session can continue.

For multi-agent sessions, pass the session_thread_id from the confirmation request to route the response back to the correct sub-agent thread.

Args:
  - session_id (string, required)
  - tool_use_id (string, required): From the confirmation request event
  - result ('allow' | 'deny', required)
  - session_thread_id (string, optional): For multi-agent sessions`,
    inputSchema: ConfirmToolUseInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { session_id, tool_use_id, result, session_thread_id, response_format } = params;
      try {
        await postSessionEvent(getAccessToken()!, session_id, {
          type: "user.tool_confirmation",
          tool_use_id,
          result,
          ...(session_thread_id ? { session_thread_id } : {}),
        });
        return createSuccessResponse(
          {
            session_id,
            tool_use_id,
            result,
          },
          response_format,
          { title: "Tool Use Confirmation Sent" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_confirm_tool_use failed", { error: err, session_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "confirm tool use"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_respond_custom_tool
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_respond_custom_tool",
    description: `Respond to a custom tool call from an agent.

When an agent calls a custom tool, the session pauses waiting for the client to provide the result. Call this tool to return the custom tool's result so the session can continue.

Args:
  - session_id (string, required)
  - tool_use_id (string, required)
  - result (any, required): The tool result — must match the tool's expected output schema
  - session_thread_id (string, optional): For multi-agent sessions`,
    inputSchema: RespondCustomToolInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { session_id, tool_use_id, result, session_thread_id, response_format } = params;
      try {
        await postSessionEvent(getAccessToken()!, session_id, {
          type: "user.custom_tool_result",
          tool_use_id,
          result,
          ...(session_thread_id ? { session_thread_id } : {}),
        });
        return createSuccessResponse(
          {
            session_id,
            tool_use_id,
            status: "result_sent",
          },
          response_format,
          { title: "Custom Tool Result Sent" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_respond_custom_tool failed", { error: err, session_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "respond to custom tool"));
      }
    },
  });
}
