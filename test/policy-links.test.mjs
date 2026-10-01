import assert from "node:assert/strict";
import { test } from "node:test";

import { policyLink, publicPolicyUrl } from "../build/src/policy-links.js";

test("Medicare LCDs, Articles and NCDs link to their Backwork page", () => {
  for (const policy_type of ["LCD", "Article", "NCD"]) {
    assert.deepEqual(policyLink({ policy_id: "A52369", policy_type, source_url: "https://www.cms.gov/x" }), {
      kind: "backwork",
      url: "https://backworkhealth.com/policy/A52369",
    });
  }
});

test("commercial page URLs follow the platform's /policy/payer/<slug>/<id> route", () => {
  assert.equal(
    publicPolicyUrl({ kind: "commercial", payerSlug: "moda-health", policyId: "MODA-HYALURONICACIDDERIVATIVES-D535986256" }),
    "https://backworkhealth.com/policy/payer/moda-health/MODA-HYALURONICACIDDERIVATIVES-D535986256",
  );
});

test("path segments are encoded, so an ID cannot change the route", () => {
  assert.equal(publicPolicyUrl({ kind: "medicare", policyId: "L1/../../admin?x=1#y" }), "https://backworkhealth.com/policy/L1%2F..%2F..%2Fadmin%3Fx%3D1%23y");
});

test("other policies fall back to their http(s) source document", () => {
  // The API returns no payer slug, so a commercial policy cannot name its Backwork page yet.
  assert.deepEqual(policyLink({ policy_id: "AET-0113", policy_type: "Drug Policy", source_url: "https://www.aetna.com/cpb/0113.html" }), {
    kind: "source",
    url: "https://www.aetna.com/cpb/0113.html",
  });
  assert.deepEqual(policyLink({ policy_id: "X", policy_type: null, source_url: "http://example.com/p" }), { kind: "source", url: "http://example.com/p" });
});

test("no link without a public page or a safe source URL", () => {
  assert.equal(policyLink({ policy_id: "X", policy_type: "Drug Policy", source_url: "javascript:alert(1)" }), null);
  assert.equal(policyLink({ policy_id: "X", policy_type: "PayerPolicy", source_url: null }), null);
});
