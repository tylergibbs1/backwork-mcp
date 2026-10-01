import type { OperationId } from "./api-operations.js";

/**
 * Which API operations each tool action calls. For tools with an `action`
 * input the keys are its values; for `coverage_lookup` they are the `include`
 * evidence modules. The registrar uses this to hide a tool whose every action
 * is unavailable in production and to name the unavailable actions of the rest.
 */
export const TOOL_OPERATIONS = {
  coverage_lookup: {
    code_details: ["lookupCode", "batchLookupCodes"],
    prior_auth: ["checkPriorAuth"],
    claim_risk: ["validateClaims"],
    jurisdiction_compare: ["comparePolicies"],
    spending: ["getSpendingByCode"],
  },
  policy_research: {
    search: ["listPolicies"],
    get: ["getPolicy"],
    criteria: ["searchCriteria"],
    changes: ["getPolicyChanges"],
    jurisdictions: ["listJurisdictions"],
    compare: ["comparePolicies"],
  },
  claim_validation: {
    validate: ["validateClaims"],
    policy_criteria: ["evaluateCoverage"],
  },
  prior_auth_research: {
    check: ["checkPriorAuth"],
    start_research: ["researchPriorAuth"],
    get_research: ["getPriorAuthResearch"],
  },
  drug_formulary_research: {
    search: ["searchDrugFormularyEvidence"],
  },
  compliance_review: {
    stats: ["getComplianceStats"],
    list_unreviewed: ["listUnreviewedChanges"],
    acknowledge: ["acknowledgeChange"],
    bulk_acknowledge: ["bulkAcknowledgeChanges"],
  },
  webhook_management: {
    list: ["listWebhooks"],
    create: ["createWebhook"],
    update: ["updateWebhook"],
    delete: ["deleteWebhook"],
    test: ["testWebhook"],
  },
  system_health: {
    check: ["getHealth"],
  },
} as const satisfies Record<string, Record<string, readonly OperationId[]>>;

export type ToolName = keyof typeof TOOL_OPERATIONS;
