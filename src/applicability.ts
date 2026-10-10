import { z } from "zod";

// Zod 3.25.76: safeParse bounds evidence and object schemas strip unknown keys.
// https://v3.zod.dev/?id=objects
const marketSchema = z.string().regex(/^[A-Z]{2}$/);
const marketsSchema = z.array(marketSchema).max(64);
const noteSchema = z.string().max(4000).nullable();
export const applicabilityEvidenceSchema = z.object({
  document_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  market_index_listings: z.array(z.object({
    market: marketSchema,
    index_url: z.string().max(2048).url().regex(/^https:\/\//).refine((value) => {
      try {
        const url = new URL(value);
        return !url.username && !url.password && !/[\s\u0000-\u001f\u007f]/.test(value);
      } catch {
        return false;
      }
    }, "Publisher index links must be safe HTTPS URLs"),
  })).max(16),
  document_statements: z.array(z.object({
    kind: z.enum(["non_medicare_disclaimer", "commercial_policy_header", "member_type_branch"]),
    quote: z.string().min(1).max(4000),
    page: z.number().int().positive(),
  })).max(16),
});

export const applicabilitySchemaFields = {
  applicability_scope: z.enum(["shared_markets", "document_scoped"]).optional(),
  applicability_markets: marketsSchema.optional(),
  applicability_evidence: applicabilityEvidenceSchema.nullable().optional(),
  applicability_note: noteSchema.optional(),
};

const applicabilitySchema = z.object(applicabilitySchemaFields);
export type Applicability = z.infer<typeof applicabilitySchema>;

/** Missing legacy fields remain missing. Malformed explicit evidence fails closed. */
export function parseApplicability(record: Readonly<Record<string, unknown>>): Applicability {
  const scope = record.applicability_scope;
  if (scope !== "shared_markets" && scope !== "document_scoped") return {};
  const markets = marketsSchema.safeParse(record.applicability_markets ?? []);
  const evidence = applicabilityEvidenceSchema.safeParse(record.applicability_evidence);
  const note = noteSchema.safeParse(record.applicability_note ?? null);
  return {
    applicability_scope: scope,
    applicability_markets: markets.success ? markets.data : [],
    applicability_evidence: markets.success && evidence.success ? evidence.data : null,
    applicability_note: markets.success && note.success ? note.data : null,
  };
}

/** Text clients receive the API note verbatim; quotes retain their source page. */
export function formatApplicability(record: Readonly<Record<string, unknown>>, detailed = false): string {
  const scope = parseApplicability(record);
  if (!scope.applicability_scope) return "";
  const lines = [scope.applicability_note ?? "Applicability details are unavailable; confirm the member's plan with the payer."];
  if (detailed && scope.applicability_evidence) {
    for (const listing of scope.applicability_evidence.market_index_listings) lines.push(`Publisher index for ${listing.market}: ${listing.index_url}`);
    for (const statement of scope.applicability_evidence.document_statements) lines.push(`Source statement (page ${statement.page}): ${statement.quote}`);
  }
  return lines.join("\n");
}
