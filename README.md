# Sabia Claude Code Usage plugin

Connects Claude Code's built-in OpenTelemetry **metrics** exporter to Sabia. The browser flow mints an organization-scoped, revocable ingestion key, and the bundled script writes the exporter variables into the `env` block of `~/.claude/settings.json`.

Only token counts are exported. `OTEL_LOGS_EXPORTER` and `OTEL_TRACES_EXPORTER` are set to `none`, so prompts, responses, tool arguments and file contents never leave the machine. This is the only path by which Max or Pro subscription usage reaches the Costs page — subscription traffic never appears in Anthropic's Admin or API cost surfaces.

From the plugin directory:

```text
node scripts/sabia.mjs connect
node scripts/sabia.mjs status
node scripts/sabia.mjs disconnect
```

Claude Code reads `env` when a session starts, so **start a new session** after connecting; the one that ran the command keeps exporting nothing.

The browser connection uses the public Sabia app at
`https://app1.sabiapartners.ca`. Set `SABIA_APP_URL` only when testing another
Sabia deployment.

Use `connect --base-url http://127.0.0.1:3000` against a local Sabia server. Reconnecting rotates the key with overlap. Disconnect revokes the current key before restoring whatever the managed variables held beforehand.

Settings live in `$CLAUDE_CONFIG_DIR` when that is set, `~/.claude` otherwise. `--settings` and `--state` override both paths.

See [`docs/claude-code-otel-connector.md`](../../docs/claude-code-otel-connector.md) for what Sabia does with the metrics once they arrive.
