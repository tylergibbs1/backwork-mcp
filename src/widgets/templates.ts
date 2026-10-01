import { createHash } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { renderWidget, widgetRuntime } from "./render.js";
import { z } from "zod";

import { COMPONENT_VIEWS, VIEW_SCHEMAS, type ComponentKind } from "./schemas.js";

/**
 * The UI components, served as MCP Apps resources
 * (https://modelcontextprotocol.io/docs/extensions/apps). ChatGPT and other
 * MCP Apps hosts render a component in a sandboxed iframe when a tool that
 * names it in `_meta` returns; clients without UI support ignore the `_meta`
 * keys and read the tool's text content as before.
 */

export const WIDGET_MIME_TYPE = "text/html;profile=mcp-app";

type WidgetUri = `ui://backwork/${string}.html`;

type WidgetDefinition = {
  /** Base of the resource URI; the served URI appends a hash of the HTML (see `WIDGETS`). */
  name: string;
  title: string;
  /** Shown to the model when the component loads, so it does not repeat what the component shows. */
  description: string;
  invoking: string;
  invoked: string;
};

const WIDGET_DEFINITIONS: Record<ComponentKind, WidgetDefinition> = {
  coverage_card: {
    name: "coverage-card",
    title: "Coverage result card",
    description:
      "Shows each policy that lists the requested codes: payer, policy title and number, effective date, each code's disposition and whether the document lists it or it was inferred from the policy title, and a link to the policy.",
    invoking: "Checking coverage…",
    invoked: "Coverage checked",
  },
  prior_auth_checklist: {
    name: "prior-auth-checklist",
    title: "Prior authorization checklist",
    description:
      "Shows the prior-authorization determination, the codes that require it, the documentation to gather, known gaps including codes inferred from a policy title, and citations.",
    invoking: "Researching prior authorization…",
    invoked: "Prior authorization researched",
  },
  policy_research: {
    name: "policy-research",
    title: "Policy research card",
    description:
      "Shows the policy research result: a comparison table of the codes across Medicare contractors (MACs), a policy search result list, one policy's summary with criteria excerpts and codes, matching coverage criteria, recent policy changes, or the MAC jurisdictions, with links to the policies.",
    invoking: "Researching policies…",
    invoked: "Policies researched",
  },
};

const STYLES = `
:root{color-scheme:light dark;--bw-text:var(--color-text-primary,#0d0d0d);--bw-muted:var(--color-text-secondary,#5d5d5d);--bw-border:var(--color-border-primary,rgba(13,13,13,.12));--bw-surface:var(--color-background-secondary,rgba(13,13,13,.03));--bw-link:#0b5cad;--bw-flag:#8a4b00;
--b-covered-bg:#e6f4ea;--b-covered:#0f5b26;--b-denied-bg:#fde8e8;--b-denied:#9b1c1c;--b-pa-bg:#fff1dc;--b-pa:#7a4100;--b-conditional-bg:#e8f0fe;--b-conditional:#174ea6;--b-neutral-bg:rgba(13,13,13,.06);--b-neutral:#4a4a4a}
:root[data-theme=dark]{--bw-text:var(--color-text-primary,#ececec);--bw-muted:var(--color-text-secondary,#b4b4b4);--bw-border:var(--color-border-primary,rgba(255,255,255,.14));--bw-surface:var(--color-background-secondary,rgba(255,255,255,.04));--bw-link:#8ab4f8;--bw-flag:#ffc46b;
--b-covered-bg:rgba(52,168,83,.2);--b-covered:#9be0b0;--b-denied-bg:rgba(240,82,82,.2);--b-denied:#f8b4b4;--b-pa-bg:rgba(255,170,0,.18);--b-pa:#ffd28a;--b-conditional-bg:rgba(66,133,244,.22);--b-conditional:#b3cdfb;--b-neutral-bg:rgba(255,255,255,.1);--b-neutral:#d0d0d0}
@media (prefers-color-scheme:dark){:root:not([data-theme]){--bw-text:var(--color-text-primary,#ececec);--bw-muted:var(--color-text-secondary,#b4b4b4);--bw-border:var(--color-border-primary,rgba(255,255,255,.14));--bw-surface:var(--color-background-secondary,rgba(255,255,255,.04));--bw-link:#8ab4f8;--bw-flag:#ffc46b;
--b-covered-bg:rgba(52,168,83,.2);--b-covered:#9be0b0;--b-denied-bg:rgba(240,82,82,.2);--b-denied:#f8b4b4;--b-pa-bg:rgba(255,170,0,.18);--b-pa:#ffd28a;--b-conditional-bg:rgba(66,133,244,.22);--b-conditional:#b3cdfb;--b-neutral-bg:rgba(255,255,255,.1);--b-neutral:#d0d0d0}}
*{box-sizing:border-box}
html,body{margin:0;min-height:0;background:transparent;color:var(--bw-text);font:14px/1.45 var(--font-sans,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif)}
.card{padding:12px 14px;display:flex;flex-direction:column;gap:10px}
#root:empty{display:none}
.items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.items>li{border-top:1px solid var(--bw-border);padding:8px 0;display:flex;flex-direction:column;gap:2px}
.items>li:first-child{border-top:0;padding-top:0}
.row{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px}
.excerpt{font-size:13px}
header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 10px}
h2{font-size:15px;font-weight:600;margin:0}
h3{font-size:14px;font-weight:600;margin:0 0 4px}
p{margin:0}
.muted{color:var(--bw-muted);font-size:13px}
.block{display:block}
.eyebrow{color:var(--bw-muted);font-size:12px;margin-bottom:2px}
.reason{color:var(--bw-text)}
.policy{border-top:1px solid var(--bw-border);padding-top:10px}
.codes{list-style:none;margin:8px 0;padding:0;display:flex;flex-direction:column;gap:4px}
.codes li{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-weight:600}
.badge,.pill,.tag{display:inline-block;border-radius:999px;padding:1px 8px;font-size:12px;font-weight:600;white-space:nowrap}
.pill{padding:2px 10px}
.covered{background:var(--b-covered-bg);color:var(--b-covered)}
.denied{background:var(--b-denied-bg);color:var(--b-denied)}
.pa{background:var(--b-pa-bg);color:var(--b-pa)}
.conditional{background:var(--b-conditional-bg);color:var(--b-conditional)}
.neutral,.tag{background:var(--b-neutral-bg);color:var(--b-neutral)}
.source{font-size:12px;color:var(--bw-muted)}
.source.flagged{color:var(--bw-flag);font-weight:600}
.source.flagged::before{content:"⚠ "}
.link{color:var(--bw-link);font-weight:600;text-decoration:none}
.link:hover{text-decoration:underline}
a:focus-visible,.table-wrap:focus-visible{outline:2px solid var(--bw-link);outline-offset:2px;border-radius:4px}
section h3{margin-top:2px}
.list{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px}
.checklist{list-style:none;padding-left:0}
.checklist li{display:flex;gap:8px;align-items:flex-start}
.box{flex:none;width:14px;height:14px;margin-top:3px;border:1.5px solid var(--bw-muted);border-radius:3px}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid var(--bw-border)}
thead th{font-weight:600;background:var(--bw-surface)}
td .badge{margin-bottom:2px}
.totals th,.totals td{border-bottom:0}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;

/** Keeps inlined code from closing its own script element. */
function inlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, "<\\/$1");
}

/** The complete HTML document for a component: styles and script inline, no external requests. */
export function widgetHtml(kind: ComponentKind): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${WIDGET_DEFINITIONS[kind].title}</title>
<style>${STYLES}</style>
</head>
<body>
<div id="root" aria-live="polite"></div>
<script>${inlineScript(`(${widgetRuntime.toString()})(${JSON.stringify(kind)}, ${JSON.stringify(COMPONENT_VIEWS[kind])}, ${renderWidget.toString()});`)}</script>
</body>
</html>`;
}

