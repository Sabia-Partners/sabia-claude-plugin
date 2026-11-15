# Setting up Sabia for Claude Code

You need Claude Code 2.1.81 or later and a Sabia workspace you can sign in to.
This plugin has no hooks and runs nothing on your machine; for Claude Code's own
token usage and automatic capture, see [The complete plugin](#the-complete-plugin).

## 1. Install

```text
/plugin marketplace add Sabia-Partners/sabia-claude-plugin
/plugin install sabia@sabia
```

## 2. Connect Output Reporting

1. Run `/mcp` in Claude Code.
2. Choose `plugin:sabia:sabia-artifacts`.
3. Sign in to Sabia, pick your organization and approve Output Reporting metadata
   sharing.

Access tokens last an hour and refresh on their own until you revoke the
connection in Sabia → Settings → Members → Details → Output Reporting. From then on, Claude
reports qualifying completed work, such as a created pull request or a revised
document, through the `report-artifact` skill.

## 3. Cloud sessions

Cloud sessions (claude.ai/code, `claude --cloud`, routines) do not load this
plugin. For Output Reporting there, add the Sabia connector at
[claude.ai/customize/connectors](https://claude.ai/customize/connectors)
([steps](https://app.sabia.work/help/claude)); cloud sessions get it
already signed in. The README's [Cloud sessions](README.md#cloud-sessions)
section has the details.

## The complete plugin

The complete version also sends Claude Code's token counts to Sabia, links each
report to its session, and records work done through other connectors. It uses
hooks and local scripts, so it lives on the
[`full` branch](https://github.com/Sabia-Partners/sabia-claude-plugin/tree/full)
in its own marketplace. Install one version or the other, not both:

```text
/plugin uninstall sabia@sabia
/plugin marketplace add Sabia-Partners/sabia-claude-plugin#full
/plugin install sabia@sabia-full
```

Its own [SETUP.md](https://github.com/Sabia-Partners/sabia-claude-plugin/blob/full/SETUP.md)
covers connecting native usage.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Sign-in says the server does not support dynamic client registration | Update Claude Code to 2.1.81 or later. |
| Reporting tools are missing or unauthorized | Repeat step 2. In a cloud session, connect the Sabia connector in Claude instead (step 3). |
| `/mcp` lists two Sabia servers | The Sabia connector added in Claude has the old address. Remove it in Claude's connector settings and add it again with `https://app.sabia.work/api/mcp/artifacts`. |
| The Sabia connector answers `DISALLOWED_SOURCE` from Claude Code | It was connected before it covered Claude Code. Disconnect it in Claude's connector settings and connect again. |
| Token usage stopped after updating to 0.9.0 | 0.9.0 removed the native usage sync from `sabia@sabia`. Install the complete plugin (above). Your connection itself is kept. |

Questions: [hello@sabiapartners.ca](mailto:hello@sabiapartners.ca) or [sabiapartners.ca/contact](https://sabiapartners.ca/contact).
