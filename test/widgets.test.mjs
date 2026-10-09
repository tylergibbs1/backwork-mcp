import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import vm from "node:vm";

import { renderWidget } from "../build/src/widgets/render.js";
import { COMPONENT_VIEWS, VIEW_SCHEMAS } from "../build/src/widgets/schemas.js";
import { WIDGETS, WIDGET_MIME_TYPE } from "../build/src/widgets/templates.js";
import { connect } from "./helpers.mjs";

// Which component each tool renders, per the ChatGPT app spec in the README.
const TOOL_WIDGETS = {
  backwork_coverage_lookup: "coverage_card",
  backwork_prior_auth_research: "prior_auth_checklist",
  backwork_policy_research: "policy_research",
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
  "GET /api/v1/prior-auth/research/res_123": () => ({
    research_id: "res_123",
    status: "completed",
    result: {
      determination: { pa_required: true, confidence: "medium", reasoning: "Aetna lists the code." },
      payer_policies: [{ payer_name: "Aetna", policy_name: "Botulinum toxins", policy_url: "https://www.aetna.com/cpb/0113.html" }],
      documentation_requirements: [{ requirement: "Chart notes", mandatory: true }],
    },
    error: null,
  }),
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
  // An empty query stands in for a search that matches nothing.
  "GET /api/v1/policies": (url) =>
    url.searchParams.get("q") === "nothing"
      ? []
      : [
          { ...policyMatch("L1"), status: "active", public_url: "https://backworkhealth.com/policy/L1", summary: "Covers ultrasound guidance for needle placement." },
          { ...policyMatch("AET-0113", null, { policy_type: "Medical Policy", jurisdiction: null }), payer: "Aetna", status: "retired", public_url: null, source_url: "https://www.aetna.com/cpb/0113.html" },
        ],
  "GET /api/v1/policies/L1": () => ({
    ...policyMatch("L1"),
    status: "active",
    last_reviewed_date: "2026-06-01",
    public_url: "https://backworkhealth.com/policy/L1",
    summary: "Ultrasound guidance is covered when it is medically necessary.",
    mac: { name: "Palmetto GBA", jurisdiction_name: "Jurisdiction M", states: ["NC"] },
    criteria: {
      indications: [{ text: "Needle placement needs imaging guidance." }, { text: "Second block." }],
      limitations: [{ text: "Not for routine screening." }],
    },
    codes: {
      CPT: [
        { code: "76942", display: "Ultrasonic guidance", disposition: "covered", source: "document" },
        { code: "76999", display: null, disposition: "conditional", source: "inferred_title_match" },
      ],
    },
  }),
  "GET /api/v1/coverage/criteria": () => [
    {
      section: "indications",
      text: "Polysomnography with an AHI of at least 15 events per hour.",
      policy_id: "L33718",
      policy_title: "Positive Airway Pressure Devices",
      policy_type: "LCD",
      jurisdiction: "JM",
      effective_date: "2025-01-01",
      policy: { policy_id: "L33718", title: "Positive Airway Pressure Devices", public_url: "https://backworkhealth.com/policy/L33718" },
    },
  ],
  "GET /api/v1/policies/changes": () => [
    { change_type: "codes_changed", policy_id: "L1", policy_title: "Policy L1", policy_type: "LCD", payer_name: null, changed_at: "2026-06-01T12:00:00Z", change_summary: "Added 76942." },
  ],
  "GET /api/v1/jurisdictions": () => [
    { jurisdiction_code: "JM", jurisdiction_name: "Jurisdiction M", mac_name: "Palmetto GBA", mac_code: "11502", states: ["NC", "SC", "VA", "WV"], website_url: "https://www.palmettogba.com/" },
    { jurisdiction_code: "JH", jurisdiction_name: "Jurisdiction H", mac_name: "Novitas", mac_code: "04412", states: ["TX"], website_url: "javascript:alert(1)" },
  ],
};

