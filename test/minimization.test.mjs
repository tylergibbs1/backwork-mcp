import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { connect } from "./helpers.mjs";

// Tool results leave out request IDs and timestamps (ChatGPT plugin guidelines, response minimization).
const META = { request_id: "req_secret123", timestamp: "2026-09-30T12:00:00Z", pagination: { has_more: false } };
const RESPONSES = {
  "GET /api/v1/health": [200, { success: true, data: { status: "healthy", version: "v1", checks: {}, timestamp: "2026-09-30T12:00:00Z" }, meta: META }],
  "GET /api/v1/policies": [200, { success: true, data: [{ policy_id: "L1", title: "Policy L1", policy_type: "LCD", status: "active" }], meta: META }],
  "POST /api/v1/claims/validate": [500, { success: false, error: { code: "INTERNAL_ERROR", message: "Something failed" }, meta: META }],
};

let api;
let client;
before(async () => {
  api = createServer((req, res) => {
    const [status, body] = RESPONSES[`${req.method} ${req.url.split("?")[0]}`] ?? [404, { error: { message: "no route" } }];
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  client = await connect({ BACKWORK_API_BASE: `http://127.0.0.1:${api.address().port}/api/v1` });
});
after(async () => {
  await client.close();
  await new Promise((resolve) => api.close(resolve));
});

function assertNoTrace(result) {
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /req_secret123|request_id|Request ID|2026-09-30T12:00:00Z/);
}

test("a successful result keeps the response meta that answers the request, without trace fields", async () => {
  for (const response_format of ["markdown", "json"]) {
    const result = await client.callTool({ name: "backwork_policy_research", arguments: { action: "search", query: "x", response_format } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.meta, { pagination: { has_more: false } });
    assertNoTrace(result);
  }
});

test("the health check omits its response timestamp", async () => {
  const result = await client.callTool({ name: "backwork_system_health", arguments: {} });
  assert.deepEqual(result.structuredContent.data, { status: "healthy", version: "v1", checks: {} });
  assertNoTrace(result);
});

test("an API error tells the user what failed, without the request ID", async () => {
  const result = await client.callTool({ name: "backwork_claim_validation", arguments: { procedure_codes: ["99213"] } });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Error validate claim: Something failed\nCode: INTERNAL_ERROR");
  assertNoTrace(result);
});
