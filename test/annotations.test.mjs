import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { connect, startHostedOAuth } from "./helpers.mjs";

// Each tool's hints, as the directory review reads them on each kind of connection.
const CATALOG_READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const PRIOR_AUTH_RESEARCH = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const HOSTED_OAUTH = {
  backwork_coverage_lookup: CATALOG_READ,
  backwork_policy_research: CATALOG_READ,
  backwork_claim_validation: CATALOG_READ,
  backwork_prior_auth_research: PRIOR_AUTH_RESEARCH,
  backwork_drug_formulary_research: CATALOG_READ,
  backwork_compliance_review: CATALOG_READ,
};

const API_KEY = {
  ...HOSTED_OAUTH,
  // With write access the tool also acknowledges changes; acknowledging twice records one review.
  backwork_compliance_review: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  backwork_webhook_management: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  backwork_system_health: CATALOG_READ,
};

function hintsByTool(tools) {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
}

let hosted;
before(async () => {
  hosted = await startHostedOAuth();
});
after(() => hosted.close());

test("each tool on the hosted OAuth connection declares its own hints", async () => {
  const client = await hosted.connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(hintsByTool(tools), HOSTED_OAUTH);
  } finally {
    await client.close();
  }
});

test("each tool on an API-key connection declares its own hints", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(hintsByTool(tools), API_KEY);
  } finally {
    await client.close();
  }
});
