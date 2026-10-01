import { z } from "zod";

import { priorAuthVerdictSchema } from "../prior-auth-verdict.js";

/**
 * The view models the UI components render. A tool that has a component
 * returns one of these as `structuredContent.widget`; its outputSchema declares
 * the views its component renders, so the MCP SDK rejects a result whose view
 * does not fit.
 */

const codeSourceKind = z.enum(["document", "inferred_title_match", "unrecognized"]);

/** A code attached to a policy, with why it is attached. */
export const widgetCodeSchema = z.object({
  code: z.string(),
  code_system: z.string().nullable(),
  disposition: z.string().nullable(),
  source: codeSourceKind,
  /** Text shown next to the code, e.g. "Inferred from policy title". */
  source_label: z.string(),
});

export const widgetPolicySchema = z.object({
  policy_id: z.string(),
  title: z.string(),
  policy_type: z.string().nullable(),
  /** Who issued the policy: "CMS" for Medicare policy types, otherwise the payer name when the API returns one. */
  payer: z.string().nullable(),
  jurisdiction: z.string().nullable(),
  effective_date: z.string().nullable(),
  /** Backwork's public page for the policy when there is one, else its http(s) source document; null when neither. */
  link: z.object({ kind: z.enum(["backwork", "source"]), url: z.string() }).nullable(),
});

export const coverageCardSchema = z
  .object({
    kind: z.literal("coverage_card"),
    codes_requested: z.array(z.string()),
    prior_auth: priorAuthVerdictSchema.nullable(),
    policies: z.array(
      widgetPolicySchema.extend({ codes: z.array(widgetCodeSchema), codes_omitted: z.number().int().nonnegative() }),
    ),
    policies_omitted: z.number().int().nonnegative(),
  })
  .describe("Coverage result card: the policies that list the requested codes, with each code's disposition.");

export const priorAuthChecklistSchema = z
  .object({
    kind: z.literal("prior_auth_checklist"),
    status: z.enum(["complete", "pending", "running", "failed", "canceled"]),
    research_id: z.string().nullable(),
    prior_auth: priorAuthVerdictSchema,
    mac: z.object({ name: z.string(), jurisdiction: z.string().nullable() }).nullable(),
    codes_requiring_pa: z.array(widgetCodeSchema.extend({ policy_id: z.string(), policy_title: z.string() })),
    documentation: z.array(z.object({ text: z.string(), mandatory: z.boolean().nullable() })),
    known_gaps: z.array(z.string()),
    /** Codes attached only because a policy title names them; the document does not list them. */
    inferred_codes: z.array(z.object({ code: z.string(), policy_id: z.string(), policy_title: z.string() })),
    citations: z.array(widgetPolicySchema),
  })
  .describe("Prior-authorization checklist: codes that need PA, documentation to gather, known gaps, and citations.");

export const comparisonCellSchema = z.object({
  disposition: z.string().nullable(),
  policy_id: z.string().nullable(),
  source: codeSourceKind.nullable(),
  source_label: z.string().nullable(),
  /** Further policies in this column that also list the code. */
  more: z.number().int().nonnegative(),
});

export const policyComparisonSchema = z
  .object({
    kind: z.literal("policy_comparison"),
    codes: z.array(z.string()),
    has_variation: z.boolean().nullable(),
    columns: z.array(
      z.object({
        jurisdiction: z.string(),
        payer: z.string().nullable(),
        states: z.array(z.string()),
        coverage: z.object({
          covered: z.number().int(),
          not_covered: z.number().int(),
          requires_pa: z.number().int(),
          conditional: z.number().int(),
        }),
      }),
    ),
    /** One row per code; `cells[i]` belongs to `columns[i]`. */
    rows: z.array(z.object({ code: z.string(), cells: z.array(comparisonCellSchema) })),
    policies: z.array(widgetPolicySchema.extend({ is_national: z.boolean() })),
    unresolved_jurisdictions: z.array(z.string()),
    columns_omitted: z.number().int().nonnegative(),
  })
  .describe("Policy comparison table: the requested codes side by side across Medicare contractors (MACs).");

const policyStatus = z.enum(["active", "retired"]).nullable();

// The list views below hold at least one item: a response with nothing to show
// has no view, so the component collapses instead of rendering an empty card.

export const policyListSchema = z
  .object({
    kind: z.literal("policy_list"),
    query: z.string().nullable(),
    policies: z.array(widgetPolicySchema.extend({ status: policyStatus, summary: z.string().nullable() })).nonempty(),
    /** Policies in this response that the card leaves out, plus whether the API has another page. */
    policies_omitted: z.number().int().nonnegative(),
    has_more: z.boolean(),
  })
  .describe("Policy search results: each policy's payer, title, number, effective date and link.");

