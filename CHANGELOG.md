# Changelog

## 0.4.0 (unreleased)

- Report connector mutations: a `PostToolUse` hook (`scripts/sabia-connector-hook.mjs`) sends the identifiers from the reply of a successful Google Drive or GitHub connector create or update — file or pull request ids, names and links — under the tool-output grant only, to `/api/v1/telemetry/claude-code/hooks`. Claude Code exports connector arguments but never their results, so a Doc created through the Drive connector was unidentifiable. Reads, other connectors, error-shaped replies (including errors wrapped in content blocks) and Sabia's own tools send nothing. No spool; a few bounded retries, then silence. Moved from dashboard-langfuse#95.
- `contracts/connector-hook/v1.json` pins the hook's operation allowlist and identity projection against the dashboard's.

## 0.3.0 (unreleased)

- A capture grant widened in Sabia no longer applies on its own. Sync applies a narrower grant and records a wider one as pending, announcing it at every session start until the person using the device runs `approve`. `status` shows what is waiting.
- License the plugin under MIT and prepare it for the Claude plugin directory: a new README covering what leaves the machine, a SETUP guide and a private vulnerability reporting route.
- Extract the Claude Code plugin and the Cowork OTel helper from `Sabia-Partners/dashboard-langfuse` into this repository with their history. The installed identifier stays `sabia-claude-code-otel`; native usage connections, device identity, capture grants, settings paths and app2 routing are unchanged by the move.
- Report completed work through Sabia's hosted artifact-reporting MCP server (`.mcp.json`, pre-registered public client `sabia-claude-code`, OAuth callback port 45711) with the shared `report-artifact` skill.
- Bind an accepted report to the native Claude Code session and tool call that made it through a bundled `PostToolUse` hook, over the separately authorized native usage credential. No prompt, transcript, tool input, raw session id or usage value is submitted.
- Pin the shared artifact report contract (`contracts/v2`, 2.1.0-beta.1, backend migration `20260916220422`; Claude Code bindings additionally need dashboard migration `20260921233000`).
