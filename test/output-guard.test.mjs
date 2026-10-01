import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";

import { BACKWORK_OPERATIONS } from "../build/src/api-operations.js";
import { TOOL_OPERATIONS } from "../build/src/tool-operations.js";
import { connect, startHostedOAuth } from "./helpers.mjs";

/**
 * Guard for the plugin guidelines' tool-output rules: no upsell, upgrade or
 * pricing text, and no IDs, timestamps or telemetry a tool does not need. It
 * calls every action of every tool, on an API-key connection and on the hosted
 * OAuth connection, against API responses full of such fields, and against the
 * plan, credit and rate-limit errors.
 */
const LEAK = /upgrade|pricing|pay-as-you-go|subscri|credits?\b.*buy|total_dollars|poll_url|request_id|idempotency/i;
// Fields the API sends that tool results drop; most are not caught by LEAK's wording.
const DROPPED_KEYS = new Set([
  "cost",
  "created_at",
  "updated_at",
  "finished_at",
  "model",
  "cached",
  "idempotency_key",
  "request_id",
  "timestamp",
  "poll_url",
  "criteria_id",
  "materiality_model",
  "materiality_scored_at",
  "delivery_id",
  "block_id",
]);
const BAIT_VALUES = /req_bait|jev-bait|2026-01-02T03:04:05Z|Created:|Finished:|Poll URL/;

const TRACE = "2026-01-02T03:04:05Z";
const META = { request_id: "req_bait", timestamp: TRACE, idempotency_key: "idem_bait", cached: true };
const VERIFIED = "2026-09-20T09:00:00.000Z";
const source = (id, extra = {}) => ({
  source_id: id,
  policy_id: id,
  title: `Policy ${id}`,
  policy_type: "LCD",
  jurisdiction: "JH",
  source_url: `https://www.cms.gov/${id}`,
  public_url: null,
  effective_date: "2025-01-01",
  last_verified_at: VERIFIED,
  ...extra,
});
const research = {
  research_id: "res_123",
  status: "running",
  created_at: TRACE,
  finished_at: TRACE,
  poll_url: "https://backworkhealth.com/api/v1/prior-auth/research/res_123",
  result: {
    determination: { pa_required: true, confidence: "medium", reasoning: "Payer lists the code." },
    payer_policies: [{ payer_name: "Aetna", policy_name: "Botulinum toxins", policy_url: "https://aetna.example/p", effective_date: "2025-01-01", summary: "x" }],
    documentation_requirements: [{ requirement: "Chart notes", mandatory: true, notes: "" }],
  },
  cost: { num_searches: 7, num_pages: 3, reasoning_tokens: 900, total_dollars: 0.42 },
  error: null,
};
const coverageAnswer = {
  model: "jev-bait",
  pa_required: true,
  prior_auth_required: true,
  coverage_status: "conditional",
  denial_risk: "high",
  overall_risk: "high",
  confidence: "high",
  reason: "LCD requires PA",
  requires_manual_review: false,
  known_gaps: [],
  documentation_checklist: ["Sleep study"],
  documentation_requirements: ["Sleep study"],
  issues: [],
  mac: { name: "Novitas", jurisdiction: "JH", states: ["TX"] },
  matched_policies: [source("L33718", { codes: [{ code: "E0601", code_system: "HCPCS", disposition: "requires_pa", source: "document" }] })],
  policy_sources: [source("L33718")],
  codes: [{ code: "E0601", coverage_status: "conditional", prior_auth_required: true, denial_risk: "high", issues: [], policy_count: 1 }],
  criteria_details: { indications: [{ text: "AHI >= 15", tags: [], policy_id: "L33718" }], limitations: [], pagination: { page: 1 } },
  created_at: TRACE,
};
const codeLookup = {
  code: "99213",
  code_system: "CPT",
  found: true,
  description: "Office visit",
  rvu: { work_rvu: "1.3", year: 2026 },
  policies: [{ policy_id: "L1", title: "Policy L1", policy_type: "LCD", disposition: "covered", source: "document", source_url: "https://www.cms.gov/L1", created_at: TRACE }],
  model: "jev-bait",
};

