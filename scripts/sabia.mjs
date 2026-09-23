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

const DEFAULT_BASE_URL = "https://app2.sabiapartners.ca";

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
  // Written only for the tool-output grant (SAB-81); managed either way so a
  // reconnect without --tool-output stops the trace export instead of leaving
  // it running against a connection that no longer accepts it.
  "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_LOG_TOOL_CONTENT",
  "OTEL_LOG_ASSISTANT_RESPONSES",
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
    case "sync":
      await sync();
      break;
    case "approve":
      await approve();
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
  const traceCapture = Boolean(options["tool-output"]);
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
      // Tool result bodies (SAB-81): its own grant, never implied by
      // --raw-capture, and refused server-side for any other source.
      traceCapture,
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
  if (traceCapture) {
    process.stdout.write(
      "Tool output requested: Claude Code will export tool result bodies — command output and possibly file contents; MCP response bodies are not exported by the client today — and Sabia will keep a reduced per-tool extract.\n",
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
    tracesEndpoint: new URL("/api/v1/telemetry/traces", baseUrl).toString(),
    ingestionKey: approved.ingestionKey,
    ingestionKeyId: approved.ingestionKeyId,
    organizationId: approved.organizationId,
    organizationName: approved.organizationName,
    rawCapture,
    traceCapture,
    existingState,
  });

  process.stdout.write(
    `Connected Claude Code telemetry to ${approved.organizationName}. ${describeCapture({ rawCapture, traceCapture })} Start a new Claude Code session to pick up the exporter.\n`,
  );
}

/**
 * What this connection actually exports, in one sentence.
 *
 * The two grants are independent, so there are four states and every surface
 * has to agree on them. Describing capture from a single place is what stops
 * `connect` claiming tool content is not exported while `--tool-output` is
 * busy exporting it.
 */
function describeCapture({ rawCapture, traceCapture }) {
  if (rawCapture && traceCapture) {
    return "Prompts, tool decisions, tool result bodies, and token counts are exported; Sabia retains the envelopes and a reduced per-tool extract.";
  }
  if (rawCapture) {
    return "Prompts, tool decisions, and token counts are exported and retained. Tool result bodies are not.";
  }
  if (traceCapture) {
    return "Tool result bodies and token counts are exported, and Sabia keeps a reduced per-tool extract. Prompt text and assistant responses are not exported.";
  }
  return "Only token counts are exported — prompts, responses, and tool content are not.";
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
  const traceCapture = Boolean(options["tool-output"]);

  const existingState = await readJson(statePath);
  await installEnv({
    deviceId: existingState?.deviceId || randomUUID(),
    // One authenticated endpoint serves both signals, and a headless caller has
    // only the one URL to give. Traces have their own route, derived from the
    // same origin.
    metricsEndpoint: endpoint,
    logsEndpoint: endpoint,
    tracesEndpoint: new URL("/api/v1/telemetry/traces", endpoint).toString(),
    ingestionKey,
    ingestionKeyId: null,
    organizationId: null,
    organizationName: options.organization || "headless environment",
    rawCapture,
    traceCapture,
    existingState,
  });
  process.stdout.write(
    `Configured Claude Code native OTel export. ${describeCapture({ rawCapture, traceCapture })} Sabia honours each grant only if this key was approved for it.\n`,
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
      throw new Error("the managed exporter is incomplete; revoke it in Sabia Usage Connections before removing it locally");
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
    `Exports: ${describeCapture({
      rawCapture: env.OTEL_LOGS_EXPORTER === "otlp",
      traceCapture: env.OTEL_TRACES_EXPORTER === "otlp",
    })}\n`,
  );
  const pending = state?.pendingCapture;
  if (pending?.rawCapture || pending?.traceCapture) {
    const asked = [pending.rawCapture && "raw capture", pending.traceCapture && "tool output"].filter(Boolean);
    process.stdout.write(`Waiting for your approval: ${asked.join(" and ")}. Run approve to accept.\n`);
  }
}

/**
 * Converges this device on the grants the app has recorded (SAB-102), in one
 * direction only.
 *
 * The grant is decided in Sabia — at approval, or later by an owner or
 * administrator in Settings. Narrowing applies here without asking: exporting
 * less never needs consent. Widening does not: an administrator turning on
 * prompt or tool-output export would otherwise start sending this user's
 * content without the user knowing. So a wider grant is only recorded as
 * pending and announced at every session start until the person on this
 * device runs `approve`. The app's toggle keeps working; it takes one yes here.
 *
 * Claude Code reads its environment once per session, which is why any change
 * can never apply to the session already running.
 *
 * Quiet by design under `--quiet`: a hook that prints on every healthy
 * session start is noise, and a hook that fails a session over a sync problem
 * is worse — offline stays silent and the next session retries. A pending
 * widening is the exception and always prints, because nothing else will tell
 * the user.
 */
