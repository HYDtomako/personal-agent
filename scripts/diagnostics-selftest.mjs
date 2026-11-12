import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { RuntimeTraceStore, RunTraceObserver, measureAsync, measureSync, readRuntimeTraces, summarizeRuntimeTraces } from "../src/runtime-trace.ts";

function temporary(t) {
  const parent = path.resolve(tmpdir());
  const root = mkdtempSync(path.join(parent, "pa-diagnostics-selftest-"));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert(path.basename(root).startsWith("pa-diagnostics-selftest-"));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function trace(id, firstTextMs = 20) {
  return { requestId: id, at: "2026-11-10T00:00:00.000Z", model: "fixture-model", ok: true,
    timings: { queueMs: 3, sessionMs: 2, attachmentsMs: 1, memoryMs: 4, contextMs: 1, preparationMs: 8, runnerQueueMs: 1, runMs: 30, totalMs: 42, firstTextMs },
    metrics: { queueMs: 1, modelCalls: 2, toolCalls: 2, toolErrors: 0, toolMs: 5, stopReason: "completed" },
    usage: { tokens: 10, cost: 0.01, input: 1, output: 2, cacheRead: 7, cacheWrite: 0 },
    context: { budgetChars: 100, chars: 80, selected: 2, omitted: 1, duplicates: 0 } };
}

test("original runner per-call usage accumulates; tools match IDs across concurrent events", () => {
  const observer = new RunTraceObserver(100);
  observer.observe({ kind: "usage", tokens: 100, cost: 0.1 }, 110);
  observer.observe({ kind: "usage", tokens: 200, cost: 0.2 }, 115);
  observer.observe({ kind: "tool_start", id: "a" }, 120);
  observer.observe({ kind: "tool_start", id: "b" }, 125);
  observer.observe({ kind: "tool_end", id: "b", isError: true }, 130);
  observer.observe({ kind: "tool_end", id: "a", isError: false }, 140);
  observer.observe({ kind: "delta", text: "answer" }, 150);
  observer.observe({ kind: "done", text: "answer" }, 170);
  const result = observer.finish({ ok: true, text: "answer", durationMs: 70, usage: { tokens: 200, cost: 0.2 } }, 170);
  assert.equal(result.usage.tokens, 300);
  assert(Math.abs(result.usage.cost - 0.3) < 1e-10);
  assert.equal(result.metrics.source, "events");
  assert.equal(result.metrics.queueMs, undefined);
  assert.equal(result.metrics.modelCalls, 2);
  assert.equal(result.metrics.toolCalls, 2);
  assert.equal(result.metrics.toolErrors, 1);
  assert.equal(result.metrics.toolMs, 25);
  assert.equal(result.firstTextAfterSubmitMs, 50);
});

test("cumulative usage and native enhanced runner metrics do not double count", () => {
  const observer = new RunTraceObserver(0);
  observer.observe({ kind: "usage", tokens: 100, cost: 0.1, cumulative: true }, 10);
  observer.observe({ kind: "usage", tokens: 300, cost: 0.3, cumulative: true }, 20);
  assert.equal(observer.finish({ ok: true, text: "", durationMs: 20 }, 20).usage.tokens, 300);
  const metrics = { queueMs: 10, firstTextMs: 5, modelCalls: 2, toolCalls: 1, toolErrors: 0, toolMs: 3, stopReason: "completed" };
  const result = observer.finish({ ok: true, text: "", durationMs: 20, usage: { tokens: 300, cost: 0.3, cacheRead: 250 }, metrics }, 20);
  assert.equal(result.metrics.source, "runner");
  assert.equal(result.usage.tokens, 300);
  assert.equal(result.usage.cacheRead, 250);
  assert.equal(result.firstTextAfterSubmitMs, 15);
});

test("missing usage and text remain unknown; open tools are measured until failure", () => {
  const observer = new RunTraceObserver(10);
  observer.observe({ kind: "tool_start", id: "unfinished" }, 20);
  const result = observer.finish({ ok: false, text: "", durationMs: 40 }, 50);
  assert.equal(result.usage, undefined);
  assert.equal(result.firstTextAfterSubmitMs, undefined);
  assert.equal(result.metrics.modelCalls, undefined);
  assert.equal(result.metrics.toolMs, 30);
  assert.equal(result.metrics.stopReason, "failed");
});

test("optional context channel only accepts whitelisted statistics for active request IDs", (t) => {
  const store = new RuntimeTraceStore(path.join(temporary(t), "trace.jsonl"));
  t.after(() => store.close());
  const diagnostics = channel("personal-agent.context");
  const stats = { budgetChars: 100, chars: 80, selected: 2, omitted: 1, duplicates: 0, prompt: "PRIVATE" };
  diagnostics.publish({ requestId: "unknown", stats, durationMs: 1 });
  assert.equal(store.contextFor("unknown"), undefined);
  store.begin("active");
  diagnostics.publish({ requestId: "active", stats: { ...stats, chars: 101 }, durationMs: 1 });
  assert.equal(store.contextFor("active").stats, undefined);
  diagnostics.publish({ requestId: "active", stats, durationMs: 1 });
  const saved = store.contextFor("active");
  assert.equal(saved.durationMs, 1);
  assert.equal(saved.stats.chars, 80);
  assert.equal(saved.stats.prompt, undefined);
  saved.stats.chars = 1;
  assert.equal(store.contextFor("active").stats.chars, 80);
  store.end("active");
  diagnostics.publish({ requestId: "active", stats, durationMs: 1 });
  assert.equal(store.contextFor("active"), undefined);
  store.close();
  store.begin("closed");
  diagnostics.publish({ requestId: "closed", stats, durationMs: 1 });
  assert.equal(store.contextFor("closed").stats, undefined);
});

test("preparation spans retain elapsed time on asynchronous and synchronous failure", async () => {
  const timings = trace("measure").timings;
  timings.sessionMs = 0; timings.memoryMs = 0;
  await assert.rejects(measureAsync(timings, "sessionMs", async () => {
    await new Promise((resolve) => setTimeout(resolve, 8)); throw new Error("fixture failure");
  }), /fixture failure/);
  assert(timings.sessionMs >= 5);
  assert.throws(() => measureSync(timings, "memoryMs", () => {
    const started = performance.now(); while (performance.now() - started < 2) { /* small timed fixture */ }
    throw new Error("fixture failure");
  }), /fixture failure/);
  assert(timings.memoryMs >= 1);
});

test("traces whitelist metrics, redact secrets, tolerate partial lines and bound rotation", (t) => {
  const file = path.join(temporary(t), "traces.jsonl");
  const store = new RuntimeTraceStore(file, (text) => text.replaceAll("test-secret", "[hidden]"));
  t.after(() => store.close());
  const row = trace("test-secret");
  row.prompt = "PRIVATE_PROMPT";
  row.timings.PRIVATE_TIMING_NAME = 99;
  row.metrics.args = "PRIVATE_TOOL_ARGS";
  row.usage.raw = "PRIVATE_USAGE";
  row.context.raw = "PRIVATE_CONTEXT";
  store.append(row);
  const saved = readFileSync(file, "utf8");
  assert(!saved.includes("PRIVATE_"));
  assert(!saved.includes("test-secret"));
  appendFileSync(file, "{broken half line\n");
  assert.equal(readRuntimeTraces(file).length, 1);
  writeFileSync(file, "x".repeat(2 * 1024 * 1024));
  store.append(trace("rotated"));
  assert(existsSync(`${file}.1`));
  assert(statSync(file).size < 2 * 1024 * 1024);
  assert.equal(readRuntimeTraces(file)[0].requestId, "rotated");
  store.append(trace("second-secret"));
  writeFileSync(file, "x".repeat(2 * 1024 * 1024));
  store.append(trace("rotated-again"));
  assert(!existsSync(`${file}.2`));
  assert(statSync(`${file}.1`).size <= 2 * 1024 * 1024);
  assert.equal(summarizeRuntimeTraces([]).totalMs.p95, undefined);
  const other = trace("second"); delete other.timings.firstTextMs; other.timings.totalMs = 100;
  const summary = summarizeRuntimeTraces([trace("first"), other]);
  assert.equal(summary.totalMs.p50, 42); assert.equal(summary.totalMs.p95, 100);
  assert.equal(summary.firstTextSamples, 1); assert.equal(summary.tokens, 20);
});