const FIXTURES = {
  lookupCode: codeLookup,
  batchLookupCodes: { results: { 99213: codeLookup, J0585: { ...codeLookup, code: "J0585", code_system: "HCPCS" } }, request_id: "req_bait" },
  checkPriorAuth: coverageAnswer,
  validateClaims: coverageAnswer,
  comparePolicies: {
    comparison: [{ jurisdiction: "JH", mac: { name: "Novitas", code: "04", states: ["TX"] }, policies: [source("L1", { codes: [{ code: "99213", disposition: "covered" }] })], coverage_summary: { covered: 1 } }],
    national_policies: [],
    summary: { total_jurisdictions: 1, has_variation: false, queried_codes: ["99213"], policy_type_filter: null },
  },
  getSpendingByCode: { 99213: { total_paid: "100.00", total_claims: 3, by_year: [{ year: 2025, total_paid: "100.00", total_claims: 3 }] } },
  listPolicies: [{ policy_id: "L1", title: "Policy L1", policy_type: "LCD", status: "active", effective_date: "2025-01-01", relevance_score: 0.9, created_at: TRACE }],
  getPolicy: {
    policy_id: "L1",
    title: "Policy L1",
    policy_type: "LCD",
    status: "active",
    effective_date: "2025-01-01",
    last_reviewed_date: "2026-06-01",
    created_at: TRACE,
    updated_at: TRACE,
    criteria: { indications: [{ block_id: "blk_1", text: "AHI >= 15", tags: [] }] },
    codes: { CPT: [{ code: "99213", display: "Office visit", disposition: "covered" }] },
    versions: [{ old_version: 1, new_version: 2, change_type: "updated", change_summary: "x", timestamp: TRACE }],
  },
  searchCriteria: [{ criteria_id: "crit_1", policy_id: "L1", policy_title: "Policy L1", section: "indications", text: "AHI >= 15" }],
  getPolicyChanges: [{ diff_id: 9, policy_id: "L1", policy_title: "Policy L1", change_type: "updated", changed_at: "2026-06-01", materiality_model: "jev-bait", materiality_scored_at: TRACE }],
  listJurisdictions: [{ jurisdiction_code: "JH", jurisdiction_name: "J-H", mac_name: "Novitas", states: ["TX"] }],
  evaluateCoverage: { covered: true, confidence: 0.9, reasons: [], blocks_evaluated: 3, policy: { policy_id: "L33718", title: "x", policy_type: "LCD" } },
  getPriorAuthResearch: research,
  researchPriorAuth: research,
  searchDrugFormularyEvidence: [{ source: "cvs_caremark", payer_name: "CVS Caremark", drug_name: "Ozempic", tier: "2", coverage_status: "covered", requirements: { prior_authorization: true }, source_url: "https://caremark.example/f", created_at: TRACE }],
  getComplianceStats: { total_changes_30d: 4, acknowledged_count: 1, unreviewed_count: 3, acknowledgment_rate: 25, critical_unreviewed: 0, timestamp: TRACE },
  listUnreviewedChanges: [{ diff_id: 42, policy_id: "L1", policy_title: "Policy L1", change_type: "updated", changed_at: "2026-06-01" }],
  acknowledgeChange: { id: 5, acknowledged: true, already_acked: false },
  bulkAcknowledgeChanges: { acknowledged: 2, already_acked: 0, invalid_ids: 0, total: 2 },
  listWebhooks: [{ id: 3, url: "https://hooks.example/a", events: ["compliance.acknowledged"], status: "active", failure_count: 0, created_at: TRACE, updated_at: TRACE }],
  createWebhook: { id: 3, url: "https://hooks.example/a", events: ["compliance.acknowledged"], status: "active", secret: "whsec_x", created_at: TRACE },
  updateWebhook: { id: 3, url: "https://hooks.example/a", events: ["compliance.acknowledged"], status: "paused", created_at: TRACE, updated_at: TRACE },
  deleteWebhook: { id: 3, deleted: true },
  testWebhook: { delivery_id: 77, endpoint_id: 3, event: "compliance.acknowledged", http_status: 200, success: true, error: null, created_at: TRACE },
  getHealth: { status: "healthy", version: "v1", checks: {}, timestamp: TRACE },
};

