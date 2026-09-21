#!/usr/bin/env node
// Claude Code PostToolUse bridge: after the hosted `report_artifact` tool has
// returned an accepted receipt, tell Sabia which native tool call and session
// made it. Reports themselves stay the MCP server's job; this never reports,
// never reads a transcript, and never changes a tool result.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Claude Code scopes a plugin-bundled server as mcp__plugin_<plugin>_<server>__<tool>;
// the bare form covers a user who configured the same server by hand.
const REPORT_TOOL = /^mcp__(?:plugin_sabia-claude-code-otel_)?sabia-artifacts__report_artifact$/;
const PROOF = /^sbia_proof_[A-Za-z0-9_-]{43}$/;
const MANAGED_HEADER_PATTERN = /Bearer (sbia_ing_[0-9a-f]{12}_[A-Za-z0-9_-]{43})/;
const EXPORTER_PATHS = ["/api/v1/telemetry/otlp", "/api/v1/telemetry/otlp/v1/metrics"];
const TTL = 24 * 60 * 60 * 1000;
const MAX_QUEUE = 64;
const MAX_ATTEMPTS_PER_RUN = 4;
// The device must not retry what the server has said it will never accept.
const TERMINAL = [400, 401, 403, 409, 410];

function coordinate(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
}

function retryDelay(attempts) {
  return Math.min(TTL, 1000 * (2 ** Math.min(Math.max(attempts - 1, 0), 30)));
}

/** Known transport wrappers only, bounded depth and bytes; no substring matching. */
function receipt(value, depth = 0) {
  if (depth > 6) return null;
  if (typeof value === "string") {
    if (value.length > 16384) return null;
    try { return receipt(JSON.parse(value), depth + 1); } catch { return null; }
  }
  // Claude Code hands an MCP tool's result to hooks as its content block list.
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item?.type === "text") { const found = receipt(item.text, depth + 1); if (found) return found; }
    }
    return null;
  }
  if (!value || typeof value !== "object" || value.isError === true || value.is_error === true || value.error) return null;
  if ("report_id" in value) return value;
  for (const key of ["structuredContent", "result"]) {
    if (value[key]) { const found = receipt(value[key], depth + 1); if (found) return found; }
  }
  if (Array.isArray(value.content)) return receipt(value.content, depth + 1);
  return null;
}

/** The session key the metrics exporter's session.id is normalised into on
 * arrival: one hash, on the device, so the raw id never leaves the machine. */
export function conversationKey(deviceId, sessionId) {
  return createHash("sha256").update(JSON.stringify({ source: "claude_code", deviceId, nativeSessionId: sessionId }), "utf8").digest("hex");
}

/** Host-supplied coordinates only. tool_input, transcript_path and cwd are never read. */
export function nativeBinding(event, deviceId, now = Date.now()) {
  if (event?.hook_event_name !== "PostToolUse" || !REPORT_TOOL.test(event.tool_name ?? "")) return null;
  if (!coordinate(event.tool_use_id) || !coordinate(event.session_id) || !coordinate(deviceId)) return null;
  const result = receipt(event.tool_response);
  if (result?.receipt_status !== "accepted" || !PROOF.test(result.receipt_proof ?? "")) return null;
  return { version: 1, receipt_proof: result.receipt_proof, invocation_id: event.tool_use_id,
    conversation_key: conversationKey(deviceId, event.session_id), observed_at: new Date(now).toISOString() };
}

/** The credential is read from the managed exporter variables and used only
 * against that exporter's origin. It never reaches stdout or the queue. */
export async function deviceContext(claudeHome) {
  const [settings, state] = await Promise.all([
    readFile(join(claudeHome, "settings.json"), "utf8").then(JSON.parse),
    readFile(join(claudeHome, "sabia-otel-state.json"), "utf8").then(JSON.parse),
  ]);
  const env = settings?.env && typeof settings.env === "object" ? settings.env : {};
  const token = typeof env.OTEL_EXPORTER_OTLP_HEADERS === "string" ? env.OTEL_EXPORTER_OTLP_HEADERS.match(MANAGED_HEADER_PATTERN)?.[1] : null;
  const endpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  if (!token || typeof endpoint !== "string" || !coordinate(state?.deviceId) || !coordinate(state?.organizationId) || state.endpoint !== endpoint) return null;
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || !EXPORTER_PATHS.includes(url.pathname)) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) return null;
  return { token, endpoint: new URL("/api/v1/artifact-reporting/claude-code-invocation", url).href,
    deviceId: state.deviceId, organizationId: state.organizationId };
}

