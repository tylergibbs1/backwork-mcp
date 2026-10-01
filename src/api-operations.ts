/**
 * Every Backwork REST operation this MCP server calls, and exactly which
 * request fields it sends and response fields it reads.
 *
 * Tools can only reach the API through `backworkRequest(operationId, ...)`, and
 * its argument types come from this catalog, so a tool cannot send a field
 * that is not listed here. `npm run contract:check` verifies each entry
 * against the published Backwork OpenAPI document, so a listed field that the
 * API does not accept, or a read field it no longer returns, fails CI.
 */

export type Availability = "available" | "unavailable-in-production";
/** API key scope an operation needs. Mirrors `x-backwork-required-scopes`: `write` when listed, `read` otherwise. */
export type Scope = "read" | "write";

export interface BackworkOperation {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** OpenAPI path template, relative to the `/api/v1` server URL. */
  readonly path: string;
  readonly query: readonly string[];
  readonly body: readonly string[];
  readonly headers: readonly string[];
  /** Dot paths under the success response's `data` that tools read. `[]` steps into array items. */
  readonly reads: readonly string[];
  /** Mirrors the operation's `x-backwork-availability` marker in the published OpenAPI document. */
  readonly availability: Availability;
  readonly scope: Scope;
}

const none: readonly string[] = [];

