#!/usr/bin/env node
// Claude Code PostToolUse bridge for connector (MCP) mutations. Claude Code's
// OpenTelemetry export never carries a connector tool's result, so a Google
// Doc or a pull request the connector *created* has no id anywhere Sabia can
// see. This hook reads the reply, keeps the identifiers the server would keep
// from telemetry, and posts them under the tool-output grant. Nothing else
// leaves the machine: no prompts, no document bodies, no transcript.
//
// Which operations count and which identifiers survive is Sabia's connector
// hook contract. The hook fetches it from the connected Sabia, caches it, and
// falls back to the last good copy and then to the vendored v1 contract.
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/** Drive and GitHub operations with extraction rules: the vendored v1
 * contract, applied until a contract has been fetched from Sabia. Pinned
 * against contracts/connector-hook/v1.json by a test. */
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

// ---- Identity allowlist: a port of the dashboard's projectMutationIdentity
// (src/modules/observations/domain/mutation-identity-projection.ts). Pin tests
// run both over the same fixtures; any drift fails the build.
export const PRIMARY_IDENTITY_KEYS = new Set([
  "url", "html_url", "externalId", "external_id", "id", "identifier", "fullIdentifier", "full_identifier",
  "number", "issue_number", "issueNumber", "issueId", "issue_id", "commentId", "comment_id", "pull_number", "pullNumber", "pr_number",
  "owner", "org", "repo", "repository", "repository_full_name", "repo_full_name", "name", "review_id", "reviewId", "sha",
  "fileId", "file_id", "documentId", "document_id", "spreadsheetId", "spreadsheet_id", "presentationId", "presentation_id",
  "mimeType", "mime_type", "webViewLink", "document_url", "spreadsheet_url", "presentation_url", "title",
]);
// Specialized create/action keys the server keeps beside the primary ones.
const SPECIALIZED_IDENTITY_KEYS = ["file_name", "newSpreadsheetId", "newSpreadsheetUrl", "team"];
const WRAPPER_KEYS = new Set([
  "result", "structuredContent", "structured_content", "data", "issue", "comment", "pull_request", "pullRequest", "output",
  "commit", "file", "document", "spreadsheet", "presentation", "content", "created_comments", "created_replies",
]);
const INPUT_FIELDS = ["input", "tool.input", "tool_input", "arguments", "tool.arguments", "parameters", "tool_parameters", "tool.parameters"];
const RESULT_FIELDS = ["output", "tool.output", "tool_output", "body", "tool.result"];
const MAX_PROJECTION_BYTES = 32 * 1024, MAX_SCALAR_CHARS = 4096, MAX_PARSE_DEPTH = 6, MAX_WALK_DEPTH = 8, MAX_ARRAY_ITEMS = 128;

/** Reserved key on a projected side: { "<source>": { "<as>": id | id[] | boolean } }. */
export const WORK_SOURCE_IDENTITY_KEY = "work_source_identity";
const MAX_PATH_VALUE_CHARS = 2048;
/** Provider ids and keys: no whitespace, so no names, titles or prose. */
const OPAQUE_IDENTITY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@#/+=~-]{0,255}$/;
/** An email address is personal data, never an id-path identity. */
const EMAIL_SHAPED = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
/** MCP transport envelopes an identity path may sit inside. */
const IDENTITY_PATH_TRANSPORT_KEYS = ["structuredContent", "structured_content", "content", "result"];

// ---- Identity path grammar: a port of the dashboard's
// src/modules/quality/domain/work-sources/identity-path.ts. A path is a dot
// path of keys with `[]` after a key that holds an array.
const MAX_IDENTITY_PATH_SEGMENTS = 8, MAX_IDENTITY_PATH_CHARS = 256, MAX_IDENTITY_PATH_OPERATIONS = 32;
const MAX_IDENTITY_PATHS_PER_SOURCE = 64;
export const IDENTITY_AS_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;
const SEGMENT_PATTERN = /^([A-Za-z_$][A-Za-z0-9_$-]{0,63})(\[\])?$/;
const OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Parsed segments, or null when the path is not in the grammar. */
export function parseIdentityPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_IDENTITY_PATH_CHARS) return null;
  const parts = path.split(".");
  if (parts.length > MAX_IDENTITY_PATH_SEGMENTS) return null;
  const segments = [];
  for (const part of parts) {
    const match = SEGMENT_PATTERN.exec(part);
    if (!match || FORBIDDEN_KEYS.has(match[1])) return null;
    segments.push({ key: match[1], array: match[2] === "[]" });
  }
  return segments;
}

