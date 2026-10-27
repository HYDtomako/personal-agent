import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { NotionMemory, NotionMemoryCache } from "../src/notion-memory.ts";
import { MemoryStore } from "../src/memory.ts";

/**
 * Notion 长期记忆读取缓存自测（不打真实 Notion，用本地假 HTTP 服务）。
 *
 * 覆盖：正常拉取 + 原子落盘快照、连接重置后重试、连续失败用磁盘快照并标 stale、
 * TTL 内零请求、dirty 标记立即重拉、429 退避、快照损坏退回本地归档。
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-notion-cache-"));
const repoRoot = path.resolve(import.meta.dirname, "..");
const TOKEN = "fake-token-for-selftest";
const DATA_SOURCE_ID = "ds-selftest";

let passed = 0;
const failures = [];
let logs = [];
const log = (message) => logs.push(message);

const watchdog = setTimeout(() => {
  console.error("FAIL 自测超时（60s）：可能存在连接未释放或重试未收敛");
  process.exit(1);
}, 60_000);

// 可注入时钟：TTL / 文案里的"已过多久"都靠它，避免真的等 5 分钟
let clock = new Date("2026-11-01T10:00:00").getTime();
const now = () => clock;
const advance = (ms) => {
  clock += ms;
};

async function test(name, fn) {
  logs = [];
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}`);
    console.log(`  ${error instanceof Error ? error.stack ?? error.message : error}`);
    for (const line of logs) console.log(`  log| ${line}`);
  }
}

function entryPage(id, text, kind = "memory") {
  return {
    id,
    properties: {
      内容: { title: [{ plain_text: text }] },
      ID: { rich_text: [{ plain_text: id }] },
      类型: { select: { name: kind } },
      状态: { select: { name: "active" } },
    },
  };
}

function listOf(...pages) {
  return { object: "list", results: pages, has_more: false, next_cursor: null };
}

/**
 * 假 Notion：behavior(第几次请求) 决定本次行为。
 *   "ok"     → 200 + payload()
 *   "reset"  → 直接销毁 socket（模拟连接被重置）
 *   "429"    → 429 限流
 *   数字     → 该 HTTP 状态码
 */
async function fakeNotion(behavior, payload = () => listOf(entryPage("mem-1", "用户偏好深色主题"))) {
  const state = { requests: 0, paths: [] };
  const server = createServer((req, res) => {
    req.resume();
    state.requests++;
    state.paths.push(req.url);
    const action = behavior(state.requests);
    if (action === "reset") {
      req.socket.destroy();
      return;
    }
    if (action === "hang") {
      return; // 永不响应：等客户端自己的超时把它掐掉
    }
    if (action === "429") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "rate limited" }));
      return;
    }
    if (typeof action === "number") {
      res.writeHead(action, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `http ${action}` }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload(state.requests)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.baseUrl = `http://127.0.0.1:${server.address().port}`;
  state.close = async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  };
  return state;
}

function newMemory(baseUrl, extra = {}) {
  return new NotionMemory({
    token: TOKEN,
    dataSourceId: DATA_SOURCE_ID,
    baseUrl,
    timeoutMs: 2000,
    connectTimeoutMs: 1000,
    log,
    ...extra,
  });
}

function paths(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    snapshotFile: path.join(dir, "notion-memory-cache.json"),
    dirtyFile: path.join(dir, "notion-memory-cache.dirty"),
  };
}

function newCache(memory, files, ttlMs = 300_000) {
  return new NotionMemoryCache({ memory, snapshotFile: files.snapshotFile, dirtyFile: files.dirtyFile, ttlMs, log, now });
}