export const BACKWORK_OPERATIONS = {
  lookupCode: {
    method: "GET",
    path: "/codes/lookup",
    query: ["code", "code_system", "jurisdiction", "include", "fuzzy"],
    body: none,
    headers: none,
    reads: [
      "code",
      "code_system",
      "description",
      "rvu",
      "policies[].policy_id",
      "policies[].title",
      "policies[].policy_type",
      "policies[].disposition",
      "policies[].jurisdiction",
      "policies[].source_url",
      "policies[].public_url",
      "policies[].effective_date",
      "policies[].source",
      "suggestions",
    ],
    availability: "available",
    scope: "read",
  },
  batchLookupCodes: {
    method: "POST",
    path: "/codes/batch",
    query: none,
    body: ["codes", "code_system", "include"],
    headers: none,
    reads: ["results"],
    availability: "available",
    scope: "read",
  },
  checkPriorAuth: {
    method: "POST",
    path: "/prior-auth/check",
    query: none,
    body: ["procedure_codes", "state", "payer"],
    headers: none,
    reads: [
      "pa_required",
      "coverage_status",
      "confidence",
      "reason",
      "requires_manual_review",
      "known_gaps",
      "mac",
      "matched_policies",
      "matched_policies[].public_url",
      "documentation_checklist",
      "known_gaps",
      "criteria_details",
      "policy_sources[].policy_id",
      "policy_sources[].source_url",
      "policy_sources[].effective_date",
      "policy_sources[].last_verified_at",
    ],
    availability: "available",
    scope: "read",
  },
  validateClaims: {
    method: "POST",
    path: "/claims/validate",
    query: none,
    body: [
      "payer",
      "plan_type",
      "line_of_business",
      "procedure_codes",
      "diagnosis_codes",
      "modifiers",
      "state",
      "date_of_service",
      "site_of_service",
      "provider_specialty",
      "age_category",
      "sex_when_policy_relevant",
    ],
    headers: ["X-Idempotency-Key"],
    reads: [
      "coverage_status",
      "prior_auth_required",
      "denial_risk",
      "overall_risk",
      "confidence",
      "documentation_requirements",
      "known_gaps",
      "issues",
      "matched_policies",
      "codes",
      "policy_sources[].policy_id",
      "policy_sources[].policy_type",
      "policy_sources[].source_url",
      "policy_sources[].effective_date",
      "policy_sources[].last_verified_at",
    ],
    availability: "available",
    scope: "read",
  },
  comparePolicies: {
    method: "POST",
    path: "/policies/compare",
    query: none,
    body: ["procedure_codes", "jurisdictions"],
    headers: none,
    reads: [
      "comparison",
      "comparison[].jurisdiction",
      "comparison[].mac.name",
      "comparison[].mac.states",
      "comparison[].coverage_summary",
      "comparison[].policies[].policy_id",
      "comparison[].policies[].title",
      "comparison[].policies[].policy_type",
      "comparison[].policies[].effective_date",
      "comparison[].policies[].source_url",
      "comparison[].policies[].public_url",
      "comparison[].policies[].is_national",
      "comparison[].policies[].codes[].code",
      "comparison[].policies[].codes[].disposition",
      "comparison[].policies[].codes[].source",
      "national_policies",
      "national_policies[].public_url",
      "summary.total_jurisdictions",
      "summary.jurisdictions_with_coverage",
      "summary.national_policies_count",
      "summary.has_variation",
      "summary.queried_codes",
      "summary.unresolved_jurisdictions",
    ],
    availability: "available",
    scope: "read",
  },
  getSpendingByCode: {
    method: "GET",
    path: "/spending/by-code",
    query: ["code", "codes"],
    body: none,
    headers: none,
    reads: none,
    availability: "available",
    scope: "read",
  },
  listPolicies: {
    method: "GET",
    path: "/policies",
    query: ["q", "mode", "policy_type", "jurisdiction", "payer", "status", "limit", "cursor", "include"],
    body: none,
    headers: none,
    reads: [
      "[].policy_id",
      "[].title",
      "[].policy_type",
      "[].status",
      "[].jurisdiction",
      "[].effective_date",
      "[].source_url",
      "[].payer",
    ],
    availability: "available",
    scope: "read",
  },
  getPolicy: {
    method: "GET",
    path: "/policies/{id}",
    query: ["include"],
    body: none,
    headers: none,
    reads: [
      "policy_id",
      "title",
      "policy_type",
      "status",
      "jurisdiction",
      "effective_date",
      "source_url",
      "payer.name",
      "mac",
      "criteria",
      "codes",
    ],
    availability: "available",
    scope: "read",
  },
  searchCriteria: {
    method: "GET",
    path: "/coverage/criteria",
    query: ["q", "section", "policy_type", "jurisdiction", "limit", "cursor"],
    body: none,
    headers: none,
    reads: ["[].section", "[].text", "[].policy_id", "[].effective_date"],
    availability: "available",
    scope: "read",
  },
  getPolicyChanges: {
    method: "GET",
    path: "/policies/changes",
    query: ["since", "policy_id", "change_type", "limit", "cursor"],
    body: none,
    headers: none,
    reads: ["[].change_type", "[].policy_id", "[].policy_title", "[].changed_at", "[].change_summary"],
    availability: "available",
    scope: "read",
  },
  listJurisdictions: {
    method: "GET",
    path: "/jurisdictions",
    query: none,
    body: none,
    headers: none,
    reads: ["[].jurisdiction_code", "[].jurisdiction_name", "[].mac_name", "[].states", "[].website_url"],
    availability: "available",
    scope: "read",
  },
  evaluateCoverage: {
    method: "POST",
    path: "/coverage/evaluate",
    query: none,
    body: ["policy_id", "parameters"],
    headers: none,
    reads: none,
    availability: "available",
    scope: "read",
  },
  getPriorAuthResearch: {
    method: "GET",
    path: "/prior-auth/research/{id}",
    query: none,
    body: none,
    headers: none,
    reads: ["research_id", "status", "created_at", "finished_at", "poll_url", "result", "error"],
    availability: "available",
    scope: "read",
  },
  researchPriorAuth: {
    method: "POST",
    path: "/prior-auth/research",
    query: none,
    body: ["procedure_codes", "payer", "state", "diagnosis_codes", "sync"],
    headers: none,
    reads: ["research_id", "status", "created_at", "finished_at", "poll_url", "result", "error"],
    availability: "available",
    scope: "read",
  },
  searchDrugFormularyEvidence: {
    method: "GET",
    path: "/drugs/formulary",
    query: ["q", "payer", "limit"],
    body: none,
    headers: none,
    reads: ["[].source_url", "[].payer_name", "[].effective_date"],
    availability: "available",
    scope: "read",
  },
  getComplianceStats: {
    method: "GET",
    path: "/compliance/stats",
    query: none,
    body: none,
    headers: none,
    reads: none,
    availability: "available",
    scope: "read",
  },
  listUnreviewedChanges: {
    method: "GET",
    path: "/compliance/unreviewed",
    query: ["change_type", "cursor", "limit"],
    body: none,
    headers: none,
    reads: ["[].policy_id", "[].policy_title", "[].change_type", "[].policy_type", "[].payer_name", "[].diff_id"],
    availability: "available",
    scope: "read",
  },
  acknowledgeChange: {
    method: "POST",
    path: "/compliance/ack",
    query: none,
    body: ["diff_id", "notes"],
    headers: none,
    reads: none,
    availability: "available",
    scope: "write",
  },
  bulkAcknowledgeChanges: {
    method: "POST",
    path: "/compliance/ack/bulk",
    query: none,
    body: ["diff_ids", "notes"],
    headers: none,
    reads: none,
    availability: "available",
    scope: "write",
  },
  listWebhooks: {
    method: "GET",
    path: "/webhooks",
    query: none,
    body: none,
    headers: none,
    reads: ["[].id", "[].url", "[].status", "[].events"],
    availability: "available",
    scope: "write",
  },
  createWebhook: {
    method: "POST",
    path: "/webhooks",
    query: none,
    body: ["url", "events"],
    headers: none,
    reads: ["id", "url", "secret"],
    availability: "available",
    scope: "write",
  },
  updateWebhook: {
    method: "PATCH",
    path: "/webhooks/{id}",
    query: none,
    body: ["url", "events", "status"],
    headers: none,
    reads: none,
    availability: "available",
    scope: "write",
  },
  deleteWebhook: {
    method: "DELETE",
    path: "/webhooks/{id}",
    query: none,
    body: none,
    headers: none,
    reads: none,
    availability: "available",
    scope: "write",
  },
  testWebhook: {
    method: "POST",
    path: "/webhooks/{id}/test",
    query: none,
    body: none,
    headers: none,
    reads: none,
    availability: "available",
    scope: "write",
  },
  getHealth: {
    method: "GET",
    path: "/health",
    query: none,
    body: none,
    headers: none,
    reads: none,
    availability: "available",
    scope: "read",
  },
} as const satisfies Record<string, BackworkOperation>;

