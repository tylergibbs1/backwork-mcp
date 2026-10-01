# Installing the Backwork MCP Server

These steps are for an AI agent (for example Cline) that installs MCP servers for a user.

Backwork gives read access to Medicare and commercial payer policies, prior authorization checks, claim risk and medical code lookup, with the source documents cited. The user needs a Backwork account (https://backworkhealth.com). Calls count against the organization's request credits.

There are two ways to connect. Try option 1 first. Use option 2 if the client cannot complete the OAuth login, or if the user needs write actions (webhook management, compliance acknowledgements).

## Option 1: Hosted server with OAuth (no API key)

Add this entry under `mcpServers` in the client's MCP settings file. For Cline, that is `cline_mcp_settings.json` (open it from the MCP Servers view, **Configure MCP Servers**). Keep any servers that are already there.

```json
{
  "mcpServers": {
    "backwork": {
      "type": "streamableHttp",
      "url": "https://backworkhealth.com/mcp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Then:

1. Save the file. The server shows as needing authentication, because the endpoint answers `401` until the user logs in.
2. Ask the user to click **Authenticate** on the `backwork` server in the MCP Servers view, log in to Backwork in the browser, and approve the consent screen.
3. When the server shows as connected, check that tools named `backwork_*` are listed.

Do not put an API key in `headers` for this URL. The hosted endpoint accepts only OAuth access tokens. The OAuth grant is read-only (scope `backwork:mcp read`).

If the login fails (for example the browser shows `invalid_redirect_uri`), remove this entry and use option 2.

## Option 2: Local server with npx and an API key

Requirements: Node.js 18 or later, and a Backwork live API key (`bwk_live_...`). The user creates the key in the Backwork app under **API Keys** (https://backworkhealth.com/keys). Ask the user for the key. Do not invent one.

Add this entry under `mcpServers`, with the user's key in place of `bwk_live_YOUR_API_KEY`:

```json
{
  "mcpServers": {
    "backwork": {
      "command": "npx",
      "args": ["-y", "@backwork/mcp"],
      "env": {
        "BACKWORK_API_KEY": "bwk_live_YOUR_API_KEY"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Save the file. The client starts the server with `npx`. Check that tools named `backwork_*` are listed.

A `bwk_test_` key works only on the sandbox API. To use one, also set `"BACKWORK_API_BASE": "https://backworkhealth.com/api/sandbox/v1"` in `env`.

## Check the installation

Ask the assistant a question that calls a tool, for example:

> Is CPT 76942 covered in Texas, and does it require prior authorization?

When the API returns policy documents, the tool output ends with a `--- Sources ---` block that lists them.

## Troubleshooting

- `Backwork API key missing` (option 2): `BACKWORK_API_KEY` is not set in `env`, or the server was not restarted after the change.
- `401` on option 2: the key is wrong or revoked. Ask the user for a new key.
- No `backwork_*` tools after option 1: the OAuth login did not finish. Run **Authenticate** again, or use option 2.

More: https://backworkhealth.com/docs/mcp. Support: support@backworkhealth.com.
