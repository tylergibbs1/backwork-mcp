import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { connect } from "./helpers.mjs";

// J7321 as code lookup returns it: policies from several payers, with no payer filter on the endpoint.
const policy = (policy_id, title, policy_type, public_url) => ({
  policy_id,
  title,
  policy_type,
  disposition: "conditional",
  source: "document",
  jurisdiction: null,
  effective_date: "2025-01-01",
  source_url: `https://payer.example/${policy_id}`,
  public_url,
});
const MODA = policy("MODA-HYALURONICACIDDERIVATIVES-D535986256", "Hyaluronic Acid Derivatives", "PayerPolicy", "https://backworkhealth.com/policy/payer/moda/MODA-HYALURONICACIDDERIVATIVES-D535986256");
const MIXED_PAYERS = [
  MODA,
  policy("UHC-TMJ-1", "Temporomandibular Joint Disorders", "Medical Policy", "https://backworkhealth.com/policy/payer/unitedhealthcare/UHC-TMJ-1"),
  policy("SUREST-SH-1", "Sodium Hyaluronate", "Medical Policy", "https://backworkhealth.com/policy/payer/surest/SUREST-SH-1"),
  policy("UHC-SH-1", "Sodium Hyaluronate", "Medical Policy", "https://backworkhealth.com/policy/payer/unitedhealthcare/UHC-SH-1"),
  policy("L39529", "Hyaluronic Acid Injections for Knee Osteoarthritis", "LCD", "https://backworkhealth.com/policy/L39529"),
  policy("OLD-1", "Retired viscosupplement policy", "PayerPolicy", null),
];
const lookup = (code) => ({ code, code_system: "HCPCS", found: true, description: "Hyaluronan", policies: MIXED_PAYERS });
// The prior-auth check resolves "Moda Health" to the payer whose slug is "moda".
const PRIOR_AUTH = {
  pa_required: true,
  coverage_status: "conditional",
  confidence: "medium",
  reason: "Moda Health requires prior authorization",
  requires_manual_review: false,
  known_gaps: [],
  mac: null,
  matched_policies: [{ ...MODA, payer: { name: "Moda Health", code: "MODA", slug: "moda" }, codes: [{ code: "J7321", code_system: "HCPCS", disposition: "requires_pa", source: "document" }] }],
};

let api;
let client;
before(async () => {
  api = createServer((req, res) => {
    const path = req.url.split("?")[0];
    const data = {
      "GET /api/v1/codes/lookup": lookup("J7321"),
      "POST /api/v1/codes/batch": { results: { J7321: lookup("J7321"), J7324: lookup("J7324") } },
      "POST /api/v1/prior-auth/check": PRIOR_AUTH,
    }[`${req.method} ${path}`];
    res.writeHead(data ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data ? { success: true, data } : { success: false, error: { message: "no route" } }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  client = await connect({ BACKWORK_API_BASE: `http://127.0.0.1:${api.address().port}/api/v1` });
});
after(async () => {
  await client.close();
  await new Promise((resolve) => api.close(resolve));
});

const lookupCoverage = async (args) => {
  const result = await client.callTool({ name: "backwork_coverage_lookup", arguments: { include: ["code_details", "prior_auth"], ...args } });
  assert.notEqual(result.isError, true, result.content[0].text);
  return result;
};
const ids = (policies) => policies.map((entry) => entry.policy_id);

test("a named payer's coverage card and text show only that payer's policies", async () => {
  const result = await lookupCoverage({ procedure_codes: ["J7321"], payer: "Moda Health", state: "OR" });
  const text = result.content[0].text;

  assert.deepEqual(ids(result.structuredContent.widget.policies), [MODA.policy_id]);
  assert.deepEqual(ids(result.structuredContent.data.code_details.policies), [MODA.policy_id]);
  for (const other of ["UHC-TMJ-1", "SUREST-SH-1", "UHC-SH-1", "L39529", "OLD-1", "Temporomandibular", "Sodium Hyaluronate"]) {
    assert.doesNotMatch(text, new RegExp(other), other);
    assert.doesNotMatch(JSON.stringify(result.structuredContent), new RegExp(other), other);
  }
  assert.match(text, /Showing only Moda Health policies\. Also listing J7321, not shown: policies from 3 other payers, and 1 policy with no identified payer\./);
  assert.deepEqual(result.structuredContent.data.other_payers, { payers: 3, unidentified_policies: 1 });
});

test("a named payer also scopes a batch lookup, code by code", async () => {
  const result = await lookupCoverage({ procedure_codes: ["J7321", "J7324"], payer: "Moda Health", include: ["code_details", "prior_auth"] });
  for (const code of ["J7321", "J7324"]) assert.deepEqual(ids(result.structuredContent.data.code_details.results[code].policies), [MODA.policy_id]);
  assert.match(result.content[0].text, /Also listing these codes, not shown: policies from 3 other payers/);
});

test("without a prior-auth check, a payer slug spelled like the request still matches", async () => {
  const result = await lookupCoverage({ procedure_codes: ["J7321"], payer: "moda", include: ["code_details"] });
  assert.deepEqual(ids(result.structuredContent.data.code_details.policies), [MODA.policy_id]);
});

test("Medicare as the payer keeps only Medicare policies", async () => {
  const result = await lookupCoverage({ procedure_codes: ["J7321"], payer: "Medicare", include: ["code_details"] });
  assert.deepEqual(ids(result.structuredContent.data.code_details.policies), ["L39529"]);
});

test("without a payer, every payer's policies are listed", async () => {
  const result = await lookupCoverage({ procedure_codes: ["J7321"], include: ["code_details"] });
  assert.deepEqual(ids(result.structuredContent.data.code_details.policies), ids(MIXED_PAYERS));
  assert.doesNotMatch(result.content[0].text, /Showing only/);
  assert.equal(result.structuredContent.data.other_payers, undefined);
});
