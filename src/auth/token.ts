/**
 * Token Extraction Utilities
 *
 * Extract and validate Bearer tokens from incoming requests.
 * The token is the SaaS access token (Gmail, Shopify, etc.) that
 * Claude/Agentman obtained via OAuth and passes to this MCP server.
 */

import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Result of token extraction
 */
export interface TokenResult {
  /** The extracted access token, or null if not present */
  token: string | null;
  /** Error message if token extraction failed */
  error?: string;
}

/**
 * Request context with extracted token
 * Attach this to Express request for use in handlers
 */
export interface RequestContext {
  /** The SaaS access token from Authorization header */
  accessToken: string | null;
  /** Whether the request is authenticated */
  isAuthenticated: boolean;
}

// =============================================================================
// Token Extraction
// =============================================================================

/**
 * Extract Bearer token from Authorization header
 *
 * @param req Express request object
 * @returns TokenResult with token or error
 *
 * @example
 * const { token, error } = extractBearerToken(req);
 * if (!token) {
 *   return res.status(401).send('Unauthorized');
 * }
 */
export function extractBearerToken(req: Request): TokenResult {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return { token: null };
  }

  // Must be "Bearer <token>" format
  if (!authHeader.startsWith("Bearer ")) {
    return {
      token: null,
      error: "Invalid Authorization header format. Expected: Bearer <token>",
    };
  }

  const token = authHeader.slice(7).trim();

  if (!token) {
    return {
      token: null,
      error: "Empty Bearer token",
    };
  }

  return { token };
}

/**
 * Build request context from incoming request
 *
 * @param req Express request object
 * @returns RequestContext with token info
 */
export function getRequestContext(req: Request): RequestContext {
  const { token } = extractBearerToken(req);

  return {
    accessToken: token,
    isAuthenticated: token !== null,
  };
}

/**
 * Require authentication middleware
 *
 * Returns 401 Unauthorized if no valid Bearer token is present.
 * This triggers the OAuth flow in Claude/Agentman.
 *
 * @example
 * app.post('/mcp', requireAuth, mcpHandler);
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const requestId = req.requestId;
  const { token, error } = extractBearerToken(req);

  if (!token) {
    logger.info("No auth token - returning 401 to trigger OAuth flow", { requestId });
    res.status(401);
    res.setHeader("Content-Type", "text/plain;charset=UTF-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send("Unauthorized");
    return;
  }

  if (error) {
    logger.warn("Invalid auth token", { requestId, error });
    res.status(401);
    res.setHeader("Content-Type", "text/plain;charset=UTF-8");
    res.send("Unauthorized");
    return;
  }

  // Attach token to request for downstream handlers
  req.accessToken = token;
  next();
}

/**
 * Optional authentication middleware
 *
 * Extracts token if present but doesn't require it.
 * Use this for endpoints that work with or without auth.
 *
 * @example
 * app.post('/mcp', optionalAuth, mcpHandler);
 */
export function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const { token } = extractBearerToken(req);
  req.accessToken = token ?? undefined;
  next();
}

// =============================================================================
// Express Request Extension
// =============================================================================

// Extend Express Request type to include our custom properties
declare global {
  namespace Express {
    interface Request {
      accessToken?: string;
    }
  }
}
