import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCoworkLogsPayload,
  findSessionAudits,
  readSessionEvents,
} from "../cowork/scripts/cowork-local.mjs";

// The shape of Cowork's local audit log, reduced to the fields read. A message
// is written once per content block, and each line's `usage` is the snapshot
// taken as the response started streaming — deliberately tiny here, so a test
// fails if it is ever summed instead of the turn's `modelUsage`.
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 25, 12, 0, seconds)).toISOString();
const snapshot = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

const lines = {
  prompt: { type: "user", session_id: "cli-1", _audit_timestamp: at(0), message: { role: "user", content: "Update the Q3 forecast sheet" } },
  opusText: { type: "assistant", session_id: "cli-1", _audit_timestamp: at(1), message: { id: "msg_1", model: "claude-opus-5", usage: snapshot, content: [{ type: "text", text: "I'll update it." }] } },
  opusTool: { type: "assistant", session_id: "cli-1", _audit_timestamp: at(2), message: { id: "msg_1", model: "claude-opus-5", usage: snapshot, content: [{ type: "tool_use", id: "tu_1", name: "mcp__drive__update_file", input: { fileId: "1AbC", values: [["42"]] } }] } },
  subagent: { type: "assistant", session_id: "cli-1", parent_tool_use_id: "tu_0", _audit_timestamp: at(3), message: { id: "msg_2", model: "claude-haiku-4-5", usage: snapshot, content: [{ type: "text", text: "sub" }] } },
  toolResult: { type: "user", session_id: "cli-1", _audit_timestamp: at(4), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "{\"id\":\"1AbC\"}" }] }] } },
  opusAgain: { type: "assistant", session_id: "cli-1", _audit_timestamp: at(5), message: { id: "msg_3", model: "claude-opus-5", usage: snapshot, content: [{ type: "text", text: "Done." }] } },
  result: {
    type: "result", uuid: "res-1", session_id: "cli-1", _audit_timestamp: at(6),
    usage: { output_tokens: 1 },
    modelUsage: {
      "claude-opus-5": { inputTokens: 120, outputTokens: 900, cacheReadInputTokens: 5000, cacheCreationInputTokens: 300 },
      "claude-haiku-4-5": { inputTokens: 40, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    },
  },
};

let appData: string;
let auditPath: string;

beforeEach(async () => {
  appData = await mkdtemp(join(tmpdir(), "sabia-cowork-local-"));
  const session = join(appData, "local-agent-mode-sessions", "account", "org", "local_abc");
  await mkdir(session, { recursive: true });
  auditPath = join(session, "audit.jsonl");
});

afterEach(async () => {
  await rm(appData, { recursive: true, force: true });
});