async function sync() {
  const quiet = Boolean(options.quiet);
  const settings = await readSettings();
  const env = plainObject(settings.env) ? { ...settings.env } : null;
  if (!env || !isManaged(env)) {
    if (!quiet) {
      process.stdout.write("Sabia telemetry is not configured in these Claude Code settings.\n");
    }
    return;
  }

  const granted = await readGrants(env, { failOpen: true, quiet });
  if (!granted) return;

  const current = currentCapture(env);
  const next = {
    rawCapture: current.rawCapture && granted.rawCapture,
    traceCapture: current.traceCapture && granted.traceCapture,
  };
  const pending = {
    rawCapture: granted.rawCapture && !current.rawCapture,
    traceCapture: granted.traceCapture && !current.traceCapture,
  };
  const state = await readJson(statePath);
  const narrowed =
    next.rawCapture !== current.rawCapture || next.traceCapture !== current.traceCapture;

  if (narrowed) {
    await applyCapture(state, granted, next);
    process.stdout.write(
      `Sabia updated this device's capture. ${describeCapture(next)} The change applies from the next Claude Code session.\n`,
    );
  }

  if (pending.rawCapture || pending.traceCapture) {
    await recordPending(pending);
    process.stdout.write(pendingNotice(state, granted));
    return;
  }

  if (state?.pendingCapture) await recordPending(null);
  if (!narrowed && !quiet) process.stdout.write("Sabia telemetry is in sync with the app.\n");
}

/**
 * Applies a wider grant waiting in Sabia, on the say-so of the person using
 * this device. Grants are read fresh rather than from the state file, so a
 * request withdrawn in the app since the last session cannot be approved.
 */
async function approve() {
  const settings = await readSettings();
  const env = plainObject(settings.env) ? { ...settings.env } : null;
  if (!env || !isManaged(env)) {
    process.stdout.write("Sabia telemetry is not configured in these Claude Code settings.\n");
    return;
  }

  const granted = await readGrants(env, { failOpen: false, quiet: false });
  if (!granted) return;
  const current = currentCapture(env);
  const target = { rawCapture: granted.rawCapture, traceCapture: granted.traceCapture };
  const state = await readJson(statePath);
  if (target.rawCapture === current.rawCapture && target.traceCapture === current.traceCapture) {
    if (state?.pendingCapture) await recordPending(null);
    process.stdout.write(`Nothing is waiting for approval. ${describeCapture(current)}\n`);
    return;
  }

  await applyCapture(state, granted, target);
  process.stdout.write(
    `Approved. ${describeCapture(target)} The change applies from the next Claude Code session.\n`,
  );
}