export type OperationId = keyof typeof BACKWORK_OPERATIONS;

type QueryKey<Id extends OperationId> = (typeof BACKWORK_OPERATIONS)[Id]["query"][number];
type BodyKey<Id extends OperationId> = (typeof BACKWORK_OPERATIONS)[Id]["body"][number];
type HeaderKey<Id extends OperationId> = (typeof BACKWORK_OPERATIONS)[Id]["headers"][number];
type PathParam<Path extends string> = Path extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PathParam<Rest>
  : never;

/** The request a tool may make for an operation: only the catalog's declared fields type-check. */
export type OperationRequest<Id extends OperationId> = {
  query?: Partial<Record<QueryKey<Id>, string | number | boolean | undefined>>;
  body?: Partial<Record<BodyKey<Id>, unknown>>;
  headers?: Partial<Record<HeaderKey<Id>, string>>;
} & ([PathParam<(typeof BACKWORK_OPERATIONS)[Id]["path"]>] extends [never]
  ? { pathParams?: undefined }
  : { pathParams: Record<PathParam<(typeof BACKWORK_OPERATIONS)[Id]["path"]>, string | number> });

export const OPERATION_IDS = Object.keys(BACKWORK_OPERATIONS) as OperationId[];

export function operationPath(id: OperationId, pathParams: Record<string, string | number> | undefined): string {
  return BACKWORK_OPERATIONS[id].path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = pathParams?.[name];
    if (value === undefined) throw new Error(`Missing path parameter "${name}" for ${id}`);
    return encodeURIComponent(String(value));
  });
}

export const PRODUCTION_API_ORIGIN = "https://backworkhealth.com";

/** Where a server sends requests and what its caller's credential may do. */
export interface ExposureContext {
  readonly apiBase: string;
  /** `read` for the hosted OAuth grant (`backwork:mcp read`); `write` for a Backwork API key. */
  readonly access: Scope;
  /** Operator opt-in to offer operations the production API marks unavailable. */
  readonly exposeUnavailable: boolean;
}

export type Exposure = "offered" | "unavailable-in-production" | "needs-write-access";

/**
 * Whether a tool may call an operation. Availability markers describe the
 * production API only: a server pointed at another Backwork deployment, or an
 * operator who opts in, sees every operation. Scope applies everywhere.
 */
export function operationExposure(operation: BackworkOperation, context: ExposureContext): Exposure {
  if (operation.scope === "write" && context.access === "read") return "needs-write-access";
  if (context.exposeUnavailable) return "offered";
  if (new URL(context.apiBase).origin !== PRODUCTION_API_ORIGIN) return "offered";
  return operation.availability === "available" ? "offered" : "unavailable-in-production";
}
