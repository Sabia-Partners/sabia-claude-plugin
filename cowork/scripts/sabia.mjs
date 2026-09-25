#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { claudeAppDataDirectory, syncCoworkUsage } from "./cowork-local.mjs";
import {
  approvedHandoff,
  connectHandoff,
  readResponseJson,
} from "./sabia-http.mjs";

/**
 * Claude Cowork has no per-device exporter config to write: its OpenTelemetry
 * export is switched on by a Claude organization admin under
 * Admin settings > Cowork (endpoint, protocol, headers). This helper runs the
 * same browser handoff the other connectors use, then prints exactly what to
 * paste into those three fields. See docs/cowork-otel-connector.md.
 */

const DEFAULT_BASE_URL = "https://app2.sabiapartners.ca";

const { command, options } = parseArguments(process.argv.slice(2));
const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const statePath = options.state || join(claudeHome, "sabia-cowork-otel-state.json");
// The local collector is a separate connection from the admin export: its key
// belongs to the person on this device, so their usage is attributed to them.
const localStatePath =
  options["local-state"] || join(claudeHome, "sabia-cowork-local-state.json");
const cursorPath = options.cursor || join(claudeHome, "sabia-cowork-local-cursor.json");
const LAUNCH_AGENT_LABEL = "ca.sabiapartners.cowork-sync";
const launchAgentPath = join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
const SYNC_INTERVAL_SECONDS = 600;

try {
  switch (command) {
    case "connect":
      if (options.local) await connectLocal();
      else await connect();
      break;
    case "sync":
      await sync();
      break;
    case "schedule":
      await schedule();
      break;
    case "unschedule":
      await unschedule();
      break;
    case "settings":
      await settings();
      break;
    case "status":
      await status();
      break;
    case "disconnect":
      await disconnect();
      break;
    case "record-output":
      await recordOutput();
      break;
    default:
      usage();
      process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`Sabia: ${error instanceof Error ? error.message : "Unexpected failure"}\n`);
  process.exitCode = 1;
}

async function connect() {
  const baseUrl = normalizedBaseUrl(
    options["base-url"] || process.env.SABIA_APP_URL || DEFAULT_BASE_URL,
  );
  const existingState = await readJson(statePath);
  const deviceId = existingState?.deviceId || randomUUID();
  const verifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(verifier).digest("hex");
  const toolDetails = Boolean(options["tool-details"]);

  const response = await fetch(new URL("/api/v1/telemetry/connect", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "cowork",
      deviceId,
      deviceName: options["device-name"] || `${hostname() || "Cowork"} (Cowork)`,
      codeChallenge,
      // Token-only by default. The wider grant retains a reduced tool
      // extract — never the envelope — and the approval screen says so.
      rawCapture: toolDetails,
    }),
  });
  const handoff = connectHandoff(
    await readResponseJson(response, "start browser connection"),
  );
  process.stdout.write(
    `Open this URL to share Cowork ${toolDetails ? "tool details and usage" : "usage"} with Sabia:\n${handoff.verificationUri}\n`,
  );
  if (!options["no-open"]) openBrowser(handoff.verificationUri);

  const approved = await pollForApproval(baseUrl, handoff, verifier);
  const state = {
    deviceId,
    baseUrl: baseUrl.toString(),
    ingestionKeyId: approved.ingestionKeyId,
    ingestionKey: approved.ingestionKey,
    organizationId: approved.organizationId,
    organizationName: approved.organizationName,
    otlpLogsEndpoint: approved.otlpLogsEndpoint,
    toolDetails,
    connectedAt: new Date().toISOString(),
  };
  await writeJson(statePath, state);

  process.stdout.write(
    `Connected Cowork telemetry to ${approved.organizationName}.\n\n`,
  );
  printAdminSettings(state);
}

/**
 * Connects this device's own Cowork sessions, read from the desktop app's
 * local session logs. For Claude plans without Cowork's admin OTel export
 * (Pro, Max). The key is this person's, so usage is attributed to them.
 */
