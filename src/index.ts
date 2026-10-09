#!/usr/bin/env node

import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  BACKWORK_OPERATIONS,
  operationExposure,
  operationPath,
  type Exposure,
  type ExposureContext,
  type OperationId,
  type OperationRequest,
  type Scope,
} from "./api-operations.js";
import { BackworkApiError, formatApiFailure, parseApiFailure } from "./api-errors.js";
import { codeGroundingNote, codeSourceNote, parseCodeSources, type SourcedCode } from "./code-source.js";
import { limitCodeDetailsToPayer, otherPayersNote, resolveRequestedPayer } from "./payer-scope.js";
import { parsePriorAuthCheck, parseResearchDetermination, verdictAnswer } from "./prior-auth-verdict.js";
import { extractProvenance, formatProvenance, provenanceSchema } from "./provenance.js";
import { projectEnvelope } from "./projection.js";
import { formatSourceAccuracy, parseSourceCheck } from "./source-check.js";
import { TOOL_OPERATIONS } from "./tool-operations.js";
import type { ComponentKind, WidgetView } from "./widgets/schemas.js";
import { registerWidgetResources, widgetOutputSchema, widgetToolMeta } from "./widgets/templates.js";
import {
  buildCoverageCard,
  buildCriteriaList,
  buildJurisdictionList,
  buildPolicyChanges,
  buildPolicyComparison,
  buildPolicyDetail,
  buildPolicyList,
  buildPriorAuthChecklist,
  buildResearchChecklist,
} from "./widgets/views.js";

// Configuration
const BACKWORK_API_BASE = process.env.BACKWORK_API_BASE || "https://backworkhealth.com/api/v1";
const requestApiKey = new AsyncLocalStorage<string | undefined>();
const requestToolName = new AsyncLocalStorage<string | undefined>();
const requestExposure = new AsyncLocalStorage<ExposureContext>();
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
// Kept equal to package.json and server.json; test/registry-manifest.test.mjs checks it.
export const SERVER_VERSION = "2.1.4";
const exposeUnavailableTools = process.env.BACKWORK_MCP_EXPOSE_UNAVAILABLE_TOOLS === "true";

type AuthenticatedIncomingMessage = IncomingMessage & { auth?: AuthInfo };
type BackworkToolInputSchema = z.ZodRawShape;
/**
 * MCP tool hints, stated per tool. Every hint is required so none falls back to
 * a default that does not match the tool; the registrar checks them against the
 * scopes and methods of the operations the tool calls.
 */
type ToolHints = {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  /** true when the tool reaches beyond Backwork's own catalog and org data, e.g. by searching public websites. */
  readonly openWorldHint: boolean;
};
type BackworkToolConfig = {
  /** The API operations each action (or evidence module) calls; drives production availability. */
  operations: Record<string, readonly OperationId[]>;
  title?: string;
  description: string;
  inputSchema?: BackworkToolInputSchema;
  outputSchema?: BackworkToolInputSchema;
  annotations: ToolHints;
  _meta?: Record<string, unknown>;
  /**
   * The UI component that renders this tool's `structuredContent.widget` in MCP
   * Apps hosts such as ChatGPT. Hosts load it for every call of the tool, so it
   * must render every view the tool's actions return.
   */
  widget?: ComponentKind;
};
type BackworkToolHandler = (args: any, extra: unknown) => CallToolResult | Promise<CallToolResult>;
type RegisterBackworkTool = (name: string, config: BackworkToolConfig, handler: BackworkToolHandler) => void;
type ResponseFormat = "markdown" | "json";
type HttpAuthMode = "api-key" | "oauth" | "dual";
type HttpAuthContext = {
  backworkCredential: string;
  authInfo: AuthInfo;
  /** What the credential may do: a Backwork API key carries its own scopes; an OAuth grant is read-only unless it includes `write`. */
  access: Scope;
};

const responseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Output format: 'markdown' for readable text or 'json' for machine-readable structuredContent.");

const backworkToolOutputSchema = {
  data: z.unknown().optional().describe("Structured data returned by the Backwork API when available."),
  meta: z.unknown().optional().describe("Response metadata such as pagination when available."),
  message: z.string().describe("Human-readable result, status, or empty-result message."),
  provenance: provenanceSchema.optional(),
};

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

const exposureReasons: Record<Exclude<Exposure, "offered">, string> = {
  "unavailable-in-production": "is not available on the production Backwork API yet",
  "needs-write-access": "needs write access, which this connection's read-only OAuth grant does not include",
};

