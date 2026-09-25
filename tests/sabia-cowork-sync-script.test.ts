import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const scriptPath = join(process.cwd(), "cowork/scripts/sabia.mjs");
const ingestionKey = `sbia_ing_0123456789ab_${"A".repeat(43)}`;

let workspace: string;
let appData: string;
let statePath: string;
let cursorPath: string;
let server: Server;
let baseUrl: string;
let posts: Array<{ authorization?: string; body: { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: unknown[] }> }> } }>;
let grant: { rawCapture: boolean };
let revoked: boolean;

const turn = [
  { type: "user", session_id: "cli-1", _audit_timestamp: "2026-09-25T12:00:00Z", message: { content: "a private prompt" } },
  { type: "assistant", session_id: "cli-1", _audit_timestamp: "2026-09-25T12:00:01Z", message: { id: "msg_1", model: "claude-opus-5", usage: { output_tokens: 1 }, content: [{ type: "text", text: "a private reply" }] } },
  { type: "result", uuid: "res-1", session_id: "cli-1", _audit_timestamp: "2026-09-25T12:00:02Z", modelUsage: { "claude-opus-5": { inputTokens: 10, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } },
];

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "sabia-cowork-sync-"));
  appData = join(workspace, "Claude");
  statePath = join(workspace, "local-state.json");
  cursorPath = join(workspace, "cursor.json");
  posts = [];
  grant = { rawCapture: false };
  revoked = false;

  const session = join(appData, "local-agent-mode-sessions", "acct", "org", "local_1");
  await mkdir(session, { recursive: true });
  await writeFile(join(session, "audit.jsonl"), turn.map((line) => `${JSON.stringify(line)}\n`).join(""));

  server = createServer((request, response) => {
    if (revoked) {
      response.writeHead(401, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (request.method === "GET" && request.url === "/api/v1/telemetry/connection") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(grant));
      return;
    }
    if (request.method === "POST" && request.url === "/api/v1/telemetry/otlp/v1/logs") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        posts.push({
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(workspace, { recursive: true, force: true });
});

async function connectState(content: boolean) {
  await writeFile(
    statePath,
    JSON.stringify({
      baseUrl,
      ingestionKey,
      organizationName: "Sabia Partners",
      otlpLogsEndpoint: `${baseUrl}/api/v1/telemetry/otlp/v1/logs`,
      content,
    }),
  );
}

function sync() {
  return run(process.execPath, [
    scriptPath, "sync",
    "--local-state", statePath,
    "--cursor", cursorPath,
    "--app-data", appData,
  ]);
}

const recordNames = () =>
  posts.flatMap((post) =>
    post.body.resourceLogs[0]!.scopeLogs[0]!.logRecords.map(
      (record) => (record as { body: { stringValue: string } }).body.stringValue,
    ),
  );

describe("cowork sync", () => {
  it("sends usage with the device's key, then nothing when nothing is new", async () => {
    await connectState(false);

    const first = await sync();
    expect(first.stdout).toContain("Sent 1 Cowork events from 1 sessions");
    expect(posts[0]?.authorization).toBe(`Bearer ${ingestionKey}`);
    expect(recordNames()).toEqual(["api_request"]);
    expect(JSON.stringify(posts)).not.toContain("private");

    const cursor = JSON.parse(await readFile(cursorPath, "utf8"));
    expect(Object.values(cursor)[0]).toMatchObject({ offset: expect.any(Number) });

    const second = await sync();
    expect(second.stdout).toContain("Sent 0 Cowork events");
    expect(posts).toHaveLength(1);
  });

  it("withholds content that was asked for until Sabia records the grant", async () => {
    await connectState(true);
    await sync();
    expect(JSON.stringify(posts)).not.toContain("private");
  });

  it("sends content once the grant is approved", async () => {
    await connectState(true);
    grant = { rawCapture: true };

    const result = await sync();
    expect(result.stdout).toContain("(with content)");
    expect(recordNames()).toEqual(["user_prompt", "assistant_response", "api_request"]);
    expect(JSON.stringify(posts)).toContain("a private prompt");
  });

  it("stops and keeps its place when the key is revoked", async () => {
    await connectState(false);
    revoked = true;

    await expect(sync()).rejects.toMatchObject({
      stderr: expect.stringContaining("revoked"),
    });
    await expect(readFile(cursorPath, "utf8")).rejects.toThrow();
  });

  it("refuses to sync a device that was never connected", async () => {
    await expect(sync()).rejects.toMatchObject({
      stderr: expect.stringContaining("connect --local"),
    });
  });
});
