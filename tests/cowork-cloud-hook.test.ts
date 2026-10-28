import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { COWORK_HOOK_SERVER, COWORK_HOOK_TOOL, coworkHookMatcher, coworkOperations, readCoworkContract } from "../scripts/cowork-hook-matcher.mjs";

// In cloud Cowork the command hook finds no device key, so an mcp_tool hook
// reports connector writes through the person's Sabia connector, which
// carries the sign-in. It sends the raw input and reply, so it lives in its
// own opt-in plugin, never in the main one, and its matcher selects writes
// only.
const root = process.cwd();
const json = async (path: string) => JSON.parse(await readFile(join(root, path), "utf8"));
const hasMcpToolHook = (hooks: { hooks: Record<string, { hooks: { type: string }[] }[]> }) =>
  Object.values(hooks.hooks).flat().some((group) => group.hooks.some((hook) => hook.type === "mcp_tool"));

async function coworkHook() {
  const hooks = await json("cowork-cloud/hooks/hooks.json");
  const group = hooks.hooks.PostToolUse.find((entry: { hooks: { type: string; tool?: string }[] }) =>
    entry.hooks.some((hook) => hook.type === "mcp_tool" && hook.tool === COWORK_HOOK_TOOL));
  return { group, hook: group.hooks[0] };
}

describe("cloud Cowork connector hook", () => {
  it("ships in its own opt-in plugin, so the main plugin never sends a raw reply", async () => {
    expect(hasMcpToolHook(await json("hooks/hooks.json"))).toBe(false);
    const plugin = await json("cowork-cloud/.claude-plugin/plugin.json");
    expect(plugin.name).toBe("sabia-cowork-cloud");
    expect(plugin.description).toMatch(/full input and reply/);
    const marketplace = await json(".claude-plugin/marketplace.json");
    expect(marketplace.plugins.map((entry: { name: string; source: string }) => [entry.name, entry.source]))
      .toEqual([["sabia", "./"], ["sabia-cowork-cloud", "./cowork-cloud"]]);
    const readme = await readFile(join(root, "cowork-cloud/README.md"), "utf8");
    expect(readme.split(/\s+/).length).toBeGreaterThan(40);
  });

  it("calls the Sabia connector with the hook's own fields", async () => {
    const { hook } = await coworkHook();
    expect(hook).toEqual({
      type: "mcp_tool", server: COWORK_HOOK_SERVER, tool: "report_connector_result", timeout: 10,
      input: {
        schema_version: 1, source_application: "cowork",
        tool_name: "${tool_name}", tool_use_id: "${tool_use_id}", session_id: "${session_id}",
        tool_input: "${tool_input}", tool_response: "${tool_response}",
      },
    });
  });

  it("keeps its matcher in step with the vendored write operations", async () => {
    const { group } = await coworkHook();
    expect(group.matcher).toBe(coworkHookMatcher());
  });

  it("covers every write in the command hook's vendored contract", async () => {
    // identity-paths-v3.json is an older dashboard fixture and names
    // operations the server has since dropped, so only v1 is a floor.
    const operations = new Set(coworkOperations());
    const v1 = await json("contracts/connector-hook/v1.json");
    for (const name of v1.mutations) expect(operations.has(name.toLowerCase()), name).toBe(true);
  });

  it("matches writes in any case, as the server does", () => {
    const matcher = new RegExp(coworkHookMatcher());
    for (const name of [
      "mcp__Google_Drive__create_file", "mcp__Notion__notion-create-pages", "mcp__claude_ai_HubSpot__manage_crm_objects",
      "mcp__github__create_pull_request", "mcp__composio__MAILCHIMP_ADD_CAMPAIGN",
      "mcp__claude_ai_Intuit_Mailchimp__Save-To-Mailchimp", "mcp__claude_ai_Intuit_Mailchimp__save-to-mailchimp",
    ]) {
      expect(matcher.test(name), name).toBe(true);
    }
  });

  it("never matches reads, routers that also read, Sabia's own tools or built-in tools", () => {
    const matcher = new RegExp(coworkHookMatcher());
    const excluded = Object.keys(readCoworkContract().excluded);
    expect(excluded.sort()).toEqual(["mailchimp_campaigns", "manage_campaign_objects", "manage_marketing_email"]);
    for (const name of [
      "mcp__Google_Drive__list_recent_files", "mcp__Google_Drive__read_file_content", "mcp__Notion__notion-fetch",
      "mcp__mailchimp__mailchimp_campaigns", "mcp__mailchimp__MAILCHIMP_CAMPAIGNS",
      "mcp__claude_ai_HubSpot__manage_campaign_objects", "mcp__claude_ai_HubSpot__manage_marketing_email",
      "mcp__Sabia__report_artifact_v3", "mcp__Sabia__report_connector_result",
      "Write", "Bash", "mcp__Google_Drive__create_file_extra",
    ]) {
      expect(matcher.test(name), name).toBe(false);
    }
  });
});
