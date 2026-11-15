import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The Claude Code plugin's reporting path is hosted MCP plus a skill; the
// manifest is the contract Claude Code loads, so it is pinned here rather than
// trusted. Native usage and the hooks live in the complete plugin on the full branch.
// The listed plugin lives in plugins/sabia: the directory reads that folder
// alone, so the tests, scripts and cowork-cloud plugin at the root stay out of it.
const repo = process.cwd();
const root = join(repo, "plugins/sabia");
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

  it("ships no hooks and no local scripts, so the plugin directory can list it", async () => {
    // Claude's plugin directory accepts hooks only from verified organizations.
    // The complete plugin, with its hooks and scripts, lives on the full branch.
    await expect(readFile(join(root, "hooks/hooks.json"), "utf8")).rejects.toThrow();
    await expect(readdir(join(root, "scripts"))).rejects.toThrow();
    const skills = await readdir(join(root, "skills"));
    expect(skills).toEqual(["report-artifact"]);
  });

  it("holds only the file types the directory accepts from unverified organizations", async () => {
    // Markdown, text, JSON and images; no #! line, no package manager files,
    // no second .claude-plugin folder. Anything else refuses the whole version.
    const files = (await readdir(root, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
      .sort();
    expect(files).toEqual([
      ".claude-plugin/plugin.json",
      ".mcp.json",
      "LICENSE",
      "README.md",
      "icon.png",
      "skills/report-artifact/SKILL.md",
    ]);
    for (const file of files.filter((name) => name !== "icon.png")) {
      const text = await readFile(join(root, file), "utf8");
      expect(text.startsWith("#!"), file).toBe(false);
      expect(text.includes("\u0000"), file).toBe(false);
    }
    expect(await readFile(join(root, "LICENSE"), "utf8")).toBe(await readFile(join(repo, "LICENSE"), "utf8"));
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
    // the contract's scope_ref, and no Source is refused here: the contract decides.
    expect(skill).toMatch(/review that printed its URL is `review`/);
    expect(skill).toContain("exact `scope_ref`");
    expect(skill).not.toMatch(/cannot be reported|Slack/);
    // Named systems are hints, not the whole list, and no act is ruled out here.
    expect(skill).toMatch(/the contract decides what Sabia\s+accepts/);
    expect(skill).not.toMatch(/is not reportable|`apollo`, or `other`\)/);
    // Work without a reporting definition: `other` for an unlisted system, and
    // an unresolved fallback sends artifact null with the tool's own hint.
    expect(skill).toMatch(/`source_system` `other`, and lowercase slugs/);
    expect(skill).toMatch(/follow its `fallback_guidance`/);
    expect(skill).toMatch(/Never invent an ID, URL or\s+title/);
    expect(skill).toMatch(/`update_pending`: Sabia is mid-update/);
    expect(skill).not.toMatch(/artifact_account_id|availability `host_local`/);
    expect(skill).toMatch(/`source_application` is\s+`claude_code`/);
    expect(skill).toContain("original `event_id`");
    expect(skill).toContain("Keep every `usage` value null");
    expect(skill).toContain("Never use Claude Code's own session id");
    expect(skill).not.toMatch(/transcript_path|OTEL_/);
  });
});
