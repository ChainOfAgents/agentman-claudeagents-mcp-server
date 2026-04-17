/**
 * Smart composite tools — value-added tools that combine multiple API calls
 * to produce high-level results.
 *
 *   - claudeagent_summarize_session
 *   - claudeagent_find_anomalies
 *   - claudeagent_run_task (the hero tool — create + send + wait + summarize)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  AgentIdSchema,
  EnvironmentIdSchema,
  FileUploadSpecSchema,
  ResponseFormatSchema,
  SessionIdSchema,
} from "../../schemas/index.js";
import {
  apiGet,
  apiPost,
  AuthExpiredError,
  formatApiError,
} from "../../services/api-client.js";
import {
  ListResponse,
  Session,
  SessionEvent,
} from "../../types/anthropic.js";
import { logger } from "../../utils/logger.js";
import {
  createErrorResponse,
  createSuccessResponse,
  registerTool,
  requireAuth,
  sendProgress,
  ToolExtra,
} from "../shared.js";
import { runStreamLoop } from "./streaming.js";

// =============================================================================
// claudeagent_summarize_session
// =============================================================================

const SummarizeSessionInputSchema = z.object({
  session_id: SessionIdSchema,
  include_tool_details: z
    .boolean()
    .default(false)
    .describe("If true, include per-tool-call details; if false, just counts and patterns"),
  response_format: ResponseFormatSchema,
});

/**
 * Fetch all events for a session (up to a safety cap), paginating if needed.
 */
