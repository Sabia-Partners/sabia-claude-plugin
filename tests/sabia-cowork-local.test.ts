import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCoworkLogsPayload,
  findSessionAudits,
  readSessionEvents,
  syncCoworkUsage,
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

// A session's turns as Claude Code records them. `modelUsage` holds totals per
// model (subagents included) and `usage` the main thread's own share of this
// turn. From Claude Code 2.1.288 a resumed turn starts from the previous
// turn's totals, so `modelUsage` carries them over while `usage` does not.
type Counts = [input: number, output: number, cacheRead: number, cacheCreation: number];
const opus = "claude-opus-5";
const haiku = "claude-haiku-4-5";
const init = (session = "cli-1", { model = opus, version = "2.1.288" } = {}) => ({
  type: "system", subtype: "init", session_id: session, model, claude_code_version: version, _audit_timestamp: at(0),
});
function turn(
  uuid: string,
  second: number,
  totals: Record<string, Counts>,
  own: Counts,
  { session = "cli-1" } = {},
) {
  return {
    type: "result", uuid, session_id: session, _audit_timestamp: at(second),
    usage: { input_tokens: own[0], output_tokens: own[1], cache_read_input_tokens: own[2], cache_creation_input_tokens: own[3] },
    modelUsage: Object.fromEntries(
      Object.entries(totals).map(([model, [input, output, cacheRead, cacheCreation]]) => [
        model,
        { inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation, costUSD: 0.5 },
      ]),
    ),
  };
}

function sent(events: Array<{ name: string; sequence: string; attributes: Record<string, unknown> }>) {
  return events
    .filter((event) => event.name === "api_request")
    .map((event) => ({
      sequence: event.sequence,
      tokens: [
        event.attributes.input_tokens,
        event.attributes.output_tokens,
        event.attributes.cache_read_tokens,
        event.attributes.cache_creation_tokens,
      ],
    }));
}

