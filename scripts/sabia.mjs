#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  approvedHandoff,
  connectHandoff,
  readResponseJson,
} from "./sabia-http.mjs";

const DEFAULT_BASE_URL = "https://app1.sabiapartners.ca";

/**
 * Every variable this plugin owns.
 *
 * Codex's config is TOML and can be fenced off with comment markers; Claude
 * Code's settings are JSON, where a comment would not survive a round trip. So
 * the managed region is this key list instead: connect records what each key
 * held beforehand, and disconnect puts those values back. Someone already
 * exporting telemetry elsewhere gets their own configuration returned rather
 * than deleted.
 */
const MANAGED_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_TRACES_EXPORTER",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE",
  // Written only in raw-capture mode, but managed either way: the list is also
  // what disconnect restores and what reconnecting without --raw-capture has
  // to clear. A key that is only managed when it is set would survive a
  // downgrade and keep exporting prompts to a metrics-only connection.
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_EXPORTER_OTLP_HEADERS",
];

/**
 * Sabia's own key format, which is what makes the header a reliable ownership
 * marker: nothing but this plugin writes a `sbia_ing_` bearer token into Claude
 * Code's settings, so finding one is proof the block is ours to restore.
 */
const INGESTION_KEY_PATTERN = /^sbia_ing_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/;
const MANAGED_HEADER_PATTERN = /Bearer (sbia_ing_[0-9a-f]{12}_[A-Za-z0-9_-]{43})/;

const { command, options } = parseArguments(process.argv.slice(2));
const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const settingsPath = options.settings || join(claudeHome, "settings.json");
const statePath = options.state || join(claudeHome, "sabia-otel-state.json");

try {
  switch (command) {
    case "connect":
      await connect();
      break;
    case "configure":
      await configureHeadless();
      break;
    case "disconnect":
      await disconnect();
      break;
    case "status":
      await status();
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
  const rawCapture = Boolean(options["raw-capture"]);
  const existingState = await readJson(statePath);
  const deviceId = existingState?.deviceId || randomUUID();
  const verifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(verifier).digest("hex");

  const response = await fetch(new URL("/api/v1/telemetry/connect", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "claude_code",
      deviceId,
      deviceName: options["device-name"] || hostname() || "Claude Code device",
      codeChallenge,
      // Asked for here and granted in the browser. Sabia records the answer on
      // the ingestion key, so a connection made without this flag cannot start
      // retaining envelopes later by changing what this machine sends.
      rawCapture,
    }),
  });
  const handoff = connectHandoff(
    await readResponseJson(response, "start browser connection"),
  );
  if (rawCapture) {
    process.stdout.write(
      "Raw capture requested: Claude Code will export prompt text, tool decisions and results, and session identifiers, and Sabia will retain the complete envelopes.\n",
    );
  }
  process.stdout.write(`Open this URL to share Claude Code usage with Sabia:\n${handoff.verificationUri}\n`);

  if (!options["no-open"]) {
    openBrowser(handoff.verificationUri);
  }

  const approved = await pollForApproval(baseUrl, handoff, verifier, rawCapture);
  await installEnv({
    deviceId,
    metricsEndpoint: approved.otlpMetricsEndpoint,
    logsEndpoint: approved.otlpLogsEndpoint,
    ingestionKey: approved.ingestionKey,
    ingestionKeyId: approved.ingestionKeyId,
    organizationId: approved.organizationId,
    organizationName: approved.organizationName,
    rawCapture,
    existingState,
  });

  process.stdout.write(
    rawCapture
      ? `Connected Claude Code telemetry to ${approved.organizationName} with raw capture on. Prompts, tool decisions and results, and token counts are exported and retained. Start a new Claude Code session to pick up the exporter.\n`
      : `Connected Claude Code telemetry to ${approved.organizationName}. Only token counts are exported — prompts, responses, and tool content are not. Start a new Claude Code session to pick up the exporter.\n`,
  );
}