let api;
let client;
before(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const respond = RESPONSES[`${req.method} ${url.pathname}`];
    res.writeHead(respond ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(respond ? { success: true, data: respond(url), meta: { request_id: "req_test" } } : { error: { message: "no route" } }));
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

/** One call per view kind. */
const CALLS = {
  coverage_card: () => call("backwork_coverage_lookup", { procedure_codes: ["J1001"] }),
  prior_auth_checklist: () => call("backwork_prior_auth_research", { action: "check", procedure_codes: ["J1001", "J1002"] }),
  policy_comparison: () => call("backwork_policy_research", { action: "compare", procedure_codes: ["76942"], jurisdictions: ["JM", "JH", "J9"] }),
  policy_list: () => call("backwork_policy_research", { action: "search", query: "ultrasound" }),
  policy_detail: () => call("backwork_policy_research", { action: "get", policy_id: "L1" }),
  criteria_list: () => call("backwork_policy_research", { action: "criteria", query: "AHI" }),
  policy_changes: () => call("backwork_policy_research", { action: "changes" }),
  jurisdiction_list: () => call("backwork_policy_research", { action: "jurisdictions" }),
};

/**
 * Every action of every tool that has a component, with the view it returns
 * (null: nothing to show, so the component collapses). Includes results with
 * nothing to show, which must collapse rather than leave an empty card.
 */
const ACTION_CALLS = [
  { name: "backwork_coverage_lookup", args: { procedure_codes: ["J1001"] }, view: "coverage_card" },
  { name: "backwork_coverage_lookup", args: { procedure_codes: ["J1001"], include: ["prior_auth"] }, view: "coverage_card" },
  { name: "backwork_coverage_lookup", args: { procedure_codes: ["76942"], include: ["jurisdiction_compare"] }, view: null },
  { name: "backwork_prior_auth_research", args: { action: "check", procedure_codes: ["J1001"] }, view: "prior_auth_checklist" },
  { name: "backwork_prior_auth_research", args: { action: "start_research", procedure_codes: ["J1001"], payer: "Aetna" }, view: "prior_auth_checklist" },
  { name: "backwork_prior_auth_research", args: { action: "get_research", research_id: "res_123" }, view: "prior_auth_checklist" },
  { name: "backwork_prior_auth_research", args: { action: "get_research" }, view: null, isError: true },
  { name: "backwork_policy_research", args: { action: "compare", procedure_codes: ["76942"] }, view: "policy_comparison" },
  { name: "backwork_policy_research", args: { action: "search", query: "ultrasound" }, view: "policy_list" },
  { name: "backwork_policy_research", args: { action: "search", query: "nothing" }, view: null },
  { name: "backwork_policy_research", args: { action: "get", policy_id: "L1" }, view: "policy_detail" },
  { name: "backwork_policy_research", args: { action: "get", policy_id: "L404" }, view: null, isError: true },
  { name: "backwork_policy_research", args: { action: "criteria", query: "AHI" }, view: "criteria_list" },
  { name: "backwork_policy_research", args: { action: "changes" }, view: "policy_changes" },
  { name: "backwork_policy_research", args: { action: "jurisdictions" }, view: "jurisdiction_list" },
];

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
    // Hosts cache a component by URI, so the URI must change whenever its HTML does.
    test(`${kind} URI is derived from a hash of the HTML it serves`, async () => {
      const { contents } = await client.readResource({ uri: widget.uri });
      const hash = createHash("sha256").update(contents[0].text).digest("hex").slice(0, 12);
      assert.match(widget.uri, new RegExp(`^ui://backwork/[a-z-]+-${hash}\\.html$`));
    });

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
      assert.deepEqual(VIEW_SCHEMAS[kind].strict().parse(view), view);
    });
  }

  test("coverage card labels inferred codes and links Backwork pages, else the source", async () => {
    const { structuredContent } = await CALLS.coverage_card();
    const [listed, inferred, commercial] = structuredContent.widget.policies;
    assert.deepEqual(listed.codes[0], { code: "J1001", code_system: "HCPCS", disposition: "covered", source: "document", source_label: "Listed in policy", grounding: null, grounding_label: null });
    assert.equal(listed.payer, "CMS");
    assert.deepEqual(listed.link, backworkPage("L1"));
    assert.equal(inferred.codes[0].source_label, "Inferred from policy title");
    assert.equal(inferred.link, null, "a javascript: source URL is not a link");
    assert.deepEqual(commercial.link, { kind: "source", url: "https://www.aetna.com/cpb/0113.html" });
    assert.deepEqual(structuredContent.widget.prior_auth, { verdict: "required", confidence: "high", reason: "Listed in the Medicare prior authorization program" });
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

  test("a search that finds nothing carries no widget", async () => {
    const result = await call("backwork_policy_research", { action: "search", query: "nothing" });
    assert.equal(result.structuredContent.widget, undefined);
  });

  test("policy search lists each policy with its payer, status and link", async () => {
    const view = (await CALLS.policy_list()).structuredContent.widget;
    assert.equal(view.query, "ultrasound");
    assert.deepEqual(view.policies.map((policy) => [policy.policy_id, policy.payer, policy.status, policy.link]), [
      ["L1", "CMS", "active", backworkPage("L1")],
      ["AET-0113", "Aetna", "retired", { kind: "source", url: "https://www.aetna.com/cpb/0113.html" }],
    ]);
  });

  test("a fetched policy carries its summary, one criteria excerpt per section, and labelled codes", async () => {
    const view = (await CALLS.policy_detail()).structuredContent.widget;
    assert.equal(view.policy.summary, "Ultrasound guidance is covered when it is medically necessary.");
    assert.equal(view.policy.last_reviewed_date, "2026-06-01");
    assert.deepEqual(view.criteria, [
      { section: "indications", text: "Needle placement needs imaging guidance.", more: 1 },
      { section: "limitations", text: "Not for routine screening.", more: 0 },
    ]);
    assert.deepEqual(view.codes.map((code) => [code.code, code.code_system, code.disposition, code.source_label]), [
      ["76942", "CPT", "covered", "Listed in policy"],
      ["76999", "CPT", "conditional", "Inferred from policy title"],
    ]);
  });

  test("criteria, changes and jurisdictions keep only what the card shows", async () => {
    const criteria = (await CALLS.criteria_list()).structuredContent.widget;
    assert.deepEqual(criteria.items[0].policy.link, backworkPage("L33718"));
    const changes = (await CALLS.policy_changes()).structuredContent.widget;
    assert.deepEqual(changes.changes[0], {
      change_type: "codes_changed",
      policy_id: "L1",
      policy_title: "Policy L1",
      payer: "CMS",
      changed_on: "2026-06-01",
      summary: "Added 76942.",
    });
    const jurisdictions = (await CALLS.jurisdiction_list()).structuredContent.widget;
    assert.deepEqual(jurisdictions.jurisdictions.map((row) => [row.code, row.website]), [
      ["JM", "https://www.palmettogba.com/"],
      ["JH", null],
    ]);
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

/**
 * Loads a component page in a stub browser and returns hooks to drive it as a
 * host would. The page's height is 0 when the root is empty and grows with its
 * content, so a test can tell an empty card from a collapsed one.
 */
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
    getBoundingClientRect: () => ({ width: 640, height: root.innerHTML ? 280 : 0 }),
  };
  const host = { heights: [], closed: 0 };
  if (openai) {
    openai.notifyIntrinsicHeight = (height) => host.heights.push(height);
    openai.requestClose = () => host.closed++;
  }
  const parent = { postMessage: (message) => posted.push(structuredClone(message)) };
  const window = { parent, openai, addEventListener: on, open: () => {} };
  const document = { getElementById: (id) => (id === "root" ? root : null), documentElement, body: {}, addEventListener: on };
  vm.runInNewContext(script, { window, document, setTimeout, Element: class {}, HTMLAnchorElement: class {} });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    root,
    documentElement,
    posted,
    host,
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
    const { contents } = await client.readResource({ uri: WIDGETS.policy_research.uri });
    const page = loadWidget(contents[0].text, { openai: { toolOutput: structuredContent } });
    const out = page.root.innerHTML;
    assert.match(out, /<caption class="sr-only">Disposition of 76942 in each jurisdiction<\/caption>/);
    assert.match(out, /<th scope="col"><span class="code">JM<\/span><span class="muted block">Palmetto GBA<\/span><\/th>/);
    assert.match(out, /<th scope="row" class="code">76942<\/th><td><span class="badge covered">Covered<\/span>/);
    assert.match(out, /Coverage varies/);
    assert.match(out, /No active contractor for J9/);
  });

  test("collapses and closes for a result from another component", async () => {
    const { structuredContent } = await CALLS.coverage_card();
    const { contents } = await client.readResource({ uri: WIDGETS.policy_research.uri });
    const page = loadWidget(contents[0].text, { openai: { toolOutput: structuredContent } });
    assert.equal(page.root.innerHTML, "");
    assert.deepEqual(page.host.heights, [0]);
    assert.equal(page.host.closed, 1);
  });

  test("renders a compact policy card for search, fetch, criteria, changes and jurisdictions", async () => {
    const { contents } = await client.readResource({ uri: WIDGETS.policy_research.uri });
    const render = async (kind) => loadWidget(contents[0].text, { openai: { toolOutput: (await CALLS[kind]()).structuredContent } }).root.innerHTML;

    const search = await render("policy_list");
    assert.match(search, /<h2>Policies matching “ultrasound”<\/h2>/);
    assert.match(search, /<strong>Policy AET-0113<\/strong> <span class="tag">Retired<\/span>/);
    assert.match(search, /aria-label="Open L1 on Backwork: Policy L1">Open policy<\/a>/);

    const detail = await render("policy_detail");
    assert.match(detail, /<h2>Policy L1<\/h2>/);
    assert.match(detail, /Policy L1 · Effective 2025-01-01 · Reviewed 2026-06-01/);
    assert.match(detail, /<li><span class="eyebrow">Indications<\/span><span class="excerpt">Needle placement needs imaging guidance\. <span class="muted">\+1 more<\/span><\/span><\/li>/);
    assert.doesNotMatch(detail, /<li><li>/);
    assert.match(detail, /<span class="code">76999<\/span><span class="badge conditional">Conditional<\/span><span class="muted">.*<span class="source flagged">Inferred from policy title<\/span>|<span class="code">76999<\/span><span class="badge conditional">Conditional<\/span><span class="source flagged">Inferred from policy title<\/span>/);

    const criteria = await render("criteria_list");
    assert.match(criteria, /<span class="tag">Indications<\/span>/);
    assert.match(criteria, /Positive Airway Pressure Devices<\/a>/);

    const changes = await render("policy_changes");
    assert.match(changes, /<span class="tag">Codes changed<\/span><span class="muted">2026-06-01 · CMS<\/span>/);

    const jurisdictions = await render("jurisdiction_list");
    assert.match(jurisdictions, /<th scope="row" class="code">JM<\/th><td><a class="link" href="https:\/\/www\.palmettogba\.com\/"/);
    assert.match(jurisdictions, /<th scope="row" class="code">JH<\/th><td>Novitas<\/td>/);
    assert.doesNotMatch(jurisdictions, /javascript:/);
  });
});

