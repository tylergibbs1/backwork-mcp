import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The hosted server at https://backworkhealth.com/mcp: OAuth only, and the grant is `backwork:mcp read`.
const introspection = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const token = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("token");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(token === "read-grant" ? { active: true, scope: "backwork:mcp read", client_id: "claude" } : { active: false }));
});
await new Promise((resolve) => introspection.listen(0, "127.0.0.1", resolve));

process.env.BACKWORK_MCP_AUTH_MODE = "oauth";
process.env.BACKWORK_MCP_OAUTH_AUTHORIZATION_SERVERS = "https://backworkhealth.com";
process.env.BACKWORK_MCP_OAUTH_SCOPES = "backwork:mcp read";
process.env.BACKWORK_MCP_OAUTH_REQUIRED_SCOPES = "backwork:mcp";
process.env.BACKWORK_MCP_OAUTH_INTROSPECTION_URL = `http://127.0.0.1:${introspection.address().port}/introspect`;
delete process.env.BACKWORK_API_BASE;
delete process.env.BACKWORK_MCP_EXPOSE_UNAVAILABLE_TOOLS;

const { handleHttpRequest } = await import("../build/src/index.js");

const READ_TOOLS = [
  "backwork_claim_validation",
  "backwork_compliance_review",
  "backwork_coverage_lookup",
  "backwork_drug_formulary_research",
  "backwork_policy_research",
  "backwork_prior_auth_research",
  "backwork_system_health",
];

describe("the hosted OAuth server", () => {
  let server;
  let mcpUrl;
  before(async () => {
    server = createServer(handleHttpRequest);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    mcpUrl = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => introspection.close(resolve));
  });

  async function connect(token) {
    const client = new Client({ name: "backwork-mcp-hosted-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  }

  test("refuses tool listing without an OAuth token, and does not accept an API key in its place", async () => {
    const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    for (const headers of [{}, { Authorization: "Bearer bwk_live_not_an_oauth_token" }]) {
      const response = await fetch(mcpUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify(listTools),
      });
      assert.equal(response.status, 401);
      assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata=/);
    }
  });

  test("offers the coverage, claim, prior-auth and formulary tools, and only read actions", async () => {
    const client = await connect("read-grant");
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), READ_TOOLS);

      const compliance = tools.find((tool) => tool.name === "backwork_compliance_review");
      assert.deepEqual(compliance.inputSchema.properties.action.enum, ["stats", "list_unreviewed"]);
      assert.match(compliance.description, /Not offered on this read-only connection \(they need write access\): 'acknowledge', 'bulk_acknowledge'\./);
      assert.equal(compliance.annotations.readOnlyHint, true);

      for (const tool of tools) {
        assert.doesNotMatch(tool.description, /Not available on the production/, tool.name);
        assert.equal(tool.annotations.destructiveHint, false, tool.name);
      }
    } finally {
      await client.close();
    }
  });

  test("rejects a write action before calling the API", async () => {
    const client = await connect("read-grant");
    try {
      const result = await client.callTool({ name: "backwork_compliance_review", arguments: { action: "acknowledge", diff_id: 1 } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /acknowledge/);
    } finally {
      await client.close();
    }
  });
});
