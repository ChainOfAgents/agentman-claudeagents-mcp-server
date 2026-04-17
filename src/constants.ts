/**
 * Shared Constants
 *
 * Centralized constants for the MCP server following mcp-builder best practices.
 */

// =============================================================================
// Response Limits
// =============================================================================

/**
 * Maximum character limit for tool responses.
 * Prevents context overflow in LLM conversations.
 */
export const CHARACTER_LIMIT = 25000;

/**
 * Truncation indicator appended when content exceeds limit.
 */
export const TRUNCATION_INDICATOR =
  "\n\n... [Content truncated due to length. Use pagination or filters to get more specific results.]";

// =============================================================================
// Pagination Defaults
// =============================================================================

/**
 * Default number of items to return in list operations.
 */
export const DEFAULT_PAGE_LIMIT = 20;

/**
 * Maximum number of items allowed per request.
 */
export const MAX_PAGE_LIMIT = 100;

// =============================================================================
// Response Formats
// =============================================================================

/**
 * Supported response formats for tool outputs.
 */
export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

// =============================================================================
// API Configuration
// =============================================================================

/**
 * Default timeout for API requests in milliseconds.
 */
export const API_TIMEOUT_MS = 30000;

/**
 * Request ID header name for distributed tracing.
 */
export const REQUEST_ID_HEADER = "x-agentman-request-id";

// =============================================================================
// MCP Protocol
// =============================================================================

/**
 * MCP protocol version supported by this server.
 */
export const MCP_PROTOCOL_VERSION = "2025-11-25";
