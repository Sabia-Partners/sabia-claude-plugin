# Setting up Sabia for Claude Code

You need Claude Code 2.1.81 or later with Node 22 or newer, and a Sabia
workspace you can sign in to. The two connections below are independent. Set up either one, or both.

## 1. Install

```text
/plugin marketplace add Sabia-Partners/sabia-claude-plugin
/plugin install sabia@sabia
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

The connection sends token counts and asks for tool output, a separate grant
described in the [README](README.md#tool-output-grant). Connect with
`--no-tool-output` to share token counts only. The plugin never turns on prompt text;
the README's [Prompt text](README.md#prompt-text) section explains why and what
the setting is.

## 3. Connect Output Reporting

1. Run `/mcp` in Claude Code.
2. Choose `plugin:sabia:sabia-artifacts`.
3. Sign in to Sabia, pick your organization and approve Output Reporting metadata
   sharing.

Access tokens last an hour and refresh on their own until you revoke the
connection in Sabia → Settings → Members → Details → Output Reporting. From then on, Claude
reports qualifying completed work, such as a created pull request or a revised
document, through the `report-artifact` skill.

When both connections are active, the plugin also links each accepted report to
the session and tokens that produced it. You do not need to do anything for
this.

## 4. Cloud sessions

Cloud sessions (claude.ai/code, `claude --cloud`, routines) do not load this
plugin or the settings it writes. For Output Reporting there, add the Sabia
connector at [claude.ai/customize/connectors](https://claude.ai/customize/connectors)
([steps](https://app.sabia.work/help/claude)); cloud sessions get it
already signed in. For native usage, get the cloud session values in Sabia
under Settings → Connected Tools → Connect a tool → Claude Code, and add them
to a personal cloud environment. The README's
[Cloud sessions](README.md#cloud-sessions) section has the full steps.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Sign-in says the server does not support dynamic client registration | Update Claude Code to 2.1.81 or later. |
| Usage does not appear in Sabia | Start a new session after connecting. Check `status`. |
| A grant changed in Sabia has not applied | Narrowing applies at session start and takes effect from the next session. Widening also waits for your approval: ask Claude to approve it, or run `node scripts/sabia.mjs approve`. |
| `status` says Sabia revoked this device | Run `disconnect` to clean up, then connect again. |
| Reporting tools are missing or unauthorized | Repeat step 3. Updating to 0.8.0 needs this once. In a cloud session, connect the Sabia connector in Claude instead (step 4). |
| `/mcp` lists two Sabia servers | The Sabia connector added in Claude has the old address. Remove it in Claude's connector settings and add it again with `https://app.sabia.work/api/mcp/artifacts`. |
| `connect` says this is a Claude Code cloud session | Set up cloud usage in Sabia instead (step 4). |
| The Sabia connector answers `DISALLOWED_SOURCE` from Claude Code | It was connected before it covered Claude Code. Disconnect it in Claude's connector settings and connect again. |

For a Sabia deployment other than the default, pass `--base-url <url>` to
`connect` or set `SABIA_APP_URL`. On a machine without a browser, use
`configure --endpoint <url> --ingestion-key <key>` with a key issued in Sabia.

Questions: [hello@sabiapartners.ca](mailto:hello@sabiapartners.ca) or [sabiapartners.ca/contact](https://sabiapartners.ca/contact).
