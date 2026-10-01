import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";

import { connect } from "./helpers.mjs";

// What POST /prior-auth/check returns for Moda Health + J7321 in Oregon, and for a payer with no matching policy.
const MODA_J7321 = {
  pa_required: true,
  coverage_status: "conditional",
  confidence: "low",
  reason:
    "Conditional coverage requires review of specific criteria; every matched code is inferred from a policy title (inferred_title_match), so the policy document has not confirmed it",
  requires_manual_review: true,
  known_gaps: ["J7321: attached because a policy title names the drug; that policy document does not list the code"],
  mac: null,
  matched_policies: [
    {
      policy_id: "MODA-HYALURONICACIDDERIVATIVES-D535986256",
      title: "Hyaluronic Acid Derivatives",
      policy_type: "PayerPolicy",
      jurisdiction: "OR",
      codes: [{ code: "J7321", code_system: "HCPCS", disposition: "conditional", source: "inferred_title_match" }],
    },
  ],
};
const NO_MATCH = {
  pa_required: false,
  coverage_status: "unknown",
  confidence: "low",
  reason: "No active Moda Health policies found for the provided codes",
  requires_manual_review: true,
  known_gaps: ["No active coverage policies found for the provided codes and context"],
  mac: null,
  matched_policies: [],
};

describe("prior-auth checks for a named payer", () => {
  const bodies = [];
  let response = MODA_J7321;
  let api;
  let client;

  before(async () => {
    api = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const found = req.method === "POST" && req.url === "/api/v1/prior-auth/check";
        if (found) bodies.push(JSON.parse(raw));
        res.writeHead(found ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify(found ? { success: true, data: response, meta: { request_id: "req_test" } } : {}));
      });
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    client = await connect({ BACKWORK_API_BASE: `http://127.0.0.1:${api.address().port}/api/v1` });
  });
  after(async () => {
    await client.close();
    await new Promise((resolve) => api.close(resolve));
  });

  const text = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, result.content[0].text);
    return result.content[0].text;
  };

  test("coverage_lookup sends the payer and shows that J7321 is inferred", async () => {
    response = MODA_J7321;
    const output = await text("backwork_coverage_lookup", {
      procedure_codes: ["J7321"],
      payer: "Moda Health",
      plan_type: "commercial",
      state: "OR",
      include: ["prior_auth"],
    });

    assert.deepEqual(bodies.at(-1), { procedure_codes: ["J7321"], state: "OR", payer: "Moda Health" });
    assert.match(output, /Prior Authorization Required: YES/);
    assert.match(output, /MODA-HYALURONICACIDDERIVATIVES-D535986256/);
    assert.match(output, /J7321: attached because a policy title names the drug/);
  });

  test("prior_auth_research check sends the payer", async () => {
    response = MODA_J7321;
    await text("backwork_prior_auth_research", {
      action: "check",
      procedure_codes: ["J7321"],
      payer: "Moda Health",
      state: "OR",
    });

    assert.deepEqual(bodies.at(-1), { procedure_codes: ["J7321"], state: "OR", payer: "Moda Health" });
  });

  test("no matching policy reads as unknown, not as prior auth not required", async () => {
    response = NO_MATCH;
    const output = await text("backwork_coverage_lookup", {
      procedure_codes: ["J7321"],
      payer: "Moda Health",
      state: "OR",
      include: ["prior_auth"],
    });

    assert.match(output, /Prior Authorization Required: UNKNOWN/);
    assert.doesNotMatch(output, /Prior Authorization Required: NO/);
    assert.match(output, /Manual review required/);
  });
});
