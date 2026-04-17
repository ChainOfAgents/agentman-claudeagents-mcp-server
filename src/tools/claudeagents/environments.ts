/**
 * Environment CRUD tools (Step 2 of the Anthropic Console quickstart).
 *
 *   - claudeagent_list_environments
 *   - claudeagent_get_environment
 *   - claudeagent_create_environment
 *   - claudeagent_update_environment
 *   - claudeagent_archive_environment
 *   - claudeagent_delete_environment
 *
 * Environments define the container template that agents run in — what
 * packages are installed (apt/pip/npm/cargo/gem/go), what network hosts
 * are reachable, and general compute profile.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  AnthropicPaginationSchema,
  EnvironmentIdSchema,
  MetadataSchema,
  MetadataUpdateSchema,
  NetworkingTypeSchema,
  ResponseFormatSchema,
} from "../../schemas/index.js";
import {
  apiDelete,
  apiGet,
  apiPost,
  AuthExpiredError,
  formatApiError,
} from "../../services/api-client.js";
import { Environment, ListResponse } from "../../types/anthropic.js";
import { logger } from "../../utils/logger.js";
import {
  createErrorResponse,
  createSuccessResponse,
  registerTool,
  requireAuth,
} from "../shared.js";

// =============================================================================
// Helper: build environment config from flat tool params
// =============================================================================

interface EnvConfigParams {
  networking_type?: "unrestricted" | "limited";
  allowed_hosts?: string[];
  allow_package_managers?: boolean;
  allow_mcp_servers?: boolean;
  apt_packages?: string[];
  pip_packages?: string[];
  npm_packages?: string[];
  go_packages?: string[];
  cargo_packages?: string[];
  gem_packages?: string[];
}

function buildEnvironmentConfig(params: EnvConfigParams): Record<string, unknown> {
  const config: Record<string, unknown> = { type: "cloud" };

  // Networking
  if (params.networking_type === "limited") {
    config.networking = {
      type: "limited",
      allow_mcp_servers: params.allow_mcp_servers ?? false,
      allow_package_managers: params.allow_package_managers ?? false,
      allowed_hosts: params.allowed_hosts ?? [],
    };
  } else if (params.networking_type === "unrestricted") {
    config.networking = { type: "unrestricted" };
  }

  // Packages
  const packages: Record<string, unknown> = {};
  if (params.apt_packages) packages.apt = params.apt_packages;
  if (params.pip_packages) packages.pip = params.pip_packages;
  if (params.npm_packages) packages.npm = params.npm_packages;
  if (params.go_packages) packages.go = params.go_packages;
  if (params.cargo_packages) packages.cargo = params.cargo_packages;
  if (params.gem_packages) packages.gem = params.gem_packages;
  if (Object.keys(packages).length > 0) {
    packages.type = "packages";
    config.packages = packages;
  }

  return config;
}

// =============================================================================
// Input schemas
// =============================================================================

const ListEnvironmentsInputSchema = AnthropicPaginationSchema.extend({
  include_archived: z.boolean().default(false),
  response_format: ResponseFormatSchema,
});

const GetEnvironmentInputSchema = z.object({
  environment_id: EnvironmentIdSchema,
  response_format: ResponseFormatSchema,
});

const CreateEnvironmentInputSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(2048).optional(),
  networking_type: NetworkingTypeSchema,
  allowed_hosts: z
    .array(z.string())
    .optional()
    .describe("List of allowed hosts when networking_type is 'limited'"),
  allow_package_managers: z
    .boolean()
    .default(false)
    .describe(
      "Allow outbound to public package managers (pypi, npm) when networking is 'limited'"
    ),
  allow_mcp_servers: z
    .boolean()
    .default(false)
    .describe("Allow outbound to configured MCP servers when networking is 'limited'"),
  apt_packages: z.array(z.string()).optional(),
  pip_packages: z.array(z.string()).optional(),
  npm_packages: z.array(z.string()).optional(),
  go_packages: z.array(z.string()).optional(),
  cargo_packages: z.array(z.string()).optional(),
  gem_packages: z.array(z.string()).optional(),
  metadata: MetadataSchema.optional(),
  response_format: ResponseFormatSchema,
});

const UpdateEnvironmentInputSchema = z.object({
  environment_id: EnvironmentIdSchema,
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(2048).nullable().optional(),
  networking_type: NetworkingTypeSchema.optional(),
  allowed_hosts: z.array(z.string()).optional(),
  allow_package_managers: z.boolean().optional(),
  allow_mcp_servers: z.boolean().optional(),
  apt_packages: z.array(z.string()).optional(),
  pip_packages: z.array(z.string()).optional(),
  npm_packages: z.array(z.string()).optional(),
  go_packages: z.array(z.string()).optional(),
  cargo_packages: z.array(z.string()).optional(),
  gem_packages: z.array(z.string()).optional(),
  metadata: MetadataUpdateSchema.optional(),
  response_format: ResponseFormatSchema,
});

const EnvironmentIdOnlyInputSchema = z.object({
  environment_id: EnvironmentIdSchema,
  response_format: ResponseFormatSchema,
});

// =============================================================================
// Registration
// =============================================================================

export function registerEnvironmentTools(
  server: McpServer,
  getAccessToken: () => string | undefined
): void {
  // ===========================================================================
  // claudeagent_list_environments
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_list_environments",
    description: `List all container environments configured in the workspace.

Environments define the container template agents run in — what packages are installed, what hosts the container can reach on the network, and the general compute profile. Before creating a session, you need both an agent_id AND an environment_id.

Args:
  - limit (number): Max results (1-100, default: 20)
  - page (string): Pagination cursor
  - include_archived (boolean): Include archived environments (default: false)
  - response_format ('markdown' | 'json'): Output format

Returns:
  Markdown table of environments with id, name, networking type, and package count.`,
    inputSchema: ListEnvironmentsInputSchema,
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
        const data = await apiGet<ListResponse<Environment>>(
          getAccessToken()!,
          "/v1/environments",
          { limit, page, include_archived }
        );
        return createSuccessResponse(
          {
            total: data.data.length,
            environments: data.data,
            next_page: data.next_page,
          },
          response_format,
          { title: "Environments" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_list_environments failed", { error: err });
        return createErrorResponse("API_ERROR", formatApiError(err, "list environments"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_get_environment
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_get_environment",
    description: `Retrieve a specific environment's full configuration.

Returns the environment's name, description, networking policy (unrestricted or limited with allowlist), installed packages across all package managers, and metadata.

Args:
  - environment_id (string, required)
  - response_format ('markdown' | 'json')

Error Handling:
  - Returns NOT_FOUND if environment_id doesn't exist`,
    inputSchema: GetEnvironmentInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { environment_id, response_format } = params;
      try {
        const data = await apiGet<Environment>(
          getAccessToken()!,
          `/v1/environments/${encodeURIComponent(environment_id)}`
        );
        return createSuccessResponse(
          data as unknown as Record<string, unknown>,
          response_format,
          { title: `Environment: ${data.name}` }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_get_environment failed", { error: err, environment_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "get environment"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_create_environment
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_create_environment",
    description: `Create a new cloud environment for running agents.

Specify packages to install across apt/pip/npm/go/cargo/gem and the network access policy ('unrestricted' or 'limited' with an allowlist). If networking_type is 'limited', you can optionally allow_package_managers (PyPI, npm, etc.) and/or allow_mcp_servers (the MCP servers configured on agents) beyond the allowed_hosts list.

Args:
  - name (string, required)
  - description (string, optional)
  - networking_type ('unrestricted' | 'limited', default: 'unrestricted')
  - allowed_hosts (string[], required if networking_type is 'limited')
  - allow_package_managers (boolean, default: false)
  - allow_mcp_servers (boolean, default: false)
  - apt_packages, pip_packages, npm_packages, go_packages, cargo_packages, gem_packages (string[], optional)
  - metadata (object, optional)
  - response_format ('markdown' | 'json')

Examples:
  - Minimal unrestricted env: {"name": "my-env"}
  - Limited env with Python: {"name": "python-analytics", "networking_type": "limited", "allow_package_managers": true, "pip_packages": ["pandas", "numpy"]}
  - Strict sandbox: {"name": "sandbox", "networking_type": "limited", "allowed_hosts": ["api.internal.example.com"]}`,
    inputSchema: CreateEnvironmentInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { response_format, name, description, metadata, ...configParams } = params;
      const body: Record<string, unknown> = {
        name,
        config: buildEnvironmentConfig(configParams),
      };
      if (description !== undefined) body.description = description;
      if (metadata !== undefined) body.metadata = metadata;

      try {
        const created = await apiPost<Environment>(
          getAccessToken()!,
          "/v1/environments",
          body
        );
        return createSuccessResponse(
          {
            environment_id: created.id,
            name: created.name,
            created_at: created.created_at,
            next_step: `Use environment_id: "${created.id}" in claudeagent_create_session or claudeagent_run_task.`,
          },
          response_format,
          { title: "Environment Created" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_create_environment failed", { error: err, name });
        return createErrorResponse("API_ERROR", formatApiError(err, "create environment"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_update_environment
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_update_environment",
    description: `Update an environment's configuration.

Any field omitted from the input is preserved. Package lists are fully replaced by whatever is passed. To clear the description, pass null explicitly.

Args: same shape as claudeagent_create_environment, plus environment_id`,
    inputSchema: UpdateEnvironmentInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { environment_id, response_format, name, description, metadata, ...configParams } = params;
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (metadata !== undefined) body.metadata = metadata;

      // Only include config if any config-related field was set
      const hasConfigChange = Object.values(configParams).some((v) => v !== undefined);
      if (hasConfigChange) {
        body.config = buildEnvironmentConfig(configParams);
      }

      try {
        const updated = await apiPost<Environment>(
          getAccessToken()!,
          `/v1/environments/${encodeURIComponent(environment_id)}`,
          body
        );
        return createSuccessResponse(
          {
            environment_id: updated.id,
            name: updated.name,
            updated_at: updated.updated_at,
          },
          response_format,
          { title: "Environment Updated" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_update_environment failed", { error: err, environment_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "update environment"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_archive_environment
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_archive_environment",
    description: `Archive an environment (soft-delete).

Archived environments cannot be used to create new sessions. Prefer this over delete_environment unless you specifically need to remove the environment from the API. Archive is reversible via the Anthropic Console; delete is not.`,
    inputSchema: EnvironmentIdOnlyInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { environment_id, response_format } = params;
      try {
        const archived = await apiPost<Environment>(
          getAccessToken()!,
          `/v1/environments/${encodeURIComponent(environment_id)}/archive`,
          {}
        );
        return createSuccessResponse(
          {
            environment_id: archived.id,
            name: archived.name,
            archived_at: archived.archived_at,
          },
          response_format,
          { title: "Environment Archived" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_archive_environment failed", { error: err, environment_id });
        return createErrorResponse(
          "API_ERROR",
          formatApiError(err, "archive environment")
        );
      }
    },
  });

  // ===========================================================================
  // claudeagent_delete_environment
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_delete_environment",
    description: `Permanently delete an environment.

⚠️ WARNING: This is destructive and non-reversible. Prefer claudeagent_archive_environment unless you specifically need to remove the environment from the API.

Error Handling:
  - Returns CONFLICT if the environment is still in use by active sessions`,
    inputSchema: EnvironmentIdOnlyInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;

      const { environment_id, response_format } = params;
      try {
        await apiDelete(
          getAccessToken()!,
          `/v1/environments/${encodeURIComponent(environment_id)}`
        );
        return createSuccessResponse(
          {
            success: true,
            deleted_environment_id: environment_id,
          },
          response_format,
          { title: "Environment Deleted" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_delete_environment failed", { error: err, environment_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "delete environment"));
      }
    },
  });
}
