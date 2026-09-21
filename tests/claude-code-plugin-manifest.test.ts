import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The Claude Code plugin's reporting path is hosted MCP plus a skill; the
// manifest is the contract Claude Code loads, so it is pinned here rather than
// trusted. Native usage stays the separate connect-sabia path.
const root = process.cwd();
const json = async (path: string) => JSON.parse(await readFile(join(root, path), "utf8"));

describe("Sabia for Claude Code plugin manifest", () => {
  it("keeps the installed identity and declares the bundled reporting server", async () => {
    const plugin = await json(".claude-plugin/plugin.json");
    expect(plugin.name).toBe("sabia-claude-code-otel");
    expect(plugin.license).toBe("UNLICENSED");
    expect(plugin.mcpServers).toBe("./.mcp.json");
    expect(plugin.hooks).toBe("./hooks/hooks.json");
    expect(plugin.skills).toBe("./skills/");
  });

  it("reports through the hosted HTTP server with a pre-registered public client", async () => {
    const mcp = await json(".mcp.json");
    const server = mcp.mcpServers["sabia-artifacts"];
    expect(Object.keys(mcp.mcpServers)).toEqual(["sabia-artifacts"]);
    expect(server.type).toBe("http");
    expect(server.url).toBe("https://app2.sabiapartners.ca/api/mcp/artifacts");
    expect(server.command).toBeUndefined();
    expect(server.headers).toBeUndefined();
    // Sabia's authorization server has no dynamic registration, so Claude Code
    // must present the registered client and a fixed callback port whose
    // redirect URI is on the allowlist.
    expect(server.oauth).toEqual({ clientId: "sabia-claude-code", callbackPort: 45711 });
  });

  it("keeps the native usage sync and binds reports only from the scoped report tool", async () => {
    const hooks = await json("hooks/hooks.json");
    expect(Object.keys(hooks.hooks).sort()).toEqual(["PostToolUse", "SessionStart"]);
    const start = hooks.hooks.SessionStart[0].hooks.map((hook: { command: string }) => hook.command);
    expect(start[0]).toContain("sabia.mjs\" sync --quiet");
    expect(start[1]).toContain("sabia-report-binding.mjs");
    const [post] = hooks.hooks.PostToolUse;
    const matcher = new RegExp(post.matcher);
    expect(matcher.test("mcp__plugin_sabia-claude-code-otel_sabia-artifacts__report_artifact")).toBe(true);
    expect(matcher.test("mcp__sabia-artifacts__report_artifact")).toBe(true);
    expect(matcher.test("mcp__plugin_sabia-claude-code-otel_sabia-artifacts__get_artifact_report")).toBe(false);
    expect(matcher.test("Bash")).toBe(false);
    expect(post.hooks).toEqual([{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/sabia-report-binding.mjs"', timeout: 8 }]);
  });

  it("ships the reporting skill against the scoped tool names", async () => {
    const skill = await readFile(join(root, "skills/report-artifact/SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: report-artifact\n/);
    expect(skill).toContain("mcp__plugin_sabia-claude-code-otel_sabia-artifacts__report_artifact");
    expect(skill).toContain("`source_application` is\n`claude_code`");
    expect(skill).toContain("original `event_id`");
    expect(skill).toContain("Keep every `usage` value null");
    expect(skill).toContain("Never use Claude Code's own session id");
    expect(skill).not.toMatch(/transcript_path|OTEL_/);
  });
});
