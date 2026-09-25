#!/usr/bin/env node
// Builds the Claude Desktop extension: dist/sabia-desktop/ (the unpacked
// bundle, used by tests) and dist/sabia.mcpb (the file people install).
//
// The server shares its Cowork reader and HTTP helpers with the CLI; they are
// copied into the bundle so the .mcpb is self-contained and needs no
// dependencies.

import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "dist", "sabia-desktop");
const bundle = join(root, "dist", "sabia.mcpb");

const manifest = JSON.parse(await readFile(join(root, "desktop-extension", "manifest.json"), "utf8"));
const plugin = JSON.parse(await readFile(join(root, ".claude-plugin", "plugin.json"), "utf8"));
if (manifest.version !== plugin.version) {
  throw new Error(`manifest.json ${manifest.version} and plugin.json ${plugin.version} must match`);
}

await rm(out, { recursive: true, force: true });
await rm(bundle, { force: true });
await mkdir(join(out, "server", "lib"), { recursive: true });
await cp(join(root, "desktop-extension", "manifest.json"), join(out, "manifest.json"));
await cp(join(root, "desktop-extension", "icon.png"), join(out, "icon.png"));
await cp(join(root, "desktop-extension", "server", "index.mjs"), join(out, "server", "index.mjs"));
await cp(join(root, "cowork", "scripts", "cowork-local.mjs"), join(out, "server", "lib", "cowork-local.mjs"));
await cp(join(root, "cowork", "scripts", "sabia-http.mjs"), join(out, "server", "lib", "sabia-http.mjs"));
await cp(join(root, "LICENSE"), join(out, "LICENSE"));

await run("zip", ["-qr", "-X", bundle, "."], { cwd: out });
process.stdout.write(`Built ${bundle}\n`);
