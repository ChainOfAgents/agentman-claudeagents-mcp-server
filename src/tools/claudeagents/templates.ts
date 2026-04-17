/**
 * Template tools — claudeagent_list_templates, claudeagent_get_template
 *
 * These tools let users discover and retrieve bundled agent configuration
 * templates. They don't call the Anthropic API; templates are loaded from
 * src/templates/ at module init and served from memory.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import YAML from "yaml";
import { z } from "zod";

import { ResponseFormatSchema } from "../../schemas/index.js";
import { listTemplates, getTemplate, TemplateFile } from "../../services/templates.js";
import { registerTool, createSuccessResponse, createErrorResponse } from "../shared.js";

// =============================================================================
// Input schemas
// =============================================================================

const ListTemplatesInputSchema = z.object({
  category: z
    .string()
    .max(100)
    .optional()
    .describe("Optional category filter (e.g., 'research', 'support', 'ops', 'data')"),
  response_format: ResponseFormatSchema,
});

const GetTemplateInputSchema = z.object({
  template_slug: z
    .string()
    .min(1)
    .max(200)
    .describe("Template slug, e.g., 'deep-researcher'"),
  format: z
    .enum(["yaml", "json"])
    .default("yaml")
    .describe("Output format for the template config body"),
  response_format: ResponseFormatSchema,
});

// =============================================================================
// Registration
// =============================================================================

export function registerTemplateTools(server: McpServer): void {
  // ===========================================================================
  // claudeagent_list_templates
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_list_templates",
    description: `List agent templates bundled with agentman-claudeagents-mcp-server.

Returns a catalog of ready-to-use Claude Managed Agents configurations: Blank, Deep researcher, Structured extractor, Field monitor, Support agent, Incident commander, Feedback miner, Sprint retro facilitator, Support-to-eng escalator, Data analyst. Use this tool to show the user what templates are available before creating an agent — then call claudeagent_get_template to fetch the full YAML/JSON of the chosen template.

Args:
  - category (string, optional): Filter by category, e.g., 'research', 'support', 'ops', 'data'
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  Markdown table of templates with slug, name, description, category, and default_model. For JSON format, a structured list.

Examples:
  - List all templates: {}
  - List data-focused templates: {"category": "data"}
  - Get as JSON: {"response_format": "json"}

Error Handling:
  - Returns an empty list if no templates match the category filter.
  - Never errors under normal conditions — templates are bundled with the package.`,
    inputSchema: ListTemplatesInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (params): Promise<CallToolResult> => {
      const { category, response_format } = params;
      const templates = listTemplates(category);

      const summarized = templates.map((t) => ({
        slug: t.slug,
        name: t.name,
        description: t.description,
        category: t.category,
        default_model:
          typeof t.config.model === "string"
            ? t.config.model
            : (t.config.model as Record<string, unknown> | undefined)?.id ?? "unknown",
      }));

      return createSuccessResponse(
        {
          total: summarized.length,
          templates: summarized,
        },
        response_format,
        { title: "Available Agent Templates" }
      );
    },
  });

  // ===========================================================================
  // claudeagent_get_template
  // ===========================================================================
  registerTool(server, {
    name: "claudeagent_get_template",
    description: `Retrieve the full YAML or JSON of a specific agent template, ready to be passed to claudeagent_create_agent.

Use this tool after claudeagent_list_templates when the user has chosen a template. The returned config can be passed directly (after any customization) to claudeagent_create_agent to create a new Claude Managed Agent based on the template.

Args:
  - template_slug (string, required): The template slug from claudeagent_list_templates, e.g., 'deep-researcher'
  - format ('yaml' | 'json'): Format for the config body (default: 'yaml')
  - response_format ('markdown' | 'json'): Output format of the tool response itself (default: 'markdown')

Returns:
  The template's full configuration including name, description, model, system prompt, tools, mcp_servers, and skills. In markdown format, the config is wrapped in a code block; in JSON format, it's a structured object.

Examples:
  - Get the deep researcher template as YAML: {"template_slug": "deep-researcher"}
  - Get as JSON: {"template_slug": "support-agent", "format": "json"}

Error Handling:
  - Returns NOT_FOUND if template_slug doesn't match any bundled template. Call claudeagent_list_templates first to see valid slugs.`,
    inputSchema: GetTemplateInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (params): Promise<CallToolResult> => {
      const { template_slug, format, response_format } = params;
      const template = getTemplate(template_slug);
      if (!template) {
        return createErrorResponse(
          "NOT_FOUND",
          `No template found with slug '${template_slug}'. Call claudeagent_list_templates to see available templates.`
        );
      }
      return createSuccessResponse(
        renderTemplate(template, format),
        response_format,
        { title: `Template: ${template.name}` }
      );
    },
  });
}

// =============================================================================
// Helpers
// =============================================================================

function renderTemplate(
  template: TemplateFile,
  format: "yaml" | "json"
): Record<string, unknown> {
  const body =
    format === "yaml"
      ? YAML.stringify(template.config)
      : JSON.stringify(template.config, null, 2);

  return {
    slug: template.slug,
    name: template.name,
    description: template.description,
    category: template.category,
    format,
    config_body: body,
    next_step:
      "Pass the config body to claudeagent_create_agent (optionally customizing name, model, or system prompt) to create the agent.",
  };
}
