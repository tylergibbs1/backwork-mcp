import { z } from "zod";

/**
 * Citation metadata for a tool result, in the same shape as the `provenance`
 * block on Backwork agent tool results: source URLs, when Backwork last
 * fetched each source, the effective date the answer reflects, and who issued
 * it. Values are copied from the API response; a value the API did not return
 * is null, never guessed.
 */

export const provenanceSourceSchema = z.object({
  policy_id: z.string().nullable(),
  source_url: z.string().nullable(),
  authority: z.string().nullable(),
  retrieved_at: z.string().nullable(),
  as_of: z.string().nullable(),
});

export const provenanceSchema = z
  .object({
    source_urls: z.array(z.string()).describe("Distinct source document URLs to cite."),
    authorities: z.array(z.string()).describe('Issuing authorities, for example "CMS" or a payer name.'),
    retrieved_at: z
      .string()
      .nullable()
      .describe("Oldest retrieval time among the cited sources: every source was fetched at or after this time."),
    as_of: z.string().nullable().describe("Latest effective date among the cited sources."),
    sources: z.array(provenanceSourceSchema),
  })
  .describe("Where the answer came from and how current it is. Cite source_urls when answering.");

export type ProvenanceSource = z.infer<typeof provenanceSourceSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;

const CMS_ISSUED_POLICY_TYPES = new Set(["LCD", "ARTICLE", "NCD", "CMS_PA_PROGRAM", "CMS_PA_DEMONSTRATION"]);
const MAX_DEPTH = 8;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The value as an http(s) URL, or null. */
export function httpUrl(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function isoDateTime(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** An explicit source check owns freshness, even when its fetch time is unknown. */
export function sourceFetchedAt(record: JsonRecord): string | null {
  if ("source_check" in record) {
    return isRecord(record.source_check) ? isoDateTime(record.source_check.last_fetched_at) : null;
  }
  return isoDateTime(record.retrieved_at ?? record.last_verified_at ?? record.crawled_at);
}

function isoDate(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate || !/^\d{4}-\d{2}-\d{2}/.test(candidate)) return null;
  const day = candidate.slice(0, 10);
  return Number.isNaN(new Date(`${day}T00:00:00Z`).getTime()) ? null : day;
}

/** Who issued a policy: "CMS" for Medicare policy types, otherwise the payer the record names. */
export function authorityOf(record: JsonRecord): string | null {
  const explicit = text(record.authority);
  if (explicit) return explicit;
  const policyType = text(record.policy_type);
  if (policyType && CMS_ISSUED_POLICY_TYPES.has(policyType.toUpperCase())) return "CMS";
  const payer = record.payer;
  return text(record.payer_name) ?? text(payer) ?? (isRecord(payer) ? text(payer.name) : null);
}

/** A record cites a source when it names a source document. */
function isSourceRecord(record: JsonRecord): boolean {
  const check = isRecord(record.source_check) ? record.source_check : null;
  return (
    ("source_url" in record || "source_check" in record) &&
    (text(record.policy_id) !== null || (httpUrl(check?.source_url) ?? httpUrl(record.source_url)) !== null)
  );
}

function sourceFromRecord(record: JsonRecord): ProvenanceSource {
  const check = isRecord(record.source_check) ? record.source_check : null;
  return {
    policy_id: text(record.policy_id) ?? text(record.source_id),
    source_url: httpUrl(check?.source_url) ?? httpUrl(record.source_url),
    authority: authorityOf(record),
    retrieved_at: sourceFetchedAt(record),
    as_of: isoDate(record.as_of ?? record.effective_date),
  };
}

function isProvenanceBlock(value: unknown): value is Provenance {
  return provenanceSchema.safeParse(value).success;
}

type SourceCandidate = { source: ProvenanceSource; checked: boolean };

function collect(value: unknown, depth: number, into: SourceCandidate[]): void {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) collect(item, depth + 1, into);
    return;
  }
  if (!isRecord(value)) return;

  // An upstream provenance block (Backwork agent tools) is passed through as is.
  if (isProvenanceBlock(value.provenance)) {
    into.push(...value.provenance.sources.map((source) => ({ source, checked: false })));
  }
  if (isSourceRecord(value)) into.push({ source: sourceFromRecord(value), checked: "source_check" in value });

  for (const [key, child] of Object.entries(value)) {
    // A source check is evidence for its parent policy, not a separate citation.
    if (key === "provenance" || key === "source_check") continue;
    collect(child, depth + 1, into);
  }
}

