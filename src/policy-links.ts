import { httpUrl } from "./provenance.js";

/**
 * Where "Open policy" goes. Backwork's public page when the policy has one;
 * otherwise the policy's source document.
 *
 * The API names the page itself: every v1 policy object carries `public_url`,
 * a Backwork page URL or null (backwork-platform `web/src/lib/public-policy-url.ts`).
 * - A Backwork page URL is used as given.
 * - null means the policy has no public page (a retired Medicare document, a
 *   commercial policy without a successor), so the link is its source.
 * - An absent field (an API that predates it) falls back to inferring the
 *   page: Medicare LCDs, Articles and NCDs live at /policy/<policy_id>.
 */

export const BACKWORK_SITE = "https://backworkhealth.com";

/** The policy types that have a public Medicare page; mirrors PUBLIC_MEDICARE_POLICY_TYPES in the platform. */
const PUBLIC_MEDICARE_POLICY_TYPES: ReadonlySet<string> = new Set(["LCD", "Article", "NCD"]);

export type PublicPolicyPage =
  | { kind: "medicare"; policyId: string }
  | { kind: "commercial"; payerSlug: string; policyId: string };

export type PolicyLink = { kind: "backwork" | "source"; url: string };

/** An API policy record, as far as linking reads it. */
export type PolicyLinkRecord = {
  policy_id: string;
  policy_type: string | null;
  source_url: unknown;
  /** The API's `public_url`; undefined when the response has no such field. */
  public_url?: unknown;
};

export function publicPolicyUrl(page: PublicPolicyPage): string {
  const segments = page.kind === "medicare" ? ["policy", page.policyId] : ["policy", "payer", page.payerSlug, page.policyId];
  return new URL(segments.map(encodeURIComponent).join("/"), `${BACKWORK_SITE}/`).toString();
}

/** The public page inferred from the policy type, for API responses without `public_url`. */
export function publicPolicyPage(policy: { policy_id: string; policy_type: string | null }): PublicPolicyPage | null {
  return policy.policy_type !== null && PUBLIC_MEDICARE_POLICY_TYPES.has(policy.policy_type)
    ? { kind: "medicare", policyId: policy.policy_id }
    : null;
}

/** The API's `public_url` when it is a policy page on Backwork's own site; anything else is not trusted as one. */
function backworkPageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.origin === BACKWORK_SITE && url.pathname.startsWith("/policy/") ? url.toString() : null;
  } catch {
    return null;
  }
}

function sourceLink(sourceUrl: unknown): PolicyLink | null {
  const source = httpUrl(sourceUrl);
  return source ? { kind: "source", url: source } : null;
}

export function policyLink(policy: PolicyLinkRecord): PolicyLink | null {
  const page = backworkPageUrl(policy.public_url);
  if (page) return { kind: "backwork", url: page };
  if (policy.public_url === null) return sourceLink(policy.source_url);

  const inferred = publicPolicyPage(policy);
  if (inferred) return { kind: "backwork", url: publicPolicyUrl(inferred) };
  return sourceLink(policy.source_url);
}
