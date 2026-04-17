# agentman-claudeagents-mcp-server

**The MCP server for Claude Managed Agents.** Install it in any MCP client — claude.ai, Claude Desktop, Cursor, Claude Code — and run your entire Claude Managed Agents workflow by prompting Claude in your chat.

- 🧠 **Promptable agent management**: create agents, configure environments, start sessions, send messages, watch results, archive — all from natural language
- 🌊 **Live streaming**: `claudeagent_run_task` streams agent activity as MCP progress notifications while the session runs, so you see what's happening in real-time
- 📋 **Bundled templates**: ten ready-to-use agent configurations (Deep researcher, Support agent, Data analyst, and more) you can pass directly to `claudeagent_create_agent`
- 🔒 **Open source**: MIT-licensed, auditable, your API key stays local in stdio mode
- 🚀 **Two transports**: stdio for local install in Claude Desktop / Cursor, streamable HTTP for claude.ai and remote clients

This is **Layer 1** of the [Agentwatch](https://agentwatch.com) architecture — an Agentman-branded free open-source tool. It's useful on its own for managing Claude Managed Agents from any MCP client, and it's the foundation that Agentwatch (the hosted operations platform) consumes internally.

---

## Quick start

### Local install (Claude Desktop, Cursor, Claude Code)

```bash
npm install -g @agentman/claudeagents-mcp-server
```

Add to your MCP client config:

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "claudeagents": {
      "command": "claudeagents-mcp-server",
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

**Cursor / Claude Code**: same shape, in the respective settings file. Restart your client — the `claudeagent_*` tools appear in the tool menu.

### Hosted install (claude.ai and remote clients)

Add an MCP server in claude.ai Projects settings:

- **URL**: `https://mcp.agentman.ai/claudeagents/mcp`
- **Authentication**: Bearer token = your Anthropic API key

No install needed — claude.ai connects directly to the hosted endpoint.

### Get an Anthropic API key

1. Open [Anthropic Console → API Keys](https://console.anthropic.com/settings/keys)
2. Click **Create Key**
3. Name it `claudeagents-mcp` so you can revoke it independently later
4. Paste the key into your MCP client config (or pass as Bearer token for hosted mode)

---

## What you can do

Once installed, type into your MCP client:

> *list my agents*
>
> *show me all failed sessions from today*
>
> *create an agent from the deep researcher template and call it "Costco Analyst"*
>
> *run my deal evaluation agent on this CIM (attached)*
>
> *summarize session sesn_01ab*
>
> *which session was the most expensive this week?*

Claude calls the right tools behind the scenes. You see progress stream as the agent runs, and get a clean summary when it's done.

---

## The 33 tools

Organized around the Anthropic Console's four-step quickstart plus templates, observation, streaming, and composite tools.

### 📦 Templates (2)

- `claudeagent_list_templates` — list bundled templates (Blank, Deep researcher, Structured extractor, Field monitor, Support agent, Incident commander, Feedback miner, Sprint retro facilitator, Support-to-eng escalator, Data analyst)
- `claudeagent_get_template` — get the full YAML or JSON of a specific template

### 🤖 Agent CRUD (6)

- `claudeagent_list_agents`
- `claudeagent_get_agent`
- `claudeagent_list_agent_versions`
- `claudeagent_create_agent`
- `claudeagent_update_agent`
- `claudeagent_archive_agent`

### 🧱 Environment CRUD (6)

- `claudeagent_list_environments`
- `claudeagent_get_environment`
- `claudeagent_create_environment`
- `claudeagent_update_environment`
- `claudeagent_archive_environment`
- `claudeagent_delete_environment`

### 🗂 Session CRUD (6)

- `claudeagent_list_sessions`
- `claudeagent_get_session`
- `claudeagent_create_session`
- `claudeagent_update_session`
- `claudeagent_archive_session`
- `claudeagent_delete_session`

### 📨 Session events (5)

- `claudeagent_send_user_message` — kicks off agent work
- `claudeagent_define_outcome` — rubric-guided autonomous mode
- `claudeagent_interrupt_session`
- `claudeagent_confirm_tool_use`
- `claudeagent_respond_custom_tool`

### 👀 Observation (3)

- `claudeagent_list_session_events`
- `claudeagent_list_session_threads`
- `claudeagent_get_thread_events`

### 🌊 Streaming (2) — emit MCP progress notifications

- `claudeagent_wait_for_session_idle` — block until done, streaming events live
- `claudeagent_stream_session_events` — explicit "tail -f" for a running session

### ⭐ Smart composite (3)

- `claudeagent_summarize_session` — multi-call summary of a session
- `claudeagent_find_anomalies` — statistical anomaly detection over recent sessions
- **`claudeagent_run_task`** — the hero tool. Creates a session, sends a message, streams agent activity as progress notifications, waits for completion, returns a summary. All in one tool call.

---

## Streaming: live agent activity in your chat

Long-running tools (`run_task`, `wait_for_session_idle`, `stream_session_events`) open an SSE stream to the Anthropic Managed Agents event stream and forward each event as an MCP `notifications/progress` message with a human-readable label.

As the agent runs, you see progress updates like:

```
🔄 Agent started working...
🔄 Calling tool: web_search (query: "Costco revenue 2024")
🔄 Tool result: web_search (12 KB)
🔄 Agent: Let me analyze the financial statements...
🔄 Calling tool: file_read (path: "/mnt/data/costco.csv")
🔄 Model call: 8200 in / 410 out tokens
🔄 Session complete. Stop reason: end_turn
```

...followed by the final summary in the tool result.

Compatibility: Claude Desktop, Claude Code, Cursor, and Cline render these progress notifications visibly. claude.ai's support is being verified — check the [Agentwatch docs](https://github.com/agentman/agentwatch) for current status.

---

## Environment variables

The only required variable in stdio mode is `ANTHROPIC_API_KEY`. Everything else has defaults.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Your Anthropic API key (required in stdio mode; in HTTP mode, comes from Bearer header) |
| `SAAS_API_BASE_URL` | `https://api.anthropic.com` | Anthropic API base URL |
| `ANTHROPIC_VERSION` | `2023-06-01` | Anthropic API version header |
| `ANTHROPIC_BETA` | `managed-agents-2026-04-01` | Anthropic beta header for Managed Agents |
| `API_TIMEOUT_MS` | `1800000` | Long-running request timeout (30 min) for streaming tools |
| `API_FAST_TIMEOUT_MS` | `30000` | Fast read timeout (30 sec) for list/get tools |
| `MCP_SERVER_NAME` | `claudeagents_mcp` | Advertised MCP server name |
| `MCP_SERVER_VERSION` | `0.1.0` | Advertised version |
| `PORT` | `8010` | HTTP mode port |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

See `.env.example` for the full list.

---

## Development

### Run locally (stdio)

```bash
git clone https://github.com/agentman/agentman-claudeagents-mcp-server.git
cd agentman-claudeagents-mcp-server
npm install
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

### Run locally (HTTP)

```bash
MCP_TRANSPORT=http npm run dev:http
```

Then POST to `http://localhost:8010/mcp` with `Authorization: Bearer sk-ant-...`.

### Build

```bash
npm run build
npm run start            # stdio
npm run start:http       # HTTP
```

### Typecheck / lint

```bash
npm run typecheck
npm run lint
```

---

## Security

**Open source means auditable.** All code is MIT-licensed. You can read every line that touches your API key:

- **stdio mode**: your API key is read from `ANTHROPIC_API_KEY` in the MCP client's config and stays entirely on your local machine. Nothing is sent anywhere except `api.anthropic.com`.
- **HTTP mode** (hosted at `mcp.agentman.ai/claudeagents/mcp`): your API key is sent as a Bearer token on each request, forwarded to `api.anthropic.com`, and discarded. The server doesn't persist keys.

The server uses the `x-api-key` + `anthropic-version` + `anthropic-beta` header combo required by the Anthropic API. No credentials are logged. No telemetry is sent to third parties.

**Recommended**: create a dedicated Anthropic API key named `claudeagents-mcp` so you can revoke it independently if needed.

---

## License

MIT — see [LICENSE](./LICENSE).

Copyright © Agentman. Built from [agentman-mcp-server-template](https://github.com/ChainOfAgents/agentman-mcp-server-template).

---

## Related

- **[Agentwatch](https://github.com/agentman/agentwatch)** — the hosted operations platform for AI agent fleets that consumes this MCP server as a data source. NBA-first Briefing Room, continuous watching, eval runner, alerts, and status pages.
- **[agentman-mcp-server-template](https://github.com/ChainOfAgents/agentman-mcp-server-template)** — the template this server is built from.
- **[Agentman MCP servers](https://github.com/agentman)** — all of Agentman's open-source MCP servers, including `agentman-gmail-mcp-server`, `agentman-linkedin-mcp-server`, and more.
