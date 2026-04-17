/**
 * OAuth 2.0 Authorization Server (Broker Mode)
 *
 * When OAUTH_SERVER_ENABLED=true, this MCP server acts as its own OAuth
 * authorization server, brokering authentication to an upstream SaaS provider
 * (Google, Shopify, etc.) on behalf of MCP clients.
 *
 * The server does NOT store tokens long-term. It holds them in memory only long
 * enough for the client to exchange the authorization code (~5 minutes). After
 * that, the client (e.g., Studio) stores tokens and handles refresh.
 *
 * Endpoints:
 *   POST /oauth/register   - Dynamic Client Registration (RFC 7591)
 *   GET  /oauth/authorize   - Authorization endpoint (redirects to SaaS provider)
 *   GET  /oauth/callback    - SaaS provider redirects back here
 *   POST /oauth/token       - Token exchange (auth code -> tokens)
 *   POST /oauth/revoke      - Token revocation
 *
 * To customize for your SaaS provider, update:
 *   1. config.ts - Set UPSTREAM_CLIENT_ID, UPSTREAM_CLIENT_SECRET, UPSTREAM_AUTH_URL, etc.
 *   2. The token exchange body in /oauth/callback (if provider needs extra params)
 *   3. The redirect URL construction in /oauth/authorize (if provider needs extra params)
 */

import express, { Router, Request, Response } from "express";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { verifyPkce, generateSecureToken, generateSessionId } from "./pkce.js";

const router = Router();

/**
 * The redirect URI registered with the upstream SaaS provider for the OAuth callback.
 * In production this equals config.serverUrl. For local dev behind ngrok/tunnel,
 * set UPSTREAM_REDIRECT_URI to the tunnel URL so the provider accepts the redirect.
 */
function getUpstreamRedirectUri(): string {
  // If UPSTREAM_REDIRECT_URI is set, use it as-is (it should be the full callback URL).
  // Otherwise, derive from serverUrl.
  return config.upstream.redirectUri || `${config.serverUrl}/oauth/callback`;
}

// =============================================================================
// In-Memory Storage (short-lived only)
// =============================================================================

interface ClientRegistration {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  created_at: number;
}

interface AuthSession {
  client_id: string;
  redirect_uri: string;
  state: string; // Client's original state (returned on callback)
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  created_at: number;
}

interface AuthCodeData {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  // Upstream provider tokens obtained during callback (standard OAuth flow)
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope: string;
  created_at: number;
  // API key paste flow (claudeagents-mcp custom)
  api_key?: string;
}

const clients = new Map<string, ClientRegistration>();
const authSessions = new Map<string, AuthSession>();
const authCodes = new Map<string, AuthCodeData>();

// TTLs in milliseconds
const AUTH_SESSION_TTL = 10 * 60 * 1000; // 10 minutes
const AUTH_CODE_TTL = 5 * 60 * 1000; // 5 minutes

// Periodic cleanup of expired entries (every 60 seconds)
// unref() allows the process to exit even if the interval is still active
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, session] of authSessions) {
    if (now - session.created_at > AUTH_SESSION_TTL) {
      authSessions.delete(key);
    }
  }
  for (const [key, code] of authCodes) {
    if (now - code.created_at > AUTH_CODE_TTL) {
      authCodes.delete(key);
    }
  }
}, 60_000);
cleanupInterval.unref();

// =============================================================================
// POST /oauth/register - Dynamic Client Registration (RFC 7591)
// =============================================================================

router.post("/oauth/register", (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  const log = logger.child({ requestId });

  if (!config.oauthServerEnabled) {
    return res.status(404).json({ error: "not_found" });
  }

  const { client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method } = req.body;

  if (!client_name || !redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return res.status(400).json({
      error: "invalid_client_metadata",
      error_description: "client_name and redirect_uris are required",
    });
  }

  const client_id = generateSecureToken("mcp_client", 16);
  const registration: ClientRegistration = {
    client_id,
    client_name,
    redirect_uris,
    grant_types: grant_types || ["authorization_code"],
    response_types: response_types || ["code"],
    token_endpoint_auth_method: token_endpoint_auth_method || "none",
    created_at: Date.now(),
  };

  clients.set(client_id, registration);
  log.info("Client registered", { client_id, client_name });

  return res.status(201).json({
    client_id: registration.client_id,
    client_name: registration.client_name,
    redirect_uris: registration.redirect_uris,
    grant_types: registration.grant_types,
    response_types: registration.response_types,
    token_endpoint_auth_method: registration.token_endpoint_auth_method,
  });
});