async function configureHeadless() {
  const endpoint = options.endpoint;
  const ingestionKey = options["ingestion-key"];
  if (!endpoint || !ingestionKey) {
    throw new Error("configure requires --endpoint and --ingestion-key");
  }
  // Rejected here rather than discovered later: a key in another format still
  // installs a working-looking exporter, but leaves no marker, so `status` and
  // `disconnect` would both report nothing is configured.
  if (!INGESTION_KEY_PATTERN.test(ingestionKey)) {
    throw new Error("--ingestion-key must be a Sabia ingestion key");
  }
  new URL(endpoint);
  const rawCapture = Boolean(options["raw-capture"]);

  const existingState = await readJson(statePath);
  await installEnv({
    deviceId: existingState?.deviceId || randomUUID(),
    // One authenticated endpoint serves both signals, and a headless caller has
    // only the one URL to give.
    metricsEndpoint: endpoint,
    logsEndpoint: endpoint,
    ingestionKey,
    ingestionKeyId: null,
    organizationId: null,
    organizationName: options.organization || "headless environment",
    rawCapture,
    existingState,
  });
  process.stdout.write(
    rawCapture
      ? "Configured Claude Code native OTel metrics and event export. Sabia retains raw envelopes only if this key was approved for raw capture.\n"
      : "Configured Claude Code native OTel metrics export.\n",
  );
}

async function disconnect() {
  const state = await readJson(statePath);
  const settings = await readSettings();
  const env = plainObject(settings.env) ? { ...settings.env } : null;
  if (!env || !isManaged(env)) {
    process.stdout.write("Sabia telemetry is not configured in these Claude Code settings.\n");
    return;
  }

  if (!options["local-only"]) {
    const token = env.OTEL_EXPORTER_OTLP_HEADERS.match(MANAGED_HEADER_PATTERN)?.[1];
    const endpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    if (!token || !endpoint) {
      throw new Error("the managed exporter is incomplete; revoke it in Sabia Settings before removing it locally");
    }

    const response = await fetch(new URL("/api/v1/telemetry/connection", endpoint), {
      method: "DELETE",
      redirect: "manual",
      headers: { authorization: `Bearer ${token}` },
    });
    // 204 success and 401 already-revoked both continue to local cleanup.
    if (response.status !== 204 && response.status !== 401) {
      await readResponseJson(response, "revoke this device");
    }
  }

  const previousEnv = plainObject(state?.previousEnv) ? state.previousEnv : {};
  for (const key of MANAGED_KEYS) {
    const value = previousEnv[key];
    if (typeof value === "string") {
      env[key] = value;
    } else {
      delete env[key];
    }
  }

  if (Object.keys(env).length > 0) {
    settings.env = env;
  } else {
    // Do not leave behind an empty block that only exists because of Sabia.
    delete settings.env;
  }

  await writeSettings(settings);
  await atomicWrite(
    statePath,
    JSON.stringify({ deviceId: state?.deviceId || randomUUID() }, null, 2) + "\n",
  );
  process.stdout.write("Disconnected Sabia and restored the previous Claude Code telemetry settings.\n");
}

async function status() {
  const settings = await readSettings();
  const env = plainObject(settings.env) ? settings.env : {};
  const state = await readJson(statePath);
  if (!isManaged(env)) {
    process.stdout.write("Sabia telemetry: disconnected\n");
    return;
  }

  process.stdout.write("Sabia telemetry: connected\n");
  process.stdout.write(`Organization: ${state?.organizationName || "unknown"}\n`);
  process.stdout.write(
    `Endpoint: ${env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || "unknown"}\n`,
  );
  // Read from the settings rather than the state file: the settings are what
  // Claude Code actually exports from, and the state file can go missing.
  process.stdout.write(
    env.OTEL_LOGS_EXPORTER === "otlp"
      ? "Exports: token metrics and events, including prompt text and tool details (traces off)\n"
      : "Exports: token metrics only (logs and traces off)\n",
  );
}

