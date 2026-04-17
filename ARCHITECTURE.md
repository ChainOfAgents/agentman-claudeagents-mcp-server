# Architecture Documentation

This document explains the MCP Server Template architecture, following the **MCP 2025-11-25 specification** with **Streamable HTTP transport** and OAuth integration.

## Overview

The template implements a production-ready remote MCP server using TypeScript and Express.js, designed for:

- **SaaS integrations** (Gmail, Shopify, QuickBooks, etc.)
- **OAuth token passthrough** pattern
- **Horizontal scaling** and serverless deployment
- **Claude and Agentman** compatibility

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MCP Client (Claude / Agentman)                       │
│  - Stores user OAuth tokens                                                  │
│  - Handles OAuth flow with SaaS                                              │
│  - Passes Bearer token to MCP server                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTP POST/GET
                                    │ Authorization: Bearer <saas_token>
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MCP Server (Express.js)                            │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                        OAuth Metadata Routes                         │    │
│  │  GET /.well-known/oauth-authorization-server  (RFC 8414)            │    │
│  │  GET /.well-known/oauth-protected-resource    (RFC 9728)            │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                         Middleware Stack                             │    │
│  │  CORS → Rate Limiting → Body Parser → Request Logging               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                         MCP Handler (POST /mcp)                      │    │
│  │                                                                      │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │    │
│  │  │  initialize  │  │ tools/list   │  │      tools/call          │  │    │
│  │  │  (auth req)  │  │ (no auth)    │  │  (extracts Bearer token) │  │    │
│  │  └──────────────┘  └──────────────┘  └──────────────────────────┘  │    │
│  │                                                │                    │    │
│  │                                                ▼                    │    │
│  │                         ┌──────────────────────────────────┐       │    │
│  │                         │        Tool Handlers             │       │    │
│  │                         │  handleToolCall(name, args, token)│       │    │
│  │                         └──────────────────────────────────┘       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                │                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                         API Client                                   │    │
│  │  apiGet/Post/Put/Delete(token, path, params)                        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTP with Bearer token
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SaaS API (Gmail, Shopify, etc.)                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

## File Structure

```
agentman-mcp-server-template/
├── src/
│   ├── index.ts               # Stdio transport entry point
│   ├── http-server.ts         # HTTP transport entry point (production)
│   ├── config.ts              # Environment configuration (Zod)
│   ├── auth/
│   │   ├── index.ts           # Auth module exports
│   │   ├── oauth-metadata.ts  # OAuth well-known endpoints
│   │   └── token.ts           # Token extraction utilities
│   ├── services/
│   │   └── api-client.ts      # HTTP client for SaaS APIs
│   └── tools/
│       └── index.ts           # Tool definitions and handlers
├── package.json               # Node.js dependencies
├── tsconfig.json              # TypeScript configuration
├── Dockerfile                 # Container definition
├── deploy.sh                  # GCP deployment script
├── cloudbuild.yaml            # Cloud Build configuration
├── .env.example               # Environment template
├── README.md                  # User documentation
└── ARCHITECTURE.md            # This file
```

## Components

### 1. HTTP Server (`src/http-server.ts`)

**Purpose**: Main production entry point with Streamable HTTP transport

**Responsibilities**:
- Configure CORS for Claude/Agentman origins
- Apply rate limiting
- Log requests with sensitive data sanitization
- Handle MCP JSON-RPC methods
- Return proper response codes (200, 202, 401, 405)

```typescript
// Key endpoints
POST /mcp          → MCP JSON-RPC handler
GET /mcp           → Returns 405 (stateless mode)
GET /health        → Health check
GET /.well-known/* → OAuth metadata
```

### 2. Stdio Entry Point (`src/index.ts`)

**Purpose**: Local development with Claude Desktop

**Usage**:
```bash
npm run dev  # Uses stdio transport
```

Uses `@modelcontextprotocol/sdk` StdioServerTransport for local testing.

### 3. Configuration (`src/config.ts`)

**Purpose**: Environment-based configuration using Zod validation

**Key Settings**:
```typescript
const config = {
  serverName: "template_mcp",        // MCP_SERVER_NAME
  serverVersion: "1.0.0",            // MCP_SERVER_VERSION
  port: 8010,                        // PORT
  host: "0.0.0.0",                   // HOST
  oauth: {
    issuer: "...",                   // OAUTH_ISSUER
    authorizationEndpoint: "...",    // OAUTH_AUTHORIZATION_ENDPOINT
    tokenEndpoint: "...",            // OAUTH_TOKEN_ENDPOINT
    scopes: "...",                   // OAUTH_SCOPES
  },
  saasApi: {
    baseUrl: "...",                  // SAAS_API_BASE_URL
    timeout: 30000,                  // SAAS_API_TIMEOUT
  },
};
```

