import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("report contract", () => {
  it("pins the versioned schema checksum and the repository's own marketplace", async () => {
    const schema = await readFile("contracts/v2/report-artifact.schema.json", "utf8");
    const manifest = JSON.parse(await readFile("contracts/v2/manifest.json", "utf8"));
    expect(createHash("sha256").update(schema).digest("hex")).toBe(manifest.sha256);
    expect(JSON.parse(schema).properties.schema_version.const).toBe(2);
    const marketplace = JSON.parse(await readFile(".claude-plugin/marketplace.json", "utf8"));
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: "sabia-claude-code-otel", source: "./" })]);
    const plugin = JSON.parse(await readFile(".claude-plugin/plugin.json", "utf8"));
    expect(plugin.repository).toBe("https://github.com/Sabia-Partners/sabia-claude-plugin");
    expect(JSON.parse(await readFile("package.json", "utf8")).version).toBe(plugin.version);
  });
});
