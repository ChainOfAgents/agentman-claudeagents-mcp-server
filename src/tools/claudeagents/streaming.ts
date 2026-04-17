/**
 * Streaming observation tools — the core of the "claude.ai as console" UX.
 *
 *   - claudeagent_wait_for_session_idle: block until a session reaches idle,
 *     streaming events as MCP progress notifications along the way
 *   - claudeagent_stream_session_events: explicit "tail -f" for a session
 *
 * Both open an SSE stream to Anthropic's /v1/sessions/{id}/events/stream
 * endpoint and forward each event as an MCP notifications/progress message
 * with a human-readable label.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  ResponseFormatSchema,
  SessionIdSchema,
} from "../../schemas/index.js";
import {
  apiStream,
  AuthExpiredError,
  formatApiError,
  SseEvent,
} from "../../services/api-client.js";
import { logger } from "../../utils/logger.js";
import {
  createErrorResponse,
  createSuccessResponse,
  registerTool,
  requireAuth,
  sendProgress,
  ToolExtra,
} from "../shared.js";

// =============================================================================
// Event translation: Anthropic SSE event → human-readable progress message
// =============================================================================

/**
 * Known terminal session events that should end the stream.
 */
const TERMINAL_EVENT_TYPES = new Set([
  "session.status_idle",
  "session.status_terminated",
]);

/**
 * Event types we deliberately filter out of progress notifications because
 * they're too noisy (per-token streaming, internal span boundaries).
 * They're still captured in the accumulated log for the final return value.
 */
const NOISY_EVENT_TYPES = new Set([
  "agent.thinking", // opt-in via include_thinking
  "span.model_request_start",
  "agent.message_delta",
  "agent.thinking_delta",
]);

/**
 * Convert an Anthropic SSE event into a short human-readable message
 * suitable for an MCP progress notification.
 *
 * Returns null if the event should be silently skipped (e.g., noise).
 */
function formatEventForProgress(
  sse: SseEvent,
  options: { includeThinking?: boolean; resolvedType?: string } = {}
): string | null {
  // Anthropic's SSE uses `event: message` for all events.
  // The real event type is inside the `data` JSON payload's `type` field.
  const rawData = (sse.data as Record<string, unknown> | undefined) ?? {};
  const eventType = options.resolvedType ?? (typeof rawData.type === "string" ? rawData.type : sse.event) ?? "unknown";
  const data = rawData;

  // Skip noise unless explicitly requested
  if (NOISY_EVENT_TYPES.has(eventType)) {
    if (eventType === "agent.thinking" && options.includeThinking) {
      return "Agent thinking...";
    }
    return null;
  }

  switch (eventType) {
    case "session.status_running":
      return "Agent started working...";

    case "session.status_idle": {
      const stopReason =
        typeof data.stop_reason === "string" ? data.stop_reason : "idle";
      return `Session complete. Stop reason: ${stopReason}`;
    }

    case "session.status_terminated": {
      const err = data.error as Record<string, unknown> | undefined;
      const msg = typeof err?.message === "string" ? err.message : "terminated";
      return `⚠ Session terminated: ${msg}`;
    }

    case "session.status_rescheduled":
      return "Transient error, retrying...";

    case "session.error": {
      const err = data.error as Record<string, unknown> | undefined;
      const type = typeof err?.type === "string" ? err.type : "error";
      const msg = typeof err?.message === "string" ? err.message : "unknown error";
      return `⚠ Session error: ${type} — ${truncate(msg, 120)}`;
    }

    case "agent.message": {
      const content = data.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            (block as Record<string, unknown>).type === "text"
          ) {
            const text = (block as Record<string, unknown>).text;
            if (typeof text === "string" && text.trim().length > 0) {
              return `Agent: ${truncate(text, 180)}`;
            }
          }
        }
      }
      return "Agent: (message)";
    }

    case "agent.tool_use": {
      const name = typeof data.name === "string" ? data.name : "unknown";
      const input = data.input as Record<string, unknown> | undefined;
      const hint = summarizeToolInput(input);
      return `Calling tool: ${name}${hint ? ` (${hint})` : ""}`;
    }

    case "agent.tool_result": {
      const name = typeof data.name === "string" ? data.name : "tool";
      const content = data.content;
      let sizeHint = "";
      if (typeof content === "string") {
        sizeHint = ` (${content.length} chars)`;
      } else if (Array.isArray(content)) {
        sizeHint = ` (${content.length} blocks)`;
      }
      const isError = data.is_error === true;
      return `${isError ? "⚠ " : ""}Tool result: ${name}${sizeHint}`;
    }

    case "agent.mcp_tool_use": {
      const name = typeof data.name === "string" ? data.name : "unknown";
      const server =
        typeof data.server_name === "string" ? ` on ${data.server_name}` : "";
      return `Calling MCP tool: ${name}${server}`;
    }

    case "agent.mcp_tool_result": {
      const name = typeof data.name === "string" ? data.name : "mcp_tool";
      return `MCP tool result: ${name}`;
    }

    case "agent.custom_tool_use": {
      const name = typeof data.name === "string" ? data.name : "unknown";
      return `Calling custom tool: ${name} (pending your confirmation)`;
    }

    case "span.model_request_end": {
      const usage = data.model_usage as Record<string, unknown> | undefined;
      if (usage) {
        const inTok = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
        const outTok = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
        return `Model call: ${inTok} in / ${outTok} out tokens`;
      }
      return "Model call complete";
    }

    case "span.outcome_evaluation_start": {
      const iteration = typeof data.iteration === "number" ? data.iteration : 0;
      return `Running outcome evaluation (iteration ${iteration})...`;
    }

    case "span.outcome_evaluation_end": {
      const result =
        typeof data.result === "string" ? data.result : "unknown";
      return `Outcome evaluation: ${result}`;
    }

    case "session.thread_created": {
      const model = typeof data.model === "string" ? ` (${data.model})` : "";
      return `Coordinator spawned sub-agent thread${model}`;
    }

    case "session.thread_idle":
      return "Sub-agent thread completed";

    case "user.message":
      return "User message sent";

    case "user.interrupt":
      return "User interrupted the session";

    default:
      // Fall back to a generic short label so the user sees *something*
      return `Event: ${eventType}`;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

