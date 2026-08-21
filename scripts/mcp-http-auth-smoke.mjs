import assert from "node:assert/strict";
import { createServer } from "node:http";

const introspectionBodies = [];
const introspectionServer = createServer(async (req, res) => {
  assert.equal(req.method, "POST");
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  introspectionBodies.push(body);
  const token = new URLSearchParams(body).get("token");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ active: token === "valid-token" }));
});

await new Promise((resolve) => introspectionServer.listen(0, "127.0.0.1", resolve));
const introspectionAddress = introspectionServer.address();
assert.ok(introspectionAddress && typeof introspectionAddress === "object");

process.env.BACKWORK_MCP_AUTH_MODE = "oauth";
process.env.BACKWORK_MCP_OAUTH_AUTHORIZATION_SERVERS = "https://auth.backwork.example";
process.env.BACKWORK_MCP_OAUTH_INTROSPECTION_URL = `http://127.0.0.1:${introspectionAddress.port}/introspect`;
process.env.BACKWORK_MCP_OAUTH_SCOPES = "backwork:mcp";
process.env.BACKWORK_MCP_PUBLIC_URL = "https://mcp.backwork.example";

const { handleHttpRequest } = await import("../build/src/index.js");

const server = createServer(handleHttpRequest);

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
  assert.deepEqual(metadata.scopes_supported, ["backwork:mcp"]);

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

  console.log("MCP HTTP OAuth smoke test passed.");
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await new Promise((resolve, reject) => introspectionServer.close((error) => (error ? reject(error) : resolve())));
}