async function fetchAllSessionEvents(
  accessToken: string,
  sessionId: string,
  maxEvents = 1000
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  let page: string | undefined;

  while (events.length < maxEvents) {
    const data = await apiGet<ListResponse<SessionEvent>>(
      accessToken,
      `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      { limit: 100, page }
    );
    events.push(...data.data);
    if (!data.next_page || data.data.length === 0) break;
    page = data.next_page;
  }

  return events;
}

interface EventStats {
  total: number;
  byType: Record<string, number>;
  toolCalls: Map<string, { count: number; errors: number }>;
  errorEvents: Array<{ type: string; message: string }>;
  highlights: Array<{ type: string; text: string }>;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** The full text of the last agent.message event — the agent's final output */
  finalOutput: string | null;
  /** Whether the final output was truncated */
  finalOutputTruncated: boolean;
}

/** Max chars for the final output before truncation */
const MAX_FINAL_OUTPUT_CHARS = 50_000;

function analyzeEvents(events: SessionEvent[]): EventStats {
  const stats: EventStats = {
    total: events.length,
    byType: {},
    toolCalls: new Map(),
    errorEvents: [],
    highlights: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    finalOutput: null,
    finalOutputTruncated: false,
  };

  for (const event of events) {
    const type = event.type;
    stats.byType[type] = (stats.byType[type] ?? 0) + 1;

    // Tool call tracking
    if (type === "agent.tool_use" || type === "agent.mcp_tool_use" || type === "agent.custom_tool_use") {
      const name = typeof event.name === "string" ? event.name : "unknown";
      const entry = stats.toolCalls.get(name) ?? { count: 0, errors: 0 };
      entry.count++;
      stats.toolCalls.set(name, entry);
    }

    if (type === "agent.tool_result" && event.is_error === true) {
      const name = typeof event.name === "string" ? event.name : "unknown";
      const entry = stats.toolCalls.get(name) ?? { count: 0, errors: 0 };
      entry.errors++;
      stats.toolCalls.set(name, entry);
    }

    // Errors
    if (type === "session.error" && event.error) {
      const err = event.error;
      stats.errorEvents.push({
        type: typeof err.type === "string" ? err.type : "error",
        message: typeof err.message === "string" ? err.message : String(err),
      });
    }

    // Token usage from span.model_request_end
    if (type === "span.model_request_end" && event.model_usage) {
      const usage = event.model_usage;
      if (typeof usage.input_tokens === "number") {
        stats.totalInputTokens += usage.input_tokens;
      }
      if (typeof usage.output_tokens === "number") {
        stats.totalOutputTokens += usage.output_tokens;
      }
    }

    // Highlights — first few agent messages and tool calls
    if (stats.highlights.length < 5) {
      if (type === "agent.message" && Array.isArray(event.content)) {
        for (const block of event.content) {
          if (
            typeof block === "object" &&
            block !== null &&
            (block as Record<string, unknown>).type === "text"
          ) {
            const text = (block as Record<string, unknown>).text;
            if (typeof text === "string" && text.trim().length > 0) {
              stats.highlights.push({
                type: "agent_message",
                text: text.slice(0, 160),
              });
              break;
            }
          }
        }
      } else if (type === "agent.tool_use") {
        const name = typeof event.name === "string" ? event.name : "unknown";
        stats.highlights.push({ type: "tool_call", text: `Called ${name}` });
      }
    }
  }

  // Extract the agent's final output — scan backwards for the last agent.message
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "agent.message" && Array.isArray(event.content)) {
      const textParts: string[] = [];
      for (const block of event.content) {
        if (
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "text"
        ) {
          const text = (block as Record<string, unknown>).text;
          if (typeof text === "string") {
            textParts.push(text);
          }
        }
      }
      if (textParts.length > 0) {
        let fullText = textParts.join("\n");
        if (fullText.length > MAX_FINAL_OUTPUT_CHARS) {
          // Truncate at a paragraph boundary
          const truncPoint = fullText.lastIndexOf("\n\n", MAX_FINAL_OUTPUT_CHARS);
          fullText = fullText.slice(0, truncPoint > 0 ? truncPoint : MAX_FINAL_OUTPUT_CHARS);
          stats.finalOutputTruncated = true;
        }
        stats.finalOutput = fullText;
        break;
      }
    }
  }

  return stats;
}

// =============================================================================
// Cost estimation (Anthropic published pricing, April 2026)
// =============================================================================

/** Per-million-token pricing for Claude models */
const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-sonnet-4-6":  { input: 3.00,  output: 15.00, cacheWrite: 3.75,  cacheRead: 0.30 },
  "claude-opus-4-6":    { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-haiku-4-5":   { input: 0.80,  output: 4.00,  cacheWrite: 1.00,  cacheRead: 0.08 },
  // Fallback for unknown models — use Sonnet pricing as a reasonable default
  "_default":           { input: 3.00,  output: 15.00, cacheWrite: 3.75,  cacheRead: 0.30 },
};

function estimateCost(
  modelId: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  }
): { estimated_cost_usd: number; breakdown: Record<string, number>; model_pricing_used: string } {
  const pricing = MODEL_PRICING[modelId] ?? MODEL_PRICING["_default"];
  const modelUsed = MODEL_PRICING[modelId] ? modelId : `_default (assumed ${modelId})`;

  const inputCost = (usage.input_tokens / 1_000_000) * pricing.input;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.output;
  const cacheWriteCost = (usage.cache_creation_input_tokens / 1_000_000) * pricing.cacheWrite;
  const cacheReadCost = (usage.cache_read_input_tokens / 1_000_000) * pricing.cacheRead;
  const total = inputCost + outputCost + cacheWriteCost + cacheReadCost;

  return {
    estimated_cost_usd: Math.round(total * 10000) / 10000, // 4 decimal places
    breakdown: {
      input_cost: Math.round(inputCost * 10000) / 10000,
      output_cost: Math.round(outputCost * 10000) / 10000,
      cache_write_cost: Math.round(cacheWriteCost * 10000) / 10000,
      cache_read_cost: Math.round(cacheReadCost * 10000) / 10000,
    },
    model_pricing_used: modelUsed,
  };
}

// =============================================================================
// Build summary
// =============================================================================

function buildSummaryMarkdown(
  session: Session,
  stats: EventStats,
  includeToolDetails: boolean
): Record<string, unknown> {
  const agentName =
    typeof session.agent === "object" && session.agent !== null && "name" in session.agent
      ? (session.agent as { name: string }).name
      : "unknown";

  const modelId =
    typeof session.agent === "object" && session.agent !== null
      ? typeof (session.agent as Record<string, unknown>).model === "object"
        ? ((session.agent as Record<string, unknown>).model as Record<string, unknown>)?.id as string ?? "unknown"
        : (session.agent as Record<string, unknown>).model as string ?? "unknown"
      : "unknown";

  const durationSeconds = session.stats?.duration_seconds ?? 0;
  const activeSeconds = session.stats?.active_seconds ?? 0;

  // Detailed token usage from the session object (includes cache breakdown)
  const sessionUsage = session.usage ?? { input_tokens: 0, output_tokens: 0 };
  const inputTokens = sessionUsage.input_tokens ?? 0;
  const outputTokens = sessionUsage.output_tokens ?? 0;
  const cacheReadTokens = sessionUsage.cache_read_input_tokens ?? 0;
  const cacheCreation = sessionUsage.cache_creation ?? {};
  const cacheWriteTokens =
    ((cacheCreation as Record<string, number>).ephemeral_5m_input_tokens ?? 0) +
    ((cacheCreation as Record<string, number>).ephemeral_1h_input_tokens ?? 0);

  // Estimate cost
  const costEstimate = estimateCost(modelId, {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheWriteTokens,
    cache_read_input_tokens: cacheReadTokens,
  });

  const toolCallsList = Array.from(stats.toolCalls.entries())
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 10)
    .map(([name, { count, errors }]) => ({
      name,
      calls: count,
      ...(errors > 0 ? { errors } : {}),
    }));

  const outcomes = session.outcome_evaluations ?? [];

  return {
    session_id: session.id,
    agent_name: agentName,
    model: modelId,
    status: session.status,
    duration_seconds: durationSeconds,
    active_seconds: activeSeconds,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_write_tokens: cacheWriteTokens,
      cache_read_tokens: cacheReadTokens,
      total_tokens: inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens,
    },
    cost: costEstimate,
    model_calls: stats.byType["span.model_request_end"] ?? 0,
    event_count: stats.total,
    event_counts_by_type: stats.byType,
    tool_calls: includeToolDetails ? toolCallsList : toolCallsList.slice(0, 5),
    errors: stats.errorEvents.length > 0 ? stats.errorEvents.slice(0, 10) : null,
    highlights: stats.highlights,
    outcomes: outcomes.length > 0 ? outcomes : null,
    // Derived metrics — for decision-making, not debugging
    derived_metrics: buildDerivedMetrics(
      costEstimate.estimated_cost_usd,
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      toolCallsList
    ),
    narrative:
      outcomes.length > 0
        ? `Session ran in outcome-oriented mode. Final result: ${outcomes[outcomes.length - 1].result}.`
        : `Session ${session.status}. ${stats.total} events, ${stats.toolCalls.size} distinct tools called. Estimated cost: $${costEstimate.estimated_cost_usd}.`,
    // The agent's final response text — the main thing callers want
    final_output: stats.finalOutput,
    final_output_truncated: stats.finalOutputTruncated,
  };
}

function buildDerivedMetrics(
  totalCostUsd: number,
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number,
  toolCalls: Array<{ name: string; calls: number }>
): Record<string, unknown> {
  const totalInputSide = inputTokens + cacheWriteTokens + cacheReadTokens;

  // Cache hit rate: what fraction of input-side tokens were served from cache
  const cacheHitRate = totalInputSide > 0
    ? round(cacheReadTokens / totalInputSide, 2)
    : null;

  // Cache write-to-read cost ratio
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * 3.75; // Sonnet default
  const cacheReadCost = (cacheReadTokens / 1_000_000) * 0.30;
  const cacheWriteToReadRatio = cacheReadCost > 0
    ? round(cacheWriteCost / cacheReadCost, 1)
    : null;

  // Cost per search (web_search + web_fetch tool calls)
  const searchCalls = toolCalls
    .filter((t) => t.name === "web_search" || t.name === "web_fetch")
    .reduce((sum, t) => sum + t.calls, 0);
  const costPerSearch = searchCalls > 0
    ? round(totalCostUsd / searchCalls, 4)
    : null;

  // Cost per 1K output tokens (blended — includes all cache overhead)
  const costPer1kOutput = outputTokens > 0
    ? round((totalCostUsd / outputTokens) * 1000, 4)
    : null;

  // Total tool calls
  const totalToolCalls = toolCalls.reduce((sum, t) => sum + t.calls, 0);
  const costPerToolCall = totalToolCalls > 0
    ? round(totalCostUsd / totalToolCalls, 4)
    : null;

  return {
    cache_hit_rate: cacheHitRate,
    cache_write_to_read_ratio: cacheWriteToReadRatio,
    cost_per_search_usd: costPerSearch,
    cost_per_1k_output_tokens_usd: costPer1kOutput,
    cost_per_tool_call_usd: costPerToolCall,
    total_tool_calls: totalToolCalls,
    total_searches: searchCalls > 0 ? searchCalls : undefined,
  };
}

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// =============================================================================
// claudeagent_get_session_output
// =============================================================================

/** Max chars per response for get_session_output — higher than the global 25K limit */
const OUTPUT_CHUNK_SIZE = 80_000;

const GetSessionOutputInputSchema = z.object({
  session_id: SessionIdSchema,
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Character offset to start from (default: 0). For paginating long outputs: " +
      "if the response has truncated=true, call again with offset=<offset + length of returned text> to get the next chunk."
    ),
  response_format: ResponseFormatSchema,
});

function registerGetSessionOutput(
  server: McpServer,
  getAccessToken: () => string | undefined
): void {
  registerTool(server, {
    name: "claudeagent_get_session_output",
    description: `Get the agent's final response text from a completed session.

This is the "happy path" tool — it returns what the agent said, nothing else. No event metadata, no tool call logs, no token counts. Use this after the session reaches "idle" status to retrieve the agent's deliverable.

Supports pagination for long outputs: if has_more=true in the response, call again with offset=next_offset to get the next chunk. Each chunk is up to ~80K characters.

For monitoring data (event counts, tool usage, duration), use claudeagent_summarize_session instead.

Args:
  - session_id (string, required): A completed session
  - offset (number, default: 0): Character offset for pagination. Pass next_offset from a previous response to continue.
  - response_format ('markdown' | 'json')

Returns:
  The agent's response text (or a chunk of it), plus total_length, offset, chunk_length, has_more, and next_offset for pagination.

Error Handling:
  - Returns NOT_FOUND if session_id doesn't exist
  - Returns STILL_RUNNING if the session hasn't finished yet — call get_session first to check status`,
    inputSchema: GetSessionOutputInputSchema,
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
        // Check session status first
        const session = await apiGet<Session>(
          getAccessToken()!,
          `/v1/sessions/${encodeURIComponent(session_id)}`
        );

        if (session.status === "running" || session.status === "rescheduling") {
          return createErrorResponse(
            "STILL_RUNNING",
            `Session ${session_id} is still ${session.status}. Wait for status "idle" before retrieving output. Use claudeagent_get_session to poll for completion.`
          );
        }

        // Fetch all events and extract the final agent.message
        const events = await fetchAllSessionEvents(getAccessToken()!, session_id);
        const stats = analyzeEvents(events);

        if (!stats.finalOutput) {
          return createSuccessResponse(
            {
              session_id,
              status: session.status,
              output: null,
              message: "No agent output found in this session. The agent may not have produced a text response.",
            },
            response_format,
            { title: "Session Output" }
          );
        }

        // Paginate the output — return a chunk starting at offset
        const { offset } = params;
        const fullLength = stats.finalOutput.length;
        const chunk = stats.finalOutput.slice(offset, offset + OUTPUT_CHUNK_SIZE);
        const hasMore = offset + chunk.length < fullLength;

        // Return the text directly as an MCP content block to bypass the
        // global 25K CHARACTER_LIMIT truncation in createSuccessResponse.
        // This tool's job is to return the agent's output verbatim.
        return {
          content: [{ type: "text" as const, text: chunk }],
          structuredContent: {
            session_id,
            status: session.status,
            total_length: fullLength,
            offset,
            chunk_length: chunk.length,
            has_more: hasMore,
            ...(hasMore
              ? { next_offset: offset + chunk.length }
              : {}),
          },
        };
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_get_session_output failed", { error: err, session_id });
        return createErrorResponse(
          "API_ERROR",
          formatApiError(err, "get session output")
        );
      }
    },
  });
}

