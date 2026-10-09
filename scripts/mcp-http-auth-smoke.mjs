import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const serverEntry = resolve(process.argv[2] || "build/src/index.js");
const require = createRequire(serverEntry);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const introspectionBodies = [];
const introspectionServer = createServer(async (req, res) => {
  assert.equal(req.method, "POST");
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  introspectionBodies.push(body);
  const token = new URLSearchParams(body).get("token");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ active: token === "valid-token", scope: "backwork:mcp read" }));
});

await new Promise((resolve) => introspectionServer.listen(0, "127.0.0.1", resolve));
const introspectionAddress = introspectionServer.address();
assert.ok(introspectionAddress && typeof introspectionAddress === "object");

process.env.BACKWORK_MCP_AUTH_MODE = "oauth";
process.env.BACKWORK_MCP_OAUTH_AUTHORIZATION_SERVERS = "https://auth.backwork.example";
process.env.BACKWORK_MCP_OAUTH_INTROSPECTION_URL = `http://127.0.0.1:${introspectionAddress.port}/introspect`;
process.env.BACKWORK_MCP_OAUTH_SCOPES = "backwork:mcp read";
process.env.BACKWORK_MCP_OAUTH_REQUIRED_SCOPES = "backwork:mcp";
process.env.BACKWORK_MCP_PUBLIC_URL = "https://mcp.backwork.example";

const { handleHttpRequest } = await import(pathToFileURL(serverEntry));

const server = createServer(handleHttpRequest);
const client = new Client({ name: "backwork-mcp-http-smoke", version: "1.0.0" });

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const metadataResponse = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`, {
    headers: { Host: "127.0.0.1" },
  });
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.resource, "https://mcp.backwork.example/mcp");
  assert.deepEqual(metadata.authorization_servers, ["https://auth.backwork.example"]);
  assert.deepEqual(metadata.scopes_supported, ["backwork:mcp", "read"]);

  const pathMetadataResponse = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`, {
    headers: { Host: "127.0.0.1" },
  });
  assert.equal(pathMetadataResponse.status, 200);

  const mcpResponse = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Host: "127.0.0.1", "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(mcpResponse.status, 401);
  assert.match(mcpResponse.headers.get("www-authenticate") || "", /resource_metadata="https:\/\/mcp\.backwork\.example\/\.well-known\/oauth-protected-resource"/);

  const invalidTokenResponse = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Host: "127.0.0.1", "Content-Type": "application/json", Authorization: "Bearer expired-token" },
    body: "{}",
  });
  assert.equal(invalidTokenResponse.status, 401);
  const invalidTokenBody = await invalidTokenResponse.json();
  assert.equal(invalidTokenBody.error, "invalid_token");
  assert.match(introspectionBodies.at(-1) || "", /token=expired-token/);

  const activeTokenResponse = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Host: "127.0.0.1", "Content-Type": "application/json", Authorization: "Bearer valid-token" },
    body: "{",
  });
  assert.equal(activeTokenResponse.status, 400);
  const activeTokenBody = await activeTokenResponse.json();
  assert.equal(activeTokenBody.error, "invalid_json");
  assert.match(introspectionBodies.at(-1) || "", /token=valid-token/);

  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: "Bearer valid-token" } },
  }));
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "backwork_coverage_lookup"));
  assert.equal(tools.some((tool) => tool.name === "backwork_webhook_management"), false);
  const invalidPolicyCall = await client.callTool({
    name: "backwork_policy_research",
    arguments: { action: "get", response_format: "json" },
  });
  assert.equal(invalidPolicyCall.isError, true);

  console.log(`MCP HTTP OAuth smoke test passed: initialization, ${tools.length} tools and a tool call on ${process.version}.`);
} finally {
  await client.close();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await new Promise((resolve, reject) => introspectionServer.close((error) => (error ? reject(error) : resolve())));
}
