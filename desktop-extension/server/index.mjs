#!/usr/bin/env node
// Sabia for Claude Desktop: a Desktop Extension (MCPB) that shares this
// device's Claude Cowork usage with a Sabia organization, on any Claude plan.
//
// Claude Desktop starts this server itself, on the host, so nothing is run in
// a terminal. On the first start after install it opens Sabia's approval page
// once; after approval it syncs Cowork's per-turn usage from the desktop app's
// local session logs at start-up and every ten minutes while Claude is open,
// and whenever one of its tools is called.
//
// The protocol is MCP over stdio (newline-delimited JSON-RPC 2.0). Only
// stdout carries protocol messages; everything else goes to stderr.

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import {
  claudeAppDataDirectory,
  readJson,
  syncCoworkUsage,
  writeJson,
} from "./lib/cowork-local.mjs";
import { approvedHandoff, connectHandoff, readResponseJson } from "./lib/sabia-http.mjs";

const SERVER_INFO = { name: "sabia", version: "0.4.0" };
const PROTOCOL_VERSION = "2025-06-18";
const SYNC_INTERVAL_MS = 10 * 60 * 1_000;

const baseUrl = normalizedBaseUrl(process.env.SABIA_APP_URL || "https://app2.sabiapartners.ca");
const shareContent = process.env.SABIA_SHARE_CONTENT === "true";
const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
// Shared with `cowork/scripts/sabia.mjs connect --local`, so the CLI and the
// extension never hold two keys for one device.
const statePath = process.env.SABIA_LOCAL_STATE || join(claudeHome, "sabia-cowork-local-state.json");
const cursorPath = process.env.SABIA_LOCAL_CURSOR || join(claudeHome, "sabia-cowork-local-cursor.json");
const pendingPath = process.env.SABIA_PENDING_CONNECT || join(claudeHome, "sabia-desktop-connect.json");
const appDataDirectory = claudeAppDataDirectory();
const openBrowserEnabled = process.env.SABIA_NO_BROWSER !== "1";

let lastSync = null;
let syncing = null;
let polling = null;
let timer = null;
// The approval being started, so status asked mid-start reports it rather
// than "not connected".
let starting = null;

const log = (message) => process.stderr.write(`[sabia] ${message}\n`);

// ---- connection -----------------------------------------------------------

async function connectedState() {
  const state = await readJson(statePath);
  return state?.ingestionKey ? state : null;
}

/**
 * Starts the browser approval, or returns the one already waiting. A pending
 * approval survives restarts so Claude Desktop re-launching the server does
 * not open a new tab each time.
 */
function beginConnect({ open }) {
  starting ??= startConnect({ open }).finally(() => {
    starting = null;
  });
  return starting;
}

const lockPath = `${pendingPath}.lock`;
const LOCK_STALE_MS = 60 * 1_000;

async function waitingApproval() {
  const pending = await readJson(pendingPath);
  return pending && Date.parse(pending.expiresAt) > Date.now() ? pending : null;
}

/**
 * Claude Desktop can start this server twice at once (install, then enable).
 * Only the process that creates the lock file starts an approval; the other
 * waits for it and reuses it, so one device never ends up with two keys.
 */
async function acquireConnectLock() {
  // A fresh machine may not have the Claude config folder yet.
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs < LOCK_STALE_MS) return false;
      await rm(lockPath, { force: true }); // left by a process that died
    }
  }
  return false;
}

async function startConnect({ open }) {
  const pending = await waitingApproval();
  if (pending) {
    pollUntilApproved(pending);
    return pending.verificationUri;
  }

  if (!(await acquireConnectLock())) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await connectedState()) {
        startSyncLoop();
        return null;
      }
      const theirs = await waitingApproval();
      if (theirs) {
        pollUntilApproved(theirs);
        return theirs.verificationUri;
      }
      await delay(100);
    }
    throw new Error("another Sabia process is starting the connection; try again in a moment");
  }
  try {
    return await createApproval({ open, pending });
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function createApproval({ open, pending }) {
  const existing = await readJson(statePath);
  const deviceId = existing?.deviceId || pending?.deviceId || randomUUID();
  const verifier = randomBytes(32).toString("base64url");
  const response = await fetch(new URL("/api/v1/telemetry/connect", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "cowork",
      deviceId,
      deviceName: `${hostname() || "This device"} (Claude Desktop)`,
      codeChallenge: createHash("sha256").update(verifier).digest("hex"),
      // Asked for, not assumed: an owner or administrator approves it, and
      // sync sends content only once Sabia records the grant.
      rawCapture: shareContent,
    }),
  });
  const handoff = connectHandoff(await readResponseJson(response, "start the Sabia connection"));
  const next = { ...handoff, verifier, deviceId };
  await writeJson(pendingPath, next);
  if (open) openBrowser(handoff.verificationUri);
  pollUntilApproved(next);
  return handoff.verificationUri;
}

