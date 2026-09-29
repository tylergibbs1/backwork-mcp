import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { TOOL_OPERATIONS } from "../build/src/tool-operations.js";
import { connect } from "./helpers.mjs";

let client;
let tools;
before(async () => {
  client = await connect({ BACKWORK_MCP_EXPOSE_UNAVAILABLE_TOOLS: "true" });
  ({ tools } = await client.listTools());
});
after(() => client.close());

test("each tool has a distinct title and a description that says what it is for", () => {
  const titles = new Set();
  for (const tool of tools) {
    const [purpose] = tool.description.split("\n");
    assert.ok(purpose.length >= 40 && purpose.length <= 400, `${tool.name}: first line should state the purpose in one sentence`);
    assert.ok(tool.description.length <= 1500, `${tool.name}: description is too long for a tool list`);
    assert.ok(!titles.has(tool.title), `${tool.name}: duplicate title`);
    titles.add(tool.title);
  }
});

test("action values match the operations each action is registered with", () => {
  for (const tool of tools) {
    const name = tool.name.replace(/^backwork_/, "");
    const actions = tool.inputSchema.properties.action?.enum ?? tool.inputSchema.properties.include?.items?.enum;
    if (!actions) continue;
    assert.deepEqual([...actions].sort(), Object.keys(TOOL_OPERATIONS[name]).sort(), `${tool.name}: actions and TOOL_OPERATIONS disagree`);
  }
});

test("every result schema offers provenance for citation", () => {
  for (const tool of tools) {
    assert.ok(tool.outputSchema?.properties?.provenance, `${tool.name}: outputSchema should include provenance`);
  }
});

/**
 * A lexical stand-in for tool selection: each prompt should share more
 * distinctive words with its intended tool's title and description than with
 * any other tool. It catches descriptions that drift apart from the requests
 * they are meant for, without calling a model.
 */
const SELECTION_CASES = [
  ["Is CPT 76942 covered in Texas, and what procedure codes need prior authorization?", "backwork_coverage_lookup"],
  ["Search coverage policies and extracted criteria for oxygen therapy", "backwork_policy_research"],
  ["Validate claim denial risk and documentation requirements for 99213 with E11.9", "backwork_claim_validation"],
  ["Start payer website research on prior authorization and poll the research task", "backwork_prior_auth_research"],
  ["Does CVS Caremark require step therapy for Ozempic on its drug formulary?", "backwork_drug_formulary_research"],
  ["Acknowledge the unreviewed policy change in the compliance queue", "backwork_compliance_review"],
  ["Create a webhook endpoint for policy events", "backwork_webhook_management"],
  ["Is the Backwork API healthy right now?", "backwork_system_health"],
];

function words(text) {
  return new Set(text.toLowerCase().match(/[a-z]{3,}/g) ?? []);
}

test("each sample request selects its intended tool by description overlap", () => {
  const documents = tools.map((tool) => ({ name: tool.name, words: words(`${tool.name} ${tool.title} ${tool.description}`) }));
  const documentFrequency = new Map();
  for (const document of documents) {
    for (const word of document.words) documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
  }
  const weight = (word) => Math.log((documents.length + 1) / ((documentFrequency.get(word) ?? 0) + 0.5));

  for (const [prompt, expected] of SELECTION_CASES) {
    const promptWords = [...words(prompt)];
    const scored = documents
      .map((document) => ({
        name: document.name,
        score: promptWords.filter((word) => document.words.has(word)).reduce((sum, word) => sum + weight(word), 0),
      }))
      .sort((a, b) => b.score - a.score);
    assert.equal(scored[0].name, expected, `"${prompt}" selected ${scored[0].name} (${scored.map((s) => `${s.name}=${s.score.toFixed(2)}`).join(", ")})`);
  }
});