### 4. OAuth Metadata (`src/auth/oauth-metadata.ts`)

**Purpose**: Expose OAuth endpoints for Claude/Agentman discovery

**Endpoints**:

| Endpoint | RFC | Purpose |
|----------|-----|---------|
| `/.well-known/oauth-authorization-server` | RFC 8414 | OAuth server metadata |
| `/.well-known/oauth-protected-resource` | RFC 9728 | Resource server metadata |

**Response Example**:
```json
{
  "issuer": "https://accounts.google.com",
  "authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth",
  "token_endpoint": "https://oauth2.googleapis.com/token",
  "scopes_supported": ["https://www.googleapis.com/auth/gmail.readonly"]
}
```

### 5. Token Utilities (`src/auth/token.ts`)

**Purpose**: Extract and validate Bearer tokens from requests

**Functions**:
```typescript
// Extract token from Authorization header
extractBearerToken(req): { token?: string, error?: string }

// Middleware: Require auth (returns 401 if missing)
requireAuth(req, res, next)

// Middleware: Optional auth (continues if missing)
optionalAuth(req, res, next)
```

### 6. API Client (`src/services/api-client.ts`)

**Purpose**: HTTP client for calling SaaS APIs with user tokens

**Features**:
- Automatic Bearer token injection
- Configurable timeouts
- Error handling with status codes
- User-friendly error messages

```typescript
// Usage in tool handlers
const data = await apiGet(accessToken, '/users/me');
const result = await apiPost(accessToken, '/messages', { body });
```

### 7. Tool Definitions (`src/tools/index.ts`)

**Purpose**: Define and handle MCP tools

**Structure**:
```typescript
// Tool definition
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "service_action",
    description: "Detailed description with examples",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: { /* JSON Schema */ },
    outputSchema: { /* JSON Schema */ },
  },
];

// Tool handler
export async function handleToolCall(
  name: string,
  args: unknown,
  accessToken: string | undefined
): Promise<ToolCallResult> {
  // Validate input with Zod
  // Call SaaS API with token
  // Return structured result
}
```

## OAuth Token Passthrough Pattern

This template implements a specific authentication pattern where:

1. **MCP Server does NOT handle OAuth flow** directly
2. **Claude/Agentman handles OAuth** with the SaaS provider
3. **MCP Server receives access tokens** in request headers
4. **MCP Server passes tokens** to SaaS API calls

### Why This Pattern?

- **Security**: Tokens stored in Claude/Agentman, not MCP server
- **Simplicity**: MCP server doesn't need OAuth state management
- **Scalability**: Stateless servers can scale horizontally
- **Consistency**: Same pattern for all SaaS integrations

### Flow Diagram

```
Claude/Agentman                MCP Server              SaaS API
      │                            │                      │
      │ 1. GET /.well-known/...    │                      │
      │───────────────────────────>│                      │
      │<───────────────────────────│                      │
      │    OAuth metadata          │                      │
      │                            │                      │
      │ 2. OAuth flow with user    │                      │
      │──────────────────────────────────────────────────>│
      │<──────────────────────────────────────────────────│
      │    Store access_token      │                      │
      │                            │                      │
      │ 3. POST /mcp tools/call    │                      │
      │    Authorization: Bearer   │                      │
      │───────────────────────────>│                      │
      │                            │ 4. API call with     │
      │                            │    Bearer token      │
      │                            │─────────────────────>│
      │                            │<─────────────────────│
      │<───────────────────────────│                      │
      │    Tool result             │                      │
```

## MCP 2025-11-25 Protocol Implementation

### Streamable HTTP Transport

| Feature | Implementation |
|---------|---------------|
| Endpoint | Single `POST /mcp` |
| Mode | Stateless (no sessions) |
| Response | JSON (no SSE) |
| Protocol Version | `2025-11-25` |

### Request Flow

```
1. Client POST to /mcp
   ├── Headers: Content-Type, Accept, Authorization
   └── Body: JSON-RPC 2.0 request

2. Server validates request
   ├── Check JSON-RPC format
   └── Extract Bearer token (if present)

3. Route to handler
   ├── initialize → Return server info (requires auth)
   ├── notifications/initialized → Return 202
   ├── tools/list → Return tool definitions
   └── tools/call → Execute tool with token

4. Return JSON-RPC response
   └── Content-Type: application/json
```

### Response Codes

