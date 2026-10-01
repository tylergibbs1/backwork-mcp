---
name: prior-auth-research
description: Research whether a payer requires prior authorization for CPT or HCPCS codes with Backwork, and build a cited documentation checklist. Use for PA questions by payer and code.
---

# Prior authorization research

Given a payer and CPT/HCPCS codes (and optionally diagnosis codes and a state), find out whether the payer's policy requires prior authorization, list the documentation criteria with citations, flag gaps, and produce a submission checklist.

The tools come from the Backwork MCP server. Their names start with `backwork_`. Some clients add a prefix, for example `mcp__plugin_backwork_backwork__backwork_prior_auth_research`. If no Backwork tool is available, tell the user to connect Backwork (https://backworkhealth.com/mcp) and stop. Do not answer from general knowledge.

## Ground rules

- **Research support, not a determination.** Report what the policy says. Never say PA "will be approved" or that a service "is medically necessary". End every answer with: "Confirm with the payer before you submit or schedule."
- **No PHI.** Never ask for or accept patient names, member IDs, dates of birth, MRNs, addresses, or chart notes. If the user pastes any, do not repeat it. Ask them to remove it, and continue with codes, payer, state, plan type, and date of service only. Send only those values to the tools.
- **Cite from tool output only.** Each policy citation needs: policy number (`policy_id`), title, payer or authority, effective date, and source URL. Add the last-verified date when the tool returns it. A field the tool did not return is written "not returned". Never fill it in from memory.
- **Inferred codes are not document-backed.** A code with `source: inferred_title_match` is attached because the policy title names the drug. The document does not list the code. Label it "Inferred from policy title. Confirm in the document." A code with `source: document` (or no `source`) is listed in the document.
- **Say when you don't know.** If the tools return no PA rule or policy, write "Not determinable from Backwork data" and say what is missing. Do not guess.

## Steps

1. Get the inputs: payer and codes (required). Optional: diagnosis codes, state, plan type. Ask for payer or code if missing.
2. Get the PA signal.
   - Traditional Medicare: call `backwork_prior_auth_research` with `action: "check"`, `procedure_codes`, and `state`.
   - Any other payer (commercial, Medicare Advantage, Medicaid): call `backwork_prior_auth_research` with `action: "start_research"`, `procedure_codes`, `payer`, `state`, and `diagnosis_codes`. If the result has a `research_id` and is not complete, call `action: "get_research"` with that `research_id` up to three times. If it is still running, give the `research_id` to the user and continue with the policy evidence.
3. Get the policy evidence. Call `backwork_coverage_lookup` with `procedure_codes`, `payer`, `state`, `diagnosis_codes`, `include: ["code_details", "prior_auth"]`, and `code_include: ["policies"]`.
4. For each policy that matches the payer (at most three), call `backwork_policy_research` with `action: "get"`, `policy_id`, and `include: ["criteria", "codes"]`. Read the code's `source` and the criteria sections.
5. If the criteria are thin, call `backwork_policy_research` with `action: "criteria"`, `query` set to the code or service name, and `section: "documentation"`.
6. If diagnosis codes were given, call `backwork_claim_validation` with `procedure_codes`, `diagnosis_codes`, `payer`, and `state` to get documentation requirements and denial-risk notes.
7. Write the answer in the format below.

## Output format

```
Prior authorization research: <codes> for <payer> [<state>]

PA required? <Yes, per policy | No, per policy | Not determinable from Backwork data> [<policy_id or research_id>]

Codes:
| Code | In policy | Evidence |
| <code> | <policy_id> | Listed in document / Inferred from policy title. Confirm in the document. |

Documentation criteria:
1. <criterion text from tool output> [<policy_id>, <section>]

Gaps and open questions:
- <codes with no policy, inferred-only codes, research still running, diagnosis not addressed>

Submission checklist:
- [ ] <one line per criterion: the record or form that shows it>
- [ ] Confirm PA rule and submission channel with <payer>

Sources:
- <policy_id>, "<title>", <payer/authority>, effective <date>, <source_url>, last verified <date>

Confirm with the payer before you submit or schedule.
```

## Examples

**Example 1: Medicare Advantage, procedure with diagnosis**

User: "Does Humana Medicare Advantage need PA for 64493 in Florida? Diagnosis M47.816."

1. `backwork_prior_auth_research` with `action: "start_research"`, `procedure_codes: ["64493"]`, `payer: "Humana"`, `state: "FL"`, `diagnosis_codes: ["M47.816"]`. Poll with `get_research` if needed.
2. `backwork_coverage_lookup` with the same codes, payer, and state, `include: ["code_details", "prior_auth"]`, `code_include: ["policies"]`.
3. `backwork_policy_research` `action: "get"` on the Humana facet joint policy. List each criterion it returns (for example, prior conservative care or diagnostic block results) with the policy number.
4. `backwork_claim_validation` with `procedure_codes: ["64493"]`, `diagnosis_codes: ["M47.816"]`, `payer: "Humana"`, `state: "FL"`.
5. Fill the template. Under gaps, note anything the research task did not finish.

**Example 2: commercial payer, drug code**

User: "PA requirements for J0585 with Aetna commercial."

Run steps 2 to 5. If J0585 shows `source: inferred_title_match` on the Aetna botulinum toxin policy, mark it inferred in the codes table, add "J0585 is inferred from the policy title. Check the policy's code list." to the gaps, and keep the checklist tied only to criteria the tools returned.