export async function runReportBindingHook(event, options = {}) {
  const claudeHome = options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const context = await deviceContext(claudeHome).catch(() => null);
  if (!context) return;
  const data = options.dataPath ?? (process.env.CLAUDE_PLUGIN_DATA ? join(process.env.CLAUDE_PLUGIN_DATA, "report-bindings") : join(claudeHome, "sabia-report-bindings"));
  const queue = join(data, "pending");
  await mkdir(queue, { recursive: true, mode: 0o700 });
  const now = options.now ?? Date.now();
  const binding = nativeBinding(event, context.deviceId, now);
  if (binding) {
    // Per-invocation files avoid shared-state races across concurrent sessions.
    // The name excludes the timestamp so a duplicate delivery of one hook event
    // keeps the first record.
    const { observed_at: _observedAt, ...identity } = binding;
    const id = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const path = join(queue, `${id}.json`);
    const queued = { binding, createdAt: now, attempts: 0, nextAttemptAt: now, deviceId: context.deviceId, organizationId: context.organizationId };
    await writeFile(path, JSON.stringify(queued), { mode: 0o600, flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
  }
  const entries = (await readdir(queue)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  const records = [];
  for (const name of entries) {
    const path = join(queue, name);
    let item;
    try {
      if ((await stat(path)).size > 4096) { await unlink(path); continue; }
      item = JSON.parse(await readFile(path, "utf8"));
    } catch { continue; }
    const attempts = item?.attempts ?? 0;
    const nextAttemptAt = item?.nextAttemptAt ?? item?.createdAt;
    if (!Number.isFinite(item?.createdAt) || !Number.isSafeInteger(attempts) || attempts < 0 || !Number.isFinite(nextAttemptAt) ||
        now - item.createdAt > TTL || item.createdAt > now || item.deviceId !== context.deviceId || item.organizationId !== context.organizationId ||
        !PROOF.test(item.binding?.receipt_proof ?? "") || !coordinate(item.binding?.invocation_id) || !/^[a-f0-9]{64}$/.test(item.binding?.conversation_key ?? "")) {
      await unlink(path).catch(() => {}); continue;
    }
    records.push({ name, path, item: { ...item, attempts, nextAttemptAt } });
  }
  records.sort((left, right) => left.item.createdAt - right.item.createdAt || left.name.localeCompare(right.name));
  const overflow = Math.max(0, records.length - MAX_QUEUE);
  await Promise.all(records.slice(0, overflow).map(({ path }) => unlink(path).catch(() => {})));

  // The injected clock is for queue age/backoff tests; latency uses wall time.
  const budget = Date.now() + 4000;
  let attempted = 0;
  for (const { path, item } of records.slice(overflow)) {
    if (attempted >= MAX_ATTEMPTS_PER_RUN || Date.now() > budget) break;
    if (item.nextAttemptAt > now) continue;
    attempted++;
    try {
      const response = await (options.fetch ?? fetch)(context.endpoint, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(1500),
        headers: { "content-type": "application/json", authorization: `Bearer ${context.token}` },
        body: JSON.stringify(item.binding),
      });
      // Never expose response bodies or follow a redirect supplied by the server.
      await response.body?.cancel().catch(() => {});
      if (response.ok || TERMINAL.includes(response.status)) {
        await unlink(path).catch(() => {});
      } else {
        const attempts = item.attempts + 1;
        await writeFile(path, JSON.stringify({ ...item, attempts, nextAttemptAt: now + retryDelay(attempts) }), { mode: 0o600 });
      }
    } catch {
      const attempts = item.attempts + 1;
      await writeFile(path, JSON.stringify({ ...item, attempts, nextAttemptAt: now + retryDelay(attempts) }), { mode: 0o600 }).catch(() => {});
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    let input = "";
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 262144) throw new Error("bounded input"); }
    await runReportBindingHook(JSON.parse(input));
  } catch { /* Advisory: a PostToolUse hook can neither change nor block the tool result. */ }
}