export const policyDetailSchema = z
  .object({
    kind: z.literal("policy_detail"),
    policy: widgetPolicySchema.extend({
      status: policyStatus,
      last_reviewed_date: z.string().nullable(),
      summary: z.string().nullable(),
    }),
    /** The first criteria excerpt of each section, e.g. indications. */
    criteria: z.array(z.object({ section: z.string(), text: z.string(), more: z.number().int().nonnegative() })),
    codes: z.array(widgetCodeSchema.extend({ display: z.string().nullable() })),
    codes_omitted: z.number().int().nonnegative(),
  })
  .describe("One policy: summary, criteria excerpts by section, its codes with dispositions, and a link.");

export const criteriaListSchema = z
  .object({
    kind: z.literal("criteria_list"),
    query: z.string().nullable(),
    items: z.array(
      z.object({
        section: z.string(),
        text: z.string(),
        policy: widgetPolicySchema,
      }),
    )
    .nonempty(),
    items_omitted: z.number().int().nonnegative(),
    has_more: z.boolean(),
  })
  .describe("Coverage criteria search results: each excerpt with its section and the policy it comes from.");

export const policyChangesSchema = z
  .object({
    kind: z.literal("policy_changes"),
    changes: z.array(
      z.object({
        change_type: z.string(),
        policy_id: z.string(),
        policy_title: z.string(),
        payer: z.string().nullable(),
        /** YYYY-MM-DD */
        changed_on: z.string().nullable(),
        summary: z.string().nullable(),
      }),
    )
    .nonempty(),
    changes_omitted: z.number().int().nonnegative(),
    has_more: z.boolean(),
  })
  .describe("Recent policy changes: what changed, in which policy, and when.");

export const jurisdictionListSchema = z
  .object({
    kind: z.literal("jurisdiction_list"),
    jurisdictions: z.array(
      z.object({
        code: z.string(),
        name: z.string().nullable(),
        mac: z.string().nullable(),
        states: z.array(z.string()),
        website: z.string().nullable(),
      }),
    )
    .nonempty(),
    jurisdictions_omitted: z.number().int().nonnegative(),
  })
  .describe("Medicare contractor (MAC) jurisdictions and the states each covers.");

export type WidgetCode = z.infer<typeof widgetCodeSchema>;
export type WidgetPolicy = z.infer<typeof widgetPolicySchema>;
export type CoverageCardView = z.infer<typeof coverageCardSchema>;
export type PriorAuthChecklistView = z.infer<typeof priorAuthChecklistSchema>;
export type ComparisonCell = z.infer<typeof comparisonCellSchema>;
export type PolicyComparisonView = z.infer<typeof policyComparisonSchema>;
export type PolicyListView = z.infer<typeof policyListSchema>;
export type PolicyDetailView = z.infer<typeof policyDetailSchema>;
export type CriteriaListView = z.infer<typeof criteriaListSchema>;
export type PolicyChangesView = z.infer<typeof policyChangesSchema>;
export type JurisdictionListView = z.infer<typeof jurisdictionListSchema>;

export type WidgetView =
  | CoverageCardView
  | PriorAuthChecklistView
  | PolicyComparisonView
  | PolicyListView
  | PolicyDetailView
  | CriteriaListView
  | PolicyChangesView
  | JurisdictionListView;
export type ViewKind = WidgetView["kind"];

export const VIEW_SCHEMAS = {
  coverage_card: coverageCardSchema,
  prior_auth_checklist: priorAuthChecklistSchema,
  policy_comparison: policyComparisonSchema,
  policy_list: policyListSchema,
  policy_detail: policyDetailSchema,
  criteria_list: criteriaListSchema,
  policy_changes: policyChangesSchema,
  jurisdiction_list: jurisdictionListSchema,
} as const satisfies { [K in ViewKind]: z.ZodType<Extract<WidgetView, { kind: K }>, z.ZodTypeDef, unknown> };

/**
 * The UI components and the views each renders. A tool names one component;
 * ChatGPT and other MCP Apps hosts load that component for every call of the
 * tool, so a component must render every view the tool returns. A result with
 * no view (an empty search, an error) collapses the component to nothing.
 */
export const COMPONENT_VIEWS = {
  coverage_card: ["coverage_card"],
  prior_auth_checklist: ["prior_auth_checklist"],
  policy_research: ["policy_comparison", "policy_list", "policy_detail", "criteria_list", "policy_changes", "jurisdiction_list"],
} as const satisfies Record<string, readonly [ViewKind, ...ViewKind[]]>;

export type ComponentKind = keyof typeof COMPONENT_VIEWS;
/** The views a component renders, e.g. ComponentView<"policy_research">. */
export type ComponentView<C extends ComponentKind> = Extract<WidgetView, { kind: (typeof COMPONENT_VIEWS)[C][number] }>;
