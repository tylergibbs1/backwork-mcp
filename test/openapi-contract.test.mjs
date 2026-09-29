import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { BACKWORK_OPERATIONS, OPERATION_IDS } from "../build/src/api-operations.js";
import { TOOL_OPERATIONS } from "../build/src/tool-operations.js";
import { checkContract } from "../scripts/openapi-contract.mjs";
import { VENDORED_OPENAPI_PATH } from "../scripts/openapi-source.mjs";

const spec = JSON.parse(await readFile(VENDORED_OPENAPI_PATH, "utf8"));

function withOperation(id, change) {
  return { ...BACKWORK_OPERATIONS, [id]: { ...BACKWORK_OPERATIONS[id], ...change } };
}

test("the operation catalog matches the vendored OpenAPI document", () => {
  assert.deepEqual(checkContract(spec, BACKWORK_OPERATIONS), { problems: [], warnings: [] });
});

test("every catalogued operation is used by a tool, and every tool action uses catalogued operations", () => {
  const used = new Set(Object.values(TOOL_OPERATIONS).flatMap((actions) => Object.values(actions).flat()));
  assert.deepEqual([...used].sort(), [...OPERATION_IDS].sort());
});

test("a request field the API does not accept is drift", () => {
  // The prior-auth check used to send payer and diagnosis_codes, which the API ignores.
  const catalog = withOperation("checkPriorAuth", { body: ["procedure_codes", "state", "payer", "diagnosis_codes"] });
  const { problems } = checkContract(spec, catalog);
  assert.deepEqual(problems, [
    'checkPriorAuth (POST /prior-auth/check): body field "payer" is not accepted',
    'checkPriorAuth (POST /prior-auth/check): body field "diagnosis_codes" is not accepted',
  ]);
});

test("a removed query parameter, path, or response field is drift", () => {
  const trimmed = structuredClone(spec);
  trimmed.paths["/policies"].get.parameters = trimmed.paths["/policies"].get.parameters.filter((p) => p.name !== "mode");
  delete trimmed.paths["/health"];
  delete trimmed.components.schemas.PolicyListItem.properties.source_url;

  const { problems } = checkContract(trimmed, BACKWORK_OPERATIONS);
  assert.ok(problems.includes('listPolicies (GET /policies): query parameter "mode" is not accepted'));
  assert.ok(problems.includes("getHealth (GET /health): operation is not in the OpenAPI document"));
  assert.ok(problems.includes("listPolicies (GET /policies): reads data.[].source_url, which the success response does not declare"));
});

test("a new unavailable marker fails in every mode; a lifted one only warns against the live document", () => {
  const marked = structuredClone(spec);
  marked.paths["/webhooks"].get["x-backwork-availability"] = "unavailable-in-production";
  for (const availability of ["exact", "no-silent-failures"]) {
    assert.equal(checkContract(marked, BACKWORK_OPERATIONS, { availability }).problems.length, 1);
  }

  const lifted = structuredClone(spec);
  delete lifted.paths["/policies"].get["x-backwork-availability"];
  assert.equal(checkContract(lifted, BACKWORK_OPERATIONS, { availability: "exact" }).problems.length, 1);
  const live = checkContract(lifted, BACKWORK_OPERATIONS, { availability: "no-silent-failures" });
  assert.equal(live.problems.length, 0);
  assert.equal(live.warnings.length, 1);
});