/** The dashboard's toolNameMatchesOperation: case-insensitive on both sides. */
export function toolNameMatchesOperation(toolName, operation) {
  const name = toolName.trim().toLowerCase(), op = operation.trim().toLowerCase();
  return name === op || name.endsWith(`_${op}`) || name.endsWith(`:${op}`) || name.endsWith(`/${op}`);
}

// ---- The contract: what the server serves at
// GET /api/v1/telemetry/claude-code/hooks/contract, validated all or nothing.
export const CONTRACT_VERSION = 1;
const MAX_CONTRACT_BYTES = 256 * 1024;
const MAX_CONTRACT_MUTATIONS = 1024, MAX_CONTRACT_KEYS = 512, MAX_CONTRACT_SOURCES = 32, MAX_CONTRACT_PATHS = 1024;
const CONTRACT_KEYS = ["identityPaths", "mutations", "primaryIdentityKeys", "version"];
/** Exactly what the server serves: `kind` is always emitted, "id" or "flag". */
const IDENTITY_PATH_KEYS = ["as", "kind", "operations", "path", "side", "source"];
const IDENTITY_KEY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;
const SOURCE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const hasExactKeys = (value, keys) => isRecord(value) && Object.keys(value).sort().join(",") === keys.join(",");
const stringList = (value, max, pattern) => Array.isArray(value) && value.length >= 1 && value.length <= max &&
  value.every((item) => typeof item === "string" && pattern.test(item));

/**
 * A validated, ready-to-apply contract, or null. Any unknown key, wrong type,
 * oversized list or path outside the server's grammar rejects the whole
 * contract: it is never partially applied.
 */
export function parseConnectorContract(value) {
  if (!hasExactKeys(value, CONTRACT_KEYS) || value.version !== CONTRACT_VERSION) return null;
  try { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_CONTRACT_BYTES) return null; } catch { return null; }
  if (!stringList(value.mutations, MAX_CONTRACT_MUTATIONS, OPERATION_PATTERN)) return null;
  if (!stringList(value.primaryIdentityKeys, MAX_CONTRACT_KEYS, IDENTITY_KEY_PATTERN)) return null;
  if (value.primaryIdentityKeys.some((key) => FORBIDDEN_KEYS.has(key))) return null;
  if (!Array.isArray(value.identityPaths) || value.identityPaths.length > MAX_CONTRACT_PATHS) return null;
  const modules = new Map(), kinds = new Map();
  for (const entry of value.identityPaths) {
    if (!hasExactKeys(entry, IDENTITY_PATH_KEYS)) return null;
    if (typeof entry.source !== "string" || !SOURCE_PATTERN.test(entry.source) || FORBIDDEN_KEYS.has(entry.source)) return null;
    if (entry.side !== "input" && entry.side !== "result") return null;
    const segments = parseIdentityPath(entry.path);
    if (!segments) return null;
    if (typeof entry.as !== "string" || !IDENTITY_AS_PATTERN.test(entry.as)) return null;
    if (entry.kind !== "id" && entry.kind !== "flag") return null;
    // A flag is one boolean: never from an array.
    if (entry.kind === "flag" && segments.some((segment) => segment.array)) return null;
    // One `as` is one value shape: a source cannot declare it both as an id and as a flag.
    const kindKey = `${entry.source}\u0000${entry.as}`;
    if ((kinds.get(kindKey) ?? entry.kind) !== entry.kind) return null;
    kinds.set(kindKey, entry.kind);
    if (!stringList(entry.operations, MAX_IDENTITY_PATH_OPERATIONS, OPERATION_PATTERN)) return null;
    const paths = modules.get(entry.source) ?? [];
    if (paths.length >= MAX_IDENTITY_PATHS_PER_SOURCE) return null;
    paths.push({ operations: [...entry.operations], side: entry.side, path: entry.path, as: entry.as, kind: entry.kind, segments });
    modules.set(entry.source, paths);
  }
  if (modules.size > MAX_CONTRACT_SOURCES) return null;
  const primaryIdentityKeys = new Set(value.primaryIdentityKeys);
  return {
    version: CONTRACT_VERSION,
    mutations: [...new Set(value.mutations)],
    primaryIdentityKeys,
    identityKeys: new Set([...primaryIdentityKeys, ...SPECIALIZED_IDENTITY_KEYS]),
    // First appearance is the server's module order.
    modules: [...modules].map(([id, identityPaths]) => ({ id, identityPaths })),
  };
}

