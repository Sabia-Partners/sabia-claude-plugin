#!/usr/bin/env node
// Claude Code PostToolUse bridge for connector (MCP) mutations. Claude Code's
// OpenTelemetry export never carries a connector tool's result, so a Google
// Doc or a pull request the connector *created* has no id anywhere Sabia can
// see. This hook reads the reply, keeps the identifiers the server would keep
// from telemetry, and posts them under the tool-output grant. Nothing else
// leaves the machine: no prompts, no document bodies, no transcript.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { deviceContext } from "./sabia-report-binding.mjs";

export const SCHEMA_VERSION = 1;
const MAX_INPUT_BYTES = 262_144;
const MAX_ENVELOPE_BYTES = 16_384;
const RETRY_DELAYS_MS = [300, 900, 2700];
const REQUEST_TIMEOUT_MS = 1500;
const TOTAL_BUDGET_MS = 6000;

// Sabia's own reporting server is never a producing tool.
const SABIA_SERVERS = /^(?:plugin_[A-Za-z0-9._-]+_)?(?:sabia[_-]artifacts|sabia[_-]artifact[_-]reporting)$/;

/** Drive and GitHub operations with extraction rules today. Pinned against the
 * dashboard's CLAUDE_CODE_HOOK_MUTATIONS by a test; the server refuses the rest. */
export const MUTATIONS = [
  "update_file", "update_document", "update_spreadsheet", "update_presentation", "append_text", "insert_text",
  "replace_text", "delete_text", "append_values", "update_values", "clear_values", "batch_update", "write_file",
  "batch_update_document", "batch_update_spreadsheet", "batch_update_presentation",
  "add_sheet", "create_sheet", "add_slide", "create_slide", "create_comment", "add_comment", "bulk_update_file_comments",
  "copy_file", "create_file", "create_presentation_from_template", "duplicate_sheet_in_new_spreadsheet",
  "import_document", "import_presentation", "import_spreadsheet", "upload_file",
  "create_pull_request", "update_pull_request", "merge_pull_request", "enable_auto_merge",
  "add_review_to_pr", "create_pull_request_review", "submit_pull_request_review",
  "create_issue", "update_issue", "add_issue_comment", "add_comment_to_issue",
];

// ---- Identity allowlist: a port of the dashboard's projectMutationIdentity.
// A pin test runs both over the same fixtures; any drift fails the build.
export const PRIMARY_IDENTITY_KEYS = new Set([
  "url", "html_url", "externalId", "external_id", "id", "identifier", "fullIdentifier", "full_identifier",
  "number", "issue_number", "issueNumber", "issueId", "issue_id", "commentId", "comment_id", "pull_number", "pullNumber", "pr_number",
  "owner", "org", "repo", "repository", "repository_full_name", "repo_full_name", "name", "review_id", "reviewId", "sha",
  "fileId", "file_id", "documentId", "document_id", "spreadsheetId", "spreadsheet_id", "presentationId", "presentation_id",
  "mimeType", "mime_type", "webViewLink", "document_url", "spreadsheet_url", "presentation_url", "title",
]);
const IDENTITY_KEYS = new Set([...PRIMARY_IDENTITY_KEYS, "file_name", "newSpreadsheetId", "newSpreadsheetUrl", "team"]);
const WRAPPER_KEYS = new Set([
  "result", "structuredContent", "structured_content", "data", "issue", "comment", "pull_request", "pullRequest", "output",
  "commit", "file", "document", "spreadsheet", "presentation", "content", "created_comments", "created_replies",
]);
const INPUT_FIELDS = ["input", "tool.input", "tool_input", "arguments", "tool.arguments", "parameters", "tool_parameters", "tool.parameters"];
const RESULT_FIELDS = ["output", "tool.output", "tool_output", "body", "tool.result"];
const MAX_PROJECTION_BYTES = 32 * 1024, MAX_SCALAR_CHARS = 4096, MAX_PARSE_DEPTH = 6, MAX_WALK_DEPTH = 8, MAX_ARRAY_ITEMS = 128;

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isIdentityLiteral = (v) => /^https?:\/\/\S+$/i.test(v) || /^[A-Z][A-Z0-9]{1,15}-\d+$/.test(v) || /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+(?:\/reviews\/\d+)?$/.test(v);

