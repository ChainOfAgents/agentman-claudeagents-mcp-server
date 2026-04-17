/**
 * OAuth 2.0 Metadata Endpoints
 *
 * Provides the well-known endpoints required for MCP OAuth:
 * 1. /.well-known/oauth-protected-resource (RFC 9728) - Protected Resource Metadata
 * 2. /.well-known/oauth-authorization-server (RFC 8414) - Authorization Server Metadata
 *
 * These endpoints tell Claude/Agentman how to authenticate with your SaaS provider
 * (Google, Shopify, QuickBooks, etc.)
 */

import { Router, Request, Response } from "express";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const router = Router();

// =============================================================================
// Types
// =============================================================================

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728)
 * Tells clients which authorization server(s) can issue tokens for this resource
 */
interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  resource_documentation?: string;
}

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414)
 * Describes OAuth endpoints and capabilities
 */
interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  service_documentation?: string;
}

// =============================================================================
// Metadata Builders
// =============================================================================

/**
 * Build Protected Resource Metadata (RFC 9728)
 * This tells clients where to find the authorization server.
 *
 * When oauthServerEnabled=true, the server itself is the authorization server
 * (broker mode). Otherwise, points to the external OAuth provider.
 */
function getProtectedResourceMetadata(): ProtectedResourceMetadata {
  // In broker mode, this server IS the authorization server
  const authServer = config.oauthServerEnabled
    ? config.serverUrl
    : config.oauth.issuer;

  return {
    resource: config.serverUrl,
    authorization_servers: authServer ? [authServer] : [],
    scopes_supported: config.oauth.scopes,
    bearer_methods_supported: ["header"],
    resource_documentation: config.serverUrl,
  };
}

/**
 * Build Authorization Server Metadata (RFC 8414)
 *
 * When oauthServerEnabled=true, all endpoints point to this server's own
 * /oauth/* routes (broker mode). Otherwise, points to the external provider.
 */
function getAuthorizationServerMetadata(): AuthorizationServerMetadata {
  if (config.oauthServerEnabled) {
    const base = config.serverUrl;
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      scopes_supported: config.oauth.scopes,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
    };
  }

  // External provider mode (passthrough)
  const issuer = config.oauth.issuer;
  return {
    issuer,
    authorization_endpoint:
      config.oauth.authorizationEndpoint || `${issuer}/authorize`,
    token_endpoint: config.oauth.tokenEndpoint || `${issuer}/token`,
    revocation_endpoint:
      config.oauth.revocationEndpoint || `${issuer}/revoke`,
    scopes_supported: config.oauth.scopes,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Check if OAuth is properly configured.
 * In broker mode, always return true (endpoints are self-hosted).
 * In passthrough mode, check that external endpoints are configured.
 */
function isOAuthConfigured(): boolean {
  if (config.oauthServerEnabled) {
    return true;
  }
  return !!(
    config.oauth.issuer &&
    config.oauth.authorizationEndpoint &&
    config.oauth.tokenEndpoint
  );
}

// =============================================================================
// Route Handlers
// =============================================================================

/**
 * GET /.well-known/oauth-protected-resource
 *
 * Returns OAuth 2.0 Protected Resource Metadata (RFC 9728).
 * This is the FIRST endpoint Claude/Agentman fetches to discover where to authenticate.
 */
router.get("/.well-known/oauth-protected-resource", (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  logger.info("Protected Resource Metadata requested (RFC 9728)", { requestId });

  if (!isOAuthConfigured()) {
    logger.warn("OAuth not configured - returning 503", { requestId });
    return res.status(503).json({
      error: "oauth_not_configured",
      message: "OAuth is not configured for this MCP server. Set OAUTH_ISSUER, OAUTH_AUTHORIZATION_ENDPOINT, and OAUTH_TOKEN_ENDPOINT.",
    });
  }

  const metadata = getProtectedResourceMetadata();
  logger.debug("Returning protected resource metadata", { requestId, metadata });
  res.json(metadata);
});

// Handle Claude appending /mcp to the well-known URL
router.get("/.well-known/oauth-protected-resource/mcp", (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  logger.info("Protected Resource Metadata requested (with /mcp suffix)", { requestId });

  if (!isOAuthConfigured()) {
    logger.warn("OAuth not configured - returning 503", { requestId });
    return res.status(503).json({
      error: "oauth_not_configured",
      message: "OAuth is not configured for this MCP server.",
    });
  }

  const metadata = getProtectedResourceMetadata();
  res.json(metadata);
});

/**
 * GET /.well-known/oauth-authorization-server
 *
 * Returns OAuth 2.0 Authorization Server Metadata (RFC 8414).
 * Claude/Agentman uses this to discover OAuth endpoints.
 *
 * IMPORTANT: This endpoint is REQUIRED. Claude will not proceed without it.
 */
router.get("/.well-known/oauth-authorization-server", (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  logger.info("Authorization Server Metadata requested (RFC 8414)", { requestId });

  if (!isOAuthConfigured()) {
    logger.warn("OAuth not configured - returning 503", { requestId });
    return res.status(503).json({
      error: "oauth_not_configured",
      message: "OAuth is not configured for this MCP server. Set OAUTH_ISSUER, OAUTH_AUTHORIZATION_ENDPOINT, and OAUTH_TOKEN_ENDPOINT.",
    });
  }

  const metadata = getAuthorizationServerMetadata();
  logger.debug("Returning authorization server metadata", { requestId, metadata });
  res.json(metadata);
});

// Handle Claude appending /mcp to the well-known URL
router.get("/.well-known/oauth-authorization-server/mcp", (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  logger.info("Authorization Server Metadata requested (with /mcp suffix)", { requestId });

  if (!isOAuthConfigured()) {
    logger.warn("OAuth not configured - returning 503", { requestId });
    return res.status(503).json({
      error: "oauth_not_configured",
      message: "OAuth is not configured for this MCP server.",
    });
  }

  const metadata = getAuthorizationServerMetadata();
  res.json(metadata);
});

/**
 * OpenID Connect discovery (alias for oauth-authorization-server)
 * Some clients may use this path
 */
router.get("/.well-known/openid-configuration", (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  logger.info("OpenID configuration requested (alias)", { requestId });

  if (!isOAuthConfigured()) {
    return res.status(503).json({
      error: "oauth_not_configured",
      message: "OAuth is not configured for this MCP server.",
    });
  }

  const metadata = getAuthorizationServerMetadata();
  res.json(metadata);
});

export default router;
export {
  getProtectedResourceMetadata,
  getAuthorizationServerMetadata,
  ProtectedResourceMetadata,
  AuthorizationServerMetadata,
};