export const VENDORED_CONTRACT = parseConnectorContract({
  version: CONTRACT_VERSION, mutations: MUTATIONS, primaryIdentityKeys: [...PRIMARY_IDENTITY_KEYS], identityPaths: [],
});

// ---- The projector.
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
    if (state.identityKeys.has(key)) { const scalar = boundedScalar(nested, state); if (scalar !== null) projected[key] = scalar; continue; }
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

// ---- identityPaths: operation-scoped paths into the raw input or result.
function normalizedToolNames(value) {
  const names = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return [...new Set(names.flatMap((name) => typeof name === "string" && name.trim() ? [name.trim()] : []))];
}
function withWorkSourceIdentity(projected, namespace) {
  if (!namespace) return projected;
  return { ...(projected ?? {}), [WORK_SOURCE_IDENTITY_KEY]: namespace };
}
const normalizedOperation = (operation) => operation.trim().toLowerCase();

/**
 * The dashboard's winningIdentityPathOperations: which module owns a called
 * tool, and through which operation. For each tool name, every identityPaths
 * operation of every module (either side) that matches it competes: exact
 * equality (case-insensitive) beats any suffix match, the longest suffix wins,
 * and when more than one module declares the winning operation none of them
 * owns the call. Several tool names are judged alone and combined.
 * Returns, per module id, the winning operations (lower-cased) it owns.
 */
export function winningIdentityPathOperations(toolNames, modules) {
  const winners = new Map();
  for (const toolName of toolNames) {
    const called = normalizedOperation(toolName);
    let best = null, owners = new Set();
    for (const workSource of modules) {
      for (const path of workSource.identityPaths) {
        for (const operation of path.operations) {
          if (!toolNameMatchesOperation(toolName, operation)) continue;
          const normalized = normalizedOperation(operation);
          const rank = normalized === called ? Number.POSITIVE_INFINITY : normalized.length;
          if (!best || rank > best.rank) {
            best = { operation: normalized, rank };
            owners = new Set([workSource.id]);
          } else if (rank === best.rank) {
            owners.add(workSource.id);
            if (normalized !== best.operation) owners.add("\u0000tie");
          }
        }
      }
    }
    if (!best || owners.size !== 1) continue;
    const [owner] = owners;
    const operations = winners.get(owner) ?? new Set();
    operations.add(best.operation);
    winners.set(owner, operations);
  }
  return winners;
}
/** A path applies only if its module won the call through an operation it lists. */
function pathApplies(workSource, path, winners) {
  const owned = winners.get(workSource.id);
  return owned !== undefined && path.operations.some((operation) => owned.has(normalizedOperation(operation)));
}
/** The value shape is fixed by the declaration, never by what was observed:
 * "flag", "id_array" (a path for that `as` and side has `[]`) or "id"; null
 * when undeclared or when the declarations disagree on the kind. */
function declaredShape(module, side, as) {
  const paths = module.identityPaths.filter((path) => path.side === side && path.as === as);
  if (paths.length === 0) return null;
  const kinds = new Set(paths.map((path) => path.kind));
  if (kinds.size !== 1) return null;
  if (kinds.has("flag")) return "flag";
  return paths.some((path) => path.segments.some((segment) => segment.array)) ? "id_array" : "id";
}

