import { z } from "zod";

/** Audits sample a source's policy records; they do not score this policy's certainty. */
export const sourceAccuracySchema = z.object({
  field: z.enum(["overall", "title", "effective_date", "codes", "link"]),
  sampled_at: z.string(),
  sample_size: z.number().int().positive(),
  accuracy: z.number().min(0).max(1),
  ci_low: z.number().min(0).max(1),
  ci_high: z.number().min(0).max(1),
  method: z.string(),
});

export const sourceCheckSchema = z.object({
  source_url: z.string(),
  last_fetched_at: z.string().nullable(),
  content_sha256: z.string().nullable(),
  source_accuracy: z.array(sourceAccuracySchema).nullable(),
});

export type SourceCheck = z.infer<typeof sourceCheckSchema>;

export function parseSourceCheck(value: unknown): SourceCheck | null {
  const parsed = sourceCheckSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A source-sample label for text clients, with the audit's size, interval and method. */
export function formatSourceAccuracy(check: SourceCheck | null): string {
  if (!check?.source_accuracy?.length) return "";
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  return [
    "Source sample audits (sampled records from this source; not certainty for this policy):",
    ...check.source_accuracy.map((audit) =>
      `- ${audit.field}: ${percent(audit.accuracy)} matched in ${audit.sample_size} sampled records; 95% interval ${percent(audit.ci_low)}–${percent(audit.ci_high)}; sampled ${audit.sampled_at}; method ${audit.method}`,
    ),
  ].join("\n");
}
