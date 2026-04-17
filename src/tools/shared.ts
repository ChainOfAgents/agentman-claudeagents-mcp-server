/**
 * Shared helpers for tool registration.
 *
 * All tool category modules (agents.ts, environments.ts, sessions.ts, etc.)
 * use these helpers to register tools with consistent error handling,
 * response formatting, and Zod input validation.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z, ZodObject, ZodRawShape } from "zod";

import { ResponseFormat, CHARACTER_LIMIT } from "../constants.js";
import { logger } from "../utils/logger.js";
import { formatResponse, createPaginationInfo, formatPaginationFooter } from "../utils/response.js";

// =============================================================================
// Request handler extras (passed to every tool handler)
// =============================================================================

/**
 * Extra context the MCP SDK passes to every tool handler.
 * Tools that need to emit progress notifications or respect cancellation
 * use this type for their second parameter.
 */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// =============================================================================
// Typed tool registration wrapper
// =============================================================================

export interface ToolConfig<T extends ZodRawShape> {
  name: string;
  description: string;
  inputSchema: ZodObject<T>;
  annotations: ToolAnnotations;
  handler: (
    params: z.infer<ZodObject<T>>,
    extra: ToolExtra
  ) => Promise<CallToolResult>;
}

/**
 * Register a tool with the MCP server using a typed wrapper that provides:
 *   - Automatic Zod schema validation at runtime
 *   - Type-safe handler parameters
 *   - Access to the MCP SDK's RequestHandlerExtra (for progress notifications,
 *     abort signals, etc.) as the handler's second argument
 *   - Structured tool metadata
 */
export function registerTool<T extends ZodRawShape>(
  server: McpServer,
  config: ToolConfig<T>
): void {
  const { name, description, inputSchema, annotations, handler } = config;

  (server as unknown as {
    tool: (
      name: string,
      description: string,
      schema: Record<string, unknown>,
      annotations: ToolAnnotations,
      handler: (args: unknown, extra: ToolExtra) => Promise<CallToolResult>
    ) => void;
  }).tool(
    name,
    description,
    inputSchema.shape,
    annotations,
    async (args: unknown, extra: ToolExtra): Promise<CallToolResult> => {
      const parseResult = inputSchema.safeParse(args);
      if (!parseResult.success) {
        const errorMessage = parseResult.error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", ");
        return createErrorResponse("INVALID_PARAMS", `Invalid parameters: ${errorMessage}`);
      }
      try {
        const result = await handler(parseResult.data, extra);
        // Log tool completion for observability
        const isError = result.isError ?? false;
        const contentPreview = result.content?.[0]?.type === "text"
          ? (result.content[0] as { text: string }).text.slice(0, 200)
          : "(non-text)";
        logger.info(`Tool ${name} completed`, { isError, preview: contentPreview });
        return result;
      } catch (err) {
        // Re-throw AuthExpiredError so the HTTP layer can convert to 401
        if (err && typeof err === "object" && "name" in err && err.name === "AuthExpiredError") {
          throw err;
        }
        logger.error(`Tool ${name} threw an unhandled error`, { error: err });
        return createErrorResponse(
          "INTERNAL_ERROR",
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  );
}

// =============================================================================
// Progress notification helper
// =============================================================================

/**
 * Send a progress notification from inside a tool handler.
 *
 * Does nothing (silently) if the client didn't provide a progressToken in
 * the original request, so tools can always call this without checking first.
 *
 * @param extra The RequestHandlerExtra from the tool handler
 * @param progress Numeric progress counter (monotonically increasing)
 * @param message Short human-readable message (< 200 chars recommended)
 * @param total Optional estimated total (enables progress bar rendering)
 */
export async function sendProgress(
  extra: ToolExtra,
  progress: number,
  message: string,
  total?: number
): Promise<void> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined || progressToken === null) {
    // Client didn't request progress; silently skip
    return;
  }
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
        ...(total !== undefined ? { total } : {}),
        message,
      },
    });
  } catch (err) {
    // Progress notifications are best-effort — if the transport is gone,
    // don't fail the tool.
    logger.debug("Failed to send progress notification", { err });
  }
}

// =============================================================================
// Response helpers
// =============================================================================

export interface SuccessOptions {
  title?: string;
  pagination?: ReturnType<typeof createPaginationInfo>;
}

/**
 * Build a successful tool response with both text (markdown or JSON) and
 * structured content.
 */
export function createSuccessResponse(
  data: Record<string, unknown>,
  format: ResponseFormat = ResponseFormat.MARKDOWN,
  options: SuccessOptions = {}
): CallToolResult {
  const formatted = formatResponse(data, format, { title: options.title });

  let text = formatted.text;
  if (format === ResponseFormat.MARKDOWN && options.pagination) {
    text += formatPaginationFooter(options.pagination);
  }

  if (formatted.wasTruncated) {
    logger.warn("Response truncated", {
      originalLength: formatted.originalLength,
      limit: CHARACTER_LIMIT,
    });
  }

  return {
    content: [{ type: "text" as const, text }],
    structuredContent: data,
  };
}

/**
 * Build an error response. Always emits isError: true so MCP clients know
 * to surface this as an error rather than normal content.
 */
export function createErrorResponse(code: string, message: string): CallToolResult {
  const error = { error: code, message };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(error, null, 2) }],
    structuredContent: error,
    isError: true,
  };
}

/**
 * Standard auth-required check. Returns an error response if the token is
 * missing, otherwise returns null and the caller proceeds with the token.
 */
export function requireAuth(accessToken: string | undefined): CallToolResult | null {
  if (!accessToken) {
    return createErrorResponse(
      "AUTH_REQUIRED",
      "Authentication required. Set ANTHROPIC_API_KEY (stdio mode) or pass an Authorization: Bearer <key> header (HTTP mode)."
    );
  }
  return null;
}
