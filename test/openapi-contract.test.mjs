import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { BACKWORK_OPERATIONS, OPERATION_IDS, operationExposure } from "../build/src/api-operations.js";
import { TOOL_OPERATIONS } from "../build/src/tool-operations.js";
import { checkContract, checkExposure, specDifferences } from "../scripts/openapi-contract.mjs";
import { VENDORED_OPENAPI_PATH } from "../scripts/openapi-source.mjs";

const spec = JSON.parse(await readFile(VENDORED_OPENAPI_PATH, "utf8"));

function withOperation(id, change) {
  return { ...BACKWORK_OPERATIONS, [id]: { ...BACKWORK_OPERATIONS[id], ...change } };
}

const exposure = (candidateSpec, catalog = BACKWORK_OPERATIONS) =>
  checkExposure(candidateSpec, catalog, TOOL_OPERATIONS, operationExposure);

test("the operation catalog matches the vendored OpenAPI document", () => {
  assert.deepEqual(checkContract(spec, BACKWORK_OPERATIONS), []);
  assert.deepEqual(exposure(spec), []);
});

test("every catalogued operation is used by a tool, and every tool action uses catalogued operations", () => {
  const used = new Set(Object.values(TOOL_OPERATIONS).flatMap((actions) => Object.values(actions).flat()));
  assert.deepEqual([...used].sort(), [...OPERATION_IDS].sort());
});

test("a request field the API does not accept is drift", () => {
  // The prior-auth check used to send payer and diagnosis_codes, which the API ignores.
  const catalog = withOperation("checkPriorAuth", { body: ["procedure_codes", "state", "payer", "diagnosis_codes"] });
  assert.deepEqual(checkContract(spec, catalog), [
    'checkPriorAuth (POST /prior-auth/check): body field "payer" is not accepted',
    'checkPriorAuth (POST /prior-auth/check): body field "diagnosis_codes" is not accepted',
  ]);
});

test("a removed query parameter, path, or response field is drift", () => {
  const trimmed = structuredClone(spec);
  trimmed.paths["/policies"].get.parameters = trimmed.paths["/policies"].get.parameters.filter((p) => p.name !== "mode");
  delete trimmed.paths["/health"];
  delete trimmed.components.schemas.PolicyListItem.properties.source_url;

  const problems = checkContract(trimmed, BACKWORK_OPERATIONS);
  assert.ok(problems.includes('listPolicies (GET /policies): query parameter "mode" is not accepted'));
  assert.ok(problems.includes("getHealth (GET /health): operation is not in the OpenAPI document"));
  assert.ok(problems.includes("listPolicies (GET /policies): reads data.[].source_url, which the success response does not declare"));
});

test("an availability marker added or lifted is drift", () => {
  const marked = structuredClone(spec);
  marked.paths["/compliance/stats"].get["x-backwork-availability"] = "unavailable-in-production";
  assert.deepEqual(checkContract(marked, BACKWORK_OPERATIONS), [
    'getComplianceStats (GET /compliance/stats): catalog availability is "available" but the document says "unavailable-in-production"',
  ]);

  // The stale catalog that hid coverage, claim, prior-auth and formulary tools from the hosted server.
  const stale = withOperation("lookupCode", { availability: "unavailable-in-production" });
  assert.deepEqual(checkContract(spec, stale), [
    'lookupCode (GET /codes/lookup): catalog availability is "unavailable-in-production" but the document says "available"',
  ]);
});

test("a required-scope change is drift", () => {
  const scoped = structuredClone(spec);
  scoped.paths["/compliance/stats"].get["x-backwork-required-scopes"] = ["write"];
  assert.deepEqual(checkContract(scoped, BACKWORK_OPERATIONS), [
    'getComplianceStats (GET /compliance/stats): catalog scope is "read" but the document requires "write"',
  ]);
});

test("a tool action offered for an operation production does not serve fails, even with a stale catalog", () => {
  const marked = structuredClone(spec);
  marked.paths["/drugs/formulary"].get["x-backwork-availability"] = "unavailable-in-production";
  delete marked.paths["/health"];
  assert.deepEqual(exposure(marked), [
    "backwork_drug_formulary_research 'search' (read access) calls searchDrugFormularyEvidence, which production marks unavailable",
    "backwork_system_health 'check' (read access) calls getHealth, which production does not serve",
    "backwork_drug_formulary_research 'search' (write access) calls searchDrugFormularyEvidence, which production marks unavailable",
    "backwork_system_health 'check' (write access) calls getHealth, which production does not serve",
  ]);
});

test("the read-only OAuth grant is never offered an action that needs write scope", () => {
  const readScoped = withOperation("acknowledgeChange", { scope: "read" });
  assert.deepEqual(exposure(spec, readScoped), [
    "backwork_compliance_review 'acknowledge' (read access) calls acknowledgeChange, which needs write scope",
  ]);
});

test("the live check compares the contract, not the prose", () => {
  const reworded = structuredClone(spec);
  reworded.info.description = "Reworded.";
  reworded.paths["/policies"].get.summary = "Reworded.";
  assert.deepEqual(specDifferences(spec, reworded), []);

  const changed = structuredClone(spec);
  changed.paths["/codes/lookup"].get["x-backwork-availability"] = "unavailable-in-production";
  delete changed.paths["/health"];
  assert.deepEqual(specDifferences(spec, changed), [
    "/paths/~1health",
    "/paths/~1codes~1lookup/get/x-backwork-availability",
  ]);
});
