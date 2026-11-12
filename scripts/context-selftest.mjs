import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { assembleContext } from "../src/context.ts";
function temporary(t) {
  const parent = path.resolve(tmpdir());
  const root = mkdtempSync(path.join(parent, "pa-module-selftest-"));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert(path.basename(root).startsWith("pa-module-selftest-"));
    rmSync(root, { recursive: true, force: true });
  });
  return { root };
}

test("context selection honors priorities and exact JSON budget, deduplicates and never modifies caller data", () => {
  const items = [
    { id: "index", source: "index", text: "低优先级目录".repeat(100), priority: 9 },
    { id: "state", source: "task", text: "目标：完成测试；约束：不推送", priority: 0 },
    { id: "memory", source: "memory", text: '含引号 " 和换行\n 的记忆', priority: 2 },
    { id: "duplicate", source: "memory", text: '含引号 " 和换行\n 的记忆', priority: 2 },
  ];
  const before = structuredClone(items);
  const packed = assembleContext(items, 250);
  assert.deepEqual(JSON.parse(packed.text).map((item) => item.id), ["state", "memory"]);
  assert.equal(packed.stats.chars, packed.text.length);
  assert(packed.text.length <= 250);
  assert.equal(packed.stats.omitted, 1);
  assert.equal(packed.stats.duplicates, 1);
  assert.deepEqual(items, before);
  assert.equal(assembleContext(items, 2).text, "[]");
  assert.throws(() => assembleContext(items, 1));
});

test("background budgets validate their character unit and preserve old configurations", (t) => {
  const { root } = temporary(t);
  const file = path.join(root, "config.json");
  const base = { agent: { userId: "fixture" }, pi: { command: "node", args: [] } };
  for (const value of [1, -1, 2.5]) {
    writeFileSync(file, JSON.stringify({ ...base, agent: { ...base.agent, maxBackgroundChars: value } }));
    assert.throws(() => loadConfig(file), /maxBackgroundChars/);
  }
  writeFileSync(file, JSON.stringify({ ...base, agent: { ...base.agent, maxBackgroundChars: 2 } }));
  assert.equal(loadConfig(file).agent.maxBackgroundChars, 2);
});

test("context statistics publish without a diagnostics-module dependency", (t) => {
  const observed = [];
  const capture = (message) => observed.push(message);
  const diagnostics = channel("personal-agent.context");
  diagnostics.subscribe(capture);
  t.after(() => diagnostics.unsubscribe(capture));
  const packed = assembleContext([{ id:"one", source:"task", priority:0, text:"pending" }], 300, "request-fixture");
  assert.equal(observed.length, 1);
  assert.equal(observed[0].requestId, "request-fixture");
  assert.deepEqual(observed[0].stats, packed.stats);
  assert(observed[0].durationMs >= 0);
});