async function connectLocal() {
  const baseUrl = normalizedBaseUrl(
    options["base-url"] || process.env.SABIA_APP_URL || DEFAULT_BASE_URL,
  );
  const existingState = await readJson(localStatePath);
  const deviceId = existingState?.deviceId || randomUUID();
  const verifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(verifier).digest("hex");
  const content = Boolean(options.content);

  const response = await fetch(new URL("/api/v1/telemetry/connect", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "cowork",
      deviceId,
      deviceName: options["device-name"] || `${hostname() || "This device"} (Cowork)`,
      codeChallenge,
      // Content capture is asked for, not assumed: an owner or administrator
      // approves the grant, and sync sends content only once it is granted.
      rawCapture: content,
    }),
  });
  const handoff = connectHandoff(
    await readResponseJson(response, "start browser connection"),
  );
  process.stdout.write(
    `Open this URL to share this device's Cowork ${content ? "usage and content" : "usage"} with Sabia:\n${handoff.verificationUri}\n`,
  );
  if (!options["no-open"]) openBrowser(handoff.verificationUri);

  const approved = await pollForApproval(baseUrl, handoff, verifier);
  await writeJson(localStatePath, {
    deviceId,
    baseUrl: baseUrl.toString(),
    ingestionKeyId: approved.ingestionKeyId,
    ingestionKey: approved.ingestionKey,
    organizationId: approved.organizationId,
    organizationName: approved.organizationName,
    otlpLogsEndpoint: approved.otlpLogsEndpoint,
    content,
    connectedAt: new Date().toISOString(),
  });
  process.stdout.write(
    [
      `Connected this device's Cowork sessions to ${approved.organizationName}.`,
      content
        ? "Content capture was requested. Prompts, responses and tool details are sent only after an owner or administrator approves it; until then, usage only."
        : "Usage only: model, token counts, times and session ids. No prompts, responses or file contents.",
      "",
    ].join("\n"),
  );

  if (!options["no-schedule"]) await schedule();
  if (!options["no-sync"]) await sync();
}

/**
 * Sends Cowork usage (and granted content) recorded since the last run. Safe
 * to run repeatedly: each file resumes from its saved offset, and a resent
 * call keeps its idempotency key.
 */
async function sync() {
  const state = await readJson(localStatePath);
  if (!state?.ingestionKey) {
    throw new Error("this device's Cowork sessions are not connected; run connect --local first");
  }
  const result = await syncCoworkUsage({
    state: { ...state, baseUrl: state.baseUrl || DEFAULT_BASE_URL },
    cursorPath,
    appDataDirectory: options["app-data"] || claudeAppDataDirectory(),
  });
  if (result.status === "revoked") {
    process.stderr.write("Sabia: this device's Cowork connection was revoked. Run connect --local again.\n");
    process.exitCode = 1;
    return;
  }
  if (result.status === "unreachable") {
    process.stderr.write(`Sabia: could not reach Sabia; ${result.sent} events sent, the rest retry next run.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Sent ${result.sent} Cowork events from ${result.sessions} sessions${result.content ? " (with content)" : ""}.\n`,
  );
}

/** Runs sync in the background every ten minutes (macOS LaunchAgent). */
async function schedule() {
  const script = fileURLToPath(import.meta.url);
  if (process.platform !== "darwin") {
    process.stdout.write(
      `Automatic sync is set up on macOS only. Schedule this every 10 minutes:\n  ${process.execPath} ${script} sync\n`,
    );
    return;
  }
  const logPath = join(claudeHome, "sabia-cowork-sync.log");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(script)}</string>
    <string>sync</string>
  </array>
  <key>StartInterval</key><integer>${SYNC_INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`;
  await mkdir(dirname(launchAgentPath), { recursive: true });
  await writeFile(launchAgentPath, plist, { mode: 0o644 });
  const domain = `gui/${process.getuid()}`;
  await launchctl(["bootout", domain, launchAgentPath]).catch(() => undefined);
  await launchctl(["bootstrap", domain, launchAgentPath]);
  process.stdout.write(
    `Cowork usage now syncs every ${SYNC_INTERVAL_SECONDS / 60} minutes (log: ${logPath}).\n`,
  );
}

async function unschedule() {
  if (process.platform !== "darwin") return;
  await launchctl(["bootout", `gui/${process.getuid()}`, launchAgentPath]).catch(() => undefined);
  await rm(launchAgentPath, { force: true });
}

function launchctl(args) {
  return new Promise((resolve, reject) => {
    execFile("launchctl", args, (error) => (error ? reject(error) : resolve()));
  });
}

function xml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function settings() {
  const state = await readJson(statePath);
  if (!state?.ingestionKey) {
    throw new Error("Cowork is not connected on this device; run connect first");
  }
  printAdminSettings(state);
}

async function status() {
  const state = await readJson(statePath);
  if (!state?.ingestionKey) {
    process.stdout.write("Cowork is not connected to Sabia on this device.\n");
    return;
  }
  const response = await fetch(
    new URL("/api/v1/telemetry/connection", state.baseUrl || DEFAULT_BASE_URL),
    { headers: { authorization: `Bearer ${state.ingestionKey}` }, redirect: "manual" },
  );
  if (response.status === 401) {
    process.stdout.write(
      `The Cowork connection to ${state.organizationName} was revoked. Run connect again.\n`,
    );
    return;
  }
  const sheet = await readResponseJson(response, "read connection");
  process.stdout.write(
    [
      `Organization: ${state.organizationName}`,
      `Key: ${String(state.ingestionKey).slice(0, 21)}…`,
      `Tool details: ${sheet.rawCapture ? "granted" : "not granted (token activity only)"}`,
      `Logs endpoint: ${sheet.otlpLogsEndpoint}`,
      "",
    ].join("\n"),
  );
}

async function disconnect() {
  if (options.local) return disconnectLocal();
  const state = await readJson(statePath);
  if (!state?.ingestionKey) {
    process.stdout.write("Cowork is not connected to Sabia on this device.\n");
    return;
  }
  if (!options["local-only"]) {
    const response = await fetch(
      new URL("/api/v1/telemetry/connection", state.baseUrl || DEFAULT_BASE_URL),
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${state.ingestionKey}` },
        redirect: "manual",
      },
    );
    if (response.status !== 204 && response.status !== 401) {
      throw new Error(
        `could not revoke the Cowork connection (HTTP ${response.status}); retry, or revoke the device from Sabia Usage Connections`,
      );
    }
  }
  await rm(statePath, { force: true });
  process.stdout.write(
    "Disconnected. Remove the Sabia endpoint from Admin settings > Cowork so sessions stop exporting to a revoked key.\n",
  );
}

