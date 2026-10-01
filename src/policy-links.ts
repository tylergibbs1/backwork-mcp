import { httpUrl } from "./provenance.js";

/**
 * Where "Open policy" goes. Backwork's public page when the API response
 * identifies one; otherwise the policy's source document.
 *
 * Public pages (backwork-platform `web/src/app/policy`):
 * - Medicare LCDs, Articles and NCDs: /policy/<policy_id>
 * - Commercial policies: /policy/payer/<payer-slug>/<policy_id>. The platform
 *   assigns payer slugs (with collision suffixes), and the API does not return
 *   them, so commercial policies link to their source until it does.
 */

export const BACKWORK_SITE = "https://backworkhealth.com";

/** The policy types that have a public Medicare page; mirrors PUBLIC_MEDICARE_POLICY_TYPES in the platform. */
const PUBLIC_MEDICARE_POLICY_TYPES: ReadonlySet<string> = new Set(["LCD", "Article", "NCD"]);

export type PublicPolicyPage =
  | { kind: "medicare"; policyId: string }
  | { kind: "commercial"; payerSlug: string; policyId: string };

export type PolicyLink = { kind: "backwork" | "source"; url: string };

export function publicPolicyUrl(page: PublicPolicyPage): string {
  const segments = page.kind === "medicare" ? ["policy", page.policyId] : ["policy", "payer", page.payerSlug, page.policyId];
  return new URL(segments.map(encodeURIComponent).join("/"), `${BACKWORK_SITE}/`).toString();
}

/** The public page an API policy record identifies, if any. */
export function publicPolicyPage(policy: { policy_id: string; policy_type: string | null }): PublicPolicyPage | null {
  return policy.policy_type !== null && PUBLIC_MEDICARE_POLICY_TYPES.has(policy.policy_type)
    ? { kind: "medicare", policyId: policy.policy_id }
    : null;
}

export function policyLink(policy: { policy_id: string; policy_type: string | null; source_url: unknown }): PolicyLink | null {
  const page = publicPolicyPage(policy);
  if (page) return { kind: "backwork", url: publicPolicyUrl(page) };
  const source = httpUrl(policy.source_url);
  return source ? { kind: "source", url: source } : null;
}
