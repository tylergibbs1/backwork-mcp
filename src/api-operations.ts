/**
 * Every Backwork REST operation this MCP server calls, and exactly which
 * request fields it sends and response fields it passes on.
 *
 * Tools can only reach the API through `backworkRequest(operationId, ...)`, and
 * its argument types come from this catalog, so a tool cannot send a field
 * that is not listed here, and a response field not listed in `reads` or
 * `metaReads` never reaches a tool result. `npm run contract:check` verifies
 * each entry against the published Backwork OpenAPI document, so a listed
 * field that the API does not accept, or a read field it no longer returns,
 * fails CI.
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
  /**
   * Dot paths under the success response's `data` that tool results carry; every
   * other field is dropped (src/projection.ts). `[]` steps into array items, `*`
   * into every value of a keyed record, and the last segment keeps its whole value.
   */
  readonly reads: readonly string[];
  /** Extra `data` paths kept only for write access: IDs that only a write action needs. */
  readonly readsForWriteAccess: readonly string[];
  /** Dot paths under the success response's `meta` that tool results carry. */
  readonly metaReads: readonly string[];
  /** Mirrors the operation's `x-backwork-availability` marker in the published OpenAPI document. */
  readonly availability: Availability;
  readonly scope: Scope;
}

const none: readonly string[] = [];
/** Data notices the API marks as required for the data in a response. */
const notices = ["attributions", "disclaimer"] as const;
const pagination = ["pagination.cursor", "pagination.has_more", "pagination.limit"] as const;

const codePolicyFields = ["policy_id", "title", "policy_type", "disposition", "jurisdiction", "source_url", "public_url", "effective_date", "source"];
const lookupFields = [
  "code",
  "code_system",
  "found",
  "description",
  "short_description",
  "category",
  "is_active",
  "rvu",
  "negotiated_rates",
  "ndc_crosswalk",
  ...codePolicyFields.map((field) => `policies[].${field}`),
  "suggestions[].code",
  "suggestions[].code_system",
  "suggestions[].description",
  "suggestions[].score",
  "suggestions[].match_type",
];
const sourceFields = ["policy_id", "title", "policy_type", "jurisdiction", "source_url", "public_url", "effective_date", "last_verified_at"];
const researchReads = [
  "research_id",
  "status",
  "result.determination",
  "result.payer_policies",
  "result.documentation_requirements",
  "result.medical_necessity_criteria",
  "result.coverage_limitations",
  "result.timeline",
  "result.appeal_process",
  "result.sources",
  "error",
];