// =============================================================================
// claudeagent_summarize_session
// =============================================================================

function registerSummarizeSession(
  server: McpServer,
  getAccessToken: () => string | undefined
): void {
  registerTool(server, {
    name: "claudeagent_summarize_session",
    description: `Summarize a session with metadata AND the agent's final output.

Fetches the full event history, usage data, errors, outcome evaluations, and tool call patterns, then generates a concise markdown summary covering: what the session was doing, how it ended, total cost and duration, any errors, key tool calls, and the outcome evaluation verdict if present.

Use this when the user wants to understand what happened in a session without reading every raw event. Pair with claudeagent_run_task for a one-shot "run and summarize" flow.

Args:
  - session_id (string, required)
  - include_tool_details (boolean, default: false): Include per-tool-call breakdown
  - response_format ('markdown' | 'json')

Returns:
  Markdown summary with: session ID, agent name, status, duration, usage, narrative paragraph, tool call summary, errors, and outcome evaluations if any.

Error Handling:
  - Returns NOT_FOUND if session_id doesn't exist`,
    inputSchema: SummarizeSessionInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { session_id, include_tool_details, response_format } = params;
      try {
        const session = await apiGet<Session>(
          getAccessToken()!,
          `/v1/sessions/${encodeURIComponent(session_id)}`
        );
        const events = await fetchAllSessionEvents(getAccessToken()!, session_id);
        const stats = analyzeEvents(events);
        const summary = buildSummaryMarkdown(session, stats, include_tool_details);

        return createSuccessResponse(summary, response_format, {
          title: `Session Summary: ${session_id}`,
        });
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_summarize_session failed", { error: err, session_id });
        return createErrorResponse(
          "API_ERROR",
          formatApiError(err, "summarize session")
        );
      }
    },
  });
}

