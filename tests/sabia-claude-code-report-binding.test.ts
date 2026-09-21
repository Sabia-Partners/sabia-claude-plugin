import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { conversationKey, nativeBinding, runReportBindingHook } from "../scripts/sabia-report-binding.mjs";

// The hook posts the report call's tool_use_id and a device-hashed session_id
// over the managed telemetry credential. Everything else in the hook input is
// never read: tool_input, transcript_path, cwd, prompt_id.
let directory: string;
const proof = `sbia_proof_${"a".repeat(43)}`;
const token = `sbia_ing_0123456789ab_${"b".repeat(43)}`;
const endpoint = "https://app2.sabiapartners.ca/api/v1/telemetry/otlp";
const device = "5c0d0000-0000-4000-8000-000000000031";
const scopedTool = "mcp__plugin_sabia-claude-code-otel_sabia-artifacts__report_artifact";
const acceptance = { report_id: "5c0d0000-0000-4000-8000-000000000050", output_id: "5c0d0000-0000-4000-8000-000000000051", receipt_status: "accepted", receipt_proof: proof };
const event = { hook_event_name: "PostToolUse", session_id: "00000000-0000-4000-a000-000000000018", transcript_path: "/do-not-read", cwd: "/workspace",
  tool_name: scopedTool, tool_use_id: "toolu_01ReportCall", tool_input: { session_id: "agent-claim", artifact: { external_id: "sabia-partners/dashboard-langfuse#84" } },
  tool_response: [{ type: "text", text: JSON.stringify(acceptance) }] };
