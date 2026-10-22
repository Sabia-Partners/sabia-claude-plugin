// Reads Claude Cowork's local session logs and turns them into the OTLP log
// events Cowork's own exporter would send, so Sabia's existing Cowork endpoint
// accepts them unchanged.
//
// Why: Cowork's OpenTelemetry export is a Claude Team/Enterprise admin
// setting. Individual Pro and Max accounts have no export, but the desktop app
// keeps an audit log for every Cowork session on disk:
//
//   <Claude app data>/local-agent-mode-sessions/<account>/<org>/local_<id>/audit.jsonl
//
// Tokens come from each turn's `result` line, whose `modelUsage` holds totals
// per model, subagents included. Those totals usually cover only that turn,
// but Claude Code can start a turn from the previous turn's totals: a resumed
// session restores them (seen from Claude Code 2.1.288), and a queued
// follow-up continues them. A turn that carries the previous totals over is
// sent as the difference, so every token is counted once (see `turnUsage`).
// The `usage` on `assistant`
// lines is a snapshot taken as the response starts streaming: on real logs it
// under-reports output about thirtyfold, so it is never summed. `assistant`
// lines are used only to count distinct calls (message ids) per model, which
// becomes the turn's request count. A message is written once per content
// block, so it is counted once per id.
//
// Usage (model, token counts, time, session id) is always sent. Content —
// prompts, responses, tool inputs and results — is sent only when the person
// opted in at connect AND Sabia reports the capture grant approved. The file
// format is Anthropic's internal one, not a documented contract: anything
// unrecognised is skipped, never guessed at.

import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

export const SESSIONS_DIRECTORY = "local-agent-mode-sessions";

/** Recent message ids kept per file, so a message split across runs counts once. */
export const RECENT_IDS_PER_FILE = 256;

// Cowork's own exporter limits, applied to the same fields.
const MAX_ARGUMENT_STRING = 512;
const MAX_TOOL_INPUT = 4_096;
const MAX_TOOL_RESULT = 4_096;
const MAX_TEXT = 60 * 1_024;

/** Where the Claude desktop app keeps its data on this platform. */
export function claudeAppDataDirectory(env = process.env, os = platform(), home = homedir()) {
  if (env.SABIA_CLAUDE_APP_DATA) return env.SABIA_CLAUDE_APP_DATA;
  if (os === "darwin") return join(home, "Library", "Application Support", "Claude");
  if (os === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "Claude");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "Claude");
}

/** Every Cowork session folder on this device that has an audit log. */
export async function findSessionAudits(appDataDirectory) {
  const root = join(appDataDirectory, SESSIONS_DIRECTORY);
  const audits = [];
  for (const account of await directories(root)) {
    for (const organization of await directories(join(root, account))) {
      const organizationPath = join(root, account, organization);
      for (const session of await directories(organizationPath)) {
        if (!session.startsWith("local_")) continue;
        const auditPath = join(organizationPath, session, "audit.jsonl");
        const info = await stat(auditPath).catch(() => null);
        if (info?.isFile()) audits.push({ sessionKey: session, auditPath, size: info.size });
      }
    }
  }
  return audits;
}

async function directories(path) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Reads an audit log from `cursor.offset` and returns the new events, the
 * byte offset after the last complete line, and the updated recent ids and
 * usage baselines. A final line without a newline may still be being written
 * and is left for the next run. The same cursor always yields the same
 * events, so a run that fails before saving its cursor resends them unchanged.
 */
export async function readSessionEvents(auditPath, cursor = {}, { content = false } = {}) {
  const recent = new Set(cursor.recentMessageIds ?? []);
  // Calls per model since the last result; a turn can span two runs.
  const pendingCalls = { ...(cursor.pendingCalls ?? {}) };
  const toolCalls = new Map();
  const events = [];
  let offset = cursor.offset ?? 0;
  let sequence = cursor.sequence ?? 0;
  const size = (await stat(auditPath)).size;
  if (offset > size) offset = 0; // the file was replaced; start over
  // A cursor saved before baselines existed rebuilds them from the part
  // already sent, without sending it again.
  const usage =
    offset === 0
      ? {}
      : cursor.usage
        ? structuredClone(cursor.usage)
        : await usageBaselinesUntil(auditPath, offset);

  for await (const { entry, end } of completeEntries(auditPath, offset, size)) {
    offset = end;
    for (const event of eventsFromEntry(entry, { content, recent, toolCalls, pendingCalls, usage })) {
      sequence += 1;
      events.push({ ...event, sequence: event.sequence ?? String(sequence) });
    }
  }
  return {
    events,
    cursor: {
      offset,
      sequence,
      recentMessageIds: [...recent].slice(-RECENT_IDS_PER_FILE),
      pendingCalls,
      usage,
    },
  };
}

