/**
 * Claude Managed Agents — shared Zod schemas
 *
 * These schemas define the shape of inputs and outputs specific to the
 * Anthropic Managed Agents API. They're used across all 28 tools in
 * agentman-claudeagents-mcp-server.
 *
 * The schemas intentionally mirror the Managed Agents REST API shape so
 * the Zod types can be passed almost directly to the Anthropic API with
 * minimal translation.
 */

import { z } from "zod";

// =============================================================================
// Identifier schemas
// =============================================================================

/**
 * Claude Managed Agents agent ID.
 * Format: "agent_..." (alphanumeric with underscores)
 */
export const AgentIdSchema = z
  .string()
  .min(1, "agent_id is required")
  .max(100, "agent_id too long")
  .describe("Claude Managed Agents agent ID, e.g., 'agent_01ab...'");

/**
 * Claude Managed Agents environment ID.
 * Format: "env_..."
 */
export const EnvironmentIdSchema = z
  .string()
  .min(1, "environment_id is required")
  .max(100, "environment_id too long")
  .describe("Environment ID, e.g., 'env_01ab...'");

/**
 * Claude Managed Agents session ID.
 * Format: "sesn_..." or "sess_..."
 */
export const SessionIdSchema = z
  .string()
  .min(1, "session_id is required")
  .max(100, "session_id too long")
  .describe("Session ID, e.g., 'sesn_01ab...'");

/**
 * Thread ID for multi-agent sessions.
 */
export const ThreadIdSchema = z
  .string()
  .min(1, "thread_id is required")
  .max(100, "thread_id too long")
  .describe("Session thread ID (multi-agent only)");

/**
 * Tool use ID from an agent.tool_use event.
 * Used when confirming or responding to tool calls that required client action.
 */
export const ToolUseIdSchema = z
  .string()
  .min(1, "tool_use_id is required")
  .max(100, "tool_use_id too long")
  .describe("Tool use ID from an agent.tool_use event");

// =============================================================================
// Pagination (Anthropic-specific — uses opaque cursor strings, not offset)
// =============================================================================

/**
 * Anthropic-style pagination parameters.
 * Unlike the template's offset-based PaginationSchema, Anthropic uses
 * opaque cursor tokens (`page`) returned in each response.
 */
export const AnthropicPaginationSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Max results to return (1-100, default: 20)"),
  page: z
    .string()
    .optional()
    .describe("Pagination cursor from a previous response"),
});

export type AnthropicPaginationParams = z.infer<typeof AnthropicPaginationSchema>;

// =============================================================================
// Agent schemas
// =============================================================================

/**
 * Model identifier (e.g., "claude-sonnet-4-6", "claude-haiku-4-5")
 */
export const ModelSchema = z
  .string()
  .min(1, "model is required")
  .max(100, "model identifier too long")
  .describe("Claude model identifier, e.g., 'claude-sonnet-4-6'");

/**
 * Agent system prompt.
 */
export const SystemPromptSchema = z
  .string()
  .max(100_000, "system prompt must not exceed 100,000 characters")
  .describe("System prompt for the agent");

/**
 * Agent description field.
 */
export const AgentDescriptionSchema = z
  .string()
  .max(2048, "description must not exceed 2048 characters")
  .describe("Human-readable description of the agent");

/**
 * Agent name field.
 */
export const AgentNameSchema = z
  .string()
  .min(1, "name is required")
  .max(256, "name must not exceed 256 characters")
  .describe("Display name for the agent");

/**
 * Tool configuration — a loosely-typed object because Anthropic's
 * tool schema has many variants (built-in tools, MCP toolsets, custom tools).
 * We accept any valid object and pass it through.
 */
export const ToolConfigSchema = z
  .record(z.string(), z.any())
  .describe("Tool configuration object (see Anthropic docs for schema)");

/**
 * MCP server configuration entry.
 */
export const McpServerConfigSchema = z
  .object({
    name: z.string(),
    type: z.enum(["http", "sse", "stdio"]).optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .passthrough()
  .describe("MCP server configuration entry");

/**
 * Skill configuration entry.
 */
export const SkillConfigSchema = z
  .record(z.string(), z.any())
  .describe("Skill configuration");

/**
 * Callable agent reference for multi-agent coordinator setups.
 */
export const CallableAgentSchema = z
  .object({
    type: z.literal("agent"),
    id: z.string(),
    version: z.number().int().positive(),
  })
  .describe("Reference to another agent this one can delegate to");

/**
 * Free-form metadata key-value pairs.
 */
export const MetadataSchema = z
  .record(z.string(), z.string())
  .describe("Key-value metadata");

/**
 * Metadata update schema — allows null values for deletion.
 */
export const MetadataUpdateSchema = z
  .record(z.string(), z.string().nullable())
  .describe("Metadata patch (set a value to null to delete the key)");

// =============================================================================
// Environment schemas
// =============================================================================

/**
 * Networking mode for environments.
 */
export const NetworkingTypeSchema = z
  .enum(["unrestricted", "limited"])
  .default("unrestricted")
  .describe("Network access policy for the environment container");

/**
 * Session status enum.
 */
export const SessionStatusSchema = z
  .enum(["running", "idle", "terminated", "rescheduling"])
  .describe("Session status");

// =============================================================================
// Event send schemas
// =============================================================================

/**
 * A single content block for a user message (text, image, document, etc.).
 * We accept a flexible shape and pass it through — Anthropic validates.
 */
export const MessageContentBlockSchema = z
  .record(z.string(), z.any())
  .describe("A content block for a user message");

/**
 * File upload spec used in send_user_message.
 */
export const FileUploadSpecSchema = z.object({
  name: z.string().describe("Filename"),
  content_base64: z.string().describe("Base64-encoded file content"),
  mime_type: z.string().optional().describe("MIME type, e.g., 'application/pdf'"),
});

export type FileUploadSpec = z.infer<typeof FileUploadSpecSchema>;

// =============================================================================
// Rubric schemas (for define_outcome)
// =============================================================================

/**
 * Inline rubric text.
 */
export const RubricTextSchema = z
  .object({
    type: z.literal("text"),
    content: z.string().min(1).describe("Markdown rubric text"),
  })
  .describe("Inline rubric");

/**
 * File-based rubric reference.
 */
export const RubricFileSchema = z
  .object({
    type: z.literal("file"),
    file_id: z.string().min(1).describe("File ID from the Files API"),
  })
  .describe("Rubric stored in the Files API");

export const RubricSchema = z.union([RubricTextSchema, RubricFileSchema]);
