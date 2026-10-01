import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { startHostedOAuth } from "./helpers.mjs";

// The hosted server at https://backworkhealth.com/mcp: OAuth only, and the grant is `backwork:mcp read`.
const READ_TOOLS = [
  "backwork_claim_validation",
  "backwork_compliance_review",
  "backwork_coverage_lookup",
  "backwork_drug_formulary_research",
  "backwork_policy_research",
  "backwork_prior_auth_research",
];

describe("the hosted OAuth server", () => {
  let hosted;
  before(async () => {
    hosted = await startHostedOAuth();
  });
  after(() => hosted.close());

  test("refuses tool listing without an OAuth token, and does not accept an API key in its place", async () => {
    const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    for (const headers of [{}, { Authorization: "Bearer bwk_live_not_an_oauth_token" }]) {
      const response = await fetch(hosted.mcpUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify(listTools),
      });
      assert.equal(response.status, 401);
      assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata=/);
    }
  });

  test("offers the coverage, claim, prior-auth, formulary and compliance tools, with read actions and inputs only", async () => {
    const client = await hosted.connect();
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), READ_TOOLS);

      const compliance = tools.find((tool) => tool.name === "backwork_compliance_review");
      assert.deepEqual(compliance.inputSchema.properties.action.enum, ["stats", "list_unreviewed"]);
      assert.deepEqual(Object.keys(compliance.inputSchema.properties).sort(), ["action", "change_type", "cursor", "limit", "response_format"]);
      assert.doesNotMatch(compliance.description, /acknowledg/i);

      const claims = tools.find((tool) => tool.name === "backwork_claim_validation");
      assert.equal(claims.inputSchema.properties.idempotency_key, undefined);

      for (const tool of tools) {
        assert.doesNotMatch(tool.description, /Not available on the production|Not offered|write access/, tool.name);
        assert.doesNotMatch(JSON.stringify(tool.inputSchema), /date of service/i, tool.name);
      }
    } finally {
      await client.close();
    }
  });

  test("rejects a write action before calling the API", async () => {
    const client = await hosted.connect();
    try {
      const result = await client.callTool({ name: "backwork_compliance_review", arguments: { action: "acknowledge", diff_id: 1 } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /acknowledge/);
    } finally {
      await client.close();
    }
  });
});