/** The grants Sabia holds for this key, or null when there is nothing to act on. */
async function readGrants(env, { failOpen, quiet }) {
  const token = env.OTEL_EXPORTER_OTLP_HEADERS.match(MANAGED_HEADER_PATTERN)?.[1];
  const metricsEndpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  if (!token || !metricsEndpoint) return null;

  let response;
  try {
    response = await fetch(new URL("/api/v1/telemetry/connection", metricsEndpoint), {
      redirect: "manual",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Offline or slow: leave the current block alone; the next session retries.
    if (!failOpen) throw new Error("could not reach Sabia; nothing was changed");
    return null;
  }

  if (response.status === 401) {
    // Revoked in the app. Removal is `disconnect`'s job — silently deleting
    // the block here would erase the user's record of what was configured.
    process.stdout.write(
      "Sabia revoked this device's usage sharing. Run disconnect to clean up, or Connect Sabia to reconnect.\n",
    );
    return null;
  }

  let granted;
  try {
    granted = await readResponseJson(response, "read the connection grants");
  } catch (error) {
    // Reachable but unhappy — 403, 429, 5xx, a redirect, an unreadable body.
    // Same posture as offline: leave the block alone and let the next session
    // retry. This runs from SessionStart, so throwing here would fail the
    // user's session over a response that is usually fine a minute later.
    if (!failOpen) throw error;
    if (!quiet) {
      process.stdout.write(
        `Could not read Sabia's grants: ${error instanceof Error ? error.message : "unexpected failure"}. This device's capture settings are unchanged.\n`,
      );
    }
    return null;
  }

  return {
    rawCapture: granted.rawCapture === true,
    traceCapture: granted.traceCapture === true,
    metricsEndpoint,
    token,
    logsEndpoint:
      typeof granted.otlpLogsEndpoint === "string" ? granted.otlpLogsEndpoint : metricsEndpoint,
    tracesEndpoint:
      typeof granted.tracesEndpoint === "string"
        ? granted.tracesEndpoint
        : new URL("/api/v1/telemetry/traces", metricsEndpoint).toString(),
  };
}

function currentCapture(env) {
  return {
    rawCapture: env.OTEL_LOGS_EXPORTER === "otlp",
    traceCapture: env.OTEL_TRACES_EXPORTER === "otlp",
  };
}

async function applyCapture(state, granted, capture) {
  await installEnv({
    deviceId: state?.deviceId || randomUUID(),
    metricsEndpoint: granted.metricsEndpoint,
    logsEndpoint: granted.logsEndpoint,
    tracesEndpoint: granted.tracesEndpoint,
    ingestionKey: granted.token,
    ingestionKeyId: state?.ingestionKeyId ?? null,
    organizationId: state?.organizationId ?? null,
    organizationName: state?.organizationName || "unknown",
    rawCapture: capture.rawCapture,
    traceCapture: capture.traceCapture,
    existingState: state,
  });
}

/** Kept in the state file only so `status` can show it without a request. */
async function recordPending(pending) {
  const state = await readJson(statePath);
  if (!state) return;
  if (pending) {
    state.pendingCapture = pending;
  } else {
    delete state.pendingCapture;
  }
  await atomicWrite(statePath, JSON.stringify(state, null, 2) + "\n");
}

function pendingNotice(state, granted) {
  const organization = state?.organizationName || "your Sabia organization";
  return (
    `Sabia: an administrator of ${organization} asked to widen what this device shares. ` +
    `If approved: ${describeCapture(granted)} ` +
    "Nothing more is exported until the person using this device approves. " +
    `To approve, run: node "${process.argv[1]}" approve. To decline, do nothing; this notice repeats at each session start while the request stands.\n`
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
    // Traces carry tool input/output bodies, so they are off unless this
    // connection was approved for the tool-output grant (SAB-81).
    OTEL_TRACES_EXPORTER: input.traceCapture ? "otlp" : "none",
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
    // OTEL_LOG_TOOL_CONTENT and OTEL_LOG_RAW_API_BODIES stay unset here. They
    // carry whole file contents and complete Messages API conversations, which
    // is a separate privacy decision from the one this flag asks for.
  }

  if (input.traceCapture) {
    env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = "1";
    env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/json";
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = input.tracesEndpoint;
    env.OTEL_LOG_TOOL_CONTENT = "1";
    // The command line (bash_command / full_command) is gated by tool
    // details, not tool content — verified against Claude Code 2.1.226.
    // Without it, Sabia cannot tell `gh pr create` output from `gh pr list`
    // output, and the fail-closed evidence gate identifies nothing.
    env.OTEL_LOG_TOOL_DETAILS = "1";
    // OTEL_LOG_ASSISTANT_RESPONSES stays unset: this grant's consent copy
    // says prompt text and assistant responses are not exported, and traces
    // gate response text on that flag. OTEL_LOG_RAW_API_BODIES stays unset
    // on every grant.
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
    if (["no-open", "local-only", "raw-capture", "tool-output", "quiet"].includes(key)) {
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
  sabia.mjs connect [--base-url URL] [--device-name NAME] [--no-open] [--raw-capture] [--tool-output]
  sabia.mjs status
  sabia.mjs sync [--quiet]
  sabia.mjs approve
  sabia.mjs disconnect [--local-only]
  sabia.mjs configure --endpoint URL --ingestion-key KEY [--organization NAME] [--raw-capture] [--tool-output]

  Token counts are always exported. The two capture grants are independent and
  can be combined; each is approved separately in the browser. Grants changed
  later in Sabia Settings reach this device through sync, which the plugin
  runs at every session start. A narrower grant applies on its own; a wider
  one waits until the person using this device runs approve.

  --raw-capture exports prompt text and tool decisions in addition to token
  counts, and asks Sabia to retain the complete OpenTelemetry envelopes.

  --tool-output exports tool result bodies — command output and the command
  lines that produced it — and asks Sabia to keep a reduced per-tool extract.
  File tool contents are dropped before storage. Prompt text and assistant
  responses are not exported by this flag. Claude Code does not export MCP
  tool result bodies today, so an MCP create identified only by its response
  cannot appear; MCP updates carrying the identifier in arguments still can.
`);
}
