---
name: coverage-check
description: Check whether a payer covers a CPT or HCPCS code with Backwork. Returns the policy disposition, coverage conditions, and a citation. Use for questions like is code X covered by payer Y.
---

# Coverage check

Answer "is code X covered by payer Y" from Backwork policy data, with a citation for every statement.

The tools come from the Backwork MCP server. Their names start with `backwork_`. Some clients add a prefix, for example `mcp__plugin_backwork_backwork__backwork_coverage_lookup`. If no Backwork tool is available, tell the user to connect Backwork (https://backworkhealth.com/mcp) and stop. Do not answer from general knowledge.

## Ground rules

- **Research support, not a determination.** Report what the policy says. Never say a service "is covered" or "is medically necessary" for a patient. End every answer with: "Confirm with the payer before you submit or schedule."
- **No PHI.** Never ask for or accept patient names, member IDs, dates of birth, MRNs, addresses, or chart notes. If the user pastes any, do not repeat it. Ask them to remove it, and continue with codes, payer, state, plan type, and policy as-of date only. Send only those values to the tools.
- **Cite from tool output only.** Each policy citation needs: policy number (`policy_id`), title, payer or authority, effective date, and source URL. Add the last-verified date when the tool returns it. A field the tool did not return is written "not returned". Never fill it in from memory.
- **Inferred codes are not document-backed.** A code with `source: inferred_title_match` is attached because the policy title names the drug. The document does not list the code. Label it "Inferred from policy title. Confirm in the document." A code with `source: document` (or no `source`) is listed in the document.
- **Say when you don't know.** If the tools return no policy for this payer and code, say "Backwork has no policy on file for <payer> and <code>." Do not guess and do not substitute another payer's policy without saying so.

## Steps

1. Get the inputs: payer, one or more CPT/HCPCS codes. Optional: state (two letters), plan type, policy as-of date (the date whose policy version applies). If payer or code is missing, ask for it.
2. Call `backwork_coverage_lookup` with `procedure_codes`, `payer`, `state`, `plan_type`, `date_of_service` (the policy as-of date), `include: ["code_details", "prior_auth"]`, and `code_include: ["policies"]`.
3. From the returned policies, keep the ones that match the payer (for traditional Medicare: NCDs, and LCDs or Articles for the state's MAC jurisdiction). If none match, call `backwork_policy_research` with `action: "search"`, `query` set to the code (or drug name for a J-code), and `payer`.
4. For each matching policy (at most three), call `backwork_policy_research` with `action: "get"`, `policy_id`, and `include: ["criteria", "codes"]`. Read the code's `source` and the indications and limitations criteria.
5. Write the answer in the format below.

## Output format

```
Coverage research: <code> for <payer> [<state>, <plan type>]

Policy disposition (as written): <Listed with conditions | Listed as not covered or investigational | Not addressed | No policy on file | Conflicting policies>
Code evidence: <Listed in document | Inferred from policy title. Confirm in the document.>

Conditions (quoted or closely paraphrased from the tool output):
- <criterion> [<policy_id>]

Prior authorization signal: <what the prior_auth module returned, or "not returned">

Sources:
- <policy_id>, "<title>", <payer/authority>, effective <date>, <source_url>, last verified <date>

Confirm with the payer before you submit or schedule.
```

## Examples

**Example 1: traditional Medicare, procedure code**

User: "Is CPT 76942 covered by Medicare in Texas?"

1. `backwork_coverage_lookup` with `procedure_codes: ["76942"]`, `payer: "Medicare"`, `state: "TX"`, `plan_type: "traditional_medicare"`, `include: ["code_details", "prior_auth"]`, `code_include: ["policies"]`.
2. Keep the NCDs and the LCDs or Articles for Texas's MAC jurisdiction. Call `backwork_policy_research` `action: "get"` on each.
3. Answer in the format above. If only Articles that list 76942 come back and no LCD sets conditions, say the code is listed but Backwork returned no coverage conditions.

**Example 2: commercial payer, drug code with an inferred match**

User: "Does UnitedHealthcare cover J0585?"

1. `backwork_coverage_lookup` with `procedure_codes: ["J0585"]`, `payer: "UnitedHealthcare"`, `plan_type: "commercial"`, `code_include: ["policies"]`.
2. Suppose the returned UnitedHealthcare drug policy shows J0585 with `source: inferred_title_match`. Write "Code evidence: Inferred from policy title. Confirm in the document." Do not write that the policy lists J0585. Cite the policy's source URL so the user can check the code list.
