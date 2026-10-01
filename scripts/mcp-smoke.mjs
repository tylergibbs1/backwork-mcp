import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const toolNames = [
  "coverage_lookup",
  "policy_research",
  "claim_validation",
  "prior_auth_research",
  "drug_formulary_research",
  "compliance_review",
  "webhook_management",
  "system_health",
];

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/src/index.js"],
  env: {
    ...process.env,
    BACKWORK_API_KEY: "bwk_test_dummy",
    // Production hides tools whose endpoints are unavailable; test/tools.test.mjs covers that.
    BACKWORK_MCP_EXPOSE_UNAVAILABLE_TOOLS: "true",
  },
});

const client = new Client({ name: "backwork-mcp-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  assert.equal(tools.length, toolNames.length, "expected one prefixed tool per supported workflow");

  for (const toolName of toolNames) {
    const primaryName = `backwork_${toolName}`;
    const primary = byName.get(primaryName);

    assert.ok(primary, `missing primary tool ${primaryName}`);
    assert.equal(byName.has(toolName), false, `unprefixed alias ${toolName} should not be advertised`);
    assert.ok(primary.title, `${primaryName} should have a title`);
    assert.ok(primary.description?.includes("response_format"), `${primaryName} should document response_format`);
    assert.ok(primary.inputSchema?.properties?.response_format, `${primaryName} should accept response_format`);
    assert.ok(primary.outputSchema, `${primaryName} should expose outputSchema`);
    assert.equal(typeof primary.annotations?.readOnlyHint, "boolean", `${primaryName} should set readOnlyHint`);
    assert.equal(typeof primary.annotations?.destructiveHint, "boolean", `${primaryName} should set destructiveHint`);
    assert.equal(typeof primary.annotations?.idempotentHint, "boolean", `${primaryName} should set idempotentHint`);
    assert.equal(typeof primary.annotations?.openWorldHint, "boolean", `${primaryName} should set openWorldHint`);
  }

  assert.equal(byName.get("backwork_policy_research")?.annotations?.readOnlyHint, true);
  assert.equal(byName.get("backwork_webhook_management")?.annotations?.readOnlyHint, false);
  assert.equal(byName.get("backwork_webhook_management")?.annotations?.destructiveHint, true);

  const invalidPolicyCall = await client.callTool({
    name: "backwork_policy_research",
    arguments: { action: "get", response_format: "json" },
  });
  assert.equal(invalidPolicyCall.isError, true, "local validation errors should be tool errors");

  console.log(`MCP smoke test passed: ${tools.length} tools verified.`);
} finally {
  await client.close();
}