async function write(entries: object[]) {
  await writeFile(auditPath, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
}

describe("findSessionAudits", () => {
  it("finds every Cowork session with an audit log", async () => {
    await write([lines.prompt]);
    await mkdir(join(appData, "local-agent-mode-sessions", "account", "org", "local_empty"));

    const audits = await findSessionAudits(appData);
    expect(audits.map((audit) => audit.sessionKey)).toEqual(["local_abc"]);
  });
});

describe("readSessionEvents", () => {
  it("reports a turn's per-model totals, never the streaming snapshots", async () => {
    await write(Object.values(lines));

    const { events } = await readSessionEvents(auditPath);
    const usage = events.filter((event) => event.name === "api_request");

    expect(usage).toEqual([
      expect.objectContaining({
        sequence: "res-1:claude-opus-5",
        attributes: { model: "claude-opus-5", input_tokens: 120, output_tokens: 900, cache_read_tokens: 5000, cache_creation_tokens: 300, request_count: 2 },
      }),
      expect.objectContaining({
        sequence: "res-1:claude-haiku-4-5",
        attributes: expect.objectContaining({ output_tokens: 10, request_count: 1 }),
      }),
    ]);
  });

  it("sends no content unless asked", async () => {
    await write(Object.values(lines));

    const { events } = await readSessionEvents(auditPath);
    const payload = JSON.stringify(buildCoworkLogsPayload(events, { sessionKey: "local_abc" }));

    expect(events.map((event) => event.name)).toEqual(["tool_result", "api_request", "api_request"]);
    expect(payload).not.toContain("Q3 forecast");
    expect(payload).not.toContain("I'll update it");
    expect(payload).not.toContain("1AbC");
    expect(payload).toContain("mcp_server_name");
  });

  it("includes prompts, responses and tool details when content is granted", async () => {
    await write(Object.values(lines));

    const { events } = await readSessionEvents(auditPath, undefined, { content: true });
    const byName = (name: string) => events.filter((event) => event.name === name);

    expect(byName("user_prompt")[0]?.attributes.prompt).toBe("Update the Q3 forecast sheet");
    // Text from the message's first line and from a later message both count.
    expect(byName("assistant_response").map((event) => event.attributes.response)).toEqual([
      "I'll update it.",
      "sub",
      "Done.",
    ]);
    expect(byName("tool_result")[0]?.attributes).toMatchObject({
      tool_name: "mcp__drive__update_file",
      success: "true",
      tool_input: JSON.stringify({ fileId: "1AbC", values: [["42"]] }),
      tool_result: "{\"id\":\"1AbC\"}",
      tool_parameters: JSON.stringify({ mcp_server_name: "drive", mcp_tool_name: "update_file" }),
    });
  });

  it("resumes where it stopped, counting a turn split across runs once", async () => {
    await write([lines.prompt, lines.opusText, lines.opusTool]);
    const first = await readSessionEvents(auditPath);
    expect(first.events.filter((event) => event.name === "api_request")).toEqual([]);

    await appendFile(
      auditPath,
      [lines.opusTool, lines.subagent, lines.toolResult, lines.opusAgain, lines.result]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
    );
    const second = await readSessionEvents(auditPath, first.cursor);
    const opus = second.events.find((event) => event.sequence === "res-1:claude-opus-5");
    expect(opus?.attributes.request_count).toBe(2);

    const third = await readSessionEvents(auditPath, second.cursor);
    expect(third.events).toEqual([]);
  });

  it("leaves a line that is still being written for the next run", async () => {
    await writeFile(auditPath, `${JSON.stringify(lines.opusText)}\n${JSON.stringify(lines.result).slice(0, 40)}`);
    const { events, cursor } = await readSessionEvents(auditPath);

    expect(events).toEqual([]);
    expect(cursor.offset).toBe(Buffer.byteLength(`${JSON.stringify(lines.opusText)}\n`));
  });

  it("ignores lines it does not recognise", async () => {
    await writeFile(auditPath, `not json\n${JSON.stringify({ type: "result", uuid: "x", _audit_timestamp: "never" })}\n${JSON.stringify({ type: "rate_limit_event", _audit_timestamp: at(1) })}\n`);
    expect((await readSessionEvents(auditPath)).events).toEqual([]);
  });
});

describe("buildCoworkLogsPayload", () => {
  it("shapes events as Cowork's exporter does", async () => {
    await write(Object.values(lines));
    const { events } = await readSessionEvents(auditPath);
    const payload = buildCoworkLogsPayload(events, { sessionKey: "local_abc" });
    const record = payload.resourceLogs[0]!.scopeLogs[0]!.logRecords.find(
      (log) => log.body.stringValue === "api_request",
    )!;
    const attributes = Object.fromEntries(
      record.attributes.map((attribute) => [attribute.key, attribute.value.stringValue ?? attribute.value.intValue]),
    );

    expect(payload.resourceLogs[0]!.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "cowork" } });
    expect(record.timeUnixNano).toBe(`${Date.parse(at(6))}000000`);
    expect(attributes).toMatchObject({
      "event.name": "api_request",
      "session.id": "cli-1",
      "event.sequence": "res-1:claude-opus-5",
      model: "claude-opus-5",
      output_tokens: "900",
      request_count: "2",
    });
  });
});
