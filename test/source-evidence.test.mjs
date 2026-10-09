import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { renderWidget } from "../build/src/widgets/render.js";
import { connect } from "./helpers.mjs";

const SOURCE_CHECK = {
  source_url: "https://payer.example/policies/drug-policy",
  last_fetched_at: "2026-10-08T12:30:00Z",
  content_sha256: "a".repeat(64),
  source_accuracy: [{ field: "codes", sampled_at: "2026-10-07T10:00:00Z", sample_size: 120, accuracy: 0.95, ci_low: 0.894, ci_high: 0.977, method: "manual_review_v1" }],
};
const unminimizedCheck = () => ({ ...SOURCE_CHECK, request_id: "private_trace", source_accuracy: SOURCE_CHECK.source_accuracy.map((audit) => ({ ...audit, auditor_email: "private_trace" })) });
const CODE_ENTRIES = [
  { code: "J1001", disposition: "requires_pa", source: "document", grounding: "grounded" },
  { code: "J1002", disposition: "conditional", source: "document", grounding: "not_grounded" },
  { code: "J1003", disposition: "covered", source: "document", grounding: "no_source_text" },
  { code: "J1004", disposition: "requires_pa", source: "inferred_title_match", grounding: "not_checked" },
  { code: "J1005", disposition: "covered", source: "document" },
];
const policy = () => ({ policy_id: "DRUG-1", title: "Drug policy", policy_type: "Drug Policy", source_url: SOURCE_CHECK.source_url, source_check: unminimizedCheck(), last_verified_at: "2026-09-20T09:00:00Z", codes: CODE_ENTRIES });
const lookup = (code) => ({ code, code_system: "HCPCS", policies: [{ ...policy(), disposition: "covered", source: "document", grounding: "grounded" }] });
const RESPONSES = {
  "GET /api/v1/codes/lookup": (url) => {
    const code = url.searchParams.get("code") ?? "J1001";
    const result = lookup(code);
    // Simulate an older code-lookup deployment during an API rollout.
    if (code === "J1002") {
      delete result.policies[0].source_check;
      delete result.policies[0].grounding;
    }
    return result;
  },
  "POST /api/v1/codes/batch": () => ({ results: { J1001: lookup("J1001"), J1002: lookup("J1002") } }),
  "GET /api/v1/policies": () => [policy()],
  "GET /api/v1/policies/DRUG-1": () => ({ ...policy(), codes: { HCPCS: CODE_ENTRIES } }),
  "POST /api/v1/prior-auth/check": () => ({ pa_required: true, matched_policies: [policy()], policy_sources: [policy()] }),
  "POST /api/v1/claims/validate": () => ({ coverage_status: "conditional", matched_policies: [policy()], policy_sources: [policy()], codes: [{ code: "J1001", coverage_status: "conditional", policy_sources: [policy()] }] }),
  "POST /api/v1/coverage/evaluate": () => ({ covered: false, confidence: 0.5, reasons: [], matched_criteria: [], unmatched_criteria: [], skipped_criteria: [], policy: policy() }),
  "POST /api/v1/policies/compare": () => ({ comparison: [{ jurisdiction: "JM", policies: [policy()] }], national_policies: [{ ...policy(), policy_id: "NCD-1", is_national: true }], summary: { queried_codes: ["J1001"], has_variation: false } }),
  "GET /api/v1/coverage/criteria": () => [{ policy_id: "DRUG-1", policy_title: "Drug policy", policy_type: "Drug Policy", section: "indications", text: "Document the indication.", policy: policy() }],
};

