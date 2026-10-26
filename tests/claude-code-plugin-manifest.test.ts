import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The Claude Code plugin's reporting path is hosted MCP plus a skill; the
// manifest is the contract Claude Code loads, so it is pinned here rather than
// trusted. Native usage stays the separate connect-sabia path.
const root = process.cwd();
const json = async (path: string) => JSON.parse(await readFile(join(root, path), "utf8"));
const listingUrls = ["documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl"] as const;

describe("Sabia for Claude Code plugin manifest", () => {
  it("names the plugin plainly and loads its components from the default locations", async () => {
    const plugin = await json(".claude-plugin/plugin.json");
    expect(plugin.name).toBe("sabia");
    expect(plugin.displayName).toBe("Sabia");
    expect(plugin.license).toBe("MIT");
    // Naming the default files again makes the validator warn; Claude Code
    // loads .mcp.json, hooks/hooks.json and skills/ on its own.
    expect(plugin.mcpServers).toBeUndefined();
    expect(plugin.hooks).toBeUndefined();
    expect(plugin.skills).toBeUndefined();
  });

  it("carries the directory listing fields, on https and with a real icon", async () => {
    const plugin = await json(".claude-plugin/plugin.json");
    for (const field of listingUrls) expect(new URL(plugin[field]).protocol).toBe("https:");
    expect(plugin.author.email).toBe("hello@sabiapartners.ca");
    const icon = await readFile(join(root, plugin.icon));
    expect(icon.subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("reports through the hosted HTTP server with a pre-registered public client", async () => {
    const mcp = await json(".mcp.json");
    const server = mcp.mcpServers["sabia-artifacts"];
    expect(Object.keys(mcp.mcpServers)).toEqual(["sabia-artifacts"]);
    expect(server.type).toBe("http");
    expect(server.url).toBe("https://app.sabia.work/api/mcp/artifacts");
    expect(server.command).toBeUndefined();
    expect(server.headers).toBeUndefined();
    // Sabia advertises Client ID Metadata Documents, so Claude Code signs in
    // with Claude's published identity on any free port. A pinned client would
    // override that and bring back the fixed port.
    expect(server.oauth).toBeUndefined();
  });

  it("keeps the native usage sync and binds reports only from the scoped report tool", async () => {
    const hooks = await json("hooks/hooks.json");
    expect(Object.keys(hooks.hooks).sort()).toEqual(["PostToolUse", "SessionStart"]);
    const start = hooks.hooks.SessionStart[0].hooks.map((hook: { command: string }) => hook.command);
    expect(start[0]).toContain("sabia.mjs\" sync --quiet");
    expect(start[1]).toContain("sabia-report-binding.mjs");
    const [post, connector] = hooks.hooks.PostToolUse;
    const matcher = new RegExp(post.matcher);
    expect(matcher.test("mcp__plugin_sabia_sabia-artifacts__report_artifact")).toBe(true);
    expect(matcher.test("mcp__sabia-artifacts__report_artifact")).toBe(true);
    expect(matcher.test("mcp__plugin_sabia_sabia-artifacts__report_artifact_v3")).toBe(true);
    expect(matcher.test("mcp__sabia-artifacts__report_artifact_v3")).toBe(true);
    // The Sabia connector added in claude.ai, as Claude Code names it on a computer.
    expect(matcher.test("mcp__claude_ai_Sabia__report_artifact_v3")).toBe(true);
    expect(matcher.test("mcp__claude_ai_Sabia__get_artifact_report")).toBe(false);
    expect(matcher.test("mcp__claude_ai_Slack__report_artifact_v3")).toBe(false);
    expect(matcher.test("mcp__plugin_sabia_sabia-artifacts__report_artifact_v4")).toBe(false);
    expect(matcher.test("mcp__plugin_sabia_sabia-artifacts__get_artifact_report")).toBe(false);
    expect(matcher.test("Bash")).toBe(false);
    expect(post.hooks).toEqual([{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/sabia-report-binding.mjs"', timeout: 8 }]);
    // Connector mutations: every MCP tool reaches the script, which decides
    // locally and stays silent for reads and for Sabia's own tools.
    const connectorMatcher = new RegExp(connector.matcher);
    expect(connectorMatcher.test("mcp__google_drive__create_file")).toBe(true);
    expect(connectorMatcher.test("mcp__github__create_pull_request")).toBe(true);
    expect(connectorMatcher.test("Bash")).toBe(false);
    expect(connector.hooks).toEqual([{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/sabia-connector-hook.mjs"', timeout: 10 }]);
  });

  it("ships the reporting skill against the scoped tool names", async () => {
    const skill = await readFile(join(root, "skills/report-artifact/SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: report-artifact\n/);
    expect(skill).toContain("mcp__plugin_sabia_sabia-artifacts__report_artifact_v3");
    // New reports go through the v3 contract; the database refuses new v2 reports.
    expect(skill).toContain("First call `get_reporting_contract`");
    expect(skill).toMatch(/Do not use\s+`report_artifact`:/);
    expect(skill).not.toContain("schema version 2");
    // v3 identities and actions: a review is not an update, Drive and Linear need
    // the contract's scope_ref, and unsupported sources are not reported at all.
    expect(skill).toMatch(/review that printed its URL is `review`/);
    expect(skill).toContain("exact `scope_ref`");
    expect(skill).toMatch(/Slack messages, web publications and email cannot be reported/);
    expect(skill).not.toMatch(/`send` on `slack`|artifact_account_id|availability `host_local`/);
    expect(skill).toMatch(/`source_application` is\s+`claude_code`/);
    expect(skill).toContain("original `event_id`");
    expect(skill).toContain("Keep every `usage` value null");
    expect(skill).toContain("Never use Claude Code's own session id");
    expect(skill).not.toMatch(/transcript_path|OTEL_/);
  });
});