function distinct(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

/** One entry per cited document, respecting authoritative fetch checks across mentions. */
function mergeDuplicates(sources: readonly SourceCandidate[]): ProvenanceSource[] {
  const byDocument = new Map<string, SourceCandidate>();
  for (const candidate of sources) {
    const { source, checked } = candidate;
    const key = `${source.policy_id ?? ""}|${source.source_url ?? ""}`;
    const prior = byDocument.get(key);
    if (!prior) {
      byDocument.set(key, candidate);
      continue;
    }
    const seen = prior.source;
    // A new source check wins over legacy metadata, including an unknown time.
    // Conflicting checks remain conservative: both must have a known fetch time.
    const retrieved = checked !== prior.checked
      ? (checked ? source.retrieved_at : seen.retrieved_at)
      : checked
        ? (seen.retrieved_at && source.retrieved_at ? [seen.retrieved_at, source.retrieved_at].sort()[0] : null)
        : seen.retrieved_at ?? source.retrieved_at;
    byDocument.set(
      key,
      {
        checked: checked || prior.checked,
        source: {
          policy_id: seen.policy_id ?? source.policy_id,
          source_url: seen.source_url ?? source.source_url,
          authority: seen.authority ?? source.authority,
          retrieved_at: retrieved,
          as_of: seen.as_of ?? source.as_of,
        },
      },
    );
  }
  return [...byDocument.values()].map((candidate) => candidate.source);
}

function assembleProvenance(unique: ProvenanceSource[]): Provenance {
  const retrievedAt = distinct(unique.map((source) => source.retrieved_at)).sort();
  const asOf = distinct(unique.map((source) => source.as_of)).sort();
  return {
    source_urls: distinct(unique.map((source) => source.source_url)),
    authorities: distinct(unique.map((source) => source.authority)).sort(),
    retrieved_at: unique.every((source) => source.retrieved_at !== null) ? retrievedAt[0] ?? null : null,
    as_of: asOf.at(-1) ?? null,
    sources: unique,
  };
}

export function buildProvenance(sources: readonly ProvenanceSource[]): Provenance {
  return assembleProvenance(mergeDuplicates(sources.map((source) => ({ source, checked: false }))));
}

/** Provenance for an API response, or undefined when it cites no source. */
export function extractProvenance(data: unknown): Provenance | undefined {
  const sources: SourceCandidate[] = [];
  collect(data, 0, sources);
  return sources.length > 0 ? assembleProvenance(mergeDuplicates(sources)) : undefined;
}

/** A short citation footer for the readable text output. */
export function formatProvenance(provenance: Provenance, maxUrls = 5): string {
  const lines = ["--- Sources ---"];
  const currency = [
    provenance.as_of ? `effective ${provenance.as_of}` : null,
    provenance.retrieved_at ? `retrieved by Backwork on or after ${provenance.retrieved_at}` : null,
  ].filter(Boolean);
  if (provenance.authorities.length) lines.push(`Authority: ${provenance.authorities.join(", ")}`);
  if (currency.length) lines.push(`Currency: ${currency.join("; ")}`);
  if (provenance.retrieved_at === null) {
    const missing = provenance.sources.filter((source) => source.retrieved_at === null).length;
    lines.push(`Fetch time unknown for ${missing} of ${provenance.sources.length} cited sources.`);
  }
  provenance.source_urls.slice(0, maxUrls).forEach((url) => lines.push(`- ${url}`));
  const remaining = provenance.source_urls.length - maxUrls;
  if (remaining > 0) lines.push(`... ${remaining} more in structuredContent.provenance`);
  return lines.join("\n");
}
