#!/usr/bin/env node
// Usage:
//   node scripts/check-openapi-contract.mjs          check against the vendored openapi/backwork-openapi.json
//   node scripts/check-openapi-contract.mjs --live   also check the published document, and that the vendored copy matches it (CI)
import { readFile } from "node:fs/promises";

import { BACKWORK_OPERATIONS, operationExposure } from "../build/src/api-operations.js";
import { TOOL_OPERATIONS } from "../build/src/tool-operations.js";
import { checkContract, checkExposure, specDifferences } from "./openapi-contract.mjs";
import { PUBLISHED_OPENAPI_URL, VENDORED_OPENAPI_PATH } from "./openapi-source.mjs";

const live = process.argv.includes("--live");

// Production sits behind Vercel bot protection, which answers GitHub-hosted runners with 429 or 403.
// Those responses mean "could not read the spec", not drift: retry with backoff, then warn and skip.
// The vendored check (`npm test`) stays the blocking contract gate.
const BLOCKED_STATUSES = new Set([403, 429]);
const ATTEMPTS = 4;
const SHOWN_DIFFERENCES = 20;

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

function contractProblems(spec) {
  return [
    ...checkContract(spec, BACKWORK_OPERATIONS),
    ...checkExposure(spec, BACKWORK_OPERATIONS, TOOL_OPERATIONS, operationExposure),
  ];
}

function fail(source, problems, remedy) {
  console.error(`OpenAPI contract drift against ${source}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(remedy);
  process.exit(1);
}

const vendored = JSON.parse(await readFile(VENDORED_OPENAPI_PATH, "utf8"));
const remedy = "Update src/api-operations.ts and the tools that use it, then run `npm run openapi:update`.";

const vendoredProblems = contractProblems(vendored);
if (vendoredProblems.length > 0) fail(VENDORED_OPENAPI_PATH, vendoredProblems, remedy);

if (live) {
  const published = await fetchPublishedSpec();
  if (published.blockedStatus) {
    const message = `Skipped the live contract check: ${PUBLISHED_OPENAPI_URL} returned HTTP ${published.blockedStatus} after ${ATTEMPTS} attempts (bot protection). The vendored contract check still ran.`;
    console.log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `warning: ${message}`);
    process.exit(0);
  }

  const liveProblems = contractProblems(published);
  if (liveProblems.length > 0) fail(PUBLISHED_OPENAPI_URL, liveProblems, remedy);

  const drift = specDifferences(vendored, published);
  if (drift.length > 0) {
    const shown = drift.slice(0, SHOWN_DIFFERENCES);
    if (drift.length > shown.length) shown.push(`... and ${drift.length - shown.length} more`);
    fail(
      PUBLISHED_OPENAPI_URL,
      shown.map((pointer) => `vendored copy differs at ${pointer}`),
      "Run `npm run openapi:update`, review the diff, and commit openapi/backwork-openapi.json.",
    );
  }
}

const operations = Object.keys(BACKWORK_OPERATIONS).length;
console.log(
  live
    ? `OpenAPI contract in sync: ${operations} operations checked against ${PUBLISHED_OPENAPI_URL}, which matches the vendored copy.`
    : `OpenAPI contract in sync with ${VENDORED_OPENAPI_PATH}: ${operations} operations checked.`,
);
