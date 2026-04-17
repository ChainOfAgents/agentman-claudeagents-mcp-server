#!/usr/bin/env node
/**
 * MCP Server - HTTP Transport (Stateless)
 *
 * Production-ready MCP server following the MCP 2025-11-25 specification.
 * Uses the modern StreamableHTTPServerTransport for MCP protocol handling.
 *
 * Features:
 * - StreamableHTTPServerTransport for proper MCP protocol handling
 * - Stateless HTTP transport (POST /mcp)
 * - OAuth well-known endpoints for SaaS authentication
 * - CORS, rate limiting, request logging
 * - Proper 401/202/405 response handling for Claude compatibility
 *
 * Endpoints:
 * - POST /mcp - MCP JSON-RPC requests (via StreamableHTTPServerTransport)
 * - GET /mcp - Returns 405 (stateless mode)
 * - GET /health - Health check
 * - GET /.well-known/oauth-authorization-server - OAuth metadata
 * - GET /.well-known/oauth-protected-resource - Protected resource metadata
 */

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { config, limits } from "./config.js";
import { oauthMetadataRouter, oauthServerRouter, extractBearerToken } from "./auth/index.js";
import { registerTools } from "./tools/index.js";
import { AuthExpiredError } from "./services/api-client.js";
import { logger, requestIdMiddleware, REQUEST_ID_HEADER } from "./utils/index.js";

// =============================================================================
// Express App Setup
// =============================================================================

const app = express();

// Trust proxy when behind load balancer (GCP, Cloud Run)
// Required for express-rate-limit to read X-Forwarded-For correctly
app.set("trust proxy", true);

// =============================================================================
// CORS Configuration
// =============================================================================

const allowedOrigins = [
  "https://claude.ai",
  "https://www.claude.ai",
  "https://studio.agentman.ai",
  "https://studio.chainoftasks.ai",
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (non-browser clients)
      if (!origin) {
        return callback(null, true);
      }
      // Allow specific origins
      if (allowedOrigins.includes(origin)) {
        return callback(null, origin);
      }
      // Allow other origins without credentials
      return callback(null, true);
    },
    methods: ["GET", "POST", "OPTIONS", "DELETE"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "MCP-Protocol-Version",
      "Mcp-Session-Id",
      REQUEST_ID_HEADER,
    ],
    exposedHeaders: ["MCP-Protocol-Version", "Mcp-Session-Id", REQUEST_ID_HEADER],
    credentials: false, // MCP uses Bearer tokens, not cookies
  })
);

// =============================================================================
// Request ID Middleware (must be first)
// =============================================================================

app.use(requestIdMiddleware);

// =============================================================================
// OAuth Metadata Routes (must be before rate limiting)
// =============================================================================

app.use(oauthMetadataRouter);

// =============================================================================
// Rate Limiting
// =============================================================================

const generalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "rate_limit_exceeded",
    message: "Too many requests, please try again later",
  },
  skip: (req) => req.path === "/health",
  validate: { trustProxy: false },
});

app.use(generalLimiter);

// =============================================================================
// Body Parsing
// =============================================================================

app.use(express.json({ limit: limits.maxRequestBodySize }));
app.use(express.urlencoded({ extended: true, limit: limits.maxRequestBodySize }));

// =============================================================================
// OAuth Authorization Server Routes (Broker Mode)
// Registered after body parsing since POST /oauth/register and /oauth/token need it.
// Only active when OAUTH_SERVER_ENABLED=true.
// =============================================================================

if (config.oauthServerEnabled) {
  if (!config.upstream.clientId || !config.upstream.clientSecret) {
    logger.error("OAUTH_SERVER_ENABLED=true but UPSTREAM_CLIENT_ID or UPSTREAM_CLIENT_SECRET is not set");
    process.exit(1);
  }
  app.use(oauthServerRouter);
  logger.info("OAuth Authorization Server (broker mode) enabled");
}

// =============================================================================
// Request Logging
// =============================================================================

const SENSITIVE_FIELDS = ["password", "secret", "token", "api_key", "authorization"];

function sanitizeForLogging(obj: unknown, depth = 0): unknown {
  if (depth > 5) return "[MAX_DEPTH]";
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    if (obj.length > 500) return `[STRING_${obj.length}_CHARS]`;
    return obj;
  }
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    if (obj.length > 10) return `[ARRAY_${obj.length}_ITEMS]`;
    return obj.map((item) => sanitizeForLogging(item, depth + 1));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_FIELDS.some((f) => lowerKey.includes(f))) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = sanitizeForLogging(value, depth + 1);
    }
  }
  return sanitized;
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = req.requestId;
  const log = logger.child({ requestId });

  log.info(`${req.method} ${req.url}`, {
    userAgent: req.headers["user-agent"] || "N/A",
    hasAuth: !!req.headers.authorization,
  });

  if (req.body && Object.keys(req.body).length > 0) {
    const sanitizedBody = sanitizeForLogging(req.body);
    log.debug("Request body", { body: sanitizedBody });
  }

  next();
});

// =============================================================================
// Health Check
// =============================================================================

app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "healthy",
    service: config.serverName,
    version: config.serverVersion,
    protocol: "MCP 2025-11-25",
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
// Root Handler
// =============================================================================

app.get("/", (req: Request, res: Response) => {
  res.json({
    service: config.serverName,
    version: config.serverVersion,
    protocol: "MCP 2025-11-25 (Stateless HTTP)",
    description: "Use POST /mcp for MCP requests",
    health: "/health",
  });
});

// =============================================================================
// MCP GET Handler (Stateless - Return 405)
// =============================================================================