/**
 * Hosts cache a component by URI, so each URI ends in a hash of the HTML it
 * serves: any change to the markup, styles or renderer ships under a new URI.
 */
export const WIDGETS = Object.fromEntries(
  (Object.keys(WIDGET_DEFINITIONS) as ComponentKind[]).map((kind) => {
    const definition = WIDGET_DEFINITIONS[kind];
    const hash = createHash("sha256").update(widgetHtml(kind)).digest("hex").slice(0, 12);
    const uri: WidgetUri = `ui://backwork/${definition.name}-${hash}.html`;
    return [kind, { ...definition, uri }];
  }),
) as Record<ComponentKind, WidgetDefinition & { uri: WidgetUri }>;

/** Resource `_meta`: the components load nothing from the network, so every CSP allowlist is empty. */
function resourceMeta(kind: ComponentKind): Record<string, unknown> {
  return {
    ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
    // ChatGPT compatibility aliases (https://developers.openai.com/plugins/reference#component-resource-_meta-fields).
    // The domain is set only through the ChatGPT key because `ui.domain` is host-specific.
    "openai/widgetDescription": WIDGETS[kind].description,
    "openai/widgetPrefersBorder": true,
    "openai/widgetDomain": "https://backworkhealth.com",
    "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
  };
}

export function registerWidgetResources(server: McpServer): void {
  for (const kind of Object.keys(WIDGETS) as ComponentKind[]) {
    const widget = WIDGETS[kind];
    server.registerResource(
      `backwork-${kind.replace(/_/g, "-")}`,
      widget.uri,
      { title: widget.title, description: widget.description, mimeType: WIDGET_MIME_TYPE, _meta: resourceMeta(kind) },
      async () => ({
        contents: [{ uri: widget.uri, mimeType: WIDGET_MIME_TYPE, text: widgetHtml(kind), _meta: resourceMeta(kind) }],
      }),
    );
  }
}

/** Tool descriptor `_meta` that links a tool to its component. */
export function widgetToolMeta(kind: ComponentKind): Record<string, unknown> {
  const widget = WIDGETS[kind];
  return {
    ui: { resourceUri: widget.uri },
    "openai/outputTemplate": widget.uri,
    "openai/toolInvocation/invoking": widget.invoking,
    "openai/toolInvocation/invoked": widget.invoked,
  };
}

/** The tool's outputSchema entry for the component's view model. */
/** The tool's outputSchema entry: any view its component renders, or none (the component then collapses). */
export function widgetOutputSchema(kind: ComponentKind): z.ZodTypeAny {
  const [first, second, ...rest]: z.ZodTypeAny[] = COMPONENT_VIEWS[kind].map((view) => VIEW_SCHEMAS[view]);
  return (second ? z.union([first, second, ...rest]) : first).optional();
}
