import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import vm from "node:vm";

import { renderWidget } from "../build/src/widgets/render.js";
import { WIDGETS } from "../build/src/widgets/templates.js";
import { connect, startHostedOAuth } from "./helpers.mjs";

const INDEX = "https://www.modahealth.com/medical/medical_criteria.shtml";
const QUOTE = "The preceding information is intended for non-Medicare coverage determinations.";
const SHARED_NOTE = "Listed in Moda Health's provider indexes for Oregon, Alaska, Idaho, Texas. The document does not establish the member's state or line of business.";
const TX_NOTE = "Listed in Moda Health's provider index for Texas. The document does not establish plan or product applicability.";
const UNKNOWN_NOTE = "The retained document does not establish a state, line of business, or indexed market. Applicability is unknown; confirm the member's plan with the payer.";
const evidence = (markets, statements = []) => ({
  document_sha256: "a".repeat(64),
  market_index_listings: markets.map((market) => ({ market, index_url: INDEX })),
  document_statements: statements,
});
const SHARED = {
  applicability_scope: "shared_markets",
  applicability_markets: ["OR", "AK", "ID", "TX"],
  applicability_evidence: evidence(["OR", "AK", "ID", "TX"], [{ kind: "non_medicare_disclaimer", quote: QUOTE, page: 43 }]),
  applicability_note: SHARED_NOTE,
};
const TX = { applicability_scope: "document_scoped", applicability_markets: ["TX"], applicability_evidence: evidence(["TX"]), applicability_note: TX_NOTE };
const UNKNOWN = { applicability_scope: "document_scoped", applicability_markets: [], applicability_evidence: evidence([], [{ kind: "non_medicare_disclaimer", quote: QUOTE, page: 43 }]), applicability_note: UNKNOWN_NOTE };
const policy = (id = "SHARED", fields = SHARED) => ({
  policy_id: id,
  title: `Policy ${id}`,
  policy_type: "Medical Policy",
  jurisdiction: null,
  payer: { name: "Moda Health", slug: "moda-health" },
  source_url: "https://www.modahealth.com/pdfs/med_criteria/policy.pdf",
  public_url: `https://backworkhealth.com/policy/payer/moda-health/${id}`,
  effective_date: "2026-01-01",
  status: "active",
  codes: [{ code: "J1001", code_system: "HCPCS", disposition: "requires_pa", source: "document" }],
  ...fields,
});
const polluted = () => policy("SHARED", {
  ...SHARED,
  private_member: "private_trace",
  applicability_evidence: {
    ...SHARED.applicability_evidence,
    private_member: "private_trace",
    market_index_listings: SHARED.applicability_evidence.market_index_listings.map((item) => ({ ...item, trace_id: "private_trace" })),
    document_statements: SHARED.applicability_evidence.document_statements.map((item) => ({ ...item, patient_name: "private_trace" })),
  },
});
const MALFORMED = {
  "BAD-URL": { ...evidence(["TX"]), market_index_listings: [{ market: "TX", index_url: "javascript:alert(1)" }] },
  "BAD-HTTP": { ...evidence(["TX"]), market_index_listings: [{ market: "TX", index_url: "http://publisher.example/index" }] },
  "BAD-CREDENTIALS": { ...evidence(["TX"]), market_index_listings: [{ market: "TX", index_url: "https://user:password@publisher.example/index" }] },
  "BAD-SYNTAX": { ...evidence(["TX"]), market_index_listings: [{ market: "TX", index_url: "https://invalid[" }] },
  "BAD-URL-LIMIT": { ...evidence(["TX"]), market_index_listings: [{ market: "TX", index_url: `https://publisher.example/${"x".repeat(2048)}` }] },
  "BAD-HASH": { ...evidence(["TX"]), document_sha256: "invented" },
  "BAD-KIND": evidence(["TX"], [{ kind: "nationwide_coverage", quote: "Covered everywhere", page: 1 }]),
  "BAD-PAGE": evidence(["TX"], [{ kind: "member_type_branch", quote: "Source statement", page: 0 }]),
  "BAD-QUOTE": evidence(["TX"], [{ kind: "member_type_branch", quote: "x".repeat(4001), page: 1 }]),
  "BAD-LIMIT": { ...evidence([]), market_index_listings: Array.from({ length: 17 }, () => ({ market: "TX", index_url: INDEX })) },
  "BAD-STATEMENT-LIMIT": evidence([], Array.from({ length: 17 }, () => ({ kind: "member_type_branch", quote: "Source statement", page: 1 }))),
};
const lookup = (code) => ({ code, code_system: "HCPCS", policies: [code === "J1002" ? policy("SHARED", {}) : polluted()] });
const priorAuth = () => ({
  pa_required: true,
  coverage_status: "conditional",
  confidence: "medium",
  reason: "Confirm plan applicability with the payer.",
  requires_manual_review: true,
  matched_policies: [polluted()],
  policy_sources: [polluted()],
  source_policy_references: [policy("UNKNOWN", UNKNOWN)],
  coverage_decision: { confidence: "medium", requires_manual_review: true, policy_sources: [polluted()] },
});