const ERROR_META = { request_id: "req_bait", timestamp: TRACE };
const FAILURES = {
  "plan gate (402 upgrade_to)": {
    status: 402,
    body: { success: false, error: { code: "UPGRADE_REQUIRED", message: "Upgrade to Scale to use this feature", upgrade_to: "scale", pricing_url: "https://backworkhealth.com/pricing" }, meta: ERROR_META },
    text: "This feature isn't included in your organization's current Backwork plan.",
  },
  "feature not in plan (403)": {
    status: 403,
    body: { success: false, error: { code: "FEATURE_NOT_AVAILABLE", message: "Your plan does not include this. Subscribe to Professional.", upgrade_to: "professional", pricing_url: "https://backworkhealth.com/pricing" }, meta: ERROR_META },
    text: "This feature isn't included in your organization's current Backwork plan.",
  },
  "credits exhausted (402)": {
    status: 402,
    body: {
      success: false,
      error: {
        code: "BILLING_CREDITS_EXHAUSTED",
        message: "Your organization has no request credits left for this call",
        hint: "Buy a Credits pack or start a monthly pack at https://backworkhealth.com/api-usage",
        docUrl: "https://backworkhealth.com/docs/errors#billing-credits-exhausted",
        retryable: false,
        details: { requests_needed: 1, requests_left: 0 },
      },
      meta: ERROR_META,
    },
    text: "Your organization has no remaining Backwork request credits. An organization admin can manage usage in Backwork.",
  },
  "usage limit (402 pay-as-you-go)": {
    status: 402,
    body: { success: false, error: { code: "USAGE_LIMIT_EXCEEDED", message: "Monthly limit reached; switch to pay-as-you-go", upgrade_to: "scale", pricing_url: "https://backworkhealth.com/pricing" }, meta: ERROR_META },
    text: "Your organization has no remaining Backwork request credits. An organization admin can manage usage in Backwork.",
  },
  "rate limited (429)": {
    status: 429,
    headers: { "Retry-After": "17" },
    body: {
      success: false,
      error: { code: "RATE_LIMIT_EXCEEDED", message: "Rate limit exceeded", hint: "Wait for Retry-After, or upgrade to Scale for 1,000 requests per minute", retryable: true },
      meta: ERROR_META,
    },
    text: "Backwork is rate-limiting this organization's requests.\nRetry in 17 seconds.",
  },
  "inactive account (403)": {
    status: 403,
    body: { success: false, error: { code: "SUBSCRIPTION_INACTIVE", message: "Your subscription is inactive", pricing_url: "https://backworkhealth.com/pricing" }, meta: ERROR_META },
    text: "Your organization's Backwork access is inactive. An organization admin can manage it in Backwork.",
  },
};

/** One or more calls per tool; together they reach every action the tool offers. */
const CALLS = {
  backwork_coverage_lookup: [
    { procedure_codes: ["99213"], include: ["code_details", "prior_auth", "claim_risk", "jurisdiction_compare", "spending"], state: "TX", date_of_service: "2026-01-15" },
    { procedure_codes: ["99213", "J0585"], include: ["code_details"] },
  ],
  backwork_policy_research: [
    { action: "search", query: "oxygen" },
    { action: "get", policy_id: "L1" },
    { action: "criteria", query: "AHI" },
    { action: "changes" },
    { action: "jurisdictions" },
    { action: "compare", procedure_codes: ["99213"] },
  ],
  backwork_claim_validation: [{ procedure_codes: ["E0601"], state: "TX", policy_id: "L33718", coverage_parameters: { ahi: 20 } }],
  backwork_prior_auth_research: [
    { action: "check", procedure_codes: ["E0601"], state: "TX" },
    { action: "start_research", procedure_codes: ["J0585"], payer: "Aetna" },
    { action: "get_research", research_id: "res_123" },
  ],
  backwork_drug_formulary_research: [{ query: "Ozempic" }],
  backwork_compliance_review: [
    { action: "stats" },
    { action: "list_unreviewed" },
    { action: "acknowledge", diff_id: 42 },
    { action: "bulk_acknowledge", diff_ids: [42, 43] },
  ],
  backwork_webhook_management: [
    { action: "list" },
    { action: "create", url: "https://hooks.example/a", events: ["compliance.acknowledged"] },
    { action: "update", id: 3, status: "paused" },
    { action: "delete", id: 3 },
    { action: "test", id: 3 },
  ],
  backwork_system_health: [{}],
};

let failure = null;
const routes = Object.entries(BACKWORK_OPERATIONS).map(([id, operation]) => ({
  id,
  method: operation.method,
  dynamic: operation.path.includes("{"),
  pattern: new RegExp(`^/api/v1${operation.path.replace(/\{[^}]+\}/g, "[^/]+")}$`),
}));

