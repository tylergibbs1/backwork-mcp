import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";

import { renderWidget } from "../build/src/widgets/render.js";
import { connect } from "./helpers.mjs";

// "Compare how Medicare contractors JM, JH, and JK cover CPT 64493": code lookup lists local and
// payer policies for 64493, while the prior-auth check (no state, so national policies only) matches
// none and answers with its empty result: pa_required false, coverage_status "unknown".
const lookupPolicy = (policy_id, policy_type, jurisdiction) => ({
  policy_id,
  title: `Policy ${policy_id}`,
  policy_type,
  jurisdiction,
  disposition: "covered",
  source: "document",
  effective_date: "2025-01-01",
  source_url: "https://www.cms.gov/medicare-coverage-database/view/lcd.aspx?lcdid=40391",
});
const CODE_64493 = {
  code: "64493",
  code_system: "CPT",
  policies: [
    lookupPolicy("AMBETTER-CP-MP-171", "Medical Policy", null),
    lookupPolicy("FIRST_COAST-L40404", "LCD", "JN"),
    lookupPolicy("NOVITAS-JH-L40391", "LCD", "JH"),
    lookupPolicy("NOVITAS-JL-L40391", "LCD", "JL"),
  ],
};
const NO_POLICY_MATCHED = {
  pa_required: false,
  prior_auth_required: false,
  coverage_status: "unknown",
  confidence: "low",
  denial_risk: "medium",
  reason: "No coverage policies found for the provided codes",
  matched_policies: [],
  documentation_checklist: [],
  requires_manual_review: true,
  known_gaps: ["No active coverage policies found for the provided codes and context"],
  mac: null,
};
const PA_REQUIRED = {
  pa_required: true,
  coverage_status: "conditional",
  confidence: "high",
  reason: "Listed in the Medicare prior authorization program",
  matched_policies: [
    { ...lookupPolicy("NOVITAS-JH-L40391", "LCD", "JH"), codes: [{ code: "64493", code_system: "CPT", disposition: "requires_pa", source: "document" }] },
  ],
  known_gaps: [],
  mac: { name: "Novitas", jurisdiction: "JH", states: ["TX"] },
};
const NOT_REQUIRED = {
  ...PA_REQUIRED,
  pa_required: false,
  coverage_status: "covered",
  reason: "Covered without prior authorization",
  matched_policies: [
    { ...lookupPolicy("NOVITAS-JH-L40391", "LCD", "JH"), codes: [{ code: "64493", code_system: "CPT", disposition: "covered", source: "document" }] },
  ],
};

describe("prior-auth verdict on the coverage card and checklist", () => {
  let check = NO_POLICY_MATCHED;
  let api;
  let client;

  before(async () => {
    api = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const path = new URL(req.url, "http://localhost").pathname;
        const data = path === "/api/v1/codes/lookup" ? CODE_64493 : path === "/api/v1/prior-auth/check" ? check : undefined;
        res.writeHead(data ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data ? { success: true, data, meta: { request_id: "req_test" } } : {}));
      });
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    client = await connect({ BACKWORK_API_BASE: `http://127.0.0.1:${api.address().port}/api/v1` });
  });
  after(async () => {
    await client.close();
    await new Promise((resolve) => api.close(resolve));
  });

  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, result.content[0].text);
    return result;
  };
  const coverageLookup = () => call("backwork_coverage_lookup", { procedure_codes: ["64493"] });
  const priorAuthCheck = () => call("backwork_prior_auth_research", { action: "check", procedure_codes: ["64493"] });

  test("a check that matched no policy renders as unknown, and does not deny the listed policies", async () => {
    check = NO_POLICY_MATCHED;
    const { structuredContent, content } = await coverageLookup();
    const view = structuredContent.widget;
    assert.equal(view.policies.length, 4);
    assert.equal(view.prior_auth.verdict, "unknown");

    const html = renderWidget(view);
    assert.match(html, /Prior auth unknown/);
    assert.doesNotMatch(html, /not required|No prior auth/);
    assert.doesNotMatch(html, /No coverage policies found/);
    assert.match(html, /Review the policies below for prior-auth rules/);

    const text = content[0].text;
    assert.match(text, /Prior Authorization Required: UNKNOWN/);
    assert.match(text, /policies under Code Details were not evaluated for prior auth/i);
  });

  test("with no policies at all, the card says no policy lists the codes, once", async () => {
    check = NO_POLICY_MATCHED;
    const { structuredContent } = await call("backwork_coverage_lookup", { procedure_codes: ["64493"], include: ["prior_auth"] });
    const html = renderWidget(structuredContent.widget);
    assert.match(html, /Prior auth unknown/);
    assert.match(html, /No Backwork policy lists these codes/);
    assert.doesNotMatch(html, /No coverage policies found/);
  });

  test("a check that matched policies keeps its verdict and reason", async () => {
    check = PA_REQUIRED;
    let html = renderWidget((await coverageLookup()).structuredContent.widget);
    assert.match(html, /Prior auth required/);
    assert.match(html, /Listed in the Medicare prior authorization program/);

    check = NOT_REQUIRED;
    html = renderWidget((await coverageLookup()).structuredContent.widget);
    assert.match(html, /Prior auth not required/);
    assert.match(html, /Covered without prior authorization/);
  });

  test("the prior-auth checklist reads an unmatched check as unknown, not as not required", async () => {
    check = NO_POLICY_MATCHED;
    const { structuredContent } = await priorAuthCheck();
    assert.equal(structuredContent.widget.prior_auth.verdict, "unknown");
    const html = renderWidget(structuredContent.widget);
    assert.match(html, /Prior auth unknown/);
    assert.doesNotMatch(html, /Prior auth not required/);
  });
});

test("only src/prior-auth-verdict.ts reads the API's pa_required boolean", () => {
  // Read alone, pa_required: false also means "the check found nothing". Every surface goes through
  // parsePriorAuthCheck or parseResearchDetermination so it cannot show that as "not required".
  const readers = readdirSync("src", { recursive: true })
    .filter((file) => file.endsWith(".ts") && file !== "prior-auth-verdict.ts")
    .filter((file) => /\.pa_required\b|\[\s*["']pa_required["']\s*\]|\{[^}]*\bpa_required\b[^}]*\}\s*=/.test(readFileSync(`src/${file}`, "utf8")));
  assert.deepEqual(readers, []);
});