const expectedKey = createHash("sha256").update(JSON.stringify({ source: "claude_code", deviceId: device, nativeSessionId: event.session_id })).digest("hex");
const run = (input: unknown, options: Record<string, unknown> = {}) => runReportBindingHook(input, { claudeHome: directory, dataPath: directory, ...options });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sabia-claude-binding-"));
  await writeFile(join(directory, "settings.json"), JSON.stringify({ env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}` } }));
  await writeFile(join(directory, "sabia-otel-state.json"), JSON.stringify({ deviceId: device, organizationId: "org", endpoint }));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("Claude Code report binding", () => {
  it("uses the native tool_use_id and a hashed session_id, never tool input or the transcript", () => {
    const binding = nativeBinding(event, device, Date.parse("2026-09-21T22:00:00Z"));
    expect(binding).toEqual({ version: 1, receipt_proof: proof, invocation_id: "toolu_01ReportCall", conversation_key: expectedKey, observed_at: "2026-09-21T22:00:00.000Z" });
    expect(conversationKey(device, event.session_id)).toBe(expectedKey);
    expect(JSON.stringify(binding)).not.toContain(event.session_id);
    expect(JSON.stringify(binding)).not.toContain("agent-claim");
  });
  it("accepts the bare server name and the receipt inside known wrappers only", () => {
    expect(nativeBinding({ ...event, tool_name: "mcp__sabia-artifacts__report_artifact" }, device)).toMatchObject({ invocation_id: "toolu_01ReportCall" });
    expect(nativeBinding({ ...event, tool_response: { structuredContent: { result: acceptance } } }, device)).toMatchObject({ receipt_proof: proof });
    expect(nativeBinding({ ...event, tool_response: { content: [{ type: "text", text: JSON.stringify(acceptance) }] } }, device)).toMatchObject({ receipt_proof: proof });
    expect(nativeBinding({ ...event, tool_response: `Quoted: ${JSON.stringify(acceptance)}` }, device)).toBeNull();
  });
  it("ignores other tools, lookups, failures, duplicates and missing coordinates", () => {
    expect(nativeBinding({ ...event, tool_name: "mcp__plugin_sabia-claude-code-otel_sabia-artifacts__get_artifact_report" }, device)).toBeNull();
    expect(nativeBinding({ ...event, tool_name: "mcp__plugin_other_sabia-artifacts__report_artifact" }, device)).toBeNull();
    expect(nativeBinding({ ...event, tool_name: "Bash" }, device)).toBeNull();
    expect(nativeBinding({ ...event, hook_event_name: "PreToolUse" }, device)).toBeNull();
    expect(nativeBinding({ ...event, tool_response: [{ type: "text", text: JSON.stringify({ ...acceptance, receipt_status: "duplicate" }) }] }, device)).toBeNull();
    expect(nativeBinding({ ...event, tool_response: { isError: true, content: event.tool_response } }, device)).toBeNull();
    expect(nativeBinding({ ...event, tool_use_id: undefined }, device)).toBeNull();
    expect(nativeBinding({ ...event, session_id: "" }, device)).toBeNull();
    expect(nativeBinding({ ...event, tool_use_id: "toolu\n01" }, device)).toBeNull();
    expect(nativeBinding(event, "")).toBeNull();
  });
  it("posts only the envelope to the exporter's origin, with the bearer, and prints nothing", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const stdout = vi.spyOn(process.stdout, "write");
    await run(event, { fetch, now: 1_000 });
    expect(fetch).toHaveBeenCalledWith("https://app2.sabiapartners.ca/api/v1/artifact-reporting/claude-code-invocation",
      expect.objectContaining({ redirect: "manual", headers: expect.objectContaining({ authorization: `Bearer ${token}` }), body: JSON.stringify(nativeBinding(event, device, 1_000)) }));
    for (const value of [event.session_id, "agent-claim", "/do-not-read"]) expect(JSON.stringify(fetch.mock.calls[0]?.[1]?.body)).not.toContain(value);
    expect(stdout).not.toHaveBeenCalled(); stdout.mockRestore();
    expect(await readdir(join(directory, "pending"))).toEqual([]);
  });
  it("keeps the original coordinates after a lost response and retries with backoff from another session", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("lost response")).mockResolvedValue(new Response("{}", { status: 200 }));
    await run(event, { fetch, now: 1_000 });
    const queued = await readdir(join(directory, "pending")); expect(queued).toHaveLength(1);
    const text = await readFile(join(directory, "pending", queued[0]!), "utf8");
    expect(text).not.toContain(token); expect(text).not.toContain(event.session_id);
    expect(JSON.parse(text)).toMatchObject({ attempts: 1, nextAttemptAt: 2_000 });
    await run({ hook_event_name: "SessionStart", session_id: "another-session" }, { fetch, now: 1_999 });
    expect(fetch).toHaveBeenCalledTimes(1);
    await run({ hook_event_name: "SessionStart", session_id: "another-session" }, { fetch, now: 2_000 });
    expect(fetch.mock.calls.map((call) => JSON.parse(call[1].body))).toMatchObject([{ invocation_id: "toolu_01ReportCall", conversation_key: expectedKey }, { invocation_id: "toolu_01ReportCall", conversation_key: expectedKey }]);
    expect(await readdir(join(directory, "pending"))).toEqual([]);
  });
  it("keeps concurrent sessions distinct and survives credential rotation", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    await Promise.all([event, { ...event, tool_use_id: "toolu_02Other", session_id: "00000000-0000-4000-a000-000000000019" }].map((e) => run(e, { fetch, now: 1_000 })));
    expect(await readdir(join(directory, "pending"))).toHaveLength(2);
    const rotated = token.replace("b".repeat(43), "c".repeat(43));
    await writeFile(join(directory, "settings.json"), JSON.stringify({ env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${rotated}` } }));
    fetch.mockClear(); fetch.mockImplementation(async () => new Response("{}", { status: 200 }));
    await run({ hook_event_name: "SessionStart" }, { fetch, now: 2_000 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every((call) => call[1].headers.authorization === `Bearer ${rotated}`)).toBe(true);
    expect(await readdir(join(directory, "pending"))).toEqual([]);
  });
  it.each([429, 500, 503])("retains HTTP %i, backs off, and later succeeds", async (status) => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("no", { status })).mockResolvedValue(new Response("{}", { status: 200 }));
    await run(event, { fetch, now: 1_000 });
    expect(await readdir(join(directory, "pending"))).toHaveLength(1);
    await run({ hook_event_name: "SessionStart" }, { fetch, now: 1_500 });
    expect(fetch).toHaveBeenCalledTimes(1);
    await run({ hook_event_name: "SessionStart" }, { fetch, now: 2_000 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await readdir(join(directory, "pending"))).toEqual([]);
  });
  it.each([400, 401, 403, 409, 410])("drops a delivery the server answered %i without a retry loop", async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response("no", { status }));
    await run(event, { fetch, now: 1_000 });
    expect(await readdir(join(directory, "pending"))).toEqual([]);
    await run({ hook_event_name: "SessionStart" }, { fetch, now: 5_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("expires queued bindings after 24 hours and caps the queue at the 64 newest", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    await run(event, { fetch, now: 1_000 });
    fetch.mockClear();
    await run({ hook_event_name: "SessionStart" }, { fetch, now: 1_000 + TTL + 1 });
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(join(directory, "pending"))).toEqual([]);
    const pending = join(directory, "pending");
    await Promise.all(Array.from({ length: 70 }, (_, createdAt) => writeFile(join(pending, `${createdAt.toString(16).padStart(64, "0")}.json`),
      JSON.stringify({ binding: { version: 1, receipt_proof: proof, invocation_id: `toolu_${createdAt}`, conversation_key: expectedKey }, createdAt, attempts: 1, nextAttemptAt: 10_000, deviceId: device, organizationId: "org" }))));
    await run({ hook_event_name: "SessionStart" }, { fetch, now: 100 });
    const surviving = await Promise.all((await readdir(pending)).map(async (name) => JSON.parse(await readFile(join(pending, name), "utf8")).createdAt as number));
    expect(surviving.sort((a, b) => a - b)).toEqual(Array.from({ length: 64 }, (_, index) => index + 6));
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not replay pending data into a different device or organization, nor to a changed origin", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    await run(event, { fetch, now: 1_000 });
    await writeFile(join(directory, "sabia-otel-state.json"), JSON.stringify({ deviceId: "other-device", organizationId: "other-org", endpoint }));
    fetch.mockClear(); await run({ hook_event_name: "SessionStart" }, { fetch, now: 1_000 });
    expect(fetch).not.toHaveBeenCalled(); expect(await readdir(join(directory, "pending"))).toEqual([]);
    await writeFile(join(directory, "sabia-otel-state.json"), JSON.stringify({ deviceId: device, organizationId: "org", endpoint: "https://other.example/api/v1/telemetry/otlp" }));
    await run(event, { fetch, now: 1_000 }); expect(fetch).not.toHaveBeenCalled();
  });
  it("is a no-op without the managed exporter credential", async () => {
    const fetch = vi.fn();
    await writeFile(join(directory, "settings.json"), JSON.stringify({ env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint } }));
    await run(event, { fetch, now: 1_000 });
    expect(fetch).not.toHaveBeenCalled();
    await expect(readdir(join(directory, "pending"))).rejects.toThrow();
  });
});
const TTL = 24 * 60 * 60 * 1000;
