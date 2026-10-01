---
name: policy-change-review
description: Summarize recent medical policy changes that Backwork tracks for a payer or code, and say what to do about each. Use when asked what changed in payer or Medicare policies.
---

# Policy change review

Summarize recent policy changes for a payer or a code, then give concrete follow-up actions for each change.

The tools come from the Backwork MCP server. Their names start with `backwork_`. Some clients add a prefix, for example `mcp__plugin_backwork_backwork__backwork_policy_research`. If no Backwork tool is available, tell the user to connect Backwork (https://backworkhealth.com/mcp) and stop. Do not answer from general knowledge.

## Ground rules

- **Research support, not a determination.** Report what changed in the policy. Do not tell the user how a payer will decide a claim. End every answer with: "Confirm with the payer before you change billing or PA practice."
- **No PHI.** Never ask for or accept patient names, member IDs, dates of birth, MRNs, addresses, or chart notes. If the user pastes any, do not repeat it. Ask them to remove it. Send only payer, codes, state, and dates to the tools.
- **Cite from tool output only.** Each change needs: policy number (`policy_id`), title, change date, effective date, and source URL. Add the last-verified date when the tool returns it. A field the tool did not return is written "not returned". Never fill it in from memory.
- **Use the tool's summary.** Use `change_summary` as returned. If it is empty, write "No summary returned" and fetch the policy. Do not invent what changed.
- **Inferred codes are not document-backed.** A code with `source: inferred_title_match` is attached because the policy title names the drug. The document does not list the code. Label it "Inferred from policy title. Confirm in the document."
- **Say when you don't know.** If no changes come back for the window, say so and give the window you checked.

## Steps

1. Get the inputs: a payer or one or more codes, and a time window. Default to the last 90 days. Convert the window to an ISO 8601 `since` timestamp.
2. Find the policies in scope.
   - For codes: call `backwork_coverage_lookup` with `procedure_codes`, `include: ["code_details"]`, and `code_include: ["policies"]`. Collect the `policy_id` values.
   - For a payer: call `backwork_policy_research` with `action: "search"`, `payer`, `status: "all"`, and `limit: 50`. Add a `query` if the user named a topic. Collect the `policy_id` values.
3. Get the changes. Call `backwork_policy_research` with `action: "changes"` and `since`.
   - With ten or fewer policies in scope, call it once per `policy_id`.
   - Otherwise call it once without `policy_id` and keep only changes whose `policy_id` is in your set. The `changes` action does not filter by payer. Follow `cursor` while more results are available.
4. For each change of type `criteria_changed`, `codes_changed`, or `retired`, call `backwork_policy_research` with `action: "get"`, `policy_id`, and `include: ["criteria", "codes"]` to get the current version.
5. Optional: if the user asks about their organization's review queue, call `backwork_compliance_review` with `action: "stats"`, then `action: "list_unreviewed"`. The hosted server is read-only. Tell the user to acknowledge changes in the Backwork app.
6. Write the answer in the format below.

## Follow-up actions by change type

- `criteria_changed`: update PA checklists, documentation templates, and front-desk scripts for the affected codes.
- `codes_changed`: check which codes were added or removed. Check charge-master mappings and any inferred codes.
- `retired`: find the replacement policy with `action: "search"`. Until you find one, treat the codes as having no policy on file.
- `created`: check whether the new policy adds PA or documentation rules for services you bill.
- `updated` or `metadata_changed`: check the new effective date. Usually no workflow change.

## Output format

```
Policy changes: <payer or codes>, <since date> to today

| Date | Policy | Change | Summary (from Backwork) | Action |
| <changed_at> | <policy_id> "<title>" | <change_type> | <change_summary or "No summary returned"> | <action> |

Details:
- <policy_id>: current effective date <date>; criteria or codes that changed, quoted from the tool output.

Sources:
- <policy_id>, "<title>", <payer/authority>, effective <date>, <source_url>, last verified <date>

Confirm with the payer before you change billing or PA practice.
```

## Examples

**Example 1: payer, last 30 days**

User: "What changed in Cigna medical policies in the last 30 days?"

1. `backwork_policy_research` with `action: "search"`, `payer: "Cigna"`, `status: "all"`, `limit: 50`. Follow the cursor to collect all policy IDs.
2. `backwork_policy_research` with `action: "changes"` and `since` set to 30 days ago. Keep only Cigna policy IDs.
3. `action: "get"` on each `criteria_changed` or `retired` policy. Fill the table.

**Example 2: codes, default window**

User: "Any policy changes for 97110 and 97140?"

1. `backwork_coverage_lookup` with `procedure_codes: ["97110", "97140"]`, `include: ["code_details"]`, `code_include: ["policies"]`.
2. `backwork_policy_research` with `action: "changes"`, `since` 90 days ago, once per policy ID.
3. If nothing changed, say "No changes found for the policies that list 97110 or 97140 since <date>," and list the policies you checked.