function workSourceIdentity(envelope, fields, side, toolNames, modules, state) {
  if (!envelope) return null;
  const namespace = {};
  const winners = winningIdentityPathOperations(toolNames, modules);
  // Names found ambiguous here: a supplied value for one of them is dropped too.
  const ambiguous = new Map();
  for (const workSource of modules) {
    if (!winners.has(workSource.id)) continue;
    const collected = new Map();
    for (const path of workSource.identityPaths) {
      if (path.side !== side || !pathApplies(workSource, path, winners)) continue;
      const values = collected.get(path.as) ?? [];
      for (const field of fields) {
        if (Object.hasOwn(envelope, field)) values.push(...identityPathValues(envelope[field], path.segments, path.kind, state));
      }
      collected.set(path.as, values);
    }
    const kept = {};
    for (const [as, values] of collected) {
      const unique = [...new Set(values)];
      if (unique.length === 0) continue;
      const shape = declaredShape(workSource, side, as);
      if (shape === "id_array") {
        if (unique.length > MAX_ARRAY_ITEMS) state.tooLarge = true;
        kept[as] = unique.slice(0, MAX_ARRAY_ITEMS);
      } else if (shape !== null && unique.length === 1) {
        kept[as] = unique[0];
      } else {
        // Two different values for a single-valued identity or flag are ambiguous: keep neither.
        const names = ambiguous.get(workSource.id) ?? new Set();
        names.add(as);
        ambiguous.set(workSource.id, names);
      }
    }
    if (Object.keys(kept).length > 0) namespace[workSource.id] = kept;
  }
  // A subtree already present is kept only if every part of it is valid.
  const supplied = sanitizeWorkSourceIdentity(envelope[WORK_SOURCE_IDENTITY_KEY], side, toolNames, modules);
  for (const [source, suppliedFields] of Object.entries(supplied ?? {})) {
    const merged = { ...suppliedFields, ...(namespace[source] ?? {}) };
    for (const as of ambiguous.get(source) ?? []) delete merged[as];
    if (Object.keys(merged).length > 0) namespace[source] = merged;
  }
  return Object.keys(namespace).length > 0 ? namespace : null;
}
/** All or nothing, exactly as the server re-validates what the hook sends:
 * with a tool name, every name must belong to an operation its module wins. */
function sanitizeWorkSourceIdentity(value, side, toolNames, modules) {
  if (!isRecord(value)) return null;
  const sources = Object.entries(value);
  if (sources.length === 0 || sources.length > modules.length) return null;
  const winners = toolNames.length > 0 ? winningIdentityPathOperations(toolNames, modules) : null;
  const sanitized = {};
  for (const [source, fields] of sources) {
    const workSource = modules.find((candidate) => candidate.id === source);
    if (!workSource || !isRecord(fields)) return null;
    const names = Object.entries(fields);
    if (names.length === 0) return null;
    const kept = {};
    for (const [as, raw] of names) {
      const declared = workSource.identityPaths.some((path) => path.side === side && path.as === as && (winners === null || pathApplies(workSource, path, winners)));
      if (!declared) return null;
      const shape = declaredShape(workSource, side, as);
      const normalized = shape === "flag" ? (typeof raw === "boolean" ? raw : null)
        : shape === "id_array" ? exactIdentityArray(raw)
          : shape === "id" ? exactIdentityScalar(raw) : null;
      if (normalized === null) return null;
      kept[as] = normalized;
    }
    sanitized[workSource.id] = kept;
  }
  return sanitized;
}
function exactIdentityScalar(value) {
  const normalized = identityPathValue(value);
  return normalized !== null && normalized === value ? normalized : null;
}
function exactIdentityArray(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARRAY_ITEMS) return null;
  const items = value.map(exactIdentityScalar);
  return items.every((item) => item !== null) ? items : null;
}
/** A bounded identity literal for an `id` path; never an email address. */
function identityPathValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const literal = value.trim();
  if (!literal || literal.length > MAX_PATH_VALUE_CHARS) return null;
  if (EMAIL_SHAPED.test(literal)) return null;
  return isIdentityLiteral(literal) || OPAQUE_IDENTITY_TOKEN.test(literal) ? literal : null;
}
/** A boolean for a `flag` path; the exact strings "true"/"false" are normalized. */
function identityFlagValue(value) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}
function identityPathValues(value, segments, kind, state) {
  // The walker already reports malformed JSON for these same fields.
  const decoding = { malformed: false, tooLarge: false };
  const values = identityPathRoots(value, decoding, 0).flatMap((root) => walkIdentityPath(root, segments, 0, kind, state));
  if (decoding.tooLarge) state.tooLarge = true;
  return values;
}
/** The decoded value and the MCP transport envelopes inside it. A JSON-RPC
 * message (any record with a `jsonrpc` key) is never a root itself: its `id`
 * is a request counter, so only its `result` is descended. */