describe("turns that carry the previous totals over", () => {
  it("sends 100 then 200 as 100 and 100", async () => {
    await write([
      init(),
      turn("r1", 1, { [opus]: [10, 100, 1000, 50] }, [10, 100, 1000, 50]),
      init(),
      turn("r2", 2, { [opus]: [20, 200, 2000, 100] }, [10, 100, 1000, 50]),
    ]);

    expect(sent((await readSessionEvents(auditPath)).events)).toEqual([
      { sequence: `r1:${opus}`, tokens: [10, 100, 1000, 50] },
      { sequence: `r2:${opus}`, tokens: [10, 100, 1000, 50] },
    ]);
  });

  it("sends a model whose carried totals did not move as nothing, and a new model whole", async () => {
    await write([
      init(),
      turn("r1", 1, { [opus]: [10, 100, 1000, 50], [haiku]: [400, 40, 0, 0] }, [10, 100, 1000, 50]),
      turn("r2", 2, { [opus]: [12, 150, 1500, 60], [haiku]: [400, 40, 0, 0] }, [2, 50, 500, 10]),
      turn("r3", 3, { [opus]: [14, 170, 1900, 70], [haiku]: [400, 40, 0, 0], "claude-sonnet-5": [7, 3, 0, 0] }, [2, 20, 400, 10]),
    ]);

    expect(sent((await readSessionEvents(auditPath)).events)).toEqual([
      { sequence: `r1:${opus}`, tokens: [10, 100, 1000, 50] },
      { sequence: `r1:${haiku}`, tokens: [400, 40, 0, 0] },
      { sequence: `r2:${opus}`, tokens: [2, 50, 500, 10] },
      { sequence: `r3:${opus}`, tokens: [2, 20, 400, 10] },
      { sequence: "r3:claude-sonnet-5", tokens: [7, 3, 0, 0] },
    ]);
  });

  it("sends each turn whole when the totals are that turn's own, even if they happen to grow", async () => {
    // Claude Code before 2.1.288: every result is a fresh count.
    await write([
      init(),
      turn("r1", 1, { [opus]: [10, 100, 1000, 50] }, [10, 100, 1000, 50]),
      turn("r2", 2, { [opus]: [30, 900, 9000, 600] }, [30, 900, 9000, 600]),
    ]);

    expect(sent((await readSessionEvents(auditPath)).events).map((event) => event.tokens)).toEqual([
      [10, 100, 1000, 50],
      [30, 900, 9000, 600],
    ]);
  });

  it("starts over after a reset and never sends a negative count", async () => {
    await write([
      init(),
      turn("r1", 1, { [opus]: [10, 100, 1000, 50] }, [10, 100, 1000, 50]),
      turn("r2", 2, { [opus]: [20, 200, 2000, 100] }, [10, 100, 1000, 50]),
      // A new process that did not restore the totals.
      turn("r3", 3, { [opus]: [5, 60, 700, 20] }, [5, 60, 700, 20]),
      // Totals that went down in one class cannot be carried over.
      turn("r4", 4, { [opus]: [9, 70, 650, 30] }, [4, 10, 1, 10]),
    ]);

    const tokens = sent((await readSessionEvents(auditPath)).events).map((event) => event.tokens);
    expect(tokens).toEqual([
      [10, 100, 1000, 50],
      [10, 100, 1000, 50],
      [5, 60, 700, 20],
      [9, 70, 650, 30],
    ]);
    expect(tokens.flat().every((value) => (value as number) >= 0)).toBe(true);
  });

  it("counts a subagent on the main model once when a resumed turn carries the totals over", async () => {
    // The main model grew by more than its own share: a subagent used it too,
    // so only the Claude Code version can say whether the totals carried over.
    await write([
      init(),
      turn("r1", 1, { [opus]: [10, 100, 1000, 50] }, [10, 100, 1000, 50]),
      init(),
      turn("r2", 2, { [opus]: [18, 250, 1700, 120] }, [5, 100, 500, 50]),
      init(),
      turn("r3", 3, { [opus]: [33, 550, 3200, 320] }, [5, 100, 500, 50]),
    ]);

    expect(sent((await readSessionEvents(auditPath)).events).map((event) => event.tokens)).toEqual([
      [10, 100, 1000, 50],
      [8, 150, 700, 70],
      [15, 300, 1500, 200],
    ]);
  });

  it("sends that same shape whole on a Claude Code version that does not restore totals", async () => {
    await write([
      init("cli-1", { version: "2.1.237" }),
      turn("r1", 1, { [opus]: [10, 100, 1000, 50] }, [10, 100, 1000, 50]),
      turn("r2", 2, { [opus]: [25, 400, 2500, 250] }, [5, 100, 500, 50]),
    ]);

    expect(sent((await readSessionEvents(auditPath)).events).at(-1)!.tokens).toEqual([25, 400, 2500, 250]);
  });

  it("recognises a carried turn by a model it did not use, even when the main model changed", async () => {
    await write([
      init("cli-1", { version: "2.1.237" }),
      turn("r1", 1, { [opus]: [10, 100, 1000, 50] }, [10, 100, 1000, 50]),
      init("cli-1", { model: "claude-sonnet-5", version: "2.1.237" }),
      turn("r2", 2, { [opus]: [10, 100, 1000, 50], "claude-sonnet-5": [4, 40, 400, 20] }, [4, 40, 400, 20]),
    ]);

    expect(sent((await readSessionEvents(auditPath)).events)).toEqual([
      { sequence: `r1:${opus}`, tokens: [10, 100, 1000, 50] },
      { sequence: "r2:claude-sonnet-5", tokens: [4, 40, 400, 20] },
    ]);
  });

  it("keeps a separate baseline per session in one log", async () => {
    await write([
      init("a"),
      turn("a1", 1, { [opus]: [10, 100, 1000, 50] }, [10, 100, 1000, 50], { session: "a" }),
      init("b"),
      turn("b1", 2, { [opus]: [1, 10, 100, 5] }, [1, 10, 100, 5], { session: "b" }),
      turn("a2", 3, { [opus]: [20, 200, 2000, 100] }, [10, 100, 1000, 50], { session: "a" }),
    ]);

    expect(sent((await readSessionEvents(auditPath)).events).map((event) => event.tokens)).toEqual([
      [10, 100, 1000, 50],
      [1, 10, 100, 5],
      [10, 100, 1000, 50],
    ]);
  });

  it("carries the baseline across runs and rebuilds it for a cursor saved without one", async () => {
    const first = [init(), turn("r1", 1, { [opus]: [10, 100, 1000, 50] }, [10, 100, 1000, 50])];
    const later = [init(), turn("r2", 2, { [opus]: [20, 200, 2000, 100] }, [10, 100, 1000, 50])];
    await write(first);
    const run1 = await readSessionEvents(auditPath);
    await appendFile(auditPath, later.map((entry) => `${JSON.stringify(entry)}\n`).join(""));

    const resumed = await readSessionEvents(auditPath, run1.cursor);
    const { usage: _usage, ...savedBeforeThisFix } = run1.cursor;
    const upgraded = await readSessionEvents(auditPath, savedBeforeThisFix);

    expect(sent(resumed.events)).toEqual([{ sequence: `r2:${opus}`, tokens: [10, 100, 1000, 50] }]);
    expect(upgraded.events).toEqual(resumed.events);
    expect(upgraded.cursor).toEqual(resumed.cursor);
  });

  it("sends a turn seen for the first time whole, and an already-seen result never again", async () => {
    await write([init(), turn("r2", 2, { [opus]: [20, 200, 2000, 100] }, [10, 100, 1000, 50])]);
    const once = await readSessionEvents(auditPath);
    expect(sent(once.events).map((event) => event.tokens)).toEqual([[20, 200, 2000, 100]]);

    // The same result written again (a replayed line) adds nothing and moves no baseline.
    await appendFile(auditPath, `${JSON.stringify(turn("r2", 2, { [opus]: [20, 200, 2000, 100] }, [10, 100, 1000, 50]))}\n`);
    const replay = await readSessionEvents(auditPath, once.cursor);
    expect(replay.events).toEqual([]);
    expect(replay.cursor.usage).toEqual(once.cursor.usage);
  });

  it("does not let a replayed result move the baseline after its id left the recent ids", async () => {
    const r1 = turn("r1", 1, { [opus]: [10, 100, 1000, 50] }, [10, 100, 1000, 50]);
    await write([init(), r1, turn("r2", 2, { [opus]: [20, 200, 2000, 100] }, [10, 100, 1000, 50])]);
    const first = await readSessionEvents(auditPath);
    // Hundreds of later messages push both result ids out of the recent ids.
    const forgotten = { ...first.cursor, recentMessageIds: [] };

    await appendFile(
      auditPath,
      [r1, turn("r3", 3, { [opus]: [25, 300, 2500, 150] }, [5, 100, 500, 50])].map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    );
    const next = await readSessionEvents(auditPath, forgotten);

    expect(sent(next.events)).toEqual([{ sequence: `r3:${opus}`, tokens: [5, 100, 500, 50] }]);
  });
});