async function installEnv(input) {
  const settings = await readSettings();
  const env = plainObject(settings.env) ? { ...settings.env } : {};

  // Capture the user's own values once. Reconnecting to rotate a key must not
  // record Sabia's own block as "what was there before", or disconnect would
  // restore a revoked exporter instead of removing it.
  //
  // The stored state is not the only guard, because it can go missing: the
  // state file gets deleted, or `writeSettings` succeeds and the `atomicWrite`
  // after it does not. `isManaged` is the ownership check that does not depend
  // on it — if the block is already ours, there is nothing of the user's left
  // in these keys to preserve, so previous is absent rather than recaptured.
  const previousEnv = plainObject(input.existingState?.previousEnv)
    ? input.existingState.previousEnv
    : isManaged(env)
      ? absentPrevious()
      : capturePrevious(env);

  // Assigned key by key rather than merged, so a managed key the current mode
  // does not write is removed instead of surviving. Reconnecting without
  // --raw-capture is a downgrade, and a stale OTEL_LOG_USER_PROMPTS=1 would
  // keep sending prompt text to a connection that no longer retains it.
  const managed = managedEnv(input);
  for (const key of MANAGED_KEYS) {
    if (key in managed) {
      env[key] = managed[key];
    } else {
      delete env[key];
    }
  }
  settings.env = env;

  await writeSettings(settings);
  await atomicWrite(
    statePath,
    JSON.stringify(
      {
        deviceId: input.deviceId,
        ingestionKeyId: input.ingestionKeyId,
        organizationId: input.organizationId,
        organizationName: input.organizationName,
        endpoint: input.metricsEndpoint,
        rawCapture: Boolean(input.rawCapture),
        previousEnv,
        connectedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
}

function managedEnv(input) {
  const env = {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    // Claude Code's log records carry prompt and tool content, so they are off
    // unless this connection was explicitly approved for raw capture.
    OTEL_LOGS_EXPORTER: input.rawCapture ? "otlp" : "none",
    OTEL_TRACES_EXPORTER: "none",
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json",
    // The full signal URL, not a base one — the metrics-specific variable is
    // used verbatim rather than having "/v1/metrics" appended to it.
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: input.metricsEndpoint,
    // Cumulative restates the running total on every export, so Sabia would
    // double-count it against what it already stored. The normalizer rejects
    // cumulative datapoints rather than guessing, which would look like silent
    // data loss from here.
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "delta",
    // The signal-agnostic header variable, which is the one Claude Code
    // documents. It carries the key to whichever signals are enabled, which is
    // exactly the set Sabia asked for: metrics always, logs only when this
    // connection was approved for them.
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${input.ingestionKey}`,
  };

  if (input.rawCapture) {
    env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http/json";
    env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = input.logsEndpoint;
    env.OTEL_LOG_USER_PROMPTS = "1";
    env.OTEL_LOG_TOOL_DETAILS = "1";
    // OTEL_LOG_TOOL_CONTENT and OTEL_LOG_RAW_API_BODIES stay unset. They carry
    // whole file contents and complete Messages API conversations, which is a
    // separate privacy decision from the one this flag asks for.
  }

  return env;
}

/** Every managed key recorded as absent, so disconnect deletes rather than restores. */
function absentPrevious() {
  return Object.fromEntries(MANAGED_KEYS.map((key) => [key, null]));
}

function capturePrevious(env) {
  const previous = {};
  for (const key of MANAGED_KEYS) {
    // null records "was absent", so disconnect deletes the key rather than
    // restoring an empty string over it.
    previous[key] = typeof env[key] === "string" ? env[key] : null;
  }
  return previous;
}

function isManaged(env) {
  return (
    typeof env.OTEL_EXPORTER_OTLP_HEADERS === "string" &&
    MANAGED_HEADER_PATTERN.test(env.OTEL_EXPORTER_OTLP_HEADERS)
  );
}

async function readSettings() {
  const text = await readText(settingsPath);
  if (!text.trim()) return {};

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Refusing beats rewriting: these settings are the user's, and a parse
    // failure means anything written back would drop whatever was not
    // understood.
    throw new Error(`${settingsPath} is not valid JSON; fix it before connecting Sabia`);
  }
  if (!plainObject(parsed)) {
    throw new Error(`${settingsPath} does not contain a settings object`);
  }
  return parsed;
}

async function writeSettings(settings) {
  // Mode 0600 because the file now holds an ingestion key.
  await atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

async function pollForApproval(baseUrl, handoff, verifier, rawCapture) {
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
      rawCapture,
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
    if (["no-open", "local-only", "raw-capture"].includes(key)) {
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

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.sabia-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function readText(path) {
  return readFile(path, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
}

async function readJson(path) {
  const value = await readText(path);
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`could not read ${path}`);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function usage() {
  process.stdout.write(`Usage:
  sabia.mjs connect [--base-url URL] [--device-name NAME] [--no-open] [--raw-capture]
  sabia.mjs status
  sabia.mjs disconnect [--local-only]
  sabia.mjs configure --endpoint URL --ingestion-key KEY [--organization NAME] [--raw-capture]

  --raw-capture exports prompt text and tool details in addition to token
  counts, and asks Sabia to retain the complete OpenTelemetry envelopes.
`);
}