class OperationUnavailableError extends Error {
  constructor(readonly operationId: OperationId, reason: Exclude<Exposure, "offered">) {
    super(`${BACKWORK_OPERATIONS[operationId].method} ${BACKWORK_OPERATIONS[operationId].path} ${exposureReasons[reason]}.`);
    this.name = "OperationUnavailableError";
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

/**
 * The only way tools reach the Backwork API. The request type comes from the
 * operation catalog, so a tool can send only fields the catalog declares; the
 * response is projected to the catalog's `reads` and `metaReads`, so a tool
 * sees only listed fields. The catalog is checked against the published
 * OpenAPI document in CI.
 */
// The projected envelope is typed `any`; the catalog's read lists, checked
// against the OpenAPI document, pin the fields it can hold.
async function backworkRequest<Id extends OperationId>(
  operationId: Id,
  request: OperationRequest<Id> = {} as OperationRequest<Id>,
): Promise<any> {
  const context = requestExposure.getStore();
  if (!context) throw new Error(`${operationId} was called outside a registered tool handler`);
  const exposure = operationExposure(BACKWORK_OPERATIONS[operationId], context);
  if (exposure !== "offered") throw new OperationUnavailableError(operationId, exposure);
  const operation = BACKWORK_OPERATIONS[operationId];
  const method = operation.method;
  const params: Record<string, unknown> | undefined = request.query;
  const body: unknown = request.body;
  const extraHeaders: Record<string, string> | undefined = request.headers as Record<string, string> | undefined;

  const url = new URL(`${BACKWORK_API_BASE}${operationPath(operationId, request.pathParams)}`);
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
    // The request ID is for support, so it goes to the server log and never into tool output.
    console.error(
      `Backwork API ${operationId} failed: HTTP ${response.status}${data.error?.code ? ` ${data.error.code}` : ""}${
        data.meta?.request_id ? ` request_id=${data.meta.request_id}` : ""
      }`,
    );
    throw new BackworkApiError(response.status, parseApiFailure(response.status, data, response.headers.get("retry-after")));
  }

  const projected = projectEnvelope(operationId, data, context.access);
  return { ...projected, data: parseCodeSources(operationId, projected.data) };
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
  if (error instanceof OperationUnavailableError) {
    return `Cannot ${action}: ${error.message} This request was not sent. Use an action this tool lists as available.`;
  }
  if (error instanceof BackworkApiError) return formatApiFailure(action, error.failure);
  return `Error ${action}: ${error instanceof Error ? error.message : String(error)}`;
}

function formatCode(code: any): string {
  const lines: string[] = [];
  lines.push(`Code: ${code.code} (${code.code_system})`);
  const description = code.description || code.short_description;
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
    shown.forEach((p: SourcedCode) => {
      lines.push(`  - ${p.policy_id}: ${cleanText(p.title, 140)}`);
      lines.push(`    Type: ${p.policy_type || "unknown"}, Disposition: ${p.disposition || "unknown"}${codeSourceNote(p.source)}${codeGroundingNote(p.grounding)}`);
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
  if (policy.last_reviewed_date) lines.push(`Last reviewed: ${policy.last_reviewed_date}`);
  if (policy.source_url) lines.push(`Source: ${policy.source_url}`);

  if (detailed) {
    const sourceAccuracy = formatSourceAccuracy(parseSourceCheck(policy.source_check));
    if (sourceAccuracy) lines.push(`\n${sourceAccuracy}`);
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
        codeList.slice(0, 8).forEach((c: SourcedCode) => {
          lines.push(`  - ${c.code}: ${c.display || "No description"} [${c.disposition}]${codeSourceNote(c.source)}${codeGroundingNote(c.grounding)}`);
        });
        if (codeList.length > 8) lines.push(`  ... and ${codeList.length - 8} more codes`);
      });
    }
  }

  return lines.join("\n");
}

