#!/usr/bin/env node
// Builds the PostToolUse matcher for the cloud Cowork hook from the vendored
// list of connector write operations. The hook sends the raw tool input and
// reply to Sabia, so it must match writes only: a read's reply (a document,
// an email) would reach Sabia otherwise. Operation names follow the server's
// rule: the whole tool name after `mcp__<server>__`, or its last segment after
// `_`, `:` or `/`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const COWORK_HOOK_TOOL = "report_connector_result";
export const COWORK_HOOK_SERVER = "Sabia";

export function readCoworkMutations(path = join(root, "contracts/connector-hook/cowork-mutations.json")) {
  return JSON.parse(readFileSync(path, "utf8")).mutations;
}

const escape = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function coworkHookMatcher(mutations = readCoworkMutations()) {
  return `^mcp__.+__(?:.+[_:/])?(?:${[...mutations].sort().map(escape).join("|")})$`;
}

/** Rewrites the matcher in hooks/hooks.json in place. */
export function writeCoworkHookMatcher(hooksPath = join(root, "hooks/hooks.json")) {
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
  const group = hooks.hooks.PostToolUse.find((entry) =>
    entry.hooks.some((hook) => hook.type === "mcp_tool" && hook.tool === COWORK_HOOK_TOOL));
  if (!group) throw new Error("hooks/hooks.json has no cloud Cowork hook");
  group.matcher = coworkHookMatcher();
  writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--write")) writeCoworkHookMatcher();
  else process.stdout.write(`${coworkHookMatcher()}\n`);
}
