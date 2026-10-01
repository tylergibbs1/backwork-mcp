---
name: claim-denial-appeal-prep
description: Find the payer policy criteria that govern denied CPT or HCPCS codes with Backwork, and draft a cited appeal-letter outline. Use when preparing a claim denial appeal.
---

# Claim denial appeal prep

Given denied codes and a payer, find the policy that governed the date of service, pull its criteria, and draft an appeal-letter outline that cites the policy. The user fills in the clinical facts from their own records.

The tools come from the Backwork MCP server. Their names start with `backwork_`. Some clients add a prefix, for example `mcp__plugin_backwork_backwork__backwork_policy_research`. If no Backwork tool is available, tell the user to connect Backwork (https://backworkhealth.com/mcp) and stop. Do not answer from general knowledge.

## Ground rules

- **Research support, not a determination.** Do not state that the denial is wrong, that the service was medically necessary, or that the appeal will succeed. The outline shows which policy criteria the record must show. End every answer with: "Confirm the policy version and appeal process with the payer before you file."
- **No PHI.** Never ask for or accept patient names, member IDs, dates of birth, MRNs, claim numbers, addresses, or chart notes. If the user pastes any, do not repeat it. Ask them to remove it. Use placeholders such as `[Member ID]` in the letter. Send only codes, payer, state, plan type, date of service, and denial reason codes to the tools.
- **Quote only what the tools return.** Put policy language in quotation marks only when it is verbatim from tool output. Never write or reconstruct policy text. If the tools did not return the criterion text, write "[Criterion text not returned. Copy it from <source_url>.]"
- **Cite from tool output only.** Each policy citation needs: policy number (`policy_id`), title, payer or authority, effective date, and source URL. Add the last-verified date when the tool returns it. A field the tool did not return is written "not returned".
- **Inferred codes are not document-backed.** A code with `source: inferred_title_match` is attached because the policy title names the drug. The document does not list the code. Never cite an inferred code as listed in the policy. Tell the user to confirm the code in the document before the appeal relies on it.
- **Say when you don't know.** If no policy for the payer covers the date of service, say so. Do not build an appeal on a different payer's policy or a policy that took effect after the date of service.

## Steps

1. Get the inputs: payer, denied codes, date of service (required). Optional: denial reason codes (CARC/RARC), diagnosis codes, state, plan type, modifiers.
2. Call `backwork_coverage_lookup` with `procedure_codes`, `payer`, `state`, `plan_type`, `diagnosis_codes`, `date_of_service`, `include: ["code_details", "claim_risk"]`, and `code_include: ["policies"]`.
3. Find the governing policy. Call `backwork_policy_research` with `action: "search"`, `payer`, `query` set to the code or service, and `status: "all"`. Retired policies may have governed an older date of service. Keep the policy whose effective date is on or before the date of service.
4. Call `backwork_policy_research` with `action: "get"`, `policy_id`, and `include: ["criteria", "codes"]`. Read the code's `source` and the indications, limitations, and documentation criteria.
5. If the governing policy has changed since the date of service, call `backwork_policy_research` with `action: "changes"` and that `policy_id` to see what differs.
6. Call `backwork_claim_validation` with `procedure_codes`, `diagnosis_codes`, `payer`, `state`, `date_of_service`, and `modifiers` to get documentation requirements and denial-risk reasons. Compare them with the denial reason.
7. Write the outline below.

## Output format

```
Appeal outline: <codes> denied by <payer>, date of service <date>

Governing policy: <policy_id>, "<title>", effective <date>, <source_url>
Code evidence: <Listed in document | Inferred from policy title. Confirm in the document before you rely on it.>
Denial reason given: <CARC/RARC or "not provided">

Letter outline
1. Header: [Provider name, NPI], [Payer appeals address], [Member ID], [Claim number], date of service <date>
2. Request: reconsideration of <codes> under <policy_id>.
3. Governing policy: <policy_id>, "<title>", effective <date>.
4. Criteria and supporting records:
   a. "<verbatim criterion from tool output>" [<policy_id>, <section>]
      Record that shows it: [fill in from the chart]
5. Response to the denial reason: <map the denial reason to the criterion it questions>
6. Enclosures: [ ] policy excerpt  [ ] <records named by the criteria>

Gaps: <criteria with no supporting record named yet, inferred-only codes, policy version unclear>

Sources:
- <policy_id>, "<title>", <payer/authority>, effective <date>, <source_url>, last verified <date>

Confirm the policy version and appeal process with the payer before you file.
```

## Examples

**Example 1: medical necessity denial**

User: "Medicare in Ohio denied 64483 with CO-50 for date of service 2026-03-12. Diagnosis M54.16."

1. `backwork_coverage_lookup` with `procedure_codes: ["64483"]`, `payer: "Medicare"`, `state: "OH"`, `plan_type: "traditional_medicare"`, `diagnosis_codes: ["M54.16"]`, `date_of_service: "2026-03-12"`, `include: ["code_details", "claim_risk"]`, `code_include: ["policies"]`.
2. `backwork_policy_research` `action: "search"` with `query: "epidural steroid injection"`, `payer: "Medicare"`, `status: "all"`. Pick the LCD for Ohio's MAC jurisdiction in effect on 2026-03-12. Then `action: "get"` on it.
3. `backwork_claim_validation` with the same codes, diagnosis, state, and date.
4. Fill the outline. CO-50 is a medical necessity denial, so map it to the indications criteria. Quote each criterion exactly as the tool returned it.

**Example 2: drug code, inferred match**

User: "Aetna denied J0585 for 2026-05-02, reason CO-197."

Run steps 2 to 6 with `payer: "Aetna"`, `procedure_codes: ["J0585"]`, `date_of_service: "2026-05-02"`. If the botulinum toxin policy shows J0585 with `source: inferred_title_match`, write that in "Code evidence" and in "Gaps", and do not state in the letter that the policy lists J0585. CO-197 means no precertification, so map it to the policy's PA requirement and add "[Prior authorization reference, if one was obtained]" to the header.