export const BACKWORK_OPERATIONS = {
  lookupCode: {
    method: "GET",
    path: "/codes/lookup",
    query: ["code", "code_system", "jurisdiction", "include", "fuzzy"],
    body: none,
    headers: none,
    reads: lookupFields,
    readsForWriteAccess: none,
    metaReads: ["attributions"],
    availability: "available",
    scope: "read",
  },
  batchLookupCodes: {
    method: "POST",
    path: "/codes/batch",
    query: none,
    body: ["codes", "code_system", "include"],
    headers: none,
    reads: lookupFields.map((field) => `results.*.${field}`),
    readsForWriteAccess: none,
    metaReads: ["attributions"],
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
      ...sourceFields.map((field) => `matched_policies[].${field}`),
      "matched_policies[].payer.name",
      "matched_policies[].payer.slug",
      "matched_policies[].codes",
      "documentation_checklist",
      "criteria_details.indications[].text",
      "criteria_details.indications[].policy_id",
      "criteria_details.limitations[].text",
      "criteria_details.limitations[].policy_id",
      "criteria_details.pagination.indications.total",
      "criteria_details.pagination.limitations.total",
      ...sourceFields.map((field) => `policy_sources[].${field}`),
      "policy_sources[].payer.name",
    ],
    readsForWriteAccess: none,
    metaReads: notices,
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
      "requires_manual_review",
      "documentation_requirements",
      "known_gaps",
      "issues",
      ...sourceFields.map((field) => `matched_policies[].${field}`),
      "codes[].code",
      "codes[].description",
      "codes[].coverage_status",
      "codes[].prior_auth_required",
      "codes[].denial_risk",
      "codes[].documentation_requirements",
      "codes[].issues",
      ...sourceFields.map((field) => `policy_sources[].${field}`),
      "mac",
    ],
    readsForWriteAccess: none,
    metaReads: none,
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
      "national_policies[].policy_id",
      "national_policies[].title",
      "national_policies[].policy_type",
      "national_policies[].effective_date",
      "national_policies[].source_url",
      "national_policies[].public_url",
      "national_policies[].is_national",
      "national_policies[].codes",
      "summary.total_jurisdictions",
      "summary.jurisdictions_with_coverage",
      "summary.national_policies_count",
      "summary.has_variation",
      "summary.queried_codes",
      "summary.unresolved_jurisdictions",
    ],
    readsForWriteAccess: none,
    metaReads: none,
    availability: "available",
    scope: "read",
  },
  getSpendingByCode: {
    method: "GET",
    path: "/spending/by-code",
    query: ["code", "codes"],
    body: none,
    headers: none,
    reads: [
      "*.total_paid",
      "*.total_claims",
      "*.reported_patient_count_sum",
      "*.unique_providers",
      "*.date_range",
      "*.by_year[].year",
      "*.by_year[].total_paid",
      "*.by_year[].total_claims",
    ],
    readsForWriteAccess: none,
    metaReads: ["patient_count_disclosure"],
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
      "[].retire_date",
      "[].source_url",
      "[].public_url",
      "[].payer",
      "[].summary",
      "[].codes",
      "[].criteria[].section",
      "[].criteria[].text",
    ],
    readsForWriteAccess: none,
    metaReads: [...pagination, "attributions"],
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
      "retire_date",
      "last_reviewed_date",
      "version",
      "source_url",
      "public_url",
      "description",
      "summary",
      "sections",
      "mac.name",
      "mac.jurisdiction_name",
      "mac.states",
      "payer.name",
      "criteria.*[].text",
      "criteria.*[].tags",
      "codes.*[].code",
      "codes.*[].display",
      "codes.*[].disposition",
      "codes.*[].source",
    ],
    readsForWriteAccess: none,
    metaReads: notices,
    availability: "available",
    scope: "read",
  },
  searchCriteria: {
    method: "GET",
    path: "/coverage/criteria",
    query: ["q", "section", "policy_type", "jurisdiction", "limit", "cursor"],
    body: none,
    headers: none,
    reads: [
      "[].section",
      "[].text",
      "[].tags",
      "[].policy_id",
      "[].policy_title",
      "[].policy_type",
      "[].jurisdiction",
      "[].effective_date",
      "[].policy.policy_id",
      "[].policy.title",
      "[].policy.public_url",
    ],
    readsForWriteAccess: none,
    metaReads: [...pagination, ...notices],
    availability: "available",
    scope: "read",
  },
  getPolicyChanges: {
    method: "GET",
    path: "/policies/changes",
    query: ["since", "policy_id", "change_type", "limit", "cursor"],
    body: none,
    headers: none,
    reads: ["[].change_type", "[].policy_id", "[].policy_title", "[].policy_type", "[].payer_name", "[].changed_at", "[].change_summary"],
    readsForWriteAccess: none,
    metaReads: pagination,
    availability: "available",
    scope: "read",
  },
  listJurisdictions: {
    method: "GET",
    path: "/jurisdictions",
    query: none,
    body: none,
    headers: none,
    reads: ["[].jurisdiction_code", "[].jurisdiction_name", "[].mac_name", "[].mac_code", "[].states", "[].website_url"],
    readsForWriteAccess: none,
    metaReads: none,
    availability: "available",
    scope: "read",
  },
  evaluateCoverage: {
    method: "POST",
    path: "/coverage/evaluate",
    query: none,
    body: ["policy_id", "parameters"],
    headers: none,
    reads: [
      "covered",
      "confidence",
      "reasons",
      "matched_criteria",
      "unmatched_criteria",
      "skipped_criteria",
      "policy.policy_id",
      "policy.title",
      "policy.policy_type",
      "policy.public_url",
    ],
    readsForWriteAccess: none,
    metaReads: notices,
    availability: "available",
    scope: "read",
  },
  getPriorAuthResearch: {
    method: "GET",
    path: "/prior-auth/research/{id}",
    query: none,
    body: none,
    headers: none,
    reads: researchReads,
    readsForWriteAccess: none,
    metaReads: none,
    availability: "available",
    scope: "read",
  },
  researchPriorAuth: {
    method: "POST",
    path: "/prior-auth/research",
    query: none,
    body: ["procedure_codes", "payer", "state", "diagnosis_codes", "sync"],
    headers: none,
    reads: researchReads,
    readsForWriteAccess: none,
    metaReads: none,
    availability: "available",
    scope: "read",
  },
  searchDrugFormularyEvidence: {
    method: "GET",
    path: "/drugs/formulary",
    query: ["q", "payer", "limit"],
    body: none,
    headers: none,
    reads: [
      "[].source",
      "[].payer_name",
      "[].pbm_name",
      "[].formulary_name",
      "[].plan_year",
      "[].effective_date",
      "[].drug_name",
      "[].drug_class",
      "[].tier",
      "[].coverage_status",
      "[].requirements",
      "[].alternatives",
      "[].preferred_alternatives",
      "[].source_url",
    ],
    readsForWriteAccess: none,
    metaReads: ["counts", ...notices],
    availability: "available",
    scope: "read",
  },
  getComplianceStats: {
    method: "GET",
    path: "/compliance/stats",
    query: none,
    body: none,
    headers: none,
    reads: ["total_changes_30d", "acknowledged_count", "unreviewed_count", "acknowledgment_rate", "critical_unreviewed"],
    readsForWriteAccess: none,
    metaReads: none,
    availability: "available",
    scope: "read",
  },
  listUnreviewedChanges: {
    method: "GET",
    path: "/compliance/unreviewed",
    query: ["change_type", "cursor", "limit"],
    body: none,
    headers: none,
    reads: ["[].policy_id", "[].policy_title", "[].change_type", "[].policy_type", "[].payer_name", "[].change_summary", "[].changed_at"],
    // The acknowledge actions take a diff_id; a read-only connection has no use for it.
    readsForWriteAccess: ["[].diff_id"],
    metaReads: pagination,
    availability: "available",
    scope: "read",
  },
  acknowledgeChange: {
    method: "POST",
    path: "/compliance/ack",
    query: none,
    body: ["diff_id", "notes"],
    headers: none,
    reads: ["acknowledged", "already_acked"],
    readsForWriteAccess: none,
    metaReads: none,
    availability: "available",
    scope: "write",
  },
  bulkAcknowledgeChanges: {
    method: "POST",
    path: "/compliance/ack/bulk",
    query: none,
    body: ["diff_ids", "notes"],
    headers: none,
    reads: ["acknowledged", "already_acked", "invalid_ids", "total"],
    readsForWriteAccess: none,
    metaReads: none,
    availability: "available",
    scope: "write",
  },
  listWebhooks: {
    method: "GET",
    path: "/webhooks",
    query: none,
    body: none,
    headers: none,
    reads: ["[].id", "[].url", "[].status", "[].events", "[].failure_count"],
    readsForWriteAccess: none,
    metaReads: none,
    availability: "available",
    scope: "write",
  },
  createWebhook: {
    method: "POST",
    path: "/webhooks",
    query: none,
    body: ["url", "events"],
    headers: none,
    reads: ["id", "url", "events", "status", "secret"],
    readsForWriteAccess: none,
    metaReads: none,
    availability: "available",
    scope: "write",
  },
  updateWebhook: {
    method: "PATCH",
    path: "/webhooks/{id}",
    query: none,
    body: ["url", "events", "status"],
    headers: none,
    reads: ["id", "url", "events", "status", "failure_count"],
    readsForWriteAccess: none,
    metaReads: none,
    availability: "available",
    scope: "write",
  },
  deleteWebhook: {
    method: "DELETE",
    path: "/webhooks/{id}",
    query: none,
    body: none,
    headers: none,
    reads: ["id", "deleted"],
    readsForWriteAccess: none,
    metaReads: none,
    availability: "available",
    scope: "write",
  },
  testWebhook: {
    method: "POST",
    path: "/webhooks/{id}/test",
    query: none,
    body: none,
    headers: none,
    reads: ["event", "http_status", "success", "error"],
    readsForWriteAccess: none,
    metaReads: none,
    availability: "available",
    scope: "write",
  },
  getHealth: {
    method: "GET",
    path: "/health",
    query: none,
    body: none,
    headers: none,
    reads: ["status", "version", "checks"],
    readsForWriteAccess: none,
    metaReads: none,
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
