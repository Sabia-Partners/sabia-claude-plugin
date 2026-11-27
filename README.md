# Sabia for Claude Code

**Report the work Claude Code finishes to your team's Sabia workspace.**

[![Plugin checks](https://github.com/Sabia-Partners/sabia-claude-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/Sabia-Partners/sabia-claude-plugin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Sabia is AI Work Intelligence for teams. This plugin connects Claude Code to
your team's Sabia workspace through **Output Reporting**: when Claude Code
opens a pull request, files an issue or revises a document, it records that
work in Sabia. Creating a document and later materially editing it produces two
Outputs linked to one Artifact. A generated response or trace alone does not
qualify.

This plugin is the Sabia connector and one skill. It ships **no hooks and no
local scripts**: nothing runs on your machine and nothing is read from it.

## Quick start

```text
/plugin marketplace add Sabia-Partners/sabia-claude-plugin
/plugin install sabia@sabia
```

Then run `/mcp`, choose `plugin:sabia:sabia-artifacts`, sign in to Sabia and
approve metadata sharing for your organization. Needs Claude Code 2.1.81 or
later. For Claude on the web, Desktop and mobile, see
[Connect Claude to Sabia](https://app.sabia.work/help/claude).

You need a Sabia workspace. Talk to [Sabia Partners](https://sabiapartners.ca/contact)
if your team does not have one yet.

## The complete plugin: token usage and automatic capture

A complete version of this plugin also sends Claude Code's own token counts to
Sabia, links each report to the session and tokens behind it, and records work
Claude Code does through other connectors, such as a Google Doc it creates. It
does that with hooks and local scripts, which Claude's plugin directory accepts
only from verified organizations, so it lives on this repository's
[`full` branch](https://github.com/Sabia-Partners/sabia-claude-plugin/tree/full#readme)
in its own marketplace:

```text
/plugin marketplace add Sabia-Partners/sabia-claude-plugin#full
/plugin install sabia@sabia-full
```

If you already have `sabia@sabia`, run `/plugin uninstall sabia@sabia` first:
both are named `sabia`, and Claude Code would install them side by side.

Then ask Claude to **"connect Sabia"** for native usage, as its README
describes.

Up to 0.8.1 the complete plugin was `sabia@sabia`. From 0.9.0 that name is this
hook-free plugin. Updating keeps sending token counts, and tool output if that
grant is on, because the exporter settings stay in `~/.claude/settings.json`.
But grant changes no longer sync, reports are no longer linked to their
sessions, and connector work is no longer captured. Install `sabia@sabia-full`
to keep those, or to stop the export: its disconnect removes those settings.
Revoking the device in Sabia makes Sabia refuse whatever is still sent.

## What leaves your machine

Nothing is sent until you sign in through `/mcp`. After that, Claude sends
Sabia what it reports through the connector's tools, and only that.

| Action | Data sent to Sabia |
| --- | --- |
| Report completed work | The action, short title, Artifact type, provider identifiers and available evidence references. |
| Review a passage you select | The selected text, title, source URL when available, and your review goal. Sabia saves the text in your Organization so you can open the reviewed version. |

Titles and references can still contain sensitive information, so review what
Claude reports the same way you would review a commit message. The
[privacy notice](https://app.sabia.work/privacy/claude-code) covers what Sabia
keeps and for how long.

## How it works

| Piece | What it does |
| --- | --- |
| [`plugins/sabia/.mcp.json`](plugins/sabia/.mcp.json) | Bundles Sabia's hosted MCP server as `sabia-artifacts`. It is HTTP with OAuth, and nothing runs locally. |
| [`plugins/sabia/skills/report-artifact`](plugins/sabia/skills/report-artifact/SKILL.md) | Tells Claude when a completed create, update, send, publish or deliver is worth reporting, and how to report it. |
| [`cowork-cloud/`](cowork-cloud/README.md) | A separate, opt-in plugin for Cowork in the cloud (below). It is not part of `sabia`. |
| [`scripts/cowork-hook-matcher.mjs`](scripts/cowork-hook-matcher.mjs) | A maintainer tool, never run by the plugin: builds the `sabia-cowork-cloud` hook's matcher from `contracts/connector-hook/cowork-mutations.json`; `--write` updates `cowork-cloud/hooks/hooks.json`. |

## Cloud sessions

Cloud sessions run on Anthropic's machines: claude.ai/code, `claude --cloud`,
the Desktop app's Cloud option and routines. They load neither the plugins
installed on your computer nor the `settings.json` the complete plugin writes, so
installing and connecting on your computer does not cover them. Set them up
once, separately for each connection.

**Output Reporting.** Add the Sabia connector in Claude: at
[claude.ai/customize/connectors](https://claude.ai/customize/connectors),
choose **Add custom connector** and follow
[Connect Claude to Sabia](https://app.sabia.work/help/claude). Cloud
sessions get it already signed in, and it reports their work as Claude Code;
`/mcp` sign-in cannot finish in a cloud session. The same connector covers
Claude chat, Cowork, Desktop and mobile. If you connected it before it covered
Claude Code, disconnect it there and connect again.

Native usage from cloud sessions is set up from Sabia, not from a plugin; the
[complete plugin's README](https://github.com/Sabia-Partners/sabia-claude-plugin/tree/full#cloud-sessions)
walks through it.

### Cowork in the cloud

Cowork sessions also run on Anthropic's machines (on Pro and Max since
October 2026). Unlike Claude Code cloud sessions they load the plugins on your
Claude account, with their hooks. The complete plugin's connector hook needs a
`settings.json` key, which Cowork in the cloud doesn't have, so it sends nothing there. A separate, opt-in plugin,
**Sabia Cowork cloud capture** ([`cowork-cloud/`](cowork-cloud/README.md),
`sabia-cowork-cloud` in this marketplace), reports the same connector writes
through the Sabia connector you added in Claude, which carries your sign-in:

1. In Sabia, go to **Settings → AI Tools**, open Claude Cowork and
   select **Turn on cloud capture**. Tool details must be allowed for it,
   which an owner or administrator does.
2. Add the Sabia connector in Claude, as above, so that it is named
   **Sabia**. The hook calls it by that name.
3. Add **Sabia Cowork cloud capture** to your Claude account: under
   Customize, then Plugins, choose **Add**, then **Add marketplace**, enter
   `Sabia-Partners/sabia-claude-plugin`, and install it from that
   marketplace. Installed this way it updates with the marketplace; an
   uploaded zip does not.
4. In Claude, under Customize, then Connectors, open Sabia and set **Cowork
   cloud capture (plugin only)** to **Always allow**. If it is not listed,
   choose the **⋯** menu next to Disconnect, then **Refresh tools list**; Sabia
   lists it only once cloud capture is on. A hook cannot ask for approval, so
   until this is set Claude refuses each call with "MCP tool call requires
   approval" and nothing reaches Sabia.

After a successful connector write in a cloud Cowork session, such as a Notion
page or a HubSpot deal, its hook passes the tool's name, input and reply to
Sabia's `report_connector_result` tool. The matcher selects only the write
operations in
[`contracts/connector-hook/cowork-mutations.json`](contracts/connector-hook/cowork-mutations.json),
in any case, and leaves out routers that also serve reads, so reads send
nothing. A hook cannot trim a reply on the machine, so the whole input and
reply reach Sabia, which keeps only the identifiers and discards the rest.
That is why it is a separate plugin: adding it is the opt-in, and removing it
stops the sending. Sabia stores nothing from it unless cloud capture is on and
Tool details is allowed.

Two other places that look right do not work. Network secrets never reach
Claude Code's telemetry export. A repository's `.claude/settings.json` cannot
turn telemetry on. A server-managed settings `env` block would also reach
every member's own computer and replace their personal keys, so Sabia does
not use it.

## Development

```text
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

The tests pin the plugin manifest, the reporting skill, the reporting contract
and the Cowork cloud capture hook. New reports follow the v3 contract that
`get_reporting_contract` returns; the earlier v2 contract, kept for receipt
recovery, is pinned in [`contracts/v2`](contracts/v2/README.md). The native usage
scripts, the report binding, the connector hook and their contracts live on the
[`full` branch](https://github.com/Sabia-Partners/sabia-claude-plugin/tree/full).
Changes to them go there.

### Retiring `app2.sabiapartners.ca`

Sabia moved from `https://app2.sabiapartners.ca` to `https://app.sabia.work`, and
this plugin followed in 0.8.0. That release changes only new connects, the bundled
MCP server and links. Devices connected before it keep app2 in their settings, as do
cloud environments and Output Reporting sign-ins made there. The dashboard serves
app2's API, OAuth discovery and consent page for them while app2 is listed in its
`LEGACY_APP_ORIGINS`. Removing it is the contract step of expand, deploy, contract,
so it waits for this release, not the other way round:

1. **Expand** (dashboard): `APP_URL` is app.sabia.work, and app2 is served as its
   own authorization server.
2. **Deploy** (0.8.0): nothing new names app2. Native usage already connected
   keeps working; Output Reporting asks for one new sign-in.
3. **Contract**: drop app2 from `LEGACY_APP_ORIGINS` only once nothing calls it.
   The dashboard's `docs/engineering/hosted-claude-artifact-reporting.md` lists
   what to check first.

Never point `plugins/sabia/.mcp.json` (or, on the `full` branch, `DEFAULT_BASE_URL`) back at app2. Moving a plugin
server's URL makes every user sign in again.

The listed plugin is the `plugins/sabia` folder, and that folder is what Claude's plugin
directory reads. Keep only Markdown, JSON, the license and the icon in it: the directory refuses
scripts, tests and package files from organizations it has not verified.

To release, raise the version in `plugins/sabia/.claude-plugin/plugin.json` and
`package.json`, then tag `vX.Y.Z`. The release workflow runs the checks and
attaches `sabia-claude-plugin.tar.gz`. Claude Code only installs an update when
the plugin's version changes. The Claude Desktop extension and the Cowork helper
live in [Sabia-Partners/sabia-claude-desktop](https://github.com/Sabia-Partners/sabia-claude-desktop).



## Security and license

Report vulnerabilities privately. [SECURITY.md](SECURITY.md) explains how.
Support: [sabiapartners.ca/contact](https://sabiapartners.ca/contact) or
[hello@sabiapartners.ca](mailto:hello@sabiapartners.ca). Released under the
[MIT License](LICENSE).
