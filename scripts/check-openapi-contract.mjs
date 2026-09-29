#!/usr/bin/env node
// Usage:
//   node scripts/check-openapi-contract.mjs          check against the vendored openapi/backwork-openapi.json
//   node scripts/check-openapi-contract.mjs --live   check against the published document (CI)
import { readFile } from "node:fs/promises";

import { BACKWORK_OPERATIONS } from "../build/src/api-operations.js";
import { checkContract } from "./openapi-contract.mjs";
import { PUBLISHED_OPENAPI_URL, VENDORED_OPENAPI_PATH } from "./openapi-source.mjs";

const live = process.argv.includes("--live");

// Production sits behind Vercel bot protection, which answers GitHub-hosted runners with 429 or 403.
// Those responses mean "could not read the spec", not drift: retry with backoff, then warn and skip.
// The vendored check (`npm test`) stays the blocking contract gate.
const BLOCKED_STATUSES = new Set([403, 429]);
const ATTEMPTS = 4;

async function fetchPublishedSpec() {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const response = await fetch(PUBLISHED_OPENAPI_URL, { headers: { Accept: "application/json" } });
    if (response.ok) return response.json();
    if (!BLOCKED_STATUSES.has(response.status)) {
      throw new Error(`GET ${PUBLISHED_OPENAPI_URL} returned HTTP ${response.status}`);
    }
    if (attempt === ATTEMPTS) return { blockedStatus: response.status };
    const retryAfterSeconds = Number(response.headers.get("retry-after")) || 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfterSeconds, 30) * 1000));
  }
  throw new Error("unreachable");
}

async function loadSpec() {
  if (!live) return JSON.parse(await readFile(VENDORED_OPENAPI_PATH, "utf8"));
  return fetchPublishedSpec();
}

const spec = await loadSpec();
if (spec.blockedStatus) {
  const message = `Skipped the live contract check: ${PUBLISHED_OPENAPI_URL} returned HTTP ${spec.blockedStatus} after ${ATTEMPTS} attempts (bot protection). The vendored contract check still ran.`;
  console.log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `warning: ${message}`);
  process.exit(0);
}
const { problems, warnings } = checkContract(spec, BACKWORK_OPERATIONS, {
  availability: live ? "no-silent-failures" : "exact",
});
const source = live ? PUBLISHED_OPENAPI_URL : VENDORED_OPENAPI_PATH;

for (const warning of warnings) console.warn(`warning: ${warning}`);
if (problems.length > 0) {
  console.error(`OpenAPI contract drift against ${source}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("Update src/api-operations.ts and the tools that use it, then run `npm run openapi:update`.");
  process.exit(1);
}
console.log(`OpenAPI contract in sync with ${source}: ${Object.keys(BACKWORK_OPERATIONS).length} operations checked.`);
