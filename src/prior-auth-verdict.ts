import { z } from "zod";

/**
 * The one reading of a Backwork prior-auth answer that the text output and the
 * UI components share. The API's `pa_required` is a plain boolean, and its
 * empty result sends `false` with `coverage_status: "unknown"`; read on its
 * own it says "not required" when the check found nothing. Only this module
 * reads `pa_required`, so every surface shows "unknown" for that case.
 *
 * An unknown verdict carries no reason: the API's reason for it ("No coverage
 * policies found...") describes only the prior-auth check's scope, and shown
 * beside policies from a code lookup it contradicts them.
 */
export const priorAuthVerdictSchema = z.discriminatedUnion("verdict", [
  z.object({
    verdict: z.enum(["required", "not_required"]),
    confidence: z.string().nullable(),
    reason: z.string().nullable(),
  }),
  z.object({
    verdict: z.literal("unknown"),
    confidence: z.string().nullable(),
    reason: z.null(),
  }),
]);

export type PriorAuthVerdict = z.infer<typeof priorAuthVerdictSchema>;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function verdict(paRequired: unknown, confidence: unknown, reason: unknown): PriorAuthVerdict {
  if (typeof paRequired !== "boolean") return { verdict: "unknown", confidence: text(confidence), reason: null };
  return { verdict: paRequired ? "required" : "not_required", confidence: text(confidence), reason: text(reason) };
}

/**
 * From an immediate prior-auth check (`POST /prior-auth/check`). "Not required"
 * needs a matched policy: with none, or with `coverage_status: "unknown"`, the
 * check has no evidence either way.
 */
export function parsePriorAuthCheck(check: unknown): PriorAuthVerdict {
  const data = isRecord(check) ? check : {};
  const matched = Array.isArray(data.matched_policies) && data.matched_policies.length > 0;
  const undecided = data.coverage_status === "unknown" || (data.pa_required === false && !matched);
  return verdict(undecided ? null : data.pa_required, data.confidence, data.reason);
}

/** From a payer-website research task's `result.determination`. */
export function parseResearchDetermination(determination: unknown): PriorAuthVerdict {
  const data = isRecord(determination) ? determination : {};
  return verdict(data.pa_required, data.confidence, data.reasoning);
}

const ANSWERS = { required: "YES", not_required: "NO", unknown: "UNKNOWN" } as const satisfies Record<PriorAuthVerdict["verdict"], string>;

/** "YES", "NO" or "UNKNOWN", for the text output. */
export function verdictAnswer(result: PriorAuthVerdict): (typeof ANSWERS)[PriorAuthVerdict["verdict"]] {
  return ANSWERS[result.verdict];
}
