# Backwork plugin for Claude

Payer coverage-policy research for Medicare and commercial payers, inside Claude Code. The plugin connects Claude to the hosted Backwork MCP server (`https://backworkhealth.com/mcp`). It adds four skills that call Backwork's tools in a fixed order and cite every policy they use.

This is research support. The skills report what payer policies say, with citations. They do not make coverage or medical-necessity decisions. Always confirm with the payer before you act.

## Install

In Claude Code:

```text
/plugin marketplace add tylergibbs1/backwork-mcp
/plugin install backwork@backwork
```

From a shell:

```bash
claude plugin marketplace add tylergibbs1/backwork-mcp
claude plugin install backwork@backwork
```

## Sign in

The plugin connects to Backwork with OAuth. You do not need an API key.

1. Start Claude Code and run `/mcp`.
2. Select `plugin:backwork:backwork`. It shows "Needs authentication".
3. Finish the browser sign-in and the Backwork consent screen.

New Backwork accounts start with 100 free credits. Each tool call uses your organization's request credits. The OAuth grant is read-only. Webhook management and compliance acknowledgements are not available through the plugin; use them in the Backwork app.

## Skills

| Skill | Run it with | What it does |
| --- | --- | --- |
| `prior-auth-research` | `/backwork:pa` or `/backwork:prior-auth-research` | Checks whether a payer requires prior authorization for CPT/HCPCS codes. Lists the documentation criteria with citations, flags inferred codes and gaps, and gives a submission checklist. |
| `coverage-check` | `/backwork:coverage` or `/backwork:coverage-check` | Answers "is code X covered by payer Y" with the policy disposition, conditions, and citation. |
| `policy-change-review` | `/backwork:policy-change-review` | Summarizes recent policy changes for a payer or code, and says what to update for each change. |
| `claim-denial-appeal-prep` | `/backwork:claim-denial-appeal-prep` | Finds the policy that governed the date of service for denied codes. Drafts an appeal-letter outline that quotes only criteria Backwork returned. |

You can also ask in plain language. Claude picks the skill from your question. Examples:

```text
/backwork:pa Humana 64493 M47.816 FL
/backwork:coverage UnitedHealthcare J0585
What changed in Cigna medical policies in the last 30 days?
Medicare in Ohio denied 64483 with CO-50 for 2026-03-12. Help me prep the appeal.
```

## What every skill does

- **Cites sources.** Each policy has its policy number, title, payer, effective date, and source URL, taken from the tool output.
- **Labels inferred codes.** Backwork marks some codes `inferred_title_match`. These codes are attached because the policy title names the drug, and the document does not list them. The skills label them "Inferred from policy title. Confirm in the document." They never present them as listed in the document.
- **Says when it doesn't know.** If Backwork has no policy on file, the skill says so. It does not fill gaps from general knowledge.
- **Refuses PHI.** Do not enter patient names, member IDs, dates of birth, MRNs, or chart notes. The skills ask only for codes, payer, state, plan type, and dates.

## Use the skills in claude.ai

The same skills work in claude.ai. See [Claude.ai skills](../../README.md#claudeai-skills) in the repository README.

## Links

- Backwork docs: https://backworkhealth.com/docs
- MCP server and tools: [repository README](../../README.md)
- Support: support@backworkhealth.com
