# Sabia for Claude

Sabia is AI Work Intelligence for teams: it shows what work came out of the AI
tools a company already pays for, and what that work cost. This repository holds
everything Sabia runs on the Claude side.

[![Plugin checks](https://github.com/Sabia-Partners/sabia-claude-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/Sabia-Partners/sabia-claude-plugin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

| Folder | What it is |
| --- | --- |
| [`plugins/sabia`](plugins/sabia/README.md) | **Sabia for Claude Code**, the plugin listed in this marketplace: Output Reporting through Sabia's hosted MCP server, and Claude Code's native token usage. Its README lists everything it runs, sends and fetches. |
| [`desktop-extension`](desktop-extension) | **Sabia for Claude Desktop** (`sabia.mcpb`, attached to each release): shares Cowork usage from a Pro or Max plan. Distributed directly from Sabia, not through the plugin marketplace. |
| [`cowork`](cowork/README.md) | The command-line engine behind the Desktop extension, and an administrator helper for Cowork's own OpenTelemetry export on Team and Enterprise. |
| [`contracts`](contracts) | Contracts pinned against the Sabia dashboard. |

## Install the Claude Code plugin

```text
/plugin marketplace add Sabia-Partners/sabia-claude-plugin
/plugin install sabia@sabia
```

[`plugins/sabia/SETUP.md`](plugins/sabia/SETUP.md) walks through connecting it.

## Development

```text
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

The tests cover connect, sync and disconnect against a local handoff server,
the Cowork helper, the plugin manifest, the report-binding hook and the connector
hook. The shared report contract is pinned in [`contracts/v2`](contracts/v2/README.md);
the connector hook's vendored contract and its identity-path parity cases, generated
from the dashboard's own projector, are in [`contracts/connector-hook`](contracts/connector-hook).
`identity-paths-v3.json` is a byte copy of the dashboard's
`tests/fixtures/claude-code-identity-paths-v3.json`; when the dashboard regenerates
it, copy it again rather than editing it here.

### Changing the connector hook contract

Clients cache the contract for 24 hours, and keep using the last good copy for as
long as Sabia cannot be reached, so the server never knows which contract a hook
is applying. Any change to `identityPaths` is therefore expand, deploy, contract,
the same rule as a database migration:

1. **Expand.** Add the new path, `as` name or operation beside the old one, and
   have the module read both.
2. **Deploy**, and wait at least one release (well past the 24-hour cache) so every
   connected hook has fetched the expanded contract.
3. **Contract.** Only then remove or rename the old declaration, or deactivate the
   module that declared it.

Never rename or remove an `as`, change its `kind`, or deactivate a module's paths
in a single release: a hook still on the old contract would send names the server
no longer declares, and the server rejects that whole subtree. The contract's own
shape is pinned on both sides (the dashboard's
`tests/unit/claude-code-identity-path-parity.test.ts` and this repository's
`parseConnectorContract`); this hook rejects a contract with any key, kind or cap it
does not know and falls back to its last good copy, so a new field needs a plugin
release that accepts it before the server may serve it.

To release, raise the version in `plugins/sabia/.claude-plugin/plugin.json`,
`package.json` and `desktop-extension/manifest.json`, then tag `vX.Y.Z`. The
release workflow runs the checks and attaches `sabia-claude-plugin.tar.gz` and
`sabia.mcpb`. Claude Code only installs an update when the plugin's version
changes.


## Security and license

Report vulnerabilities privately. [SECURITY.md](SECURITY.md) explains how.
Support: [sabiapartners.ca/contact](https://sabiapartners.ca/contact). Released
under the [MIT License](LICENSE).
