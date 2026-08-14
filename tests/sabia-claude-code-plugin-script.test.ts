import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { approvedHandoff } from "@/plugins/sabia-claude-code-otel/scripts/sabia-http.mjs";

const run = promisify(execFile);
const pluginRoot = join(process.cwd(), "plugins/sabia-claude-code-otel");
const scriptPath = join(pluginRoot, "scripts/sabia.mjs");

const ingestionKey = `sbia_ing_0123456789ab_${"A".repeat(43)}`;
const endpoint = "https://app1.sabiapartners.ca/api/v1/telemetry/otlp";

let workspace: string;
let settingsPath: string;
let statePath: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "sabia-claude-code-"));
  settingsPath = join(workspace, "settings.json");
  statePath = join(workspace, "sabia-otel-state.json");
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function sabia(...args: string[]) {
  return run(process.execPath, [
    scriptPath,
    ...args,
    "--settings",
    settingsPath,
    "--state",
    statePath,
  ]);
}

async function readSettings(): Promise<{
  model?: string;
  env?: Record<string, string>;
}> {
  return JSON.parse(await readFile(settingsPath, "utf8"));
}

describe("Sabia Claude Code plugin production connection", () => {
  it("uses the public canonical domain consistently", async () => {
    const [script, manifestText] = await Promise.all([
      readFile(scriptPath, "utf8"),
      readFile(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as { homepage: string };

    expect(script).toContain(
      'const DEFAULT_BASE_URL = "https://app1.sabiapartners.ca";',
    );
    expect(manifest.homepage).toBe("https://app1.sabiapartners.ca");
  });

  it("handles disconnect redirects the same way as connect", async () => {
    const script = await readFile(scriptPath, "utf8");
    expect(script).toMatch(/method:\s*"DELETE",\s*redirect:\s*"manual"/);
  });

  it("rejects an approval that carries no metrics endpoint", () => {
    // The logs endpoint is the same URL today, so reading the wrong field would
    // pass every test until the two diverge.
    expect(() =>
      approvedHandoff({
        status: "approved",
        organizationId: "org",
        organizationName: "Sabia",
        ingestionKeyId: "key",
        ingestionKey,
        otlpLogsEndpoint: endpoint,
      }),
    ).toThrow("Sabia returned an invalid approval response");
  });
});

describe("Sabia Claude Code plugin settings management", () => {
  it("exports token metrics only, with delta temporality", async () => {
    await sabia("configure", "--endpoint", endpoint, "--ingestion-key", ingestionKey);

    const env = (await readSettings()).env ?? {};
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(env.OTEL_METRICS_EXPORTER).toBe("otlp");
    // Claude Code's log records carry conversational content; the connector's
    // promise is that only token counts leave the machine.
    expect(env.OTEL_LOGS_EXPORTER).toBe("none");
    expect(env.OTEL_TRACES_EXPORTER).toBe("none");
    // Cumulative would restate running totals and be rejected on ingest, which
    // looks like silently missing usage rather than a failure.
    expect(env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE).toBe("delta");
    expect(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe(endpoint);
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe(
      `Authorization=Bearer ${ingestionKey}`,
    );
  });

  it("preserves unrelated settings and restores replaced variables", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        model: "opus",
        env: { EDITOR: "vim", OTEL_LOGS_EXPORTER: "otlp" },
      }),
    );

    await sabia("configure", "--endpoint", endpoint, "--ingestion-key", ingestionKey);

    const connected = await readSettings();
    expect(connected.model).toBe("opus");
    expect(connected.env?.EDITOR).toBe("vim");
    expect(connected.env?.OTEL_LOGS_EXPORTER).toBe("none");

    await sabia("disconnect", "--local-only");

    const restored = await readSettings();
    expect(restored.model).toBe("opus");
    expect(restored.env?.EDITOR).toBe("vim");
    // The user was exporting logs somewhere before Sabia; disconnect gives that
    // back rather than deleting it.
    expect(restored.env?.OTEL_LOGS_EXPORTER).toBe("otlp");
    expect(restored.env?.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
    expect(restored.env?.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
  });

  it("removes an env block that only existed because of Sabia", async () => {
    await sabia("configure", "--endpoint", endpoint, "--ingestion-key", ingestionKey);
    await sabia("disconnect", "--local-only");

    expect(await readSettings()).toEqual({});
  });

  it("does not record its own block as the previous configuration", async () => {
    await sabia("configure", "--endpoint", endpoint, "--ingestion-key", ingestionKey);
    // Rotating a key must not make disconnect restore the revoked exporter.
    await sabia("configure", "--endpoint", endpoint, "--ingestion-key", ingestionKey);
    await sabia("disconnect", "--local-only");

    expect(await readSettings()).toEqual({});
  });

  it("reports status without printing the ingestion key", async () => {
    await sabia(
      "configure",
      "--endpoint",
      endpoint,
      "--ingestion-key",
      ingestionKey,
      "--organization",
      "Sabia Partners",
    );

    const { stdout } = await sabia("status");
    expect(stdout).toContain("Sabia telemetry: connected");
    expect(stdout).toContain("Sabia Partners");
    expect(stdout).not.toContain(ingestionKey);
  });

  it("refuses to rewrite settings it could not parse", async () => {
    const damaged = '{ "model": "opus", }';
    await writeFile(settingsPath, damaged);

    await expect(
      sabia("configure", "--endpoint", endpoint, "--ingestion-key", ingestionKey),
    ).rejects.toThrow(/is not valid JSON/);

    expect(await readFile(settingsPath, "utf8")).toBe(damaged);
  });

  it("rejects a credential that is not a Sabia ingestion key", async () => {
    // Anything else installs a working-looking exporter with no marker, leaving
    // status and disconnect blind to it.
    await expect(
      sabia("configure", "--endpoint", endpoint, "--ingestion-key", "not-a-key"),
    ).rejects.toThrow(/must be a Sabia ingestion key/);
  });
});
