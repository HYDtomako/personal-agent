import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ExecutionMonitor } from "../src/execution-monitor.ts";
import { temporary, runnerFixture } from "./runtime-fixtures.mjs";
const start = (id, args = { path: "fixture" }) => ({ type: "tool_execution_start", toolCallId: id, toolName: "read", args });
const end = (id, result = "denied", isError = true) => ({ type: "tool_execution_end", toolCallId: id, toolName: "read", result, isError });
function observation(monitor, id, args, result, isError = true) {
  monitor.observe(start(id, args), 1);
  return monitor.observe(end(id, result, isError), 2);
}

test("execution budgets validate positive values and explicit zero without breaking old configs", (t) => {
  const { root } = temporary(t);
  const file = path.join(root, "config.json");
  const base = { agent: { userId: "fixture" }, pi: { command: "node", args: [] } };
  writeFileSync(file, JSON.stringify(base));
  assert.equal(loadConfig(file).agent.userId, "fixture");
  for (const [field, value] of [["maxToolCalls", -1], ["maxRepeatedToolFailures", 1.5]]) {
    writeFileSync(file, JSON.stringify({ ...base, agent: { ...base.agent, [field]: value } }));
    assert.throws(() => loadConfig(file), new RegExp(field));
  }
  writeFileSync(file, JSON.stringify({ ...base, agent: { ...base.agent, maxToolCalls: 0, maxRepeatedToolFailures: 0 } }));
  assert.equal(loadConfig(file).agent.maxToolCalls, 0);
});

test("event replay accumulates every model call and cache usage, deduplicates message IDs and measures first text", () => {
  const monitor = new ExecutionMonitor({}, 0);
  monitor.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好" } }, 12);
  const first = { type: "message_end", message: { id: "first", role: "assistant", usage: { totalTokens: 100, input: 20, output: 30, cacheRead: 50, cost: { total: 0.1 } } } };
  monitor.observe(first, 20);
  monitor.observe(first, 21);
  monitor.observe({ type: "message_end", message: { id: "second", role: "assistant", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: { total: 0.2 } } } }, 30);
  assert.deepEqual(monitor.usage(), { tokens: 200, cost: 0.1 + 0.2, input: 30, output: 50, cacheRead: 80, cacheWrite: 40 });
  assert.equal(monitor.metrics(3, "completed", 40).modelCalls, 2);
  assert.equal(monitor.metrics(3, "completed", 40).firstTextMs, 12);
  const snapshot = monitor.usage(); snapshot.tokens = 999;
  assert.equal(monitor.usage().tokens, 200);
});

test("loop guard requires identical failed actions and results, permits progress and normal repeated successes", () => {
  const monitor = new ExecutionMonitor({ maxRepeatedToolFailures: 3 }, 0);
  assert.equal(observation(monitor, "a", { path: "a", page: 1 }, { error: "denied" }), undefined);
  assert.equal(observation(monitor, "b", { page: 1, path: "a" }, { error: "denied" }), undefined);
  assert.equal(observation(monitor, "c", { page: 1, path: "a" }, { error: "denied" }), "repeated_tool_failure");
  const changing = new ExecutionMonitor({ maxRepeatedToolFailures: 2 }, 0);
  for (let i = 0; i < 10; i++) assert.equal(observation(changing, String(i), { page: i }, "same failure"), undefined);
  assert.equal(observation(changing, "new-result-a", {}, "first failure"), undefined);
  assert.equal(observation(changing, "new-result-b", {}, "different failure"), undefined);
  assert.equal(observation(changing, "success", {}, "ok", false), undefined);
  assert.equal(observation(changing, "retry", {}, "different failure"), undefined);
  for (let i = 0; i < 10; i++) assert.equal(observation(changing, "success-" + i, {}, "ok", false), undefined);
});

test("tool budgets are independent of loop detection and concurrent completions use their own call IDs", () => {
  const monitor = new ExecutionMonitor({ maxToolCalls: 2 }, 0);
  monitor.observe(start("a"), 10);
  monitor.observe(start("a"), 11);
  monitor.observe(start("b"), 20);
  monitor.observe(end("b", "ok", false), 30);
  monitor.observe(end("a", "error", true), 50);
  assert.equal(monitor.metrics(0, "completed", 60).toolCalls, 2);
  assert.equal(monitor.metrics(0, "completed", 60).toolMs, 50);
  assert.equal(monitor.metrics(0, "completed", 60).toolErrors, 1);
  assert.equal(monitor.observe(start("c"), 70), "tool_budget");
  const unlimited = new ExecutionMonitor({ maxToolCalls: 0, maxRepeatedToolFailures: 0 });
  for (let i = 0; i < 110; i++) assert.equal(observation(unlimited, String(i), {}, "same failure"), undefined);
});

test("real subprocess handles UTF-8 across byte boundaries, final JSON without newline, and cumulative billing", { timeout: 10000 }, async (t) => {
  const runner = runnerFixture(t);
  const unicode = await runner.run("unicode", {});
  assert.equal(unicode.ok, true); assert.equal(unicode.text, "你好🔑");
  const usageEvents = [];
  const result = await runner.run("multi", { onEvent: (event) => { if (event.kind === "usage") usageEvents.push(event); } });
  assert(usageEvents.every((event) => event.cumulative === true));
  assert.equal(result.text, "done"); assert.equal(result.usage.tokens, 300);
  assert(Math.abs(result.usage.cost - 0.3) < 1e-9);
  assert.equal(result.metrics.modelCalls, 2); assert(result.metrics.firstTextMs >= 0);
});

test("loop and tool budget stops are failures, do not retry and release the slot only after worker close", { timeout: 15000 }, async (t) => {
  const runner = runnerFixture(t, { maxRepeatedToolFailures: 3, maxToolCalls: 4 });
  const loop = await runner.run("loop", {});
  assert.equal(loop.ok, false); assert.equal(loop.metrics.stopReason, "repeated_tool_failure");
  assert.equal(loop.metrics.toolErrors, 3);
  const budget = await runner.run("limit", {});
  assert.equal(budget.ok, false); assert.equal(budget.metrics.stopReason, "tool_budget");
  const normal = await runner.run("normal", {});
  assert.equal(normal.ok, true); assert.equal(runner.busy, 0);
});

test("changing observations are not mistaken for a no-progress loop, and queued runs measure their wait", { timeout: 10000 }, async (t) => {
  const runner = runnerFixture(t, { maxRepeatedToolFailures: 2 });
  assert.equal((await runner.run("progress", {})).ok, true);
  const [slow, queued] = await Promise.all([runner.run("slow", {}), runner.run("normal", {})]);
  assert.equal(slow.ok, true); assert.equal(queued.ok, true);
  assert(queued.metrics.queueMs >= 60, JSON.stringify(queued.metrics));
});

test("timeout, cancellation, output limits and process failures produce distinct outcomes and never hang the queue", { timeout: 15000 }, async (t) => {
  const runner = runnerFixture(t);
  const timeout = await runner.run("timeout", { timeoutMs: 120 });
  assert.equal(timeout.ok, false); assert.equal(timeout.metrics.stopReason, "timed_out");
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const cancelled = runner.run("cancel", { onEvent: (event) => { if (event.kind === "delta") started(); } });
  await ready;
  assert.equal(runner.abortAll(), 1);
  assert.equal((await cancelled).metrics.stopReason, "cancelled");
  assert.equal((await runner.run("oversize", {})).metrics.stopReason, "output_limit");
  assert.equal((await runner.run("failure", {})).metrics.stopReason, "failed");
  assert.equal((await runner.run("normal", {})).ok, true);
});