let api;
let client;
before(async () => {
  api = createServer((req, res) => {
    const respond = RESPONSES[`${req.method} ${req.url.split("?")[0]}`];
    res.writeHead(respond ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(respond ? { success: true, data: respond(new URL(req.url, "http://localhost")) } : { error: { message: "no route" } }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  client = await connect({ BACKWORK_API_BASE: `http://127.0.0.1:${api.address().port}/api/v1` });
});
after(async () => {
  await client.close();
  await new Promise((resolve) => api.close(resolve));
});

// Each case exercises a distinct API envelope through the public MCP tool;
// dropping nested evidence or allowing undeclared source-audit fields must fail.
for (const [name, tool, args, evidence] of [
  ["single lookup", "backwork_coverage_lookup", { procedure_codes: ["J1001"], include: ["code_details"] }, (data) => [data.code_details.policies[0]]],
  ["batch lookup", "backwork_coverage_lookup", { procedure_codes: ["J1001", "J1002"], include: ["code_details"] }, (data) => Object.values(data.code_details.results).flatMap((lookup) => lookup.policies)],
  ["policy list", "backwork_policy_research", { action: "search", query: "drug" }, (data) => data],
  ["policy detail", "backwork_policy_research", { action: "get", policy_id: "DRUG-1" }, (data) => [data]],
  ["prior auth", "backwork_prior_auth_research", { action: "check", procedure_codes: ["J1001"] }, (data) => [...data.matched_policies, ...data.policy_sources]],
  ["claim and evaluation", "backwork_claim_validation", { procedure_codes: ["J1001"], policy_id: "DRUG-1", coverage_parameters: { age: 18 } }, (data) => [...data.claim_validation.matched_policies, ...data.claim_validation.policy_sources, ...data.claim_validation.codes[0].policy_sources, data.coverage_evaluation.policy]],
  ["comparison", "backwork_policy_research", { action: "compare", procedure_codes: ["J1001"] }, (data) => [...data.comparison[0].policies, ...data.national_policies]],
  ["criteria", "backwork_policy_research", { action: "criteria", query: "indication" }, (data) => [data[0].policy]],
]) {
  test(`${name} carries the API's source evidence without private audit fields`, async () => {
    const result = await client.callTool({ name: tool, arguments: { ...args, response_format: "json" } });
    assert.equal(result.isError, undefined, result.content[0].text);
    for (const record of evidence(result.structuredContent.data)) assert.deepEqual(record.source_check, SOURCE_CHECK);
    assert.doesNotMatch(JSON.stringify(result), /private_trace|auditor_email|request_id/);
  });
}

test("policy card and markdown distinguish grounding from code source and source-sample accuracy", async () => {
  const result = await client.callTool({ name: "backwork_policy_research", arguments: { action: "get", policy_id: "DRUG-1" } });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(result.structuredContent.data.codes.HCPCS.map((code) => code.grounding), ["grounded", "not_grounded", "no_source_text", "not_checked", undefined]);
  const view = result.structuredContent.widget;
  assert.deepEqual(view.policy.source_check, SOURCE_CHECK);
  assert.deepEqual(view.codes.map((code) => code.grounding), ["grounded", "not_grounded", "no_source_text", "not_checked", null]);
  const html = renderWidget(view);
  for (const text of [result.content[0].text, html]) {
    assert.match(text, /Not found in retained source text/i);
    assert.match(text, /No retained source text/i);
    assert.match(text, /Grounding not checked/i);
    assert.match(text, /source sample/i);
    assert.match(text, /120/);
    assert.doesNotMatch(text, /95% (policy |coverage |confidence)/i);
  }
  assert.match(html, /2026-10-08/);
});

test("coverage, prior-auth and comparison cards retain code-grounding evidence", async () => {
  for (const [tool, args, codeFromView] of [
    ["backwork_coverage_lookup", { procedure_codes: ["J1001"], include: ["code_details"] }, (view) => view.policies[0].codes[0]],
    ["backwork_prior_auth_research", { action: "check", procedure_codes: ["J1001"] }, (view) => view.codes_requiring_pa[0]],
    ["backwork_policy_research", { action: "compare", procedure_codes: ["J1001"] }, (view) => view.rows[0].cells[0]],
  ]) {
    const result = await client.callTool({ name: tool, arguments: args });
    assert.equal(result.isError, undefined, result.content[0].text);
    const view = result.structuredContent.widget;
    assert.equal(codeFromView(view).grounding, "grounded");
    assert.match(renderWidget(view), /Found in retained source text/);
  }
});

test("a combined coverage card fills missing code evidence from its prior-auth response", async () => {
  const result = await client.callTool({ name: "backwork_coverage_lookup", arguments: { procedure_codes: ["J1002"], include: ["code_details", "prior_auth"] } });
  assert.equal(result.isError, undefined, result.content[0].text);
  const policy = result.structuredContent.widget.policies[0];
  assert.deepEqual(policy.source_check, SOURCE_CHECK);
  assert.equal(policy.codes.find((code) => code.code === "J1002").grounding, "not_grounded");
  assert.match(renderWidget(result.structuredContent.widget), /Not found in retained source text/);
});