function identityPathRoots(value, state, depth) {
  if (depth > MAX_WALK_DEPTH) return [];
  const decoded = decodeStructured(value, state);
  if (Array.isArray(decoded)) {
    if (decoded.length > MAX_ARRAY_ITEMS) state.tooLarge = true;
    return decoded.slice(0, MAX_ARRAY_ITEMS).flatMap((block) => isRecord(block) && block.type === "text" ? identityPathRoots(block.text, state, depth + 1) : []);
  }
  if (!isRecord(decoded)) return [];
  if (Object.hasOwn(decoded, "jsonrpc")) return Object.hasOwn(decoded, "result") ? identityPathRoots(decoded.result, state, depth + 1) : [];
  return [decoded, ...IDENTITY_PATH_TRANSPORT_KEYS.flatMap((key) => Object.hasOwn(decoded, key) ? identityPathRoots(decoded[key], state, depth + 1) : [])];
}
function walkIdentityPath(node, segments, index, kind, state) {
  if (index === segments.length) {
    const value = kind === "flag" ? identityFlagValue(node) : identityPathValue(node);
    return value === null ? [] : [value];
  }
  const segment = segments[index];
  if (!isRecord(node) || !Object.hasOwn(node, segment.key)) return [];
  const child = node[segment.key];
  if (!segment.array) return walkIdentityPath(child, segments, index + 1, kind, state);
  // A flag never comes from an array (the contract rejects `[]` in flag paths).
  if (kind === "flag" || !Array.isArray(child)) return [];
  if (child.length > MAX_ARRAY_ITEMS) state.tooLarge = true;
  return child.slice(0, MAX_ARRAY_ITEMS).flatMap((item) => walkIdentityPath(item, segments, index + 1, kind, state));
}

/** Same contract as the dashboard: { projection | null, omissionReason }.
 * identityPaths apply only with a tool name, and only for the module that
 * wins the call under the specificity rule, through the operation it won. */
export function projectMutationIdentity(input, contract = VENDORED_CONTRACT) {
  const state = { malformed: false, tooLarge: false, identityKeys: contract.identityKeys };
  const toolNames = normalizedToolNames(input.toolName);
  const projectedInput = withWorkSourceIdentity(
    projectEnvelope(input.inputProjection, INPUT_FIELDS, true, state),
    workSourceIdentity(input.inputProjection, INPUT_FIELDS, "input", toolNames, contract.modules, state));
  const projectedResult = withWorkSourceIdentity(
    projectEnvelope(input.resultProjection, RESULT_FIELDS, false, state),
    workSourceIdentity(input.resultProjection, RESULT_FIELDS, "result", toolNames, contract.modules, state));
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
function connectorTool(toolName) {
  const parts = splitToolName(toolName);
  return parts && !SABIA_SERVERS.test(parts.serverName) ? parts : null;
}
/** The dashboard's isClaudeCodeHookMutation, over the given contract. */
export function isMutation(toolName, contract = VENDORED_CONTRACT) {
  const parts = connectorTool(toolName);
  return !!parts && contract.mutations.some((name) => toolNameMatchesOperation(parts.operation, name));
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
/** Everything that can be judged before a contract is loaded. */
function connectorCandidate(event) {
  return event?.hook_event_name === "PostToolUse" && !!connectorTool(event.tool_name) &&
    coordinate(event.tool_use_id) && coordinate(event.session_id) && !errorShaped(event.tool_response);
}

/** Host coordinates and the allowlisted identity only. transcript_path, cwd,
 * prompt_id and anything unlisted are never read. */
export function connectorEnvelope(event, now = Date.now(), contract = VENDORED_CONTRACT) {
  if (!connectorCandidate(event) || !isMutation(event.tool_name, contract)) return null;
  const { projection } = projectMutationIdentity({
    inputProjection: event.tool_input === undefined ? null : { input: event.tool_input },
    resultProjection: event.tool_response === undefined ? null : { output: event.tool_response },
    toolName: event.tool_name,
  }, contract);
  if (!projection) return null;
  const envelope = {
    schema_version: SCHEMA_VERSION, hook_event_name: "PostToolUse", tool_name: event.tool_name, tool_use_id: event.tool_use_id,
    session_id: event.session_id, occurred_at: new Date(now).toISOString(), success: true,
    identity: { input: projection.input, result: projection.result },
  };
  return Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_ENVELOPE_BYTES ? null : envelope;
}

// ---- Contract fetch and cache.
export const CONTRACT_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed refresh, wait this long before trying again, so an offline
 * machine does not spend a fetch timeout on every connector call. */
export const CONTRACT_RETRY_MS = 15 * 60 * 1000;
export const CONTRACT_TIMEOUT_MS = 1500;
const CACHE_FORMAT = 1;
const MAX_CACHE_BYTES = MAX_CONTRACT_BYTES + 4096;

export function contractCachePath(claudeHome) {
  return process.env.CLAUDE_PLUGIN_DATA
    ? join(process.env.CLAUDE_PLUGIN_DATA, "connector-hook-contract.json")
    : join(claudeHome, "sabia-connector-hook-contract.json");
}

/** A small regular file, read without following a symlink and only after its
 * size is known to be within bounds; null for anything else. */
async function readRegularFile(path, maxBytes, { ownedByProcessUser = false } = {}) {
  let handle;
  try {
    const link = await lstat(path);
    if (!link.isFile() || link.size > maxBytes) return null;
    // O_NONBLOCK: a FIFO swapped in after the lstat cannot hang the hook.
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes || info.dev !== link.dev || info.ino !== link.ino) return null;
    if (ownedByProcessUser && typeof process.getuid === "function" && info.uid !== process.getuid()) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maxBytes) return null;
    }
    return buffer.subarray(0, size).toString("utf8");
  } catch { return null; } finally { await handle?.close().catch(() => {}); }
}
/** Write-then-rename through a fresh temporary file that must not exist yet. */
async function writePrivateFile(path, text) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
  await rename(temporary, path).catch(async (error) => { await unlink(temporary).catch(() => {}); throw error; });
}

