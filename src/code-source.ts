import type { OperationId } from "./api-operations.js";

/**
 * Why a code is attached to a policy (the `CodeSource` component in the
 * Backwork OpenAPI document).
 * - document: listed in the payer's policy document.
 * - inferred_title_match: attached because the policy title names the drug;
 *   the document itself does not list the code.
 */
export const CODE_SOURCES = ["document", "inferred_title_match"] as const;
export type CodeSource = (typeof CODE_SOURCES)[number];

/** A code entry after parsing: `source` is always present. */
export type SourcedCode = Record<string, unknown> & { source: CodeSource };

export class CodeSourceParseError extends Error {
  constructor(value: unknown) {
    super(`Backwork API returned an unrecognized code source ${JSON.stringify(value)}; expected ${CODE_SOURCES.join(" or ")}.`);
    this.name = "CodeSourceParseError";
  }
}

/** Responses from before the field existed omit it; those codes all came from the document. */
export function parseCodeSource(value: unknown): CodeSource {
  if (value === undefined || value === null) return "document";
  if ((CODE_SOURCES as readonly unknown[]).includes(value)) return value as CodeSource;
  throw new CodeSourceParseError(value);
}

const INFERRED_NOTE = " — inferred from policy title (not listed in the document)";

/** Text to append to a rendered code line. Empty for codes listed in the document. */
export function codeSourceNote(source: CodeSource): string {
  switch (source) {
    case "document":
      return "";
    case "inferred_title_match":
      return INFERRED_NOTE;
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(entry: unknown): unknown {
  return isRecord(entry) ? { ...entry, source: parseCodeSource(entry.source) } : entry;
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
 * operation returns has a `source`. Throws CodeSourceParseError on a value
 * outside the documented enum.
 */
export function parseCodeSources(operationId: OperationId, data: unknown): unknown {
  const parse = PARSERS[operationId];
  return parse ? parse(data) : data;
}