function pollUntilApproved(pending) {
  if (polling) return polling;
  polling = (async () => {
    try {
      while (Date.parse(pending.expiresAt) > Date.now()) {
        await delay(Math.max(1, pending.intervalSeconds || 2) * 1_000);
        const url = new URL(`/api/v1/telemetry/connect/${pending.sessionId}`, baseUrl);
        url.searchParams.set("verifier", pending.verifier);
        let response;
        try {
          response = await fetch(url, { redirect: "manual" });
        } catch {
          continue;
        }
        if (response.status === 202) continue;
        if (response.status === 410) break;
        const approved = approvedHandoff(await readResponseJson(response, "complete the Sabia connection"));
        await writeJson(statePath, {
          deviceId: pending.deviceId,
          baseUrl: baseUrl.toString(),
          ingestionKeyId: approved.ingestionKeyId,
          ingestionKey: approved.ingestionKey,
          organizationId: approved.organizationId,
          organizationName: approved.organizationName,
          otlpLogsEndpoint: approved.otlpLogsEndpoint,
          content: shareContent,
          connectedAt: new Date().toISOString(),
          connectedBy: "claude-desktop-extension",
        });
        await rm(pendingPath, { force: true });
        log(`connected to ${approved.organizationName}`);
        startSyncLoop();
        return;
      }
      await rm(pendingPath, { force: true });
    } catch (error) {
      log(`connection failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      polling = null;
    }
  })();
  return polling;
}

// ---- sync -----------------------------------------------------------------

async function syncNow() {
  if (syncing) return syncing;
  syncing = (async () => {
    const state = await connectedState();
    if (!state) return (lastSync = { status: "not_connected", at: new Date().toISOString() });
    try {
      const result = await syncCoworkUsage({
        state: { ...state, baseUrl: state.baseUrl || baseUrl.toString() },
        cursorPath,
        appDataDirectory,
      });
      lastSync = { ...result, at: new Date().toISOString() };
      if (result.status === "revoked") stopSyncLoop();
    } catch (error) {
      lastSync = { status: "failed", error: error instanceof Error ? error.message : "unknown", at: new Date().toISOString() };
    }
    log(`sync ${lastSync.status}: ${lastSync.sent ?? 0} events`);
    return lastSync;
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

function startSyncLoop() {
  if (timer) return;
  void syncNow();
  timer = setInterval(() => void syncNow(), SYNC_INTERVAL_MS);
  timer.unref();
}

function stopSyncLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---- tools ----------------------------------------------------------------

const tools = [
  {
    name: "sabia_status",
    description: "Show whether this device's Claude Cowork usage is connected to Sabia, and the last sync.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "sabia_connect",
    description: "Connect this device's Claude Cowork usage to a Sabia organization. Returns the approval link to open.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "sabia_sync_now",
    description: "Send Claude Cowork usage recorded since the last sync to Sabia now.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function callTool(name) {
  await startup;
  if (name === "sabia_status") return statusText();
  if (name === "sabia_connect") {
    const state = await connectedState();
    if (state) return `Already connected to ${state.organizationName}. ${await statusText()}`;
    const link = await beginConnect({ open: true });
    if (!link) return `Connected. ${await statusText()}`;
    return `Open this link to approve sharing Cowork usage with Sabia: ${link}`;
  }
  if (name === "sabia_sync_now") {
    const result = await syncNow();
    if (result.status === "not_connected") return "Not connected yet. Use sabia_connect first.";
    return describeSync(result);
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function statusText() {
  if (starting) await starting.catch(() => undefined);
  const state = await connectedState();
  if (!state) {
    const pending = await readJson(pendingPath);
    return pending && Date.parse(pending.expiresAt) > Date.now()
      ? `Waiting for approval: ${pending.verificationUri}`
      : "Not connected. Use sabia_connect to connect this device.";
  }
  return [
    `Connected to ${state.organizationName}.`,
    state.content ? "Content capture requested (sent once approved in Sabia)." : "Usage only.",
    lastSync ? `Last sync: ${describeSync(lastSync)}` : "No sync yet in this session.",
  ].join(" ");
}

function describeSync(result) {
  if (result.status === "revoked") return "the connection was revoked in Sabia; use sabia_connect to reconnect.";
  if (result.status === "unreachable") return `Sabia could not be reached; ${result.sent} events sent, the rest retry automatically.`;
  if (result.status === "failed") return `failed (${result.error}).`;
  return `sent ${result.sent} events from ${result.sessions} sessions${result.content ? " with content" : ""} at ${result.at}.`;
}

// ---- MCP stdio ------------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  const { id, method, params } = message;
  const reply = (result) => id !== undefined && send({ jsonrpc: "2.0", id, result });
  const fail = (code, text) => id !== undefined && send({ jsonrpc: "2.0", id, error: { code, message: text } });

  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools });
    case "tools/call":
      try {
        const text = await callTool(params?.name);
        return reply({ content: [{ type: "text", text }] });
      } catch (error) {
        return reply({
          content: [{ type: "text", text: error instanceof Error ? error.message : "Sabia failed" }],
          isError: true,
        });
      }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  void handle(message);
});
input.on("close", () => process.exit(0));

// ---- start-up -------------------------------------------------------------

// Tool calls wait for this, so a status asked in the first milliseconds
// reports the connection being started rather than "not connected".
const startup = (async () => {
  try {
    if (await connectedState()) startSyncLoop();
    else await beginConnect({ open: openBrowserEnabled });
  } catch (error) {
    log(`start-up: ${error instanceof Error ? error.message : "unknown error"}`);
  }
})();

// ---- helpers --------------------------------------------------------------

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

function normalizedBaseUrl(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Sabia URL must use HTTP or HTTPS");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds).unref?.());
}
