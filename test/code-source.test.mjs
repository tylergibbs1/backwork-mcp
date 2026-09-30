import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";

import { connect } from "./helpers.mjs";

const INFERRED = " — inferred from policy title (not listed in the document)";

// One code entry of each kind: listed in the document, inferred from the
// title, and from an older API response that has no `source` field.
const policyMatch = (policy_id, source) => ({
  policy_id,
  title: `Policy ${policy_id}`,
  policy_type: "Drug Policy",
  disposition: "covered",
  jurisdiction: null,
  effective_date: null,
  source_url: null,
  ...(source ? { source } : {}),
});
const codeEntry = (code, source) => ({
  code,
  code_system: "HCPCS",
  display: `Drug ${code}`,
  disposition: "covered",
  ...(source ? { source } : {}),
});
const codeLookup = (code) => ({
  code,
  code_system: "HCPCS",
  description: `Drug ${code}`,
  policies: [policyMatch("DOC-1", "document"), policyMatch("INF-1", "inferred_title_match"), policyMatch("OLD-1")],
});
const policyCodes = [codeEntry("J1001", "document"), codeEntry("J1002", "inferred_title_match"), codeEntry("J1003")];

let unknownSource = false;
const RESPONSES = {
  "GET /api/v1/codes/lookup": () => codeLookup("J1001"),
  "POST /api/v1/codes/batch": () => ({ results: { J1001: codeLookup("J1001"), J1002: codeLookup("J1002") } }),
  "POST /api/v1/prior-auth/check": () => ({
    pa_required: true,
    confidence: "high",
    reason: "Listed drug",
    matched_policies: [
      {
        policy_id: "DRUG-1",
        title: "Drug policy",
        policy_type: "Drug Policy",
        codes: unknownSource ? [codeEntry("J1004", "guessed")] : policyCodes,
      },
    ],
  }),
  "GET /api/v1/policies/DRUG-1": () => ({
    policy_id: "DRUG-1",
    title: "Drug policy",
    policy_type: "Drug Policy",
    status: "active",
    codes: { HCPCS: policyCodes },
  }),
};

function lineFor(text, needle) {
  const line = text.split("\n").find((candidate) => candidate.includes(needle));
  assert.ok(line, `no line contains ${JSON.stringify(needle)} in:\n${text}`);
  return line;
}

/** Asserts that only the inferred entry is labelled, in whatever line format the formatter uses. */
function assertLabels(text, { document, inferred, missing }) {
  assert.ok(lineFor(text, inferred).endsWith(INFERRED));
  assert.ok(!lineFor(text, document).includes("inferred"));
  assert.ok(!lineFor(text, missing).includes("inferred"));
}

describe("code source in markdown output", () => {
  let api;
  let client;

  before(async () => {
    api = createServer((req, res) => {
      const respond = RESPONSES[`${req.method} ${req.url.split("?")[0]}`];
      res.writeHead(respond ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(respond ? { success: true, data: respond(), meta: { request_id: "req_test" } } : { error: { message: "no route" } }));
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

  test("single code lookup labels inferred policy matches", async () => {
    const result = await call("backwork_coverage_lookup", { procedure_codes: ["J1001"], include: ["code_details"] });
    const text = result.content[0].text;
    // Policy match lines are "  - <id>: <title>" followed by the disposition line.
    const dispositionAfter = (id) => text.split("\n")[text.split("\n").indexOf(lineFor(text, `- ${id}:`)) + 1];
    assert.equal(dispositionAfter("DOC-1"), "    Type: Drug Policy, Disposition: covered");
    assert.equal(dispositionAfter("INF-1"), `    Type: Drug Policy, Disposition: covered${INFERRED}`);
    assert.equal(dispositionAfter("OLD-1"), "    Type: Drug Policy, Disposition: covered");
  });

  test("batch code lookup labels inferred policy matches", async () => {
    const result = await call("backwork_coverage_lookup", { procedure_codes: ["J1001", "J1002"], include: ["code_details"] });
    assertLabels(result.content[0].text, { document: "DOC-1:", inferred: "INF-1:", missing: "OLD-1:" });
  });

  test("prior auth check labels inferred codes", async () => {
    const result = await call("backwork_prior_auth_research", { action: "check", procedure_codes: ["J1001"] });
    const text = result.content[0].text;
    assert.equal(lineFor(text, "J1001"), "  - J1001 (HCPCS): covered");
    assert.equal(lineFor(text, "J1002"), `  - J1002 (HCPCS): covered${INFERRED}`);
    assert.equal(lineFor(text, "J1003"), "  - J1003 (HCPCS): covered");
  });

  test("policy detail labels inferred codes", async () => {
    const result = await call("backwork_policy_research", { action: "get", policy_id: "DRUG-1" });
    const text = result.content[0].text;
    assert.equal(lineFor(text, "J1001"), "  - J1001: Drug J1001 [covered]");
    assert.equal(lineFor(text, "J1002"), `  - J1002: Drug J1002 [covered]${INFERRED}`);
    assert.equal(lineFor(text, "J1003"), "  - J1003: Drug J1003 [covered]");
  });

  test("structured output reports a missing source as document", async () => {
    const result = await call("backwork_policy_research", { action: "get", policy_id: "DRUG-1", response_format: "json" });
    const sources = result.structuredContent.data.codes.HCPCS.map((code) => [code.code, code.source]);
    assert.deepEqual(sources, [
      ["J1001", "document"],
      ["J1002", "inferred_title_match"],
      ["J1003", "document"],
    ]);
  });

  test("an unrecognized source is labelled in markdown and passed through in JSON", async () => {
    unknownSource = true;
    try {
      const markdown = await call("backwork_prior_auth_research", { action: "check", procedure_codes: ["J1004"] });
      assert.equal(lineFor(markdown.content[0].text, "J1004"), "  - J1004 (HCPCS): covered — source: guessed (unrecognized)");
      const json = await call("backwork_prior_auth_research", { action: "check", procedure_codes: ["J1004"], response_format: "json" });
      assert.equal(json.structuredContent.data.matched_policies[0].codes[0].source, "guessed");
    } finally {
      unknownSource = false;
    }
  });
});
