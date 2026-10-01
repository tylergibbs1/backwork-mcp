import type { WidgetKind, WidgetView } from "./schemas.js";

/**
 * Code that runs inside the component iframe. Both functions are inlined into
 * the HTML with Function.prototype.toString (see ./templates.ts), so neither
 * may reference anything outside its own body; test/widgets.test.mjs runs the
 * inlined page to catch a stray reference.
 */

declare global {
  interface Window {
    openai?: {
      theme?: string;
      toolOutput?: unknown;
      openExternal?: (options: { href: string }) => unknown;
    };
  }
}

/** Renders a view model to HTML. Every string from the view is escaped; only http(s) links are emitted. */
export function renderWidget(view: WidgetView): string {
  const esc = (value: unknown): string =>
    String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
  const safeUrl = (link: { url: string } | null): string | null => (link && /^https?:\/\//i.test(link.url) ? link.url : null);
  const join = (parts: Array<string | null | undefined | false>, separator = " · "): string => parts.filter(Boolean).join(separator);

  const DISPOSITIONS: Record<string, [string, string]> = {
    covered: ["Covered", "covered"],
    not_covered: ["Not covered", "denied"],
    requires_pa: ["Prior auth", "pa"],
    conditional: ["Conditional", "conditional"],
  };
  const badge = (disposition: string | null): string => {
    if (!disposition) return '<span class="badge neutral">No policy</span>';
    const [label, tone] = DISPOSITIONS[disposition] ?? [disposition.replace(/_/g, " "), "neutral"];
    return `<span class="badge ${tone}">${esc(label)}</span>`;
  };
  const sourceLabel = (source: string | null, label: string | null): string =>
    label ? `<span class="source${source === "document" ? "" : " flagged"}">${esc(label)}</span>` : "";
  type Linked = { policy_id: string; title: string; link: { kind: "backwork" | "source"; url: string } | null };
  /** `text` defaults to "Open policy" for a Backwork page and "Open source document" for a payer or CMS document. */
  const link = (policy: Linked, text?: string): string => {
    const href = safeUrl(policy.link);
    if (!href || !policy.link) return "";
    const where = policy.link.kind === "backwork" ? "on Backwork" : "source document";
    const label = `Open ${policy.policy_id} ${where}: ${policy.title}`;
    const shown = text ?? (policy.link.kind === "backwork" ? "Open policy" : "Open source document");
    return `<a class="link" href="${esc(href)}" data-external target="_blank" rel="noopener noreferrer" aria-label="${esc(label)}">${esc(shown)}</a>`;
  };
  const section = (title: string, body: string): string => (body ? `<section><h3>${esc(title)}</h3>${body}</section>` : "");
  const list = (items: string[], ordered = false): string =>
    items.length ? `<${ordered ? "ol" : "ul"} class="list">${items.map((item) => `<li>${item}</li>`).join("")}</${ordered ? "ol" : "ul"}>` : "";
  const more = (count: number, noun: string): string => (count > 0 ? `<p class="muted">${count} more ${noun} not shown. Ask for a narrower search to see them.</p>` : "");

  if (view.kind === "coverage_card") {
    const pa = view.prior_auth;
    const paPill = pa
      ? `<span class="pill ${pa.required === true ? "pa" : pa.required === false ? "covered" : "neutral"}">${
          pa.required === true ? "Prior auth required" : pa.required === false ? "No prior auth" : "Prior auth unknown"
        }${pa.confidence ? ` · ${esc(pa.confidence)} confidence` : ""}</span>`
      : "";
    const policies = view.policies.map((policy) => {
      const codes = policy.codes
        .map((code) => `<li><span class="code">${esc(code.code)}</span>${badge(code.disposition)}${sourceLabel(code.source, code.source_label)}</li>`)
        .join("");
      return `<section class="policy">
<p class="eyebrow">${esc(join([policy.payer, policy.jurisdiction, policy.policy_type]))}</p>
<h3>${esc(policy.title)}</h3>
<p class="muted">${esc(join([`Policy ${policy.policy_id}`, policy.effective_date && `Effective ${policy.effective_date}`]))}</p>
<ul class="codes">${codes}</ul>${more(policy.codes_omitted, "codes")}
${link(policy)}
</section>`;
    });
    return `<article class="card" aria-label="Backwork coverage result">
<header><h2>Coverage for ${esc(view.codes_requested.join(", "))}</h2>${paPill}</header>
${pa?.reason ? `<p class="reason">${esc(pa.reason)}</p>` : ""}
${policies.join("") || '<p class="muted">No Backwork policy lists these codes.</p>'}
${more(view.policies_omitted, "policies")}
</article>`;
  }

  if (view.kind === "prior_auth_checklist") {
    const status =
      view.status !== "complete"
        ? `<span class="pill neutral">Research ${esc(view.status)}</span>`
        : `<span class="pill ${view.pa_required === true ? "pa" : view.pa_required === false ? "covered" : "neutral"}">${
            view.pa_required === true ? "Prior auth required" : view.pa_required === false ? "Prior auth not required" : "Prior auth unknown"
          }</span>`;
    const subtitle = join([view.confidence && `${view.confidence} confidence`, view.mac && join([view.mac.name, view.mac.jurisdiction], " ")]);
    const codes = view.codes_requiring_pa
      .map((code) => `<li><span class="code">${esc(code.code)}</span><span class="muted">${esc(code.policy_id)}</span>${sourceLabel(code.source, code.source_label)}</li>`)
      .join("");
    const documentation = view.documentation.map(
      (item) => `<span class="box" aria-hidden="true"></span>${esc(item.text)}${item.mandatory === true ? ' <span class="tag">Required</span>' : ""}`,
    );
    const gaps = [
      ...view.known_gaps.map((gap) => esc(gap)),
      ...view.inferred_codes.map(
        (code) =>
          `<span class="code">${esc(code.code)}</span> <span class="source flagged">Inferred from policy title</span> ${esc(code.policy_id)} does not list this code in the document; confirm it before submitting.`,
      ),
    ];
    const citations = view.citations.map(
      (policy) =>
        `${link(policy, policy.title) || esc(policy.title)} <span class="muted">${esc(
          join([policy.policy_id !== policy.title && policy.policy_id, policy.payer, policy.effective_date && `Effective ${policy.effective_date}`]),
        )}</span>`,
    );
    const pending =
      view.status === "pending" || view.status === "running"
        ? `<p class="muted">Research ${esc(view.research_id ?? "")} is still ${esc(view.status)}. Ask again in a minute to see the result.</p>`
        : "";
    return `<article class="card" aria-label="Backwork prior authorization checklist">
<header><h2>Prior authorization checklist</h2>${status}</header>
${subtitle ? `<p class="muted">${esc(subtitle)}</p>` : ""}
${view.reason ? `<p class="reason">${esc(view.reason)}</p>` : ""}${pending}
${section("Codes requiring prior auth", codes ? `<ul class="codes">${codes}</ul>` : "")}
${section("Documentation needed", documentation.length ? `<ul class="list checklist">${documentation.map((item) => `<li>${item}</li>`).join("")}</ul>` : "")}
${section("Known gaps", list(gaps))}
${section("Citations", list(citations, true))}
</article>`;
  }

  const head = view.columns
    .map((column) => `<th scope="col"><span class="code">${esc(column.jurisdiction)}</span>${column.payer ? `<span class="muted block">${esc(column.payer)}</span>` : ""}</th>`)
    .join("");
  const rows = view.rows
    .map(
      (row) =>
        `<tr><th scope="row" class="code">${esc(row.code)}</th>${row.cells
          .map(
            (cell) =>
              `<td>${badge(cell.disposition)}${cell.policy_id ? `<span class="muted block">${esc(cell.policy_id)}${cell.more ? ` +${cell.more}` : ""}</span>` : ""}${
                cell.source === "document" ? "" : sourceLabel(cell.source, cell.source_label)
              }</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  const totals = view.columns
    .map((column) => {
      const counts = join(
        [
          column.coverage.covered > 0 && `${column.coverage.covered} covered`,
          column.coverage.requires_pa > 0 && `${column.coverage.requires_pa} prior auth`,
          column.coverage.conditional > 0 && `${column.coverage.conditional} conditional`,
          column.coverage.not_covered > 0 && `${column.coverage.not_covered} not covered`,
        ],
        ", ",
      );
      return `<td class="muted">${esc(counts || "No policies")}</td>`;
    })
    .join("");
  const variation =
    view.has_variation === null ? "" : `<span class="pill ${view.has_variation ? "pa" : "covered"}">${view.has_variation ? "Coverage varies" : "Consistent coverage"}</span>`;
  const policyLinks = view.policies
    .filter((policy) => safeUrl(policy.link))
    .slice(0, 6)
    .map((policy) => `${link(policy, policy.policy_id)} <span class="muted">${esc(policy.title)}</span>`);
  const notes = [
    view.unresolved_jurisdictions.length ? `No active contractor for ${esc(view.unresolved_jurisdictions.join(", "))}.` : "",
    view.columns_omitted ? `${view.columns_omitted} more jurisdictions not shown; compare fewer at a time to see them.` : "",
  ].filter(Boolean);
  return `<article class="card" aria-label="Backwork policy comparison">
<header><h2>Coverage across Medicare contractors</h2>${variation}</header>
${
  view.columns.length
    ? `<div class="table-wrap" role="region" aria-label="Comparison table" tabindex="0"><table>
<caption class="sr-only">Disposition of ${esc(view.codes.join(", "))} in each jurisdiction</caption>
<thead><tr><th scope="col">Code</th>${head}</tr></thead>
<tbody>${rows}<tr class="totals"><th scope="row">Policies</th>${totals}</tr></tbody>
</table></div>`
    : '<p class="muted">No jurisdictions matched this comparison.</p>'
}
${notes.map((note) => `<p class="muted">${note}</p>`).join("")}
${section("Policies", list(policyLinks))}
</article>`;
}

/**
 * Connects the page to its host and renders each tool result. It speaks the
 * MCP Apps bridge (`ui/*` JSON-RPC over postMessage) and also reads ChatGPT's
 * `window.openai` globals, so the component renders in either host.
 */
export function widgetRuntime(kind: WidgetKind, render: (view: unknown) => string): void {
  const root = document.getElementById("root") as HTMLElement;
  const html = document.documentElement;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: unknown) => void }>();
  let nextId = 1;
  let initialized = false;
  let rendered: string | null = null;

  const post = (message: Record<string, unknown>) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      post({ id, method, params });
      setTimeout(() => pending.delete(id) && reject(new Error(`${method} timed out`)), 10000);
    });

  const reportSize = () => {
    if (!initialized) return;
    const box = html.getBoundingClientRect();
    post({ method: "ui/notifications/size-changed", params: { width: Math.ceil(box.width), height: Math.ceil(box.height) } });
  };

  const show = (structuredContent: unknown) => {
    const view = structuredContent && typeof structuredContent === "object" ? (structuredContent as { widget?: { kind?: unknown } }).widget : undefined;
    const next = view && view.kind === kind ? render(view) : "";
    if (next === rendered) return;
    rendered = next;
    root.innerHTML = next;
    reportSize();
  };

  const applyTheme = (theme: unknown) => {
    if (theme === "light" || theme === "dark") html.dataset.theme = theme;
  };
  const applyHostContext = (context: any) => {
    if (!context || typeof context !== "object") return;
    applyTheme(context.theme);
    if (typeof context.locale === "string") html.lang = context.locale;
    const variables = context.styles?.variables;
    if (variables && typeof variables === "object") {
      for (const [name, value] of Object.entries(variables)) {
        if (name.startsWith("--") && typeof value === "string") html.style.setProperty(name, value);
      }
    }
  };

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === undefined && pending.has(message.id)) {
      const waiter = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error) waiter.reject(message.error);
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-result") show(message.params?.structuredContent);
    else if (message.method === "ui/notifications/host-context-changed") applyHostContext(message.params);
    else if ((message.method === "ui/resource-teardown" || message.method === "ping") && message.id !== undefined) post({ id: message.id, result: {} });
  });

  // ChatGPT also exposes the result and theme as window.openai globals.
  const openai = window.openai;
  if (openai) {
    applyTheme(openai.theme);
    if (openai.toolOutput) show(openai.toolOutput);
  }
  window.addEventListener("openai:set_globals", (event: Event) => {
    const globals = (event as CustomEvent).detail?.globals ?? {};
    applyTheme(globals.theme);
    if (globals.toolOutput) show(globals.toolOutput);
  });

  document.addEventListener("click", (event: MouseEvent) => {
    const anchor = event.target instanceof Element ? event.target.closest("a[data-external]") : null;
    if (!(anchor instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    const url = anchor.href;
    const fallback = () => {
      if (typeof window.openai?.openExternal === "function") window.openai.openExternal({ href: url });
      else window.open(url, "_blank", "noopener,noreferrer");
    };
    if (initialized) request("ui/open-link", { url }).catch(fallback);
    else fallback();
  });

  if (typeof ResizeObserver === "function") new ResizeObserver(reportSize).observe(document.body);

  request("ui/initialize", {
    appInfo: { name: `backwork-${kind}`, version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
    protocolVersion: "2026-01-26",
  })
    .then((result) => {
      initialized = true;
      applyHostContext(result?.hostContext);
      post({ method: "ui/notifications/initialized", params: {} });
      reportSize();
    })
    .catch(() => {
      // Not an MCP Apps host; window.openai (if present) still drives rendering.
    });
}
