/**
 * Agent CRUD tools (Step 1 of the Anthropic Console quickstart).
 *
 *   - claudeagent_list_agents
 *   - claudeagent_get_agent
 *   - claudeagent_list_agent_versions
 *   - claudeagent_create_agent
 *   - claudeagent_update_agent
 *   - claudeagent_archive_agent
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  AgentDescriptionSchema,
  AgentIdSchema,
  AgentNameSchema,
  AnthropicPaginationSchema,
  CallableAgentSchema,
  McpServerConfigSchema,
  MetadataSchema,
  MetadataUpdateSchema,
  ModelSchema,
  ResponseFormatSchema,
  SkillConfigSchema,
  SystemPromptSchema,
  ToolConfigSchema,
} from "../../schemas/index.js";
import {
  apiGet,
  apiPost,
  AuthExpiredError,
  formatApiError,
} from "../../services/api-client.js";
import { Agent, ListResponse } from "../../types/anthropic.js";
import { logger } from "../../utils/logger.js";
import {
  createErrorResponse,
  createSuccessResponse,
  registerTool,
  requireAuth,
} from "../shared.js";

// =============================================================================
// Input schemas
// =============================================================================

const ListAgentsInputSchema = AnthropicPaginationSchema.extend({
  include_archived: z.boolean().default(false),
  response_format: ResponseFormatSchema,
});

const GetAgentInputSchema = z.object({
  agent_id: AgentIdSchema,
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Specific version number; omit for latest"),
  response_format: ResponseFormatSchema,
});

const ListAgentVersionsInputSchema = AnthropicPaginationSchema.extend({
  agent_id: AgentIdSchema,
  response_format: ResponseFormatSchema,
});

const CreateAgentInputSchema = z.object({
  name: AgentNameSchema,
  model: ModelSchema,
  system: SystemPromptSchema.optional(),
  description: AgentDescriptionSchema.optional(),
  tools: z.array(ToolConfigSchema).max(128).optional(),
  mcp_servers: z.array(McpServerConfigSchema).max(20).optional(),
  skills: z.array(SkillConfigSchema).max(20).optional(),
  callable_agents: z.array(CallableAgentSchema).optional(),
  metadata: MetadataSchema.optional(),
  response_format: ResponseFormatSchema,
});

const UpdateAgentInputSchema = z.object({
  agent_id: AgentIdSchema,
  version: z
    .number()
    .int()
    .min(1)
    .describe("Current version — required for optimistic concurrency control"),
  name: AgentNameSchema.optional(),
  description: AgentDescriptionSchema.nullable().optional(),
  system: SystemPromptSchema.nullable().optional(),
  model: ModelSchema.optional(),
  tools: z.array(ToolConfigSchema).optional(),
  mcp_servers: z.array(McpServerConfigSchema).optional(),
  skills: z.array(SkillConfigSchema).optional(),
  metadata: MetadataUpdateSchema.optional(),
  response_format: ResponseFormatSchema,
});

const ArchiveAgentInputSchema = z.object({
  agent_id: AgentIdSchema,
  response_format: ResponseFormatSchema,
});

// =============================================================================
// Registration
// =============================================================================

export function registerAgentTools(
  server: McpServer,
  getAccessToken: () => string | undefined
): void {
  // ===========================================================================
  // claudeagent_list_agents
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_list_agents",
    description: `List all agents in the Anthropic workspace.

Returns agents with their IDs, names, models, descriptions, versions, and metadata. Use this to discover which agents exist and get their IDs for further operations like claudeagent_get_agent, claudeagent_create_session, or claudeagent_run_task.

Args:
  - limit (number): Max results to return (1-100, default: 20)
  - page (string): Pagination cursor from a previous response
  - include_archived (boolean): Include archived agents (default: false)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  Markdown table (or JSON) of agents with: id, name, model, description, version, created_at, archived_at, plus next_page cursor if more results exist.

Examples:
  - List latest 20: {}
  - List next page: {"page": "eyJhbGci..."}
  - Include archived: {"include_archived": true}
  - Get as JSON: {"response_format": "json"}

Error Handling:
  - Returns AUTH_REQUIRED if no API key is configured
  - Returns API_ERROR on Anthropic API failures`,
    inputSchema: ListAgentsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { limit, page, include_archived, response_format } = params;
      try {
        const data = await apiGet<ListResponse<Agent>>(
          getAccessToken()!,
          "/v1/agents",
          {
            limit,
            page,
            include_archived,
          }
        );
        return createSuccessResponse(
          {
            total: data.data.length,
            agents: data.data,
            next_page: data.next_page,
          },
          response_format,
          { title: "Agents" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_list_agents failed", { error: err });
        return createErrorResponse("API_ERROR", formatApiError(err, "list agents"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_get_agent
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_get_agent",
    description: `Retrieve a specific agent by ID, including the full configuration.

Returns the agent's name, model, system prompt, tools, MCP servers, skills, metadata, and version. Optionally specify a version to retrieve a historical version.

Args:
  - agent_id (string, required): The agent ID, e.g., 'agent_01ab...'
  - version (number, optional): Specific version to retrieve; omit for latest
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  Markdown-formatted agent details showing all fields, including system prompt, tools, and MCP servers.

Examples:
  - Get latest version: {"agent_id": "agent_01abc"}
  - Get historical version: {"agent_id": "agent_01abc", "version": 2}

Error Handling:
  - Returns NOT_FOUND if agent_id doesn't exist
  - Returns AUTH_REQUIRED if no API key is configured`,
    inputSchema: GetAgentInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { agent_id, version, response_format } = params;
      try {
        const data = await apiGet<Agent>(
          getAccessToken()!,
          `/v1/agents/${encodeURIComponent(agent_id)}`,
          version !== undefined ? { version } : undefined
        );
        return createSuccessResponse(
          data as unknown as Record<string, unknown>,
          response_format,
          { title: `Agent: ${data.name}` }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_get_agent failed", { error: err, agent_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "get agent"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_list_agent_versions
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_list_agent_versions",
    description: `List historical versions of a specific agent.

Useful for comparing how an agent's configuration has changed over time. Each version is a snapshot of the agent's config at the time it was updated. Agents are automatically versioned by the Anthropic API on every update_agent call.

Args:
  - agent_id (string, required): The agent ID
  - limit (number): Max results (1-100, default: 20)
  - page (string): Pagination cursor

Returns:
  Markdown table of versions with version number, created_at, name, and a summary of changes.

Examples:
  - List all versions: {"agent_id": "agent_01abc"}`,
    inputSchema: ListAgentVersionsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { agent_id, limit, page, response_format } = params;
      try {
        const data = await apiGet<ListResponse<Agent>>(
          getAccessToken()!,
          `/v1/agents/${encodeURIComponent(agent_id)}/versions`,
          { limit, page }
        );
        return createSuccessResponse(
          {
            agent_id,
            total: data.data.length,
            versions: data.data,
            next_page: data.next_page,
          },
          response_format,
          { title: `Agent Versions: ${agent_id}` }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_list_agent_versions failed", { error: err, agent_id });
        return createErrorResponse(
          "API_ERROR",
          formatApiError(err, "list agent versions")
        );
      }
    },
  });

  // ===========================================================================
  // claudeagent_create_agent
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_create_agent",
    description: `Create a new Claude Managed Agent.

Pass the name, model, system prompt, tools, MCP servers, skills, and metadata. Returns the new agent ID and version. This is a one-time setup operation — store the returned agent_id and reuse it for all future sessions via claudeagent_create_session or claudeagent_run_task.

Args:
  - name (string, required): Human-readable agent name (1-256 chars)
  - model (string, required): Claude model identifier, e.g., 'claude-sonnet-4-6'
  - system (string, optional): System prompt (up to 100,000 chars)
  - description (string, optional): Short description (up to 2048 chars)
  - tools (array, optional): Tool configurations (max 128). Use [{"type": "agent_toolset_20260401"}] for the default full toolset.
  - mcp_servers (array, optional): MCP server configurations (max 20)
  - skills (array, optional): Skill configurations (max 20)
  - callable_agents (array, optional): For multi-agent: list of agent IDs this one can delegate to
  - metadata (object, optional): Key-value string metadata
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  Markdown with the new agent's ID, version, and suggested next step.

Examples:
  - Minimal agent: {"name": "My Agent", "model": "claude-sonnet-4-6", "tools": [{"type": "agent_toolset_20260401"}]}
  - With system prompt: {"name": "Research Bot", "model": "claude-sonnet-4-6", "system": "You are a thorough research assistant...", "tools": [{"type": "agent_toolset_20260401"}]}

Error Handling:
  - Returns INVALID_PARAMS if name or model is empty
  - Returns AUTH_REQUIRED if no API key is configured
  - Returns API_ERROR on Anthropic API failures`,
    inputSchema: CreateAgentInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { response_format, ...body } = params;
      try {
        const created = await apiPost<Agent>(
          getAccessToken()!,
          "/v1/agents",
          body
        );
        return createSuccessResponse(
          {
            agent_id: created.id,
            name: created.name,
            version: created.version,
            model: created.model,
            created_at: created.created_at,
            next_step: `Call claudeagent_create_session or claudeagent_run_task with agent_id: "${created.id}" to start using this agent.`,
          },
          response_format,
          { title: "Agent Created" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_create_agent failed", { error: err, name: body.name });
        return createErrorResponse("API_ERROR", formatApiError(err, "create agent"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_update_agent
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_update_agent",
    description: `Update an existing agent's configuration.

Requires the current version number for optimistic concurrency control — this prevents two concurrent updates from silently overwriting each other. Only pass the fields you want to change; unset fields are preserved. Updates create a new version.

To clear a nullable field (description, system), pass null explicitly.

Args:
  - agent_id (string, required): Agent to update
  - version (number, required): Current version — get it from claudeagent_get_agent first
  - name (string, optional): New name
  - description (string | null, optional): New description, or null to clear
  - system (string | null, optional): New system prompt, or null to clear
  - model (string, optional): New model
  - tools (array, optional): New tools array (replaces existing)
  - mcp_servers (array, optional): New MCP servers array
  - skills (array, optional): New skills array
  - metadata (object, optional): Metadata patch (set a key to null to delete it)
  - response_format ('markdown' | 'json'): Output format

Returns:
  Markdown confirming the update with the new version number.

Error Handling:
  - Returns VERSION_CONFLICT if the provided version doesn't match current — fetch the latest version and retry
  - Returns NOT_FOUND if agent_id doesn't exist`,
    inputSchema: UpdateAgentInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { agent_id, response_format, ...body } = params;
      try {
        const updated = await apiPost<Agent>(
          getAccessToken()!,
          `/v1/agents/${encodeURIComponent(agent_id)}`,
          body
        );
        return createSuccessResponse(
          {
            agent_id: updated.id,
            name: updated.name,
            new_version: updated.version,
            updated_at: updated.updated_at,
          },
          response_format,
          { title: "Agent Updated" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_update_agent failed", { error: err, agent_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "update agent"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_archive_agent
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_archive_agent",
    description: `Archive (soft-delete) an agent.

Archived agents cannot be used to create new sessions, but existing sessions continue to work. This is reversible via the Anthropic Console. Use this instead of deleting an agent so you retain the version history.

Args:
  - agent_id (string, required): Agent to archive
  - response_format ('markdown' | 'json'): Output format

Returns:
  Markdown confirmation with the archive timestamp.

Error Handling:
  - Returns NOT_FOUND if agent_id doesn't exist`,
    inputSchema: ArchiveAgentInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { agent_id, response_format } = params;
      try {
        const archived = await apiPost<Agent>(
          getAccessToken()!,
          `/v1/agents/${encodeURIComponent(agent_id)}/archive`,
          {}
        );
        return createSuccessResponse(
          {
            agent_id: archived.id,
            name: archived.name,
            archived_at: archived.archived_at,
          },
          response_format,
          { title: "Agent Archived" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_archive_agent failed", { error: err, agent_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "archive agent"));
      }
    },
  });
}
