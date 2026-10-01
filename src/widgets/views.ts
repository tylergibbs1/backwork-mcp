import { codeSourceLabel, parseCodeSource } from "../code-source.js";
import { policyLink } from "../policy-links.js";
import { authorityOf, httpUrl } from "../provenance.js";
import type {
  ComparisonCell,
  CoverageCardView,
  CriteriaListView,
  JurisdictionListView,
  PolicyChangesView,
  PolicyComparisonView,
  PolicyDetailView,
  PolicyListView,
  PriorAuthChecklistView,
  WidgetCode,
  WidgetPolicy,
} from "./schemas.js";

/**
 * Builds the UI components' view models from Backwork API response data. This
 * is the parse boundary for the components: API data is untyped here, and
 * every builder returns a value that fits its schema in ./schemas.ts. A
 * builder returns null when the response has nothing to show, so the result
 * carries no view and the component collapses instead of showing an empty card.
 */

const MAX_POLICIES = 8;
const MAX_CODES_PER_POLICY = 20;
const MAX_COLUMNS = 6;
const MAX_LIST_ITEMS = 12;
const MAX_RESULTS = 8;
const MAX_CRITERIA = 6;
const MAX_JURISDICTIONS = 20;
const SUMMARY_CHARS = 280;
const EXCERPT_CHARS = 240;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function str(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function strings(value: unknown, limit = MAX_LIST_ITEMS): string[] {
  return (Array.isArray(value) ? value : []).map(str).filter((item): item is string => item !== null).slice(0, limit);
}

/** Collapses whitespace and cuts at a word boundary, so long policy text stays a compact excerpt. */
function excerpt(value: unknown, limit: number): string | null {
  const text = str(value)?.replace(/\s+/g, " ");
  if (!text || text.length <= limit) return text ?? null;
  const cut = text.slice(0, limit);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), limit - 20)).replace(/[\s,;:.]+$/, "")}…`;
}

/** The date part of an ISO date or timestamp. */
function isoDay(value: unknown): string | null {
  const text = str(value);
  return text && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function policyStatus(value: unknown): "active" | "retired" | null {
  const status = str(value);
  return status === "active" || status === "retired" ? status : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function widgetCode(code: string, record: JsonRecord, codeSystem: unknown = record.code_system): WidgetCode {
  const source = parseCodeSource(record.source);
  return {
    code,
    code_system: str(codeSystem),
    disposition: str(record.disposition),
    source: source.kind,
    source_label: codeSourceLabel(source),
  };
}

function widgetPolicy(record: JsonRecord): WidgetPolicy | null {
  const policyId = str(record.policy_id);
  if (!policyId) return null;
  const policyType = str(record.policy_type);
  return {
    policy_id: policyId,
    title: str(record.title) ?? policyId,
    policy_type: policyType,
    payer: authorityOf(record),
    jurisdiction: str(record.jurisdiction),
    effective_date: str(record.effective_date),
    link: policyLink({
      policy_id: policyId,
      policy_type: policyType,
      source_url: record.source_url,
      public_url: record.public_url,
    }),
  };
}

/** A code lookup's results: one lookup for a single code, or the `results` of a batch lookup. */
function codeLookups(codeDetails: unknown): JsonRecord[] {
  if (!isRecord(codeDetails)) return [];
  if (!("results" in codeDetails)) return [codeDetails];
  const results = codeDetails.results;
  if (Array.isArray(results)) return records(results);
  if (!isRecord(results)) return [];
  return Object.entries(results)
    .filter((entry): entry is [string, JsonRecord] => isRecord(entry[1]))
    .map(([code, lookup]) => ({ code, ...lookup }));
}

type PolicyGroup = WidgetPolicy & { codes: WidgetCode[] };

function addCode(groups: Map<string, PolicyGroup>, policy: WidgetPolicy, code: WidgetCode): void {
  const group = groups.get(policy.policy_id) ?? { ...policy, codes: [] };
  if (!group.codes.some((existing) => existing.code === code.code)) group.codes.push(code);
  groups.set(policy.policy_id, group);
}

export function buildCoverageCard(codesRequested: string[], data: { code_details?: unknown; prior_auth?: unknown }): CoverageCardView {
  const groups = new Map<string, PolicyGroup>();

  for (const lookup of codeLookups(data.code_details)) {
    const code = str(lookup.code);
    if (!code) continue;
    for (const match of records(lookup.policies)) {
      const policy = widgetPolicy(match);
      if (policy) addCode(groups, policy, widgetCode(code, match, lookup.code_system));
    }
  }

  const priorAuth = isRecord(data.prior_auth) ? data.prior_auth : undefined;
  for (const matched of records(priorAuth?.matched_policies)) {
    const policy = widgetPolicy(matched);
    if (!policy) continue;
    for (const entry of records(matched.codes)) {
      const code = str(entry.code);
      if (code) addCode(groups, policy, widgetCode(code, entry));
    }
  }

  const policies = [...groups.values()];
  return {
    kind: "coverage_card",
    codes_requested: codesRequested,
    prior_auth: priorAuth
      ? { required: bool(priorAuth.pa_required), confidence: str(priorAuth.confidence), reason: str(priorAuth.reason) }
      : null,
    policies: policies.slice(0, MAX_POLICIES).map((policy) => ({
      ...policy,
      codes: policy.codes.slice(0, MAX_CODES_PER_POLICY),
      codes_omitted: Math.max(0, policy.codes.length - MAX_CODES_PER_POLICY),
    })),
    policies_omitted: Math.max(0, policies.length - MAX_POLICIES),
  };
}

const emptyChecklist: Omit<PriorAuthChecklistView, "status"> = {
  kind: "prior_auth_checklist",
  research_id: null,
  pa_required: null,
  confidence: null,
  reason: null,
  mac: null,
  codes_requiring_pa: [],
  documentation: [],
  known_gaps: [],
  inferred_codes: [],
  citations: [],
};

/** From an immediate Medicare prior-auth check (`POST /prior-auth/check`). */
export function buildPriorAuthChecklist(check: unknown): PriorAuthChecklistView {
  const data = isRecord(check) ? check : {};
  const codesRequiringPa: PriorAuthChecklistView["codes_requiring_pa"] = [];
  const inferredCodes: PriorAuthChecklistView["inferred_codes"] = [];
  const citations: WidgetPolicy[] = [];

  for (const matched of records(data.matched_policies)) {
    const policy = widgetPolicy(matched);
    if (!policy) continue;
    citations.push(policy);
    for (const entry of records(matched.codes)) {
      const code = str(entry.code);
      if (!code) continue;
      const row = widgetCode(code, entry);
      const origin = { policy_id: policy.policy_id, policy_title: policy.title };
      if (row.disposition === "requires_pa") codesRequiringPa.push({ ...row, ...origin });
      if (row.source === "inferred_title_match") inferredCodes.push({ code, ...origin });
    }
  }

  const mac = isRecord(data.mac) ? data.mac : undefined;
  const macName = str(mac?.name);
  return {
    ...emptyChecklist,
    status: "complete",
    pa_required: bool(data.pa_required),
    confidence: str(data.confidence),
    reason: str(data.reason),
    mac: macName ? { name: macName, jurisdiction: str(mac?.jurisdiction) } : null,
    codes_requiring_pa: codesRequiringPa.slice(0, MAX_LIST_ITEMS * 2),
    documentation: strings(data.documentation_checklist).map((text) => ({ text, mandatory: null })),
    known_gaps: strings(data.known_gaps),
    inferred_codes: inferredCodes.slice(0, MAX_LIST_ITEMS),
    citations: citations.slice(0, MAX_POLICIES),
  };
}

const RESEARCH_STATUSES = {
  pending: "pending",
  running: "running",
  completed: "complete",
  failed: "failed",
  canceled: "canceled",
} as const satisfies Record<string, PriorAuthChecklistView["status"]>;

function researchStatus(value: unknown): PriorAuthChecklistView["status"] {
  const status = str(value);
  return status && status in RESEARCH_STATUSES ? RESEARCH_STATUSES[status as keyof typeof RESEARCH_STATUSES] : "pending";
}

/** From a payer-website research task (`POST /prior-auth/research` or `GET /prior-auth/research/{id}`). */
export function buildResearchChecklist(research: unknown): PriorAuthChecklistView {
  const data = isRecord(research) ? research : {};
  const result = isRecord(data.result) ? data.result : {};
  const determination = isRecord(result.determination) ? result.determination : {};
  const error = str(data.error);

  const citations = records(result.payer_policies)
    .map((policy): WidgetPolicy => {
      const name = str(policy.policy_name);
      const payer = str(policy.payer_name);
      const policyId = name ?? payer ?? "Payer policy";
      return {
        policy_id: policyId,
        title: name ?? str(policy.summary) ?? "Payer policy",
        policy_type: null,
        payer,
        jurisdiction: null,
        effective_date: str(policy.effective_date),
        link: policyLink({ policy_id: policyId, policy_type: null, source_url: policy.policy_url }),
      };
    })
    .slice(0, MAX_POLICIES);

  return {
    ...emptyChecklist,
    status: researchStatus(data.status),
    research_id: str(data.research_id),
    pa_required: bool(determination.pa_required),
    confidence: str(determination.confidence),
    reason: str(determination.reasoning),
    documentation: records(result.documentation_requirements)
      .map((item) => ({ text: str(item.requirement), mandatory: bool(item.mandatory) }))
      .filter((item): item is { text: string; mandatory: boolean | null } => item.text !== null)
      .slice(0, MAX_LIST_ITEMS),
    known_gaps: error ? [error] : [],
    citations,
  };
}

const emptyCell: ComparisonCell = { disposition: null, policy_id: null, source: null, source_label: null, more: 0 };

function comparisonCell(code: string, policies: JsonRecord[]): ComparisonCell {
  // Jurisdiction-specific policies first: they are what differs between columns.
  const ordered = [...policies.filter((policy) => policy.is_national !== true), ...policies.filter((policy) => policy.is_national === true)];
  const matches = ordered.flatMap((policy) =>
    records(policy.codes)
      .filter((entry) => str(entry.code) === code)
      .map((entry) => ({ policy, entry })),
  );
  const first = matches[0];
  if (!first) return emptyCell;
  const row = widgetCode(code, first.entry);
  return {
    disposition: row.disposition,
    policy_id: str(first.policy.policy_id),
    source: row.source,
    source_label: row.source_label,
    more: matches.length - 1,
  };
}

/** From a cross-jurisdiction comparison (`POST /policies/compare`). */
export function buildPolicyComparison(codesRequested: string[], compare: unknown): PolicyComparisonView {
  const data = isRecord(compare) ? compare : {};
  const summary = isRecord(data.summary) ? data.summary : {};
  const jurisdictions = records(data.comparison);
  const shown = jurisdictions.slice(0, MAX_COLUMNS);
  const queried = strings(summary.queried_codes, 10);
  const codes = queried.length ? queried : codesRequested;

  const policies = new Map<string, PolicyComparisonView["policies"][number]>();
  for (const policy of [...shown.flatMap((jurisdiction) => records(jurisdiction.policies)), ...records(data.national_policies)]) {
    const parsed = widgetPolicy(policy);
    if (parsed && !policies.has(parsed.policy_id)) policies.set(parsed.policy_id, { ...parsed, is_national: policy.is_national === true });
  }

  return {
    kind: "policy_comparison",
    codes,
    has_variation: bool(summary.has_variation),
    columns: shown.map((jurisdiction) => {
      const mac = isRecord(jurisdiction.mac) ? jurisdiction.mac : undefined;
      const coverage = isRecord(jurisdiction.coverage_summary) ? jurisdiction.coverage_summary : {};
      return {
        jurisdiction: str(jurisdiction.jurisdiction) ?? "Unknown",
        payer: str(mac?.name),
        states: strings(mac?.states, 60),
        coverage: {
          covered: count(coverage.covered),
          not_covered: count(coverage.not_covered),
          requires_pa: count(coverage.requires_pa),
          conditional: count(coverage.conditional),
        },
      };
    }),
    rows: codes.map((code) => ({
      code,
      cells: shown.map((jurisdiction) => comparisonCell(code, records(jurisdiction.policies))),
    })),
    policies: [...policies.values()].slice(0, MAX_LIST_ITEMS),
    unresolved_jurisdictions: strings(summary.unresolved_jurisdictions),
    columns_omitted: Math.max(0, jurisdictions.length - MAX_COLUMNS),
  };
}

/** The first `limit` items and how many were left out, or null when there are none. */
function shown<T>(items: T[], limit: number): { items: [T, ...T[]]; omitted: number } | null {
  const [first, ...rest] = items;
  if (first === undefined) return null;
  return { items: [first, ...rest.slice(0, limit - 1)], omitted: Math.max(0, items.length - limit) };
}

function hasMore(meta: unknown): boolean {
  return isRecord(meta) && isRecord(meta.pagination) && meta.pagination.has_more === true;
}

/** From a policy search (`GET /policies`). */
export function buildPolicyList(query: string | undefined, list: unknown, meta: unknown): PolicyListView | null {
  const policies = records(list)
    .map((record) => {
      const policy = widgetPolicy(record);
      return policy && { ...policy, status: policyStatus(record.status), summary: excerpt(record.summary, SUMMARY_CHARS) };
    })
    .filter((policy) => policy !== null);
  const page = shown(policies, MAX_RESULTS);
  return page && { kind: "policy_list", query: str(query), policies: page.items, policies_omitted: page.omitted, has_more: hasMore(meta) };
}

/** From one policy (`GET /policies/{id}`). */
export function buildPolicyDetail(detail: unknown): PolicyDetailView | null {
  const data = isRecord(detail) ? detail : {};
  const policy = widgetPolicy(data);
  if (!policy) return null;

  const criteria = Object.entries(isRecord(data.criteria) ? data.criteria : {})
    .map(([section, blocks]) => {
      const texts = records(blocks)
        .map((block) => excerpt(block.text, EXCERPT_CHARS))
        .filter((text) => text !== null);
      const [first] = texts;
      return first ? { section, text: first, more: texts.length - 1 } : null;
    })
    .filter((entry) => entry !== null);

  const codes = Object.entries(isRecord(data.codes) ? data.codes : {}).flatMap(([system, entries]) =>
    records(entries).flatMap((entry) => {
      const code = str(entry.code);
      return code ? [{ ...widgetCode(code, entry, system), display: excerpt(entry.display, 80) }] : [];
    }),
  );

  const macName = isRecord(data.mac) ? str(data.mac.name) : null;
  return {
    kind: "policy_detail",
    policy: {
      ...policy,
      payer: policy.payer ?? macName,
      status: policyStatus(data.status),
      last_reviewed_date: str(data.last_reviewed_date),
      summary: excerpt(data.summary ?? data.description, SUMMARY_CHARS * 2),
    },
    criteria: criteria.slice(0, MAX_CRITERIA),
    codes: codes.slice(0, MAX_LIST_ITEMS),
    codes_omitted: Math.max(0, codes.length - MAX_LIST_ITEMS),
  };
}

/** From a criteria search (`GET /coverage/criteria`). */
export function buildCriteriaList(query: string | undefined, list: unknown, meta: unknown): CriteriaListView | null {
  const items = records(list).flatMap((record) => {
    const nested = isRecord(record.policy) ? record.policy : {};
    const text = excerpt(record.text, EXCERPT_CHARS);
    const policy = widgetPolicy({
      ...record,
      policy_id: record.policy_id ?? nested.policy_id,
      title: record.policy_title ?? nested.title,
      public_url: nested.public_url,
    });
    return text && policy ? [{ section: str(record.section) ?? "other", text, policy }] : [];
  });
  const page = shown(items, MAX_CRITERIA);
  return page && { kind: "criteria_list", query: str(query), items: page.items, items_omitted: page.omitted, has_more: hasMore(meta) };
}

/** From the policy change feed (`GET /policies/changes`). */
export function buildPolicyChanges(list: unknown, meta: unknown): PolicyChangesView | null {
  const changes = records(list).flatMap((record) => {
    const policyId = str(record.policy_id);
    if (!policyId) return [];
    return [
      {
        change_type: str(record.change_type) ?? "updated",
        policy_id: policyId,
        policy_title: str(record.policy_title) ?? policyId,
        payer: authorityOf(record),
        changed_on: isoDay(record.changed_at),
        summary: excerpt(record.change_summary, EXCERPT_CHARS),
      },
    ];
  });
  const page = shown(changes, MAX_RESULTS);
  return page && { kind: "policy_changes", changes: page.items, changes_omitted: page.omitted, has_more: hasMore(meta) };
}

/** From the MAC jurisdiction list (`GET /jurisdictions`). */
export function buildJurisdictionList(list: unknown): JurisdictionListView | null {
  const jurisdictions = records(list).flatMap((record) => {
    const code = str(record.jurisdiction_code);
    return code
      ? [{ code, name: str(record.jurisdiction_name), mac: str(record.mac_name), states: strings(record.states, 60), website: httpUrl(record.website_url) }]
      : [];
  });
  const page = shown(jurisdictions, MAX_JURISDICTIONS);
  return page && { kind: "jurisdiction_list", jurisdictions: page.items, jurisdictions_omitted: page.omitted };
}
