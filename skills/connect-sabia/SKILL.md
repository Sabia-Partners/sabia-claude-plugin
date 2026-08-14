---
name: connect-sabia
description: Connect, inspect, rotate, or disconnect Sabia's native Claude Code OpenTelemetry token export. Use when the user asks to connect Sabia, share Claude Code usage, check Sabia telemetry, rotate the ingestion credential, or disconnect Sabia.
---

# Sabia Claude Code usage

Use the bundled `scripts/sabia.mjs`; do not invent a token counter or read transcript files.

## Connect or rotate

1. Tell the user what this shares: token counts from Claude Code's native OpenTelemetry metrics export, and nothing else. Prompts, responses, tool arguments and file contents are never sent — logs and traces are turned off. It does not report invoice-confirmed spend.
2. Run `node <plugin-root>/scripts/sabia.mjs connect`. The script opens Sabia in the browser. If browser launch fails, give the printed URL to the user.
3. Wait while the user signs in and confirms **Share usage with <organization>**. The script receives the credential through the one-time device handoff and updates the `env` block in `~/.claude/settings.json`.
4. Report the selected organization and tell the user to **start a new Claude Code session** — the current one already read its environment and will keep exporting nothing. Re-running connect rotates the key with overlap.

The bundled production default is `https://app1.sabiapartners.ca`. Do not replace
it with a generated or preview Vercel URL. For local Sabia development, add
`--base-url http://127.0.0.1:3000`. For headless environments only, use
`configure --endpoint <url> --ingestion-key <key>`; browser connect is the
normal path.

## Status

Run `node <plugin-root>/scripts/sabia.mjs status`. Never print or copy the full ingestion key.

## Disconnect

Run `node <plugin-root>/scripts/sabia.mjs disconnect`. It revokes the current key before restoring whatever the managed variables held beforehand. If Sabia is unreachable, leave the configuration intact and explain that the user can retry or revoke the device from Sabia Settings. Use `--local-only` only when the user explicitly wants to remove local configuration without server revocation.

## Safety

- Keep `OTEL_LOGS_EXPORTER` and `OTEL_TRACES_EXPORTER` set to `none`. Claude Code's log records carry conversational content, and this connector's promise is that only token metrics leave the machine.
- Keep the temporality preference on `delta`. Cumulative export restates running totals, which Sabia rejects rather than double-counting — the visible symptom is silently missing usage.
- Preserve unrelated `settings.json` keys, and never rewrite the file if it fails to parse.
- Keep the settings and state files mode `0600`; the settings file holds the ingestion key once connected.
- Never echo, log, or persist the ingestion key anywhere else.
