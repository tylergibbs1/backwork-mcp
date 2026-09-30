import assert from "node:assert/strict";
import { test } from "node:test";

import { BACKWORK_OPERATIONS, operationExposure } from "../build/src/api-operations.js";

const production = { apiBase: "https://backworkhealth.com/api/v1", access: "write", exposeUnavailable: false };
const unavailable = { ...BACKWORK_OPERATIONS.lookupCode, availability: "unavailable-in-production" };

test("production withholds an operation marked unavailable", () => {
  assert.equal(operationExposure(unavailable, production), "unavailable-in-production");
  assert.equal(operationExposure(BACKWORK_OPERATIONS.lookupCode, production), "offered");
});

test("another deployment, or the operator opt-in, offers operations production marks unavailable", () => {
  assert.equal(operationExposure(unavailable, { ...production, apiBase: "http://127.0.0.1:3000/api/v1" }), "offered");
  assert.equal(operationExposure(unavailable, { ...production, exposeUnavailable: true }), "offered");
});

test("read access withholds write-scope operations everywhere, even with the opt-in", () => {
  const readOnly = { ...production, access: "read", exposeUnavailable: true, apiBase: "http://127.0.0.1:3000/api/v1" };
  assert.equal(operationExposure(BACKWORK_OPERATIONS.createWebhook, readOnly), "needs-write-access");
  assert.equal(operationExposure(BACKWORK_OPERATIONS.listUnreviewedChanges, readOnly), "offered");
});