/**
 * Binds a cached contract to the Sabia origin and the ingestion key it was
 * fetched with. The key itself is never written; a contract edited on disk
 * no longer matches.
 */
function contractProof(token, origin, raw) {
  return createHmac("sha256", token).update(`sabia-connector-hook-contract\n${origin}\n${JSON.stringify(raw)}`).digest("hex");
}
function proofMatches(proof, expected) {
  return typeof proof === "string" && proof.length === expected.length && timingSafeEqual(Buffer.from(proof), Buffer.from(expected));
}
/** Grants nothing the vendored v1 contract does not: no wider key allowlist, no identity paths. */
function withinVendored(contract) {
  return contract.modules.length === 0 && [...contract.primaryIdentityKeys].every((key) => VENDORED_CONTRACT.primaryIdentityKeys.has(key));
}

/** The cache holds the last good contract, an HMAC proof that it is what
 * Sabia served for this key, and when it was fetched and last checked — never
 * the ingestion key — for one Sabia origin. A cached contract wider than the
 * vendored v1 contract is applied only with a valid proof. */
async function readContractCache(path, origin, token) {
  const text = await readRegularFile(path, MAX_CACHE_BYTES);
  if (text === null) return null;
  try {
    const cache = JSON.parse(text);
    if (!isRecord(cache) || cache.format !== CACHE_FORMAT || cache.origin !== origin) return null;
    let contract = cache.contract === null ? null : parseConnectorContract(cache.contract);
    const proven = contract !== null && proofMatches(cache.proof, contractProof(token, origin, cache.contract));
    if (contract && !proven && !withinVendored(contract)) contract = null;
    return {
      raw: contract ? cache.contract : null, proof: contract && proven ? cache.proof : null, contract,
      fetchedAt: contract && Number.isFinite(cache.fetchedAt) ? cache.fetchedAt : null,
      checkedAt: Number.isFinite(cache.checkedAt) ? cache.checkedAt : null,
    };
  } catch { return null; }
}
/** True when the cache now holds the record. */
async function writeContractCache(path, record) {
  try { await writePrivateFile(path, JSON.stringify({ format: CACHE_FORMAT, ...record })); return true; }
  catch { return false; }
}

/**
 * Where the retry pause is remembered when the cache itself cannot be
 * written: a per-user, per-cache marker in the temporary directory holding
 * only when Sabia was last tried. It can postpone a fetch by at most
 * CONTRACT_RETRY_MS and never supplies a contract.
 */
