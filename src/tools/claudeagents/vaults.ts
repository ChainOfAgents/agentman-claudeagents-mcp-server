/**
 * Vault & Credential tools — the MCP credential store.
 *
 *   - claudeagent_create_vault
 *   - claudeagent_list_vaults
 *   - claudeagent_get_vault
 *   - claudeagent_delete_vault
 *   - claudeagent_create_credential
 *   - claudeagent_list_credentials
 *   - claudeagent_delete_credential
 *
 * Vaults store credentials for the MCP servers an agent connects to. The
 * agent's `mcp_servers` array declares servers by {type:"url", name, url} with
 * NO auth; the vault holds the secret, matched to a server by URL, and is
 * attached to a session via `vault_ids` at session creation. Anthropic injects
 * the credential into outbound MCP calls — it never enters the sandbox.
 *
 * Two credential types:
 *   - static_bearer : a fixed token (API key / PAT / app token). No refresh.
 *   - mcp_oauth     : OAuth 2.0 access token; pass a `refresh` block and
 *                     Anthropic auto-refreshes it.
 *
 * Vaults are workspace-scoped: anyone with an API key for the same workspace
 * can reference them, so the workspace IS the tenant-isolation boundary.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  AnthropicPaginationSchema,
  CredentialIdSchema,
  MetadataSchema,
  ResponseFormatSchema,
  VaultIdSchema,
} from "../../schemas/index.js";
import {
  apiDelete,
  apiGet,
  apiPost,
  AuthExpiredError,
  formatApiError,
} from "../../services/api-client.js";
import { Credential, ListResponse, Vault } from "../../types/anthropic.js";
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

const CreateVaultInputSchema = z.object({
  display_name: z
    .string()
    .min(1)
    .max(256)
    .describe("Human-readable vault name, e.g. an end-user or deal label"),
  metadata: MetadataSchema.optional(),
  response_format: ResponseFormatSchema,
});

const ListVaultsInputSchema = AnthropicPaginationSchema.extend({
  include_archived: z.boolean().default(false),
  response_format: ResponseFormatSchema,
});

const GetVaultInputSchema = z.object({
  vault_id: VaultIdSchema,
  response_format: ResponseFormatSchema,
});

const DeleteVaultInputSchema = z.object({
  vault_id: VaultIdSchema,
  response_format: ResponseFormatSchema,
});

// Credential auth — discriminated by `type`. Secret fields are write-only.
const StaticBearerAuthSchema = z.object({
  type: z.literal("static_bearer"),
  mcp_server_url: z
    .string()
    .url()
    .describe("Exact URL of the MCP server this credential authenticates"),
  token: z.string().min(1).describe("Fixed bearer token (API key / PAT)"),
});

const McpOAuthRefreshSchema = z
  .object({
    refresh_token: z.string(),
    token_endpoint: z.string().url(),
    client_id: z.string(),
    scope: z.string().optional(),
    token_endpoint_auth: z
      .object({
        type: z.enum([
          "none",
          "client_secret_basic",
          "client_secret_post",
        ]),
        client_secret: z.string().optional(),
      })
      .optional(),
  })
  .describe("Refresh block — supply to have Anthropic auto-refresh the token");

const McpOAuthAuthSchema = z.object({
  type: z.literal("mcp_oauth"),
  mcp_server_url: z.string().url(),
  access_token: z.string().min(1),
  expires_at: z
    .string()
    .optional()
    .describe("RFC 3339 expiry of the access token"),
  refresh: McpOAuthRefreshSchema.optional(),
});

const CreateCredentialInputSchema = z.object({
  vault_id: VaultIdSchema,
  display_name: z.string().min(1).max(256),
  auth: z
    .union([StaticBearerAuthSchema, McpOAuthAuthSchema])
    .describe("static_bearer (fixed token) or mcp_oauth (with optional refresh)"),
  response_format: ResponseFormatSchema,
});

const ListCredentialsInputSchema = AnthropicPaginationSchema.extend({
  vault_id: VaultIdSchema,
  include_archived: z.boolean().default(false),
  response_format: ResponseFormatSchema,
});

const DeleteCredentialInputSchema = z.object({
  vault_id: VaultIdSchema,
  credential_id: CredentialIdSchema,
  response_format: ResponseFormatSchema,
});

// =============================================================================
// Registration
// =============================================================================

export function registerVaultTools(
  server: McpServer,
  getAccessToken: () => string | undefined
): void {
  // ===========================================================================
  // claudeagent_create_vault
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_create_vault",
    description: `Create a vault — a workspace-scoped collection of MCP credentials.

A vault holds the secrets for the MCP servers an agent connects to, typically one vault per end user or per deal. Tag it with metadata (e.g. {"deal":"1440-foods"} or {"external_user_id":"usr_abc"}) so you can map it back to your own records. After creating, add credentials with claudeagent_create_credential, then pass the vault id to claudeagent_create_session / claudeagent_run_task via vault_ids.

Args:
  - display_name (string, required): Human-readable label
  - metadata (object, optional): Key-value string tags
  - response_format ('markdown' | 'json')

Returns:
  The new vault id (vlt_...) and metadata.

Error Handling:
  - Returns AUTH_REQUIRED if no API key is configured
  - Returns API_ERROR on Anthropic API failures`,
    inputSchema: CreateVaultInputSchema,
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
        const vault = await apiPost<Vault>(getAccessToken()!, "/v1/vaults", body);
        return createSuccessResponse(
          {
            vault_id: vault.id,
            display_name: vault.display_name,
            metadata: vault.metadata,
            next_step: `Add a credential: claudeagent_create_credential(vault_id="${vault.id}", ...)`,
          },
          response_format,
          { title: "Vault Created" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_create_vault failed", { error: err });
        return createErrorResponse("API_ERROR", formatApiError(err, "create vault"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_list_vaults
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_list_vaults",
    description: `List vaults in the workspace (newest first, paginated).

Args:
  - limit (number): Max results (1-100, default: 20)
  - page (string): Pagination cursor
  - include_archived (boolean): Include archived vaults (default: false)
  - response_format ('markdown' | 'json')

Returns:
  Vault ids, display names, and metadata. Secrets are never returned.`,
    inputSchema: ListVaultsInputSchema,
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
        const data = await apiGet<ListResponse<Vault>>(
          getAccessToken()!,
          "/v1/vaults",
          { limit, page, include_archived }
        );
        return createSuccessResponse(
          { total: data.data.length, vaults: data.data, next_page: data.next_page },
          response_format,
          { title: "Vaults" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_list_vaults failed", { error: err });
        return createErrorResponse("API_ERROR", formatApiError(err, "list vaults"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_get_vault
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_get_vault",
    description: `Get a vault's metadata by id. Secrets are never returned.

Args:
  - vault_id (string, required)
  - response_format ('markdown' | 'json')

Error Handling:
  - Returns NOT_FOUND if vault_id doesn't exist`,
    inputSchema: GetVaultInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;
      const { vault_id, response_format } = params;
      try {
        const vault = await apiGet<Vault>(
          getAccessToken()!,
          `/v1/vaults/${encodeURIComponent(vault_id)}`
        );
        return createSuccessResponse(
          vault as unknown as Record<string, unknown>,
          response_format,
          { title: "Vault" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_get_vault failed", { error: err, vault_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "get vault"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_delete_vault
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_delete_vault",
    description: `Delete a vault and all its credentials (hard delete; not retained).

Sessions already referencing this vault keep running; new sessions cannot use it. Prefer this for cleanup of throwaway/per-task vaults.

Args:
  - vault_id (string, required)
  - response_format ('markdown' | 'json')`,
    inputSchema: DeleteVaultInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;
      const { vault_id, response_format } = params;
      try {
        await apiDelete(getAccessToken()!, `/v1/vaults/${encodeURIComponent(vault_id)}`);
        return createSuccessResponse(
          { deleted: true, vault_id },
          response_format,
          { title: "Vault Deleted" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_delete_vault failed", { error: err, vault_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "delete vault"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_create_credential
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_create_credential",
    description: `Add a credential to a vault, bound to one MCP server URL.

The credential authenticates the agent's outbound calls to the MCP server whose url EXACTLY matches mcp_server_url. Two types:

  static_bearer — a fixed token. auth = {type:"static_bearer", mcp_server_url, token}
  mcp_oauth     — an OAuth access token; include a refresh block and Anthropic
                  auto-refreshes it. auth = {type:"mcp_oauth", mcp_server_url,
                  access_token, expires_at?, refresh?}

Constraints: one active credential per mcp_server_url per vault (409 on conflict); mcp_server_url is immutable; max 20 credentials per vault. Secret fields are write-only.

Args:
  - vault_id (string, required)
  - display_name (string, required)
  - auth (object, required): static_bearer or mcp_oauth (see above)
  - response_format ('markdown' | 'json')

Returns:
  The new credential id (vcrd_...). Secrets are not echoed back.`,
    inputSchema: CreateCredentialInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;
      const { vault_id, response_format, ...body } = params;
      try {
        const cred = await apiPost<Credential>(
          getAccessToken()!,
          `/v1/vaults/${encodeURIComponent(vault_id)}/credentials`,
          body
        );
        return createSuccessResponse(
          {
            credential_id: cred.id,
            vault_id,
            display_name: cred.display_name,
          },
          response_format,
          { title: "Credential Created" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_create_credential failed", { error: err, vault_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "create credential"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_list_credentials
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_list_credentials",
    description: `List credentials in a vault (metadata only; secrets never returned).

Args:
  - vault_id (string, required)
  - limit (number): Max results (1-100, default: 20)
  - page (string): Pagination cursor
  - include_archived (boolean): default false
  - response_format ('markdown' | 'json')`,
    inputSchema: ListCredentialsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;
      const { vault_id, limit, page, include_archived, response_format } = params;
      try {
        const data = await apiGet<ListResponse<Credential>>(
          getAccessToken()!,
          `/v1/vaults/${encodeURIComponent(vault_id)}/credentials`,
          { limit, page, include_archived }
        );
        return createSuccessResponse(
          { vault_id, total: data.data.length, credentials: data.data, next_page: data.next_page },
          response_format,
          { title: "Credentials" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_list_credentials failed", { error: err, vault_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "list credentials"));
      }
    },
  });

  // ===========================================================================
  // claudeagent_delete_credential
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_delete_credential",
    description: `Delete a credential from a vault (hard delete; frees its mcp_server_url for a replacement).

Args:
  - vault_id (string, required)
  - credential_id (string, required)
  - response_format ('markdown' | 'json')`,
    inputSchema: DeleteCredentialInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<CallToolResult> => {
      const authError = requireAuth(getAccessToken());
      if (authError) return authError;
      const { vault_id, credential_id, response_format } = params;
      try {
        await apiDelete(
          getAccessToken()!,
          `/v1/vaults/${encodeURIComponent(vault_id)}/credentials/${encodeURIComponent(credential_id)}`
        );
        return createSuccessResponse(
          { deleted: true, vault_id, credential_id },
          response_format,
          { title: "Credential Deleted" }
        );
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        logger.error("claudeagent_delete_credential failed", { error: err, vault_id, credential_id });
        return createErrorResponse("API_ERROR", formatApiError(err, "delete credential"));
      }
    },
  });
}
