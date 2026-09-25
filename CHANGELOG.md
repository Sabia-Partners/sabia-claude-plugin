# Changelog

## 0.4.0 (unreleased)

- **Sabia for Claude Desktop** (`desktop-extension/`, released as `sabia.mcpb`): a Desktop Extension that shares Cowork usage on any Claude plan with no terminal. Claude Desktop runs it on the host; on first start it opens Sabia's approval page once, then syncs at start-up and every ten minutes while Claude is open. Tools: `sabia_status`, `sabia_connect`, `sabia_sync_now`. Content sharing is an install-time toggle and still needs approval in Sabia. It shares state with `connect --local`, so a device never holds two keys. The release workflow attaches `sabia.mcpb` so Sabia can link to `releases/latest/download/sabia.mcpb`.

- Share Cowork on Pro and Max plans: `cowork/scripts/sabia.mjs connect --local` reads the desktop app's local Cowork session logs (`local-agent-mode-sessions/**/audit.jsonl`) and sends each turn's per-model token totals, call count, time and session id to the Cowork endpoint under the person's own key, then syncs every ten minutes through a macOS LaunchAgent. Totals come from each turn's `result.modelUsage`; the per-message `usage` is a streaming-start snapshot that under-reports output about thirtyfold and is never summed. `--content` asks for prompts, responses and tool inputs and results, sent only once an owner or administrator approves the grant. Needs dashboard-langfuse#147 for the per-turn request count.

- Report connector mutations: a `PostToolUse` hook (`scripts/sabia-connector-hook.mjs`) sends the identifiers from the reply of a successful Google Drive or GitHub connector create or update — file or pull request ids, names and links — under the tool-output grant only, to `/api/v1/telemetry/claude-code/hooks`. Claude Code exports connector arguments but never their results, so a Doc created through the Drive connector was unidentifiable. Reads, other connectors, error-shaped replies (including errors wrapped in content blocks) and Sabia's own tools send nothing. No spool; a few bounded retries, then silence. Moved from dashboard-langfuse#95.
- `contracts/connector-hook/v1.json` pins the hook's operation allowlist and identity projection against the dashboard's.

## 0.3.0 (unreleased)

- A capture grant widened in Sabia no longer applies on its own. Sync applies a narrower grant and records a wider one as pending, announcing it at every session start until the person using the device runs `approve`. `status` shows what is waiting.
- License the plugin under MIT and prepare it for the Claude plugin directory: a new README covering what leaves the machine, a SETUP guide and a private vulnerability reporting route.
- Extract the Claude Code plugin and the Cowork OTel helper from `Sabia-Partners/dashboard-langfuse` into this repository with their history. The installed identifier stays `sabia-claude-code-otel`; native usage connections, device identity, capture grants, settings paths and app2 routing are unchanged by the move.
- Report completed work through Sabia's hosted artifact-reporting MCP server (`.mcp.json`, pre-registered public client `sabia-claude-code`, OAuth callback port 45711) with the shared `report-artifact` skill.
- Bind an accepted report to the native Claude Code session and tool call that made it through a bundled `PostToolUse` hook, over the separately authorized native usage credential. No prompt, transcript, tool input, raw session id or usage value is submitted.
- Pin the shared artifact report contract (`contracts/v2`, 2.1.0-beta.1, backend migration `20260916220422`; Claude Code bindings additionally need dashboard migration `20260921233000`).