function decodeStructured(value, state, depth = 0) {
  if (typeof value !== "string" || depth >= MAX_PARSE_DEPTH) return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const candidates = [trimmed];
  const output = trimmed.match(/(?:^|\r?\n)Output:\s*([\s\S]*)$/i)?.[1]?.trim();
  if (output && output !== trimmed) candidates.push(output);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return typeof parsed === "string" && parsed !== value ? decodeStructured(parsed, state, depth + 1) : parsed;
    } catch {
      if (/^[\[{]/.test(candidate) && candidate.includes('\\"')) {
        try {
          const unescaped = JSON.parse(`"${candidate.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`);
          if (typeof unescaped === "string") {
            const parsed = decodeStructured(unescaped, state, depth + 1);
            if (parsed !== unescaped) return parsed;
          }
        } catch { /* malformed marker below */ }
      }
    }
  }
  if (candidates.some((c) => /^[\[{]/.test(c) || /[\[{]\s*\\?["']/.test(c))) state.malformed = true;
  return value;
}
function boundedScalar(value, state) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  if (value.length > MAX_SCALAR_CHARS) { state.tooLarge = true; return null; }
  return value;
}
function projectRequestActions(value, state) {
  const decoded = decodeStructured(value, state);
  if (!Array.isArray(decoded)) return null;
  const requests = decoded.slice(0, MAX_ARRAY_ITEMS).flatMap((request) => {
    if (!isRecord(request)) return [];
    const names = Object.keys(request).filter((n) => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(n));
    return names.length === 0 ? [] : [Object.fromEntries(names.map((n) => [n, {}]))];
  });
  if (decoded.length > MAX_ARRAY_ITEMS) state.tooLarge = true;
  return requests.length > 0 ? requests : null;
}
function projectWrapper(value, allowActionRequests, state, depth) {
  if (!Array.isArray(value)) return projectValue(value, allowActionRequests, state, depth);
  const projected = value.slice(0, MAX_ARRAY_ITEMS).flatMap((item) => { const next = projectValue(item, allowActionRequests, state, depth + 1); return next === null ? [] : [next]; });
  if (value.length > MAX_ARRAY_ITEMS) state.tooLarge = true;
  return projected.length > 0 ? projected : null;
}
function projectValue(value, allowActionRequests, state, depth) {
  if (depth > MAX_WALK_DEPTH) return null;
  const decoded = decodeStructured(value, state);
  if (decoded !== value) return projectValue(decoded, allowActionRequests, state, depth + 1);
  if (typeof decoded === "string") {
    const literal = decoded.trim();
    if (!isIdentityLiteral(literal)) return null;
    if (literal.length > MAX_SCALAR_CHARS) { state.tooLarge = true; return null; }
    return literal;
  }
  if (Array.isArray(decoded)) {
    const blocks = decoded.slice(0, MAX_ARRAY_ITEMS).flatMap((item) => {
      if (!isRecord(item) || item.type !== "text") return [];
      const projected = projectValue(item.text, allowActionRequests, state, depth + 1);
      return projected === null ? [] : [{ type: "text", text: projected }];
    });
    if (decoded.length > MAX_ARRAY_ITEMS) state.tooLarge = true;
    return blocks.length > 0 ? blocks : null;
  }
  if (!isRecord(decoded)) return null;
  const projected = {};
  for (const [key, nested] of Object.entries(decoded)) {
    if (IDENTITY_KEYS.has(key)) { const scalar = boundedScalar(nested, state); if (scalar !== null) projected[key] = scalar; continue; }
    if (allowActionRequests && key === "requests") { const requests = projectRequestActions(nested, state); if (requests) projected.requests = requests; continue; }
    if (!WRAPPER_KEYS.has(key)) continue;
    const wrapper = projectWrapper(nested, allowActionRequests, state, depth + 1);
    if (wrapper !== null) projected[key] = wrapper;
  }
  return Object.keys(projected).length > 0 ? projected : null;
}
function projectEnvelope(envelope, fields, allowActionRequests, state) {
  if (!envelope) return null;
  const projected = {};
  for (const field of fields) {
    if (!(field in envelope)) continue;
    const value = projectValue(envelope[field], allowActionRequests, state, 0);
    if (value !== null) projected[field] = value;
  }
  return Object.keys(projected).length > 0 ? projected : null;
}
/** Same contract as the dashboard: { projection | null, omissionReason }. */
export function projectMutationIdentity(input) {
  const state = { malformed: false, tooLarge: false };
  const projectedInput = projectEnvelope(input.inputProjection, INPUT_FIELDS, true, state);
  const projectedResult = projectEnvelope(input.resultProjection, RESULT_FIELDS, false, state);
  const projection = projectedInput || projectedResult ? { version: 1, input: projectedInput, result: projectedResult } : null;
  if (projection) {
    try { if (new TextEncoder().encode(JSON.stringify(projection)).length > MAX_PROJECTION_BYTES) return { projection: null, omissionReason: "too_large" }; }
    catch { return { projection: null, omissionReason: "malformed" }; }
  }
  return { projection, omissionReason: state.tooLarge ? "too_large" : state.malformed ? "malformed" : null };
}

// ---- The hook itself.
const coordinate = (v) => typeof v === "string" && v.length >= 1 && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v);
export function splitToolName(toolName) {
  if (typeof toolName !== "string" || !toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice(5), at = rest.lastIndexOf("__");
  if (at <= 0 || at + 2 >= rest.length) return null;
  return { serverName: rest.slice(0, at), operation: rest.slice(at + 2) };
}
export function isMutation(toolName) {
  const parts = splitToolName(toolName);
  if (!parts || SABIA_SERVERS.test(parts.serverName)) return false;
  const op = parts.operation.toLowerCase();
  return MUTATIONS.some((name) => op === name || op.endsWith(`_${name}`) || op.endsWith(`:${name}`) || op.endsWith(`/${name}`));
}
// Claude Code hands an MCP tool's result to hooks as its content block list, so
// an error can sit inside a text block or a structured wrapper. Walks the same
// wrappers as receipt() in sabia-report-binding.mjs; plain text is not parsed
// for error words.
function errorShaped(response, depth = 0) {
  if (depth > 6) return false;
  if (typeof response === "string") {
    if (response.length > 16384) return false;
    try { return errorShaped(JSON.parse(response), depth + 1); } catch { return false; }
  }
  if (Array.isArray(response)) return response.some((item) => item?.type === "text" && errorShaped(item.text, depth + 1));
  if (!isRecord(response)) return false;
  if (response.isError === true || response.is_error === true || (response.error !== undefined && response.error !== null && response.error !== false)) return true;
  return ["structuredContent", "structured_content", "result", "content"].some((key) => response[key] !== undefined && errorShaped(response[key], depth + 1));
}

/** Host coordinates and the allowlisted identity only. transcript_path, cwd,
 * prompt_id and anything unlisted are never read. */
export function connectorEnvelope(event, now = Date.now()) {
  if (event?.hook_event_name !== "PostToolUse" || !isMutation(event.tool_name)) return null;
  if (!coordinate(event.tool_use_id) || !coordinate(event.session_id)) return null;
  if (errorShaped(event.tool_response)) return null;
  const { projection } = projectMutationIdentity({
    inputProjection: event.tool_input === undefined ? null : { input: event.tool_input },
    resultProjection: event.tool_response === undefined ? null : { output: event.tool_response },
  });
  if (!projection) return null;
  const envelope = {
    schema_version: SCHEMA_VERSION, hook_event_name: "PostToolUse", tool_name: event.tool_name, tool_use_id: event.tool_use_id,
    session_id: event.session_id, occurred_at: new Date(now).toISOString(), success: true,
    identity: { input: projection.input, result: projection.result },
  };
  return Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_ENVELOPE_BYTES ? null : envelope;
}

/** The tool-output grant is what the server checks; read it from the managed
 * env so a machine without it never posts. */
async function traceCaptureGranted(claudeHome) {
  try {
    const settings = JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8"));
    return settings?.env?.OTEL_TRACES_EXPORTER === "otlp";
  } catch { return false; }
}

export async function runConnectorHook(event, options = {}) {
  const claudeHome = options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const envelope = connectorEnvelope(event, options.now);
  if (!envelope) return { sent: false, reason: "not_a_mutation" };
  if (!await traceCaptureGranted(claudeHome)) return { sent: false, reason: "no_trace_grant" };
  const context = await deviceContext(claudeHome).catch(() => null);
  if (!context) return { sent: false, reason: "no_credential" };
  const endpoint = new URL("/api/v1/telemetry/claude-code/hooks", context.endpoint).href;
  const body = JSON.stringify(envelope);
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // No spool: a lost creation is lost, by design — a file that could hold
  // the credential is the greater risk. Retries stay inside the hook's own
  // timeout and give up silently.
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1];
      if (Date.now() + delay > deadline) break;
      await sleep(delay);
    }
    try {
      const response = await (options.fetch ?? fetch)(endpoint, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, Math.max(1, deadline - Date.now()))),
        headers: { "content-type": "application/json", authorization: `Bearer ${context.token}` }, body,
      });
      await response.body?.cancel().catch(() => {});
      if (response.ok) return { sent: true, attempts: attempt + 1 };
      // 4xx means the same body can never succeed; only 429 and 5xx are retried.
      if (response.status < 500 && response.status !== 429) return { sent: false, reason: `http_${response.status}`, attempts: attempt + 1 };
    } catch { /* transient: retry */ }
  }
  return { sent: false, reason: "gave_up" };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    let input = "";
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error("bounded input"); }
    await runConnectorHook(JSON.parse(input));
  } catch { /* Advisory: a PostToolUse hook can neither change nor block the tool result. */ }
}