const api = createServer((req, res) => {
  const path = req.url.split("?")[0];
  // Static paths first, so /policies/changes is not read as /policies/{id}.
  const route =
    routes.find((candidate) => candidate.method === req.method && !candidate.dynamic && candidate.pattern.test(path)) ??
    routes.find((candidate) => candidate.method === req.method && candidate.pattern.test(path));
  if (failure) {
    res.writeHead(failure.status, { "Content-Type": "application/json", ...failure.headers });
    res.end(JSON.stringify(failure.body));
    return;
  }
  res.writeHead(route ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify(route ? { success: true, data: FIXTURES[route.id], meta: META } : { success: false, error: { message: `no route ${req.method} ${path}` } }));
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const apiBase = `http://127.0.0.1:${api.address().port}/api/v1`;

function droppedKeysIn(value, path = "") {
  if (Array.isArray(value)) return value.flatMap((item, index) => droppedKeysIn(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(DROPPED_KEYS.has(key) ? [`${path}.${key}`] : []),
    ...droppedKeysIn(child, `${path}.${key}`),
  ]);
}

function assertClean(result, where) {
  const text = result.content.map((item) => item.text ?? "").join("\n");
  const structured = JSON.stringify(result.structuredContent ?? {});
  for (const [part, output] of [["text", text], ["structuredContent", structured]]) {
    assert.doesNotMatch(output, LEAK, `${where}: ${part} leaks upsell or trace wording`);
    assert.doesNotMatch(output, BAIT_VALUES, `${where}: ${part} carries an ID, timestamp or model the API sent`);
  }
  assert.deepEqual(droppedKeysIn(result.structuredContent), [], `${where}: structuredContent keeps fields the projection should drop`);
}

/** Every listed tool has calls, and the calls reach every action the tool lists. */
function plannedCalls(tools) {
  return tools.flatMap((tool) => {
    const calls = CALLS[tool.name];
    assert.ok(calls, `${tool.name}: add calls for it to CALLS`);
    const operations = Object.keys(TOOL_OPERATIONS[tool.name.replace(/^backwork_/, "")]);
    const offered = tool.inputSchema.properties.action?.enum ?? operations;
    // A tool without an `action` input runs its operations from one call; coverage_lookup picks them with `include`.
    const reached = new Set(calls.flatMap((args) => (args.action ? [args.action] : (args.include ?? operations))));
    for (const action of offered) assert.ok(reached.has(action), `${tool.name}: no call reaches action '${action}'`);
    return calls.filter((args) => !args.action || offered.includes(args.action)).map((args) => ({ name: tool.name, args }));
  });
}

for (const [connection, open] of [
  ["API-key connection", () => connect({ BACKWORK_API_BASE: apiBase })],
  ["hosted OAuth connection", async () => (await startHostedOAuth({ apiBase })).connect()],
]) {
  describe(`tool output on the ${connection}`, () => {
    let client;
    let calls;
    before(async () => {
      client = await open();
      calls = plannedCalls((await client.listTools()).tools);
    });
    after(() => client.close());

    test("every action's result carries no upsell, trace ID, timestamp, cost or model", async () => {
      failure = null;
      for (const { name, args } of calls) {
        for (const response_format of ["markdown", "json"]) {
          const where = `${name} ${JSON.stringify(args)} ${response_format}`;
          const result = await client.callTool({ name, arguments: { ...args, response_format } });
          assert.notEqual(result.isError, true, `${where}: ${result.content[0]?.text}`);
          assertClean(result, where);
        }
      }
    });

    for (const [label, scenario] of Object.entries(FAILURES)) {
      test(`a ${label} error says only what the user can act on`, async () => {
        failure = scenario;
        try {
          for (const { name, args } of calls) {
            const where = `${name} ${JSON.stringify(args)}`;
            const result = await client.callTool({ name, arguments: args });
            assert.equal(result.isError, true, where);
            assert.ok(result.content[0].text.endsWith(`\n${scenario.text}`), `${where}: ${result.content[0].text}`);
            assertClean(result, where);
          }
        } finally {
          failure = null;
        }
      });
    }
  });
}

test("research results keep the research ID for polling, labeled as one", async () => {
  const client = await connect({ BACKWORK_API_BASE: apiBase });
  try {
    const result = await client.callTool({ name: "backwork_prior_auth_research", arguments: { action: "start_research", procedure_codes: ["J0585"], payer: "Aetna" } });
    assert.match(result.content[0].text, /^Research status: running\nResearch ID: res_123\n.*action='get_research'/);
    assert.deepEqual(Object.keys(result.structuredContent.data).sort(), ["error", "research_id", "result", "status"]);
  } finally {
    await client.close();
  }
});

test("policy effective and last-reviewed dates are content, and stay", async () => {
  const client = await connect({ BACKWORK_API_BASE: apiBase });
  try {
    const result = await client.callTool({ name: "backwork_policy_research", arguments: { action: "get", policy_id: "L1" } });
    assert.equal(result.structuredContent.data.effective_date, "2025-01-01");
    assert.equal(result.structuredContent.data.last_reviewed_date, "2026-06-01");
    assert.match(result.content[0].text, /Effective: 2025-01-01\nLast reviewed: 2026-06-01/);
  } finally {
    await client.close();
  }
});

test("the diff ID an acknowledgment needs reaches only a connection that can acknowledge", async () => {
  const apiKey = await connect({ BACKWORK_API_BASE: apiBase });
  const oauth = await (await startHostedOAuth({ apiBase })).connect();
  try {
    const args = { name: "backwork_compliance_review", arguments: { action: "list_unreviewed" } };
    assert.equal((await apiKey.callTool(args)).structuredContent.data[0].diff_id, 42);
    const hosted = await oauth.callTool(args);
    assert.equal(hosted.structuredContent.data[0].diff_id, undefined);
    assert.doesNotMatch(hosted.content[0].text, /Diff ID/);
  } finally {
    await apiKey.close();
    await oauth.close();
  }
});

after(async () => {
  await (await startHostedOAuth({ apiBase })).close();
  await new Promise((resolve) => api.close(resolve));
});