describe("syncCoworkUsage", () => {
  const state = { baseUrl: "https://sabia.test", ingestionKey: "sbia_ing_test" };
  const tokensPosted = (bodies: string[]) =>
    bodies.flatMap((body) =>
      JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords.map((record: { attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }> }) => {
        const attributes = Object.fromEntries(record.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.intValue]));
        return `${attributes["event.sequence"]}=${attributes.output_tokens}`;
      }),
    );

  it("resends the same differences after a failed delivery and nothing after a successful one", async () => {
    await write([
      init(),
      turn("r1", 1, { [opus]: [10, 100, 1000, 50] }, [10, 100, 1000, 50]),
      turn("r2", 2, { [opus]: [20, 200, 2000, 100] }, [10, 100, 1000, 50]),
    ]);
    const cursorPath = join(appData, "cursor.json");
    const bodies: string[] = [];
    let failNext = true;
    const fetchImpl = async (url: URL | string, init?: { method?: string; body?: string }) => {
      if (init?.method !== "POST") return new Response(JSON.stringify({ rawCapture: false }), { status: 200 });
      bodies.push(init.body!);
      if (failNext) {
        failNext = false;
        return new Response("{}", { status: 503 });
      }
      return new Response("{}", { status: 200 });
    };

    const failed = await syncCoworkUsage({ state, cursorPath, appDataDirectory: appData, fetchImpl });
    const retried = await syncCoworkUsage({ state, cursorPath, appDataDirectory: appData, fetchImpl });
    const idle = await syncCoworkUsage({ state, cursorPath, appDataDirectory: appData, fetchImpl });

    expect(failed.status).toBe("unreachable");
    expect(retried).toMatchObject({ status: "synced", sent: 2 });
    expect(idle).toMatchObject({ status: "synced", sent: 0 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(tokensPosted(bodies.slice(1))).toEqual([`r1:${opus}=100`, `r2:${opus}=100`]);
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
