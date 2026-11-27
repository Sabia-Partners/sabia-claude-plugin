// Replay synthetic Claude connector results through the candidate Sabia MCP App.
// Run with the path to a trusted Sabia checkout with its dev dependencies installed.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const checkout = process.argv[2];
if (!checkout) throw new Error("Pass the path to the Sabia checkout to verify.");
const requireFromCheckout = createRequire(resolve(checkout, "package.json"));
const { JSDOM } = requireFromCheckout("jsdom");
const { WORK_PANEL_HTML } = await import(pathToFileURL(resolve(checkout,
  "src/modules/quality/infrastructure/reporting/work-panel-html.ts")));
const cases = JSON.parse(await readFile(new URL("./fixtures/review-suggestions.json", import.meta.url), "utf8"));

for (const [name, review] of Object.entries(cases)) {
  for (const tool of ["review_work", "get_work"]) {
    const answer = {
      work: { title: "Sample chart", type: "Document", sabia_url: "https://app.sabia.work/artifacts/chart" },
      reviews: [review], history: [], people: [], changes: 0,
    };
    if (tool === "review_work") answer.review = {
      evaluation: review.evaluation, status: "reviewed", repeated: false,
      result: review, message: `The review finished: ${review.result}.`,
    };
    const dom = new JSDOM(WORK_PANEL_HTML, {
      runScripts: "dangerously",
      beforeParse(window) {
        // Supply only the MCP Apps initialization reply. No connector calls are made.
        window.postMessage = (message) => {
          if (message.method !== "ui/initialize") return;
          window.queueMicrotask(() => window.dispatchEvent(new window.MessageEvent("message", {
            source: window, data: { jsonrpc: "2.0", id: message.id, result: {
              protocolVersion: "2026-01-26", hostInfo: { name: "fixture", version: "1" }, hostCapabilities: {},
            } },
          })));
        };
      },
    });
    try {
      const { window } = dom;
      await new Promise(resolve => setImmediate(resolve));
      window.dispatchEvent(new window.MessageEvent("message", { source: window, data: {
        jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
          structuredContent: { result: answer }, content: [{ type: "text", text: JSON.stringify(answer) }],
        },
      } }));
      const app = window.document.querySelector("#app");
      assert.ok(app.textContent.includes(review.result), `${name} verdict`);
      const heading = [...app.querySelectorAll("button")].find(button => button.textContent === "Suggestions");
      if (name === "all-pass" || name === "mixed") {
        assert.ok(heading, `${name} Suggestions heading`);
        const section = heading.parentElement.textContent;
        for (const value of ["Labels the chart", "Label the two peaks.", "Readers can compare the peaks directly.",
          "Evidence 2", "Review ledger page 4"]) assert.ok(section.includes(value), value);
        assert.ok(!section.includes("Add the missing citation."));
        const findings = app.querySelector(".findings")?.textContent ?? "";
        assert.ok(!findings.includes("Label the two peaks."));
        assert.equal(findings.includes("Add the missing citation."), name === "mixed");
      } else {
        assert.equal(heading, undefined);
        assert.ok(!app.textContent.includes("Label the two peaks."));
        assert.ok(!app.textContent.includes("Add the missing citation."));
        if (name === "permission-filtered") assert.ok(app.textContent.includes("Cites its sources"));
      }
      console.log(`PASS ${name} / ${tool}`);
    } finally {
      dom.window.close();
    }
  }
}
