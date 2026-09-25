import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const serverPath = join(process.cwd(), "dist/sabia-desktop/server/index.mjs");
const ingestionKey = `sbia_ing_0123456789ab_${"A".repeat(43)}`;

let workspace: string;
let server: Server;
let baseUrl: string;
let child: ChildProcessWithoutNullStreams | null;
let connectRequests: unknown[];
let posts: string[];
let approved: boolean;
let revoked: boolean;

beforeAll(async () => {
  await run(process.execPath, ["scripts/pack-desktop-extension.mjs"]);
});

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "sabia-desktop-"));
  const session = join(workspace, "Claude", "local-agent-mode-sessions", "acct", "org", "local_1");
  await mkdir(session, { recursive: true });
  await writeFile(
    join(session, "audit.jsonl"),
    [
      { type: "assistant", session_id: "cli-1", _audit_timestamp: "2026-09-25T12:00:01Z", message: { id: "msg_1", model: "claude-opus-5", content: [{ type: "text", text: "a private reply" }] } },
      { type: "result", uuid: "res-1", session_id: "cli-1", _audit_timestamp: "2026-09-25T12:00:02Z", modelUsage: { "claude-opus-5": { inputTokens: 10, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } },
    ].map((line) => `${JSON.stringify(line)}\n`).join(""),
  );

  connectRequests = [];
  posts = [];
  approved = false;
  revoked = false;
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const json = (status: number, value: unknown) =>
        response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (request.method === "POST" && request.url === "/api/v1/telemetry/connect") {
        connectRequests.push(JSON.parse(body));
        return json(201, {
          sessionId: "sess-1",
          verificationUri: `${baseUrl}/connect/telemetry/sess-1`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          intervalSeconds: 1,
        });
      }
      if (request.method === "GET" && request.url?.startsWith("/api/v1/telemetry/connect/sess-1")) {
        if (!approved) return response.writeHead(202).end();
        return json(200, {
          status: "approved",
          organizationId: "org-1",
          organizationName: "Sabia Partners",
          ingestionKeyId: "key-1",
          ingestionKey,
          otlpLogsEndpoint: `${baseUrl}/api/v1/telemetry/otlp/v1/logs`,
        });
      }
      if (revoked) return json(401, {});
      if (request.method === "GET" && request.url === "/api/v1/telemetry/connection") {
        return json(200, { rawCapture: false });
      }
      if (request.method === "POST" && request.url === "/api/v1/telemetry/otlp/v1/logs") {
        posts.push(body);
        return json(200, {});
      }
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  child?.kill();
  child = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(workspace, { recursive: true, force: true });
});

function start() {
  child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      SABIA_APP_URL: baseUrl,
      SABIA_SHARE_CONTENT: "false",
      SABIA_NO_BROWSER: "1",
      SABIA_CLAUDE_APP_DATA: join(workspace, "Claude"),
      CLAUDE_CONFIG_DIR: join(workspace, ".claude"),
    },
  });
  const responses = new Map<number, (value: { result?: { content?: Array<{ text: string }>; tools?: Array<{ name: string }> } }) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    responses.get(message.id)?.(message);
  });
  let nextId = 1;
  const request = (method: string, params?: unknown) =>
    new Promise<{ result?: { content?: Array<{ text: string }>; tools?: Array<{ name: string }> } }>((resolve) => {
      const id = nextId++;
      responses.set(id, resolve);
      child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const tool = async (name: string) => (await request("tools/call", { name, arguments: {} })).result!.content![0]!.text;
  return { request, tool };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
}

describe("Sabia Desktop Extension", () => {
  it("speaks MCP and lists its tools", async () => {
    const { request } = start();
    const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result).toMatchObject({ serverInfo: { name: "sabia" }, capabilities: { tools: {} } });
    const list = await request("tools/list");
    expect(list.result!.tools!.map((tool) => tool.name)).toEqual(["sabia_status", "sabia_connect", "sabia_sync_now"]);
  });

  it("connects on first launch, then syncs Cowork usage without being asked", async () => {
    const { tool } = start();
    await until(() => connectRequests.length === 1);
    expect(connectRequests[0]).toMatchObject({ source: "cowork", rawCapture: false });
    expect(await tool("sabia_status")).toContain("Waiting for approval");

    approved = true;
    await until(() => posts.length === 1);
    expect(posts[0]).toContain("api_request");
    expect(posts[0]).not.toContain("private");

    const statePath = join(workspace, ".claude", "sabia-cowork-local-state.json");
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ organizationName: "Sabia Partners", ingestionKey });

    await until(async () => (await tool("sabia_status")).includes("sent 1 events"));
    expect(await tool("sabia_sync_now")).toContain("sent 0 events");
  });

  it("resumes a waiting approval after a restart instead of starting another", async () => {
    start();
    const pendingPath = join(workspace, ".claude", "sabia-desktop-connect.json");
    await until(() => stat(pendingPath).then(() => true, () => false));
    child!.kill();

    const { tool } = start();
    expect(await tool("sabia_status")).toContain("Waiting for approval");
    expect(connectRequests).toHaveLength(1);
  });

  it("reports a revoked connection and stops", async () => {
    const { tool } = start();
    await until(() => connectRequests.length === 1);
    approved = true;
    await until(() => posts.length === 1);

    revoked = true;
    expect(await tool("sabia_sync_now")).toContain("revoked");
  });
});
