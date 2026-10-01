import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import vm from "node:vm";

import { WIDGET_SCHEMAS } from "../build/src/widgets/schemas.js";
import { WIDGETS, WIDGET_MIME_TYPE } from "../build/src/widgets/templates.js";
import { connect } from "./helpers.mjs";

// Which component each tool renders, per the ChatGPT app spec in the README.
const TOOL_WIDGETS = {
  backwork_coverage_lookup: "coverage_card",
  backwork_prior_auth_research: "prior_auth_checklist",
  backwork_policy_research: "policy_comparison",
};

const LCD_URL = "https://www.cms.gov/medicare-coverage-database/view/lcd.aspx?lcdid=33718";
const backworkPage = (policyId) => ({ kind: "backwork", url: `https://backworkhealth.com/policy/${policyId}` });
const policyMatch = (policy_id, source, extra = {}) => ({
  policy_id,
  title: `Policy ${policy_id}`,
  policy_type: "LCD",
  disposition: "requires_pa",
  jurisdiction: "JM",
  effective_date: "2025-01-01",
  source_url: LCD_URL,
  ...(source ? { source } : {}),
  ...extra,
});
const comparedPolicy = (policy_id, codes, is_national = false) => ({
  policy_id,
  title: `Policy ${policy_id}`,
  policy_type: is_national ? "NCD" : "LCD",
  effective_date: "2025-01-01",
  source_url: LCD_URL,
  is_national,
  codes,
});

const RESPONSES = {
  "GET /api/v1/codes/lookup": () => ({
    code: "J1001",
    code_system: "HCPCS",
    policies: [
      policyMatch("L1", "document", { disposition: "covered" }),
      policyMatch("L2", "inferred_title_match", {
        title: 'Drug <img src=x onerror="alert(1)"> policy',
        policy_type: "Drug Policy",
        source_url: "javascript:alert(1)",
      }),
      policyMatch("AET-1", "document", { policy_type: "Drug Policy", source_url: "https://www.aetna.com/cpb/0113.html" }),
    ],
  }),
  "POST /api/v1/prior-auth/check": () => ({
    pa_required: true,
    confidence: "high",
    reason: "Listed in the Medicare prior authorization program",
    mac: { name: "Palmetto GBA", jurisdiction: "JM", states: ["NC", "SC"] },
    matched_policies: [
      {
        ...policyMatch("L1"),
        codes: [
          { code: "J1001", code_system: "HCPCS", disposition: "requires_pa", source: "document" },
          { code: "J1002", code_system: "HCPCS", disposition: "requires_pa", source: "inferred_title_match" },
        ],
      },
    ],
    documentation_checklist: ["Physician order", "Progress notes from the last 6 months"],
    known_gaps: ["Commercial payer rules were not checked"],
  }),
  "POST /api/v1/prior-auth/research": () => ({ research_id: "res_123", status: "pending", poll_url: "/api/v1/prior-auth/research/res_123" }),
  "POST /api/v1/policies/compare": () => ({
    comparison: [
      {
        jurisdiction: "JM",
        mac: { name: "Palmetto GBA", code: "11201", jurisdiction_name: "Jurisdiction M", states: ["NC", "SC"] },
        policies: [comparedPolicy("L1", [{ code: "76942", code_system: "CPT", disposition: "covered", source: "document" }])],
        coverage_summary: { covered: 1, not_covered: 0, requires_pa: 0, conditional: 0 },
      },
      {
        jurisdiction: "JH",
        mac: { name: "Novitas", code: "04112", jurisdiction_name: "Jurisdiction H", states: ["TX"] },
        policies: [comparedPolicy("L2", [{ code: "76942", code_system: "CPT", disposition: "requires_pa", source: "inferred_title_match" }])],
        coverage_summary: { covered: 0, not_covered: 0, requires_pa: 1, conditional: 0 },
      },
    ],
    national_policies: [],
    summary: {
      total_jurisdictions: 2,
      jurisdictions_with_coverage: 2,
      national_policies_count: 0,
      has_variation: true,
      queried_codes: ["76942"],
      requested_jurisdictions: ["JM", "JH", "J9"],
      unresolved_jurisdictions: ["J9"],
      policy_type_filter: null,
    },
  }),
};

