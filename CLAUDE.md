# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP server for Claude Managed Agents — gives any MCP client (claude.ai, Claude Desktop, Cursor, Claude Code) a promptable interface to the Anthropic Managed Agents API. 34 tools covering the full agent lifecycle: create agents, configure environments, start sessions, send messages, retrieve results.

**Live at:** `mcp.agentman.ai/claudeagents/mcp`
**Repo:** `github.com/ChainOfAgents/agentman-claudeagents-mcp-server`
**Built from:** `agentman-mcp-server-template`

## Build & Run

```bash
npm install
npm run build              # TypeScript compile (tsc)
npm run dev                # Start stdio MCP server (for Claude Desktop / Cursor)
MCP_TRANSPORT=http npm run dev:http   # Start HTTP server (for claude.ai / Cloud Run)
npm run typecheck          # Type-check without emitting
npm run lint               # ESLint
```

**Prerequisites:** Node >= 20. For local testing, set `ANTHROPIC_API_KEY` in `.env` (copy from `.env.example`).

## Architecture

This is a TypeScript MCP server built from `agentman-mcp-server-template`. Two transports:

- **stdio** (`src/index.ts`) — for local MCP clients. API key from `ANTHROPIC_API_KEY` env var.
- **HTTP** (`src/http-server.ts`) — for remote clients and claude.ai. API key comes as Bearer token via OAuth flow.

### Key Directories

- `src/tools/claudeagents/` — the 34 MCP tool implementations, organized by category:
  - `templates.ts` — `claudeagent_list_templates`, `claudeagent_get_template` (bundled YAML templates)
  - `agents.ts` — agent CRUD (list, get, versions, create, update, archive)
  - `environments.ts` — environment CRUD (list, get, create, update, archive, delete)
  - `sessions.ts` — session CRUD (list, get, create, update, archive, delete)
  - `session-events.ts` — send_user_message, define_outcome, interrupt, confirm_tool_use, respond_custom_tool
  - `observation.ts` — list_session_events (with type/exclude_type filtering), list_threads, get_thread_events
  - `streaming.ts` — wait_for_session_idle, stream_session_events (MCP progress notifications via SSE)
  - `smart.ts` — summarize_session (with cost/cache/derived metrics), get_session_output (80K pagination), find_anomalies, run_task (async default)
- `src/tools/shared.ts` — `registerTool` wrapper, `sendProgress` helper, `createSuccessResponse`, `createErrorResponse`, `requireAuth`
- `src/tools/index.ts` — wires up all 34 tools via category registration functions
- `src/schemas/claudeagents.ts` — Zod schemas for Anthropic API fields (agent IDs, session IDs, pagination, etc.)
- `src/types/anthropic.ts` — TypeScript interfaces for Anthropic Managed Agents API responses
- `src/services/api-client.ts` — HTTP client with Anthropic headers (`x-api-key`, `anthropic-version`, `anthropic-beta`), SSE streaming via `apiStream()` async generator
- `src/services/templates.ts` — YAML template loader (reads `src/templates/*.yaml` at startup)
- `src/templates/` — 10 bundled agent config templates (deep-researcher, support-agent, data-analyst, etc.)
- `src/auth/oauth-server.ts` — OAuth broker with custom API-key-paste flow for claude.ai
- `src/config.ts` — env var loading with Zod validation, Anthropic-specific config

## Key Patterns

### Tool naming: `claudeagent_{verb}_{noun}`

All tools follow `claudeagent_*` prefix in snake_case. Verbs: list, get, create, update, archive, delete, send, wait_for, stream, summarize, find, run.

### Async-first for agent execution

`claudeagent_run_task` defaults to `wait=false` — creates session, sends message, returns immediately with `session_id`. Caller polls with `claudeagent_get_session` until status is "idle", then retrieves output with `claudeagent_get_session_output`.

`wait=true` blocks and streams SSE progress notifications — only for stdio mode where long-lived connections are fine.

### Anthropic API authentication

- **Stdio mode:** `ANTHROPIC_API_KEY` from env var, static for the process lifetime
- **HTTP mode:** Bearer token extracted from each request's `Authorization` header. In hosted mode, this token is the user's Anthropic API key, obtained via the OAuth API-key-paste flow.

The API client attaches three headers to every Anthropic request:
- `x-api-key: <key>` (NOT `Authorization: Bearer`)
- `anthropic-version: 2023-06-01`
- `anthropic-beta: managed-agents-2026-04-01`

### Anthropic API quirks

- **Date filters use bracket notation:** `created_at[gte]` and `created_at[lte]`, not `created_after`/`created_before`. Our tool schemas accept `created_after`/`created_before` and translate them in the handler.
- **SSE events all use `event: message`:** the real event type is inside the `data` JSON payload's `type` field, not in the SSE `event` field. The streaming code resolves this.
- **Session usage fields are zero during "running" status** and only populate on "idle". Documented in `get_session` description.
- **RFC 8414 `.well-known` path with path suffix:** OAuth discovery at `/.well-known/oauth-authorization-server/{path_prefix}`, not `/{path_prefix}/.well-known/oauth-authorization-server`. Both paths are mapped in the URL map.

### Response formatting

