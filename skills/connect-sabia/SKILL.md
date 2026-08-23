---
name: connect-sabia
description: Connect, inspect, rotate, or disconnect Sabia's native Claude Code OpenTelemetry token export. Use when the user asks to connect Sabia, share Claude Code usage, check Sabia telemetry, rotate the ingestion credential, or disconnect Sabia.
---

# Sabia Claude Code usage

Use the bundled `scripts/sabia.mjs`; do not invent a token counter or read transcript files.

## Connect or rotate

1. Tell the user what this shares: token counts from Claude Code's native OpenTelemetry metrics export, and nothing else. Prompts, responses, tool arguments and file contents are never sent — logs and traces are turned off. It does not report invoice-confirmed spend.
2. Run `node <plugin-root>/scripts/sabia.mjs connect`. The script opens Sabia in the browser. If browser launch fails, give the printed URL to the user.
   Add `--raw-capture` or `--tool-output` **only** when the user has asked for what that flag shares — see the sections below. Never add either to make a connection "more useful". When the user wants their sessions on Sabia's **Output page**, that is `--tool-output`.
3. Wait while the user signs in and confirms **Share usage with <organization>**. The script receives the credential through the one-time device handoff and updates the `env` block in `~/.claude/settings.json`.
4. Report the selected organization and tell the user to **start a new Claude Code session** — the current one already read its environment and will keep exporting nothing. Re-running connect rotates the key with overlap.

The bundled production default is `https://app1.sabiapartners.ca`. Do not replace
it with a generated or preview Vercel URL. For local Sabia development, add
`--base-url http://127.0.0.1:3000`. For headless environments only, use
`configure --endpoint <url> --ingestion-key <key>`; browser connect is the
normal path.

## Raw capture

`connect --raw-capture` is a pre-production exploration mode with a different
privacy scope. Before running it, tell the user plainly that Claude Code will
export prompt text, tool decisions and results, model requests, and session and
prompt identifiers, that Sabia retains the complete envelopes, and that every
member of the organization can read them in Settings → Telemetry captures.
Confirm before running.

Sabia records the choice on the ingestion key at approval, so this is a real
grant rather than a local setting. Reconnecting without the flag clears the log
exporter and returns the connection to token counts only.

## Tool output

`connect --tool-output` is the grant that puts a session's work — pull
requests and issues created with `gh` — on Sabia's Output page. Before running
it, tell the user plainly that Claude Code will export tool result bodies and
the command lines that produced them (command output can include file contents
when a command echoes them), that Sabia keeps a reduced per-tool extract and
drops file-tool bodies, and that every member of the organization can read
what is kept. Prompt text and assistant responses are not exported by this
flag. Confirm before running.

Like raw capture, the grant is recorded on the ingestion key at approval;
reconnecting without the flag turns the trace export off. The two flags are
independent and can be combined.

Two expectations to set: only work done in **new** sessions after connecting
can appear, and identification depends on where the artifact's identity shows
up in what Claude Code exports. Command output is exported, so a PR or issue
created at the command line is identifiable from its stdout. MCP tool *create*
results are not exported by the client today, so a create whose only identity
is in the response cannot be identified; MCP *updates* that carry the
identifier in their arguments (an `issue_number`, a `pull_number`) still can.
This is a Claude Code client limitation, not a Sabia rule choice.

## Sync

Capture grants live in Sabia, and the plugin's SessionStart hook already runs
`sabia.mjs sync --quiet` to converge this machine on them. Run
`node <plugin-root>/scripts/sabia.mjs sync` by hand only when the user asks
why a grant changed in the app has not applied yet — and remember the change
lands at the start of the *next* session either way. Never edit the managed
env variables directly to force a grant; the app is the source of truth.

## Status

Run `node <plugin-root>/scripts/sabia.mjs status`. Never print or copy the full ingestion key.

## Disconnect

Run `node <plugin-root>/scripts/sabia.mjs disconnect`. It revokes the current key before restoring whatever the managed variables held beforehand. If Sabia is unreachable, leave the configuration intact and explain that the user can retry or revoke the device from Sabia Usage Connections. Use `--local-only` only when the user explicitly wants to remove local configuration without server revocation.

## Safety

- Keep `OTEL_LOGS_EXPORTER` at `none` unless the user explicitly chose raw capture, and `OTEL_TRACES_EXPORTER` at `none` unless the user explicitly chose tool output. Claude Code's log records and trace events carry conversational and tool content, and the default connector's promise is that only token metrics leave the machine.
- Never set `OTEL_LOG_RAW_API_BODIES` or `OTEL_LOG_ASSISTANT_RESPONSES`. Complete Messages API conversations are something no grant of this connector asks for, and assistant response text is explicitly outside the tool-output grant's consent copy. Let the script manage `OTEL_LOG_TOOL_CONTENT` and `OTEL_LOG_TOOL_DETAILS`; never set them by hand.
- Keep the temporality preference on `delta`. Cumulative export restates running totals, which Sabia rejects rather than double-counting — the visible symptom is silently missing usage.
- Preserve unrelated `settings.json` keys, and never rewrite the file if it fails to parse.
- Keep the settings and state files mode `0600`; the settings file holds the ingestion key once connected.
- Never echo, log, or persist the ingestion key anywhere else.
