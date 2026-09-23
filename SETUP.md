# Setting up Sabia for Claude Code

You need Claude Code with Node 22 or newer, and a Sabia workspace you can sign
in to. The two connections below are independent. Set up either one, or both.

## 1. Install

```text
/plugin marketplace add Sabia-Partners/sabia-claude-plugin
/plugin install sabia-claude-code-otel@sabia
```

## 2. Connect native usage

Ask Claude to **"connect Sabia"**. The `connect-sabia` skill runs
`scripts/sabia.mjs connect`, which:

1. opens Sabia in your browser (if it cannot, it prints the URL);
2. waits while you sign in and confirm **Share usage with &lt;organization&gt;**;
3. writes Claude Code's OpenTelemetry exporter settings into the `env` block of
   `~/.claude/settings.json`, keeping your other settings.

**Start a new Claude Code session.** The session that ran connect has already
read its environment, so it keeps exporting nothing.

To check the connection, ask Claude for your Sabia status, or run
`node scripts/sabia.mjs status` from the plugin directory.

The default connection sends token counts only. Tool output and raw capture
are separate grants, described in the [README](README.md#opt-in-capture-grants).
Ask for one only if you mean to share what it adds.

## 3. Connect completed-work reporting

1. Run `/mcp` in Claude Code.
2. Choose `plugin:sabia-claude-code-otel:sabia-artifacts`.
3. Sign in to Sabia, pick your organization and approve artifact metadata
   sharing.

Access tokens last an hour and refresh on their own until you revoke the
connection in Sabia → Settings → Artifact reporting. From then on, Claude
reports qualifying completed work, such as a created pull request or a revised
document, through the `report-artifact` skill.

When both connections are active, the plugin also links each accepted report to
the session and tokens that produced it. You do not need to do anything for
this.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Sign-in fails with a redirect error | OAuth uses a fixed callback on port `45711`. Free that port and retry. |
| Usage does not appear in Sabia | Start a new session after connecting. Check `status`. |
| A grant changed in Sabia has not applied | Grants apply at session start and take effect from the next session. Run `node scripts/sabia.mjs sync` to see the result now. |
| `status` says Sabia revoked this device | Run `disconnect` to clean up, then connect again. |
| Reporting tools are missing or unauthorized | Repeat step 3. |

For a Sabia deployment other than the default, pass `--base-url <url>` to
`connect` or set `SABIA_APP_URL`. On a machine without a browser, use
`configure --endpoint <url> --ingestion-key <key>` with a key issued in Sabia.

Questions: [hello@sabiapartners.com](mailto:hello@sabiapartners.com).
