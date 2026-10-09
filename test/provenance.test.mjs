import assert from "node:assert/strict";
import { test } from "node:test";

import { extractProvenance } from "../build/src/provenance.js";

const LCD_URL = "https://www.cms.gov/medicare-coverage-database/view/lcd.aspx?lcdid=33718";

test("collects policy sources from a claim validation response", () => {
  const provenance = extractProvenance({
    coverage_status: "conditional",
    effective_date: "2020-07-01",
    policy_sources: [
      {
        source_id: "L33718",
        policy_id: "L33718",
        policy_type: "LCD",
        source_url: LCD_URL,
        effective_date: "2025-01-01",
        last_verified_at: "2026-09-20T09:00:00.000Z",
      },
      {
        source_id: "CMS-OPD-PA-BOTULINUM-TOXIN",
        policy_id: "CMS-OPD-PA-BOTULINUM-TOXIN",
        policy_type: "CMS_PA_PROGRAM",
        source_url: "https://www.cms.gov/prior-authorization",
        effective_date: "2020-07-01",
        last_verified_at: null,
      },
    ],
    matched_policies: [{ policy_id: "L33718", policy_type: "LCD", source_url: LCD_URL, effective_date: "2025-01-01" }],
  });

  assert.deepEqual(provenance?.source_urls, [LCD_URL, "https://www.cms.gov/prior-authorization"]);
  assert.deepEqual(provenance?.authorities, ["CMS"]);
  assert.equal(provenance?.retrieved_at, null, "one cited source has no known fetch time");
  assert.equal(provenance?.sources[0].retrieved_at, "2026-09-20T09:00:00.000Z");
  assert.equal(provenance?.as_of, "2025-01-01");
  assert.equal(provenance?.sources.length, 2, "a policy cited twice is listed once");
});

test("names the payer for a commercial policy", () => {
  const provenance = extractProvenance({
    policy_id: "CPB-0004",
    policy_type: "PayerPolicy",
    source_url: "https://www.aetna.com/cpb/medical/data/1_99/0004.html",
    effective_date: "2026-03-01",
    payer: { name: "Aetna", code: "AETNA", type: "commercial" },
  });
  assert.deepEqual(provenance?.authorities, ["Aetna"]);
});

test("passes a Backwork agent tool provenance block through", () => {
  const upstream = {
    source_urls: [LCD_URL],
    authorities: ["CMS"],
    retrieved_at: "2026-09-20T09:00:00.000Z",
    as_of: "2025-01-01",
    sources: [
      { policy_id: "L33718", source_url: LCD_URL, authority: "CMS", retrieved_at: "2026-09-20T09:00:00.000Z", as_of: "2025-01-01" },
    ],
  };
  assert.deepEqual(extractProvenance({ coverage_status: "covered", provenance: upstream }), upstream);
});

test("reports unusable values as null instead of inventing them", () => {
  const provenance = extractProvenance([{ policy_id: "X1", source_url: "N/A", effective_date: "soon", last_verified_at: "never" }]);
  assert.deepEqual(provenance?.sources, [
    { policy_id: "X1", source_url: null, authority: null, retrieved_at: null, as_of: null },
  ]);
  assert.deepEqual(provenance?.source_urls, []);
});

test("returns nothing when the response cites no source", () => {
  assert.equal(extractProvenance({ status: "ok", checks: { database: "ok" } }), undefined);
  assert.equal(extractProvenance(null), undefined);
});

test("uses authoritative source-check freshness, with legacy fallback only when the block is absent", () => {
  const legacy = { policy_id: "L33718", policy_type: "LCD", source_url: LCD_URL, last_verified_at: "2026-09-20T09:00:00Z" };
  for (const [sourceCheck, expected] of [
    [undefined, "2026-09-20T09:00:00.000Z"],
    [{ source_url: LCD_URL, last_fetched_at: "2026-10-08T12:30:00Z" }, "2026-10-08T12:30:00.000Z"],
    [{ source_url: LCD_URL, last_fetched_at: null }, null],
    [{ source_url: LCD_URL, last_fetched_at: "never" }, null],
    [null, null],
  ]) {
    const data = sourceCheck === undefined ? legacy : { ...legacy, source_check: sourceCheck };
    const provenance = extractProvenance(data);
    assert.equal(provenance?.retrieved_at, expected);
    assert.equal(provenance?.sources.length, 1, "the nested check belongs to its policy, not a second source");
    assert.equal(provenance?.sources[0].retrieved_at, expected);
    for (const mentions of [[legacy, data], [data, legacy]]) {
      assert.equal(extractProvenance(mentions)?.retrieved_at, expected, "legacy mentions cannot override a source check for the same document");
    }
  }
});

test("cites a criteria policy whose source URL appears only in its source-check block", () => {
  const provenance = extractProvenance([{ policy: { policy_id: "L33718", policy_type: "LCD", source_check: { source_url: LCD_URL, last_fetched_at: "2026-10-08T12:30:00Z" } } }]);
  assert.deepEqual(provenance?.sources, [{ policy_id: "L33718", source_url: LCD_URL, authority: "CMS", retrieved_at: "2026-10-08T12:30:00.000Z", as_of: null }]);
});
