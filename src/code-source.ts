import type { OperationId } from "./api-operations.js";

/**
 * Why a code is attached to a policy (the `CodeSource` component in the
 * Backwork OpenAPI document).
 * - document: listed in the payer's policy document.
 * - inferred_title_match: attached because the policy title names the drug;
 *   the document itself does not list the code.
 */
export type CodeSource =
  | { kind: "document" }
  | { kind: "inferred_title_match" }
  | { kind: "unrecognized"; raw: string };

/**
 * A code entry after the response boundary: `source` is always a string. It is
 * the API's own value, or "document" when an older response omitted it, so
 * JSON output passes an unrecognized value through unchanged.
 */
export type SourcedCode = Record<string, unknown> & { source: string };

/** Responses from before the field existed omit it; those codes all came from the document. */
export function parseCodeSource(value: unknown): CodeSource {
  if (value === undefined || value === null || value === "document") return { kind: "document" };
  if (value === "inferred_title_match") return { kind: "inferred_title_match" };
  return { kind: "unrecognized", raw: typeof value === "string" ? value : JSON.stringify(value) };
}

/** The wire value for a parsed source. */
function codeSourceValue(source: CodeSource): string {
  return source.kind === "unrecognized" ? source.raw : source.kind;
}

/** Text to append to a rendered code line. Empty only for codes listed in the document. */
export function codeSourceNote(value: string): string {
  const source = parseCodeSource(value);
  switch (source.kind) {
    case "document":
      return "";
    case "inferred_title_match":
      return " — inferred from policy title (not listed in the document)";
    case "unrecognized":
      return ` — source: ${source.raw} (unrecognized)`;
  }
}

/** Short label for a code's source, as the UI components show it. */
export function codeSourceLabel(source: CodeSource): string {
  switch (source.kind) {
    case "document":
      return "Listed in policy";
    case "inferred_title_match":
      return "Inferred from policy title";
    case "unrecognized":
      return `Source: ${source.raw}`;
  }
}

/** Code grounding is a retained-text check, separate from how the code was extracted. */
export function codeGroundingLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  switch (value) {
    case "grounded": return "Found in retained source text";
    case "not_grounded": return "Not found in retained source text";
    case "no_source_text": return "No retained source text to check";
    case "not_checked": return "Grounding not checked";
    default: return `Grounding: ${typeof value === "string" ? value : JSON.stringify(value)} (unrecognized)`;
  }
}

export function codeGroundingNote(value: unknown): string {
  const label = codeGroundingLabel(value);
  return label ? ` — ${label}` : "";
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(entry: unknown): unknown {
  return isRecord(entry) ? { ...entry, source: codeSourceValue(parseCodeSource(entry.source)) } : entry;
}

function parseEntries(entries: unknown): unknown {
  return Array.isArray(entries) ? entries.map(parseEntry) : entries;
}

/** Applies `parse` to `record[key]` when `record` is an object that has the key. */
function mapField(record: unknown, key: string, parse: (value: unknown) => unknown): unknown {
  if (!isRecord(record) || !(key in record)) return record;
  return { ...record, [key]: parse(record[key]) };
}

function mapItems(list: unknown, parse: (value: unknown) => unknown): unknown {
  return Array.isArray(list) ? list.map(parse) : list;
}

function mapValues(record: unknown, parse: (value: unknown) => unknown): unknown {
  if (Array.isArray(record)) return record.map(parse);
  if (!isRecord(record)) return record;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, parse(value)]));
}

/** A policy that carries a flat `codes` list. */
const policyWithCodes = (policy: unknown) => mapField(policy, "codes", parseEntries);
/** A code lookup result whose `policies` are the code's policy matches. */
const codeLookup = (lookup: unknown) => mapField(lookup, "policies", parseEntries);

const PARSERS: Partial<Record<OperationId, (data: unknown) => unknown>> = {
  lookupCode: codeLookup,
  batchLookupCodes: (data) => mapField(data, "results", (results) => mapValues(results, codeLookup)),
  checkPriorAuth: (data) => mapField(data, "matched_policies", (policies) => mapItems(policies, policyWithCodes)),
  listPolicies: (data) => mapItems(data, policyWithCodes),
  getPolicy: (data) => mapField(data, "codes", (bySystem) => mapValues(bySystem, parseEntries)),
  comparePolicies: (data) => {
    const withNational = mapField(data, "national_policies", (policies) => mapItems(policies, policyWithCodes));
    return mapField(withNational, "comparison", (jurisdictions) =>
      mapItems(jurisdictions, (jurisdiction) => mapField(jurisdiction, "policies", (policies) => mapItems(policies, policyWithCodes))),
    );
  },
};

/**
 * Parses the `data` of a successful response so that every code entry the
 * operation returns has a `source`.
 */
export function parseCodeSources(operationId: OperationId, data: unknown): unknown {
  const parse = PARSERS[operationId];
  return parse ? parse(data) : data;
}
