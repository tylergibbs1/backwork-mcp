/**
 * What a failed Backwork API call means for the user, parsed once where the
 * response arrives. The API's own hint, plan names, pricing URL and docs links
 * are not carried past this boundary, so tool output cannot repeat them
 * (https://developers.openai.com/plugins/plugin-guidelines: no upsells or pricing in tool output).
 */
export type ApiFailure =
  | { kind: "not-in-plan" }
  | { kind: "credits-exhausted" }
  | { kind: "account-inactive" }
  | { kind: "rate-limited"; window: "minute" | "day"; retryAfterSeconds: number | null }
  | { kind: "missing-scope"; requiredScopes: string[] }
  | { kind: "unauthenticated" }
  | { kind: "unavailable-in-production" }
  | { kind: "other"; code: string | null; message: string };

export class BackworkApiError extends Error {
  constructor(readonly status: number, readonly failure: ApiFailure) {
    super(failure.kind === "other" ? failure.message : `Backwork API ${failure.kind} (HTTP ${status})`);
    this.name = "BackworkApiError";
  }
}

const PLAN_CODES = new Set(["BILLING_FEATURE_REQUIRED", "FEATURE_NOT_AVAILABLE", "UPGRADE_REQUIRED"]);
const CREDIT_CODES = new Set(["BILLING_CREDITS_EXHAUSTED", "USAGE_LIMIT_EXCEEDED"]);
const RATE_CODES = new Set(["RATE_LIMIT_EXCEEDED", "RATE_QUOTA_EXCEEDED", "RATE_CONCURRENT_EXCEEDED"]);
const SCOPE_CODES = new Set(["AUTHZ_SCOPE_REQUIRED", "AUTH_SCOPE_INSUFFICIENT"]);

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function scopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return text(value)?.split(/[,\s]+/).filter(Boolean) ?? [];
}

/** Seconds from a Retry-After header, which is either delta-seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  const value = text(header);
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** Classifies a non-2xx response. `body` is the parsed JSON body, or anything else the API sent. */
export function parseApiFailure(status: number, body: unknown, retryAfterHeader: string | null): ApiFailure {
  const error = record(record(body).error);
  const details = record(error.details);
  const code = text(error.code);

  if (code === "COMMERCIAL_SURFACE_UNAVAILABLE") return { kind: "unavailable-in-production" };
  if (code && CREDIT_CODES.has(code)) return { kind: "credits-exhausted" };
  if (code === "SUBSCRIPTION_INACTIVE") return { kind: "account-inactive" };
  if (code === "DAILY_LIMIT_EXCEEDED") return { kind: "rate-limited", window: "day", retryAfterSeconds: parseRetryAfter(retryAfterHeader) };
  if (status === 429 || (code && RATE_CODES.has(code))) {
    return { kind: "rate-limited", window: "minute", retryAfterSeconds: parseRetryAfter(retryAfterHeader) };
  }
  const planGate =
    (code !== null && PLAN_CODES.has(code)) ||
    status === 402 ||
    [error.upgrade_to, error.required_plan, details.required_plan, details.required_feature].some((value) => text(value) !== null);
  if (planGate) return { kind: "not-in-plan" };
  if (status === 403 || (code && SCOPE_CODES.has(code))) return { kind: "missing-scope", requiredScopes: scopes(details.required_scopes) };
  if (status === 401 || code === "INVALID_API_KEY") return { kind: "unauthenticated" };
  return { kind: "other", code, message: text(error.message) ?? `API error: ${status}` };
}

function retryAdvice(failure: Extract<ApiFailure, { kind: "rate-limited" }>): string {
  if (failure.retryAfterSeconds !== null) return `Retry in ${failure.retryAfterSeconds} second${failure.retryAfterSeconds === 1 ? "" : "s"}.`;
  return failure.window === "day" ? "Retry after the daily limit resets." : "Retry in about a minute.";
}

/** The tool-output text for a failed call. `action` completes "Cannot …", e.g. "validate claim". */
export function formatApiFailure(action: string, failure: ApiFailure): string {
  switch (failure.kind) {
    case "not-in-plan":
      return `Cannot ${action}.\nThis feature isn't included in your organization's current Backwork plan.`;
    case "credits-exhausted":
      return `Cannot ${action}.\nYour organization has no remaining Backwork request credits. An organization admin can manage usage in Backwork.`;
    case "account-inactive":
      return `Cannot ${action}.\nYour organization's Backwork access is inactive. An organization admin can manage it in Backwork.`;
    case "rate-limited":
      return [
        `Cannot ${action}.`,
        failure.window === "day"
          ? "Backwork has reached this organization's daily request limit."
          : "Backwork is rate-limiting this organization's requests.",
        retryAdvice(failure),
      ].join("\n");
    case "missing-scope":
      return [
        `Cannot ${action}: this connection is not authorized for that operation.`,
        failure.requiredScopes.length ? `Required scope: ${failure.requiredScopes.map((scope) => `"${scope}"`).join(" or ")}.` : null,
        "Choose a read-only action for this workflow.",
      ]
        .filter(Boolean)
        .join("\n");
    case "unauthenticated":
      return `Cannot ${action}: the Backwork credential was missing, invalid, revoked, or suspended. Reconnect Backwork and try again.`;
    case "unavailable-in-production":
      return [
        `Cannot ${action}: the Backwork API reports this endpoint is not available in production yet.`,
        "Do not retry. Use an available action or tell the user this data is not available.",
      ].join("\n");
    case "other":
      return [`Error ${action}: ${failure.message}`, failure.code ? `Code: ${failure.code}` : null].filter(Boolean).join("\n");
  }
}