// =============================================================================
// GET /oauth/authorize - Authorization Endpoint
// =============================================================================

router.get("/oauth/authorize", (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  const log = logger.child({ requestId });

  if (!config.oauthServerEnabled) {
    return res.status(404).json({ error: "not_found" });
  }

  const {
    client_id,
    redirect_uri,
    response_type,
    state,
    code_challenge,
    code_challenge_method,
    scope,
  } = req.query as Record<string, string>;

  // Validate required parameters
  if (!client_id || !redirect_uri || !state || !code_challenge) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "Missing required parameters: client_id, redirect_uri, state, code_challenge",
    });
  }

  if (response_type && response_type !== "code") {
    return res.status(400).json({
      error: "unsupported_response_type",
      error_description: "Only response_type=code is supported",
    });
  }

  if (code_challenge_method && code_challenge_method !== "S256") {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "Only code_challenge_method=S256 is supported",
    });
  }

  // Validate client
  const client = clients.get(client_id);
  if (!client) {
    return res.status(400).json({
      error: "invalid_client",
      error_description: "Unknown client_id",
    });
  }

  // Validate redirect_uri
  if (!client.redirect_uris.includes(redirect_uri)) {
    log.warn("Redirect URI mismatch", { client_id, redirect_uri, registered: client.redirect_uris });
    return res.status(400).json({
      error: "invalid_request",
      error_description: "redirect_uri does not match any registered URIs",
    });
  }

  // Determine scopes: use requested scopes or fall back to configured defaults
  const requestedScope = scope || config.oauth.scopes.join(" ");

  // Store auth session
  const sessionId = generateSessionId();
  authSessions.set(sessionId, {
    client_id,
    redirect_uri,
    state, // Preserve client's original state
    code_challenge,
    code_challenge_method: code_challenge_method || "S256",
    scope: requestedScope,
    created_at: Date.now(),
  });

  // =========================================================================
  // CUSTOMIZED for claudeagents-mcp: API Key Paste Flow
  // Instead of redirecting to an upstream OAuth provider, show an HTML form
  // that asks the user to paste their Anthropic API key. When submitted,
  // we issue an auth code wrapping the key, and the token exchange returns
  // the key as the access token.
  // =========================================================================
  log.info("Showing API key paste form", { client_id, sessionId });

  // Render a simple HTML form
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect to Claude Managed Agents</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; color: #333; }
    h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
    p { color: #666; line-height: 1.5; font-size: 0.95rem; }
    label { display: block; margin-top: 1.5rem; font-weight: 600; font-size: 0.9rem; }
    input[type="password"] { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.95rem; margin-top: 6px; box-sizing: border-box; }
    input[type="password"]:focus { outline: none; border-color: #b07d56; box-shadow: 0 0 0 2px rgba(176,125,86,0.2); }
    button { display: block; width: 100%; padding: 12px; background: #b07d56; color: white; border: none; border-radius: 6px; font-size: 1rem; font-weight: 600; cursor: pointer; margin-top: 1.5rem; }
    button:hover { background: #9a6c49; }
    .note { font-size: 0.8rem; color: #999; margin-top: 1rem; }
    .note a { color: #b07d56; }
  </style>
</head>
<body>
  <h1>Connect to Claude Managed Agents</h1>
  <p>Paste your Anthropic API key to give this MCP server access to your Claude Managed Agents workspace.</p>
  <form method="POST" action="${config.serverUrl}/oauth/callback-apikey">
    <input type="hidden" name="session_id" value="${sessionId}">
    <label for="api_key">Anthropic API Key</label>
    <input type="password" id="api_key" name="api_key" placeholder="sk-ant-..." required>
    <button type="submit">Connect</button>
  </form>
  <p class="note">
    Your key is used only for API calls and is never stored on disk.
    <a href="https://console.anthropic.com/settings/keys" target="_blank">Create a dedicated key</a> so you can revoke it independently.
  </p>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  return res.send(html);
});

// =============================================================================
// POST /oauth/callback-apikey - API Key Paste Form Submission
// (CUSTOM: claudeagents-mcp only — replaces the upstream OAuth redirect flow)
// =============================================================================

router.post("/oauth/callback-apikey", express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  const log = logger.child({ requestId });

  const { session_id: sessionId, api_key: apiKey } = req.body as Record<string, string>;

  if (!sessionId || !apiKey) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "Missing session_id or api_key",
    });
  }

  // Retrieve the auth session created during GET /oauth/authorize
  const session = authSessions.get(sessionId);
  if (!session) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "Auth session expired or invalid. Please try connecting again.",
    });
  }

  // Check session expiry
  if (Date.now() - session.created_at > AUTH_SESSION_TTL) {
    authSessions.delete(sessionId);
    return res.status(400).json({
      error: "invalid_request",
      error_description: "Auth session expired. Please try connecting again.",
    });
  }

  // Validate the API key format (basic check)
  if (!apiKey.startsWith("sk-ant-")) {
    return res.status(400).send(`
      <html><body>
        <h3>Invalid API Key</h3>
        <p>The key must start with <code>sk-ant-</code>. Please go back and try again.</p>
        <a href="javascript:history.back()">Go back</a>
      </body></html>
    `);
  }

  // Generate an authorization code that wraps the API key.
  // The token exchange endpoint will look up this code and return the API key
  // as the access_token.
  const authCode = generateSessionId(); // reuse the session ID generator for randomness
  authCodes.set(authCode, {
    api_key: apiKey,
    client_id: session.client_id,
    redirect_uri: session.redirect_uri,
    code_challenge: session.code_challenge,
    code_challenge_method: session.code_challenge_method,
    scope: session.scope,
    created_at: Date.now(),
  });

  // Clean up the auth session
  authSessions.delete(sessionId);

  // Redirect back to the client (claude.ai) with the auth code
  const redirectUrl = new URL(session.redirect_uri);
  redirectUrl.searchParams.set("code", authCode);
  redirectUrl.searchParams.set("state", session.state);

  log.info("API key received, redirecting back to client with auth code", {
    client_id: session.client_id,
  });

  return res.redirect(redirectUrl.toString());
});

