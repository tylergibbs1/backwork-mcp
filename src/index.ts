#!/usr/bin/env node

import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Configuration
const BACKWORK_API_BASE = process.env.BACKWORK_API_BASE || "https://backworkhealth.com/api/v1";
const requestApiKey = new AsyncLocalStorage<string | undefined>();
const requestToolName = new AsyncLocalStorage<string | undefined>();
const args = process.argv.slice(2);
const shouldShowHelp = args.includes("--help") || args.includes("-h");
const transportMode = (readOption("transport") || process.env.BACKWORK_MCP_TRANSPORT || (args.includes("--http") ? "http" : "stdio")).toLowerCase();
const httpPath = normalizePath(readOption("path") || process.env.BACKWORK_MCP_PATH || "/mcp");
const httpHost = readOption("host") || process.env.BACKWORK_MCP_HOST || "127.0.0.1";
const httpPort = Number(readOption("port") || process.env.BACKWORK_MCP_PORT || process.env.PORT || "3000");
const allowEnvKeyForHttp = args.includes("--allow-env-key") || process.env.BACKWORK_MCP_ALLOW_ENV_KEY === "true";
const allowedOrigins = parseAllowedList(process.env.BACKWORK_MCP_ALLOWED_ORIGINS || process.env.BACKWORK_MCP_ALLOW_ORIGIN);
const allowedHosts = parseAllowedList(process.env.BACKWORK_MCP_ALLOWED_HOSTS || process.env.BACKWORK_MCP_ALLOW_HOST);
const oauthAuthorizationServers = parseDelimitedList(
  process.env.BACKWORK_MCP_OAUTH_AUTHORIZATION_SERVERS || process.env.BACKWORK_MCP_OAUTH_AUTHORIZATION_SERVER,
);
const httpAuthMode = normalizeAuthMode(readOption("auth") || process.env.BACKWORK_MCP_AUTH_MODE, oauthAuthorizationServers.length > 0);
const oauthScopes = parseDelimitedList(process.env.BACKWORK_MCP_OAUTH_SCOPES || "backwork:mcp");
const oauthRequiredScopes = parseDelimitedList(process.env.BACKWORK_MCP_OAUTH_REQUIRED_SCOPES);
const oauthIntrospectionUrl = process.env.BACKWORK_MCP_OAUTH_INTROSPECTION_URL;
const oauthIntrospectionClientId = process.env.BACKWORK_MCP_OAUTH_INTROSPECTION_CLIENT_ID;
const oauthIntrospectionClientSecret = process.env.BACKWORK_MCP_OAUTH_INTROSPECTION_CLIENT_SECRET;
const oauthIntrospectionBearerToken = process.env.BACKWORK_MCP_OAUTH_INTROSPECTION_TOKEN;
const oauthApiKeyClaim = process.env.BACKWORK_MCP_OAUTH_API_KEY_CLAIM;
const oauthExpectedAudiences = parseDelimitedList(process.env.BACKWORK_MCP_OAUTH_EXPECTED_AUDIENCE);
const oauthResourceOverride = process.env.BACKWORK_MCP_OAUTH_RESOURCE;
const publicUrlOverride = process.env.BACKWORK_MCP_PUBLIC_URL;

type AuthenticatedIncomingMessage = IncomingMessage & { auth?: AuthInfo };
type BackworkToolInputSchema = z.ZodRawShape;
type BackworkToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: BackworkToolInputSchema;
  outputSchema?: BackworkToolInputSchema;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
};
type BackworkToolHandler = (args: any, extra: unknown) => CallToolResult | Promise<CallToolResult>;
type RegisterBackworkTool = (name: string, config: BackworkToolConfig, handler: BackworkToolHandler) => void;
type ResponseFormat = "markdown" | "json";
type HttpAuthMode = "api-key" | "oauth" | "dual";
type HttpAuthContext = {
  backworkCredential: string;
  authInfo: AuthInfo;
};

const responseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Output format: 'markdown' for readable text or 'json' for machine-readable structuredContent.");

const backworkToolOutputSchema = {
  data: z.unknown().optional().describe("Structured data returned by the Backwork API when available."),
  meta: z.unknown().optional().describe("Response metadata such as pagination when available."),
  message: z.string().describe("Human-readable result, status, or empty-result message."),
};

const mutatingTools = new Set([
  "prior_auth_research",
  "compliance_review",
  "webhook_management",
]);

const destructiveTools = new Set(["webhook_management"]);

const toolTitles: Record<string, string> = {
  coverage_lookup: "Coverage Lookup",
  policy_research: "Policy Research",
  claim_validation: "Claim Validation",
  prior_auth_research: "Prior Authorization Research",
  drug_formulary_research: "Drug Formulary Research",
  compliance_review: "Compliance Review",
  webhook_management: "Webhook Management",
  system_health: "System Health",
};

const includeSchema = z.union([z.string(), z.array(z.string())]).optional();

class BackworkApiError extends Error {
  status: number;
  code?: string;
  hint?: string;
  details?: unknown;
  requestId?: string;
  upgradeTo?: string;
  requiredPlan?: string;

  constructor(params: {
    status: number;
    message: string;
    code?: string;
    hint?: string;
    details?: unknown;
    requestId?: string;
    upgradeTo?: string;
    requiredPlan?: string;
  }) {
    super(params.message);
    this.name = "BackworkApiError";
    this.status = params.status;
    this.code = params.code;
    this.hint = params.hint;
    this.details = params.details;
    this.requestId = params.requestId;
    this.upgradeTo = params.upgradeTo;
    this.requiredPlan = params.requiredPlan;
  }
}

class HttpAuthError extends Error {
  status: number;
  code: string;
  requiredScopes?: string[];

  constructor(status: number, code: string, message: string, requiredScopes?: string[]) {
    super(message);
    this.name = "HttpAuthError";
    this.status = status;
    this.code = code;
    this.requiredScopes = requiredScopes;
  }
}

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function parseDelimitedList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeAuthMode(value: string | undefined, oauthConfigured: boolean): HttpAuthMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "api-key" || normalized === "oauth" || normalized === "dual") return normalized;
  return oauthConfigured ? "dual" : "api-key";
}

function printHelp(): void {
  console.error(`Backwork MCP Server

Usage:
  backwork-mcp                         Start stdio transport
  backwork-mcp --http                  Start Streamable HTTP transport on /mcp

Options:
  --transport stdio|http             Transport mode (default: stdio)
  --http                             Shortcut for --transport http
  --host 127.0.0.1                   HTTP host (default: 127.0.0.1)
  --port 3000                        HTTP port (default: 3000 or PORT)
  --path /mcp                        HTTP MCP endpoint path (default: /mcp)
  --auth api-key|oauth|dual          HTTP bearer auth mode (default: api-key, or dual when OAuth is configured)
  --allow-env-key                    Allow HTTP requests to use BACKWORK_API_KEY when no bearer token is sent

Authentication:
  stdio requires BACKWORK_API_KEY in the server environment.
  http expects Authorization: Bearer on each MCP request.
  OAuth discovery is enabled when BACKWORK_MCP_OAUTH_AUTHORIZATION_SERVERS is set.
`);
}

function resolveBackworkApiKey(): string {
  const apiKey = requestApiKey.getStore() || process.env.BACKWORK_API_KEY;
  if (!apiKey) {
    throw new Error("Backwork API key missing. Set BACKWORK_API_KEY for stdio, or send Authorization: Bearer <key> for HTTP.");
  }
  return apiKey;
}

function parseAllowedList(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((origin) => origin.trim().toLowerCase())
      .filter(Boolean)
  );
}

function normalizeHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const host = value.trim().toLowerCase();
  if (!host) return undefined;
  if (host.startsWith("[")) {
    return host.slice(1, host.indexOf("]"));
  }
  return host.split(":")[0];
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isPrivateHost(host: string): boolean {
  return (
    isLoopbackHost(host) ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

function isAllowedHost(req: IncomingMessage): boolean {
  const requestHost = normalizeHost(req.headers.host);
  if (!requestHost) return false;

  if (allowedHosts.has(requestHost)) return true;

  const vercelUrlHost = normalizeHost(process.env.VERCEL_URL);
  if (vercelUrlHost && requestHost === vercelUrlHost) return true;

  const publicHost = normalizeHost(process.env.BACKWORK_MCP_PUBLIC_HOST);
  if (publicHost && requestHost === publicHost) return true;

  const configuredHost = normalizeHost(httpHost);
  if (configuredHost && configuredHost !== "0.0.0.0" && requestHost === configuredHost) return true;

  return isPrivateHost(requestHost) && (!configuredHost || configuredHost === "0.0.0.0" || isPrivateHost(configuredHost));
}

function isAllowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;

  if (allowedOrigins.has(origin.toLowerCase())) return true;

  try {
    const parsed = new URL(origin);
    const requestHost = normalizeHost(req.headers.host);
    return isLoopbackHost(parsed.hostname.toLowerCase()) && Boolean(requestHost && isLoopbackHost(requestHost));
  } catch {
    return false;
  }
}

function responseOrigin(req: IncomingMessage): string {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(req)) return origin;
  return allowedOrigins.values().next().value || "null";
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requestOrigin(req: IncomingMessage): string {
  if (publicUrlOverride) return new URL(publicUrlOverride).origin;

  const forwardedProto = firstHeader(req.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeader(req.headers["x-forwarded-host"]);
  const proto = forwardedProto?.split(",")[0]?.trim() || (isPrivateHost(normalizeHost(req.headers.host) || "") ? "http" : "https");
  const host = forwardedHost?.split(",")[0]?.trim() || req.headers.host || `${httpHost}:${httpPort}`;
  return `${proto}://${host}`;
}

function mcpResourceUrl(req: IncomingMessage): string {
  if (oauthResourceOverride) return oauthResourceOverride;
  return new URL(httpPath, requestOrigin(req)).toString();
}

function oauthProtectedResourceMetadataUrl(req: IncomingMessage): string {
  return new URL("/.well-known/oauth-protected-resource", requestOrigin(req)).toString();
}

function isOAuthConfigured(): boolean {
  return oauthAuthorizationServers.length > 0;
}

function isOAuthProtectedResourceMetadataPath(pathname: string): boolean {
  return pathname === "/.well-known/oauth-protected-resource" || pathname === `/.well-known/oauth-protected-resource${httpPath}`;
}

function quoteAuthValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function bearerChallenge(req: IncomingMessage, error?: HttpAuthError): string {
  const parts = [`realm=${quoteAuthValue("Backwork MCP")}`];
  if (error?.code) parts.push(`error=${quoteAuthValue(error.code)}`);
  if (error?.message) parts.push(`error_description=${quoteAuthValue(error.message)}`);
  if (isOAuthConfigured()) {
    parts.push(`resource_metadata=${quoteAuthValue(oauthProtectedResourceMetadataUrl(req))}`);
    const scopes = error?.requiredScopes?.length ? error.requiredScopes : oauthScopes;
    if (scopes.length > 0) parts.push(`scope=${quoteAuthValue(scopes.join(" "))}`);
  }
  return `Bearer ${parts.join(", ")}`;
}

function buildProtectedResourceMetadata(req: IncomingMessage): Record<string, unknown> {
  return {
    resource: mcpResourceUrl(req),
    resource_name: "Backwork MCP",
    authorization_servers: oauthAuthorizationServers,
    bearer_methods_supported: ["header"],
    scopes_supported: oauthScopes,
  };
}

// Helper function for making Backwork API requests
async function backworkRequest<T>(
  endpoint: string,
  options: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    params?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<T> {
  const { method = "GET", params, body, headers: extraHeaders } = options;

  // Build URL with query params
  const url = new URL(`${BACKWORK_API_BASE}${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.append(key, String(value));
      }
    });
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolveBackworkApiKey()}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Backwork-Client": "mcp",
    ...extraHeaders,
  };
  const toolName = requestToolName.getStore();
  if (toolName && !headers["X-Backwork-MCP-Tool"]) {
    headers["X-Backwork-MCP-Tool"] = `backwork_${toolName}`;
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : { success: true, data: null };
  } catch {
    const preview = text.trim().slice(0, 300);
    data = response.ok
      ? { success: true, data: text }
      : {
          error: {
            message: preview ? `API returned non-JSON response: ${preview}` : `API returned HTTP ${response.status} with an empty response body`,
          },
        };
  }

  if (!response.ok) {
    throw new BackworkApiError({
      status: response.status,
      code: data.error?.code,
      message: data.error?.message || `API error: ${response.status}`,
      hint: data.error?.hint,
      details: data.error?.details,
      requestId: data.meta?.request_id,
      upgradeTo: data.error?.upgrade_to,
      requiredPlan: data.error?.required_plan,
    });
  }

  return data as T;
}

// Format helpers for clean output
function cleanText(value: unknown, max = 500): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}...`;
}

function humanize(value: unknown): string {
  if (value === null || value === undefined || value === "") return "unknown";
  return String(value);
}

function isTruthyRequirement(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return false;
  const text = String(value).trim().toLowerCase();
  return Boolean(text) && !["-", "0", "false", "n", "no", "none", "not required", "not_required", "na", "n/a"].includes(text);
}

function formatCurrency(value: unknown): string | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return null;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(numeric);
}

function formatNumber(value: unknown): string | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return null;
  return new Intl.NumberFormat("en-US").format(numeric);
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>);
  return [];
}

function normalizeInclude(value: string | string[] | undefined, fallback?: string): string | undefined {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean).join(",");
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function truncateList<T>(items: T[] | undefined, limit: number): { shown: T[]; remaining: number; total: number } {
  const safeItems = Array.isArray(items) ? items : [];
  return {
    shown: safeItems.slice(0, limit),
    remaining: Math.max(0, safeItems.length - limit),
    total: safeItems.length,
  };
}

function dispositionCounts(policies: any[]): string {
  const counts = new Map<string, number>();
  for (const policy of policies) {
    const dispositions = Array.isArray(policy.codes) && policy.codes.length > 0
      ? policy.codes.map((code: any) => code.disposition)
      : [policy.disposition];
    for (const disposition of dispositions.filter(Boolean)) {
      counts.set(disposition, (counts.get(disposition) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([name, count]) => `${name}: ${count}`).join(", ") || "no dispositions";
}

function formatToolError(action: string, error: unknown): string {
  if (error instanceof BackworkApiError) {
    const details = error.details && typeof error.details === "object" ? (error.details as Record<string, unknown>) : {};
    const requiredScopes = asArray(details.required_scopes).map(String);
    const requiredPlan = details.required_plan || details.required_feature || error.requiredPlan || error.upgradeTo;

    if (
      error.status === 403 ||
      error.code === "AUTHZ_SCOPE_REQUIRED" ||
      error.code === "AUTH_SCOPE_INSUFFICIENT" ||
      requiredPlan
    ) {
      const requirements = [
        requiredScopes.length ? `scope ${requiredScopes.map((scope) => `"${scope}"`).join(" or ")}` : null,
        requiredPlan ? `plan/feature "${requiredPlan}"` : null,
      ].filter(Boolean);
      return [
        `Cannot ${action}: this API key is authenticated but is not authorized for that operation.`,
        requirements.length ? `Required: ${requirements.join("; ")}.` : "Required: a higher-scope key or plan entitlement.",
        "Use a key with the required scope/plan, upgrade the organization, or choose a read-only tool for this workflow.",
        error.requestId ? `Request ID: ${error.requestId}` : null,
      ].filter(Boolean).join("\n");
    }

    if (error.status === 401) {
      return `Cannot ${action}: the API key was missing, invalid, revoked, or suspended.${error.requestId ? `\nRequest ID: ${error.requestId}` : ""}`;
    }

    return [
      `Error ${action}: ${error.message}`,
      error.hint ? `Hint: ${error.hint}` : null,
      error.code ? `Code: ${error.code}` : null,
      error.requestId ? `Request ID: ${error.requestId}` : null,
    ].filter(Boolean).join("\n");
  }

  return `Error ${action}: ${error instanceof Error ? error.message : String(error)}`;
}

function formatCode(code: any): string {
  const lines: string[] = [];
  lines.push(`Code: ${code.code} (${code.code_system})`);
  const description = code.description || code.long_description || code.short_description || code.display || code.name;
  lines.push(
    `Description: ${
      description
        ? cleanText(description, 300)
        : code.code_system === "CPT"
          ? "Omitted for CPT licensing; use the code, RVU fields, and source-backed policies below."
          : "Not returned by API"
    }`,
  );
  if (code.short_description && code.short_description !== description) lines.push(`Short: ${cleanText(code.short_description, 160)}`);
  if (code.category) lines.push(`Category: ${code.category}`);
  if (code.is_active !== undefined) lines.push(`Active: ${code.is_active ? "Yes" : "No"}`);

  if (code.rvu) {
    lines.push("\nRVU Data:");
    if (code.rvu.work_rvu) lines.push(`  Work RVU: ${code.rvu.work_rvu}`);
    if (code.rvu.total_rvu_facility) lines.push(`  Total RVU (Facility): ${code.rvu.total_rvu_facility}`);
    if (code.rvu.total_rvu_nonfacility) lines.push(`  Total RVU (Non-Facility): ${code.rvu.total_rvu_nonfacility}`);
    if (code.rvu.facility_price) lines.push(`  Facility Price: $${code.rvu.facility_price}`);
    if (code.rvu.non_facility_price) lines.push(`  Non-Facility Price: $${code.rvu.non_facility_price}`);
    if (code.rvu.global_days) lines.push(`  Global Days: ${code.rvu.global_days}`);
  }

  if (code.policies && code.policies.length > 0) {
    const policies = code.policies as any[];
    const { shown, remaining, total } = truncateList(policies, 8);
    lines.push(`\nRelated Policies: ${total} found (${dispositionCounts(policies)})`);
    lines.push("  Note: policy matches are code-list evidence and may include broader procedure families.");
    shown.forEach((p: any) => {
      lines.push(`  - ${p.policy_id}: ${cleanText(p.title, 140)}`);
      lines.push(`    Type: ${p.policy_type || "unknown"}, Disposition: ${p.disposition || "unknown"}`);
      if (p.jurisdiction) lines.push(`    Jurisdiction: ${p.jurisdiction}`);
      if (p.source_url) lines.push(`    Source: ${p.source_url}`);
    });
    if (remaining > 0) lines.push(`  ... ${remaining} more policies omitted. Use backwork_policy_research for focused evidence.`);
  }

  if (code.suggestions && code.suggestions.length > 0) {
    lines.push("\nSuggested Codes:");
    code.suggestions.slice(0, 5).forEach((s: any) => {
      lines.push(`  - ${s.code} (${s.code_system}): ${s.description || "No description"}`);
      lines.push(`    Match: ${s.match_type}, Score: ${(s.score * 100).toFixed(0)}%`);
    });
  }

  return lines.join("\n");
}

function formatPolicy(policy: any, detailed = false): string {
  const lines: string[] = [];
  lines.push(`Policy: ${policy.policy_id} - ${cleanText(policy.title, 180)}`);
  lines.push(`Type: ${policy.policy_type} | Status: ${policy.status}`);
  if (policy.jurisdiction) lines.push(`Jurisdiction: ${policy.jurisdiction}`);
  if (policy.effective_date) lines.push(`Effective: ${policy.effective_date}`);
  if (policy.retire_date) lines.push(`Retired: ${policy.retire_date}`);
  if (policy.source_url) lines.push(`Source: ${policy.source_url}`);

  if (detailed) {
    if (policy.summary) lines.push(`\nSummary: ${cleanText(policy.summary, 700)}`);
    else if (policy.description) lines.push(`\nDescription: ${cleanText(policy.description, 700)}`);

    if (policy.mac) {
      lines.push(`\nMAC: ${policy.mac.name} (${policy.mac.jurisdiction_name})`);
      if (policy.mac.states) lines.push(`States: ${policy.mac.states.join(", ")}`);
    }

    if (policy.sections) {
      if (policy.sections.indications) {
        lines.push(`\n--- Indications ---\n${cleanText(policy.sections.indications, 700)}`);
      }
      if (policy.sections.limitations) {
        lines.push(`\n--- Limitations ---\n${cleanText(policy.sections.limitations, 700)}`);
      }
      if (policy.sections.documentation) {
        lines.push(`\n--- Documentation Requirements ---\n${cleanText(policy.sections.documentation, 700)}`);
      }
    }

    if (policy.criteria && Object.keys(policy.criteria).length > 0) {
      lines.push("\n--- Coverage Criteria ---");
      Object.entries(policy.criteria).forEach(([section, blocks]: [string, any]) => {
        const criteriaBlocks = Array.isArray(blocks) ? blocks : [];
        lines.push(`\n[${section.toUpperCase()}]`);
        criteriaBlocks.slice(0, 2).forEach((block: any) => {
          lines.push(`  - ${cleanText(block.text, 240)}`);
          if (block.tags?.length) lines.push(`    Tags: ${block.tags.join(", ")}`);
        });
        if (criteriaBlocks.length > 2) lines.push(`  ... and ${criteriaBlocks.length - 2} more criteria`);
      });
    }

    if (policy.codes && Object.keys(policy.codes).length > 0) {
      lines.push("\n--- Associated Codes ---");
      Object.entries(policy.codes).forEach(([system, codes]: [string, any]) => {
        const codeList = Array.isArray(codes) ? codes : [];
        lines.push(`\n[${system}] (${codeList.length} codes)`);
        codeList.slice(0, 8).forEach((c: any) => {
          lines.push(`  - ${c.code}: ${c.display || "No description"} [${c.disposition}]`);
        });
        if (codeList.length > 8) lines.push(`  ... and ${codeList.length - 8} more codes`);
      });
    }
  }

  return lines.join("\n");
}

function formatPriorAuth(result: any): string {
  const lines: string[] = [];

  // Main determination
  lines.push(`Prior Authorization Required: ${result.pa_required ? "YES" : "NO"}`);
  lines.push(`Confidence: ${result.confidence.toUpperCase()}`);
  lines.push(`Reason: ${result.reason}`);

  // MAC info
  if (result.mac) {
    lines.push(`\nMAC: ${result.mac.name} (${result.mac.jurisdiction})`);
    if (result.mac.states) lines.push(`States: ${result.mac.states.join(", ")}`);
  }

  // Matched policies
  if (result.matched_policies?.length > 0) {
    const { shown, remaining, total } = truncateList(result.matched_policies, 6);
    lines.push(`\n--- Matched Policies (${total}) ---`);
    shown.forEach((p: any) => {
      lines.push(`\n${p.policy_id}: ${p.title}`);
      lines.push(`Type: ${p.policy_type}${p.jurisdiction ? ` | Jurisdiction: ${p.jurisdiction}` : ""}`);
      if (p.source_url) lines.push(`Source: ${p.source_url}`);
      if (p.codes?.length > 0) {
        lines.push("Codes:");
        p.codes.slice(0, 5).forEach((c: any) => {
          lines.push(`  - ${c.code} (${c.code_system}): ${c.disposition}`);
        });
        if (p.codes.length > 5) lines.push(`  ... ${p.codes.length - 5} more codes omitted`);
      }
    });
    if (remaining > 0) {
      lines.push(
        `\n... ${remaining} more matched policies omitted. Use backwork_policy_research with action='get' and policy_id for full evidence.`,
      );
    }
  }

  // Documentation checklist
  if (result.documentation_checklist?.length > 0) {
    const { shown, remaining } = truncateList(result.documentation_checklist, 8);
    lines.push("\n--- Documentation Checklist ---");
    shown.forEach((item, i) => {
      lines.push(`${i + 1}. ${cleanText(item, 260)}`);
    });
    if (remaining > 0) lines.push(`... ${remaining} more documentation items omitted`);
  }

  // Criteria details
  if (result.criteria_details) {
    const cd = result.criteria_details;
    if (cd.indications?.length > 0) {
      lines.push("\n--- Indications ---");
      cd.indications.slice(0, 5).forEach((ind: any) => {
        lines.push(`- ${cleanText(ind.text, 220)}`);
      });
      if (cd.pagination?.indications?.total > 5) {
        lines.push(`... and ${cd.pagination.indications.total - 5} more indications`);
      }
    }

    if (cd.limitations?.length > 0) {
      lines.push("\n--- Limitations ---");
      cd.limitations.slice(0, 5).forEach((lim: any) => {
        lines.push(`- ${cleanText(lim.text, 220)}`);
      });
      if (cd.pagination?.limitations?.total > 5) {
        lines.push(`... and ${cd.pagination.limitations.total - 5} more limitations`);
      }
    }
  }

  return lines.join("\n");
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function titleizeToolName(name: string): string {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function toolAnnotations(name: string): ToolAnnotations {
  const readOnly = !mutatingTools.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: destructiveTools.has(name),
    idempotentHint: readOnly,
    openWorldHint: true,
  };
}

function withResponseFormatInput(inputSchema: BackworkToolInputSchema = {}): BackworkToolInputSchema {
  if ("response_format" in inputSchema) return inputSchema;
  return {
    ...inputSchema,
    response_format: responseFormatSchema,
  };
}

function textFromToolResult(result: CallToolResult): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function splitResponseFormat(args: unknown): { handlerArgs: unknown; responseFormat: ResponseFormat } {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { handlerArgs: args, responseFormat: "markdown" };
  }

  const { response_format, ...handlerArgs } = args as Record<string, unknown>;
  return {
    handlerArgs,
    responseFormat: response_format === "json" ? "json" : "markdown",
  };
}

function normalizeToolResult(result: CallToolResult, responseFormat: ResponseFormat): CallToolResult {
  const text = textFromToolResult(result);

  if (result.isError === true) {
    return {
      ...result,
      isError: true,
    };
  }

  const structuredContent = result.structuredContent ?? { message: text };
  return {
    ...result,
    content:
      responseFormat === "json"
        ? [
            {
              type: "text",
              text: formatJson(structuredContent),
            },
          ]
        : result.content,
    structuredContent,
  };
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { message },
    isError: true,
  };
}

function toolResult(message: string, data?: unknown, meta?: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: {
      ...(data !== undefined ? { data } : {}),
      ...(meta !== undefined ? { meta } : {}),
      message,
    },
  };
}

function toolError(message: string): CallToolResult {
  return errorResult(`Error: ${message}`);
}

function enhanceDescription(name: string, description: string | undefined): string {
  const baseDescription = description || `${titleizeToolName(name)} in the Backwork API.`;
  const responseFormatNote =
    "Supports optional response_format: 'markdown' (default) for readable text or 'json' for the returned structuredContent object.";
  return `${baseDescription}\n\n${responseFormatNote}`;
}

function enhanceToolConfig(name: string, config: BackworkToolConfig): BackworkToolConfig {
  const title = config.title || toolTitles[name] || titleizeToolName(name);
  return {
    ...config,
    title,
    description: enhanceDescription(name, config.description),
    inputSchema: withResponseFormatInput(config.inputSchema),
    outputSchema: config.outputSchema || backworkToolOutputSchema,
    annotations: config.annotations || toolAnnotations(name),
    _meta: config._meta,
  };
}

function wrapToolHandler(name: string, handler: BackworkToolHandler): BackworkToolHandler {
  return async (args: unknown, extra: unknown) => {
    const { handlerArgs, responseFormat } = splitResponseFormat(args);

    try {
      const result = await requestToolName.run(name, () => handler(handlerArgs, extra));
      return normalizeToolResult(result, responseFormat);
    } catch (error) {
      return errorResult(`Error running ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

function createBackworkToolRegistrar(server: McpServer): RegisterBackworkTool {
  return (name, config, handler) => {
    const prefixedName = `backwork_${name}`;
    const wrappedHandler = wrapToolHandler(name, handler);
    const primaryConfig = enhanceToolConfig(name, config);

    server.registerTool(prefixedName, primaryConfig, wrappedHandler);
  };
}

function formatBatchLookup(data: any): string {
  const results = data?.results ?? data;
  const entries = Array.isArray(results)
    ? results.map((value: any) => [value.code ?? "unknown", value] as const)
    : Object.entries(results ?? {});
  const { shown, remaining, total } = truncateList(entries, 20);
  const foundCount = entries.filter(([, value]: any) => value?.found !== false).length;
  const lines = [`Batch Code Lookup: ${foundCount}/${total} resolved`];

  for (const [requestedCode, value] of shown as Array<[string, any]>) {
    if (!value || value.found === false) {
      lines.push(`\n${requestedCode}: not found`);
      continue;
    }

    const description = value.description || value.long_description || value.short_description || value.display;
    lines.push(`\n${value.code ?? requestedCode} (${value.code_system ?? "unknown"})`);
    lines.push(
      `  Description: ${
        description
          ? cleanText(description, 220)
          : value.code_system === "CPT"
            ? "Omitted for CPT licensing"
            : "Not returned by API"
      }`,
    );
    if (value.rvu) {
      const facility = formatCurrency(value.rvu.facility_price);
      const nonFacility = formatCurrency(value.rvu.non_facility_price);
      const rvuParts = [
        value.rvu.work_rvu ? `work RVU ${value.rvu.work_rvu}` : null,
        facility ? `facility ${facility}` : null,
        nonFacility ? `non-facility ${nonFacility}` : null,
      ].filter(Boolean);
      if (rvuParts.length) lines.push(`  RVU: ${rvuParts.join(", ")}`);
    }
    const policies = Array.isArray(value.policies) ? value.policies : [];
    if (policies.length) {
      lines.push(`  Policies: ${policies.length} (${dispositionCounts(policies)})`);
      policies.slice(0, 3).forEach((policy: any) => {
        lines.push(`    - ${policy.policy_id}: ${cleanText(policy.title, 120)} [${policy.disposition ?? "unknown"}]`);
      });
      if (policies.length > 3) lines.push(`    ... ${policies.length - 3} more omitted`);
    }
  }

  if (remaining > 0) lines.push(`\nShowing ${shown.length} of ${total} codes. Submit a smaller batch for full per-code detail.`);
  return lines.join("\n");
}

function formatSpending(data: any): string {
  const entries = Object.entries(data ?? {});
  if (entries.length === 0) return "No spending records returned.";

  const lines = ["Medicaid Spending by Code"];
  for (const [code, record] of entries as Array<[string, any]>) {
    lines.push(`\n${code}`);
    const totalPaid = formatCurrency(record.total_paid);
    const totalClaims = formatNumber(record.total_claims);
    const beneficiaries = formatNumber(record.unique_beneficiaries ?? record.beneficiaries);
    if (totalPaid) lines.push(`  Total paid: ${totalPaid}`);
    if (totalClaims) lines.push(`  Claims: ${totalClaims}`);
    if (beneficiaries) lines.push(`  Beneficiaries: ${beneficiaries}`);

    const byYear = Array.isArray(record.by_year) ? record.by_year : [];
    if (byYear.length) {
      lines.push("  By year:");
      byYear.slice(0, 5).forEach((year: any) => {
        const yearPaid = formatCurrency(year.total_paid);
        const yearClaims = formatNumber(year.total_claims);
        lines.push(`    - ${year.year}: ${[yearPaid, yearClaims ? `${yearClaims} claims` : null].filter(Boolean).join(", ")}`);
      });
      if (byYear.length > 5) lines.push(`    ... ${byYear.length - 5} more years omitted`);
    }
  }
  return lines.join("\n");
}

function formatComplianceStats(data: any): string {
  const total = data?.total_changes ?? data?.total_changes_30d ?? data?.total ?? data?.changes_total;
  const acknowledged = data?.acknowledged_count ?? data?.acknowledged ?? data?.ack_count;
  const rate = data?.acknowledgment_rate ?? data?.ack_rate;
  const critical = data?.critical_unreviewed_count ?? data?.critical_unreviewed;
  const unreviewed = data?.unreviewed_count ?? data?.unreviewed;
  const lines = ["Compliance Statistics"];
  if (total !== undefined) lines.push(`Total changes: ${humanize(total)}`);
  if (acknowledged !== undefined) lines.push(`Acknowledged: ${humanize(acknowledged)}`);
  if (unreviewed !== undefined) lines.push(`Unreviewed: ${humanize(unreviewed)}`);
  if (rate !== undefined) {
    const percent = typeof rate === "number" ? rate : null;
    lines.push(`Acknowledgment rate: ${percent === null ? humanize(rate) : `${Math.round(percent)}%`}`);
  }
  if (critical !== undefined) lines.push(`Critical unreviewed: ${humanize(critical)}`);

  const keysShown = new Set([
    "total_changes",
    "total_changes_30d",
    "total",
    "changes_total",
    "acknowledged_count",
    "acknowledged",
    "ack_count",
    "unreviewed_count",
    "unreviewed",
    "acknowledgment_rate",
    "ack_rate",
    "critical_unreviewed_count",
    "critical_unreviewed",
  ]);
  const extra = Object.entries(data ?? {}).filter(([key]) => !keysShown.has(key));
  if (extra.length) {
    lines.push("\nOther fields:");
    extra.slice(0, 8).forEach(([key, value]) => lines.push(`- ${key}: ${typeof value === "object" ? JSON.stringify(value) : humanize(value)}`));
  }
  return lines.join("\n");
}

function formatComplianceChanges(data: any, meta?: any): string {
  const changes = Array.isArray(data) ? data : [];
  if (changes.length === 0) return "No unreviewed policy changes found.";

  const lines = [`Unreviewed Policy Changes: ${changes.length}`];
  changes.forEach((change: any, index: number) => {
    lines.push(`\n${index + 1}. ${change.policy_id}: ${cleanText(change.policy_title, 160)}`);
    lines.push(`   Change: ${change.change_type ?? "unknown"}${change.changed_at ? ` at ${change.changed_at}` : ""}`);
    if (change.policy_type || change.payer_name) {
      lines.push(`   Source: ${[change.policy_type, change.payer_name].filter(Boolean).join(" / ")}`);
    }
    if (change.change_summary) lines.push(`   Summary: ${cleanText(change.change_summary, 240)}`);
    if (change.diff_id !== undefined) lines.push(`   Diff ID: ${change.diff_id}`);
  });

  const pagination = meta?.pagination;
  if (pagination?.has_more) {
    lines.push(`\nMore changes are available. Use cursor: "${pagination.cursor ?? pagination.next_cursor}"`);
  }

  return lines.join("\n");
}

function formularyResults(data: any): any[] {
  return Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
}

function simplifyDrugQuery(query: string): string | undefined {
  const simplified = query
    .replace(/\b(prior authorization|prior auth|authorization|step therapy|quantity limits?|coverage|formulary|requirements?|pa)\b/gi, " ")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return simplified && simplified.toLowerCase() !== query.trim().toLowerCase() ? simplified : undefined;
}

function formatDrugFormulary(data: any, query: string, meta?: any): string {
  const results = formularyResults(data);
  const counts = data?.counts ?? data?.source_counts ?? meta?.counts;
  const lines = [`Drug Formulary Evidence for "${query}": ${results.length} result${results.length === 1 ? "" : "s"}`];
  if (counts && typeof counts === "object") {
    lines.push(`Source counts: ${Object.entries(counts).map(([source, count]) => `${source}: ${count}`).join(", ")}`);
  }

  results.slice(0, 10).forEach((record: any, index: number) => {
    const payer = record.payer || record.source || record.source_name || record.reporting_entity || "unknown payer";
    const drug = record.drug_name || record.name || record.brand_name || record.generic_name || record.ndc || "unknown drug";
    const tier = record.tier ?? record.formulary_tier;
    const status = record.coverage_status ?? record.status ?? record.covered;
    const requirements = record.requirements && typeof record.requirements === "object" ? record.requirements : {};
    const utilization = [
      isTruthyRequirement(record.prior_authorization ?? record.priorAuth ?? requirements.prior_authorization) ? "PA" : null,
      isTruthyRequirement(record.step_therapy ?? record.stepTherapy ?? requirements.step_therapy) ? "step therapy" : null,
      isTruthyRequirement(record.quantity_limit ?? record.quantityLimit ?? requirements.quantity_limit)
        ? "quantity limit"
        : null,
      isTruthyRequirement(record.specialty ?? requirements.specialty) ? "specialty" : null,
    ].filter(Boolean);

    lines.push(`\n${index + 1}. ${cleanText(drug, 140)} (${payer})`);
    if (status !== undefined && status !== null) lines.push(`   Coverage: ${humanize(status)}`);
    if (tier !== undefined && tier !== null) lines.push(`   Tier: ${humanize(tier)}`);
    if (utilization.length) lines.push(`   Utilization management: ${utilization.join(", ")}`);
    if (requirements.text) lines.push(`   Requirements: ${cleanText(requirements.text, 180)}`);
    const alternatives = [...asArray(record.alternatives), ...asArray(record.preferred_alternatives)]
      .map(String)
      .filter((item) => item && item !== "-" && item.toLowerCase() !== "none");
    if (alternatives.length) lines.push(`   Alternatives: ${alternatives.slice(0, 5).join(", ")}`);
    if (record.source_url) lines.push(`   Source: ${record.source_url}`);
  });

  if (results.length > 10) lines.push(`\nShowing 10 of ${results.length}. Use a lower limit or payer filter for focused evidence.`);
  return lines.join("\n");
}

function formatMutationResult(action: string, data: any): string {
  const lines = [`${action} succeeded.`];
  if (data?.id !== undefined) lines.push(`ID: ${data.id}`);
  if (data?.status) lines.push(`Status: ${data.status}`);
  if (data?.url) lines.push(`URL: ${data.url}`);
  if (data?.secret) {
    lines.push(`Secret: ${data.secret}`);
    lines.push("Store this secret now; the API only returns webhook secrets on creation.");
  }
  if (data?.acknowledged !== undefined) lines.push(`Acknowledged: ${data.acknowledged}`);
  if (data?.acknowledged_count !== undefined) lines.push(`Acknowledged count: ${data.acknowledged_count}`);
  if (data?.delivery?.status || data?.delivery_status) lines.push(`Delivery status: ${data.delivery?.status ?? data.delivery_status}`);
  if (Object.keys(data ?? {}).length === 0) lines.push("No additional data returned.");
  return lines.join("\n");
}

function formatWebhookList(data: any): string {
  const endpoints = Array.isArray(data) ? data : [];
  if (endpoints.length === 0) return "No webhook endpoints are configured for this organization.";
  const lines = [`Webhook Endpoints: ${endpoints.length}`];
  endpoints.slice(0, 20).forEach((endpoint: any) => {
    lines.push(`\n${endpoint.id}: ${endpoint.url}`);
    lines.push(`  Status: ${endpoint.status ?? "unknown"} | Events: ${(endpoint.events ?? []).join(", ") || "none"}`);
    if (endpoint.failure_count !== undefined) lines.push(`  Failure count: ${endpoint.failure_count}`);
    if (endpoint.created_at) lines.push(`  Created: ${endpoint.created_at}`);
  });
  if (endpoints.length > 20) lines.push(`\nShowing 20 of ${endpoints.length} endpoints.`);
  return lines.join("\n");
}

function formatClaimValidation(result: any): string {
  const lines: string[] = [];
  lines.push(`Coverage Status: ${result.coverage_status}`);
  const paRequired = result.prior_auth_required === true ? "YES" : result.prior_auth_required === false ? "NO" : "UNKNOWN";
  lines.push(`Prior Auth Required: ${paRequired}`);
  lines.push(`Denial Risk: ${result.denial_risk}`);
  lines.push(`Overall Risk: ${result.overall_risk}`);
  lines.push(`Confidence: ${result.confidence}`);

  if (result.documentation_requirements?.length > 0) {
    lines.push("\n--- Documentation Requirements ---");
    result.documentation_requirements.forEach((item: string) => lines.push(`- ${item}`));
  }

  if (result.known_gaps?.length > 0) {
    lines.push("\n--- Known Gaps ---");
    result.known_gaps.forEach((item: string) => lines.push(`- ${item}`));
  }

  if (result.issues?.length > 0) {
    lines.push("\n--- Issues ---");
    result.issues.forEach((item: string) => lines.push(`- ${item}`));
  }

  const matchedPolicies = result.matched_policies ?? [];
  if (matchedPolicies.length > 0) {
    lines.push("\n--- Matched Policies ---");
    matchedPolicies.slice(0, 5).forEach((policy: any) => {
      const jurisdiction = policy.jurisdiction ? ` (${policy.jurisdiction})` : "";
      lines.push(`- ${policy.policy_id}: ${policy.title}${jurisdiction}`);
    });
    if (matchedPolicies.length > 5) lines.push(`... and ${matchedPolicies.length - 5} more policies`);
  }

  if (result.codes?.length > 0) {
    lines.push("\n--- Code-Level Results ---");
    result.codes.forEach((code: any) => {
      const codePa = code.prior_auth_required === true ? "yes" : code.prior_auth_required === false ? "no" : "unknown";
      lines.push(`${code.code}: ${code.coverage_status}, PA: ${codePa}, risk: ${code.denial_risk}`);
      if (code.issues?.length) lines.push(`  Issues: ${code.issues.join("; ")}`);
    });
  }

  return lines.join("\n");
}

function formatResearch(result: any): string {
  const lines: string[] = [];
  lines.push(`Research ID: ${result.research_id}`);
  lines.push(`Status: ${result.status}`);
  if (result.created_at) lines.push(`Created: ${result.created_at}`);
  if (result.finished_at) lines.push(`Finished: ${result.finished_at}`);
  if (result.poll_url) lines.push(`Poll URL: ${result.poll_url}`);

  if (result.result?.determination) {
    const determination = result.result.determination;
    lines.push("\n--- Determination ---");
    lines.push(`PA Required: ${determination.pa_required ? "YES" : "NO"}`);
    lines.push(`Confidence: ${determination.confidence}`);
    if (determination.reasoning) lines.push(`Reasoning: ${determination.reasoning}`);
  }

  if (result.result?.documentation_requirements?.length) {
    lines.push("\n--- Documentation Requirements ---");
    result.result.documentation_requirements.forEach((item: string) => lines.push(`- ${item}`));
  }

  if (result.error) lines.push(`\nError: ${result.error}`);
  return lines.join("\n");
}

function registerWorkflowTools(registerTool: RegisterBackworkTool): void {
  registerTool(
    "coverage_lookup",
    {
      description: `Answer common coverage questions for procedure codes in one workflow.
Use this when a user asks whether codes are covered, whether prior authorization is required, what policies support the answer, or how coverage differs by jurisdiction.
This tool can combine code lookup, related policy evidence, Medicare prior-auth checks, claim-risk validation, jurisdiction comparison, and spending evidence so the agent does not need to chain endpoint-shaped tools.`,
      inputSchema: {
        procedure_codes: z.array(z.string()).min(1).max(50).describe("CPT/HCPCS procedure codes, e.g. ['76942'] or ['J0585', '64493']. Up to 50 are supported for code_details-only batch lookup; contextual modules are limited to 10 codes."),
        code_system: z
          .enum(["CPT", "HCPCS", "ICD10CM", "ICD10PCS", "NDC"])
          .optional()
          .describe("Optional code system hint for lookup, e.g. CPT or HCPCS"),
        code_include: z
          .array(z.enum(["rvu", "policies", "rates"]))
          .default(["rvu", "policies"])
          .describe("Code detail data to include when running code_details"),
        state: z.string().length(2).optional().describe("Two-letter patient state used to infer MAC jurisdiction, e.g. TX"),
        jurisdiction: z.string().max(10).optional().describe("Optional MAC jurisdiction code for policy filtering, e.g. JM or JH"),
        diagnosis_codes: z.array(z.string()).max(20).optional().describe("Diagnosis codes when claim-risk validation is needed"),
        payer: z.string().max(80).optional().describe("Payer name or policy source label for claim validation"),
        plan_type: z.enum(["commercial", "medicare_advantage", "medicaid", "traditional_medicare", "exchange"]).optional(),
        date_of_service: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date of service in YYYY-MM-DD format"),
        site_of_service: z.enum(["office", "outpatient_hospital", "asc", "inpatient", "home", "telehealth"]).optional(),
        compare_jurisdictions: z.array(z.string()).max(10).optional().describe("Jurisdictions to compare for regional coverage variation"),
        include: z
          .array(z.enum(["code_details", "prior_auth", "claim_risk", "jurisdiction_compare", "spending"]))
          .default(["code_details", "prior_auth"])
          .describe("Evidence modules to run. Defaults to code details and prior auth."),
      },
    },
    async ({ procedure_codes, code_system, code_include, state, jurisdiction, diagnosis_codes, payer, plan_type, date_of_service, site_of_service, compare_jurisdictions, include }) => {
      try {
        const requested = new Set(include as string[]);
        const contextualModules = ["prior_auth", "claim_risk", "jurisdiction_compare", "spending"].filter((module) => requested.has(module));
        if (procedure_codes.length > 10 && contextualModules.length > 0) {
          return toolError(
            `coverage_lookup supports up to 50 codes for code_details-only batch lookup. Limit procedure_codes to 10 when requesting ${contextualModules.join(", ")}.`,
          );
        }

        const data: Record<string, unknown> = {};
        const lines = [`Coverage Lookup for ${procedure_codes.join(", ")}`];
        const normalizedCodeInclude = normalizeInclude(code_include, "rvu,policies");

        if (requested.has("code_details")) {
          const endpoint = procedure_codes.length === 1 ? "/codes/lookup" : "/codes/batch";
          const result = await backworkRequest<any>(
            endpoint,
            procedure_codes.length === 1
              ? {
                  params: {
                    code: procedure_codes[0],
                    code_system,
                    jurisdiction,
                    include: normalizedCodeInclude,
                    fuzzy: "true",
                  },
                }
              : {
                  method: "POST",
                  body: {
                    codes: procedure_codes,
                    code_system,
                    include: normalizedCodeInclude,
                  },
                },
          );
          data.code_details = result.data;
          lines.push("\n--- Code Details ---");
          lines.push(procedure_codes.length === 1 ? formatCode(result.data) : formatBatchLookup(result.data));
        }

        if (requested.has("prior_auth")) {
          const result = await backworkRequest<any>("/prior-auth/check", {
            method: "POST",
            body: { procedure_codes, diagnosis_codes, payer, state },
          });
          data.prior_auth = result.data;
          lines.push("\n--- Prior Authorization ---");
          lines.push(formatPriorAuth(result.data));
        }

        if (requested.has("claim_risk")) {
          const result = await backworkRequest<any>("/claims/validate", {
            method: "POST",
            body: {
              procedure_codes,
              diagnosis_codes,
              payer,
              plan_type,
              state,
              date_of_service,
              site_of_service,
            },
          });
          data.claim_risk = result.data;
          lines.push("\n--- Claim Risk ---");
          lines.push(formatClaimValidation(result.data));
        }

        if (requested.has("jurisdiction_compare") || compare_jurisdictions?.length) {
          const result = await backworkRequest<any>("/policies/compare", {
            method: "POST",
            body: { procedure_codes, jurisdictions: compare_jurisdictions },
          });
          data.jurisdiction_compare = result.data;
          const comparison = Array.isArray(result.data?.comparison) ? result.data.comparison : [];
          const summary = result.data?.summary ?? {};
          lines.push("\n--- Jurisdiction Comparison ---");
          lines.push(`Jurisdictions analyzed: ${summary.total_jurisdictions ?? comparison.length}`);
          lines.push(`With coverage: ${summary.jurisdictions_with_coverage ?? "unknown"}`);
          lines.push(`Regional variation: ${summary.has_variation === undefined ? "unknown" : summary.has_variation ? "YES" : "NO"}`);
          if (comparison.length) {
            comparison.slice(0, 8).forEach((jur: any) => {
              lines.push(`- ${jur.jurisdiction}: ${jur.coverage_summary ? JSON.stringify(jur.coverage_summary) : "no summary"}`);
            });
          }
        }

        if (requested.has("spending")) {
          const result = await backworkRequest<any>("/spending/by-code", {
            params: procedure_codes.length === 1 ? { code: procedure_codes[0] } : { codes: procedure_codes.join(",") },
          });
          data.spending = result.data;
          lines.push("\n--- Spending ---");
          lines.push(formatSpending(result.data));
        }

        return toolResult(lines.join("\n"), data);
      } catch (error) {
        return errorResult(formatToolError("run coverage lookup", error));
      }
    },
  );

  registerTool(
    "policy_research",
    {
      description: `Research coverage policies and criteria.
Use this for policy search, fetching one policy by ID, searching extracted criteria, reviewing policy changes, or mapping state to MAC jurisdiction. This replaces several endpoint-shaped policy tools with one research workflow.`,
      inputSchema: {
        action: z.enum(["search", "get", "criteria", "changes", "jurisdictions"]).describe("Policy research action to perform"),
        query: z.string().max(500).optional().describe("Search text for policy or criteria research"),
        policy_id: z.string().max(80).optional().describe("Policy ID for action='get' or filtering changes"),
        policy_type: z.enum(["LCD", "Article", "NCD", "PayerPolicy", "Medical Policy", "Drug Policy"]).optional(),
        jurisdiction: z.string().max(10).optional(),
        payer: z.string().max(80).optional(),
        status: z.enum(["active", "retired", "all"]).default("active"),
        mode: z.enum(["keyword", "semantic"]).default("keyword"),
        section: z.enum(["indications", "limitations", "documentation", "frequency", "other"]).optional(),
        since: z.string().optional().describe("ISO 8601 timestamp for policy changes"),
        change_type: z.enum(["created", "updated", "retired", "codes_changed", "criteria_changed", "metadata_changed"]).optional(),
        include: includeSchema.describe("Extra policy data, e.g. ['criteria', 'codes']"),
        limit: z.number().int().min(1).max(50).default(10),
        cursor: z.string().optional(),
      },
    },
    async ({ action, query, policy_id, policy_type, jurisdiction, payer, status, mode, section, since, change_type, include, limit, cursor }) => {
      try {
        if (action === "search") {
          const result = await backworkRequest<any>("/policies", {
            params: { q: query, mode, policy_type, jurisdiction, payer, status, limit, cursor, include: normalizeInclude(include) },
          });
          if (!result.data?.length) return toolResult(`No policies found for "${query || "your search"}".`, result.data, result.meta);
          const lines = [`Found ${result.data.length} policies${result.meta?.pagination?.has_more ? " (more available)" : ""}:\n`];
          result.data.forEach((policy: any, i: number) => lines.push(`${i + 1}. ${formatPolicy(policy)}\n`));
          if (result.meta?.pagination?.cursor) lines.push(`More results available. Use cursor: "${result.meta.pagination.cursor}"`);
          return toolResult(lines.join("\n"), result.data, result.meta);
        }

        if (action === "get") {
          if (!policy_id) return toolError("policy_id is required when action='get'.");
          const result = await backworkRequest<any>(`/policies/${encodeURIComponent(policy_id)}`, {
            params: { include: normalizeInclude(include, "criteria,codes") },
          });
          return toolResult(formatPolicy(result.data, true), result.data, result.meta);
        }

        if (action === "criteria") {
          if (!query) return toolError("query is required when action='criteria'.");
          const result = await backworkRequest<any>("/coverage/criteria", {
            params: { q: query, section, policy_type, jurisdiction, limit, cursor },
          });
          if (!result.data?.length) return toolResult(`No criteria found for "${query}".`, result.data, result.meta);
          const lines = [`Found ${result.data.length} matching criteria:\n`];
          result.data.forEach((criteria: any, i: number) => {
            const id = criteria.policy_id ?? criteria.policy?.policy_id ?? "unknown policy";
            const title = criteria.policy_title ?? criteria.policy?.title ?? "Untitled policy";
            lines.push(`${i + 1}. [${criteria.section.toUpperCase()}] ${id}: ${cleanText(title, 140)}`);
            lines.push(`   ${cleanText(criteria.text, 320)}\n`);
          });
          if (result.meta?.pagination?.cursor) lines.push(`More results available. Use cursor: "${result.meta.pagination.cursor}"`);
          return toolResult(lines.join("\n"), result.data, result.meta);
        }

        if (action === "changes") {
          const result = await backworkRequest<any>("/policies/changes", {
            params: { since, policy_id, change_type, limit, cursor },
          });
          if (!result.data?.length) return toolResult("No policy changes found for the specified criteria.", result.data, result.meta);
          const lines = [`Found ${result.data.length} policy changes:\n`];
          result.data.forEach((change: any) => {
            lines.push(`[${change.change_type?.toUpperCase?.() ?? "CHANGE"}] ${change.policy_id}: ${change.policy_title}`);
            if (change.changed_at) lines.push(`  Date: ${change.changed_at}`);
            if (change.change_summary) lines.push(`  Summary: ${change.change_summary}`);
          });
          if (result.meta?.pagination?.cursor) lines.push(`More changes available. Use cursor: "${result.meta.pagination.cursor}"`);
          return toolResult(lines.join("\n"), result.data, result.meta);
        }

        const result = await backworkRequest<any>("/jurisdictions");
        const lines = [`MAC Jurisdictions (${result.data.length} total):\n`];
        result.data.forEach((jur: any) => {
          lines.push(`[${jur.jurisdiction_code}] ${jur.jurisdiction_name || ""}`);
          lines.push(`  MAC: ${jur.mac_name}${jur.mac_code ? ` (${jur.mac_code})` : ""}`);
          if (jur.states?.length) lines.push(`  States: ${jur.states.join(", ")}`);
          if (jur.website_url) lines.push(`  Website: ${jur.website_url}`);
          lines.push("");
        });
        return toolResult(lines.join("\n"), result.data, result.meta);
      } catch (error) {
        return errorResult(formatToolError("research policies", error));
      }
    },
  );

  registerTool(
    "claim_validation",
    {
      description: "Validate claim coverage, documentation requirements, denial risk, and optional policy-specific criteria in one workflow.",
      inputSchema: {
        procedure_codes: z.array(z.string()).min(1).max(10).describe("CPT/HCPCS procedure codes"),
        diagnosis_codes: z.array(z.string()).max(20).optional(),
        payer: z.string().optional().describe("Payer or policy source label"),
        plan_type: z.enum(["commercial", "medicare_advantage", "medicaid", "traditional_medicare", "exchange"]).optional(),
        line_of_business: z.string().optional(),
        modifiers: z.array(z.string()).max(5).optional(),
        state: z.string().length(2).optional(),
        date_of_service: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        site_of_service: z.enum(["office", "outpatient_hospital", "asc", "inpatient", "home", "telehealth"]).optional(),
        provider_specialty: z.string().optional(),
        age_category: z.enum(["pediatric", "adult", "medicare_age"]).optional(),
        sex_when_policy_relevant: z.enum(["female", "male", "other", "unknown"]).optional(),
        policy_id: z.string().optional().describe("Optional policy ID to evaluate against structured parameters"),
        coverage_parameters: z.record(z.unknown()).optional().describe("Policy criteria inputs when policy_id is supplied"),
        idempotency_key: z.string().optional(),
      },
    },
    async ({ idempotency_key, policy_id, coverage_parameters, ...body }) => {
      try {
        const data: Record<string, unknown> = {};
        const lines = ["Claim Validation"];
        const result = await backworkRequest<any>("/claims/validate", {
          method: "POST",
          body,
          headers: idempotency_key ? { "X-Idempotency-Key": idempotency_key } : undefined,
        });
        data.claim_validation = result.data;
        lines.push(formatClaimValidation(result.data));

        if (policy_id && coverage_parameters) {
          const evaluation = await backworkRequest<any>("/coverage/evaluate", {
            method: "POST",
            body: { policy_id, parameters: coverage_parameters },
          });
          data.coverage_evaluation = evaluation.data;
          lines.push("\n--- Policy Criteria Evaluation ---");
          lines.push(formatJson(evaluation.data));
        }

        return toolResult(lines.join("\n"), data);
      } catch (error) {
        return errorResult(formatToolError("validate claim", error));
      }
    },
  );

  registerTool(
    "prior_auth_research",
    {
      description: "Check, start, or poll payer prior-authorization research without exposing separate task-management tools.",
      inputSchema: {
        action: z.enum(["check", "start_research", "get_research"]).describe("Use check for immediate Medicare PA evidence, start_research for payer website research, get_research to poll a research_id"),
        procedure_codes: z.array(z.string()).min(1).max(10).optional(),
        research_id: z.string().optional(),
        payer: z.string().optional(),
        state: z.string().length(2).optional(),
        diagnosis_codes: z.array(z.string()).max(20).optional(),
        clinical_context: z.string().max(2000).optional(),
        sync: z.boolean().default(false),
      },
    },
    async ({ action, procedure_codes, research_id, ...body }) => {
      try {
        if (action === "get_research") {
          if (!research_id) return toolError("research_id is required when action='get_research'.");
          const result = await backworkRequest<any>(`/prior-auth/research/${encodeURIComponent(research_id)}`);
          return toolResult(formatResearch(result.data), result.data, result.meta);
        }

        if (!procedure_codes?.length) return toolError("procedure_codes is required for prior authorization checks and research.");

        if (action === "check") {
          const result = await backworkRequest<any>("/prior-auth/check", {
            method: "POST",
            body: { procedure_codes, diagnosis_codes: body.diagnosis_codes, payer: body.payer, state: body.state },
          });
          return toolResult(formatPriorAuth(result.data), result.data, result.meta);
        }

        const result = await backworkRequest<any>("/prior-auth/research", {
          method: "POST",
          body: { ...body, procedure_codes },
        });
        return toolResult(formatResearch(result.data), result.data, result.meta);
      } catch (error) {
        return errorResult(formatToolError("research prior auth", error));
      }
    },
  );

  registerTool(
    "drug_formulary_research",
    {
      description: "Search commercial pharmacy-benefit evidence from CVS Caremark, Express Scripts, and UnitedHealthcare / Optum Rx.",
      inputSchema: {
        query: z.string().min(2).max(200).describe("Drug, class, or formulary requirement to search for"),
        payer: z.enum(["all", "cvs_caremark", "express_scripts", "uhc"]).default("all"),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ query, payer, limit }) => {
      try {
        let result = await backworkRequest<any>("/drugs/formulary", { params: { q: query, payer, limit } });
        const fallbackQuery = formularyResults(result.data).length === 0 ? simplifyDrugQuery(query) : undefined;

        if (fallbackQuery) {
          const fallbackResult = await backworkRequest<any>("/drugs/formulary", { params: { q: fallbackQuery, payer, limit } });
          if (formularyResults(fallbackResult.data).length > 0) {
            result = {
              ...fallbackResult,
              data: fallbackResult.data,
              meta: {
                ...fallbackResult.meta,
                original_query: query,
                fallback_query: fallbackQuery,
              },
            };
            const message = [
              `No formulary evidence matched "${query}" exactly; showing results for "${fallbackQuery}".`,
              "",
              formatDrugFormulary(fallbackResult.data, fallbackQuery, fallbackResult.meta),
            ].join("\n");
            return toolResult(message, result.data, result.meta);
          }
        }

        return toolResult(formatDrugFormulary(result.data, query, result.meta), result.data, result.meta);
      } catch (error) {
        return errorResult(formatToolError("search drug formulary", error));
      }
    },
  );

  registerTool(
    "compliance_review",
    {
      description: "Review compliance dashboard state, list unreviewed policy changes, or acknowledge changes when explicitly requested.",
      inputSchema: {
        action: z.enum(["stats", "list_unreviewed", "acknowledge", "bulk_acknowledge"]),
        change_type: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(25),
        diff_id: z.number().int().optional(),
        diff_ids: z.array(z.number().int()).min(1).max(200).optional(),
        notes: z.string().max(500).optional(),
      },
    },
    async ({ action, change_type, cursor, limit, diff_id, diff_ids, notes }) => {
      try {
        if (action === "stats") {
          const result = await backworkRequest<any>("/compliance/stats");
          return toolResult(formatComplianceStats(result.data), result.data, result.meta);
        }
        if (action === "list_unreviewed") {
          const result = await backworkRequest<any>("/compliance/unreviewed", { params: { change_type, cursor, limit } });
          return toolResult(formatComplianceChanges(result.data, result.meta), result.data, result.meta);
        }
        if (action === "acknowledge") {
          if (diff_id === undefined) return toolError("diff_id is required when action='acknowledge'.");
          const result = await backworkRequest<any>("/compliance/ack", { method: "POST", body: { diff_id, notes } });
          return toolResult(formatMutationResult("Acknowledge policy change", result.data), result.data, result.meta);
        }
        if (!diff_ids?.length) return toolError("diff_ids is required when action='bulk_acknowledge'.");
        const result = await backworkRequest<any>("/compliance/ack/bulk", { method: "POST", body: { diff_ids, notes } });
        return toolResult(formatMutationResult("Bulk acknowledge policy changes", result.data), result.data, result.meta);
      } catch (error) {
        return errorResult(formatToolError("review compliance", error));
      }
    },
  );

  registerTool(
    "webhook_management",
    {
      description: "List, create, update, delete, or test webhook endpoints. Use only when the user is explicitly managing webhook configuration.",
      inputSchema: {
        action: z.enum(["list", "create", "update", "delete", "test"]),
        id: z.number().int().optional(),
        url: z.string().url().refine((value) => new URL(value).protocol === "https:", "Webhook URL must use HTTPS").optional(),
        events: z.array(z.string()).optional(),
        status: z.enum(["active", "paused"]).optional(),
      },
    },
    async ({ action, id, url, events, status }) => {
      try {
        if (action === "list") {
          const result = await backworkRequest<any>("/webhooks");
          return toolResult(formatWebhookList(result.data), result.data, result.meta);
        }
        if (action === "create") {
          if (!url || !events?.length) return toolError("url and at least one event are required when action='create'.");
          const result = await backworkRequest<any>("/webhooks", { method: "POST", body: { url, events } });
          return toolResult(formatMutationResult("Create webhook", result.data), result.data, result.meta);
        }
        if (id === undefined) return toolError("id is required when action is update, delete, or test.");
        if (action === "update") {
          const result = await backworkRequest<any>(`/webhooks/${id}`, { method: "PATCH", body: { url, events, status } });
          return toolResult(formatMutationResult("Update webhook", result.data), result.data, result.meta);
        }
        if (action === "delete") {
          const result = await backworkRequest<any>(`/webhooks/${id}`, { method: "DELETE" });
          return toolResult(formatMutationResult("Delete webhook", result.data), result.data, result.meta);
        }
        const result = await backworkRequest<any>(`/webhooks/${id}/test`, { method: "POST" });
        return toolResult(formatMutationResult("Test webhook", result.data), result.data, result.meta);
      } catch (error) {
        return errorResult(formatToolError("manage webhooks", error));
      }
    },
  );

  registerTool(
    "system_health",
    {
      description: "Check Backwork API health and dependency status. Use for diagnostics, not for coverage research.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await backworkRequest<any>("/health");
        return toolResult(formatJson(result.data), result.data, result.meta);
      } catch (error) {
        return errorResult(formatToolError("check health", error));
      }
    },
  );
}

function createBackworkMcpServer(): McpServer {
  const server = new McpServer({
    name: "backwork",
    version: "2.0.0",
  });
  const registerTool = createBackworkToolRegistrar(server);

  registerWorkflowTools(registerTool);

  return server;
}

function setHttpHeaders(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", responseOrigin(req));
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Vary", "Origin");
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  setHttpHeaders(req, res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function extractBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;

  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim();
}

function looksLikeBackworkApiKey(token: string): boolean {
  return /^bwk_(live|test)_[A-Za-z0-9_-]+$/.test(token);
}

function authInfoForApiKey(apiKey: string, clientId = "backwork-api-key"): AuthInfo {
  return {
    token: apiKey,
    clientId,
    scopes: [],
  };
}

function scopeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") return value.split(/[,\s]+/).map((scope) => scope.trim()).filter(Boolean);
  return [];
}

function claimValue(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, data);
}

function hasRequiredScopes(scopes: string[], requiredScopes: string[]): boolean {
  if (requiredScopes.length === 0) return true;
  const granted = new Set(scopes);
  return requiredScopes.every((scope) => granted.has(scope));
}

function audienceMatches(value: unknown, expected: string[]): boolean {
  if (expected.length === 0 || value === undefined) return true;
  const actual = Array.isArray(value) ? value.map(String) : [String(value)];
  return expected.some((audience) => actual.includes(audience));
}

async function introspectOAuthToken(token: string, req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!oauthIntrospectionUrl) {
    return {};
  }

  const body = new URLSearchParams({
    token,
    token_type_hint: "access_token",
    resource: mcpResourceUrl(req),
  });

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (oauthIntrospectionClientId && oauthIntrospectionClientSecret) {
    const credentials = Buffer.from(`${oauthIntrospectionClientId}:${oauthIntrospectionClientSecret}`).toString("base64");
    headers.Authorization = `Basic ${credentials}`;
  } else if (oauthIntrospectionBearerToken) {
    headers.Authorization = `Bearer ${oauthIntrospectionBearerToken}`;
  }

  let response: Response;
  try {
    response = await fetch(oauthIntrospectionUrl, { method: "POST", headers, body });
  } catch (error) {
    throw new HttpAuthError(503, "server_error", `OAuth introspection failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpAuthError(503, "server_error", "OAuth introspection returned a non-JSON response.");
  }

  if (!response.ok) {
    throw new HttpAuthError(response.status === 401 ? 401 : 503, "invalid_token", "OAuth introspection did not accept the access token.");
  }

  return data;
}

async function validateOAuthAccessToken(token: string, req: IncomingMessage): Promise<HttpAuthContext> {
  if (!isOAuthConfigured()) {
    throw new HttpAuthError(500, "server_error", "OAuth auth mode requires BACKWORK_MCP_OAUTH_AUTHORIZATION_SERVERS.");
  }

  const tokenInfo = await introspectOAuthToken(token, req);
  if (oauthIntrospectionUrl && tokenInfo.active !== true) {
    throw new HttpAuthError(401, "invalid_token", "The OAuth access token is inactive, expired, or invalid.");
  }

  const scopes = scopeList(tokenInfo.scope);
  if (!hasRequiredScopes(scopes, oauthRequiredScopes)) {
    throw new HttpAuthError(403, "insufficient_scope", "The OAuth access token is missing required scopes.", oauthRequiredScopes);
  }

  if (!audienceMatches(tokenInfo.aud, oauthExpectedAudiences)) {
    throw new HttpAuthError(401, "invalid_token", "The OAuth access token audience is not valid for this MCP server.");
  }

  const credentialFromClaim = oauthApiKeyClaim ? claimValue(tokenInfo, oauthApiKeyClaim) : undefined;
  if (oauthApiKeyClaim && typeof credentialFromClaim !== "string") {
    throw new HttpAuthError(401, "invalid_token", `OAuth token introspection did not include string claim "${oauthApiKeyClaim}".`);
  }

  const resource = new URL(mcpResourceUrl(req));
  return {
    backworkCredential: typeof credentialFromClaim === "string" ? credentialFromClaim : token,
    authInfo: {
      token,
      clientId: String(tokenInfo.client_id || tokenInfo.azp || tokenInfo.sub || "oauth-client"),
      scopes,
      expiresAt: typeof tokenInfo.exp === "number" ? tokenInfo.exp : undefined,
      resource,
      extra: {
        auth_mode: "oauth",
        subject: tokenInfo.sub,
        username: tokenInfo.username,
      },
    },
  };
}

async function resolveHttpAuth(req: IncomingMessage): Promise<HttpAuthContext | undefined> {
  const bearerToken = extractBearerToken(req);
  if (bearerToken) {
    if (httpAuthMode === "api-key" || (httpAuthMode === "dual" && looksLikeBackworkApiKey(bearerToken))) {
      return {
        backworkCredential: bearerToken,
        authInfo: authInfoForApiKey(bearerToken),
      };
    }

    return validateOAuthAccessToken(bearerToken, req);
  }

  if (!allowEnvKeyForHttp || !process.env.BACKWORK_API_KEY) return undefined;

  const requestHost = normalizeHost(req.headers.host);
  if (requestHost && isPrivateHost(httpHost) && isPrivateHost(requestHost)) {
    return {
      backworkCredential: process.env.BACKWORK_API_KEY,
      authInfo: authInfoForApiKey(process.env.BACKWORK_API_KEY, "backwork-env-api-key"),
    };
  }

  return undefined;
}

async function readRequestBody(req: IncomingMessage): Promise<unknown> {
  const requestWithBody = req as IncomingMessage & { body?: unknown };
  const contentType = Array.isArray(req.headers["content-type"]) ? req.headers["content-type"].join(",") : req.headers["content-type"] || "";
  if (requestWithBody.body !== undefined) {
    if (typeof requestWithBody.body === "string" && contentType.toLowerCase().includes("application/json")) {
      return JSON.parse(requestWithBody.body);
    }
    return requestWithBody.body;
  }
  if (req.method !== "POST") return undefined;

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  if (!rawBody.trim()) return undefined;

  if (!contentType.toLowerCase().includes("application/json")) return rawBody;

  return JSON.parse(rawBody);
}

function isInvalidJsonError(error: unknown): boolean {
  return error instanceof SyntaxError || (error instanceof Error && error.message.toLowerCase().includes("invalid json"));
}

function rejectUnsafeHttpRequest(req: IncomingMessage, res: ServerResponse): boolean {
  setHttpHeaders(req, res);

  if (req.method === "OPTIONS") {
    if (!isAllowedHost(req)) {
      sendJson(req, res, 421, {
        error: "host_not_allowed",
        message: "Configure BACKWORK_MCP_ALLOWED_HOSTS or BACKWORK_MCP_PUBLIC_HOST to allow this Host.",
      });
      return true;
    }

    if (!isAllowedOrigin(req)) {
      sendJson(req, res, 403, {
        error: "origin_not_allowed",
        message: "Configure BACKWORK_MCP_ALLOWED_ORIGINS to allow this Origin.",
      });
      return true;
    }

    res.writeHead(204);
    res.end();
    return true;
  }

  if (!isAllowedHost(req)) {
    sendJson(req, res, 421, {
      error: "host_not_allowed",
      message: "Configure BACKWORK_MCP_ALLOWED_HOSTS or BACKWORK_MCP_PUBLIC_HOST to allow this Host.",
    });
    return true;
  }

  if (!isAllowedOrigin(req)) {
    sendJson(req, res, 403, {
      error: "origin_not_allowed",
      message: "Configure BACKWORK_MCP_ALLOWED_ORIGINS to allow this Origin.",
    });
    return true;
  }

  return false;
}

export function handleHealthRequest(req: IncomingMessage, res: ServerResponse): void {
  if (rejectUnsafeHttpRequest(req, res)) return;

  if (req.method !== "GET") {
    sendJson(req, res, 405, {
      error: "method_not_allowed",
      message: "Use GET for the health endpoint.",
    });
    return;
  }

  sendJson(req, res, 200, {
    status: "ok",
    transport: "streamable-http",
    mcp_path: httpPath,
  });
}

export function handleRootRequest(req: IncomingMessage, res: ServerResponse): void {
  if (rejectUnsafeHttpRequest(req, res)) return;

  if (req.method !== "GET") {
    sendJson(req, res, 405, {
      error: "method_not_allowed",
      message: "Use GET for this endpoint.",
    });
    return;
  }

  sendJson(req, res, 200, {
    name: "backwork-mcp",
    transport: "streamable-http",
    mcp_url: httpPath,
    authentication: isOAuthConfigured()
      ? "Authenticate with OAuth and send Authorization: Bearer <access_token> with each MCP request."
      : "Send Authorization: Bearer <BACKWORK_API_KEY> with each MCP request.",
    oauth_protected_resource_metadata: isOAuthConfigured() ? oauthProtectedResourceMetadataUrl(req) : undefined,
  });
}

export function handleOAuthProtectedResourceMetadataRequest(req: IncomingMessage, res: ServerResponse): void {
  if (rejectUnsafeHttpRequest(req, res)) return;

  if (req.method !== "GET") {
    sendJson(req, res, 405, {
      error: "method_not_allowed",
      message: "Use GET for OAuth protected resource metadata.",
    });
    return;
  }

  if (!isOAuthConfigured()) {
    sendJson(req, res, 404, {
      error: "oauth_not_configured",
      message: "Set BACKWORK_MCP_OAUTH_AUTHORIZATION_SERVERS to enable OAuth protected resource metadata.",
    });
    return;
  }

  sendJson(req, res, 200, buildProtectedResourceMetadata(req));
}

export async function handleMcpEndpointRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (rejectUnsafeHttpRequest(req, res)) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    sendJson(req, res, 405, {
      error: "method_not_allowed",
      message: "Use POST for stateless Streamable HTTP MCP requests.",
    });
    return;
  }

  let authContext: HttpAuthContext | undefined;
  try {
    authContext = await resolveHttpAuth(req);
  } catch (error) {
    if (!(error instanceof HttpAuthError)) throw error;
    res.setHeader("WWW-Authenticate", bearerChallenge(req, error));
    sendJson(req, res, error.status, {
      error: error.code,
      message: error.message,
      ...(error.requiredScopes?.length ? { required_scopes: error.requiredScopes } : {}),
    });
    return;
  }

  if (!authContext) {
    res.setHeader("WWW-Authenticate", bearerChallenge(req));
    sendJson(req, res, 401, {
      error: "missing_bearer_token",
      message: isOAuthConfigured()
        ? "Authenticate with OAuth and send Authorization: Bearer <access_token> with the MCP request."
        : "Send Authorization: Bearer <BACKWORK_API_KEY> with the MCP request.",
    });
    return;
  }

  const authenticatedReq = req as AuthenticatedIncomingMessage;
  authenticatedReq.auth = authContext.authInfo;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
  });

  try {
    const body = await readRequestBody(authenticatedReq);
    const server = createBackworkMcpServer();
    await server.connect(transport);
    await requestApiKey.run(authContext.backworkCredential, () => transport.handleRequest(authenticatedReq, res, body));
  } catch (error) {
    if (!isInvalidJsonError(error)) {
      console.error("Error handling MCP HTTP request:", error);
    }
    if (!res.headersSent) {
      if (isInvalidJsonError(error)) {
        sendJson(req, res, 400, {
          error: "invalid_json",
          message: "MCP request body must be valid JSON.",
        });
      } else {
        sendJson(req, res, 500, {
          error: "mcp_request_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      res.end();
    }
  }
}

export async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (isOAuthProtectedResourceMetadataPath(url.pathname)) {
    handleOAuthProtectedResourceMetadataRequest(req, res);
    return;
  }

  if (url.pathname === "/health") {
    handleHealthRequest(req, res);
    return;
  }

  if (url.pathname === "/") {
    handleRootRequest(req, res);
    return;
  }

  if (url.pathname !== httpPath) {
    if (rejectUnsafeHttpRequest(req, res)) return;
    sendJson(req, res, 404, {
      error: "not_found",
      message: `Use ${httpPath} for MCP Streamable HTTP requests.`,
    });
    return;
  }

  await handleMcpEndpointRequest(req, res);
}

async function startStdioServer(): Promise<void> {
  if (!process.env.BACKWORK_API_KEY) {
    console.error("Error: BACKWORK_API_KEY environment variable is required for stdio transport");
    console.error("Set it with: export BACKWORK_API_KEY=bwk_live_YOUR_KEY_HERE");
    process.exit(1);
  }

  const server = createBackworkMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Backwork MCP Server running on stdio");
}

async function startHttpServer(): Promise<void> {
  if (!Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535) {
    throw new Error(`Invalid HTTP port: ${httpPort}`);
  }

  const httpServer = createServer(handleHttpRequest);

  httpServer.listen(httpPort, httpHost, () => {
    console.error(`Backwork MCP Server running on Streamable HTTP: http://${httpHost}:${httpPort}${httpPath}`);
  });
}

// Main entry point
async function main() {
  if (shouldShowHelp) {
    printHelp();
    return;
  }

  if (transportMode === "http") {
    await startHttpServer();
    return;
  }

  if (transportMode !== "stdio") {
    throw new Error(`Unknown transport "${transportMode}". Use "stdio" or "http".`);
  }

  await startStdioServer();
}

function realEntrypointUrl(path: string): string {
  try {
    return pathToFileURL(realpathSync(path)).href;
  } catch {
    return pathToFileURL(path).href;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
const realEntrypoint = process.argv[1] ? realEntrypointUrl(process.argv[1]) : undefined;
if (entrypoint === import.meta.url || realEntrypoint === import.meta.url) {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
  });
}
