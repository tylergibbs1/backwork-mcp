#!/usr/bin/env node
// Refreshes the vendored copy of the published Backwork OpenAPI document.
// Review the diff, then run `npm run contract:check`.
import { writeFile } from "node:fs/promises";

import { PUBLISHED_OPENAPI_URL, VENDORED_OPENAPI_PATH } from "./openapi-source.mjs";

const response = await fetch(PUBLISHED_OPENAPI_URL, { headers: { Accept: "application/json" } });
if (!response.ok) throw new Error(`GET ${PUBLISHED_OPENAPI_URL} returned HTTP ${response.status}`);
const spec = await response.json();
if (typeof spec.openapi !== "string" || typeof spec.paths !== "object") {
  throw new Error(`${PUBLISHED_OPENAPI_URL} is not an OpenAPI document`);
}
await writeFile(VENDORED_OPENAPI_PATH, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`Wrote ${VENDORED_OPENAPI_PATH} from ${PUBLISHED_OPENAPI_URL}`);