async function main() {
  await test("正常返回并原子落盘快照", async () => {
    clock = new Date("2026-11-01T10:00:00").getTime();
    const files = paths("ok");
    const server = await fakeNotion(
      () => "ok",
      () => listOf(entryPage("mem-1", "用户偏好深色主题"), entryPage("mem-2", "项目在 D:/pi-agent", "project")),
    );
    const memory = newMemory(server.baseUrl);
    const cache = newCache(memory, files);
    try {
      const loaded = await cache.load();
      assert.equal(loaded.level, "network");
      assert.equal(loaded.stale, false);
      assert.equal(loaded.entries.length, 2);
      assert.equal(loaded.fetchedAt, clock);
      assert.equal(loaded.label, "Notion 权威（10:00 拉取）");
      assert.equal(server.requests, 1);
      assert.equal(server.paths[0], `/v1/data_sources/${DATA_SOURCE_ID}/query`);
      assert.ok(fs.existsSync(files.snapshotFile), "快照文件应已落盘");
      assert.ok(!fs.existsSync(`${files.snapshotFile}.tmp`), ".tmp 应已 rename 掉");
      const snapshot = JSON.parse(fs.readFileSync(files.snapshotFile, "utf8"));
      assert.equal(snapshot.fetchedAt, clock);
      assert.equal(snapshot.entries.length, 2);
      assert.equal(snapshot.entries[1].kind, "project");
      assert.equal(snapshot.entries[1].text, "项目在 D:/pi-agent");
      // 落盘内容能反查：新实例重启后直接可用
      const revived = newCache(newMemory(server.baseUrl), files);
      const restored = await revived.load();
      assert.equal(restored.level, "snapshot", "快照未过期时应直接从磁盘恢复，不发请求");
      assert.equal(restored.stale, false);
      assert.equal(restored.entries.length, 2);
      assert.equal(server.requests, 1, "快照仍在 TTL 内，不该再打 Notion");
    } finally {
      memory.close();
      await server.close();
    }
  });

  await test("连接被重置后重试成功", async () => {
    clock = new Date("2026-11-01T10:00:00").getTime();
    const files = paths("reset");
    const server = await fakeNotion((n) => (n === 1 ? "reset" : "ok"));
    const memory = newMemory(server.baseUrl);
    try {
      const loaded = await newCache(memory, files).load();
      assert.equal(server.requests, 2, "应重试一次并成功");
      assert.equal(loaded.level, "network");
      assert.equal(loaded.entries.length, 1);
      assert.ok(
        logs.some((line) => line.includes("网络错误")),
        `应有网络错误与重试日志，实际：${JSON.stringify(logs)}`,
      );
    } finally {
      memory.close();
      await server.close();
    }
  });

  await test("连续失败时用磁盘快照并标注 stale", async () => {
    clock = new Date("2026-11-01T10:00:00").getTime();
    const files = paths("snapshot");
    const good = await fakeNotion(() => "ok");
    const memory = newMemory(good.baseUrl);
    try {
      const first = await newCache(memory, files).load();
      assert.equal(first.level, "network");
      assert.equal(good.requests, 1);
    } finally {
      memory.close();
      await good.close();
    }

    advance(2 * 3600 * 1000); // 两小时后，快照过期、换成"网络全挂"的新实例（模拟进程重启）
    const dead = await fakeNotion(() => "reset");
    const memory2 = newMemory(dead.baseUrl);
    try {
      const loaded = await newCache(memory2, files).load();
      assert.equal(dead.requests, 3, "网络层失败应重试，共 3 次尝试");
      assert.equal(loaded.level, "snapshot");
      assert.equal(loaded.stale, true);
      assert.equal(loaded.entries.length, 1);
      assert.equal(loaded.label, "Notion 快照（10:00 拉取，已过 2 小时），本轮刷新失败");
      assert.ok(logs.some((line) => line.includes("磁盘快照恢复")), "应从磁盘快照恢复");
      assert.ok(logs.some((line) => line.includes("刷新失败") && line.includes("stale")), "降级要留日志");
      assert.ok(fs.existsSync(files.snapshotFile), "失败不得清空快照");
    } finally {
      memory2.close();
      await dead.close();
    }
  });

  await test("TTL 内第二次调用零请求", async () => {
    clock = new Date("2026-11-01T10:00:00").getTime();
    const files = paths("ttl");
    const server = await fakeNotion(() => "ok");
    const memory = newMemory(server.baseUrl);
    const cache = newCache(memory, files, 300_000);
    try {
      const first = await cache.load();
      assert.equal(first.level, "network");
      assert.equal(server.requests, 1);
      advance(4 * 60 * 1000); // TTL 内（300s > 240s）
      const second = await cache.load();
      assert.equal(server.requests, 1, "TTL 内不得再发请求");
      assert.equal(second.level, "cache");
      assert.equal(second.stale, false);
      assert.equal(second.label, "Notion 缓存（10:00 拉取，已过 4 分钟）");

      advance(2 * 60 * 1000); // 累计 6 分钟 > TTL → 该刷新
      const third = await cache.load();
      assert.equal(server.requests, 2, "TTL 到点应先尝试刷新");
      assert.equal(third.level, "network");
    } finally {
      memory.close();
      await server.close();
    }
  });

  await test("dirty 标记触发立即重拉", async () => {
    clock = new Date("2026-11-01T10:00:00").getTime();
    const files = paths("dirty");
    const server = await fakeNotion((n) => "ok", (n) => listOf(entryPage("mem-1", `第 ${n} 次拉取的内容`)));
    const memory = newMemory(server.baseUrl);
    const cache = newCache(memory, files, 300_000);
    try {
      await cache.load();
      assert.equal(server.requests, 1);
      fs.writeFileSync(files.dirtyFile, new Date(clock).toISOString(), "utf8");
      const loaded = await cache.load(); // 仍在 TTL 内，但 dirty 必须强制重拉
      assert.equal(server.requests, 2, "dirty 标记应无视 TTL 立即重拉");
      assert.equal(loaded.level, "network");
      assert.equal(loaded.entries[0].text, "第 2 次拉取的内容");
      assert.ok(!fs.existsSync(files.dirtyFile), "成功后应删除 dirty 标记");
      const snapshot = JSON.parse(fs.readFileSync(files.snapshotFile, "utf8"));
      assert.equal(snapshot.entries[0].text, "第 2 次拉取的内容", "快照应被新数据覆盖");
    } finally {
      memory.close();
      await server.close();
    }
  });

  await test("429 退避后成功", async () => {
    clock = new Date("2026-11-01T10:00:00").getTime();
    const files = paths("rate");
    const server = await fakeNotion((n) => (n <= 2 ? "429" : "ok"));
    const memory = newMemory(server.baseUrl);
    try {
      const started = Date.now();
      const entries = await memory.listActive();
      const elapsed = Date.now() - started;
      assert.equal(entries.length, 1);
      assert.equal(server.requests, 3);
      assert.ok(elapsed >= 2300, `429 退避应累计约 800+1600ms，实际 ${elapsed}ms`);
      assert.ok(logs.filter((line) => line.includes("429")).length === 2, "两次 429 都要留日志");
      // 429 重试成功后缓存照常工作
      const loaded = await newCache(memory, files).load();
      assert.equal(loaded.level, "network");
    } finally {
      memory.close();
      await server.close();
    }
  });

  await test("单次尝试超时后重试，最坏耗时可控", async () => {
    clock = new Date("2026-11-01T10:00:00").getTime();
    const files = paths("timeout");
    const server = await fakeNotion(() => "hang");
    const memory = newMemory(server.baseUrl, { timeoutMs: 300, connectTimeoutMs: 300 });
    try {
      const started = Date.now();
      await assert.rejects(
        () => newCache(memory, files).load(),
        (error) => {
          assert.match(String(error.message), /超时/, `超时错误要说清原因：${error.message}`);
          return true;
        },
      );
      const elapsed = Date.now() - started;
      assert.equal(server.requests, 3, "每次尝试超时都应重试，共 3 次");
      assert.ok(elapsed < 3000, `3 次 × 300ms + 300/800ms 退避，不该超过 3s，实际 ${elapsed}ms`);
      assert.ok(logs.some((line) => line.includes("TimeoutError")), "超时日志要带错误名");
    } finally {
      memory.close();
      await server.close();
    }
  });

  await test("快照损坏时退回本地冻结归档", async () => {
    clock = new Date("2026-11-01T10:00:00").getTime();
    const files = paths("corrupt");
    fs.writeFileSync(files.snapshotFile, "{ 这不是 JSON", "utf8");
    const dead = await fakeNotion(() => "reset");
    const memory = newMemory(dead.baseUrl);
    try {
      const cache = newCache(memory, files);
      await assert.rejects(
        () => cache.load(),
        (error) => {
          assert.match(String(error.message), /ECONNRESET|socket hang up|连接|超时/i, `错误信息应说明原因：${error.message}`);
          return true;
        },
        "快照损坏且网络不可用时必须抛出，交给上层降级",
      );
      assert.ok(logs.some((line) => line.includes("磁盘快照") && line.includes("不存在处理")), "损坏快照要留日志");
    } finally {
      memory.close();
      await dead.close();
    }

    // 第三级：main.ts 的 catch 里调用的 memory.select（本地冻结归档），此处用同一份归档验证它仍可用
    const archiveSource = path.join(repoRoot, "memory", "long-term", "me.jsonl");
    assert.ok(fs.existsSync(archiveSource), `本地归档应存在：${archiveSource}`);
    const archiveDir = path.join(root, "archive");
    fs.mkdirSync(path.join(archiveDir, "long-term"), { recursive: true });
    fs.copyFileSync(archiveSource, path.join(archiveDir, "long-term", "me.jsonl"));
    const store = new MemoryStore({
      dir: archiveDir,
      summarize: async () => "",
      runText: async () => "",
      log: () => {},
    });
    const sel = store.select("me", "记住的偏好");
    assert.ok(sel.total > 0, "本地冻结归档应能读出条目（降级第三级可用）");
    const lines = sel.lines.map((line) => `- [archive] ${line.replace(/^- /, "")}`);
    assert.equal(lines.length, sel.lines.length);
  });

  clearTimeout(watchdog);
  console.log(`\n${passed}/${passed + failures.length} 通过` + (failures.length ? `，失败：${failures.join("、")}` : ""));
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  clearTimeout(watchdog);
  console.error("FAIL 自测异常退出:", error);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
