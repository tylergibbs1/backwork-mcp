#!/usr/bin/env node
// Usage:
//   node scripts/check-openapi-contract.mjs          check against the vendored openapi/backwork-openapi.json
//   node scripts/check-openapi-contract.mjs --live   check against the published document (CI)
import { readFile } from "node:fs/promises";

import { BACKWORK_OPERATIONS } from "../build/src/api-operations.js";
import { checkContract } from "./openapi-contract.mjs";
import { PUBLISHED_OPENAPI_URL, VENDORED_OPENAPI_PATH } from "./openapi-source.mjs";

const live = process.argv.includes("--live");

async function loadSpec() {
  if (!live) return JSON.parse(await readFile(VENDORED_OPENAPI_PATH, "utf8"));
  const response = await fetch(PUBLISHED_OPENAPI_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${PUBLISHED_OPENAPI_URL} returned HTTP ${response.status}`);
  return response.json();
}

const spec = await loadSpec();
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
