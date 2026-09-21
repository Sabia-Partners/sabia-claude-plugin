import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const scriptPath = join(
  process.cwd(),
  "cowork/scripts/sabia.mjs",
);
const ingestionKey = `sbia_ing_0123456789ab_${"A".repeat(43)}`;

let workspace: string;
let statePath: string;
let server: Server;
let baseUrl: string;
let recordedRequest: {
  authorization?: string;
  body?: unknown;
} | null;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "sabia-cowork-"));
  statePath = join(workspace, "state.json");
  recordedRequest = null;
  server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/api/v1/outputs") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      recordedRequest = {
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          outputReferenceId: "output-reference-1",
          outputId: "output-1",
          artifactId: "artifact-1",
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await writeFile(
    statePath,
    JSON.stringify({
      baseUrl,
      ingestionKey,
      organizationName: "Sabia Partners",
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(workspace, { recursive: true, force: true });
});

function sabia(...args: string[]) {
  return run(process.execPath, [scriptPath, ...args, "--state", statePath]);
}

describe("Sabia Cowork explicit Output reporting", () => {
  it("posts the returned Drive identity against the exact Cowork session", async () => {
    const createdId = "1CreatedDriveArtifactId0123456789abcdefghi";
    const { stdout } = await sabia(
      "record-output",
      "--workflow-run-id",
      "cowork-session-exact-1",
      "--kind",
      "document_create",
      "--external-id",
      createdId,
      "--display-label",
      "appendix.pdf",
      "--url",
      `https://drive.google.com/file/d/${createdId}/view`,
      "--produced-at",
      "2026-09-04T01:45:00.000Z",
    );

    expect(stdout).toContain("Recorded Google Drive document_create");
    expect(stdout).not.toContain(ingestionKey);
    expect(recordedRequest).toEqual({
      authorization: `Bearer ${ingestionKey}`,
      body: {
        workflowRunId: "cowork-session-exact-1",
        kind: "document_create",
        sourceSystem: "google_drive",
        externalId: createdId,
        artifact: { kind: "document", sourceSystem: "google_drive", externalId: createdId },
        displayLabel: "appendix.pdf",
        url: `https://drive.google.com/file/d/${createdId}/view`,
        producedAt: "2026-09-04T01:45:00.000Z",
      },
    });
  });

  it("requires explicit run and artifact identity instead of guessing", async () => {
    await expect(
      sabia("record-output", "--kind", "document_create", "--external-id", "created-id"),
    ).rejects.toThrow(/--workflow-run-id is required/);
    expect(recordedRequest).toBeNull();
  });
});
