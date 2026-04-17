# MCP Server Template

This is a production-ready template for building MCP (Model Context Protocol) servers that integrate with SaaS APIs like Gmail, Google Calendar, Shopify, QuickBooks, etc.

## Quick Start

```bash
# Install dependencies
npm install

# Development (stdio transport)
npm run dev

# Production build
npm run build

# HTTP server mode
MCP_TRANSPORT=http npm run start
```

## Project Structure

```
src/
├── index.ts           # Entry point with transport switching
├── http-server.ts     # HTTP transport (production)
├── config.ts          # Environment configuration
├── auth/              # OAuth metadata endpoints
├── services/          # API client for SaaS integration
├── tools/             # MCP tool definitions and handlers
└── utils/             # Logger, response formatting, pagination
```

## Building New MCP Servers

When creating a new MCP server from this template:

1. **Clone the template** and rename for your SaaS integration
2. **Use the `mcp-builder` skill** to guide implementation

### Using the mcp-builder Skill

The `mcp-builder` skill provides comprehensive guidance for creating high-quality MCP servers. To use it:

1. **Enable the Agentman Skills MCP server** in Claude Code:
   ```bash
   claude mcp add skills-agentman-ai https://skills.agentman.ai/mcp --transport http
   ```

2. **Invoke the skill** when building your MCP server:
   ```
   Use the mcp-builder skill to help me create tools for [Gmail/Shopify/etc]
   ```

The skill includes:
- MCP 2025-11-25 best practices
- Tool naming conventions (snake_case with service prefix)
- Tool description structure (Args/Returns/Examples/Error Handling)
- Response formatting (markdown/json with `response_format` parameter)
- Pagination patterns
- TypeScript implementation patterns

## Key Files to Modify

When customizing for your SaaS:

1. **`src/tools/index.ts`** - Define your tools here
   - Add tool definitions with descriptions, annotations, input/output schemas
   - Implement tool handlers with API calls
   - Use Zod for input validation

2. **`src/services/api-client.ts`** - API client is ready to use
   - Set `SAAS_API_BASE_URL` for your API
   - Token is passed from Claude/Agentman via Authorization header

3. **`src/config.ts`** - Update server name and OAuth settings
   - `MCP_SERVER_NAME` - Your server name
   - `OAUTH_ISSUER`, `OAUTH_AUTHORIZATION_URL`, etc.
   - For broker mode: `UPSTREAM_CLIENT_ID`, `UPSTREAM_AUTH_URL`, etc.

4. **`src/auth/oauth-metadata.ts`** - OAuth scopes for your SaaS

5. **`src/auth/oauth-server.ts`** - OAuth broker customization (if using broker mode)
   - Customize the upstream authorization URL construction in `/oauth/authorize`
   - Customize the token exchange body in `/oauth/callback`
   - Add provider-specific params (e.g., `access_type=offline` for Google)

## Environment Variables

```bash
# Required for HTTP mode
PORT=8080
MCP_TRANSPORT=http

# OAuth configuration (for well-known endpoints - passthrough mode)
OAUTH_ISSUER=https://your-oauth-provider.com
OAUTH_AUTHORIZATION_URL=https://your-oauth-provider.com/authorize
OAUTH_TOKEN_URL=https://your-oauth-provider.com/token
OAUTH_SCOPES=scope1 scope2

# SaaS API
SAAS_API_BASE_URL=https://api.your-saas.com

# For local development (stdio mode)
SAAS_ACCESS_TOKEN=your-dev-token
```

### OAuth Broker Mode

To enable the server as its own OAuth authorization server:

```bash
OAUTH_SERVER_ENABLED=true
UPSTREAM_CLIENT_ID=your-saas-oauth-client-id
UPSTREAM_CLIENT_SECRET=your-saas-oauth-client-secret
UPSTREAM_AUTH_URL=https://accounts.google.com/o/oauth2/v2/auth
UPSTREAM_TOKEN_URL=https://oauth2.googleapis.com/token
UPSTREAM_REVOKE_URL=https://oauth2.googleapis.com/revoke
MCP_SERVER_URL=http://localhost:8010
OAUTH_SCOPES="scope1 scope2"
```

For local development, add `http://localhost:<port>/oauth/callback` as an authorized redirect URI in your SaaS provider's OAuth app settings.

## Testing

```bash
# Install test dependencies
npm install @chainofagents/auth open

# Run all tests
npx tsx test-harness/server.test.ts --server http://localhost:8010/mcp

# Run specific test suites
npx tsx test-harness/server.test.ts --server http://localhost:8010/mcp --public
npx tsx test-harness/server.test.ts --server http://localhost:8010/mcp --discovery
npx tsx test-harness/server.test.ts --server http://localhost:8010/mcp --auth
```

## Deployment to Google Cloud

MCP servers are deployed to Cloud Run behind a shared load balancer at `mcp.agentman.ai`.

### URL Structure

All MCP servers are accessible at:
```
https://mcp.agentman.ai/<your-path>/mcp
```

Examples:
- Gmail: `https://mcp.agentman.ai/gmail/mcp`
- Shopify: `https://mcp.agentman.ai/shopify/mcp`
- QuickBooks: `https://mcp.agentman.ai/quickbooks/mcp`

### Deploy Scripts

1. **Configure** - Edit the configuration section in deploy scripts:
   - `deploy-test.sh` - Test/staging environment
   - `deploy-prod.sh` - Production environment

2. **Deploy to Test** first:
   ```bash
   ./deploy-test.sh
   ```

3. **Test your deployment**:
   ```bash
   curl https://mcp.agentman.ai/your-path/health
   ```

4. **Deploy to Production**:
   ```bash
   ./deploy-prod.sh
   ```

See [docs/DEPLOY_TO_GCP.md](docs/DEPLOY_TO_GCP.md) for detailed deployment instructions.

## MCP Best Practices

This template follows MCP 2025-11-25 specification:

- **Stateless HTTP** - No sessions, JSON responses
- **Tool annotations** - readOnlyHint, destructiveHint, idempotentHint, openWorldHint
- **Response format** - All tools support `response_format` parameter (markdown/json)
- **Pagination** - Standardized limit/offset with metadata
- **Character limit** - 25,000 char limit with automatic truncation
- **Structured output** - outputSchema definitions for all tools
- **Request correlation** - x-agentman-request-id header for tracing

## Files Overview

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point with transport switching |
| `src/http-server.ts` | HTTP transport for production |
| `src/tools/index.ts` | Tool definitions and handlers |
| `src/config.ts` | Environment configuration |
| `src/auth/oauth-metadata.ts` | OAuth well-known endpoints (RFC 8414/9728) |
| `src/auth/oauth-server.ts` | OAuth broker routes (register, authorize, callback, token, revoke) |
| `src/auth/pkce.ts` | PKCE S256 verification and token generation |
| `test-harness/server.test.ts` | End-to-end test harness |
| `Dockerfile` | Container build |
| `cloudbuild.yaml` | Cloud Build configuration |
| `deploy-test.sh` | Test environment deployment |
| `deploy-prod.sh` | Production deployment |
| `docs/DEPLOY_TO_GCP.md` | Detailed deployment guide |
