import { BACKWORK_SITE } from "./policy-links.js";

/**
 * Limits code-lookup policy matches to the payer the user named. The code
 * lookup endpoints take no payer filter and their policy matches carry no
 * payer field, so the payer is read from the policy's Backwork page
 * (`/policy/payer/{payer_slug}/{policy_id}` for commercial policies) or its
 * Medicare policy type.
 */

/** Whose policy a code-lookup match is. */
export type PolicyPayer = { kind: "medicare" } | { kind: "payer"; slug: string } | { kind: "unidentified" };

const MEDICARE_POLICY_TYPES: ReadonlySet<string> = new Set(["LCD", "ARTICLE", "NCD"]);
const MEDICARE_PAYER = /^(traditional |original )?medicare( part [ab])?$|^cms$/i;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function policyPayer(policy: JsonRecord): PolicyPayer {
  if (typeof policy.policy_type === "string" && MEDICARE_POLICY_TYPES.has(policy.policy_type.toUpperCase())) return { kind: "medicare" };
  if (typeof policy.public_url === "string") {
    try {
      const url = new URL(policy.public_url);
      const [, policySegment, payerSegment, slug] = url.pathname.split("/");
      if (url.origin === BACKWORK_SITE && policySegment === "policy" && payerSegment === "payer" && slug) return { kind: "payer", slug };
    } catch {
      // Not a URL: the payer stays unidentified.
    }
  }
  return { kind: "unidentified" };
}

/** The requested payer, as the policy matches can be compared with it. */
export type RequestedPayer = { kind: "medicare" } | { kind: "payer"; slugs: ReadonlySet<string> };

/**
 * Resolves the user's payer text. A prior-auth check sent with the same payer
 * names the payer each matched policy belongs to; those slugs are the API's own
 * resolution. The text itself also matches a slug spelled the same way.
 */
export function resolveRequestedPayer(payer: string, priorAuth: unknown): RequestedPayer {
  if (MEDICARE_PAYER.test(payer.trim())) return { kind: "medicare" };
  const slugs = new Set([slugify(payer)]);
  const matched = isRecord(priorAuth) && Array.isArray(priorAuth.matched_policies) ? priorAuth.matched_policies : [];
  for (const policy of matched) {
    const slug = isRecord(policy) && isRecord(policy.payer) ? policy.payer.slug : undefined;
    if (typeof slug === "string" && slug) slugs.add(slug);
  }
  return { kind: "payer", slugs };
}

function isRequestedPayer(policy: PolicyPayer, requested: RequestedPayer): boolean {
  if (requested.kind === "medicare") return policy.kind === "medicare";
  return policy.kind === "payer" && requested.slugs.has(policy.slug);
}

/** What the payer filter left out: distinct other payers (Medicare counts as one) and policies with no identifiable payer. */
export type OtherPayers = { payers: number; unidentified_policies: number };

/**
 * The code-lookup data (one lookup, or a batch's `results`) with each code's
 * `policies` limited to the requested payer, and a count of what was left out.
 */
export function limitCodeDetailsToPayer(codeDetails: unknown, requested: RequestedPayer): { codeDetails: unknown; others: OtherPayers } {
  const otherPayers = new Set<string>();
  let unidentified = 0;

  const limitLookup = (lookup: unknown): unknown => {
    if (!isRecord(lookup) || !Array.isArray(lookup.policies)) return lookup;
    const kept = lookup.policies.filter((policy) => {
      if (!isRecord(policy)) return false;
      const payer = policyPayer(policy);
      if (isRequestedPayer(payer, requested)) return true;
      if (payer.kind === "unidentified") unidentified += 1;
      else otherPayers.add(payer.kind === "medicare" ? "medicare" : payer.slug);
      return false;
    });
    return { ...lookup, policies: kept };
  };

  const limited =
    isRecord(codeDetails) && isRecord(codeDetails.results)
      ? {
          ...codeDetails,
          results: Object.fromEntries(Object.entries(codeDetails.results).map(([code, lookup]) => [code, limitLookup(lookup)])),
        }
      : limitLookup(codeDetails);
  return { codeDetails: limited, others: { payers: otherPayers.size, unidentified_policies: unidentified } };
}

/** One line for the text output, or null when nothing was left out. */
export function otherPayersNote(payer: string, codes: readonly string[], others: OtherPayers): string | null {
  const { payers, unidentified_policies: unidentified } = others;
  if (payers === 0 && unidentified === 0) return null;
  const otherPolicies = [
    payers ? `policies from ${payers} other payer${payers === 1 ? "" : "s"}` : null,
    unidentified ? `${unidentified} polic${unidentified === 1 ? "y" : "ies"} with no identified payer` : null,
  ]
    .filter(Boolean)
    .join(", and ");
  const listed = codes.length === 1 ? codes[0] : "these codes";
  return `Showing only ${payer} policies. Also listing ${listed}, not shown: ${otherPolicies}.`;
}
