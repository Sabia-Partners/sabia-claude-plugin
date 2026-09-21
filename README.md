# Sabia for Claude Code

Connects completed work and native Claude Code usage to your team's Sabia
workspace. The installed identifier stays **sabia-claude-code-otel** so existing
installations keep their identity. License: **UNLICENSED**.

**Release status:** 0.3.0-beta.1 is unreleased source for review and a controlled
pilot. The bundled configuration targets `app2.sabiapartners.ca`. Your Sabia
contact must confirm that your workspace and the matching backend are ready
before onboarding.

You can authorize two separate connections. Connecting one does not authorize
the other.

| Connection | What it shares | What you see in Sabia |
| --- | --- | --- |
| Completed-work reporting | Metadata about work Claude Code produced — an action, a short title, the artifact type, its provider reference and identifiers, and available evidence references. No document bodies, prompts or transcripts go through the report tool. Titles and references can still contain sensitive information. | Records of completed work, such as a created pull request or a revised Google Doc, with separate statuses for the artifact check and the reported action. |
| Native Claude Code usage | Token counts from Claude Code's built-in OpenTelemetry metrics export, and nothing else by default. Opt-in grants add raw capture or tool output, described below. | Native usage records. These are not invoice-confirmed costs and are not attributed to a particular reported artifact. |

## Completed-work reporting

The plugin bundles Sabia's hosted MCP server as `sabia-artifacts`
([`.mcp.json`](.mcp.json)). Nothing runs locally: Claude Code talks to
`https://app2.sabiapartners.ca/api/mcp/artifacts` over HTTP with OAuth, and the
bundled [`report-artifact`](skills/report-artifact/SKILL.md) skill tells Claude
when and how to call `report_artifact` after a qualifying create, update, send,
publish or deliver.

To connect, run `/mcp` in Claude Code, choose
`plugin:sabia-claude-code-otel:sabia-artifacts`, sign in to Sabia, pick your
organization and approve artifact metadata sharing. Access tokens last one hour
and refresh without further prompts until you revoke the connection in Sabia's
Settings → Artifact reporting. `/mcp` → the same server → *Clear authentication*
disconnects this machine; it does not delete previously accepted records.

Claude Code has no dynamic client registration against Sabia's authorization
server, so the plugin presents the pre-registered public client
`sabia-claude-code` with a fixed OAuth callback on port `45711`. The backend
must list that client with the exact redirect URI
`http://localhost:45711/callback` and the `claude_code` application in
`ARTIFACT_REPORTING_OAUTH_CLIENTS` before anyone can connect — see
[`docs/claude-code-otel-connector.md`](../../docs/claude-code-otel-connector.md).
If port 45711 is taken on a machine, the sign-in fails with a redirect error;
free the port and retry rather than editing the client entry.

The reporting tools appear under their scoped names, for example
`mcp__plugin_sabia-claude-code-otel_sabia-artifacts__report_artifact`. A report
records that work was done; it never performs the work, and a reporting failure
never means the original operation failed. Exact association of a report with
the native usage session that produced it is separate work (issue #12, step 2)
and is not claimed by this version.

## Native Claude Code usage

Connects Claude Code's built-in OpenTelemetry **metrics** exporter to Sabia. The browser flow mints an organization-scoped, revocable ingestion key, and the bundled script writes the exporter variables into the `env` block of `~/.claude/settings.json`.

By default only token counts are exported. `OTEL_LOGS_EXPORTER` and `OTEL_TRACES_EXPORTER` are set to `none`, so prompts, responses, tool arguments and file contents never leave the machine. This is the only path by which Max or Pro subscription usage reaches the Costs page — subscription traffic never appears in Anthropic's Admin or API cost surfaces.

From the plugin directory:

```text
node scripts/sabia.mjs connect
node scripts/sabia.mjs status
node scripts/sabia.mjs sync
node scripts/sabia.mjs disconnect
```

The plugin also runs `sync --quiet` from a SessionStart hook. Capture grants
are managed in Sabia — approved at connect, and changeable later by an owner
or administrator in Settings → Usage Connections — and sync converges this
machine on whatever is recorded there, so a grant changed in the app applies
from the next session without anyone re-running connect. Sync never touches
the ingestion key and stays silent when Sabia is unreachable.

### Raw capture (pre-production, opt-in)

`connect --raw-capture` is a different promise, and worth reading before running.
It turns on Claude Code's log export with `OTEL_LOG_USER_PROMPTS=1` and
`OTEL_LOG_TOOL_DETAILS=1`, and asks Sabia to retain the complete OTLP envelopes
so telemetry and Quality workflows can be shaped from real data. Your prompt
text, tool decisions and results, model requests, and session identifiers are
sent and stored, and every member of the organization can read them in
Settings → Telemetry captures.

Traces stay off, and so do `OTEL_LOG_TOOL_CONTENT` and
`OTEL_LOG_RAW_API_BODIES` — full file contents and complete Messages API
bodies are a separate decision this flag does not make.

The choice is recorded on the ingestion key when an owner or administrator
approves it in the browser, not on this machine, so an existing connection
cannot start retaining envelopes without a fresh approval. Reconnecting without
the flag clears the log exporter and returns to token counts only.

Claude Code reads `env` when a session starts, so **start a new session** after connecting; the one that ran the command keeps exporting nothing.

The browser connection uses the public Sabia app at
`https://app2.sabiapartners.ca`. Set `SABIA_APP_URL` only when testing another
Sabia deployment.

Use `connect --base-url http://127.0.0.1:3000` against a local Sabia server. Reconnecting rotates the key with overlap. Disconnect revokes the current key before restoring whatever the managed variables held beforehand.

Settings live in `$CLAUDE_CONFIG_DIR` when that is set, `~/.claude` otherwise. `--settings` and `--state` override both paths.

Adding artifact reporting changes none of this: the skill and MCP server do not
touch `settings.json`, cannot turn on raw capture or tool output, and do not
alter what the metrics exporter counts.

See [`docs/claude-code-otel-connector.md`](../../docs/claude-code-otel-connector.md) for what Sabia does with the metrics once they arrive.
