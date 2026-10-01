import { z } from "zod";

/**
 * The view models the three UI components render. A tool that has a component
 * returns one of these as `structuredContent.widget`; its outputSchema declares
 * the matching schema, so the MCP SDK rejects a result whose view does not fit.
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
    prior_auth: z
      .object({
        required: z.boolean().nullable(),
        confidence: z.string().nullable(),
        reason: z.string().nullable(),
      })
      .nullable(),
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
    pa_required: z.boolean().nullable(),
    confidence: z.string().nullable(),
    reason: z.string().nullable(),
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

export type WidgetCode = z.infer<typeof widgetCodeSchema>;
export type WidgetPolicy = z.infer<typeof widgetPolicySchema>;
export type CoverageCardView = z.infer<typeof coverageCardSchema>;
export type PriorAuthChecklistView = z.infer<typeof priorAuthChecklistSchema>;
export type ComparisonCell = z.infer<typeof comparisonCellSchema>;
export type PolicyComparisonView = z.infer<typeof policyComparisonSchema>;
export type WidgetView = CoverageCardView | PriorAuthChecklistView | PolicyComparisonView;
export type WidgetKind = WidgetView["kind"];

export const WIDGET_SCHEMAS = {
  coverage_card: coverageCardSchema,
  prior_auth_checklist: priorAuthChecklistSchema,
  policy_comparison: policyComparisonSchema,
} as const satisfies Record<WidgetKind, z.ZodTypeAny>;