// =============================================================================
// claudeagent_find_anomalies
// =============================================================================

const FindAnomaliesInputSchema = z.object({
  agent_id: AgentIdSchema.optional().describe("Limit to a specific agent"),
  since: z
    .string()
    .datetime()
    .optional()
    .describe("ISO 8601 timestamp. Default: 24 hours ago"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe("Max sessions to analyze (default: 100)"),
  response_format: ResponseFormatSchema,
});

interface AnomalyResult {
  session_id: string;
  agent_name: string;
  reason: string;
  cost_usd: number | null;
  duration_seconds: number | null;
  status: string;
}

function registerFindAnomalies(
  server: McpServer,
  getAccessToken: () => string | undefined
): void {
  registerTool(server, {
    name: "claudeagent_find_anomalies",
    description: `Find anomalous sessions in the recent history.

Fetches recent sessions, computes baseline statistics per agent (typical duration, token usage, error rate), and flags sessions that deviate significantly. Returns a ranked list of anomalies with an explanation of why each was flagged.

This is a pure statistical heuristic — no LLM calls, no custom scoring. Good for quick health checks. For deeper analysis, use claudeagent_summarize_session on specific flagged sessions.

Args:
  - agent_id (string, optional): Limit to a specific agent
  - since (ISO 8601, optional): Default 24 hours ago
  - limit (number, 1-500, default: 100): Max sessions to analyze
  - response_format ('markdown' | 'json')

Returns:
  Markdown list of flagged sessions with reason, cost, duration, and session_id.`,
    inputSchema: FindAnomaliesInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { agent_id, since, limit, response_format } = params;
      const sinceIso = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      try {
        // Note: Anthropic uses bracket notation for date filters
        const sessionsResponse = await apiGet<ListResponse<Session>>(
          getAccessToken()!,
          "/v1/sessions",
          {
            agent_id,
            "created_at[gte]": sinceIso,
            limit,
            order: "desc",
          }
        );
        const sessions = sessionsResponse.data;

        if (sessions.length === 0) {
          return createSuccessResponse(
            {
              analyzed: 0,
              anomalies: [],
              window_since: sinceIso,
              message: "No sessions found in the requested window.",
            },
            response_format,
            { title: "Anomaly Detection" }
          );
        }

        // Group by agent
        const byAgent = new Map<string, Session[]>();
        for (const session of sessions) {
          const agentKey =
            typeof session.agent === "object" && session.agent !== null
              ? (session.agent as { id?: string }).id ?? "unknown"
              : String(session.agent);
          const list = byAgent.get(agentKey) ?? [];
          list.push(session);
          byAgent.set(agentKey, list);
        }

        const anomalies: AnomalyResult[] = [];

        for (const [agentKey, group] of byAgent.entries()) {
          if (group.length < 3) continue; // Need at least 3 sessions to compute baseline

          const durations = group
            .map((s) => s.stats?.active_seconds ?? 0)
            .filter((d) => d > 0)
            .sort((a, b) => a - b);
          const tokens = group
            .map(
              (s) => (s.usage?.input_tokens ?? 0) + (s.usage?.output_tokens ?? 0)
            )
            .filter((t) => t > 0)
            .sort((a, b) => a - b);

          const p95Duration =
            durations.length > 0
              ? durations[Math.floor(durations.length * 0.95)]
              : 0;
          const p95Tokens = tokens.length > 0 ? tokens[Math.floor(tokens.length * 0.95)] : 0;

          const agentName =
            typeof group[0].agent === "object" && group[0].agent !== null && "name" in group[0].agent
              ? (group[0].agent as { name: string }).name
              : agentKey;

          for (const session of group) {
            const reasons: string[] = [];

            // 1. Terminated state
            if (session.status === "terminated") {
              reasons.push("session terminated (non-idle)");
            }

            // 2. Duration > p95 * 1.5
            const dur = session.stats?.active_seconds ?? 0;
            if (p95Duration > 0 && dur > p95Duration * 1.5) {
              reasons.push(
                `duration ${dur.toFixed(0)}s > 1.5× p95 (${p95Duration.toFixed(0)}s)`
              );
            }

            // 3. Token usage > p95 * 1.5
            const tok = (session.usage?.input_tokens ?? 0) + (session.usage?.output_tokens ?? 0);
            if (p95Tokens > 0 && tok > p95Tokens * 1.5) {
              reasons.push(
                `token usage ${tok} > 1.5× p95 (${p95Tokens.toFixed(0)})`
              );
            }

            if (reasons.length > 0) {
              anomalies.push({
                session_id: session.id,
                agent_name: agentName,
                reason: reasons.join("; "),
                cost_usd: null,
                duration_seconds: dur,
                status: session.status,
              });
            }
          }
        }

        // Sort anomalies by severity heuristic: terminated first, then by how many reasons
        anomalies.sort((a, b) => {
          const aScore = (a.status === "terminated" ? 10 : 0) + a.reason.split(";").length;
          const bScore = (b.status === "terminated" ? 10 : 0) + b.reason.split(";").length;
          return bScore - aScore;
        });

        return createSuccessResponse(
          {
            analyzed: sessions.length,
            window_since: sinceIso,
            anomalies_found: anomalies.length,
            anomalies: anomalies.slice(0, 20),
          },
          response_format,
          { title: "Anomaly Detection" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_find_anomalies failed", { error: err });
        return createErrorResponse("API_ERROR", formatApiError(err, "find anomalies"));
      }
    },
  });
}

// =============================================================================
// claudeagent_run_task — THE HERO TOOL
// =============================================================================

const RunTaskInputSchema = z.object({
  agent_id: AgentIdSchema,
  environment_id: EnvironmentIdSchema,
  user_message: z.string().min(1).describe("What the agent should do"),
  files: z.array(FileUploadSpecSchema).optional(),
  title: z.string().max(256).optional(),
  wait: z
    .boolean()
    .default(false)
    .describe(
      "If false (default), creates the session and sends the message, then returns immediately with the session_id — use claudeagent_get_session to poll for completion and claudeagent_summarize_session to get the result. " +
      "If true, blocks until the agent finishes (streaming progress notifications), then returns the full summary. Use wait=true only in stdio mode (Claude Desktop/Cursor) where long-lived connections are fine."
    ),
  timeout_seconds: z
    .number()
    .int()
    .min(30)
    .max(1800)
    .default(600)
    .describe("Max wait time when wait=true (default: 600 = 10 min, max: 1800 = 30 min). Ignored when wait=false."),
  include_tool_details: z.boolean().default(false),
  response_format: ResponseFormatSchema,
});

function registerRunTask(
  server: McpServer,
  getAccessToken: () => string | undefined
): void {
  registerTool(server, {
    name: "claudeagent_run_task",
    description: `Start an agent task — creates a session, sends a message, and returns.

By default (wait=false), returns immediately after the agent starts working, with the session_id for tracking. Use claudeagent_get_session to poll for completion (status changes to "idle"), then claudeagent_summarize_session to get the result. This async mode is efficient and scalable.

With wait=true, blocks until the agent finishes, streaming progress notifications. Only use wait=true in local stdio mode (Claude Desktop/Cursor) where long-lived connections are fine — never in HTTP/cloud mode.

Args:
  - agent_id (string, required): ID of an existing agent
  - environment_id (string, required): ID of an existing environment
  - user_message (string, required): What the agent should do
  - files (array, optional): File attachments, each with {name, content_base64, mime_type}
  - title (string, optional): Session title
  - wait (boolean, default: false): If false, returns immediately after starting. If true, blocks until completion.
  - timeout_seconds (number, 30-1800, default: 600): Max wait time when wait=true. Ignored when wait=false.
  - include_tool_details (boolean, default: false): Include per-tool-call breakdown (only with wait=true)
  - response_format ('markdown' | 'json')

Returns (wait=false):
  session_id, status "running", and next_steps with the exact tool calls to check status and get results.

Returns (wait=true):
  Full summary with agent output, tool calls, tokens, and status.

Examples:
  - Start async (recommended): {"agent_id": "agent_01abc", "environment_id": "env_01xyz", "user_message": "Research the 2008 financial crisis"}
  - Start and wait: {"agent_id": "agent_01abc", "environment_id": "env_01xyz", "user_message": "What is 2+2?", "wait": true}

Error Handling:
  - Returns AUTH_REQUIRED if no API key is configured
  - Returns NOT_FOUND if agent_id or environment_id doesn't exist`,
    inputSchema: RunTaskInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (params, extra): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const {
        agent_id,
        environment_id,
        user_message,
        files,
        title,
        wait,
        timeout_seconds,
        include_tool_details,
        response_format,
      } = params;

      let sessionId: string | undefined;
      try {
        // --- Step 1: create the session ---
        await sendProgress(extra, 1, "Creating session...");
        const session = await apiPost<Session>(
          getAccessToken()!,
          "/v1/sessions",
          {
            agent: agent_id,
            environment_id,
            ...(title ? { title } : {}),
          }
        );
        sessionId = session.id;

        // --- Step 2: send the user message ---
        await sendProgress(extra, 2, "Sending user message...");
        const content: Record<string, unknown>[] = [{ type: "text", text: user_message }];
        if (files) {
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
        await apiPost(
          getAccessToken()!,
          `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
          {
            events: [{ type: "user.message", content }],
          }
        );

        // --- Async mode (default): return immediately ---
        if (!wait) {
          return createSuccessResponse(
            {
              session_id: sessionId,
              status: "running",
              mode: "async",
              agent_id,
              environment_id,
              message_preview: user_message.slice(0, 200),
              next_steps: [
                `Check status: call claudeagent_get_session(session_id: "${sessionId}")`,
                `When status is "idle", get results: call claudeagent_summarize_session(session_id: "${sessionId}")`,
                `To stop early: call claudeagent_interrupt_session(session_id: "${sessionId}")`,
              ],
            },
            response_format,
            { title: "Task Started (Async)" }
          );
        }

        // --- Sync mode (wait=true): stream + wait for idle ---
        const streamResult = await runStreamLoop(
          {
            accessToken: getAccessToken()!,
            sessionId,
            timeoutSeconds: timeout_seconds,
            includeThinking: false,
            stopOnIdle: true,
          },
          extra
        );

        // Handle timeout case
        if (streamResult.status === "timeout") {
          const lastEvent = streamResult.accumulatedLog[streamResult.accumulatedLog.length - 1];
          return createSuccessResponse(
            {
              session_id: sessionId,
              status: "still_running",
              elapsed_seconds: Math.round(streamResult.elapsedMs / 1000),
              events_observed: streamResult.eventsReceived,
              last_event: lastEvent?.summary ?? null,
              next_step: `Session is still running. Call claudeagent_get_session(session_id: "${sessionId}") to check status, or claudeagent_summarize_session(session_id: "${sessionId}") for a partial summary.`,
            },
            response_format,
            { title: "Task Still Running (Timeout)" }
          );
        }

        // Summarize the final result
        await sendProgress(
          extra,
          streamResult.progressSent + 1,
          "Generating summary..."
        );
        const finalSession = await apiGet<Session>(
          getAccessToken()!,
          `/v1/sessions/${encodeURIComponent(sessionId)}`
        );
        const events = await fetchAllSessionEvents(getAccessToken()!, sessionId);
        const stats = analyzeEvents(events);
        const summary = buildSummaryMarkdown(finalSession, stats, include_tool_details);

        return createSuccessResponse(
          {
            ...summary,
            elapsed_seconds: Math.round(streamResult.elapsedMs / 1000),
            task_status: streamResult.status,
            stop_reason: streamResult.stopReason,
          },
          response_format,
          { title: "Task Complete" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_run_task failed", { error: err, agent_id, sessionId });

        // Categorize the error and always include session_id if we have one
        const { ApiError: _ApiError } = await import("../../services/api-client.js");
        let errorCode = "API_ERROR";
        let suggestion = "";

        if (err instanceof _ApiError) {
          switch (err.statusCode) {
            case 401:
              errorCode = "AUTH_REQUIRED";
              suggestion = "Your Anthropic API key may be invalid or expired.";
              break;
            case 404:
              errorCode = "NOT_FOUND";
              suggestion = "Check that agent_id and environment_id are valid.";
              break;
            case 429:
              errorCode = "RATE_LIMITED";
              suggestion = "Anthropic rate limit hit. Wait a moment and try again.";
              break;
            default:
              suggestion = "Check the Anthropic API status or try again.";
          }
        } else if (err instanceof Error && err.message.includes("aborted")) {
          errorCode = "TIMEOUT";
          suggestion = sessionId
            ? `Session may still be running. Use claudeagent_get_session(session_id: "${sessionId}") to check status.`
            : "The request timed out before completing.";
        }

        return createErrorResponse(
          errorCode,
          JSON.stringify({
            error: errorCode,
            message: formatApiError(err, "run task"),
            ...(sessionId ? { session_id: sessionId } : {}),
            ...(suggestion ? { suggestion } : {}),
          })
        );
      }
    },
  });
}

// =============================================================================
// Registration entry point
// =============================================================================

export function registerSmartTools(
  server: McpServer,
  getAccessToken: () => string | undefined
): void {
  registerGetSessionOutput(server, getAccessToken);
  registerSummarizeSession(server, getAccessToken);
  registerFindAnomalies(server, getAccessToken);
  registerRunTask(server, getAccessToken);
}