describe("no empty cards", () => {
  test("every view belongs to exactly one component, and each has a test call", () => {
    const owners = Object.values(COMPONENT_VIEWS).flat();
    assert.deepEqual([...owners].sort(), Object.keys(VIEW_SCHEMAS).sort());
    assert.equal(new Set(owners).size, owners.length);
    assert.deepEqual(Object.keys(CALLS).sort(), Object.keys(VIEW_SCHEMAS).sort());
  });

  test("every action of every tool with a component is covered", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools.filter((candidate) => TOOL_WIDGETS[candidate.name])) {
      const actions = tool.inputSchema.properties.action?.enum;
      if (!actions) continue;
      const covered = new Set(ACTION_CALLS.filter((entry) => entry.name === tool.name).map((entry) => entry.args.action));
      for (const action of actions) assert.ok(covered.has(action), `${tool.name}: add an ACTION_CALLS entry for '${action}'`);
    }
  });

  for (const { name, args, view, isError } of ACTION_CALLS) {
    const label = `${name} ${JSON.stringify(args)}`;
    for (const bridge of ["ChatGPT window.openai", "MCP Apps bridge"]) {
      test(`${label} on the ${bridge}: ${view ? `renders ${view}` : "collapses"}`, async () => {
        const result = await client.callTool({ name, arguments: args });
        assert.equal(result.isError, isError, result.content[0]?.text);
        assert.equal(result.structuredContent.widget?.kind ?? null, view);

        const component = TOOL_WIDGETS[name];
        const { contents } = await client.readResource({ uri: WIDGETS[component].uri });
        let page;
        let height;
        if (bridge === "MCP Apps bridge") {
          page = loadWidget(contents[0].text);
          await page.send({ jsonrpc: "2.0", id: page.posted[0].id, result: { hostContext: { theme: "light" } } });
          await page.send({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
          height = page.posted.filter((message) => message.method === "ui/notifications/size-changed").at(-1)?.params.height;
        } else {
          page = loadWidget(contents[0].text, { openai: { toolOutput: result.structuredContent } });
          height = page.host.heights.at(-1);
        }

        if (view) {
          assert.match(page.root.innerHTML, /^<article class="card"[\s\S]*<h2>[^<]+/, "a card with a heading");
          assert.ok(height > 0, "a rendered card reports its height");
          if (page.host) assert.equal(page.host.closed, 0);
        } else {
          assert.equal(page.root.innerHTML, "");
          assert.equal(height, 0, "an empty result reports zero height");
          if (bridge !== "MCP Apps bridge") assert.equal(page.host.closed, 1, "ChatGPT is asked to close the empty card");
        }
      });
    }
  }

  test("renderWidget returns a non-empty card for every view schema's smallest valid view", () => {
    const policy = { policy_id: "L1", title: "T", policy_type: null, payer: null, jurisdiction: null, effective_date: null, link: null };
    const minimal = {
      coverage_card: { kind: "coverage_card", codes_requested: ["1"], prior_auth: null, policies: [], policies_omitted: 0 },
      prior_auth_checklist: {
        kind: "prior_auth_checklist", status: "complete", research_id: null, prior_auth: { verdict: "unknown", confidence: null, reason: null }, mac: null,
        codes_requiring_pa: [], documentation: [], known_gaps: [], inferred_codes: [], citations: [],
      },
      policy_comparison: { kind: "policy_comparison", codes: ["1"], has_variation: null, columns: [], rows: [], policies: [], unresolved_jurisdictions: [], columns_omitted: 0 },
      policy_list: { kind: "policy_list", query: null, policies: [{ ...policy, status: null, summary: null }], policies_omitted: 0, has_more: false },
      policy_detail: { kind: "policy_detail", policy: { ...policy, status: null, last_reviewed_date: null, summary: null }, criteria: [], codes: [], codes_omitted: 0 },
      criteria_list: { kind: "criteria_list", query: null, items: [{ section: "other", text: "x", policy }], items_omitted: 0, has_more: false },
      policy_changes: { kind: "policy_changes", changes: [{ change_type: "updated", policy_id: "L1", policy_title: "T", payer: null, changed_on: null, summary: null }], changes_omitted: 0, has_more: false },
      jurisdiction_list: { kind: "jurisdiction_list", jurisdictions: [{ code: "JM", name: null, mac: null, states: [], website: null }], jurisdictions_omitted: 0 },
    };
    assert.deepEqual(Object.keys(minimal).sort(), Object.keys(VIEW_SCHEMAS).sort());
    for (const [kind, view] of Object.entries(minimal)) {
      VIEW_SCHEMAS[kind].strict().parse(view);
      assert.match(renderWidget(view), /<h2>[^<]+<\/h2>/, kind);
    }
  });

});