// =============================================================================
// GET /oauth/callback - Upstream Provider Callback (kept for template compat)
// =============================================================================

router.get("/oauth/callback", async (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  const log = logger.child({ requestId });

  if (!config.oauthServerEnabled) {
    return res.status(404).json({ error: "not_found" });
  }

  const { code, state: sessionId, error } = req.query as Record<string, string>;

  // Handle user denying consent
  if (error) {
    log.warn("Upstream OAuth error", { error });
    const session = sessionId ? authSessions.get(sessionId) : undefined;
    if (session) {
      authSessions.delete(sessionId);
      const redirectUrl = new URL(session.redirect_uri);
      redirectUrl.searchParams.set("error", "access_denied");
      redirectUrl.searchParams.set("error_description", error);
      redirectUrl.searchParams.set("state", session.state);
      return res.redirect(redirectUrl.toString());
    }
    return res.status(400).json({ error: "access_denied", error_description: error });
  }

  if (!code || !sessionId) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "Missing code or state from upstream callback",
    });
  }

  // Retrieve auth session
  const session = authSessions.get(sessionId);
  if (!session) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "Auth session expired or invalid",
    });
  }

  // Check session expiry
  if (Date.now() - session.created_at > AUTH_SESSION_TTL) {
    authSessions.delete(sessionId);
    return res.status(400).json({
      error: "invalid_request",
      error_description: "Auth session expired",
    });
  }

  try {
    // =========================================================================
    // Exchange upstream auth code for tokens
    // CUSTOMIZE THIS for your specific SaaS provider (Google, Shopify, etc.)
    // =========================================================================
    const tokenResponse = await fetch(config.upstream.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.upstream.clientId,
        client_secret: config.upstream.clientSecret,
        redirect_uri: getUpstreamRedirectUri(),
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text();
      log.error("Upstream token exchange failed", { status: tokenResponse.status, body: errorBody });
      authSessions.delete(sessionId);

      const redirectUrl = new URL(session.redirect_uri);
      redirectUrl.searchParams.set("error", "server_error");
      redirectUrl.searchParams.set("error_description", "Failed to exchange authorization code with upstream provider");
      redirectUrl.searchParams.set("state", session.state);
      return res.redirect(redirectUrl.toString());
    }

    const upstreamTokens = await tokenResponse.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope: string;
      token_type: string;
    };

    // Generate server authorization code
    const serverAuthCode = generateSecureToken("mcp_code", 32);

    // Store auth code -> upstream tokens mapping
    authCodes.set(serverAuthCode, {
      client_id: session.client_id,
      redirect_uri: session.redirect_uri,
      code_challenge: session.code_challenge,
      code_challenge_method: session.code_challenge_method,
      access_token: upstreamTokens.access_token,
      refresh_token: upstreamTokens.refresh_token || "",
      expires_in: upstreamTokens.expires_in,
      scope: upstreamTokens.scope || session.scope,
      created_at: Date.now(),
    });

    // Clean up auth session
    authSessions.delete(sessionId);

    // Redirect back to client with server auth code + client's original state
    const redirectUrl = new URL(session.redirect_uri);
    redirectUrl.searchParams.set("code", serverAuthCode);
    redirectUrl.searchParams.set("state", session.state);

    log.info("OAuth callback successful, redirecting to client", {
      client_id: session.client_id,
    });
    return res.redirect(redirectUrl.toString());
  } catch (err) {
    log.error("OAuth callback error", { error: err instanceof Error ? err.message : "Unknown" });
    authSessions.delete(sessionId);
    return res.status(500).json({
      error: "server_error",
      error_description: "Internal error during token exchange",
    });
  }
});

