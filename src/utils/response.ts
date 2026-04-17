/**
 * Response Formatting Utilities
 *
 * Provides standardized response formatting for MCP tool outputs
 * following the MCP 2025-11-25 best practices.
 *
 * Supports:
 * - Markdown format (default) for LLM consumption
 * - JSON format for structured data
 * - Character limit enforcement with truncation
 * - Pagination metadata formatting
 */

import {
  CHARACTER_LIMIT,
  TRUNCATION_INDICATOR,
  ResponseFormat,
} from "../constants.js";

// Re-export for convenience
export { CHARACTER_LIMIT, ResponseFormat };

export interface PaginationInfo {
  /** Total number of items available */
  total: number;
  /** Number of items in current response */
  count: number;
  /** Current offset/page position */
  offset: number;
  /** Limit used for this request */
  limit: number;
  /** Whether more items are available */
  hasMore: boolean;
}

export interface FormattedResponse {
  /** The formatted text content */
  text: string;
  /** Whether the content was truncated */
  wasTruncated: boolean;
  /** Original length before truncation */
  originalLength: number;
}

// =============================================================================
// Response Formatting
// =============================================================================

/**
 * Format data for tool response
 *
 * @param data The data to format
 * @param format Output format (markdown or json)
 * @param options Additional formatting options
 * @returns Formatted response with truncation info
 *
 * @example
 * // Markdown format (default)
 * const response = formatResponse({ name: "Item 1", id: "123" }, "markdown");
 *
 * // JSON format
 * const response = formatResponse({ name: "Item 1", id: "123" }, "json");
 */
export function formatResponse(
  data: unknown,
  format: ResponseFormat = ResponseFormat.MARKDOWN,
  options: {
    /** Custom character limit (defaults to CHARACTER_LIMIT) */
    limit?: number;
    /** Title for markdown output */
    title?: string;
  } = {}
): FormattedResponse {
  const limit = options.limit ?? CHARACTER_LIMIT;

  let text: string;

  if (format === ResponseFormat.JSON) {
    text = JSON.stringify(data, null, 2);
  } else {
    text = formatAsMarkdown(data, options.title);
  }

  return truncateIfNeeded(text, limit);
}

/**
 * Format data as markdown for LLM consumption
 */
function formatAsMarkdown(data: unknown, title?: string): string {
  const lines: string[] = [];

  if (title) {
    lines.push(`## ${title}\n`);
  }

  if (data === null || data === undefined) {
    return lines.join("") + "_No data_";
  }

  if (typeof data === "string") {
    return lines.join("") + data;
  }

  if (typeof data === "number" || typeof data === "boolean") {
    return lines.join("") + String(data);
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return lines.join("") + "_No items_";
    }

    // Format array items
    data.forEach((item, index) => {
      if (typeof item === "object" && item !== null) {
        lines.push(`### Item ${index + 1}\n`);
        lines.push(formatObject(item as Record<string, unknown>));
        lines.push("");
      } else {
        lines.push(`- ${String(item)}`);
      }
    });

    return lines.join("\n");
  }

  if (typeof data === "object") {
    return lines.join("") + formatObject(data as Record<string, unknown>);
  }

  return lines.join("") + String(data);
}

/**
 * Format an object as markdown key-value pairs
 */
function formatObject(obj: Record<string, unknown>, indent = 0): string {
  const lines: string[] = [];
  const prefix = "  ".repeat(indent);

  for (const [key, value] of Object.entries(obj)) {
    const formattedKey = formatKey(key);

    if (value === null || value === undefined) {
      lines.push(`${prefix}- **${formattedKey}:** _none_`);
    } else if (typeof value === "object" && !Array.isArray(value)) {
      lines.push(`${prefix}- **${formattedKey}:**`);
      lines.push(formatObject(value as Record<string, unknown>, indent + 1));
    } else if (Array.isArray(value)) {
      lines.push(`${prefix}- **${formattedKey}:** ${value.length} items`);
      if (value.length > 0 && value.length <= 5) {
        value.forEach((item) => {
          if (typeof item === "object" && item !== null) {
            lines.push(formatObject(item as Record<string, unknown>, indent + 1));
          } else {
            lines.push(`${prefix}  - ${String(item)}`);
          }
        });
      }
    } else {
      lines.push(`${prefix}- **${formattedKey}:** ${String(value)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format a key for display (snake_case to Title Case)
 */
function formatKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// =============================================================================
// Truncation
// =============================================================================

/**
 * Truncate content if it exceeds the character limit
 */
function truncateIfNeeded(text: string, limit: number): FormattedResponse {
  const originalLength = text.length;

  if (originalLength <= limit) {
    return {
      text,
      wasTruncated: false,
      originalLength,
    };
  }

  // Reserve space for truncation indicator
  const truncateAt = limit - TRUNCATION_INDICATOR.length;

  // Try to truncate at a natural break point
  let cutPoint = truncateAt;

  // Look for paragraph break
  const lastParagraph = text.lastIndexOf("\n\n", truncateAt);
  if (lastParagraph > truncateAt * 0.7) {
    cutPoint = lastParagraph;
  } else {
    // Look for line break
    const lastLine = text.lastIndexOf("\n", truncateAt);
    if (lastLine > truncateAt * 0.8) {
      cutPoint = lastLine;
    }
  }

  return {
    text: text.slice(0, cutPoint) + TRUNCATION_INDICATOR,
    wasTruncated: true,
    originalLength,
  };
}

// =============================================================================
// Pagination Helpers
// =============================================================================

/**
 * Create pagination metadata from response data
 *
 * @param options Pagination parameters
 * @returns Formatted pagination info
 *
 * @example
 * const pagination = createPaginationInfo({
 *   total: 100,
 *   count: 20,
 *   offset: 0,
 *   limit: 20,
 * });
 */
export function createPaginationInfo(options: {
  total: number;
  count: number;
  offset: number;
  limit: number;
}): PaginationInfo {
  const { total, count, offset, limit } = options;

  return {
    total,
    count,
    offset,
    limit,
    hasMore: offset + count < total,
  };
}

/**
 * Format pagination info as markdown footer
 */
export function formatPaginationFooter(pagination: PaginationInfo): string {
  const { total, count, offset, hasMore } = pagination;

  const start = offset + 1;
  const end = offset + count;

  let footer = `\n---\nShowing ${start}-${end} of ${total} items`;

  if (hasMore) {
    footer += ` | Use \`offset: ${offset + count}\` to see more`;
  }

  return footer;
}

/**
 * Calculate pagination values for API requests
 */
export function calculatePagination(
  requestedLimit?: number,
  requestedOffset?: number,
  maxLimit = 100,
  defaultLimit = 20
): { limit: number; offset: number } {
  const limit = Math.min(Math.max(1, requestedLimit ?? defaultLimit), maxLimit);
  const offset = Math.max(0, requestedOffset ?? 0);

  return { limit, offset };
}

// =============================================================================
// Error Response Formatting
// =============================================================================

/**
 * Format an error for tool response
 */
export function formatErrorResponse(
  code: string,
  message: string,
  details?: unknown
): FormattedResponse {
  const errorData = {
    error: code,
    message,
    ...(details ? { details } : {}),
  };

  return {
    text: JSON.stringify(errorData, null, 2),
    wasTruncated: false,
    originalLength: 0,
  };
}