export function retryMarkerPath(cachePath, origin) {
  const user = typeof process.getuid === "function" ? process.getuid() : "user";
  const key = createHash("sha256").update(`${origin}\n${cachePath}`).digest("hex").slice(0, 24);
  return join(tmpdir(), `sabia-connector-hook-${user}-${key}.json`);
}
async function readRetryMarker(path, origin) {
  const text = await readRegularFile(path, 1024, { ownedByProcessUser: true });
  if (text === null) return null;
  try {
    const marker = JSON.parse(text);
    return isRecord(marker) && marker.format === CACHE_FORMAT && marker.origin === origin && Number.isFinite(marker.checkedAt) ? marker.checkedAt : null;
  } catch { return null; }
}
async function boundedText(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}
/** One bounded GET: the raw contract when it validates, otherwise null. The
 * deadline covers the whole exchange, body included. */
async function fetchContract(url, token, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); });
  const attempt = (async () => {
    const response = await fetchImpl(url, {
      method: "GET", redirect: "manual", signal: controller.signal,
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
    if (response.status !== 200) { await response.body?.cancel().catch(() => {}); return null; }
    const text = await boundedText(response, MAX_CONTRACT_BYTES);
    if (text === null) return null;
    const raw = JSON.parse(text);
    return parseConnectorContract(raw) ? raw : null;
  })().catch(() => null);
  try { return await Promise.race([attempt, deadline]); } finally { clearTimeout(timer); }
}

/**
 * The contract to apply and where it came from: a fresh cache, else a newly
 * fetched contract, else the last good cache however old, else the vendored
 * v1 contract. Never throws, and never waits longer than the fetch timeout.
 */
export async function loadConnectorContract(context, options = {}) {
  const now = options.now ?? Date.now();
  const origin = new URL(context.endpoint).origin;
  const path = options.contractPath ?? contractCachePath(options.claudeHome ?? join(homedir(), ".claude"));
  const markerPath = retryMarkerPath(path, origin);
  const cache = await readContractCache(path, origin, context.token);
  const age = (at) => (at === null || at > now ? Infinity : now - at);
  if (cache?.contract && age(cache.fetchedAt) < CONTRACT_TTL_MS) return { contract: cache.contract, source: "cache" };
  const fallback = cache?.contract ? { contract: cache.contract, source: "stale_cache" } : { contract: VENDORED_CONTRACT, source: "vendored" };
  if (cache && age(cache.checkedAt) < CONTRACT_RETRY_MS) return fallback;
  if (age(await readRetryMarker(markerPath, origin)) < CONTRACT_RETRY_MS) return fallback;
  const raw = await fetchContract(new URL("/api/v1/telemetry/claude-code/hooks/contract", context.endpoint).href, context.token,
    options.fetch ?? fetch, options.contractTimeoutMs ?? CONTRACT_TIMEOUT_MS);
  if (raw) {
    await writeContractCache(path, { origin, fetchedAt: now, checkedAt: now, proof: contractProof(context.token, origin, raw), contract: raw });
    return { contract: parseConnectorContract(raw), source: "fetched" };
  }
  const cached = await writeContractCache(path, { origin, fetchedAt: cache?.fetchedAt ?? null, checkedAt: now, proof: cache?.proof ?? null, contract: cache?.raw ?? null });
  if (!cached) await writePrivateFile(markerPath, JSON.stringify({ format: CACHE_FORMAT, origin, checkedAt: now })).catch(() => {});
  return fallback;
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
  if (!connectorCandidate(event)) return { sent: false, reason: "not_a_mutation" };
  if (!await traceCaptureGranted(claudeHome)) return { sent: false, reason: "no_trace_grant" };
  const context = await deviceContext(claudeHome).catch(() => null);
  if (!context) return { sent: false, reason: "no_credential" };
  // One budget for the whole exchange, the contract fetch included.
  const deadline = Date.now() + (options.budgetMs ?? TOTAL_BUDGET_MS);
  const { contract } = await loadConnectorContract(context, { ...options, claudeHome });
  const envelope = connectorEnvelope(event, options.now, contract);
  if (!envelope) return { sent: false, reason: "not_a_mutation" };
  const endpoint = new URL("/api/v1/telemetry/claude-code/hooks", context.endpoint).href;
  const body = JSON.stringify(envelope);
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // No spool: a lost creation is lost, by design — a file that could hold
  // the credential is the greater risk. Retries stay inside the budget and
  // give up silently; the first attempt is always made.
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
