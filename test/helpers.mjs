import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Starts the built stdio server with the given environment and returns a connected client. */
export async function connect(env = {}) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["build/src/index.js"],
    env: { PATH: process.env.PATH ?? "", BACKWORK_API_KEY: "bwk_test_dummy", ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "backwork-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** The token the hosted test introspection endpoint accepts, with the hosted grant `backwork:mcp read`. */
export const READ_GRANT = "read-grant";

let hosted;

/**
 * Serves the built HTTP handler the way https://backworkhealth.com/mcp runs it:
 * OAuth only, with a read-only grant. The server reads its configuration when
 * first imported, so a test process gets one hosted server; later calls return it.
 * `apiBase` points tool calls at a fake Backwork API (default: production).
 */
export async function startHostedOAuth({ apiBase } = {}) {
  if (hosted) return hosted;

  const introspection = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const token = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("token");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(token === READ_GRANT ? { active: true, scope: "backwork:mcp read", client_id: "claude" } : { active: false }));
  });
  await new Promise((resolve) => introspection.listen(0, "127.0.0.1", resolve));

  process.env.BACKWORK_MCP_AUTH_MODE = "oauth";
  process.env.BACKWORK_MCP_OAUTH_AUTHORIZATION_SERVERS = "https://backworkhealth.com";
  process.env.BACKWORK_MCP_OAUTH_SCOPES = "backwork:mcp read";
  process.env.BACKWORK_MCP_OAUTH_REQUIRED_SCOPES = "backwork:mcp";
  process.env.BACKWORK_MCP_OAUTH_INTROSPECTION_URL = `http://127.0.0.1:${introspection.address().port}/introspect`;
  delete process.env.BACKWORK_MCP_EXPOSE_UNAVAILABLE_TOOLS;
  if (apiBase) process.env.BACKWORK_API_BASE = apiBase;
  else delete process.env.BACKWORK_API_BASE;

  const { handleHttpRequest } = await import("../build/src/index.js");
  const server = createServer(handleHttpRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const mcpUrl = new URL(`http://127.0.0.1:${server.address().port}/mcp`);

  hosted = {
    mcpUrl,
    /** A client connected with the given bearer token (default: the read-only grant). */
    async connect(token = READ_GRANT) {
      const client = new Client({ name: "backwork-mcp-hosted-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return client;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => introspection.close(resolve));
    },
  };
  return hosted;
}
