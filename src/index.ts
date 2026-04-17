#!/usr/bin/env node
/**
 * MCP Server Entry Point
 *
 * Supports multiple transport modes based on environment:
 * - stdio: For local development and Claude Desktop (default)
 * - http: For production deployment (Cloud Run, etc.)
 *
 * Transport is selected via MCP_TRANSPORT environment variable:
 * - MCP_TRANSPORT=stdio (default)
 * - MCP_TRANSPORT=http
 *
 * This implementation uses the modern McpServer class with registerTool()
 * following mcp-builder best practices.
 *
 * Usage:
 *   npm run dev            # Development with tsx (stdio)
 *   npm run start          # Production (stdio)
 *   MCP_TRANSPORT=http npm run start  # HTTP server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { config } from "./config.js";
import { registerTools } from "./tools/index.js";
import { logger } from "./utils/logger.js";

// =============================================================================
// Transport Mode
// =============================================================================

type TransportMode = "stdio" | "http";

function getTransportMode(): TransportMode {
  const mode = process.env.MCP_TRANSPORT?.toLowerCase();
  if (mode === "http") {
    return "http";
  }
  return "stdio";
}

// =============================================================================
// Create MCP Server
// =============================================================================

/**
 * Create and configure the MCP server instance.
 * Uses the modern McpServer class with registerTool() API.
 */
function createServer(): McpServer {
  const server = new McpServer({
    name: config.serverName,
    version: config.serverVersion,
  });

  return server;
}

// =============================================================================
// Stdio Transport Server
// =============================================================================

async function startStdioServer() {
  logger.info("MCP Server Starting (Stdio Transport)", {
    serverName: config.serverName,
    version: config.serverVersion,
  });

  // Create MCP Server
  const server = createServer();

  // Anthropic API key for stdio mode (from ANTHROPIC_API_KEY env var)
  const accessToken = config.saasApi.defaultApiKey;
  if (!accessToken) {
    logger.warn(
      "No ANTHROPIC_API_KEY set — tools will return AUTH_REQUIRED errors. " +
      "Set ANTHROPIC_API_KEY in your MCP client config or .env file."
    );
  }

  // Register tools with a static token getter
  registerTools(server, () => accessToken);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("MCP Server connected via stdio");
}

// =============================================================================
// HTTP Transport Server
// =============================================================================

async function startHttpServer() {
  // Dynamically import the HTTP server to avoid loading Express for stdio mode
  const { startHttpServer: start } = await import("./http-server.js");
  await start();
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main() {
  const mode = getTransportMode();

  logger.info("Starting MCP Server", {
    transport: mode,
    serverName: config.serverName,
    version: config.serverVersion,
  });

  try {
    if (mode === "http") {
      await startHttpServer();
    } else {
      await startStdioServer();
    }
  } catch (error) {
    logger.error("Fatal error", {
      error: error instanceof Error ? error.message : "Unknown",
    });
    process.exit(1);
  }
}

main();