let api;
let client;
let hosted;
before(async () => {
  api = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    let data;
    if (url.pathname === "/api/v1/codes/lookup") data = lookup(url.searchParams.get("code"));
    else if (url.pathname === "/api/v1/codes/batch") data = { results: Object.fromEntries(body.codes.map((code) => [code, lookup(code)])) };
    else if (url.pathname === "/api/v1/prior-auth/check") data = priorAuth();
    else if (url.pathname === "/api/v1/claims/validate") data = { coverage_status: "unknown", confidence: "low", requires_manual_review: true, matched_policies: [] };
    else if (url.pathname === "/api/v1/coverage/evaluate") data = { covered: true, confidence: 0.79, requires_manual_review: true, reasons: [SHARED_NOTE], policy: polluted() };
    else if (url.pathname === "/api/v1/coverage/criteria") data = [{ section: "indications", text: "Document the indication.", policy_id: "SHARED", policy_title: "Policy SHARED", requires_manual_review: true, ...SHARED, policy: polluted() }];
    else if (url.pathname === "/api/v1/policies") data = [polluted(), policy("TX", TX), policy("UNKNOWN", UNKNOWN), policy("LEGACY", {})];
    else if (url.pathname.startsWith("/api/v1/policies/")) {
      const id = url.pathname.split("/").at(-1);
      const fields = id === "TX" ? TX : id === "UNKNOWN" ? UNKNOWN : id === "LEGACY" ? {} : SHARED;
      data = { ...policy(id, fields), codes: { HCPCS: policy().codes } };
      if (id in MALFORMED) data.applicability_evidence = MALFORMED[id];
      if (id === "BAD-MARKETS") data.applicability_markets = ["tx", "nationwide"];
      if (id === "BAD-NOTE") data.applicability_note = "x".repeat(4001);
      if (id === "HTML") {
        data.applicability_note = '<img src=x onerror="alert(1)">';
        data.applicability_evidence = evidence(["TX"], [{ kind: "member_type_branch", quote: '<script>alert("source")</script>', page: 2 }]);
      }
    }
    res.writeHead(data === undefined ? 404 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, data, meta: { request_id: "private_trace" } }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const apiBase = `http://127.0.0.1:${api.address().port}/api/v1`;
  client = await connect({ BACKWORK_API_BASE: apiBase });
  hosted = await startHostedOAuth({ apiBase });
});
after(async () => {
  await client.close();
  await hosted.close();
  await new Promise((resolve) => api.close(resolve));
});
async function call(connection, name, args) {
  const result = await connection.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return result;
}
function assertApplicability(record, expected) {
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(record[key], value, key);
}

test("public tools preserve bounded applicability through each actual policy-bearing API shape", async () => {
  for (const [name, args, select] of [
    ["backwork_coverage_lookup", { procedure_codes: ["J1001"], include: ["code_details"] }, (data) => [data.code_details.policies[0]]],
    ["backwork_coverage_lookup", { procedure_codes: ["J1001", "J1003"], include: ["code_details"] }, (data) => Object.values(data.code_details.results).flatMap((entry) => entry.policies)],
    ["backwork_policy_research", { action: "search", query: "policy" }, (data) => [data[0]]],
    ["backwork_policy_research", { action: "get", policy_id: "SHARED" }, (data) => [data]],
    ["backwork_policy_research", { action: "criteria", query: "indication" }, (data) => [data[0], data[0].policy]],
    ["backwork_prior_auth_research", { action: "check", procedure_codes: ["J1001"], payer: "Moda Health" }, (data) => [...data.matched_policies, ...data.policy_sources, ...data.coverage_decision.policy_sources]],
    ["backwork_claim_validation", { procedure_codes: ["J1001"], policy_id: "SHARED", coverage_parameters: { age: 18 } }, (data) => [data.coverage_evaluation.policy]],
  ]) {
    const result = await call(client, name, { ...args, response_format: "json" });
    for (const record of select(result.structuredContent.data)) assertApplicability(record, SHARED);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.doesNotMatch(JSON.stringify(result), /private_trace|private_member|patient_name|trace_id/);
    const widget = result.structuredContent.widget;
    if (widget) {
      const policy = widget.kind === "policy_detail" ? widget.policy
        : widget.kind === "criteria_list" ? widget.items[0].policy
          : widget.kind === "prior_auth_checklist" ? widget.citations[0] : widget.policies[0];
      assertApplicability(policy, SHARED);
      assert.match(renderWidget(widget), /Oregon, Alaska, Idaho, Texas/);
    }
    if (args.action === "check") {
      const data = result.structuredContent.data;
      assertApplicability(data.source_policy_references[0], UNKNOWN);
      assert.equal(data.confidence, "medium");
      assert.equal(data.requires_manual_review, true);
      assert.equal(data.coverage_decision.requires_manual_review, true);
    }
    if (name === "backwork_claim_validation") {
      assert.equal(result.structuredContent.data.coverage_evaluation.confidence, 0.79);
      assert.equal(result.structuredContent.data.coverage_evaluation.requires_manual_review, true);
    }
  }
});