function summarizeToolInput(
  input: Record<string, unknown> | undefined
): string | null {
  if (!input) return null;
  // Try common keys that hint at what the tool is doing
  for (const key of ["query", "command", "path", "url", "prompt", "text"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return `${key}: ${truncate(value, 80)}`;
    }
  }
  return null;
}

// =============================================================================
// Shared streaming loop — runs for both wait_for_session_idle and stream_session_events
// =============================================================================

export interface StreamLoopOptions {
  accessToken: string;
  sessionId: string;
  maxEvents?: number;
  timeoutSeconds: number;
  includeThinking?: boolean;
  stopOnIdle: boolean;
}

export interface StreamLoopResult {
  status: "idle" | "terminated" | "max_events_reached" | "timeout";
  stopReason: string | null;
  elapsedMs: number;
  eventsReceived: number;
  progressSent: number;
  accumulatedLog: Array<{ type: string; summary: string }>;
}

/**
 * Run the SSE streaming loop for a session.
 *
 * Opens an SSE stream against /v1/sessions/{id}/events/stream, emits an
 * MCP progress notification for each meaningful event, accumulates a log,
 * and returns when the session reaches idle/terminated, max_events is hit,
 * or the timeout expires.
 */
export async function runStreamLoop(
  options: StreamLoopOptions,
  extra: ToolExtra
): Promise<StreamLoopResult> {
  const { accessToken, sessionId, maxEvents, timeoutSeconds, includeThinking, stopOnIdle } = options;

  const startedAt = Date.now();
  const deadlineMs = startedAt + timeoutSeconds * 1000;
  const accumulatedLog: Array<{ type: string; summary: string }> = [];
  let eventsReceived = 0;
  let progressSent = 0;
  let status: StreamLoopResult["status"] = "timeout";
  let stopReason: string | null = null;

  // Chain the tool's abort signal with our timeout
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutSeconds * 1000);
  const clientAbortHandler = () => abortController.abort();
  if (extra.signal) {
    if (extra.signal.aborted) {
      abortController.abort();
    } else {
      extra.signal.addEventListener("abort", clientAbortHandler, { once: true });
    }
  }

  try {
    for await (const sseEvent of apiStream(accessToken, `/v1/sessions/${encodeURIComponent(sessionId)}/events/stream`, {
      signal: abortController.signal,
      timeoutMs: timeoutSeconds * 1000,
    })) {
      eventsReceived++;
      // Anthropic's SSE uses `event: message` for ALL events.
      // The actual event type is inside the parsed data JSON `type` field.
      const data = sseEvent.data as Record<string, unknown> | undefined;
      const eventType = (typeof data?.type === "string" ? data.type : sseEvent.event) ?? "unknown";

      // Accumulate into log (always, regardless of whether we emit progress)
      const summary = formatEventForProgress(sseEvent, { includeThinking: true, resolvedType: eventType });
      if (summary) {
        accumulatedLog.push({ type: eventType, summary });
      }

      // Emit progress notification if the event is interesting
      const progressMessage = formatEventForProgress(sseEvent, { includeThinking, resolvedType: eventType });
      if (progressMessage !== null) {
        progressSent++;
        await sendProgress(extra, progressSent, progressMessage);
      }

      // Check terminal conditions
      if (stopOnIdle && TERMINAL_EVENT_TYPES.has(eventType)) {
        status = eventType === "session.status_idle" ? "idle" : "terminated";
        const data = sseEvent.data as Record<string, unknown> | undefined;
        if (data) {
          stopReason = typeof data.stop_reason === "string" ? data.stop_reason : null;
          if (eventType === "session.status_terminated") {
            const err = data.error as Record<string, unknown> | undefined;
            stopReason = typeof err?.message === "string" ? err.message : "terminated";
          }
        }
        break;
      }

      if (maxEvents !== undefined && eventsReceived >= maxEvents) {
        status = "max_events_reached";
        break;
      }

      if (Date.now() >= deadlineMs) {
        status = "timeout";
        break;
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
    // Abort the controller to cleanly close the SSE stream reader
    // (prevents stale pending reads from throwing after we've exited the loop)
    abortController.abort();
    if (extra.signal) {
      extra.signal.removeEventListener("abort", clientAbortHandler);
    }
  }

  // If we received zero events from the SSE stream, the session may have
  // already completed before we opened the stream (very fast sessions, or
  // the send_user_message + stream_open timing window was too slow). Check
  // the session status directly and treat an already-idle session as success.
  if (eventsReceived === 0 && stopOnIdle && status === "timeout") {
    try {
      const { apiGet: _apiGet } = await import("../../services/api-client.js");
      const session = await _apiGet<{ status: string; stats?: { active_seconds?: number } }>(
        accessToken,
        `/v1/sessions/${encodeURIComponent(sessionId)}`
      );
      if (session.status === "idle") {
        status = "idle";
        stopReason = "already_idle";
        await sendProgress(extra, progressSent + 1, "Session already completed (fast agent).");
        progressSent++;
      } else if (session.status === "terminated") {
        status = "terminated";
        stopReason = "already_terminated";
      }
    } catch {
      // If the fallback check fails, leave status as "timeout" — the caller
      // will handle it appropriately.
    }
  }

  return {
    status,
    stopReason,
    elapsedMs: Date.now() - startedAt,
    eventsReceived,
    progressSent,
    accumulatedLog,
  };
}

// =============================================================================
// Input schemas
// =============================================================================

const WaitForSessionIdleInputSchema = z.object({
  session_id: SessionIdSchema,
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(1800)
    .default(600)
    .describe("Max wait time in seconds (default: 600 = 10 min, max: 1800 = 30 min)"),
  stream_events: z
    .boolean()
    .default(true)
    .describe("If true, emit MCP progress notifications as events arrive"),
  include_thinking: z
    .boolean()
    .default(false)
    .describe("If true, include agent.thinking events in progress notifications"),
  response_format: ResponseFormatSchema,
});

const StreamSessionEventsInputSchema = z.object({
  session_id: SessionIdSchema,
  max_events: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(200)
    .describe("Stop after this many events (default: 200, max: 1000)"),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(1800)
    .default(300)
    .describe("Stop streaming after this duration in seconds (default: 300)"),
  include_thinking: z
    .boolean()
    .default(false)
    .describe("If true, include agent.thinking events"),
  response_format: ResponseFormatSchema,
});

// =============================================================================
// Registration
// =============================================================================

export function registerStreamingTools(
  server: McpServer,
  getAccessToken: () => string | undefined
): void {
  // ===========================================================================
  // claudeagent_wait_for_session_idle
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_wait_for_session_idle",
    description: `Block until a session reaches idle state (agent has finished work) or a timeout expires.

Streams agent activity via MCP progress notifications while waiting, so the user sees what the agent is doing in near-real-time. Internally opens an SSE stream to the Anthropic Managed Agents event stream endpoint and forwards each event as a progress notification with a human-readable label.

Use this after sending a user message (claudeagent_send_user_message) to wait for the agent to complete before checking results. For a one-shot "create session + send message + wait + summarize" flow, use claudeagent_run_task instead.

Args:
  - session_id (string, required)
  - timeout_seconds (number, 1-1800, default: 600): Max wait time (default 10 min, max 30 min)
  - stream_events (boolean, default: true): Emit progress notifications as events arrive
  - include_thinking (boolean, default: false): Include agent.thinking events in progress output
  - response_format ('markdown' | 'json')

Returns:
  Markdown confirming the final state: either 'idle' with stop_reason and elapsed time, or 'timeout' if the session was still running when timeout expired (with guidance to call again with a fresh timeout, or call summarize_session for partial results).

Error Handling:
  - Returns NOT_FOUND if session_id doesn't exist
  - Returns AUTH_REQUIRED if no API key is configured
  - Returns an intermediate "still running" result on timeout, NOT an error`,
    inputSchema: WaitForSessionIdleInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (params, extra): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { session_id, timeout_seconds, include_thinking, response_format } = params;
      try {
        const result = await runStreamLoop(
          {
            accessToken: getAccessToken()!,
            sessionId: session_id,
            timeoutSeconds: timeout_seconds,
            includeThinking: include_thinking,
            stopOnIdle: true,
          },
          extra
        );

        const lastEvent = result.accumulatedLog[result.accumulatedLog.length - 1];

        if (result.status === "timeout") {
          return createSuccessResponse(
            {
              session_id,
              status: "still_running",
              elapsed_seconds: Math.round(result.elapsedMs / 1000),
              events_observed: result.eventsReceived,
              last_event: lastEvent?.summary ?? "(no events yet)",
              next_step: `Session is still running after ${timeout_seconds}s. Options: call claudeagent_wait_for_session_idle again to keep waiting, or claudeagent_summarize_session(session_id: "${session_id}") for a partial summary, or claudeagent_interrupt_session to stop it.`,
            },
            response_format,
            { title: "Session Still Running (Timeout)" }
          );
        }

        return createSuccessResponse(
          {
            session_id,
            status: result.status,
            stop_reason: result.stopReason,
            elapsed_seconds: Math.round(result.elapsedMs / 1000),
            events_observed: result.eventsReceived,
            last_event: lastEvent?.summary ?? null,
            next_step: `Call claudeagent_summarize_session(session_id: "${session_id}") to get the full result.`,
          },
          response_format,
          { title: `Session ${result.status === "idle" ? "Complete" : "Terminated"}` }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_wait_for_session_idle failed", { error: err, session_id });

        let errorCode = "API_ERROR";
        let suggestion = "";
        if (err instanceof Error && err.message.includes("aborted")) {
          errorCode = "TIMEOUT";
          suggestion = `Session may still be running. Use claudeagent_get_session(session_id: "${session_id}") to check status, or claudeagent_summarize_session to get partial results.`;
        }

        return createErrorResponse(
          errorCode,
          JSON.stringify({
            error: errorCode,
            message: formatApiError(err, "wait for session idle"),
            session_id,
            ...(suggestion ? { suggestion } : {}),
          })
        );
      }
    },
  });

  // ===========================================================================
  // claudeagent_stream_session_events
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_stream_session_events",
    description: `Stream events from a session in real-time, emitting each as an MCP progress notification and returning a log when the stream closes.

Use this for the "tail -f my agent run" use case when you want to watch a slow agent run turn by turn. Unlike claudeagent_wait_for_session_idle, this tool stops at max_events or timeout_seconds even if the session is still running — it doesn't block to completion.

Typically called on a session that's already running. Progress notifications render as status updates in claude.ai / Claude Desktop; the final return value contains a markdown log of everything observed.

Args:
  - session_id (string, required)
  - max_events (number, 1-1000, default: 200): Stop after this many events
  - timeout_seconds (number, 1-1800, default: 300): Stop after this duration
  - include_thinking (boolean, default: false): Include agent.thinking events (noisy)
  - response_format ('markdown' | 'json')

Returns:
  Markdown log of all events observed during the stream, ordered by timestamp, with a footer noting why the stream stopped.`,
    inputSchema: StreamSessionEventsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (params, extra): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { session_id, max_events, timeout_seconds, include_thinking, response_format } = params;
      try {
        const result = await runStreamLoop(
          {
            accessToken: getAccessToken()!,
            sessionId: session_id,
            maxEvents: max_events,
            timeoutSeconds: timeout_seconds,
            includeThinking: include_thinking,
            stopOnIdle: false, // explicit streaming — don't auto-stop at idle
          },
          extra
        );

        return createSuccessResponse(
          {
            session_id,
            stop_reason_category: result.status,
            elapsed_seconds: Math.round(result.elapsedMs / 1000),
            total_events: result.eventsReceived,
            progress_notifications_sent: result.progressSent,
            event_log: result.accumulatedLog,
          },
          response_format,
          { title: `Session Event Stream: ${session_id}` }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_stream_session_events failed", { error: err, session_id });
        return createErrorResponse(
          "API_ERROR",
          formatApiError(err, "stream session events")
        );
      }
    },
  });
}