async function disconnectLocal() {
  const state = await readJson(localStatePath);
  await unschedule();
  if (!state?.ingestionKey) {
    process.stdout.write("This device's Cowork sessions are not connected to Sabia.\n");
    return;
  }
  if (!options["local-only"]) {
    const response = await fetch(
      new URL("/api/v1/telemetry/connection", state.baseUrl || DEFAULT_BASE_URL),
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${state.ingestionKey}` },
        redirect: "manual",
      },
    );
    if (response.status !== 204 && response.status !== 401) {
      throw new Error(
        `could not revoke this device (HTTP ${response.status}); retry, or revoke it from Sabia Usage Connections`,
      );
    }
  }
  await rm(localStatePath, { force: true });
  await rm(cursorPath, { force: true });
  process.stdout.write(
    "Disconnected this device's Cowork sessions and stopped the background sync.\n",
  );
}

async function recordOutput() {
  const state = await readJson(statePath);
  if (!state?.ingestionKey) {
    throw new Error("Cowork is not connected on this device; run connect first");
  }

  const workflowRunId = requiredOption("workflow-run-id");
  const kind = requiredOption("kind");
  const externalId = requiredOption("external-id");
  const parents = {
    document_create: "document", document_edit: "document", document_comment: "document",
    spreadsheet_create: "spreadsheet", spreadsheet_edit: "spreadsheet", spreadsheet_add_sheet: "spreadsheet", spreadsheet_comment: "spreadsheet",
    presentation_create: "presentation", presentation_edit: "presentation", presentation_add_slide: "presentation",
  };
  if (!Object.hasOwn(parents, kind)) throw new Error("--kind must identify the completed Workspace action, such as document_create or spreadsheet_edit");
  const parentId = kind.endsWith("_comment") ? externalId.match(/^(.+)\/(?:comments|replies)\/[A-Za-z0-9_-]{1,128}$/)?.[1] : externalId;
  if (!parentId) throw new Error("Comments require the returned parent-qualified comment or reply id");
  const producedAt = options["produced-at"] || new Date().toISOString();
  if (!Number.isFinite(Date.parse(producedAt))) {
    throw new Error("--produced-at must be an ISO-8601 timestamp");
  }
  if (options.url && !isHttpUrl(options.url)) {
    throw new Error("--url must use HTTP or HTTPS");
  }

  const response = await fetch(
    new URL("/api/v1/outputs", state.baseUrl || DEFAULT_BASE_URL),
    {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${state.ingestionKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workflowRunId,
        kind,
        sourceSystem: "google_drive",
        externalId,
        artifact: { kind: parents[kind], sourceSystem: "google_drive", externalId: parentId },
        ...(options["display-label"]
          ? { displayLabel: options["display-label"] }
          : {}),
        ...(options.url ? { url: options.url } : {}),
        producedAt,
      }),
    },
  );
  await readResponseJson(response, "record the Cowork Output");
  process.stdout.write(`Recorded Google Drive ${kind} ${externalId} for Cowork session ${workflowRunId}.\n`);
}

function requiredOption(name) {
  const value = options[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value.trim();
}

function printAdminSettings(state) {
  process.stdout.write(
    [
      "Paste these into Claude Admin settings > Cowork, then start a new Cowork session:",
      "",
      `  OTLP endpoint:  ${state.otlpLogsEndpoint}`,
      "  OTLP protocol:  http/json",
      `  OTLP headers:   Authorization=Bearer ${state.ingestionKey}`,
      "",
      state.toolDetails
        ? "Tool details were granted. Sabia keeps a reduced per-tool extract and the arguments of Google Drive content mutations only — and only when the admin's otlpContentCapture setting includes toolDetails."
        : "Token activity only. Re-run connect --tool-details to let Sabia identify Google Drive files Cowork produces.",
      "",
    ].join("\n"),
  );
}

async function pollForApproval(baseUrl, handoff, verifier) {
  const expiresAt = new Date(handoff.expiresAt).getTime();
  while (Date.now() < expiresAt) {
    await delay(Math.max(1, handoff.intervalSeconds || 2) * 1_000);
    const url = new URL(`/api/v1/telemetry/connect/${handoff.sessionId}`, baseUrl);
    url.searchParams.set("verifier", verifier);
    const response = await fetch(url, { redirect: "manual" });
    if (response.status === 202) continue;
    if (response.status === 410) throw new Error("the browser connection expired or was cancelled");
    return approvedHandoff(
      await readResponseJson(response, "complete browser connection"),
    );
  }
  throw new Error("the browser connection expired");
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

function parseArguments(args) {
  const command = args[0] || "status";
  const options = {};
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (
      ["no-open", "local-only", "tool-details", "local", "content", "no-schedule", "no-sync"].includes(key)
    ) {
      options[key] = true;
    } else {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
      options[key] = value;
      index += 1;
    }
  }
  return { command, options };
}

function normalizedBaseUrl(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Sabia base URL must use HTTP or HTTPS");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function usage() {
  process.stdout.write(
    [
      "Usage: node sabia.mjs <connect|settings|status|record-output|disconnect> [options]",
      "",
      "  connect [--tool-details] [--base-url <url>] [--device-name <name>] [--no-open]",
      "  connect --local [--content] [--no-schedule] [--no-sync]",
      "                  Share this device's Cowork sessions from the desktop app's local",
      "                  logs (Pro/Max plans). --content asks to include prompts, responses",
      "                  and tool details once an owner or administrator approves.",
      "  sync            Send Cowork usage recorded since the last sync",
      "  schedule | unschedule   Background sync every 10 minutes (macOS)",
      "  disconnect --local      Revoke this device and stop the background sync",
      "  settings        Print the Admin settings > Cowork values again",
      "  status          Show the grant Sabia currently records for this key",
      "  disconnect [--local-only]",
      "  record-output --workflow-run-id <session.id> --kind <document_create|document_edit|document_comment|spreadsheet_create|spreadsheet_edit|spreadsheet_add_sheet|spreadsheet_comment|presentation_create|presentation_edit|presentation_add_slide> --external-id <drive-file-id>",
      "                [--display-label <label>] [--url <drive-url>] [--produced-at <ISO-8601>]",
      "",
    ].join("\n"),
  );
}