// =============================================================================
// POST /oauth/token - Token Exchange
// =============================================================================

router.post("/oauth/token", (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  const log = logger.child({ requestId });

  if (!config.oauthServerEnabled) {
    return res.status(404).json({ error: "not_found" });
  }

  // Support both JSON and URL-encoded bodies
  const params = req.body;
  const grant_type = params.grant_type;

  if (grant_type === "authorization_code") {
    return handleAuthorizationCodeGrant(params, log, res);
  }

  if (grant_type === "refresh_token") {
    return handleRefreshTokenGrant(params, log, res);
  }

  return res.status(400).json({
    error: "unsupported_grant_type",
    error_description: `Grant type '${grant_type}' is not supported. Use 'authorization_code' or 'refresh_token'.`,
  });
});

function handleAuthorizationCodeGrant(
  params: Record<string, string>,
  log: ReturnType<typeof logger.child>,
  res: Response
): void {
  const { code, redirect_uri, client_id, code_verifier } = params;

  if (!code || !redirect_uri || !client_id || !code_verifier) {
    res.status(400).json({
      error: "invalid_request",
      error_description: "Missing required parameters: code, redirect_uri, client_id, code_verifier",
    });
    return;
  }

  // Look up auth code
  const authCodeData = authCodes.get(code);
  if (!authCodeData) {
    res.status(400).json({
      error: "invalid_grant",
      error_description: "Authorization code is invalid or expired",
    });
    return;
  }

  // Verify client_id matches
  if (authCodeData.client_id !== client_id) {
    log.warn("Client ID mismatch on token exchange", { expected: authCodeData.client_id, received: client_id });
    res.status(400).json({
      error: "invalid_grant",
      error_description: "Client ID does not match",
    });
    return;
  }

  // Verify redirect_uri matches
  if (authCodeData.redirect_uri !== redirect_uri) {
    res.status(400).json({
      error: "invalid_grant",
      error_description: "Redirect URI does not match",
    });
    return;
  }

  // Delete auth code immediately (one-time use, even on failure prevents retry attacks)
  authCodes.delete(code);

  // Verify PKCE
  if (!verifyPkce(code_verifier, authCodeData.code_challenge)) {
    log.warn("PKCE verification failed", { client_id });
    res.status(400).json({
      error: "invalid_grant",
      error_description: "PKCE code_verifier verification failed",
    });
    return;
  }

  log.info("Token exchange successful", { client_id });

  // Return the token to the client.
  // For the API-key paste flow (claudeagents-mcp custom), the "access token"
  // IS the user's Anthropic API key. For the standard upstream OAuth flow,
  // it's the upstream provider's access token.
  const accessToken = authCodeData.api_key || authCodeData.access_token;
  if (!accessToken) {
    log.error("No access token or API key found in auth code data");
    res.status(500).json({
      error: "server_error",
      error_description: "Internal error: no token available",
    });
    return;
  }

  const response: Record<string, unknown> = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: authCodeData.expires_in ?? 86400 * 365, // API keys don't expire; use 1 year
    scope: authCodeData.scope,
  };

  if (authCodeData.refresh_token) {
    response.refresh_token = authCodeData.refresh_token;
  }

  res.json(response);
}