let api;
let client;
before(async () => {
  api = createServer((req, res) => {
    const respond = RESPONSES[`${req.method} ${req.url.split("?")[0]}`];
    res.writeHead(respond ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(respond ? { success: true, data: respond(), meta: { request_id: "req_test" } } : { error: { message: "no route" } }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  // A client that does not advertise MCP Apps support, like Claude Code, Cursor, or the MCP Inspector.
  client = await connect({ BACKWORK_API_BASE: `http://127.0.0.1:${api.address().port}/api/v1` });
});
after(async () => {
  await client.close();
  await new Promise((resolve) => api.close(resolve));
});

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return result;
}

const CALLS = {
  coverage_card: () => call("backwork_coverage_lookup", { procedure_codes: ["J1001"] }),
  prior_auth_checklist: () => call("backwork_prior_auth_research", { action: "check", procedure_codes: ["J1001", "J1002"] }),
  policy_comparison: () => call("backwork_policy_research", { action: "compare", procedure_codes: ["76942"], jurisdictions: ["JM", "JH", "J9"] }),
};

describe("tool list", () => {
  test("links each component tool to its template, and no other tool", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const kind = TOOL_WIDGETS[tool.name];
      if (!kind) {
        assert.equal(tool._meta?.ui, undefined, tool.name);
        assert.equal(tool._meta?.["openai/outputTemplate"], undefined, tool.name);
        continue;
      }
      assert.equal(tool._meta.ui.resourceUri, WIDGETS[kind].uri, tool.name);
      assert.equal(tool._meta["openai/outputTemplate"], WIDGETS[kind].uri, tool.name);
      assert.ok(tool._meta["openai/toolInvocation/invoking"].length <= 64, tool.name);
      assert.ok(tool._meta["openai/toolInvocation/invoked"].length <= 64, tool.name);
      assert.ok(tool.outputSchema.properties.widget, `${tool.name}: outputSchema should declare the widget view`);
    }
  });
});

describe("component resources", () => {
  test("lists one HTML resource per component, with the MCP Apps mime type", async () => {
    const { resources } = await client.listResources();
    assert.deepEqual(
      resources.map((resource) => resource.uri).sort(),
      Object.values(WIDGETS).map((widget) => widget.uri).sort(),
    );
    for (const resource of resources) assert.equal(resource.mimeType, WIDGET_MIME_TYPE);
    assert.equal(WIDGET_MIME_TYPE, "text/html;profile=mcp-app");
  });

  for (const [kind, widget] of Object.entries(WIDGETS)) {
    test(`${kind} is served self-contained, with an empty CSP`, async () => {
      const { contents } = await client.readResource({ uri: widget.uri });
      assert.equal(contents.length, 1);
      const [content] = contents;
      assert.equal(content.mimeType, WIDGET_MIME_TYPE);
      assert.match(content.text, /^<!doctype html>/);
      assert.deepEqual(content._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
      assert.equal(content._meta.ui.prefersBorder, true);
      assert.equal(content._meta["openai/widgetDescription"], widget.description);
      assert.doesNotMatch(content.text, /<script[^>]+src=|<link\b|@import|url\(|fetch\(|XMLHttpRequest/);
    });
  }
});

describe("structured content", () => {
  for (const [kind, run] of Object.entries(CALLS)) {
    test(`${kind}: the widget view matches its schema exactly`, async () => {
      const result = await run();
      const view = result.structuredContent.widget;
      assert.equal(view.kind, kind);
      // strict(): the view carries no field the schema does not declare.
      assert.deepEqual(WIDGET_SCHEMAS[kind].strict().parse(view), view);
    });
  }

  test("coverage card labels inferred codes and links Backwork pages, else the source", async () => {
    const { structuredContent } = await CALLS.coverage_card();
    const [listed, inferred, commercial] = structuredContent.widget.policies;
    assert.deepEqual(listed.codes[0], { code: "J1001", code_system: "HCPCS", disposition: "covered", source: "document", source_label: "Listed in policy" });
    assert.equal(listed.payer, "CMS");
    assert.deepEqual(listed.link, backworkPage("L1"));
    assert.equal(inferred.codes[0].source_label, "Inferred from policy title");
    assert.equal(inferred.link, null, "a javascript: source URL is not a link");
    assert.deepEqual(commercial.link, { kind: "source", url: "https://www.aetna.com/cpb/0113.html" });
    assert.deepEqual(structuredContent.widget.prior_auth, { required: true, confidence: "high", reason: "Listed in the Medicare prior authorization program" });
  });

  test("prior-auth checklist lists PA codes, documentation, gaps and inferred codes", async () => {
    const { structuredContent } = await CALLS.prior_auth_checklist();
    const view = structuredContent.widget;
    assert.deepEqual(view.codes_requiring_pa.map((code) => [code.code, code.source_label]), [
      ["J1001", "Listed in policy"],
      ["J1002", "Inferred from policy title"],
    ]);
    assert.deepEqual(view.documentation.map((item) => item.text), ["Physician order", "Progress notes from the last 6 months"]);
    assert.deepEqual(view.known_gaps, ["Commercial payer rules were not checked"]);
    assert.deepEqual(view.inferred_codes, [{ code: "J1002", policy_id: "L1", policy_title: "Policy L1" }]);
    assert.deepEqual(view.mac, { name: "Palmetto GBA", jurisdiction: "JM" });
    assert.deepEqual(view.citations[0].link, backworkPage("L1"));
  });

  test("a started research task renders as pending", async () => {
    const result = await call("backwork_prior_auth_research", { action: "start_research", procedure_codes: ["J1001"], payer: "Aetna" });
    assert.equal(result.structuredContent.widget.status, "pending");
    assert.equal(result.structuredContent.widget.research_id, "res_123");
  });

  test("policy comparison puts each jurisdiction in a column", async () => {
    const { structuredContent } = await CALLS.policy_comparison();
    const view = structuredContent.widget;
    assert.deepEqual(view.columns.map((column) => [column.jurisdiction, column.payer]), [
      ["JM", "Palmetto GBA"],
      ["JH", "Novitas"],
    ]);
    assert.deepEqual(view.rows[0].cells.map((cell) => [cell.disposition, cell.policy_id, cell.source]), [
      ["covered", "L1", "document"],
      ["requires_pa", "L2", "inferred_title_match"],
    ]);
    assert.deepEqual(view.unresolved_jurisdictions, ["J9"]);
  });

  test("results without a component view, such as a policy search, carry no widget", async () => {
    RESPONSES["GET /api/v1/policies"] = () => [policyMatch("L1")];
    const result = await call("backwork_policy_research", { action: "search", query: "ultrasound" });
    assert.equal(result.structuredContent.widget, undefined);
  });
});

describe("a client without UI support", () => {
  test("still gets the markdown text, with inferred codes labelled", async () => {
    const result = await CALLS.prior_auth_checklist();
    assert.equal(result.content.length, 1);
    const text = result.content[0].text;
    assert.match(text, /^Prior Authorization Required: YES\nConfidence: HIGH\n/);
    assert.match(text, /  - J1002 \(HCPCS\): requires_pa — inferred from policy title \(not listed in the document\)/);
    assert.doesNotMatch(text, /<[a-z]|widget/i);
  });

  test("gets markdown for the new compare action too", async () => {
    const text = (await CALLS.policy_comparison()).content[0].text;
    assert.match(text, /^Policy Comparison for 76942\nJurisdictions analyzed: 2\n/);
    assert.match(text, /JH \(Novitas\)\n  Covered: 0, prior auth: 1, conditional: 0, not covered: 0\n  - L2: Policy L2 \[76942 requires_pa — inferred from policy title/);
    assert.match(text, /No active MAC: J9/);
  });

  test("response_format json still returns the structured content as text", async () => {
    const result = await call("backwork_coverage_lookup", { procedure_codes: ["J1001"], response_format: "json" });
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  });
});

/** Loads a component page in a stub browser and returns hooks to drive it as a host would. */
function loadWidget(html, { openai } = {}) {
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const posted = [];
  const listeners = new Map();
  const on = (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  const root = { innerHTML: "" };
  const documentElement = {
    dataset: {},
    lang: "en",
    style: { values: {}, setProperty(name, value) { this.values[name] = value; } },
    getBoundingClientRect: () => ({ width: 640, height: 280 }),
  };
  const parent = { postMessage: (message) => posted.push(structuredClone(message)) };
  const window = { parent, openai, addEventListener: on, open: () => {} };
  const document = { getElementById: (id) => (id === "root" ? root : null), documentElement, body: {}, addEventListener: on };
  vm.runInNewContext(script, { window, document, setTimeout, Element: class {}, HTMLAnchorElement: class {} });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    root,
    documentElement,
    posted,
    async send(data) {
      for (const listener of listeners.get("message") ?? []) listener({ source: parent, data });
      await settle();
    },
  };
}

describe("component rendering", () => {
  test("renders the tool result after the MCP Apps handshake, in the host's theme", async () => {
    const { structuredContent } = await CALLS.coverage_card();
    const { contents } = await client.readResource({ uri: WIDGETS.coverage_card.uri });
    const page = loadWidget(contents[0].text);

    const [initialize] = page.posted;
    assert.equal(initialize.method, "ui/initialize");
    assert.equal(initialize.params.protocolVersion, "2026-01-26");
    await page.send({
      jsonrpc: "2.0",
      id: initialize.id,
      result: { hostContext: { theme: "dark", styles: { variables: { "--color-text-primary": "#fafafa" } } } },
    });
    assert.deepEqual(page.posted[1], { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    assert.equal(page.documentElement.dataset.theme, "dark");
    assert.equal(page.documentElement.style.values["--color-text-primary"], "#fafafa");

    await page.send({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [], structuredContent } });
    const out = page.root.innerHTML;
    assert.match(out, /<h2>Coverage for J1001<\/h2>/);
    assert.match(out, /Prior auth required · high confidence/);
    assert.match(out, /<span class="badge covered">Covered<\/span><span class="source">Listed in policy<\/span>/);
    assert.match(out, /<span class="source flagged">Inferred from policy title<\/span>/);
    assert.match(out, /<a class="link" href="https:\/\/backworkhealth\.com\/policy\/L1" data-external[^>]*aria-label="Open L1 on Backwork: Policy L1">Open policy<\/a>/);
    assert.match(out, /<a class="link" href="https:\/\/www\.aetna\.com\/cpb\/0113\.html" data-external[^>]*>Open source document<\/a>/);
    // The second policy's title is escaped and its javascript: URL is not linked.
    assert.match(out, /Drug &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; policy/);
    assert.doesNotMatch(out, /<img|javascript:/);
    assert.equal(page.posted.at(-1).method, "ui/notifications/size-changed");
  });

  test("renders from window.openai.toolOutput when the host provides it", async () => {
    const { structuredContent } = await CALLS.prior_auth_checklist();
    const { contents } = await client.readResource({ uri: WIDGETS.prior_auth_checklist.uri });
    const page = loadWidget(contents[0].text, { openai: { theme: "light", toolOutput: structuredContent } });
    const out = page.root.innerHTML;
    assert.equal(page.documentElement.dataset.theme, "light");
    assert.match(out, /<h3>Codes requiring prior auth<\/h3>/);
    assert.match(out, /<h3>Documentation needed<\/h3>/);
    assert.match(out, /Physician order/);
    assert.match(out, /<h3>Known gaps<\/h3>/);
    assert.match(out, /<span class="code">J1002<\/span> <span class="source flagged">Inferred from policy title<\/span> L1 does not list this code/);
    assert.match(out, /<h3>Citations<\/h3>/);
  });

  test("renders the comparison as an accessible table", async () => {
    const { structuredContent } = await CALLS.policy_comparison();
    const { contents } = await client.readResource({ uri: WIDGETS.policy_comparison.uri });
    const page = loadWidget(contents[0].text, { openai: { toolOutput: structuredContent } });
    const out = page.root.innerHTML;
    assert.match(out, /<caption class="sr-only">Disposition of 76942 in each jurisdiction<\/caption>/);
    assert.match(out, /<th scope="col"><span class="code">JM<\/span><span class="muted block">Palmetto GBA<\/span><\/th>/);
    assert.match(out, /<th scope="row" class="code">76942<\/th><td><span class="badge covered">Covered<\/span>/);
    assert.match(out, /Coverage varies/);
    assert.match(out, /No active contractor for J9/);
  });

  test("shows nothing for a result from another component or with no view", async () => {
    const { structuredContent } = await CALLS.coverage_card();
    const { contents } = await client.readResource({ uri: WIDGETS.policy_comparison.uri });
    const page = loadWidget(contents[0].text, { openai: { toolOutput: structuredContent } });
    assert.equal(page.root.innerHTML, "");
  });
});