| Code | When | Response |
|------|------|----------|
| 200 | Success | JSON-RPC result |
| 202 | Notification | Empty body |
| 401 | No token on auth-required method | `Unauthorized` |
| 405 | GET /mcp (stateless mode) | JSON-RPC error |
| 500 | Internal error | JSON-RPC error |

## Key Design Decisions

### 1. Stateless Mode

**Why**: Enables horizontal scaling and serverless deployment

**Benefits**:
- Works with load balancers
- Scales to zero when idle
- No session state to manage
- Simpler error handling

### 2. JSON Response Mode

**Why**: Simpler integration, no SSE stream management

**Benefits**:
- Standard HTTP request/response
- Easier debugging with curl
- Compatible with all HTTP clients
- Better for serverless environments

### 3. Zod Input Validation

**Why**: Type safety and runtime validation

```typescript
const inputSchema = z.object({
  query: z.string().min(1).max(100),
  limit: z.number().int().min(1).max(100).default(20),
});

// Validate in handler
const parsed = inputSchema.safeParse(args);
if (!parsed.success) {
  return createErrorResult("INVALID_PARAMS", parsed.error.message);
}
```

### 4. Tool Annotations

**Why**: Help clients understand tool behavior

```typescript
annotations: {
  readOnlyHint: true,      // Safe to retry
  destructiveHint: false,  // Doesn't delete data
  idempotentHint: true,    // Same result on retry
  openWorldHint: true,     // Calls external services
}
```

### 5. CORS Configuration

**Why**: Allow Claude/Agentman origins while blocking others

```typescript
const allowedOrigins = [
  "https://claude.ai",
  "https://www.claude.ai",
  "https://studio.agentman.ai",
];
```

## Deployment Architecture

### Docker Container

```dockerfile
FROM node:20-slim AS builder
# Build TypeScript
RUN npm run build

FROM node:20-slim
# Production dependencies only
RUN npm ci --omit=dev
# Run as non-root user
USER appuser
CMD ["node", "dist/http-server.js"]
```

### Cloud Run Deployment

```
deploy.sh
    │
    ▼
gcloud builds submit
    │
    ├── Build Docker image
    ├── Push to Artifact Registry
    └── Deploy to Cloud Run
            │
            ├── Port: 8010
            ├── Memory: 512Mi
            ├── Min instances: 0
            ├── Max instances: 10
            ├── Concurrency: 80
            └── Environment: OAuth config
```

### Health Checks

```bash
curl http://localhost:8010/health

# Response
{
  "status": "healthy",
  "service": "template_mcp",
  "version": "1.0.0",
  "protocol": "MCP 2025-11-25"
}
```

## Adding New Tools

### 1. Define Tool in TOOL_DEFINITIONS

```typescript
{
  name: "my_service_list_items",
  description: `List items from My Service.

Use this tool to:
- Get paginated results
- Filter by criteria

Returns: Array of items with pagination metadata.`,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      cursor: { type: "string", description: "Pagination cursor" },
    },
    required: [],
  },
}
```

### 2. Create Zod Schema

```typescript
const listItemsSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
```

### 3. Implement Handler

```typescript
async function handleListItems(
  args: unknown,
  accessToken: string | undefined
): Promise<ToolCallResult> {
  // Validate input
  const parsed = listItemsSchema.safeParse(args);
  if (!parsed.success) {
    return createErrorResult("INVALID_PARAMS", parsed.error.message);
  }

  // Check auth
  if (!accessToken) {
    return createErrorResult("AUTH_REQUIRED", "Authentication required.");
  }

  // Call SaaS API
  const data = await apiGet(accessToken, '/items', parsed.data);

  return createSuccessResult(data);
}
```

### 4. Add to Switch Statement

```typescript
case "my_service_list_items":
  return await handleListItems(args, accessToken);
```

## Security Considerations

### Token Handling

- Tokens extracted from Authorization header only
- Tokens not logged (redacted in request logging)
- Tokens passed directly to SaaS API, not stored

### Rate Limiting

- 100 requests per minute (general)
- Configurable via environment variables
- Skips health check endpoint

### CORS

- Explicit allowlist of origins
- Credentials disabled (Bearer tokens, not cookies)
- Proper headers exposed

### Input Validation

- All inputs validated with Zod
- Length limits on strings
- Range limits on numbers
- Forbidden extra properties

## References

- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [Streamable HTTP Transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [OAuth 2.0 Authorization Server Metadata (RFC 8414)](https://datatracker.ietf.org/doc/html/rfc8414)
- [OAuth 2.0 Protected Resource Metadata (RFC 9728)](https://datatracker.ietf.org/doc/html/rfc9728)
