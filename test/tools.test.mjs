import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";

import { TOOL_OPERATIONS } from "../build/src/tool-operations.js";
import { connect } from "./helpers.mjs";

const ALL_TOOLS = Object.keys(TOOL_OPERATIONS).map((name) => `backwork_${name}`).sort();

describe("against the production API with a Backwork API key", () => {
  let client;
  let tools;
  before(async () => {
    client = await connect();
    ({ tools } = await client.listTools());
  });
  after(() => client.close());

  test("offers every tool, since production serves every operation the tools call", () => {
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ALL_TOOLS);
  });

  test("withholds no action", () => {
    for (const tool of tools) assert.doesNotMatch(tool.description, /Not available|Not offered/, tool.name);
    const compliance = tools.find((tool) => tool.name === "backwork_compliance_review");
    assert.deepEqual(compliance.inputSchema.properties.action.enum, ["stats", "list_unreviewed", "acknowledge", "bulk_acknowledge"]);
  });

  test("offers only the webhook event Backwork delivers", () => {
    const webhooks = tools.find((tool) => tool.name === "backwork_webhook_management");
    assert.deepEqual(webhooks.inputSchema.properties.events.items.enum, ["compliance.acknowledged", "*"]);
  });
});

describe("against a Backwork API that serves every endpoint", () => {
  let api;
  let client;
  let requests = [];

  before(async () => {
    api = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          data: {
            coverage_status: "conditional",
            prior_auth_required: true,
            denial_risk: "high",
            overall_risk: "high",
            confidence: "high",
            policy_sources: [
              {
                source_id: "L33718",
                policy_id: "L33718",
                title: "Positive Airway Pressure Devices",
                policy_type: "LCD",
                jurisdiction: "JH",
                source_url: "https://www.cms.gov/medicare-coverage-database/view/lcd.aspx?lcdid=33718",
                effective_date: "2025-01-01",
                last_verified_at: "2026-09-20T09:00:00.000Z",
              },
            ],
          },
          meta: { request_id: "req_test" },
        }),
      );
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    client = await connect({ BACKWORK_API_BASE: `http://127.0.0.1:${api.address().port}/api/v1` });
  });
  after(async () => {
    await client.close();
    await new Promise((resolve) => api.close(resolve));
  });

  test("offers every tool", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ALL_TOOLS);
  });

  test("returns citable provenance with the result", async () => {
    requests = [];
    const result = await client.callTool({
      name: "backwork_claim_validation",
      arguments: { procedure_codes: ["E0601"], state: "TX" },
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(requests, ["POST /api/v1/claims/validate"]);
    assert.deepEqual(result.structuredContent.provenance, {
      source_urls: ["https://www.cms.gov/medicare-coverage-database/view/lcd.aspx?lcdid=33718"],
      authorities: ["CMS"],
      retrieved_at: "2026-09-20T09:00:00.000Z",
      as_of: "2025-01-01",
      sources: [
        {
          policy_id: "L33718",
          source_url: "https://www.cms.gov/medicare-coverage-database/view/lcd.aspx?lcdid=33718",
          authority: "CMS",
          retrieved_at: "2026-09-20T09:00:00.000Z",
          as_of: "2025-01-01",
        },
      ],
    });
    assert.match(result.content[0].text, /--- Sources ---\nAuthority: CMS\nCurrency: effective 2025-01-01; retrieved by Backwork on or after 2026-09-20T09:00:00.000Z/);
  });
});
