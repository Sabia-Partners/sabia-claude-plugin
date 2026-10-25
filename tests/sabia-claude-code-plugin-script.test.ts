import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { approvedHandoff } from "../scripts/sabia-http.mjs";

const run = promisify(execFile);
const pluginRoot = process.cwd();
const scriptPath = join(pluginRoot, "scripts/sabia.mjs");

const ingestionKey = `sbia_ing_0123456789ab_${"A".repeat(43)}`;
const endpoint = "https://app2.sabiapartners.ca/api/v1/telemetry/otlp";

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

// The suite can itself run inside a Claude Code cloud session, which sets
// these; each test says which kind of session it runs the script in.
const { CLAUDE_CODE_REMOTE: _remote, CLAUDE_CODE_ENABLE_TELEMETRY: _telemetry, ...localEnv } = process.env;

function sabia(...args: string[]) {
  return sabiaIn(localEnv, ...args);
}

function sabiaIn(env: NodeJS.ProcessEnv, ...args: string[]) {
  return run(
    process.execPath,
    [scriptPath, ...args, "--settings", settingsPath, "--state", statePath],
    { env },
  );
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
      'const DEFAULT_BASE_URL = "https://app2.sabiapartners.ca";',
    );
    expect(manifest.homepage).toBe("https://sabiapartners.ca");
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

  it("accepts an approval without a logs endpoint: it never configures a logs exporter", () => {
    expect(() =>
      approvedHandoff({
        status: "approved",
        organizationId: "org",
        organizationName: "Sabia",
        ingestionKeyId: "key",
        ingestionKey,
        otlpMetricsEndpoint: endpoint,
      }),
    ).not.toThrow();
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

  it("does not snapshot its own block when the state file is lost", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({ env: { OTEL_LOGS_EXPORTER: "otlp" } }),
    );
    await sabia("configure", "--endpoint", endpoint, "--ingestion-key", ingestionKey);

    // The state file is the only record of what the user had; losing it must
    // not turn Sabia's own values into "what was there before".
    await rm(statePath);
    await sabia("configure", "--endpoint", endpoint, "--ingestion-key", ingestionKey);
    await sabia("disconnect", "--local-only");

    const restored = await readSettings();
    // Without the ownership check this restores Sabia's revoked exporter.
    expect(restored.env?.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
    expect(restored.env?.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBeUndefined();
    expect(restored.env?.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
    // The user's own value is genuinely unrecoverable once that state is gone,
    // so it is dropped rather than replaced with a wrong guess.
    expect(restored.env?.OTEL_LOGS_EXPORTER).toBeUndefined();
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

  it("refuses --raw-capture and writes nothing", async () => {
    const failure = await sabia(
      "configure",
      "--endpoint",
      endpoint,
      "--ingestion-key",
      ingestionKey,
      "--raw-capture",
    ).then(
      () => null,
      (error: { code: number; stderr: string }) => error,
    );

    expect(failure?.code).toBe(1);
    expect(failure?.stderr).toContain("never exports prompt text");
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow("ENOENT");
    await expect(readFile(statePath, "utf8")).rejects.toThrow("ENOENT");
  });

  it("adds the trace exporter and its gates only for the tool-output grant", async () => {
    await sabia(
      "configure",
      "--endpoint",
      endpoint,
      "--ingestion-key",
      ingestionKey,
      "--tool-output",
    );

    const env = (await readSettings()).env ?? {};
    expect(env.OTEL_TRACES_EXPORTER).toBe("otlp");
    expect(env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBe("1");
    expect(env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL).toBe("http/json");
    expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(
      new URL("/api/v1/telemetry/traces", endpoint).toString(),
    );
    expect(env.OTEL_LOG_TOOL_CONTENT).toBe("1");
    // The command line is gated by tool details, and without it the
    // fail-closed shell-evidence gate identifies nothing (SAB-100).
    expect(env.OTEL_LOG_TOOL_DETAILS).toBe("1");
    // Tool events, connector arguments and skill names ride the log records.
    expect(env.OTEL_LOGS_EXPORTER).toBe("otlp");
    expect(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL).toBe("http/json");
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(endpoint);
    // Claude Code redacts prompt text unless this is set, and the plugin
    // never sets it; responses and raw bodies stay off too.
    expect(env.OTEL_LOG_USER_PROMPTS).toBeUndefined();
    expect(env.OTEL_LOG_ASSISTANT_RESPONSES).toBeUndefined();
    expect(env.OTEL_LOG_RAW_API_BODIES).toBeUndefined();
  });

  it("clears the trace exporter when reconnecting without tool output", async () => {
    await sabia(
      "configure",
      "--endpoint",
      endpoint,
      "--ingestion-key",
      ingestionKey,
      "--tool-output",
    );
    await sabia("configure", "--endpoint", endpoint, "--ingestion-key", ingestionKey);

    const env = (await readSettings()).env ?? {};
    expect(env.OTEL_TRACES_EXPORTER).toBe("none");
    expect(env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBeUndefined();
    expect(env.OTEL_LOG_TOOL_CONTENT).toBeUndefined();
    expect(env.OTEL_LOG_TOOL_DETAILS).toBeUndefined();
  });

  it("turns the log export off without tool output and leaves the prompt setting alone", async () => {
    await configureWithExporters({ logs: "otlp", traces: "none" }, {
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
      OTEL_LOG_USER_PROMPTS: "1",
      OTEL_LOG_TOOL_DETAILS: "1",
    });
    await sabia("configure", "--endpoint", endpoint, "--ingestion-key", ingestionKey);

    const env = (await readSettings()).env ?? {};
    expect(env.OTEL_LOGS_EXPORTER).toBe("none");
    expect(env.OTEL_LOG_TOOL_DETAILS).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL).toBeUndefined();
    // The person's own choice: the plugin never writes, clears or restores it.
    expect(env.OTEL_LOG_USER_PROMPTS).toBe("1");
  });

  it("leaves the user's own prompt-logging value through connect and disconnect", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({ env: { OTEL_LOG_USER_PROMPTS: "0" } }),
    );

    await sabia("configure", "--endpoint", endpoint, "--ingestion-key", ingestionKey);
    await sabia("disconnect", "--local-only");

    expect((await readSettings()).env?.OTEL_LOG_USER_PROMPTS).toBe("0");
  });

  /**
   * Sets the exporters by hand: `logs: "otlp"` is how a device an earlier
   * version configured for prompt export looks.
   */
  async function configureWithExporters(
    exporters: { logs: "otlp" | "none"; traces: "otlp" | "none" },
    extra: Record<string, string> = {},
  ) {
    await sabia("configure", "--endpoint", endpoint, "--ingestion-key", ingestionKey);
    const settings = await readSettings();
    await writeFile(
      settingsPath,
      JSON.stringify({
        ...settings,
        env: {
          ...settings.env,
          OTEL_LOGS_EXPORTER: exporters.logs,
          OTEL_TRACES_EXPORTER: exporters.traces,
          ...extra,
        },
      }),
    );
  }

  it("tells a trace-only connection that tool result bodies are exported", async () => {
    await configureWithExporters({ logs: "none", traces: "otlp" });

    const { stdout } = await sabia("status");

    expect(stdout).toMatch(/tool result bodies, tool events with their arguments and skill names, and token counts are exported/i);
    // The regression: a trace-only connection used to be told the opposite.
    expect(stdout).not.toMatch(/only token counts are exported/i);
    expect(stdout).not.toMatch(/tool content are not/i);
    // Prompt text genuinely is not exported by this grant.
    expect(stdout).toMatch(/prompt text and assistant responses are not exported by this plugin/i);
  });

  it("says when the person's own setting adds prompt text", async () => {
    await configureWithExporters({ logs: "otlp", traces: "otlp" }, { OTEL_LOG_USER_PROMPTS: "1" });

    const { stdout } = await sabia("status");

    expect(stdout).toContain("Prompt text is also exported, because OTEL_LOG_USER_PROMPTS is set");
  });

  it("still reports a metrics-only connection as token counts alone", async () => {
    await configureWithExporters({ logs: "none", traces: "none" });

    const { stdout } = await sabia("status");

    expect(stdout).toMatch(/only token counts are exported/i);
  });

  describe("sync", () => {
    let server: Server;
    let serverEndpoint: string;
    let grants:
      | { rawCapture: boolean; traceCapture: boolean }
      | "revoked"
      | "unavailable";
    let grantReads: number;

    beforeEach(async () => {
      grants = { rawCapture: false, traceCapture: false };
      grantReads = 0;
      server = createServer((request, response) => {
        if (request.url === "/api/v1/telemetry/connection") {
          grantReads += 1;
          if (grants === "revoked") {
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "revoked" } }));
            return;
          }
          if (grants === "unavailable") {
            response.writeHead(503, { "content-type": "application/json" });
            response.end(
              JSON.stringify({ error: { code: "UNAVAILABLE", message: "try later" } }),
            );
            return;
          }
          if (request.headers.authorization !== `Bearer ${ingestionKey}`) {
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "bad key" } }));
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              source: "claude_code",
              ...grants,
              otlpMetricsEndpoint: `${serverEndpoint}/api/v1/telemetry/otlp`,
              otlpLogsEndpoint: `${serverEndpoint}/api/v1/telemetry/otlp`,
              tracesEndpoint: `${serverEndpoint}/api/v1/telemetry/traces`,
            }),
          );
          return;
        }
        response.writeHead(404);
        response.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      serverEndpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });

    it("holds a grant widened in the app until this device approves it", async () => {
      await sabia(
        "configure",
        "--endpoint",
        `${serverEndpoint}/api/v1/telemetry/otlp`,
        "--ingestion-key",
        ingestionKey,
      );
      const before = JSON.stringify(await readSettings());
      grants = { rawCapture: false, traceCapture: true };

      // --quiet does not silence it: nothing else tells the user.
      const { stdout } = await sabia("sync", "--quiet");

      expect(stdout).toContain("asked to widen what this device shares");
      expect(stdout).toMatch(/Tool result bodies/);
      expect(stdout).toContain("approve");
      expect(JSON.stringify(await readSettings())).toBe(before);
      expect(JSON.parse(await readFile(statePath, "utf8")).pendingCapture).toEqual({
        traceCapture: true,
      });
      expect((await sabia("status")).stdout).toContain("Waiting for your approval: tool output");
    });

    it("applies a widened grant once this device approves it", async () => {
      await sabia(
        "configure",
        "--endpoint",
        `${serverEndpoint}/api/v1/telemetry/otlp`,
        "--ingestion-key",
        ingestionKey,
      );
      grants = { rawCapture: false, traceCapture: true };
      await sabia("sync", "--quiet");

      const { stdout } = await sabia("approve");

      expect(stdout).toContain("Approved.");
      const env = (await readSettings()).env ?? {};
      expect(env.OTEL_TRACES_EXPORTER).toBe("otlp");
      expect(env.OTEL_LOG_TOOL_CONTENT).toBe("1");
      expect(env.OTEL_LOG_TOOL_DETAILS).toBe("1");
      expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(
        `${serverEndpoint}/api/v1/telemetry/traces`,
      );
      // The key is untouched: approval changes configuration, never credentials.
      expect(env.OTEL_EXPORTER_OTLP_HEADERS).toContain(ingestionKey);
      expect(JSON.parse(await readFile(statePath, "utf8")).pendingCapture).toBeUndefined();
      expect((await sabia("sync", "--quiet")).stdout).toBe("");
    });

    it("cannot approve a request withdrawn in the app", async () => {
      await sabia(
        "configure",
        "--endpoint",
        `${serverEndpoint}/api/v1/telemetry/otlp`,
        "--ingestion-key",
        ingestionKey,
      );
      grants = { rawCapture: false, traceCapture: true };
      await sabia("sync", "--quiet");
      grants = { rawCapture: false, traceCapture: false };
      const before = JSON.stringify(await readSettings());

      const { stdout } = await sabia("approve");

      expect(stdout).toContain("Nothing is waiting for approval");
      expect(JSON.stringify(await readSettings())).toBe(before);
      expect(JSON.parse(await readFile(statePath, "utf8")).pendingCapture).toBeUndefined();
    });

    it("never applies or announces a raw-capture grant", async () => {
      await sabia(
        "configure",
        "--endpoint",
        `${serverEndpoint}/api/v1/telemetry/otlp`,
        "--ingestion-key",
        ingestionKey,
      );
      const before = JSON.stringify(await readSettings());
      grants = { rawCapture: true, traceCapture: false };

      const sync = await sabia("sync", "--quiet");
      const approve = await sabia("approve");

      expect(sync.stdout).toBe("");
      expect(approve.stdout).toContain("Nothing is waiting for approval");
      expect(JSON.stringify(await readSettings())).toBe(before);
      expect(JSON.parse(await readFile(statePath, "utf8")).pendingCapture).toBeUndefined();
    });

    it("turns off a log export left on without the tool-output grant", async () => {
      await configureWithExporters({ logs: "otlp", traces: "none" }, {
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${serverEndpoint}/api/v1/telemetry/otlp`,
        OTEL_LOG_USER_PROMPTS: "1",
      });
      grants = { rawCapture: true, traceCapture: false };

      const { stdout } = await sabia("sync", "--quiet");

      const env = (await readSettings()).env ?? {};
      expect(env.OTEL_LOGS_EXPORTER).toBe("none");
      expect(env.OTEL_LOG_USER_PROMPTS).toBe("1");
      expect(env.OTEL_METRICS_EXPORTER).toBe("otlp");
      expect(stdout).toContain("updated this device's capture");
    });

    it("asks before adding the log export to a tool-output device set up before 0.6.1", async () => {
      await configureWithExporters({ logs: "none", traces: "otlp" }, {
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${serverEndpoint}/api/v1/telemetry/otlp`,
      });
      grants = { rawCapture: false, traceCapture: true };
      const before = JSON.stringify(await readSettings());

      const { stdout } = await sabia("sync", "--quiet");

      expect(stdout).toContain("asks before exporting them");
      expect(JSON.stringify(await readSettings())).toBe(before);

      await sabia("approve");
      const env = (await readSettings()).env ?? {};
      expect(env.OTEL_LOGS_EXPORTER).toBe("otlp");
      expect(env.OTEL_TRACES_EXPORTER).toBe("otlp");
      expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(`${serverEndpoint}/api/v1/telemetry/otlp`);
    });

    /** Settings and state as plugin 0.5.0 left them under raw capture and tool output. */
    async function legacyRawDevice(previousPrompts: string | null) {
      await configureWithExporters({ logs: "otlp", traces: "otlp" }, {
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${serverEndpoint}/api/v1/telemetry/otlp`,
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${serverEndpoint}/api/v1/telemetry/otlp`,
        OTEL_LOG_USER_PROMPTS: "1",
      });
      const state = JSON.parse(await readFile(statePath, "utf8"));
      state.previousEnv = { ...state.previousEnv, OTEL_LOG_USER_PROMPTS: previousPrompts };
      await writeFile(statePath, JSON.stringify(state));
    }

    it("hands back the prompt setting a 0.5.0 device's plugin wrote, once", async () => {
      await legacyRawDevice(null);
      grants = { rawCapture: true, traceCapture: true };

      const first = await sabia("sync", "--quiet");
      expect(first.stdout).toContain("no longer manages OTEL_LOG_USER_PROMPTS");
      expect((await readSettings()).env?.OTEL_LOG_USER_PROMPTS).toBeUndefined();
      expect(JSON.parse(await readFile(statePath, "utf8")).previousEnv).not.toHaveProperty("OTEL_LOG_USER_PROMPTS");

      // From now on it is the person's own: set again, it stays.
      const settings = await readSettings();
      await writeFile(settingsPath, JSON.stringify({ ...settings, env: { ...settings.env, OTEL_LOG_USER_PROMPTS: "1" } }));
      expect((await sabia("sync", "--quiet")).stdout).toBe("");
      expect((await readSettings()).env?.OTEL_LOG_USER_PROMPTS).toBe("1");
    });

    it("gives back the user's own earlier value, also on disconnect", async () => {
      await legacyRawDevice("0");
      await sabia("disconnect", "--local-only");
      expect((await readSettings()).env?.OTEL_LOG_USER_PROMPTS).toBe("0");
    });

    it("tells a 0.6.0 tool-output device that the upgrade, not an administrator, asks", async () => {
      await configureWithExporters({ logs: "none", traces: "otlp" }, {
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${serverEndpoint}/api/v1/telemetry/otlp`,
      });
      grants = { rawCapture: false, traceCapture: true };

      const { stdout } = await sabia("sync", "--quiet");

      expect(stdout).toContain("0.6.1 adds Claude Code's tool events");
      expect(stdout).not.toContain("an administrator");
      expect((await sabia("status")).stdout).toContain("Tool events are not exported yet");
    });

    it("changes nothing when approval cannot reach Sabia", async () => {
      await sabia(
        "configure",
        "--endpoint",
        `${serverEndpoint}/api/v1/telemetry/otlp`,
        "--ingestion-key",
        ingestionKey,
      );
      grants = "unavailable";
      const before = JSON.stringify(await readSettings());

      const failure = await sabia("approve").then(
        () => null,
        (error: { code: number; stderr: string }) => error,
      );

      expect(failure?.code).toBe(1);
      expect(JSON.stringify(await readSettings())).toBe(before);
    });

    it("converges the device on a grant narrowed in the app", async () => {
      await sabia(
        "configure",
        "--endpoint",
        `${serverEndpoint}/api/v1/telemetry/otlp`,
        "--ingestion-key",
        ingestionKey,
        "--tool-output",
      );
      grants = { rawCapture: false, traceCapture: false };

      await sabia("sync");

      const env = (await readSettings()).env ?? {};
      expect(env.OTEL_TRACES_EXPORTER).toBe("none");
      expect(env.OTEL_LOG_TOOL_CONTENT).toBeUndefined();
      expect(env.OTEL_LOG_TOOL_DETAILS).toBeUndefined();
    });

    it("stays quiet and changes nothing when already in sync", async () => {
      await sabia(
        "configure",
        "--endpoint",
        `${serverEndpoint}/api/v1/telemetry/otlp`,
        "--ingestion-key",
        ingestionKey,
      );
      const before = JSON.stringify(await readSettings());

      const { stdout } = await sabia("sync", "--quiet");

      expect(stdout).toBe("");
      expect(grantReads).toBe(1);
      expect(JSON.stringify(await readSettings())).toBe(before);
    });

    it("reports a revoked connection without deleting the local block", async () => {
      await sabia(
        "configure",
        "--endpoint",
        `${serverEndpoint}/api/v1/telemetry/otlp`,
        "--ingestion-key",
        ingestionKey,
      );
      grants = "revoked";

      const { stdout } = await sabia("sync", "--quiet");

      // Removal is disconnect's job; sync only says what happened.
      expect(stdout).toContain("revoked");
      expect((await readSettings()).env?.OTEL_METRICS_EXPORTER).toBe("otlp");
    });

    it("leaves everything alone when Sabia is unreachable", async () => {
      await sabia(
        "configure",
        "--endpoint",
        `${serverEndpoint}/api/v1/telemetry/otlp`,
        "--ingestion-key",
        ingestionKey,
      );
      const before = JSON.stringify(await readSettings());
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );

      const { stdout } = await sabia("sync", "--quiet");
      expect(stdout).toBe("");
      expect(JSON.stringify(await readSettings())).toBe(before);

      // afterEach closes the server; reopen so it has one to close.
      server = createServer(() => {});
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    });

    it("leaves everything alone when Sabia answers with an error", async () => {
      // Reachable but unhappy is the common case — a deploy, a rate limit, a
      // gateway hiccup. The hook runs on every SessionStart, so this has to
      // fail open like being offline does, not fail the session.
      await sabia(
        "configure",
        "--endpoint",
        `${serverEndpoint}/api/v1/telemetry/otlp`,
        "--ingestion-key",
        ingestionKey,
      );
      const before = JSON.stringify(await readSettings());
      grants = "unavailable";

      const { stdout } = await sabia("sync", "--quiet");

      expect(stdout).toBe("");
      expect(JSON.stringify(await readSettings())).toBe(before);
    });

    it("does nothing on an unmanaged machine", async () => {
      await writeFile(settingsPath, JSON.stringify({ env: { PATH: "/usr/bin" } }));

      const { stdout } = await sabia("sync", "--quiet");

      expect(stdout).toBe("");
      expect(grantReads).toBe(0);
    });
  });

  it("documents the tool-output grant in its help", async () => {
    const { stdout } = await run(process.execPath, [scriptPath, "help"]).catch(
      (error: { stdout: string }) => error,
    );

    expect(stdout).toContain("--tool-output");
    expect(stdout).toMatch(/tool result bodies/i);
    expect(stdout).toContain("connect [--base-url URL]");
  });

  it("describes connect and status from the same source", async () => {
    // connect used to branch on rawCapture alone, so the two surfaces could
    // disagree about the same connection.
    const script = await readFile(scriptPath, "utf8");
    const describerCalls = script.match(/describeCapture\(/g) ?? [];
    expect(describerCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses to rewrite settings it could not parse", async () => {
    const damaged = '{ "model": "opus", }';
    await writeFile(settingsPath, damaged);

    await expect(
      sabia("configure", "--endpoint", endpoint, "--ingestion-key", ingestionKey),
    ).rejects.toThrow(/is not valid JSON/);

    expect(await readFile(settingsPath, "utf8")).toBe(damaged);
  });

  describe("in a Claude Code cloud session", () => {
    const cloud = { ...localEnv, CLAUDE_CODE_REMOTE: "true" };

    // The VM's settings are discarded with the session and never read again.
    it.each([
      [["connect", "--base-url", "http://127.0.0.1:9", "--no-open"]],
      [["configure", "--endpoint", endpoint, "--ingestion-key", ingestionKey]],
    ])("refuses %j, writes nothing and says where cloud usage is set up", async (args) => {
      const failure = await sabiaIn(cloud, ...args).then(
        () => null,
        (error: { code: number; stderr: string }) => error,
      );

      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toContain("This is a Claude Code cloud session.");
      expect(failure?.stderr).toContain("Get cloud session values");
      expect(failure?.stderr).toContain("claude.ai/customize/connectors");
      await expect(readFile(settingsPath, "utf8")).rejects.toThrow("ENOENT");
      await expect(readFile(statePath, "utf8")).rejects.toThrow("ENOENT");
    });

    it("says whether the cloud environment turns telemetry on", async () => {
      expect((await sabiaIn(cloud, "status")).stdout).toContain(
        "Sabia telemetry: not shared from this cloud session.",
      );
      expect(
        (await sabiaIn({ ...cloud, CLAUDE_CODE_ENABLE_TELEMETRY: "1" }, "status")).stdout,
      ).toContain("Sabia telemetry: set by this cloud environment.");
    });

    it("stays quiet at session start", async () => {
      expect((await sabiaIn(cloud, "sync", "--quiet")).stdout).toBe("");
    });
  });

  it("rejects a credential that is not a Sabia ingestion key", async () => {
    // Anything else installs a working-looking exporter with no marker, leaving
    // status and disconnect blind to it.
    await expect(
      sabia("configure", "--endpoint", endpoint, "--ingestion-key", "not-a-key"),
    ).rejects.toThrow(/must be a Sabia ingestion key/);
  });
});

describe("Sabia Claude Code plugin connect", () => {
  let server: Server;
  let baseUrl: string;
  let connectBodies: Array<{ rawCapture?: boolean; traceCapture?: boolean }>;
  let grants: { rawCapture: boolean; traceCapture: boolean } | "unavailable" | "revoked";

  beforeEach(async () => {
    connectBodies = [];
    grants = { rawCapture: true, traceCapture: true };
    server = createServer((request, response) => {
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.method === "POST" && request.url === "/api/v1/telemetry/connect") {
        let raw = "";
        request.on("data", (chunk) => (raw += chunk));
        request.on("end", () => {
          connectBodies.push(JSON.parse(raw));
          send(201, {
            sessionId: "session-1",
            verificationUri: `${baseUrl}/connect/telemetry/session-1`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            intervalSeconds: 1,
          });
        });
        return;
      }
      if (request.url?.startsWith("/api/v1/telemetry/connect/session-1")) {
        send(200, {
          status: "approved",
          organizationId: "org-1",
          organizationName: "Acme",
          ingestionKeyId: "key-1",
          ingestionKey,
          otlpMetricsEndpoint: `${baseUrl}/api/v1/telemetry/otlp`,
          otlpLogsEndpoint: `${baseUrl}/api/v1/telemetry/otlp`,
        });
        return;
      }
      if (request.url === "/api/v1/telemetry/connection") {
        if (grants === "unavailable") {
          send(503, { error: { code: "UNAVAILABLE", message: "try later" } });
          return;
        }
        if (grants === "revoked") {
          send(401, { error: { code: "UNAUTHORIZED", message: "revoked" } });
          return;
        }
        send(200, {
          source: "claude_code",
          ...grants,
          otlpMetricsEndpoint: `${baseUrl}/api/v1/telemetry/otlp`,
          otlpLogsEndpoint: `${baseUrl}/api/v1/telemetry/otlp`,
          tracesEndpoint: `${baseUrl}/api/v1/telemetry/traces`,
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  function connect(...flags: string[]) {
    return sabia("connect", "--base-url", baseUrl, "--no-open", ...flags);
  }

  it("asks for tool output by default and exports it at once when granted", async () => {
    const { stdout } = await connect();

    expect(connectBodies).toEqual([
      expect.objectContaining({ rawCapture: false, traceCapture: true }),
    ]);
    // Sabia counts tokens from traces once tool output is granted, so the
    // export has to start with the grant, not at a later approve.
    const env = (await readSettings()).env ?? {};
    expect(env.OTEL_TRACES_EXPORTER).toBe("otlp");
    expect(env.OTEL_LOGS_EXPORTER).toBe("otlp");
    expect(env.OTEL_LOG_USER_PROMPTS).toBeUndefined();
    expect(stdout).toContain("--no-tool-output");
    expect(stdout).toContain("Tool result bodies");
  });

  it("leaves the export off and says so when tool output is withheld", async () => {
    grants = { rawCapture: false, traceCapture: false };

    const { stdout } = await connect();

    const env = (await readSettings()).env ?? {};
    expect(env.OTEL_TRACES_EXPORTER).toBe("none");
    expect(env.OTEL_LOGS_EXPORTER).toBe("none");
    expect(env.OTEL_METRICS_EXPORTER).toBe("otlp");
    expect(stdout).toContain("Tool output was not granted");
  });

  it("keeps content export off while the grant cannot be read, then applies it once Sabia confirms it", async () => {
    // Content sent without a grant cannot be called back, so an unreadable
    // grant is never treated as consent from Sabia.
    grants = "unavailable";

    const { stdout } = await connect();

    let env = (await readSettings()).env ?? {};
    expect(env.OTEL_TRACES_EXPORTER).toBe("none");
    expect(env.OTEL_LOGS_EXPORTER).toBe("none");
    expect(stdout).toContain("could not be read yet");

    // The person asked for it at connect, so the confirmed grant is applied
    // at the next session start without a separate approve.
    grants = { rawCapture: true, traceCapture: true };
    const sync = await sabia("sync", "--quiet");
    env = (await readSettings()).env ?? {};
    expect(env.OTEL_TRACES_EXPORTER).toBe("otlp");
    expect(env.OTEL_LOGS_EXPORTER).toBe("otlp");
    expect(sync.stdout).toContain("granted the tool output requested at connect");
    expect(JSON.parse(await readFile(statePath, "utf8"))).not.toHaveProperty("toolOutputRequested");
  }, 20_000);

  it("keeps a withheld grant off until an administrator grants it, without asking again", async () => {
    grants = { rawCapture: false, traceCapture: false };
    await connect();

    await sabia("sync", "--quiet");
    expect((await readSettings()).env?.OTEL_TRACES_EXPORTER).toBe("none");

    grants = { rawCapture: false, traceCapture: true };
    await sabia("sync", "--quiet");
    expect((await readSettings()).env?.OTEL_TRACES_EXPORTER).toBe("otlp");
  });

  it("still asks before widening a device that connected without tool output", async () => {
    await connect("--no-tool-output");

    grants = { rawCapture: false, traceCapture: true };
    const { stdout } = await sabia("sync", "--quiet");

    expect((await readSettings()).env?.OTEL_TRACES_EXPORTER).toBe("none");
    expect(stdout).toContain("asked to widen");
  });

  it("refuses to install a key Sabia reports as revoked", async () => {
    grants = "revoked";

    const failure = await connect().catch((error: { code: number; stdout: string; stderr: string }) => error);

    expect(failure).toMatchObject({ code: 1 });
    expect((failure as { stderr: string }).stderr).toContain("revoked");
    expect((failure as { stdout: string }).stdout).not.toContain("Connected");
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow("ENOENT");
  });

  it("shares token counts only with --no-tool-output", async () => {
    await connect("--no-tool-output");

    expect(connectBodies).toEqual([
      expect.objectContaining({ rawCapture: false, traceCapture: false }),
    ]);
    expect((await readSettings()).env?.OTEL_TRACES_EXPORTER).toBe("none");
  });
});
