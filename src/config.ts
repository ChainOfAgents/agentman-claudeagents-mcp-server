/**
 * Environment configuration with Zod validation.
 *
 * Configure the Claude Managed Agents MCP server via environment variables.
 * The only required credential is ANTHROPIC_API_KEY (stdio mode) or a Bearer
 * token on incoming HTTP requests (HTTP mode).
 */

import { z } from "zod";

// =============================================================================
// Environment Schema
// =============================================================================

const envSchema = z.object({
  // Server Configuration
  PORT: z.string().regex(/^\d+$/).default("8010"),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // MCP Server Identity
  MCP_SERVER_NAME: z.string().default("claudeagents_mcp"),
  MCP_SERVER_VERSION: z.string().default("0.1.0"),

  // This MCP Server's Public URL (used in OAuth protected resource metadata)
  MCP_SERVER_URL: z.string().url().optional().or(z.literal("")),

  // ==========================================================================
  // OAuth Configuration - Point these to your SaaS provider
  // ==========================================================================

  // OAuth Authorization Server URL (e.g., https://accounts.google.com)
  OAUTH_ISSUER: z.string().url().optional().or(z.literal("")),

  // OAuth Endpoints (if different from issuer)
  OAUTH_AUTHORIZATION_ENDPOINT: z.string().url().optional().or(z.literal("")),
  OAUTH_TOKEN_ENDPOINT: z.string().url().optional().or(z.literal("")),
  OAUTH_REVOCATION_ENDPOINT: z.string().url().optional().or(z.literal("")),

  // Scopes required for this MCP server (space-separated)
  // e.g., "https://www.googleapis.com/auth/gmail.readonly"
  OAUTH_SCOPES: z.string().default(""),

  // ==========================================================================
  // OAuth Authorization Server (Broker Mode)
  // When enabled, the server acts as an OAuth broker to the upstream provider
  // (e.g., Google, Shopify). See docs/OAUTH_FLOW.md for the full flow.
  // ==========================================================================

  OAUTH_SERVER_ENABLED: z.string().default("false"),

  // Upstream SaaS provider OAuth credentials (used when OAUTH_SERVER_ENABLED=true)
  UPSTREAM_CLIENT_ID: z.string().optional(),
  UPSTREAM_CLIENT_SECRET: z.string().optional(),

  // Upstream SaaS provider OAuth URLs (customize for your provider)
  UPSTREAM_AUTH_URL: z.string().url().optional().or(z.literal("")),
  UPSTREAM_TOKEN_URL: z.string().url().optional().or(z.literal("")),
  UPSTREAM_REVOKE_URL: z.string().url().optional().or(z.literal("")),

  // Override the redirect URI sent to the upstream provider (for local dev behind ngrok/tunnel)
  // Defaults to {MCP_SERVER_URL}/oauth/callback
  UPSTREAM_REDIRECT_URI: z.string().url().optional().or(z.literal("")),

  // ==========================================================================
  // Anthropic API Configuration
  // ==========================================================================

  // Base URL for the Anthropic API
  SAAS_API_BASE_URL: z.string().url().default("https://api.anthropic.com"),

  // Anthropic API version header value
  ANTHROPIC_VERSION: z.string().default("2023-06-01"),

  // Anthropic beta header for Managed Agents (comma-separated if multiple)
  ANTHROPIC_BETA: z.string().default("managed-agents-2026-04-01"),

  // Long-running request timeout in ms (default: 30 min, for streaming tools)
  API_TIMEOUT_MS: z.string().regex(/^\d+$/).default("1800000"),

  // Fast read timeout in ms (default: 30 sec, for list/get tools)
  API_FAST_TIMEOUT_MS: z.string().regex(/^\d+$/).default("30000"),

  // Default API key for stdio mode (not used in HTTP mode, where token comes from Authorization header)
  ANTHROPIC_API_KEY: z.string().optional(),

  // ==========================================================================
  // Rate Limiting
  // ==========================================================================

  RATE_LIMIT_WINDOW_MS: z.string().regex(/^\d+$/).default("60000"),
  RATE_LIMIT_MAX_REQUESTS: z.string().regex(/^\d+$/).default("100"),
  RATE_LIMIT_MAX_WRITES: z.string().regex(/^\d+$/).default("20"),
});

// =============================================================================
// Validate and Export Configuration
// =============================================================================

const envValidation = envSchema.safeParse(process.env);

if (!envValidation.success) {
  console.error("❌ Environment validation failed:");
  envValidation.error.errors.forEach((err) => {
    console.error(`   ${err.path.join(".")}: ${err.message}`);
  });
  console.warn("⚠️  Server will start with defaults, but some features may not work correctly");
}

const env = envValidation.success ? envValidation.data : envSchema.parse({});

// =============================================================================
// Derived Configuration
// =============================================================================

export const config = {
  // Server
  port: parseInt(env.PORT),
  host: env.HOST,
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
  isDev: env.NODE_ENV === "development",
  isProd: env.NODE_ENV === "production",

  // MCP Server Identity
  serverName: env.MCP_SERVER_NAME,
  serverVersion: env.MCP_SERVER_VERSION,
  serverUrl: env.MCP_SERVER_URL || `http://localhost:${env.PORT}`,

  // OAuth Configuration (external provider or self as broker)
  oauth: {
    issuer: env.OAUTH_ISSUER || "",
    authorizationEndpoint: env.OAUTH_AUTHORIZATION_ENDPOINT || "",
    tokenEndpoint: env.OAUTH_TOKEN_ENDPOINT || "",
    revocationEndpoint: env.OAUTH_REVOCATION_ENDPOINT || "",
    scopes: env.OAUTH_SCOPES.split(" ").filter(Boolean),
  },

  // OAuth Authorization Server (Broker Mode)
  oauthServerEnabled: env.OAUTH_SERVER_ENABLED === "true",
  upstream: {
    clientId: env.UPSTREAM_CLIENT_ID || "",
    clientSecret: env.UPSTREAM_CLIENT_SECRET || "",
    authUrl: env.UPSTREAM_AUTH_URL || "",
    tokenUrl: env.UPSTREAM_TOKEN_URL || "",
    revokeUrl: env.UPSTREAM_REVOKE_URL || "",
    redirectUri: env.UPSTREAM_REDIRECT_URI || "",  // empty = use serverUrl/oauth/callback
  },

  // Anthropic API
  saasApi: {
    baseUrl: env.SAAS_API_BASE_URL,
    timeoutMs: parseInt(env.API_TIMEOUT_MS),
    fastTimeoutMs: parseInt(env.API_FAST_TIMEOUT_MS),
    anthropicVersion: env.ANTHROPIC_VERSION,
    anthropicBeta: env.ANTHROPIC_BETA,
    defaultApiKey: env.ANTHROPIC_API_KEY,
  },

  // Rate Limiting
  rateLimit: {
    windowMs: parseInt(env.RATE_LIMIT_WINDOW_MS),
    maxRequests: parseInt(env.RATE_LIMIT_MAX_REQUESTS),
    maxWrites: parseInt(env.RATE_LIMIT_MAX_WRITES),
  },
} as const;

// =============================================================================
// MCP Protocol Configuration
// =============================================================================

export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

export const DEFAULT_PROTOCOL_VERSION = "2025-11-25";

// =============================================================================
// Input Validation Constants
// =============================================================================

export const limits = {
  maxRequestBodySize: "10mb",
  maxSlugLength: 200,
  maxFilePathLength: 500,
  maxContentSize: 5 * 1024 * 1024, // 5MB
} as const;

export default config;