/** Each complete JSON line between two byte offsets, with the offset after it. */
async function* completeEntries(auditPath, start, size) {
  const input = createReadStream(auditPath, { start, encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let offset = start;
  try {
    for await (const line of lines) {
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      if (offset + lineBytes > size) break;
      offset += lineBytes;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      yield { entry, end: offset };
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

async function usageBaselinesUntil(auditPath, offset) {
  const usage = {};
  const context = { content: false, recent: new Set(), toolCalls: new Map(), pendingCalls: {}, usage };
  for await (const { entry } of completeEntries(auditPath, 0, offset)) eventsFromEntry(entry, context);
  return usage;
}

/** The events one audit line contributes. Exported for tests. */
export function eventsFromEntry(entry, { content, recent, toolCalls, pendingCalls = {}, usage = {} }) {
  if (!entry || typeof entry !== "object") return [];
  if (entry.type === "system" && entry.subtype === "init" && typeof entry.model === "string") {
    // The session's main model, whose own share of a turn `result.usage`
    // reports, and the Claude Code version running it.
    const key = sessionKeyOf(entry);
    const version = typeof entry.claude_code_version === "string" ? entry.claude_code_version : undefined;
    usage[key] = { ...usage[key], model: entry.model, version };
  }
  const occurredAtMs = Date.parse(entry.timestamp ?? entry._audit_timestamp ?? "");
  if (!Number.isFinite(occurredAtMs)) return [];
  const sessionId = typeof entry.session_id === "string" ? entry.session_id : null;
  const message = entry.message && typeof entry.message === "object" ? entry.message : null;
  const events = [];

  if (entry.type === "result" && typeof entry.uuid === "string" && !recent.has(entry.uuid)) {
    recent.add(entry.uuid);
    const key = sessionKeyOf(entry);
    const last = usage[key]?.last;
    // A result at or before the last one counted was already sent: a replayed
    // line whose id fell out of the recent ids must not move the baseline.
    const replayed = last && (entry.uuid === last.uuid || occurredAtMs < last.atMs);
    const { added, baseline } = replayed ? { added: {} } : turnUsage(entry, usage[key]);
    if (!replayed) usage[key] = { ...baseline, last: { uuid: entry.uuid, atMs: occurredAtMs } };
    for (const [model, counts] of Object.entries(added)) {
      const tokens = tokensOf(counts);
      if (!tokens) continue;
      events.push({
        name: "api_request",
        sessionId,
        occurredAtMs,
        // The result id and model keep a resent turn on the same idempotency key.
        sequence: `${entry.uuid}:${model}`,
        attributes: { model, ...tokens, request_count: Math.max(1, pendingCalls[model] ?? 0) },
      });
    }
    for (const model of Object.keys(pendingCalls)) delete pendingCalls[model];
  }

  if (entry.type === "assistant" && message) {
    if (typeof message.id === "string" && !recent.has(message.id)) {
      recent.add(message.id);
      if (typeof message.model === "string") {
        pendingCalls[message.model] = (pendingCalls[message.model] ?? 0) + 1;
      }
    }
    for (const block of blocks(message)) {
      if (block.type === "tool_use" && typeof block.id === "string") {
        toolCalls.set(block.id, { name: block.name, input: block.input, startedAtMs: occurredAtMs });
      } else if (content && block.type === "text" && block.text) {
        // One content block per line: later lines of the same message carry
        // its later blocks, so text is read from every line, not only the first.
        events.push({
          name: "assistant_response",
          sessionId,
          occurredAtMs,
          attributes: { model: message.model, response: truncate(block.text, MAX_TEXT) },
        });
      }
    }
  }

  if (entry.type === "user" && message) {
    const results = blocks(message).filter((block) => block.type === "tool_result");
    for (const result of results) {
      const call = toolCalls.get(result.tool_use_id);
      if (!call || typeof call.name !== "string") continue;
      toolCalls.delete(result.tool_use_id);
      events.push({
        name: "tool_result",
        sessionId,
        occurredAtMs,
        attributes: {
          tool_name: call.name,
          success: result.is_error ? "false" : "true",
          duration_ms: Math.max(0, occurredAtMs - call.startedAtMs),
          ...mcpParameters(call.name),
          ...(content
            ? {
                tool_input: truncate(JSON.stringify(boundArguments(call.input ?? {})), MAX_TOOL_INPUT),
                tool_result: truncate(resultText(result.content), MAX_TOOL_RESULT),
              }
            : {}),
        },
      });
    }
    if (content && results.length === 0 && !entry.parent_tool_use_id) {
      const prompt = promptText(message);
      if (prompt) {
        events.push({
          name: "user_prompt",
          sessionId,
          occurredAtMs,
          attributes: { prompt: truncate(prompt, MAX_TEXT), prompt_length: prompt.length },
        });
      }
    }
  }
  return events;
}

const TOKEN_CLASSES = [
  ["inputTokens", "input_tokens"],
  ["outputTokens", "output_tokens"],
  ["cacheReadInputTokens", "cache_read_input_tokens"],
  ["cacheCreationInputTokens", "cache_creation_input_tokens"],
];
const NO_TOKENS = TOKEN_CLASSES.map(() => 0);

function sessionKeyOf(entry) {
  return typeof entry.session_id === "string" ? entry.session_id : "";
}

/** The first Claude Code version seen restoring a resumed session's totals. */
const RESTORES_TOTALS_FROM = [2, 1, 288];

/**
 * The tokens one result adds, per model, and the session's next baseline.
 *
 * A turn carries the previous totals over when a model it did not use comes
 * back with exactly the previous totals, or when its main model grew by
 * exactly what `result.usage` (the main thread's own share of this turn)
 * reports. When a subagent also used the main model, neither test can pass and
 * the tokens alone cannot tell the two apart (the log does not record
 * subagent calls), so such a turn counts as carried on a Claude Code version
 * known to restore totals, and as fresh before it. A turn whose totals went
 * down anywhere is a fresh start. Totals never go below the baseline in a
 * carried turn, so no difference is negative.
 */
function turnUsage(entry, baseline = {}) {
  const totals = {};
  const modelUsage = entry.modelUsage && typeof entry.modelUsage === "object" ? entry.modelUsage : {};
  for (const [model, usage] of Object.entries(modelUsage)) {
    if (usage && typeof usage === "object") {
      totals[model] = TOKEN_CLASSES.map(([field]) => count(usage[field]));
    }
  }
  // A turn without model calls says nothing about the running totals.
  if (Object.keys(totals).length === 0) return { added: {}, baseline };

  const carried = carriesOver(entry, totals, baseline);
  const added = {};
  for (const [model, counts] of Object.entries(totals)) {
    const before = carried ? (baseline.totals[model] ?? NO_TOKENS) : NO_TOKENS;
    added[model] = counts.map((value, index) => value - before[index]);
  }
  const { model, version } = baseline;
  return { added, baseline: { model, version, totals } };
}

function carriesOver(entry, totals, baseline) {
  const previous = baseline.totals;
  if (!previous) return false;
  const grew = Object.entries(previous).every(
    ([model, before]) => totals[model] && totals[model].every((value, index) => value >= before[index]),
  );
  if (!grew) return false;
  const unchanged = Object.entries(previous).some(
    ([model, before]) =>
      before.some((value) => value > 0) && totals[model].every((value, index) => value === before[index]),
  );
  if (unchanged) return true;

  const own = TOKEN_CLASSES.map(([, field]) => count(entry.usage?.[field]));
  const main = totals[baseline.model] ?? NO_TOKENS;
  const mainBefore = previous[baseline.model] ?? NO_TOKENS;
  if (mainBefore.some((value) => value > 0)) {
    if (main.every((value, index) => value - mainBefore[index] === own[index])) return true;
    if (main.every((value, index) => value === own[index])) return false;
  }
  return restoresTotals(baseline.version);
}

function restoresTotals(version) {
  const parts = typeof version === "string" ? version.split(".").map(Number) : [];
  if (parts.length < 3 || parts.some((part) => !Number.isInteger(part))) return false;
  for (const [index, part] of RESTORES_TOTALS_FROM.entries()) {
    if (parts[index] !== part) return parts[index] > part;
  }
  return true;
}

/** One model's tokens for a turn, as the four counts `turnUsage` returns. */
function tokensOf(counts) {
  const [input, output, cacheRead, cacheCreation] = counts;
  const tokens = {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
  };
  return Object.values(tokens).some((value) => value > 0) ? tokens : null;
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function blocks(message) {
  return Array.isArray(message.content)
    ? message.content.filter((block) => block && typeof block === "object")
    : [];
}

function promptText(message) {
  if (typeof message.content === "string") return message.content;
  return blocks(message)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function resultText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** `mcp__<server>__<tool>` → Cowork's `tool_parameters`, as its exporter sends it. */
function mcpParameters(toolName) {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (!match) return {};
  return {
    tool_parameters: JSON.stringify({ mcp_server_name: match[1], mcp_tool_name: match[2] }),
  };
}

function boundArguments(value, depth = 0) {
  if (typeof value === "string") return truncate(value, MAX_ARGUMENT_STRING);
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => boundArguments(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).slice(0, 100).map(([key, item]) => [key, boundArguments(item, depth + 1)]),
  );
}

function truncate(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * The OTLP/JSON logs envelope for one session's events, shaped as Cowork's
 * exporter shapes them (attribute names from Cowork's monitoring docs).
 */
export function buildCoworkLogsPayload(events, { sessionKey }) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            stringAttribute("service.name", "cowork"),
            stringAttribute("sabia.collector", "cowork-local-audit"),
          ],
        },
        scopeLogs: [
          {
            scope: { name: "sabia.cowork.local" },
            logRecords: events.map((event) => ({
              timeUnixNano: `${BigInt(event.occurredAtMs) * BigInt(1_000_000)}`,
              body: { stringValue: event.name },
              attributes: [
                stringAttribute("event.name", event.name),
                stringAttribute("session.id", event.sessionId ?? sessionKey),
                stringAttribute("event.sequence", event.sequence),
                stringAttribute("event.timestamp", new Date(event.occurredAtMs).toISOString()),
                ...Object.entries(event.attributes)
                  .filter(([, value]) => value !== undefined && value !== null && value !== "")
                  .map(([key, value]) =>
                    typeof value === "number" ? intAttribute(key, value) : stringAttribute(key, value),
                  ),
              ],
            })),
          },
        ],
      },
    ],
  };
}

function stringAttribute(key, value) {
  return { key, value: { stringValue: String(value) } };
}

function intAttribute(key, value) {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

const MAX_RECORDS_PER_REQUEST = 500;
const MAX_BYTES_PER_REQUEST = 900_000;

/**
 * Sends Cowork usage (and granted content) recorded since the last run. Shared
 * by the CLI and the Claude Desktop extension. Safe to run repeatedly: each
 * file resumes from its saved offset, and a resent turn keeps its idempotency
 * key. Returns what happened rather than printing, so each caller reports it
 * in its own way.
 *
 * @returns {Promise<{ status: "synced" | "revoked" | "unreachable", sent: number, sessions: number, content: boolean }>}
 */
export async function syncCoworkUsage({ state, cursorPath, appDataDirectory, fetchImpl = fetch }) {
  const baseUrl = state.baseUrl;
  // Checked every run, not only when content was asked for: with nothing new
  // to send, this is the only request that would notice a revoked key.
  const grant = await contentGranted(state, baseUrl, fetchImpl);
  if (grant === "revoked") return { status: "revoked", sent: 0, sessions: 0, content: false };
  const content = Boolean(state.content) && grant === true;

  const cursors = (await readJson(cursorPath)) ?? {};
  let sent = 0;
  let sessions = 0;
  for (const audit of await findSessionAudits(appDataDirectory)) {
    const previous = cursors[audit.auditPath];
    if (previous && previous.offset === audit.size) continue;

    const { events, cursor } = await readSessionEvents(audit.auditPath, previous, { content });
    for (const batch of batches(events)) {
      const outcome = await post(state, baseUrl, buildCoworkLogsPayload(batch, audit), fetchImpl);
      // This file's cursor is not advanced: it is resent from the old one.
      if (outcome !== "sent") return { status: outcome, sent, sessions, content };
      sent += batch.length;
    }
    if (events.length > 0) sessions += 1;
    cursors[audit.auditPath] = cursor;
    await writeJson(cursorPath, cursors);
  }
  return { status: "synced", sent, sessions, content };
}

/** true when Sabia records the content grant, "revoked" on 401, false otherwise. */
async function contentGranted(state, baseUrl, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(new URL("/api/v1/telemetry/connection", baseUrl), {
      headers: { authorization: `Bearer ${state.ingestionKey}` },
      redirect: "manual",
    });
  } catch {
    return false;
  }
  if (response.status === 401) return "revoked";
  if (!response.ok) return false;
  const sheet = await response.json().catch(() => null);
  return Boolean(sheet?.rawCapture);
}

function* batches(events) {
  let batch = [];
  let bytes = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event), "utf8") + 512;
    if (
      batch.length > 0 &&
      (batch.length >= MAX_RECORDS_PER_REQUEST || bytes + size > MAX_BYTES_PER_REQUEST)
    ) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(event);
    bytes += size;
  }
  if (batch.length > 0) yield batch;
}

async function post(state, baseUrl, payload, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(
      state.otlpLogsEndpoint || new URL("/api/v1/telemetry/otlp/v1/logs", baseUrl),
      {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${state.ingestionKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );
  } catch {
    return "unreachable";
  }
  if (response.status === 401) return "revoked";
  if (response.ok) return "sent";
  // A payload Sabia refuses as invalid would be refused again; move past it
  // rather than resend it forever. Anything else is transient.
  if ([400, 413, 415].includes(response.status)) return "sent";
  return "unreachable";
}

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Atomic write, owner-only: state files hold the ingestion key. */
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