test("hosted HTTP cards distinguish Texas index discovery, unknown applicability and legacy responses", async () => {
  const httpClient = await hosted.connect();
  try {
    for (const [id, fields, note] of [["TX", TX, TX_NOTE], ["UNKNOWN", UNKNOWN, UNKNOWN_NOTE], ["LEGACY", {}, null]]) {
      const result = await call(httpClient, "backwork_policy_research", { action: "get", policy_id: id });
      assertApplicability(result.structuredContent.data, fields);
      assertApplicability(result.structuredContent.widget.policy, fields);
      const html = renderWidget(result.structuredContent.widget);
      if (note) {
        assert.ok(result.content[0].text.includes(note));
        assert.ok(html.includes(note.replaceAll("'", "&#39;")));
        assert.doesNotMatch(html, /Nationwide|Commercial coverage|Texas.only coverage/i);
      } else {
        for (const record of [result.structuredContent.data, result.structuredContent.widget.policy]) assert.equal(Object.keys(record).some((key) => key.startsWith("applicability_")), false);
        assert.doesNotMatch(html, /Applicability|Publisher index/);
      }
      if (id === "UNKNOWN") {
        assert.match(html, /page 43/);
        assert.ok(html.includes(QUOTE));
        assert.doesNotMatch(html, /Publisher index for/);
      }
      if (id === "TX") assert.ok(html.includes(`href="${INDEX}"`));
    }
  } finally {
    await httpClient.close();
  }
});

test("scope validation rejects malformed or untrusted evidence without inventing coverage", async () => {
  for (const id of Object.keys(MALFORMED)) {
    const result = await call(client, "backwork_policy_research", { action: "get", policy_id: id });
    assert.equal(result.structuredContent.data.applicability_scope, "shared_markets", id);
    assert.equal(result.structuredContent.data.applicability_evidence, null, id);
    assert.equal(result.structuredContent.widget.policy.applicability_evidence, null, id);
    assert.doesNotMatch(renderWidget(result.structuredContent.widget), /href="(?:javascript:|http:|https:\/\/user:)|nationwide_coverage|Covered everywhere|Publisher index for/);
  }
  const markets = await call(client, "backwork_policy_research", { action: "get", policy_id: "BAD-MARKETS" });
  assert.deepEqual(markets.structuredContent.data.applicability_markets, []);
  assert.equal(markets.structuredContent.data.applicability_note, null);
  const note = await call(client, "backwork_policy_research", { action: "get", policy_id: "BAD-NOTE" });
  assert.equal(note.structuredContent.data.applicability_note, null);
  const htmlResult = await call(client, "backwork_policy_research", { action: "get", policy_id: "HTML" });
  const html = renderWidget(htmlResult.structuredContent.widget);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<img|<script>/);
});

test("combined cards fill missing scope from prior auth and render the reviewed answer in the actual iframe", async () => {
  const result = await call(client, "backwork_coverage_lookup", { procedure_codes: ["J1002"], include: ["code_details", "prior_auth"], payer: "Moda Health" });
  const view = result.structuredContent.widget;
  assertApplicability(view.policies[0], SHARED);
  assert.equal(view.prior_auth.confidence, "medium");
  assert.equal(view.requires_manual_review, true);
  const root = { innerHTML: "" };
  const documentElement = { dataset: {}, style: { setProperty() {} }, getBoundingClientRect: () => ({ width: 640, height: 280 }) };
  const parent = { postMessage() {} };
  const page = (await client.readResource({ uri: WIDGETS.coverage_card.uri })).contents[0].text;
  vm.runInNewContext(page.match(/<script>([\s\S]*)<\/script>/)[1], {
    window: { parent, openai: { toolOutput: result.structuredContent }, addEventListener() {} },
    document: { getElementById: () => root, documentElement, body: {}, addEventListener() {} },
    setTimeout() {}, Element: class {}, HTMLAnchorElement: class {},
  });
  assert.match(root.innerHTML, /Oregon, Alaska, Idaho, Texas/);
  assert.match(root.innerHTML, /Manual review required/);
  assert.match(root.innerHTML, /medium confidence/);
  assert.match(root.innerHTML, /page 43/);
  assert.ok(root.innerHTML.includes(`href="${INDEX}"`));
});