app.get("/mcp", (req: Request, res: Response) => {
  const requestId = req.requestId;
  const log = logger.child({ requestId });

  // Check for auth first - if no token, return 401 with WWW-Authenticate to trigger OAuth
  const { token } = extractBearerToken(req);
  if (!token) {
    log.info("GET /mcp without token - returning 401");
    const resourceMetadataUrl = `${config.serverUrl}/.well-known/oauth-protected-resource`;
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
    res.status(401);
    res.setHeader("Content-Type", "text/plain;charset=UTF-8");
    return res.send("Unauthorized");
  }

  // With token but GET request - we're stateless, return 405
  log.info("GET /mcp - returning 405 (stateless mode)");
  res.status(405);
  res.setHeader("Content-Type", "application/json");
  return res.json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null,
  });
});

// =============================================================================
// MCP POST Handler (using StreamableHTTPServerTransport)
// =============================================================================

app.post("/mcp", async (req: Request, res: Response) => {
  const requestId = req.requestId;
  const log = logger.child({ requestId });
  let transport: StreamableHTTPServerTransport | undefined;

  try {
    // Extract token for OAuth
    const { token: accessToken } = extractBearerToken(req);

    // Handle empty body or no auth - trigger OAuth flow
    if (!req.body || Object.keys(req.body).length === 0 || !req.body.jsonrpc) {
      if (!accessToken) {
        log.info("Empty body without token - returning 401 for OAuth trigger");
        const resourceMetadataUrl = `${config.serverUrl}/.well-known/oauth-protected-resource`;
        res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
        res.status(401);
        res.setHeader("Content-Type", "text/plain;charset=UTF-8");
        return res.send("Unauthorized");
      }
      // Has token but invalid body
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid Request: missing jsonrpc field" },
        id: null,
      });
    }

    // Check for initialize without auth
    if (req.body.method === "initialize" && !accessToken) {
      log.info("Initialize without token - returning 401");
      const resourceMetadataUrl = `${config.serverUrl}/.well-known/oauth-protected-resource`;
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
      res.status(401);
      res.setHeader("Content-Type", "text/plain;charset=UTF-8");
      return res.send("Unauthorized");
    }

    // Log MCP method and tool name for observability
    const mcpMethod = req.body.method;
    const toolName = mcpMethod === "tools/call" ? req.body.params?.name : undefined;
    log.info("MCP request", { method: mcpMethod, ...(toolName ? { tool: toolName } : {}) });

    // Create a new McpServer instance for each request (stateless)
    const server = new McpServer({
      name: config.serverName,
      version: config.serverVersion,
    });

    // Register tools with access token getter for this request
    registerTools(server, () => accessToken || undefined);

    // Create StreamableHTTPServerTransport for this request
    // sessionIdGenerator: undefined makes it stateless (no sessions)
    // enableJsonResponse: true returns JSON instead of SSE
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
      enableJsonResponse: true,      // Return JSON, not SSE streams
    });

    // Connect server to transport
    await server.connect(transport);

    // Handle the request through the transport
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    // If the upstream API returned 401 (expired token), return HTTP 401
    // so the MCP client (Claude Code) refreshes the token and retries.
    if (error instanceof AuthExpiredError) {
      log.info("Upstream API returned 401 — returning HTTP 401 to trigger client token refresh");
      if (!res.headersSent) {
        const resourceMetadataUrl = `${config.serverUrl}/.well-known/oauth-protected-resource`;
        res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
        res.status(401);
        res.setHeader("Content-Type", "text/plain;charset=UTF-8");
        return res.send("Unauthorized");
      }
    }

    log.error("MCP handler error", { error: error instanceof Error ? error.message : "Unknown" });
    if (!res.headersSent) {
      return res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal error",
        },
        id: req.body?.id || null,
      });
    }
  } finally {
    // Ensure cleanup happens regardless of success/failure
    if (transport) {
      try {
        transport.close();
      } catch (closeError) {
        log.warn("Failed to close transport", { error: closeError instanceof Error ? closeError.message : "Unknown" });
      }
    }
  }
});

// =============================================================================
// Error Handler
// =============================================================================

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  const requestId = req.requestId;
  logger.error("Unhandled error", { requestId, error: err.message, stack: config.isDev ? err.stack : undefined });
  res.status(500).json({
    error: "internal_error",
    message: config.isDev ? err.message : "Internal server error",
    request_id: requestId,
  });
});

// =============================================================================
// Start Server Function (exported for use by index.ts)
// =============================================================================

/** Graceful shutdown timeout in milliseconds */
const SHUTDOWN_TIMEOUT_MS = 10000;

export async function startHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    const httpServer = app.listen(config.port, config.host, () => {
      logger.info("MCP Server Starting", {
        serverName: config.serverName,
        version: config.serverVersion,
        environment: config.nodeEnv,
        transport: "StreamableHTTP (MCP 2025-11-25)",
        endpoint: `http://${config.host}:${config.port}/mcp`,
        oauthConfigured: !!config.oauth.issuer,
        oauthServerEnabled: config.oauthServerEnabled,
      });
      resolve();
    });

    // Graceful shutdown handler
    const shutdown = (signal: string) => {
      logger.info(`${signal} received, shutting down gracefully`);

      httpServer.close(() => {
        logger.info("HTTP server closed");
        process.exit(0);
      });

      // Force close after timeout
      setTimeout(() => {
        logger.warn("Forcing shutdown after timeout");
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  });
}

// =============================================================================
// Direct execution support
// =============================================================================

// If this file is run directly (not imported)
const isDirectExecution = import.meta.url === `file://${process.argv[1]}`;
if (isDirectExecution) {
  startHttpServer();
}

export default app;
