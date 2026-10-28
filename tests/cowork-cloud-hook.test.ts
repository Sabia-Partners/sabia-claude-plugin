import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { COWORK_HOOK_SERVER, COWORK_HOOK_TOOL, coworkHookMatcher, readCoworkMutations } from "../scripts/cowork-hook-matcher.mjs";

// In cloud Cowork the command hook finds no device key, so an mcp_tool hook
// reports connector writes through the person's Sabia connector, which
// carries the sign-in. It sends the raw input and reply, so its matcher must
// select writes only.
const root = process.cwd();
const json = async (path: string) => JSON.parse(await readFile(join(root, path), "utf8"));

async function coworkHook() {
  const hooks = await json("hooks/hooks.json");
  const group = hooks.hooks.PostToolUse.find((entry: { hooks: { type: string; tool?: string }[] }) =>
    entry.hooks.some((hook) => hook.type === "mcp_tool" && hook.tool === COWORK_HOOK_TOOL));
  return { group, hook: group.hooks[0] };
}

describe("cloud Cowork connector hook", () => {
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
    const mutations = new Set(readCoworkMutations());
    const v1 = await json("contracts/connector-hook/v1.json");
    for (const name of v1.mutations) expect(mutations.has(name), name).toBe(true);
  });

  it("matches connector writes and never reads, Sabia's own tools or built-in tools", () => {
    const matcher = new RegExp(coworkHookMatcher());
    for (const name of ["mcp__Google_Drive__create_file", "mcp__Notion__notion-create-pages", "mcp__claude_ai_HubSpot__manage_crm_objects", "mcp__github__create_pull_request"]) {
      expect(matcher.test(name), name).toBe(true);
    }
    for (const name of ["mcp__Google_Drive__list_recent_files", "mcp__Google_Drive__read_file_content", "mcp__Notion__notion-fetch", "mcp__Sabia__report_artifact_v3", "mcp__Sabia__report_connector_result", "Write", "Bash", "mcp__Google_Drive__create_file_extra"]) {
      expect(matcher.test(name), name).toBe(false);
    }
  });
});
