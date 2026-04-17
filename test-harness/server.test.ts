/**
 * MCP Server Test Harness
 *
 * End-to-end test for your MCP server using @chainofagents/auth.
 * Covers public endpoints, OAuth discovery, and authenticated tool calls.
 *
 * Prerequisites:
 *   npm install @chainofagents/auth open
 *   npm install -D tsx @types/node
 *
 * Usage:
 *   npx tsx test-harness/server.test.ts                            # all tests
 *   npx tsx test-harness/server.test.ts --public                   # public only
 *   npx tsx test-harness/server.test.ts --auth                     # auth only (OAuth)
 *   npx tsx test-harness/server.test.ts --discovery                # OAuth discovery only
 *   npx tsx test-harness/server.test.ts --server http://localhost:9010/mcp  # custom URL
 */

import {
  TestRunner,
  assert,
  assertEqual,
  assertDefined,
  assertArray,
} from '@chainofagents/auth/testing';

import {
  McpClient,
  createAuthenticatedClient,
  createPublicClient,
} from '@chainofagents/auth/client';

// ============================================================================
// Configuration
// ============================================================================

// Parse --server flag or use env var
const serverFlagIdx = process.argv.indexOf('--server');
const SERVER_URL = serverFlagIdx !== -1
  ? process.argv[serverFlagIdx + 1]
  : process.env.MCP_SERVER_URL || 'http://localhost:8010/mcp';

// OAuth config for authenticated tests
// CUSTOMIZE: Update scopes for your SaaS provider
const OAUTH_CONFIG = {
  scopes: [
    // 'https://www.googleapis.com/auth/gmail.readonly',
    // 'https://www.googleapis.com/auth/gmail.send',
  ],
};

// ============================================================================
// Domain-Specific Client (CUSTOMIZE)
//
// Extend McpClient with typed convenience methods for your tools.
// ============================================================================

class MyMcpClient extends McpClient {
  // Example: typed wrapper for a tool
  // async listItems(options: { limit?: number; offset?: number } = {}) {
  //   return this.callToolJson<{
  //     items: Array<{ id: string; name: string }>;
  //     total: number;
  //   }>('example_list_items', {
  //     limit: options.limit,
  //     offset: options.offset,
  //     response_format: 'json',
  //   });
  // }
}

// Factory helpers
async function createAuthenticatedMyClient(serverUrl: string): Promise<MyMcpClient> {
  const client = new MyMcpClient({ serverUrl, oauth: OAUTH_CONFIG });
  await client.authenticate();
  return client;
}

function createPublicMyClient(serverUrl: string): MyMcpClient {
  return new MyMcpClient(serverUrl);
}

// ============================================================================
// Parse CLI args
// ============================================================================

const args = process.argv.slice(2).filter(a => !a.startsWith('http'));
const hasFlag = (flag: string) => args.includes(flag);
const noSpecificFlags = !hasFlag('--public') && !hasFlag('--auth') && !hasFlag('--discovery');
const runPublic = hasFlag('--public') || noSpecificFlags;
const runDiscovery = hasFlag('--discovery') || noSpecificFlags;
const runAuth = hasFlag('--auth') || noSpecificFlags;

console.log(`\nMCP Server: ${SERVER_URL}`);
console.log(`Running: ${noSpecificFlags ? 'all' : args.filter(a => a.startsWith('--')).join(', ')} tests\n`);

const runner = new TestRunner();

// ============================================================================
// Public Tests (No Auth Required)
// ============================================================================

if (runPublic) {
  runner.suite('Public (No Auth)');

  await runner.test('POST /mcp without auth - returns 401', async () => {
    const baseUrl = SERVER_URL.replace(/\/mcp$/, '');
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
        id: 1,
      }),
    });
    assertEqual(res.status, 401, 'Should return 401 without auth');
  });

  await runner.test('nonexistent tool - returns error', async () => {
    // This test requires auth in most configs, so it's commented out by default
    // const client = createPublicMyClient(SERVER_URL);
    // const result = await client.callTool('nonexistent_tool');
    // assert(result.isError === true, 'Should return error for unknown tool');
    assert(true, 'Placeholder - customize for your server');
  });
}

