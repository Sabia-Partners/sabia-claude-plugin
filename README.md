# Sabia Claude Code Usage plugin

Connects Claude Code's built-in OpenTelemetry **metrics** exporter to Sabia. The browser flow mints an organization-scoped, revocable ingestion key, and the bundled script writes the exporter variables into the `env` block of `~/.claude/settings.json`.

By default only token counts are exported. `OTEL_LOGS_EXPORTER` and `OTEL_TRACES_EXPORTER` are set to `none`, so prompts, responses, tool arguments and file contents never leave the machine. This is the only path by which Max or Pro subscription usage reaches the Costs page — subscription traffic never appears in Anthropic's Admin or API cost surfaces.

From the plugin directory:

```text
node scripts/sabia.mjs connect
node scripts/sabia.mjs status
node scripts/sabia.mjs disconnect
```

## Raw capture (pre-production, opt-in)

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
`https://app1.sabiapartners.ca`. Set `SABIA_APP_URL` only when testing another
Sabia deployment.

Use `connect --base-url http://127.0.0.1:3000` against a local Sabia server. Reconnecting rotates the key with overlap. Disconnect revokes the current key before restoring whatever the managed variables held beforehand.

Settings live in `$CLAUDE_CONFIG_DIR` when that is set, `~/.claude` otherwise. `--settings` and `--state` override both paths.

See [`docs/claude-code-otel-connector.md`](../../docs/claude-code-otel-connector.md) for what Sabia does with the metrics once they arrive.