function formatPriorAuth(result: any): string {
  const lines: string[] = [];

  const verdict = parsePriorAuthCheck(result);
  lines.push(`Prior Authorization Required: ${verdictAnswer(verdict)}`);
  if (verdict.confidence) lines.push(`Confidence: ${verdict.confidence.toUpperCase()}`);
  // An unknown verdict's API reason describes only the check's own scope, e.g. "No coverage policies found".
  if (verdict.reason) lines.push(`Reason: ${verdict.reason}`);
  else if (result.reason) lines.push(`Prior-auth check: ${result.reason}`);
  if (result.requires_manual_review) lines.push("Manual review required");
  if (result.known_gaps?.length > 0) {
    lines.push("Known gaps:");
    result.known_gaps.forEach((gap: string) => lines.push(`- ${gap}`));
  }

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
        p.codes.slice(0, 5).forEach((c: SourcedCode) => {
          lines.push(`  - ${c.code} (${c.code_system}): ${c.disposition}${codeSourceNote(c.source)}${codeGroundingNote(c.grounding)}`);
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

/**
 * The tool's own hints, refused at registration when they understate what its
 * offered operations do: a read-only tool cannot call a write-scope operation,
 * and a non-destructive tool cannot call a DELETE.
 */
function toolAnnotations(name: string, hints: ToolHints, offeredOperations: readonly OperationId[]): ToolHints {
  const operations = offeredOperations.map((id) => BACKWORK_OPERATIONS[id]);
  if (hints.readOnlyHint && operations.some((operation) => operation.scope === "write")) {
    throw new Error(`backwork_${name} is marked read-only but offers a write-scope operation`);
  }
  if (!hints.destructiveHint && operations.some((operation) => operation.method === "DELETE")) {
    throw new Error(`backwork_${name} is marked non-destructive but offers a DELETE operation`);
  }
  if (hints.readOnlyHint && hints.destructiveHint) throw new Error(`backwork_${name} cannot be both read-only and destructive`);
  return { ...hints };
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

/**
 * `widget` is the view model for the tool's UI component; it must be a view the
 * component renders. null (nothing to show) leaves it out, and the component collapses.
 */
function toolResult(message: string, data?: unknown, meta?: unknown, widget?: WidgetView | null): CallToolResult {
  const provenance = extractProvenance(data);
  const text = provenance ? `${message}\n\n${formatProvenance(provenance)}` : message;
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      ...(data !== undefined ? { data } : {}),
      ...(meta !== undefined ? { meta } : {}),
      message,
      ...(provenance ? { provenance } : {}),
      ...(widget ? { widget } : {}),
    },
  };
}

function toolError(message: string): CallToolResult {
  return errorResult(`Error: ${message}`);
}

/** Appended to every tool, so no tool can omit what Backwork does and does not accept. */
const DATA_HANDLING_NOTE =
  "Takes codes, payers, plan types and states only. Never send patient names, dates of birth, member IDs or other patient identifiers.";

function enhanceDescription(description: string): string {
  const responseFormatNote =
    "Supports optional response_format: 'markdown' (default) for readable text or 'json' for the returned structuredContent object.";
  return `${description}\n\n${DATA_HANDLING_NOTE}\n\n${responseFormatNote}`;
}

type ActionExposure = { offered: string[]; withheld: Map<Exclude<Exposure, "offered">, string[]> };

/** Splits a tool's actions into those it may call and those withheld, grouped by reason. */
export function actionExposure(operations: Record<string, readonly OperationId[]>, context: ExposureContext): ActionExposure {
  const result: ActionExposure = { offered: [], withheld: new Map() };
  for (const [action, ids] of Object.entries(operations)) {
    const reason = ids.map((id) => operationExposure(BACKWORK_OPERATIONS[id], context)).find((exposure) => exposure !== "offered");
    if (!reason) result.offered.push(action);
    else result.withheld.set(reason, [...(result.withheld.get(reason) ?? []), action]);
  }
  return result;
}

/**
 * Names the actions withheld because production does not serve them yet.
 * Actions withheld for lack of write access are left out of the enum without a
 * note: a read-only connection's tool list does not describe what it cannot do.
 */
function exposureNote(withheld: ActionExposure["withheld"]): string {
  const unavailable = withheld.get("unavailable-in-production");
  if (!unavailable?.length) return "";
  return `\n\nNot available on the production Backwork API yet: ${unavailable.map((action) => `'${action}'`).join(", ")}. Requests for these return an error without calling the API; do not retry them.`;
}

/** Narrows an `action` enum to the offered actions so an agent cannot pick a withheld one. */
function narrowActionInput(inputSchema: BackworkToolInputSchema | undefined, offered: string[]): BackworkToolInputSchema | undefined {
  const action = inputSchema?.action;
  if (!(action instanceof z.ZodEnum)) return inputSchema;
  const narrowed = z.enum(offered as [string, ...string[]]);
  return { ...inputSchema, action: action.description ? narrowed.describe(action.description) : narrowed };
}

function enhanceToolConfig(name: string, config: BackworkToolConfig, exposure: ActionExposure): BackworkToolConfig {
  const title = config.title || toolTitles[name] || titleizeToolName(name);
  const offeredOperations = exposure.offered.flatMap((action) => config.operations[action]);
  const { widget, ...rest } = config;
  const outputSchema = config.outputSchema || backworkToolOutputSchema;
  return {
    ...rest,
    title,
    description: enhanceDescription(config.description) + exposureNote(exposure.withheld),
    inputSchema: withResponseFormatInput(narrowActionInput(config.inputSchema, exposure.offered)),
    outputSchema: widget ? { ...outputSchema, widget: widgetOutputSchema(widget) } : outputSchema,
    annotations: toolAnnotations(name, config.annotations, offeredOperations),
    _meta: widget ? { ...config._meta, ...widgetToolMeta(widget) } : config._meta,
  };
}

function wrapToolHandler(name: string, context: ExposureContext, handler: BackworkToolHandler): BackworkToolHandler {
  return async (args: unknown, extra: unknown) => {
    const { handlerArgs, responseFormat } = splitResponseFormat(args);

    try {
      const result = await requestExposure.run(context, () => requestToolName.run(name, () => handler(handlerArgs, extra)));
      return normalizeToolResult(result, responseFormat);
    } catch (error) {
      return errorResult(`Error running ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

function createBackworkToolRegistrar(server: McpServer, context: ExposureContext): RegisterBackworkTool {
  return (name, config, handler) => {
    // A tool none of whose actions can succeed is hidden rather than offered to
    // an agent that would only collect errors from it.
    const exposure = actionExposure(config.operations, context);
    if (exposure.offered.length === 0) return;

    const prefixedName = `backwork_${name}`;
    const wrappedHandler = wrapToolHandler(name, context, handler);
    const { operations: _operations, ...primaryConfig } = enhanceToolConfig(name, config, exposure);

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

    const description = value.description || value.short_description;
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
      policies.slice(0, 3).forEach((policy: SourcedCode) => {
        lines.push(`    - ${policy.policy_id}: ${cleanText(policy.title, 120)} [${policy.disposition ?? "unknown"}]${codeSourceNote(policy.source)}${codeGroundingNote(policy.grounding)}`);
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
    const payer = record.payer_name || record.source || "unknown payer";
    const drug = record.drug_name || "unknown drug";
    const tier = record.tier;
    const status = record.coverage_status;
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

function formatPolicyComparison(data: any): string {
  const comparison: any[] = Array.isArray(data?.comparison) ? data.comparison : [];
  const summary = data?.summary ?? {};
  const codes: string[] = Array.isArray(summary.queried_codes) ? summary.queried_codes : [];
  const lines = [`Policy Comparison${codes.length ? ` for ${codes.join(", ")}` : ""}`];
  lines.push(`Jurisdictions analyzed: ${summary.total_jurisdictions ?? comparison.length}`);
  lines.push(`With coverage: ${summary.jurisdictions_with_coverage ?? "unknown"}`);
  lines.push(`Regional variation: ${summary.has_variation === undefined ? "unknown" : summary.has_variation ? "YES" : "NO"}`);
  if (summary.unresolved_jurisdictions?.length) lines.push(`No active MAC: ${summary.unresolved_jurisdictions.join(", ")}`);

  comparison.slice(0, 10).forEach((jurisdiction: any) => {
    const counts = jurisdiction.coverage_summary ?? {};
    lines.push(`\n${jurisdiction.jurisdiction}${jurisdiction.mac?.name ? ` (${jurisdiction.mac.name})` : ""}`);
    lines.push(
      `  Covered: ${counts.covered ?? 0}, prior auth: ${counts.requires_pa ?? 0}, conditional: ${counts.conditional ?? 0}, not covered: ${counts.not_covered ?? 0}`,
    );
    const policies: any[] = (jurisdiction.policies ?? []).filter((policy: any) => !policy.is_national);
    policies.slice(0, 4).forEach((policy: any) => {
      const codeList = (policy.codes ?? [])
        .slice(0, 5)
        .map((code: SourcedCode) => `${code.code} ${code.disposition}${codeSourceNote(code.source)}${codeGroundingNote(code.grounding)}`)
        .join("; ");
      lines.push(`  - ${policy.policy_id}: ${cleanText(policy.title, 120)}${codeList ? ` [${codeList}]` : ""}`);
    });
    if (policies.length > 4) lines.push(`  ... ${policies.length - 4} more policies omitted`);
  });
  if (comparison.length > 10) lines.push(`\n... ${comparison.length - 10} more jurisdictions omitted`);

  const national: any[] = Array.isArray(data?.national_policies) ? data.national_policies : [];
  if (national.length) {
    lines.push("\nNational policies (apply in every jurisdiction):");
    national.slice(0, 5).forEach((policy: any) => {
      const codes = (policy.codes ?? []).slice(0, 5).map((code: SourcedCode) => `${code.code} ${code.disposition}${codeSourceNote(code.source)}${codeGroundingNote(code.grounding)}`).join("; ");
      lines.push(`  - ${policy.policy_id}: ${cleanText(policy.title, 120)}${codes ? ` [${codes}]` : ""}`);
    });
  }
  return lines.join("\n");
}

function formatResearch(result: any): string {
  const lines: string[] = [];
  lines.push(`Research status: ${result.status}`);
  lines.push(`Research ID: ${result.research_id}`);
  if (result.status === "pending" || result.status === "running") {
    lines.push("Payer-website research usually takes a few minutes. To check on it, call this tool with action='get_research' and this research ID.");
  }

  if (result.result?.determination) {
    const determination = parseResearchDetermination(result.result.determination);
    lines.push("\n--- Determination ---");
    lines.push(`PA Required: ${verdictAnswer(determination)}`);
    if (determination.confidence) lines.push(`Confidence: ${determination.confidence}`);
    if (determination.reason) lines.push(`Reasoning: ${determination.reason}`);
  }

  if (result.result?.documentation_requirements?.length) {
    lines.push("\n--- Documentation Requirements ---");
    result.result.documentation_requirements.forEach((item: string) => lines.push(`- ${item}`));
  }

  if (result.error) lines.push(`\nError: ${result.error}`);
  return lines.join("\n");
}

/** Reads Backwork's own policy catalog or the organization's data; repeating a call changes nothing. */
const CATALOG_READ: ToolHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const POLICY_AS_OF_DATE = "Policy as-of date, YYYY-MM-DD: the date whose policy version applies.";

/**
 * Registers the workflow tools for a connection. `access` is what the
 * credential may do: a hosted OAuth grant is `read`, a Backwork API key
 * `write`. A read connection gets no write-only inputs, no diagnostics tool,
 * and descriptions that name only what it can do.
 */
function registerWorkflowTools(registerTool: RegisterBackworkTool, access: Scope): void {
  registerTool(
    "coverage_lookup",
    {
      operations: TOOL_OPERATIONS.coverage_lookup,
      widget: "coverage_card",
      annotations: CATALOG_READ,
      description: `Answer common coverage questions for procedure codes in one workflow.
Use this when a user asks whether codes are covered, whether prior authorization is required, what policies support the answer, or how coverage differs by jurisdiction.
This tool can combine code lookup, related policy evidence, prior-auth checks (traditional Medicare, or the named payer's own policies when payer is given), claim-risk validation, jurisdiction comparison, and spending evidence so the agent does not need to chain endpoint-shaped tools.`,
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
        state: z.string().length(2).optional().describe("Two-letter state where the service is provided, used to infer the MAC jurisdiction, e.g. TX"),
        jurisdiction: z.string().max(10).optional().describe("Optional MAC jurisdiction code for policy filtering, e.g. JM or JH"),
        diagnosis_codes: z.array(z.string()).max(20).optional().describe("Diagnosis codes when claim-risk validation is needed"),
        payer: z
          .string()
          .max(80)
          .optional()
          .describe("Payer name, slug or code, e.g. 'Moda Health'. The prior-auth check answers from this payer's policies, and code details list only this payer's policies. Omit it for traditional Medicare."),
        plan_type: z.enum(["commercial", "medicare_advantage", "medicaid", "traditional_medicare", "exchange"]).optional(),
        date_of_service: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(`${POLICY_AS_OF_DATE} Used by the claim_risk module.`),
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

        let codeDetails: unknown;
        if (requested.has("code_details")) {
          const result =
            procedure_codes.length === 1
              ? await backworkRequest("lookupCode", {
                  query: {
                    code: procedure_codes[0],
                    code_system,
                    jurisdiction,
                    include: normalizedCodeInclude,
                    fuzzy: "true",
                  },
                })
              : await backworkRequest("batchLookupCodes", {
                  body: {
                    codes: procedure_codes,
                    code_system,
                    include: normalizedCodeInclude,
                  },
                });
          codeDetails = result.data;
        }

        let priorAuth: unknown;
        if (requested.has("prior_auth")) {
          const result = await backworkRequest("checkPriorAuth", {
            body: { procedure_codes, state, payer },
          });
          priorAuth = result.data;
        }

        if (requested.has("code_details")) {
          // Code lookup cannot filter by payer, so a named payer's answer drops other payers' policy matches here.
          let note: string | null = null;
          if (payer) {
            const scoped = limitCodeDetailsToPayer(codeDetails, resolveRequestedPayer(payer, priorAuth));
            codeDetails = scoped.codeDetails;
            data.other_payers = scoped.others;
            note = otherPayersNote(payer, procedure_codes, scoped.others);
          }
          data.code_details = codeDetails;
          lines.push("\n--- Code Details ---");
          lines.push(procedure_codes.length === 1 ? formatCode(codeDetails) : formatBatchLookup(codeDetails));
          if (note) lines.push(note);
        }

        if (requested.has("prior_auth")) {
          data.prior_auth = priorAuth;
          lines.push("\n--- Prior Authorization ---");
          lines.push(formatPriorAuth(priorAuth));
          if (requested.has("code_details") && parsePriorAuthCheck(priorAuth).verdict === "unknown") {
            lines.push("The prior-auth check gave no answer, so policies under Code Details were not evaluated for prior auth.");
          }
        }

        if (requested.has("claim_risk")) {
          const result = await backworkRequest("validateClaims", {
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
          const result = await backworkRequest("comparePolicies", {
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
          const result = await backworkRequest("getSpendingByCode", {
            query: procedure_codes.length === 1 ? { code: procedure_codes[0] } : { codes: procedure_codes.join(",") },
          });
          data.spending = result.data;
          lines.push("\n--- Spending ---");
          lines.push(formatSpending(result.data));
        }

        const card = data.code_details !== undefined || data.prior_auth !== undefined ? buildCoverageCard(procedure_codes, data) : undefined;
        return toolResult(lines.join("\n"), data, undefined, card);
      } catch (error) {
        return errorResult(formatToolError("run coverage lookup", error));
      }
    },
  );

  registerTool(
    "policy_research",
    {
      operations: TOOL_OPERATIONS.policy_research,
      widget: "policy_research",
      annotations: CATALOG_READ,
      description: `Research coverage policies and criteria.
Use this for policy search, fetching one policy by ID, searching extracted criteria, reviewing policy changes, mapping state to MAC jurisdiction, or comparing how Medicare contractors (MACs) cover the same procedure codes side by side. This replaces several endpoint-shaped policy tools with one research workflow.`,
      inputSchema: {
        action: z.enum(["search", "get", "criteria", "changes", "jurisdictions", "compare"]).describe("Policy research action to perform"),
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
        procedure_codes: z
          .array(z.string().min(1).max(20))
          .min(1)
          .max(10)
          .optional()
          .describe("CPT/HCPCS codes to compare when action='compare', e.g. ['76942']"),
        jurisdictions: z
          .array(z.string().max(10))
          .max(10)
          .optional()
          .describe("MAC jurisdictions to compare when action='compare', e.g. ['JM', 'JH']. Omit to compare all."),
      },
    },
    async ({ action, query, policy_id, policy_type, jurisdiction, payer, status, mode, section, since, change_type, include, limit, cursor, procedure_codes, jurisdictions }) => {
      try {
        if (action === "compare") {
          if (!procedure_codes?.length) return toolError("procedure_codes is required when action='compare'.");
          const result = await backworkRequest("comparePolicies", { body: { procedure_codes, jurisdictions } });
          return toolResult(formatPolicyComparison(result.data), result.data, result.meta, buildPolicyComparison(procedure_codes, result.data));
        }

        if (action === "search") {
          const result = await backworkRequest("listPolicies", {
            query: { q: query, mode, policy_type, jurisdiction, payer, status, limit, cursor, include: normalizeInclude(include) },
          });
          if (!result.data?.length) return toolResult(`No policies found for "${query || "your search"}".`, result.data, result.meta);
          const lines = [`Found ${result.data.length} policies${result.meta?.pagination?.has_more ? " (more available)" : ""}:\n`];
          result.data.forEach((policy: any, i: number) => lines.push(`${i + 1}. ${formatPolicy(policy)}\n`));
          if (result.meta?.pagination?.cursor) lines.push(`More results available. Use cursor: "${result.meta.pagination.cursor}"`);
          return toolResult(lines.join("\n"), result.data, result.meta, buildPolicyList(query, result.data, result.meta));
        }

        if (action === "get") {
          if (!policy_id) return toolError("policy_id is required when action='get'.");
          const result = await backworkRequest("getPolicy", {
            pathParams: { id: policy_id },
            query: { include: normalizeInclude(include, "criteria,codes") },
          });
          return toolResult(formatPolicy(result.data, true), result.data, result.meta, buildPolicyDetail(result.data));
        }

        if (action === "criteria") {
          if (!query) return toolError("query is required when action='criteria'.");
          const result = await backworkRequest("searchCriteria", {
            query: { q: query, section, policy_type, jurisdiction, limit, cursor },
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
          return toolResult(lines.join("\n"), result.data, result.meta, buildCriteriaList(query, result.data, result.meta));
        }

        if (action === "changes") {
          const result = await backworkRequest("getPolicyChanges", {
            query: { since, policy_id, change_type, limit, cursor },
          });
          if (!result.data?.length) return toolResult("No policy changes found for the specified criteria.", result.data, result.meta);
          const lines = [`Found ${result.data.length} policy changes:\n`];
          result.data.forEach((change: any) => {
            lines.push(`[${change.change_type?.toUpperCase?.() ?? "CHANGE"}] ${change.policy_id}: ${change.policy_title}`);
            if (change.changed_at) lines.push(`  Date: ${change.changed_at}`);
            if (change.change_summary) lines.push(`  Summary: ${change.change_summary}`);
          });
          if (result.meta?.pagination?.cursor) lines.push(`More changes available. Use cursor: "${result.meta.pagination.cursor}"`);
          return toolResult(lines.join("\n"), result.data, result.meta, buildPolicyChanges(result.data, result.meta));
        }

        const result = await backworkRequest("listJurisdictions");
        const lines = [`MAC Jurisdictions (${result.data.length} total):\n`];
        result.data.forEach((jur: any) => {
          lines.push(`[${jur.jurisdiction_code}] ${jur.jurisdiction_name || ""}`);
          lines.push(`  MAC: ${jur.mac_name}${jur.mac_code ? ` (${jur.mac_code})` : ""}`);
          if (jur.states?.length) lines.push(`  States: ${jur.states.join(", ")}`);
          if (jur.website_url) lines.push(`  Website: ${jur.website_url}`);
          lines.push("");
        });
        return toolResult(lines.join("\n"), result.data, result.meta, buildJurisdictionList(result.data));
      } catch (error) {
        return errorResult(formatToolError("research policies", error));
      }
    },
  );

  const claimValidationInput = {
    procedure_codes: z.array(z.string()).min(1).max(10).describe("CPT/HCPCS procedure codes, up to 10"),
    diagnosis_codes: z.array(z.string()).max(20).optional().describe("ICD-10-CM diagnosis codes"),
    payer: z.string().optional().describe("Payer name, slug or code, e.g. 'Aetna'. Omit for traditional Medicare."),
    plan_type: z.enum(["commercial", "medicare_advantage", "medicaid", "traditional_medicare", "exchange"]).optional(),
    line_of_business: z.string().optional(),
    modifiers: z.array(z.string()).max(5).optional(),
    state: z.string().length(2).optional().describe("Two-letter state used to infer the Medicare jurisdiction, e.g. TX"),
    date_of_service: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(POLICY_AS_OF_DATE),
    site_of_service: z.enum(["office", "outpatient_hospital", "asc", "inpatient", "home", "telehealth"]).optional(),
    provider_specialty: z.string().optional(),
    age_category: z.enum(["pediatric", "adult", "medicare_age"]).optional(),
    sex_when_policy_relevant: z.enum(["female", "male", "other", "unknown"]).optional(),
    policy_id: z.string().optional().describe("Optional policy ID to evaluate against structured parameters"),
    coverage_parameters: z.record(z.unknown()).optional().describe("Policy criteria inputs when policy_id is supplied"),
  };
  registerTool(
    "claim_validation",
    {
      operations: TOOL_OPERATIONS.claim_validation,
      annotations: CATALOG_READ,
      description: `Validate a claim before submission: estimate denial risk and show coverage status, prior-auth need, documentation requirements and the policies behind them.
Use it when a user asks whether a claim for given procedure and diagnosis codes is likely to be denied, or what documentation the payer will expect. To test one policy's structured criteria as well, pass policy_id with coverage_parameters.
Limits: answers come only from the policies Backwork indexes (Medicare NCDs, LCDs and Articles, and the commercial payer policies in its catalog). It does not submit or look up a real claim and has no claim history; when no policy matches it reports the result as unknown. Up to 10 procedure codes.
Side effects: none. It is read-only.`,
      // A read connection gets no idempotency key: the call is read-only, so a retry is already safe.
      inputSchema:
        access === "write"
          ? { ...claimValidationInput, idempotency_key: z.string().optional().describe("Optional key that makes the API return the cached result of an earlier identical call") }
          : claimValidationInput,
    },
    async ({ idempotency_key, policy_id, coverage_parameters, ...body }) => {
      try {
        const data: Record<string, unknown> = {};
        const lines = ["Claim Validation"];
        const result = await backworkRequest("validateClaims", {
          body,
          headers: idempotency_key ? { "X-Idempotency-Key": idempotency_key } : undefined,
        });
        data.claim_validation = result.data;
        lines.push(formatClaimValidation(result.data));

        if (policy_id && coverage_parameters) {
          const evaluation = await backworkRequest("evaluateCoverage", {
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
      operations: TOOL_OPERATIONS.prior_auth_research,
      widget: "prior_auth_checklist",
      // start_research queues a job that searches public payer websites, and each call starts a new one.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: `Check whether procedure codes need prior authorization, or start and poll payer website research on a payer's prior-authorization rules.
Use action='check' first. It answers at once from Backwork's policy catalog: traditional Medicare NCDs and LCDs, or the named payer's own policies when payer is given. It returns documentation requirements and citations. When no policy matches, the answer is unknown, not "not required".
Use action='start_research' when check finds no evidence for a commercial payer. It queues a background job that searches public payer websites; it does not contact the payer or submit a request. Results can take a few minutes, then poll with action='get_research' and the returned research_id. Each start_research call starts a new job, so poll instead of starting again.
Limits: CPT/HCPCS codes, up to 10 per call. Results are evidence to confirm with the payer, not an authorization decision.`,
      inputSchema: {
        action: z
          .enum(["check", "start_research", "get_research"])
          .describe("check: immediate answer from Backwork's policies. start_research: queue payer website research. get_research: poll a research_id."),
        procedure_codes: z.array(z.string()).min(1).max(10).optional().describe("CPT/HCPCS codes; required for check and start_research"),
        research_id: z.string().optional().describe("The research ID start_research returned; required for get_research"),
        payer: z.string().optional().describe("Payer name, slug or code, e.g. 'Moda Health'. Omit for traditional Medicare."),
        state: z.string().length(2).optional().describe("Two-letter state, e.g. OR"),
        diagnosis_codes: z.array(z.string()).max(20).optional().describe("ICD-10-CM codes; start_research only"),
        sync: z.boolean().default(false).describe("start_research only: wait for the research to finish instead of returning a research_id to poll"),
      },
    },
    async ({ action, procedure_codes, research_id, ...body }) => {
      try {
        if (action === "get_research") {
          if (!research_id) return toolError("research_id is required when action='get_research'.");
          const result = await backworkRequest("getPriorAuthResearch", { pathParams: { id: research_id } });
          return toolResult(formatResearch(result.data), result.data, result.meta, buildResearchChecklist(result.data));
        }

        if (!procedure_codes?.length) return toolError("procedure_codes is required for prior authorization checks and research.");

        if (action === "check") {
          const result = await backworkRequest("checkPriorAuth", {
            body: { procedure_codes, state: body.state, payer: body.payer },
          });
          return toolResult(formatPriorAuth(result.data), result.data, result.meta, buildPriorAuthChecklist(result.data));
        }

        const result = await backworkRequest("researchPriorAuth", {
          body: { ...body, procedure_codes },
        });
        return toolResult(formatResearch(result.data), result.data, result.meta, buildResearchChecklist(result.data));
      } catch (error) {
        return errorResult(formatToolError("research prior auth", error));
      }
    },
  );

  registerTool(
    "drug_formulary_research",
    {
      operations: TOOL_OPERATIONS.drug_formulary_research,
      annotations: CATALOG_READ,
      description: `Search commercial pharmacy-benefit drug formulary evidence: tier, coverage status, prior authorization, step therapy and quantity limits for a drug.
Use it when a user asks how a pharmacy benefit manager covers a drug. It searches only the published formularies Backwork collects from CVS Caremark, Express Scripts and UnitedHealthcare / Optum Rx.
Limits: no Medicare Part D, Medicaid or other payers, and no drugs billed under the medical benefit (use coverage_lookup with the HCPCS J-code for those). A result shows what a formulary document says, not a member's plan. If a query finds nothing, it retries once with a simpler drug name and says so.
Side effects: none. It is read-only.`,
      inputSchema: {
        query: z.string().min(2).max(200).describe("Drug, class, or formulary requirement to search for, e.g. 'Ozempic'"),
        payer: z.enum(["all", "cvs_caremark", "express_scripts", "uhc"]).default("all").describe("Formulary source to search"),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ query, payer, limit }) => {
      try {
        let result = await backworkRequest("searchDrugFormularyEvidence", { query: { q: query, payer, limit } });
        const fallbackQuery = formularyResults(result.data).length === 0 ? simplifyDrugQuery(query) : undefined;

        if (fallbackQuery) {
          const fallbackResult = await backworkRequest("searchDrugFormularyEvidence", {
            query: { q: fallbackQuery, payer, limit },
          });
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

  const complianceReadInput = {
    change_type: z.string().optional().describe("Filter unreviewed changes by change type"),
    cursor: z.string().optional().describe("Pagination cursor from a previous list_unreviewed result"),
    limit: z.number().int().min(1).max(100).default(25),
  };
  registerTool(
    "compliance_review",
    access === "write"
      ? {
          operations: TOOL_OPERATIONS.compliance_review,
          // Acknowledging records a review; it removes nothing and repeating it does not add another.
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          description: `Review the organization's policy-change compliance queue: dashboard stats, unreviewed policy changes, and acknowledging changes when the user explicitly asks.
Use stats or list_unreviewed to see which tracked policies changed. Use acknowledge (diff_id) or bulk_acknowledge (diff_ids) only on an explicit request: it records the review in the organization's Backwork compliance log and sends any compliance.acknowledged webhooks.`,
          inputSchema: {
            action: z.enum(["stats", "list_unreviewed", "acknowledge", "bulk_acknowledge"]),
            ...complianceReadInput,
            diff_id: z.number().int().optional().describe("Change to acknowledge, from list_unreviewed"),
            diff_ids: z.array(z.number().int()).min(1).max(200).optional().describe("Changes to acknowledge together"),
            notes: z.string().max(500).optional().describe("Review note stored with the acknowledgment"),
          },
        }
      : {
          operations: { stats: TOOL_OPERATIONS.compliance_review.stats, list_unreviewed: TOOL_OPERATIONS.compliance_review.list_unreviewed },
          annotations: CATALOG_READ,
          description: `Review the organization's policy-change compliance queue: dashboard stats and the list of unreviewed policy changes.
Use it when a user asks which tracked coverage policies changed recently and still need review. It reads the organization's own Backwork compliance data and changes nothing.`,
          inputSchema: { action: z.enum(["stats", "list_unreviewed"]), ...complianceReadInput },
        },
    async ({ action, change_type, cursor, limit, diff_id, diff_ids, notes }) => {
      try {
        if (action === "stats") {
          const result = await backworkRequest("getComplianceStats");
          return toolResult(formatComplianceStats(result.data), result.data, result.meta);
        }
        if (action === "list_unreviewed") {
          const result = await backworkRequest("listUnreviewedChanges", { query: { change_type, cursor, limit } });
          return toolResult(formatComplianceChanges(result.data, result.meta), result.data, result.meta);
        }
        if (action === "acknowledge") {
          if (diff_id === undefined) return toolError("diff_id is required when action='acknowledge'.");
          const result = await backworkRequest("acknowledgeChange", { body: { diff_id, notes } });
          return toolResult(formatMutationResult("Acknowledge policy change", result.data), result.data, result.meta);
        }
        if (!diff_ids?.length) return toolError("diff_ids is required when action='bulk_acknowledge'.");
        const result = await backworkRequest("bulkAcknowledgeChanges", { body: { diff_ids, notes } });
        return toolResult(formatMutationResult("Bulk acknowledge policy changes", result.data), result.data, result.meta);
      } catch (error) {
        return errorResult(formatToolError("review compliance", error));
      }
    },
  );

  registerTool(
    "webhook_management",
    {
      operations: TOOL_OPERATIONS.webhook_management,
      // Delivers to the organization's own external URLs, and 'delete' removes an endpoint.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description:
        "List, create, update, delete, or test webhook endpoints. Use only when the user is explicitly managing webhook configuration. Backwork delivers one event type, compliance.acknowledged; policy-change webhooks are not sent.",
      inputSchema: {
        action: z.enum(["list", "create", "update", "delete", "test"]),
        id: z.number().int().optional(),
        url: z.string().url().refine((value) => new URL(value).protocol === "https:", "Webhook URL must use HTTPS").optional(),
        events: z
          .array(z.enum(["compliance.acknowledged", "*"]))
          .optional()
          .describe("Event types to subscribe to. compliance.acknowledged is the only event delivered; '*' subscribes to every event."),
        status: z.enum(["active", "paused"]).optional(),
      },
    },
    async ({ action, id, url, events, status }) => {
      try {
        if (action === "list") {
          const result = await backworkRequest("listWebhooks");
          return toolResult(formatWebhookList(result.data), result.data, result.meta);
        }
        if (action === "create") {
          if (!url || !events?.length) return toolError("url and at least one event are required when action='create'.");
          const result = await backworkRequest("createWebhook", { body: { url, events } });
          return toolResult(formatMutationResult("Create webhook", result.data), result.data, result.meta);
        }
        if (id === undefined) return toolError("id is required when action is update, delete, or test.");
        if (action === "update") {
          const result = await backworkRequest("updateWebhook", { pathParams: { id }, body: { url, events, status } });
          return toolResult(formatMutationResult("Update webhook", result.data), result.data, result.meta);
        }
        if (action === "delete") {
          const result = await backworkRequest("deleteWebhook", { pathParams: { id } });
          return toolResult(formatMutationResult("Delete webhook", result.data), result.data, result.meta);
        }
        const result = await backworkRequest("testWebhook", { pathParams: { id } });
        return toolResult(formatMutationResult("Test webhook", result.data), result.data, result.meta);
      } catch (error) {
        return errorResult(formatToolError("manage webhooks", error));
      }
    },
  );

  // Diagnostics for API-key integrators; a hosted read-only connection has no use for it.
  if (access === "write") {
    registerTool(
      "system_health",
      {
        operations: TOOL_OPERATIONS.system_health,
        annotations: CATALOG_READ,
        description: "Check Backwork API health and dependency status. Use for diagnostics, not for coverage research.",
        inputSchema: {},
      },
      async () => {
        try {
          const result = await backworkRequest("getHealth");
          return toolResult(formatJson(result.data), result.data, result.meta);
        } catch (error) {
          return errorResult(formatToolError("check health", error));
        }
      },
    );
  }
}

function createBackworkMcpServer(access: Scope): McpServer {
  const server = new McpServer({
    name: "backwork",
    version: SERVER_VERSION,
  });
  const registerTool = createBackworkToolRegistrar(server, {
    apiBase: BACKWORK_API_BASE,
    access,
    exposeUnavailable: exposeUnavailableTools,
  });

  registerWorkflowTools(registerTool, access);
  registerWidgetResources(server);

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
    access: scopes.includes("write") ? "write" : "read",
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
        access: "write",
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
      access: "write",
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
    // SDK 1.32.1: undefined keeps the per-request hosted transport stateless (v1.x server docs).
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
  });

  try {
    const body = await readRequestBody(authenticatedReq);
    const server = createBackworkMcpServer(authContext.access);
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

  // The key's own scopes govern what the API allows; the server offers every tool.
  const server = createBackworkMcpServer("write");
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
