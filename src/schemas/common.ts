/**
 * Common Zod Schemas
 *
 * Shared validation schemas used across multiple tools.
 * Following mcp-builder best practices for schema organization.
 */

import { z } from "zod";
import {
  ResponseFormat,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from "../constants.js";

// =============================================================================
// Response Format Schema
// =============================================================================

/**
 * Response format parameter - included in all tools.
 * Allows LLMs to request markdown (default) or JSON output.
 */
export const ResponseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe(
    "Output format: 'markdown' for human-readable or 'json' for machine-readable"
  );

// =============================================================================
// Pagination Schemas
// =============================================================================

/**
 * Standard pagination parameters for list operations.
 */
export const PaginationSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT)
    .describe(`Maximum results to return (1-${MAX_PAGE_LIMIT}, default: ${DEFAULT_PAGE_LIMIT})`),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of results to skip for pagination (default: 0)"),
});

/**
 * Type for pagination parameters.
 */
export type PaginationParams = z.infer<typeof PaginationSchema>;

// =============================================================================
// Common Field Schemas
// =============================================================================

/**
 * Standard ID field validation.
 */
export const IdSchema = z
  .string()
  .min(1, "ID is required")
  .max(100, "ID must not exceed 100 characters");

/**
 * Standard name field validation.
 */
export const NameSchema = z
  .string()
  .min(1, "Name is required")
  .max(200, "Name must not exceed 200 characters");

/**
 * Standard description field validation.
 */
export const DescriptionSchema = z
  .string()
  .max(1000, "Description must not exceed 1000 characters")
  .optional();

/**
 * Standard search query validation.
 */
export const SearchQuerySchema = z
  .string()
  .min(2, "Query must be at least 2 characters")
  .max(200, "Query must not exceed 200 characters");

// =============================================================================
// Output Schema Helpers
// =============================================================================

/**
 * Standard pagination metadata for list responses.
 */
export const PaginationOutputSchema = {
  type: "object" as const,
  properties: {
    total: { type: "integer" as const, description: "Total items available" },
    count: { type: "integer" as const, description: "Items in this response" },
    offset: { type: "integer" as const, description: "Current offset" },
    has_more: { type: "boolean" as const, description: "More items available" },
    next_offset: {
      type: "integer" as const,
      description: "Offset for next page (if has_more is true)",
    },
  },
  required: ["total", "count", "offset", "has_more"] as const,
};