function handleRefreshTokenGrant(
  params: Record<string, string>,
  log: ReturnType<typeof logger.child>,
  res: Response
): void {
  // Proxy refresh to upstream provider.
  // Note: Client validation is intentionally skipped because client registrations
  // are in-memory and lost on restart. PKCE on the initial auth flow provides
  // sufficient client binding.
  const { refresh_token, client_id } = params;

  if (!refresh_token || !client_id) {
    res.status(400).json({
      error: "invalid_request",
      error_description: "Missing required parameters: refresh_token, client_id",
    });
    return;
  }

  // =========================================================================
  // Proxy refresh to upstream SaaS provider
  // CUSTOMIZE THIS for your specific SaaS provider (Google, Shopify, etc.)
  // =========================================================================
  fetch(config.upstream.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token,
      client_id: config.upstream.clientId,
      client_secret: config.upstream.clientSecret,
    }),
  })
    .then(async (upstreamRes) => {
      if (!upstreamRes.ok) {
        const errorBody = await upstreamRes.text();
        log.error("Upstream token refresh failed", { status: upstreamRes.status, body: errorBody });
        res.status(400).json({
          error: "invalid_grant",
          error_description: "Token refresh failed",
        });
        return;
      }

      const tokens = await upstreamRes.json() as {
        access_token: string;
        expires_in: number;
        scope: string;
        token_type: string;
        refresh_token?: string; // Provider MAY rotate refresh tokens
      };

      log.info("Token refresh successful", { client_id });

      const response: Record<string, unknown> = {
        access_token: tokens.access_token,
        token_type: tokens.token_type || "Bearer",
        expires_in: tokens.expires_in,
        scope: tokens.scope,
      };

      // Forward rotated refresh token if provider issued a new one (RFC 6749 §10.4)
      if (tokens.refresh_token) {
        response.refresh_token = tokens.refresh_token;
        log.info("Refresh token rotated by upstream provider", { client_id });
      }

      res.json(response);
    })
    .catch((err) => {
      log.error("Token refresh error", { error: err instanceof Error ? err.message : "Unknown" });
      res.status(500).json({
        error: "server_error",
        error_description: "Internal error during token refresh",
      });
    });
}

// =============================================================================
// POST /oauth/revoke - Token Revocation
// =============================================================================

router.post("/oauth/revoke", async (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  const log = logger.child({ requestId });

  if (!config.oauthServerEnabled) {
    return res.status(404).json({ error: "not_found" });
  }

  const { token } = req.body;

  if (!token) {
    // Per RFC 7009, always return 200 even for missing tokens
    return res.status(200).json({});
  }

  try {
    // Proxy revocation to upstream provider
    await fetch(config.upstream.revokeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });

    log.info("Token revocation forwarded to upstream provider");
  } catch (err) {
    log.warn("Token revocation failed", { error: err instanceof Error ? err.message : "Unknown" });
  }

  // Always return 200 per RFC 7009
  return res.status(200).json({});
});

export default router;
export { router as oauthServerRouter };
