/**
 * Request ID Utilities
 *
 * Generates and manages request IDs for log correlation.
 * Uses x-agentman-request-id header for distributed tracing.
 */

import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

// =============================================================================
// Constants
// =============================================================================

export const REQUEST_ID_HEADER = "x-agentman-request-id";

// =============================================================================
// Request ID Generation
// =============================================================================

/**
 * Generate a unique request ID
 * Format: agm-{timestamp}-{random}
 */
export function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString("hex");
  return `agm-${timestamp}-${random}`;
}

// =============================================================================
// Express Middleware
// =============================================================================

/**
 * Request ID middleware
 *
 * - Extracts existing request ID from header if present
 * - Generates new request ID if not present
 * - Attaches to request object for downstream use
 * - Adds to response headers for client correlation
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Use existing request ID from header or generate new one
  const requestId =
    (req.headers[REQUEST_ID_HEADER] as string) || generateRequestId();

  // Attach to request for downstream handlers
  (req as any).requestId = requestId;

  // Add to response headers
  res.setHeader(REQUEST_ID_HEADER, requestId);

  next();
}

// =============================================================================
// Express Request Extension
// =============================================================================

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}