// ============================================================================
// OAuth Discovery Tests
// ============================================================================

if (runDiscovery) {
  runner.suite('OAuth Discovery');
  const baseUrl = SERVER_URL.replace(/\/mcp$/, '');

  await runner.test('protected resource metadata (RFC 9728)', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    assert(res.ok, `Should return 200, got ${res.status}`);
    const data = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported?: string[];
    };
    assertDefined(data.resource, 'Should have resource');
    assertArray(data.authorization_servers, 'Should have authorization_servers');
    assert(data.authorization_servers.length > 0, 'Should have at least one auth server');
    console.log(`         Resource: ${data.resource}`);
    console.log(`         Auth server: ${data.authorization_servers[0]}`);
  });

  await runner.test('authorization server metadata (RFC 8414)', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    assert(res.ok, `Should return 200, got ${res.status}`);
    const data = (await res.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint?: string;
      code_challenge_methods_supported?: string[];
    };
    assertDefined(data.issuer, 'Should have issuer');
    assertDefined(data.authorization_endpoint, 'Should have authorization_endpoint');
    assertDefined(data.token_endpoint, 'Should have token_endpoint');
    console.log(`         Issuer: ${data.issuer}`);
    console.log(`         Auth: ${data.authorization_endpoint}`);
    console.log(`         Token: ${data.token_endpoint}`);
    if (data.registration_endpoint) {
      console.log(`         Register: ${data.registration_endpoint}`);
    }
    if (data.code_challenge_methods_supported) {
      assert(
        data.code_challenge_methods_supported.includes('S256'),
        'Should support S256 PKCE'
      );
    }
  });

  await runner.test('dynamic client registration (RFC 7591)', async () => {
    const metaRes = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    const metadata = (await metaRes.json()) as { registration_endpoint?: string };
    if (!metadata.registration_endpoint) {
      console.log('         Skipped: no registration_endpoint');
      return;
    }

    const regRes = await fetch(metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test Harness',
        redirect_uris: ['http://localhost:8787/callback'],
        response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assertEqual(regRes.status, 201, 'Registration should return 201');
    const client = (await regRes.json()) as { client_id: string; client_name: string };
    assertDefined(client.client_id, 'Should return client_id');
    console.log(`         Registered: ${client.client_id}`);
  });
}

// ============================================================================
// Authenticated Tests (requires OAuth)
// ============================================================================

if (runAuth) {
  runner.suite('Authenticated Tools');
  let client: MyMcpClient;

  await runner.test('authenticate - OAuth flow succeeds', async () => {
    // Clear cached tokens to avoid stale client IDs
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tokenCache = path.join(os.homedir(), '.mcp-oauth-tokens.json');
    if (fs.existsSync(tokenCache)) {
      fs.unlinkSync(tokenCache);
    }

    client = await createAuthenticatedMyClient(SERVER_URL);
    assert(client.isAuthenticated(), 'Client should be authenticated');
  });

  await runner.test('initialize - MCP handshake with token', async () => {
    const response = await client.initialize();
    assertDefined(response.result, 'Should return init result');
  });

  await runner.test('tools/list - returns tools', async () => {
    const response = await client.listTools();
    assertDefined(response.result, 'Should return tools result');
    const result = response.result as { tools: Array<{ name: string }> };
    assertArray(result.tools, 'Should have tools array');
    assert(result.tools.length > 0, 'Should have at least one tool');
    console.log(`         Found ${result.tools.length} tools: ${result.tools.map(t => t.name).join(', ')}`);
  });

  // ---- CUSTOMIZE: Add your authenticated tool tests below ----

  // await runner.test('list_items - search items', async () => {
  //   const data = await client.listItems({ limit: 5 });
  //   assertArray(data.items, 'Should return items');
  //   console.log(`         Found ${data.items.length} items`);
  // });
}

// ============================================================================
// Summary & Exit
// ============================================================================

runner.printSummary();
const summary = runner.getSummary();
process.exit(summary.failed > 0 ? 1 : 0);
