#!/usr/bin/env node
// Builds the PostToolUse matcher for the opt-in cloud Cowork hook from the
// vendored list of connector write operations. The hook sends the raw tool
// input and reply to Sabia, so it must match writes only: a read's reply (a
// document, an email) would reach Sabia otherwise. Routers that also serve
// reads are excluded for the same reason. Operation names follow the
// server's rule (toolNameMatchesOperation): the whole tool name after
// `mcp__<server>__`, or its last segment after `_`, `:` or `/`, compared
// without regard to case. A hook matcher takes no flags, so each letter is a
// two-case class.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const COWORK_HOOK_TOOL = "report_connector_result";
export const COWORK_HOOK_SERVER = "Sabia";
export const COWORK_HOOKS_PATH = join(root, "cowork-cloud/hooks/hooks.json");

export function readCoworkContract(path = join(root, "contracts/connector-hook/cowork-mutations.json")) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The operations the hook reports: the contract's writes minus the excluded routers. */
export function coworkOperations(contract = readCoworkContract()) {
  const excluded = new Set(Object.keys(contract.excluded ?? {}).map((name) => name.toLowerCase()));
  return [...new Set(contract.mutations.map((name) => name.toLowerCase()))].filter((name) => !excluded.has(name)).sort();
}

function caseless(name) {
  return [...name].map((char) => {
    if (/[a-z]/.test(char)) return `[${char}${char.toUpperCase()}]`;
    return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
}

export function coworkHookMatcher(operations = coworkOperations()) {
  return `^mcp__.+__(?:.+[_:/])?(?:${operations.map(caseless).join("|")})$`;
}

/** Rewrites the matcher in cowork-cloud/hooks/hooks.json in place. */
export function writeCoworkHookMatcher(hooksPath = COWORK_HOOKS_PATH) {
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
  const group = hooks.hooks.PostToolUse.find((entry) =>
    entry.hooks.some((hook) => hook.type === "mcp_tool" && hook.tool === COWORK_HOOK_TOOL));
  if (!group) throw new Error("cowork-cloud/hooks/hooks.json has no cloud Cowork hook");
  group.matcher = coworkHookMatcher();
  writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--write")) writeCoworkHookMatcher();
  else process.stdout.write(`${coworkHookMatcher()}\n`);
}
