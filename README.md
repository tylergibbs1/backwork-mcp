# Backwork MCP Server

[![npm](https://img.shields.io/npm/v/@backwork/mcp)](https://www.npmjs.com/package/@backwork/mcp)

Official Model Context Protocol (MCP) server for the [Backwork API](https://backworkhealth.com). It gives AI assistants controlled access to Medicare and payer medical policies, medical code intelligence, prior authorization checks, claim validation, compliance review, drug formulary evidence, and webhook operations.

There are two ways to connect:

| | Hosted remote | Local stdio |
| --- | --- | --- |
| Endpoint | `https://backworkhealth.com/mcp` (Streamable HTTP) | `npx -y @backwork/mcp` |
| Auth | OAuth in the browser, no key to copy | `BACKWORK_API_KEY=bwk_live_...` |
| Use when | Your client supports remote MCP with OAuth | Your client only runs local commands, or you want the server on your machine |

The hosted endpoint only accepts OAuth. Do not send a Backwork API key as a bearer token to `https://backworkhealth.com/mcp`. The OAuth grant is read-only (`backwork:mcp read`), so the hosted server offers only read actions: no webhook management and no compliance acknowledgements. Use local stdio with a write-scoped live key for those.

Calls draw on your organization's request credits, like any other `/api/v1` call. A `bwk_test_` key works only on the sandbox (`https://backworkhealth.com/api/sandbox/v1`), which covers policy search, code lookup, prior-auth check and coverage evaluation; to use it, set `BACKWORK_API_BASE` to that URL.

## Claude Code

```bash
claude mcp add backwork --transport http https://backworkhealth.com/mcp
```

Add `--scope user` to make it available in every project. Then run `claude`, open `/mcp`, select `backwork`, and finish the browser login and Backwork consent screen. Check it with `claude mcp get backwork`.

If OAuth discovery needs to be pinned explicitly, add the same server as JSON:

```bash
claude mcp add-json backwork '{
  "type": "http",
  "url": "https://backworkhealth.com/mcp",
  "oauth": {
    "scopes": "backwork:mcp read"
  }
}'
```

Local stdio:

```bash
claude mcp add backwork -e BACKWORK_API_KEY=bwk_live_YOUR_API_KEY -- npx -y @backwork/mcp
```

## Claude Desktop

Hosted remote: open **Settings > Connectors > Add custom connector**, name it `Backwork`, and enter `https://backworkhealth.com/mcp`. Claude Desktop runs the OAuth login when you connect.

Local stdio: add this to `claude_desktop_config.json` (**Settings > Developer > Edit Config**) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "backwork": {
      "command": "npx",
      "args": ["-y", "@backwork/mcp"],
      "env": {
        "BACKWORK_API_KEY": "bwk_live_YOUR_API_KEY"
      }
    }
  }
}
```

## Cursor

Add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project). Cursor opens the OAuth login the first time it connects:

```json
{
  "mcpServers": {
    "backwork": {
      "url": "https://backworkhealth.com/mcp"
    }
  }
}
```

Local stdio:

```json
{
  "mcpServers": {
    "backwork": {
      "command": "npx",
      "args": ["-y", "@backwork/mcp"],
      "env": {
        "BACKWORK_API_KEY": "bwk_live_YOUR_API_KEY"
      }
    }
  }
}
```

## VS Code

```bash
code --add-mcp '{"name":"backwork","type":"http","url":"https://backworkhealth.com/mcp"}'
```

Or add it to `.vscode/mcp.json` in a workspace. VS Code asks you to sign in when the server starts:

```json
{
  "servers": {
    "backwork": {
      "type": "http",
      "url": "https://backworkhealth.com/mcp"
    }
  }
}
```

Local stdio, with the key prompted for once and stored by VS Code:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "backwork-api-key",
      "description": "Backwork API key",
      "password": true
    }
  ],
  "servers": {
    "backwork": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@backwork/mcp"],
      "env": {
        "BACKWORK_API_KEY": "${input:backwork-api-key}"
      }
    }
  }
}
```

## Codex

```bash
codex mcp add backwork --env BACKWORK_API_KEY=bwk_live_YOUR_API_KEY -- npx -y @backwork/mcp
```

## Use in ChatGPT

ChatGPT connects to the hosted server as a custom MCP connection in developer mode. Three tools return a small card that ChatGPT renders inline above its answer.

1. In ChatGPT, open **Settings → Security and login** and turn on **Developer mode**. Your plan or workspace admin may need to allow it.
2. Go to [chatgpt.com/plugins](https://chatgpt.com/plugins) and select the **+** button.
3. Name it `Backwork`, add a short description, and under **Connection** enter `https://backworkhealth.com/mcp`. Choose **OAuth** for authentication.
4. Select **Create**. ChatGPT opens Backwork's sign-in page; approve the read-only `backwork:mcp read` grant.
5. Check the discovered tools, then start a new chat, add Backwork from the tools menu, and ask something like *"Is CPT 76942 covered in Texas, and does it need prior auth?"*

After a server update, open the connection at [chatgpt.com/plugins](https://chatgpt.com/plugins) and select **Refresh** so ChatGPT picks up new tool and component metadata.

| Tool | Card | What it shows |
| --- | --- | --- |
| `backwork_coverage_lookup` | Coverage result | Each policy that lists the codes: payer (`CMS` for Medicare policies), title and number, effective date, a row per code with its disposition badge and source label, and an **Open policy** link to the policy's Backwork page (Medicare LCDs, Articles, and NCDs) or, for other policies, its source document |
| `backwork_prior_auth_research` | Prior-auth checklist | The determination and confidence, codes that require prior auth, documentation to gather, known gaps, and numbered citations. A started research task shows as pending until you ask again |
| `backwork_policy_research` (`action: "compare"`) | Policy comparison | The codes side by side across Medicare contractors (MACs), one column per jurisdiction, with each cell's disposition and policy, and a coverage count per column |

A code that a policy lists only because its title names the drug is labelled **Inferred from policy title**, in the card and in the text. Confirm it against the document before relying on it.

The cards follow ChatGPT's light or dark theme, load nothing from the network (their CSP allows no domains), and open links through the host. They are [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps) resources (`text/html;profile=mcp-app`), so other MCP Apps hosts can render them too. Clients without UI support ignore the `_meta` keys that link tools to cards and get the same markdown text as before; `structuredContent.widget` carries the card's data.

## Other MCP Clients

Clients that run local commands can use the stdio config shown for Claude Desktop. Clients that support remote URLs with OAuth can use `https://backworkhealth.com/mcp` directly.

For clients that support only remote URLs with static headers, deploy a private self-hosted server in API-key or dual-auth mode (see [Self-Hosting](#self-hosting)) and send the key as a bearer header:

```json
{
  "mcpServers": {
    "backwork": {
      "url": "https://your-private-mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer bwk_live_YOUR_API_KEY"
      }
    }
  }
}
```

## Self-Hosting

Run a Streamable HTTP server:

```bash
git clone https://github.com/tylergibbs1/backwork-mcp.git
cd backwork-mcp
npm install
npm run build
npm run start:http
```

Defaults:

| Setting | Default | Override |
| --- | --- | --- |
| Transport | `stdio` | `--http` or `BACKWORK_MCP_TRANSPORT=http` |
| Host | `127.0.0.1` | `--host` or `BACKWORK_MCP_HOST` |
| Port | `3000` | `--port` or `BACKWORK_MCP_PORT` or `PORT` |
| MCP path | `/mcp` | `--path` or `BACKWORK_MCP_PATH` |
| Allowed hosts | loopback/private hosts, `VERCEL_URL`, or configured public host | `BACKWORK_MCP_ALLOWED_HOSTS` or `BACKWORK_MCP_PUBLIC_HOST` |

HTTP mode requires `Authorization: Bearer` per request. By default this bearer is a Backwork API key. For hosted remote MCP deployments, enable OAuth protected-resource discovery so Claude-compatible clients can authenticate users through your authorization server:

```bash
BACKWORK_MCP_AUTH_MODE=oauth \
BACKWORK_MCP_OAUTH_AUTHORIZATION_SERVERS=https://backworkhealth.com \
BACKWORK_MCP_OAUTH_SCOPES="backwork:mcp read" \
npm run start:http
```

The server publishes OAuth Protected Resource Metadata at `/.well-known/oauth-protected-resource` and includes that URL in `WWW-Authenticate` challenges. If your Backwork API accepts OAuth access tokens directly, no extra mapping is needed; the MCP server forwards the OAuth bearer downstream. If your authorization server exposes a Backwork API key in token introspection, set `BACKWORK_MCP_OAUTH_INTROSPECTION_URL` and `BACKWORK_MCP_OAUTH_API_KEY_CLAIM` to validate the access token and map it to the downstream Backwork credential.

For a private single-tenant deployment where the server environment supplies the key, set:

```bash
BACKWORK_MCP_ALLOW_ENV_KEY=true BACKWORK_API_KEY=bwk_live_YOUR_API_KEY npm run start:http
```

Only use `BACKWORK_MCP_ALLOW_ENV_KEY=true` on loopback or private-network deployments protected by network access control. Public deployments should require a bearer token per request, set `BACKWORK_MCP_ALLOWED_HOSTS`/`BACKWORK_MCP_PUBLIC_HOST`, and set `BACKWORK_MCP_ALLOWED_ORIGINS` only to exact browser origins that may connect.

### Vercel Hosting

This repo can deploy as an API-only Vercel project. The production project uses:

```bash
BACKWORK_MCP_AUTH_MODE=oauth
BACKWORK_MCP_PUBLIC_HOST=backworkhealth.com
BACKWORK_MCP_PUBLIC_URL=https://backworkhealth.com
BACKWORK_MCP_ALLOWED_HOSTS=backworkhealth.com,mcp.backworkhealth.com,backwork-mcp.vercel.app
BACKWORK_MCP_OAUTH_AUTHORIZATION_SERVERS=https://backworkhealth.com
BACKWORK_MCP_OAUTH_RESOURCE=https://backworkhealth.com/mcp
BACKWORK_MCP_OAUTH_SCOPES="backwork:mcp read"
BACKWORK_MCP_OAUTH_REQUIRED_SCOPES=backwork:mcp
BACKWORK_MCP_OAUTH_INTROSPECTION_URL=https://backworkhealth.com/api/oauth/introspect
BACKWORK_MCP_OAUTH_EXPECTED_AUDIENCE=https://backworkhealth.com/mcp
```

The Vercel functions expose:

| Path | Purpose |
| --- | --- |
| `/mcp` | Streamable HTTP MCP endpoint |
| `/health` | Lightweight MCP server health check |
| `/.well-known/oauth-protected-resource` | OAuth protected-resource metadata when OAuth is configured |
| `/` | Basic endpoint metadata |

The Backwork web app that issues OAuth tokens must also be configured:

```bash
BACKWORK_OAUTH_ISSUER=https://backworkhealth.com
BACKWORK_OAUTH_SIGNING_SECRET=<generate with: openssl rand -base64 48>
BACKWORK_MCP_RESOURCE=https://backworkhealth.com/mcp
```

Production OAuth discovery fails closed unless `BACKWORK_OAUTH_SIGNING_SECRET` is at least 32 characters and Redis or Vercel KV is configured for one-time consent and authorization-code storage.

Health check:

```bash
curl http://localhost:3000/health
```

## Local Development

```bash
npm install
npm run build
BACKWORK_API_KEY=bwk_live_YOUR_API_KEY npm start
```

Useful commands:

```bash
npm run start:http
node build/src/index.js --help
```

Requires Node.js 18 or newer.

## Available Tools

Tool names use the `backwork_` prefix for discoverability when this server is installed alongside other MCP servers. The default surface is intentionally workflow-level rather than a 1:1 API wrapper, so agents see fewer choices and common tasks require fewer tool calls.

All tools include `title`, `description`, `inputSchema`, `outputSchema`, and MCP annotations. Each tool states its own annotations; the server refuses to start if a tool marked read-only offers a write-scope operation, or one marked non-destructive offers a `DELETE`. Successful calls return readable text plus `structuredContent` with `message`, and when available, Backwork API `data` and `meta`.

`data` and `meta` are projections: they carry only the response fields `src/api-operations.ts` lists for the operation (`reads` and `metaReads`). Request IDs, response timestamps, record timestamps, research-job cost and polling URLs, idempotency keys, and model names are dropped. Policy effective and last-reviewed dates are kept. The server logs the request ID of a failed API call.

Tool-level failures return `isError: true`. Billing and rate-limit failures are reported in plain terms and never repeat the API's hint, plan names, or pricing links: a feature outside the organization's plan, no remaining request credits, or a rate limit with when to retry. `test/output-guard.test.mjs` runs every tool action against fixture responses and those errors, and fails on upsell wording, trace IDs, timestamps, cost, or model fields.

### Sources and currency

When the Backwork API response cites policy documents, `structuredContent.provenance` carries what an agent needs to cite them, and the text output ends with a short `--- Sources ---` block:

| Field | Meaning |
| --- | --- |
| `source_urls` | Distinct source document URLs |
| `authorities` | Issuing authorities, for example `CMS` or a payer name |
| `retrieved_at` | Oldest time Backwork fetched any cited source |
| `as_of` | Latest effective date among the cited sources |
| `sources[]` | `policy_id`, `source_url`, `authority`, `retrieved_at`, `as_of` per source |

Values are copied from the API response (`source_url`, `effective_date`, `last_verified_at`, the policy type, and the payer). A value the API did not return is `null`. The shape matches the `provenance` block on Backwork agent tool results, which is passed through unchanged.

### Production availability

Which actions a server offers depends on two things:

- **Availability.** The Backwork OpenAPI document can mark an operation `x-backwork-availability: unavailable-in-production`. Against the production API (`https://backworkhealth.com`) the server withholds those actions. None is marked today: production serves every `/api/v1` operation these tools call to an organization's live key.
- **Access.** Operations that need `write` scope (`x-backwork-required-scopes`) are withheld from a read-only OAuth grant. On the hosted server this hides `backwork_webhook_management` and the `acknowledge` and `bulk_acknowledge` actions of `backwork_compliance_review`. A read-only connection also gets no `backwork_system_health` diagnostics, no `idempotency_key` input on `backwork_claim_validation`, and a `backwork_compliance_review` with no acknowledgment inputs (`diff_id`, `diff_ids`, `notes`) and no diff IDs in its results. A Backwork API key (stdio, or HTTP with a `bwk_` bearer) is offered every tool and action, and the API enforces the key's own scopes. An OAuth grant counts as read-only unless its scopes include `write`.

A tool with no offered action is hidden. A partly offered tool drops the withheld actions from its `action` input; actions withheld as unavailable in production are also named in its description. A server pointed at another Backwork deployment with `BACKWORK_API_BASE` ignores availability markers, and `BACKWORK_MCP_EXPOSE_UNAVAILABLE_TOOLS=true` does the same against production. Neither lifts the write-scope rule.

| Primary tool | Purpose |
| --- | --- |
| `backwork_coverage_lookup` | Look up procedure codes and combine code details, policy evidence, prior authorization, claim risk, jurisdiction comparison, and spending evidence. With `payer`, code details list only that payer's policies and say how many other payers' policies were left out |
| `backwork_policy_research` | Search policies, fetch one policy, search extracted criteria, review policy changes, map MAC jurisdictions, or compare how MACs cover the same codes |
| `backwork_claim_validation` | Validate claim coverage, documentation requirements, denial risk, and optional policy-specific criteria |
| `backwork_prior_auth_research` | Check prior authorization from Backwork's policies (Medicare, or a named payer's), or start and poll a background job that searches public payer websites |
| `backwork_drug_formulary_research` | Search commercial pharmacy-benefit evidence from CVS Caremark, Express Scripts, and UnitedHealthcare / Optum Rx |
| `backwork_compliance_review` | Review compliance stats and list unreviewed policy changes; with an API key, also acknowledge changes |
| `backwork_webhook_management` | List, create, update, delete, or test webhook endpoints. Backwork sends one event, `compliance.acknowledged`; policy-change webhooks are not sent. Needs a write-scoped API key |
| `backwork_system_health` | Check Backwork API health and dependency status. API-key connections only |

### Response Format

Every tool accepts:

```json
{
  "response_format": "markdown"
}
```

Use `"markdown"` for readable output or `"json"` to make the text content mirror the returned `structuredContent`.

## Example Prompts

```text
Is CPT 76942 covered in Texas, and does it require prior authorization?
```

```text
Compare coverage for J0585 across JM and JH.
```

```text
Validate denial risk for 99213 with diagnosis E11.9 for Medicare in Texas.
```

```text
Search formulary evidence for Ozempic across commercial PBMs.
```

## Testing and Evaluations

Run the build and MCP metadata smoke test:

```bash
npm test
```

The smoke test starts the built stdio server with a dummy key, verifies the 8 workflow tools, checks titles, schemas, annotations, output schemas, `response_format`, and verifies local validation failures are reported with `isError: true`. The `test/` suite covers production availability, the hosted server's OAuth-only, read-only tool set, provenance, description quality and a lexical tool-selection check (no model calls), the registry manifest, and the ChatGPT cards: their templates in the tool list, the resources and mime type, each card's `structuredContent` against its schema, markdown for clients without UI, and a render of each card page in a stub browser.

### API contract

Every Backwork endpoint this server calls is listed in `src/api-operations.ts`, with the request fields it sends and the response fields it reads. Tools can only call the API through that catalog. Each entry also mirrors the operation's availability marker and required scope. `npm test` checks the catalog against the vendored `openapi/backwork-openapi.json`, and asks the server's own exposure rule which tool actions it would offer on production, for a read-only OAuth grant and for an API key. An action offered for an operation that production does not serve, marks unavailable, or (for the OAuth grant) guards with `write` scope fails.

CI runs `npm run contract:live`, which runs the same checks against `https://backworkhealth.com/openapi.json` and fails when the vendored copy differs from it anywhere except descriptions, summaries and examples.

When the Backwork API changes, refresh the vendored copy and review the diff:

```bash
npm run openapi:update
npm run contract:check
```

The `evals/` directory includes a tool-discoverability evaluation and a read-only data evaluation built from fixed source-backed policy/code records. Refresh the read-only answers intentionally when Backwork source data is updated.

## MCP Registry

`server.json` describes this server for the [official MCP registry](https://registry.modelcontextprotocol.io) as `io.github.tylergibbs1/backwork-mcp`: the hosted Streamable HTTP remote at `https://backworkhealth.com/mcp` (OAuth, discovered from the protected-resource metadata) and the `@backwork/mcp` npm package over stdio. `package.json` carries the matching `mcpName` that the registry uses to verify npm ownership. `npm test` validates `server.json` against the registry schema and checks that its versions match `package.json`.

## Release

Releases publish `@backwork/mcp` to npm with [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (GitHub OIDC, no npm token) and then publish `server.json` to the MCP registry.

1. `npm version minor` (or `patch`/`major`). The `version` script copies the new version into `server.json` and `SERVER_VERSION` in `src/index.ts`.
2. Merge that change to `main`.
3. Push a matching tag from `main`, for example `git tag v2.1.0 && git push origin v2.1.0`.

The `Release` workflow then:

1. Fails unless the tag equals `v` + the `package.json` version.
2. Runs `npm ci`, `npm test` (build, smoke tests, unit tests, OpenAPI contract), and `npm pack --dry-run`.
3. Publishes to npm with provenance, in the `npm` environment. A version already on npm is skipped, so a failed run can be re-run.
4. Waits for the version to appear on npm, then runs `mcp-publisher login github-oidc` and `mcp-publisher publish`.

One-time npm setup: on npmjs.com, open `@backwork/mcp` > **Settings** > **Trusted publishing**, choose GitHub Actions, and enter user `tylergibbs1`, repository `backwork-mcp`, workflow `release.yml`, environment `npm`.

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `BACKWORK_API_KEY` | Stdio yes; HTTP no | Backwork API key. In HTTP mode, prefer `Authorization: Bearer` per request. |
| `BACKWORK_API_BASE` | No | Override the API base URL. |
| `BACKWORK_MCP_TRANSPORT` | No | `stdio` or `http`. |
| `BACKWORK_MCP_HOST` | No | HTTP bind host. Defaults to `127.0.0.1`. |
| `BACKWORK_MCP_PORT` | No | HTTP bind port. |
| `BACKWORK_MCP_PATH` | No | HTTP MCP path. |
| `BACKWORK_MCP_ALLOWED_ORIGINS` | No | Comma-separated allowed HTTP origins. Loopback origins are allowed for loopback requests. |
| `BACKWORK_MCP_ALLOW_ORIGIN` | No | Backward-compatible alias for `BACKWORK_MCP_ALLOWED_ORIGINS`. |
| `BACKWORK_MCP_ALLOWED_HOSTS` | No | Comma-separated allowed HTTP Host headers for public deployments. |
| `BACKWORK_MCP_ALLOW_HOST` | No | Backward-compatible alias for `BACKWORK_MCP_ALLOWED_HOSTS`. |
| `BACKWORK_MCP_PUBLIC_HOST` | No | Primary public host allowed for HTTP requests. |
| `BACKWORK_MCP_PUBLIC_URL` | No | Canonical public origin for OAuth metadata, e.g. `https://backworkhealth.com`. |
| `BACKWORK_MCP_ALLOW_ENV_KEY` | No | Allow private HTTP requests without bearer auth to use `BACKWORK_API_KEY`. |
| `BACKWORK_MCP_AUTH_MODE` | No | HTTP bearer mode: `api-key`, `oauth`, or `dual`. Defaults to `dual` when OAuth authorization servers are configured, otherwise `api-key`. |
| `BACKWORK_MCP_OAUTH_AUTHORIZATION_SERVERS` | OAuth | Comma-separated OAuth issuer / authorization server URLs advertised in protected-resource metadata. |
| `BACKWORK_MCP_OAUTH_RESOURCE` | No | Override the RFC 8707 resource identifier. Defaults to the public MCP URL. |
| `BACKWORK_MCP_OAUTH_SCOPES` | No | Space- or comma-separated scopes advertised to clients. Defaults to `backwork:mcp`. |
| `BACKWORK_MCP_OAUTH_REQUIRED_SCOPES` | No | Space- or comma-separated scopes required after token introspection. |
| `BACKWORK_MCP_OAUTH_INTROSPECTION_URL` | No | RFC 7662 token introspection endpoint used to validate OAuth access tokens. |
| `BACKWORK_MCP_OAUTH_INTROSPECTION_CLIENT_ID` | No | Client ID for introspection basic auth. |
| `BACKWORK_MCP_OAUTH_INTROSPECTION_CLIENT_SECRET` | No | Client secret for introspection basic auth. |
| `BACKWORK_MCP_OAUTH_INTROSPECTION_TOKEN` | No | Bearer token for introspection when basic auth is not used. |
| `BACKWORK_MCP_OAUTH_API_KEY_CLAIM` | No | Dot-path claim from introspection response to use as the downstream Backwork credential. If omitted, the OAuth access token is forwarded. |
| `BACKWORK_MCP_OAUTH_EXPECTED_AUDIENCE` | No | Comma-separated allowed `aud` values when introspection responses include an audience. |
| `BACKWORK_MCP_EXPOSE_UNAVAILABLE_TOOLS` | No | `true` offers tools and actions the production API marks unavailable. Write-scope actions stay hidden from read-only OAuth grants. |

## Troubleshooting

### Missing API Key

For stdio, set `BACKWORK_API_KEY` in the MCP client configuration. For HTTP API-key mode, send `Authorization: Bearer <key>`. For HTTP OAuth mode, configure `BACKWORK_MCP_OAUTH_AUTHORIZATION_SERVERS` and send `Authorization: Bearer <access_token>`.

### 401 From HTTP MCP

The remote server did not receive a bearer token. Configure your MCP client to authenticate with OAuth or send an `Authorization` header. OAuth-enabled deployments include `resource_metadata` in the `WWW-Authenticate` header to point clients at `/.well-known/oauth-protected-resource`.

### Claude Code OAuth

If Claude Code does not open the browser, run `/mcp`, select `backwork`, and choose the authenticate action. If it gives you a URL instead of opening a browser, copy that URL into your browser.

If the browser redirect back to Claude Code fails after consent, copy the full callback URL from the browser address bar and paste it into the Claude Code prompt.

This server does not hold OAuth tokens. It validates each request's access token by introspection and forwards it (or the mapped API key) to the Backwork API. Refreshing an expired access token is the MCP client's job: when introspection reports a token inactive, the server answers `401` with `error="invalid_token"`, and the client can use its refresh token with the Backwork authorization server.

If Claude Code keeps using an old token, open `/mcp`, select `backwork`, clear authentication, then authenticate again. You can also remove and re-add the server with:

```bash
claude mcp remove backwork
claude mcp add --transport http --scope user backwork https://backworkhealth.com/mcp
```

If discovery returns `503`, the Backwork web app is intentionally refusing to advertise OAuth because production signing or Redis/KV state storage is missing.

If tool calls authenticate but fail with `invalid_token` or `invalid_target`, check that `BACKWORK_MCP_RESOURCE`, `BACKWORK_MCP_OAUTH_RESOURCE`, and `BACKWORK_MCP_OAUTH_EXPECTED_AUDIENCE` all use:

```text
https://backworkhealth.com/mcp
```

### Rate Limits

Wait for the reset window or use a higher-capacity API plan.

## Support

- Documentation: https://backworkhealth.com/docs
- Issues: https://github.com/tylergibbs1/backwork-mcp/issues
- Email: support@backworkhealth.com

## License

MIT. See [LICENSE](LICENSE).

## Claude Code plugin

The `backwork` plugin bundles the hosted MCP server with four research skills: prior authorization, coverage checks, policy changes, and denial appeal prep. Install it from this repository's plugin marketplace:

```text
/plugin marketplace add tylergibbs1/backwork-mcp
/plugin install backwork@backwork
```

Then run `/mcp`, select `plugin:backwork:backwork`, and finish the OAuth sign-in. New accounts start with 100 free credits. See [plugins/backwork/README.md](plugins/backwork/README.md) for the skills and the `/backwork:pa` and `/backwork:coverage` commands.

The marketplace manifest is [.claude-plugin/marketplace.json](.claude-plugin/marketplace.json). `npm test` checks the manifests and every `SKILL.md`. CI also runs `claude plugin validate --strict` on the marketplace and the plugin.

## Claude.ai skills

The same four skills work in claude.ai. They need the Backwork connector to call tools.

1. Add the connector: **Settings > Connectors > Add custom connector**, name it `Backwork`, and enter `https://backworkhealth.com/mcp`. Finish the OAuth sign-in.
2. Build one zip per skill. The zips go to `dist/claude-skills/`, which git ignores:

   ```bash
   node scripts/build-claude-skills.mjs
   ```

   Each zip holds the skill folder at its root, for example `coverage-check.zip` contains `coverage-check/SKILL.md`. The build fails if a `SKILL.md` breaks the claude.ai rules (name matches its folder, description 200 characters or fewer).
3. Upload each zip: open **Customize > Skills** (in older versions, **Settings > Capabilities > Skills**), click **Add**, and select the zip. Custom skills need a Pro, Max, Team, or Enterprise plan with code execution turned on. Each user uploads their own copy.