- All tools accept `response_format: 'markdown' | 'json'` (default: markdown)
- Responses go through `createSuccessResponse` which truncates at 25K chars via `formatResponse`
- Exception: `get_session_output` bypasses truncation and returns up to 80K chars directly as MCP content, with `offset` pagination for longer outputs

### Streaming and progress notifications

Three tools emit MCP `notifications/progress` messages during execution:
- `run_task` (when `wait=true`), `wait_for_session_idle`, `stream_session_events`
- They open an SSE stream to Anthropic's `/v1/sessions/{id}/events/stream` and translate each event to a human-readable progress message
- `sendProgress(extra, progress, message)` in `shared.ts` handles the MCP protocol — reads `extra._meta?.progressToken` and emits via `extra.sendNotification()`
- Abort handling: when breaking out of the SSE loop, the AbortController is explicitly aborted to prevent stale `reader.read()` throws

### Cost estimation

`summarize_session` includes:
- **Raw token counts** from the session's `usage` field (input, output, cache_write, cache_read)
- **Cost estimate** using published Anthropic pricing (Sonnet/Opus/Haiku per-million-token rates)
- **Derived metrics:** cache_hit_rate, cost_per_search, cost_per_1k_output_tokens, cache_write_to_read_ratio

Pricing constants are in `MODEL_PRICING` inside `smart.ts`.

### OAuth broker for claude.ai

claude.ai requires OAuth discovery (RFC 8414 / RFC 9728) before authenticating MCP requests. Our flow:
1. Server returns 401 with `WWW-Authenticate: Bearer resource_metadata="..."` header
2. claude.ai discovers OAuth endpoints via `.well-known`
3. claude.ai registers a client via `POST /oauth/register`
4. claude.ai redirects user to `GET /oauth/authorize` → our server shows an HTML form: "Paste your Anthropic API key"
5. User pastes key, POST to `/oauth/callback-apikey` → server issues auth code wrapping the key
6. claude.ai exchanges code for token → receives the API key as the access token
7. All subsequent MCP requests include `Authorization: Bearer <api-key>`

Custom code in `oauth-server.ts`: the `POST /oauth/callback-apikey` handler and the modified authorize endpoint that shows the HTML form instead of redirecting to an upstream OAuth provider.

## Deployment

Deployed to Google Cloud Run behind `mcp.agentman.ai` load balancer.

```bash
./deploy-prod.sh    # Builds, pushes, deploys, updates URL map
```

**GCP Project:** `agentman-public-mcp-servers`
**Region:** `us-west2`
**Service:** `claudeagents-server`
**URL map:** `mcp-url-map` (shared across all Agentman MCP servers)
**Path prefix:** `/claudeagents`
**Cloud Run timeout:** 1800s (30 min, for streaming tools)

URL map routes (all rewrite to strip prefix):
- `/claudeagents/mcp` → `/mcp`
- `/claudeagents/health` → `/health`
- `/claudeagents/oauth/*` → `/oauth/*`
- `/claudeagents/.well-known/*` → `/.well-known/*`
- `/.well-known/oauth-authorization-server/claudeagents` → `/.well-known/oauth-authorization-server` (RFC 8414 path)
- `/.well-known/oauth-protected-resource/claudeagents` → `/.well-known/oauth-protected-resource`

**Known deploy issue:** the deploy script's URL map import sometimes fails with "Conflicting services for the same path pattern" on repeat deploys because rules already exist. The map is correct — the import step just can't handle idempotent re-adds. Manually export/clean/reimport if needed.

## Environment Variables

See `.env.example`. Key vars:

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required in stdio mode. Not used in HTTP mode (comes from Bearer header). |
| `SAAS_API_BASE_URL` | `https://api.anthropic.com` | Anthropic API base URL |
| `ANTHROPIC_VERSION` | `2023-06-01` | Anthropic API version header |
| `ANTHROPIC_BETA` | `managed-agents-2026-04-01` | Anthropic beta header |
| `API_TIMEOUT_MS` | `1800000` | Long timeout for streaming tools (30 min) |
| `API_FAST_TIMEOUT_MS` | `30000` | Fast timeout for CRUD tools (30 sec) |
| `MCP_SERVER_NAME` | `claudeagents_mcp` | Advertised server name |
| `OAUTH_SERVER_ENABLED` | `true` (in prod) | Enable OAuth broker for claude.ai |

## TypeScript Config

- ESM modules (`"type": "module"` in package.json, `"module": "ESNext"` in tsconfig)
- All imports use `.js` extensions
- Templates are YAML files in `src/templates/` — not compiled by tsc, copied to Docker image separately in the Dockerfile

## Context: Agentwatch

This server is **Layer 1** of the Agentwatch product architecture:
- **Layer 1 (this repo):** Provider MCP servers — Agentman-branded free OSS tools wrapping agent runtime APIs
- **Layer 2:** Agentwatch runtime + MCP server at `mcp.agentwatch.com/mcp` — hosted commercial product
- **Layer 3:** Agentwatch UI at `agentwatch.com` — NBA-first Briefing Room

Strategy docs at: `/Users/prasadthammineni/chainofagents/agentman-agentwatch/docs/`
