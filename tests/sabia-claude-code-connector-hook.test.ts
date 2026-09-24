import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  connectorEnvelope, isMutation, MUTATIONS, PRIMARY_IDENTITY_KEYS as PLUGIN_PRIMARY_KEYS,
  projectMutationIdentity as pluginProject, runConnectorHook,
} from "../scripts/sabia-connector-hook.mjs";

// The hook reads tool_name, tool_use_id, session_id, tool_input and
// tool_response, reduces the last two to the identity allowlist, and posts
// that under the tool-output grant. Everything else in the hook input —
// transcript_path, cwd, prompt_id — is never read.
let directory: string;
const token = `sbia_ing_0123456789ab_${"b".repeat(43)}`;
const endpoint = "https://app2.sabiapartners.ca/api/v1/telemetry/otlp";
const device = "5c0d0000-0000-4000-8000-000000000031";
const fileId = "1NHuMai1WZ-tXpaAoZ_6tpLc00E8RkLEfrUHXlTfpYWo";
const fixture = JSON.parse(readFileSync("tests/fixtures/claude-code-2.1.259/hook-post-tool-use-mcp.json", "utf8"));
const driveCreate = {
  ...fixture, tool_name: "mcp__google_drive__create_file", tool_use_id: "toolu_01DriveCreate",
  tool_input: { name: "GTM one-pager", mimeType: "application/vnd.google-apps.document", content: "Dear investor, here is why Sabia…" },
  tool_response: [{ type: "text", text: JSON.stringify({ id: fileId, name: "GTM one-pager", mimeType: "application/vnd.google-apps.document", webViewLink: `https://docs.google.com/document/d/${fileId}/edit`, content: "Dear investor, here is why Sabia…" }) }],
};
const settings = (env: Record<string, string>) => writeFile(join(directory, "settings.json"), JSON.stringify({ env }));
const run = (event: unknown, options: Record<string, unknown> = {}) => runConnectorHook(event, { claudeHome: directory, sleep: async () => {}, ...options });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sabia-connector-hook-"));
  await settings({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}`, OTEL_TRACES_EXPORTER: "otlp" });
  await writeFile(join(directory, "sabia-otel-state.json"), JSON.stringify({ deviceId: device, organizationId: "org", endpoint }));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("Claude Code connector hook", () => {
  it("reduces a Drive creation to its identifiers and names nothing else", () => {
    const envelope = connectorEnvelope(driveCreate, Date.parse("2026-09-22T15:00:00Z"));
    expect(envelope).toMatchObject({ schema_version: 1, hook_event_name: "PostToolUse", tool_name: "mcp__google_drive__create_file", tool_use_id: "toolu_01DriveCreate", session_id: fixture.session_id, occurred_at: "2026-09-22T15:00:00.000Z", success: true });
    const text = JSON.stringify(envelope);
    expect(text).toContain(fileId);
    expect(text).toContain("GTM one-pager");
    for (const secret of ["Dear investor", "/home/dev", fixture.prompt_id, "permission_mode"]) expect(text).not.toContain(secret);
    expect(Object.keys(envelope!).sort()).toEqual(["hook_event_name", "identity", "occurred_at", "schema_version", "session_id", "success", "tool_name", "tool_use_id"]);
  });
  it("sends nothing for reads, other events, error replies, Sabia's own tools, missing coordinates or identity-free replies", () => {
    expect(connectorEnvelope({ ...driveCreate, tool_name: "mcp__google_drive__get_document" })).toBeNull();
    expect(connectorEnvelope({ ...driveCreate, tool_name: "mcp__google_drive__search_files" })).toBeNull();
    expect(connectorEnvelope({ ...driveCreate, hook_event_name: "PreToolUse" })).toBeNull();
    expect(connectorEnvelope({ ...driveCreate, tool_response: { isError: true, content: driveCreate.tool_response } })).toBeNull();
    expect(connectorEnvelope({ ...driveCreate, tool_name: "mcp__plugin_sabia-claude-code-otel_sabia-artifacts__report_artifact" })).toBeNull();
    expect(connectorEnvelope({ ...driveCreate, tool_name: "Write" })).toBeNull();
    expect(connectorEnvelope({ ...driveCreate, tool_use_id: undefined })).toBeNull();
    expect(connectorEnvelope({ ...driveCreate, session_id: "" })).toBeNull();
    expect(connectorEnvelope({ ...driveCreate, tool_input: { content: "x" }, tool_response: [{ type: "text", text: "Created." }] })).toBeNull();
  });
  it("sends nothing when the error is wrapped in a content block or structured result", () => {
    // tool_input alone carries a file id and a PR number, so a missed error would still project an identity.
    const input = { fileId, pull_number: 42, owner: "sabia-partners", repo: "dashboard-langfuse" };
    const failed = JSON.stringify({ isError: true, error: "failed" });
    expect(connectorEnvelope({ ...driveCreate, tool_input: input, tool_response: [{ type: "text", text: failed }] })).toBeNull();
    expect(connectorEnvelope({ ...driveCreate, tool_input: input, tool_response: { content: [{ type: "text", text: failed }] } })).toBeNull();
    expect(connectorEnvelope({ ...driveCreate, tool_input: input, tool_response: { structuredContent: { error: "x" } } })).toBeNull();
    expect(connectorEnvelope({ ...driveCreate, tool_input: input, tool_response: { result: JSON.stringify({ is_error: true }) } })).toBeNull();
    for (const error of [null, false]) {
      const ok = [{ type: "text", text: JSON.stringify({ id: fileId, name: "GTM one-pager", error }) }];
      expect(connectorEnvelope({ ...driveCreate, tool_response: ok }), String(error)).not.toBeNull();
    }
  });
  it("accepts the Drive and GitHub operations the server accepts, by operation name", () => {
    for (const name of ["mcp__gdrive__update_document", "mcp__0daee481__batch_update_spreadsheet", "mcp__github__create_pull_request", "mcp__github__add_issue_comment"]) expect(isMutation(name), name).toBe(true);
    for (const name of ["mcp__github__get_pull_request", "mcp__github__list_pull_requests", "mcp__slack__send_message", "mcp__sabia-artifacts__report_artifact", "Bash"]) expect(isMutation(name), name).toBe(false);
  });
  it("carries the same operation list and identity allowlist as the dashboard", () => {
    // contracts/connector-hook/v1.json is generated from the dashboard's own
    // allowlist and projector, and the dashboard pins the same file; a change
    // on either side fails a test until both agree again.
    const contract = JSON.parse(readFileSync("contracts/connector-hook/v1.json", "utf8"));
    expect([...MUTATIONS].sort()).toEqual(contract.mutations);
    expect([...PLUGIN_PRIMARY_KEYS].sort()).toEqual(contract.primaryIdentityKeys);
    for (const { input, expected } of contract.projections) expect(pluginProject(input)).toEqual(expected);
  });
  it("posts the envelope to the exporter's origin with the bearer and prints nothing", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const stdout = vi.spyOn(process.stdout, "write");
    expect(await run(driveCreate, { fetch, now: 1_000 })).toEqual({ sent: true, attempts: 1 });
    expect(fetch).toHaveBeenCalledWith("https://app2.sabiapartners.ca/api/v1/telemetry/claude-code/hooks",
      expect.objectContaining({ redirect: "manual", headers: expect.objectContaining({ authorization: `Bearer ${token}` }), body: JSON.stringify(connectorEnvelope(driveCreate, 1_000)) }));
    expect(stdout).not.toHaveBeenCalled(); stdout.mockRestore();
  });
  it("retries transient failures with backoff and gives up silently without a spool", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("no", { status: 503 })).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(new Response("{}", { status: 200 }));
    const sleep = vi.fn(async (_ms: number) => {});
    expect(await run(driveCreate, { fetch, sleep })).toEqual({ sent: true, attempts: 3 });
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([300, 900]);
    fetch.mockReset().mockRejectedValue(new Error("offline")); sleep.mockClear();
    expect(await run(driveCreate, { fetch, sleep })).toEqual({ sent: false, reason: "gave_up" });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([300, 900, 2700]);
  });
  it("does not retry a refusal", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("no", { status: 403 }));
    expect(await run(driveCreate, { fetch })).toEqual({ sent: false, reason: "http_403", attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("is a no-op without the tool-output grant or the managed credential", async () => {
    const fetch = vi.fn();
    await settings({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}`, OTEL_TRACES_EXPORTER: "none" });
    expect(await run(driveCreate, { fetch })).toEqual({ sent: false, reason: "no_trace_grant" });
    await settings({ OTEL_TRACES_EXPORTER: "otlp" });
    expect(await run(driveCreate, { fetch })).toEqual({ sent: false, reason: "no_credential" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
