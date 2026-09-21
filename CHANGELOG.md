# Changelog

## 0.3.0-beta.1 (unreleased)

- Extract the Claude Code plugin and the Cowork OTel helper from `Sabia-Partners/dashboard-langfuse` into this repository with their history. The installed identifier stays `sabia-claude-code-otel`; native usage connections, device identity, capture grants, settings paths and app2 routing are unchanged by the move.
- Report completed work through Sabia's hosted artifact-reporting MCP server (`.mcp.json`, pre-registered public client `sabia-claude-code`, OAuth callback port 45711) with the shared `report-artifact` skill.
- Bind an accepted report to the native Claude Code session and tool call that made it through a bundled `PostToolUse` hook, over the separately authorized native usage credential. No prompt, transcript, tool input, raw session id or usage value is submitted.
- Pin the shared artifact report contract (`contracts/v2`, 2.1.0-beta.1, backend migration `20260916220422`; Claude Code bindings additionally need dashboard migration `20260921233000`).
