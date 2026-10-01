import assert from "node:assert/strict";
import { test } from "node:test";

import { policyLink, publicPolicyUrl } from "../build/src/policy-links.js";
import { buildCoverageCard } from "../build/src/widgets/views.js";

const MODA_PAGE = "https://backworkhealth.com/policy/payer/moda-health/MODA-HYALURONICACIDDERIVATIVES-D535986256";

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
    MODA_PAGE,
  );
});

test("path segments are encoded, so an ID cannot change the route", () => {
  assert.equal(publicPolicyUrl({ kind: "medicare", policyId: "L1/../../admin?x=1#y" }), "https://backworkhealth.com/policy/L1%2F..%2F..%2Fadmin%3Fx%3D1%23y");
});

test("the API's public_url wins: a commercial policy links to its Backwork page", () => {
  assert.deepEqual(
    policyLink({
      policy_id: "MODA-HYALURONICACIDDERIVATIVES-D535986256",
      policy_type: "Medical Policy",
      source_url: "https://www.modahealth.com/policy.pdf",
      public_url: MODA_PAGE,
    }),
    { kind: "backwork", url: MODA_PAGE },
  );
  // A retired policy's public_url names its active successor, not its own ID.
  assert.deepEqual(
    policyLink({
      policy_id: "HUMANA-BOTOX-MA-EFF-20250101",
      policy_type: "Medical Policy",
      source_url: "https://www.humana.com/b1.pdf",
      public_url: "https://backworkhealth.com/policy/payer/humana/HUMANA-BOTOX-MA-EFF-20260101",
    }),
    { kind: "backwork", url: "https://backworkhealth.com/policy/payer/humana/HUMANA-BOTOX-MA-EFF-20260101" },
  );
});

test("a null public_url means no public page, even for a Medicare type, so the link is the source", () => {
  // A retired LCD: the API knows /policy/L30000 does not exist.
  assert.deepEqual(policyLink({ policy_id: "L30000", policy_type: "LCD", source_url: "https://www.cms.gov/l30000", public_url: null }), {
    kind: "source",
    url: "https://www.cms.gov/l30000",
  });
  assert.equal(policyLink({ policy_id: "L30000", policy_type: "LCD", source_url: null, public_url: null }), null);
});

test("a public_url that is not a Backwork policy page is ignored", () => {
  for (const public_url of [
    "javascript:alert(1)",
    "https://evil.example/policy/L1",
    "http://backworkhealth.com/policy/L1",
    "https://backworkhealth.com.evil.example/policy/L1",
    "https://backworkhealth.com/sign-in",
    "not a url",
    42,
  ]) {
    assert.deepEqual(
      policyLink({ policy_id: "AET-0113", policy_type: "Drug Policy", source_url: "https://www.aetna.com/cpb/0113.html", public_url }),
      { kind: "source", url: "https://www.aetna.com/cpb/0113.html" },
      String(public_url),
    );
  }
});

test("without public_url (an older API), other policies fall back to their http(s) source document", () => {
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

test("the coverage card links each policy where the API's public_url says", () => {
  const view = buildCoverageCard(["J7321"], {
    code_details: {
      code: "J7321",
      code_system: "HCPCS",
      policies: [
        {
          policy_id: "MODA-HYALURONICACIDDERIVATIVES-D535986256",
          title: "Hyaluronic Acid Derivatives",
          policy_type: "Medical Policy",
          disposition: "requires_pa",
          source: "document",
          source_url: "https://www.modahealth.com/policy.pdf",
          public_url: MODA_PAGE,
        },
        {
          policy_id: "L30000",
          title: "Retired LCD",
          policy_type: "LCD",
          disposition: "covered",
          source: "document",
          source_url: "https://www.cms.gov/l30000",
          public_url: null,
        },
      ],
    },
  });

  assert.deepEqual(
    view.policies.map((policy) => [policy.policy_id, policy.link]),
    [
      ["MODA-HYALURONICACIDDERIVATIVES-D535986256", { kind: "backwork", url: MODA_PAGE }],
      ["L30000", { kind: "source", url: "https://www.cms.gov/l30000" }],
    ],
  );
});
