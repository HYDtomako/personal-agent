import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { DEFAULT_INDEX_DATA_SOURCE_ID, NotionMemory, NotionMemoryCache } from "../src/notion-memory.ts";
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

/** 索引表的一行（data source query 的 results 元素）；titleProp 默认新表的「名称」 */
function indexRow({ group, title, content, keywords, titleProp = "名称", id = "0a1b2c3d-4e5f-6789-abcd-ef0123450000" }) {
  const richText = (text) => (text === undefined ? [] : [{ type: "text", plain_text: text }]);
  return {
    object: "page",
    id,
    properties: {
      [titleProp]: { type: "title", title: richText(title) },
      分组: { type: "select", select: group === undefined ? null : { name: group } },
      内容: { type: "rich_text", rich_text: richText(content) },
      关键词: { type: "rich_text", rich_text: richText(keywords) },
    },
  };
}

function indexListOf(rows, nextCursor = null) {
  return { object: "list", results: rows, has_more: Boolean(nextCursor), next_cursor: nextCursor };
}

/** 目录行末尾的短 id：page id 去连字符后末 6 位小写（与 src/notion-memory.ts 的 shortPageId 同规则）。 */
function withShortId(line, pageId) {
  return `${line} · #${pageId.replace(/-/g, "").slice(-6)}`;
}

/**
 * 假 Notion：behavior(第几次请求) 决定本次行为。
 *   "ok"     → 200 + payload()
 *   "reset"  → 直接销毁 socket（模拟连接被重置）
 *   "hang"   → 永不响应
 *   "429"    → 429 限流
 *   数字     → 该 HTTP 状态码
 * 请求体也会被收集（state.methods / state.bodies），用于断言 data source query 的 body。
 */
async function fakeNotion(behavior, payload = () => listOf(entryPage("mem-1", "用户偏好深色主题"))) {
  const state = { requests: 0, paths: [], methods: [], bodies: [] };
  const server = createServer((req, res) => {
    state.requests++;
    state.paths.push(req.url);
    state.methods.push(req.method);
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", () => {});
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      state.bodies.push(body);
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
      res.end(JSON.stringify(payload(state.requests, state)));
    });
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

  await test("记忆目录改读索引表（data source query）：翻页、拼行、缓存、失败降级", async () => {
    clock = new Date("2026-11-01T10:00:00").getTime();
    const files = paths("index");
    const indexDataSourceId = "idx-ds-selftest";
    const page1 = [
      indexRow({ group: "说明", title: "总览", content: "记忆目录的读法与写入时机", keywords: "索引、recall", id: "413b4619-9bae-80ee-bde0-000bb0baa1b2" }),
      indexRow({ group: "profile", title: "profile · 2", content: "2 条稳定画像", keywords: "身份、沟通偏好", id: "1f2e3d4c-5b6a-4798-8654-33221100c3d4" }),
      indexRow({ group: "taste", title: "taste · 18", content: "18 条口味偏好", keywords: "审美、口味", id: "aa11bb22-cc33-4d44-8e55-ff66aa77e5f6" }),
    ];
    const page2 = [
      indexRow({ group: "project", title: "project · 5", content: "5 条项目约定", keywords: "工程约定", id: "0f9e8d7c-6b5a-4433-8211-0099887707a8" }),
      indexRow({ group: "memory", title: "memory · 20", content: "20 条长期记忆", keywords: "事实、结论", id: "12345678-90ab-4cde-8f01-23456789b9c0" }),
      // 向后兼容：旧内联表的标题列叫「清单」→ 取不到「名称」时回退
      indexRow({ group: "memory", title: "旧表行", content: "标题列是清单", titleProp: "清单", id: "deadbeef-1111-4222-8333-4444555566c1" }),
      // 两列都在时「名称」优先
      {
        object: "page",
        id: "cafebabe-2222-4333-8444-5555666677d2",
        properties: {
          名称: { type: "title", title: [{ plain_text: "名称优先" }] },
          清单: { type: "title", title: [{ plain_text: "清单靠后" }] },
          分组: { type: "select", select: { name: "memory" } },
          内容: { type: "rich_text", rich_text: [{ plain_text: "两列都有" }] },
        },
      },
      // 边界行：缺「分组」→ 不带 [分组] 前缀；缺「名称/关键词」→ 不留多余分隔符
      indexRow({ title: "无分组的行", content: "只有标题和内容", id: "01234567-89ab-4cde-8f01-23456789e3e4" }),
      indexRow({ group: "说明", content: "只有分组和内容", id: "76543210-fedc-4ba9-8765-432109870f5a" }),
      // 边界行：拿不到 page id（id 缺失/不是字符串）→ 不加短 id 后缀，也不抛错
      {
        object: "page",
        properties: {
          名称: { type: "title", title: [{ plain_text: "没有页面 id" }] },
          分组: { type: "select", select: { name: "说明" } },
          内容: { type: "rich_text", rich_text: [{ plain_text: "解析不到 id" }] },
        },
      },
      // 边界行：类型不符（内容不是 rich_text、关键词不是数组）→ 两个字段都跳过、整行跳过
      { object: "page", id: "bad0bad0-bad0-4bad-8bad-bad0bad0bad0", properties: { 名称: { title: [] }, 分组: { select: null }, 内容: { number: 1 }, 关键词: "not-an-array" } },
    ];
    const expected = [
      withShortId("[说明] 总览 · 记忆目录的读法与写入时机 · 索引、recall", "413b4619-9bae-80ee-bde0-000bb0baa1b2"),
      withShortId("[profile] profile · 2 · 2 条稳定画像 · 身份、沟通偏好", "1f2e3d4c-5b6a-4798-8654-33221100c3d4"),
      withShortId("[taste] taste · 18 · 18 条口味偏好 · 审美、口味", "aa11bb22-cc33-4d44-8e55-ff66aa77e5f6"),
      withShortId("[project] project · 5 · 5 条项目约定 · 工程约定", "0f9e8d7c-6b5a-4433-8211-0099887707a8"),
      withShortId("[memory] memory · 20 · 20 条长期记忆 · 事实、结论", "12345678-90ab-4cde-8f01-23456789b9c0"),
      withShortId("[memory] 旧表行 · 标题列是清单", "deadbeef-1111-4222-8333-4444555566c1"),
      withShortId("[memory] 名称优先 · 两列都有", "cafebabe-2222-4333-8444-5555666677d2"),
      withShortId("无分组的行 · 只有标题和内容", "01234567-89ab-4cde-8f01-23456789e3e4"),
      withShortId("[说明] 只有分组和内容", "76543210-fedc-4ba9-8765-432109870f5a"),
      "[说明] 没有页面 id · 解析不到 id",
    ].join("\n");
    const server = await fakeNotion(
      () => "ok",
      (n, state) => (state.bodies.at(-1)?.start_cursor ? indexListOf(page2) : indexListOf(page1, "cursor-page-2")),
    );
    const indexDirtyFile = path.join(files.dir, "notion-memory-index.dirty");
    const memory = newMemory(server.baseUrl, {
      indexDataSourceId,
      indexDirtyFile,
      indexTtlMs: 300_000,
    });
    try {
      const first = await memory.indexText();
      assert.equal(first, expected, "每行 `[分组] 标题 · 内容 · 关键词 · #短id`，空字段跳过，行序按返回顺序");
      // 短 id 存在性：有 page id 的行都以 ` · #xxxxxx`（6 位小写）结尾；拿不到 id 的行不加后缀
      const dirLines = first.split("\n");
      assert.equal(dirLines.length, 10, "10 行（9 行有 page id + 1 行没有）");
      for (const line of dirLines.slice(0, 9)) {
        assert.match(line, / · #[0-9a-z]{6}$/, `目录行应以 6 位短 id 结尾：${line}`);
      }
      assert.doesNotMatch(dirLines[9], /#[0-9a-z]{6}$/, `拿不到 page id 时不得加短 id：${dirLines[9]}`);
      assert.equal(new Set(dirLines.slice(0, 9).map((line) => line.split("#").at(-1))).size, 9, "不同 page id 的短 id 不应重复");
      assert.equal(server.requests, 2, "has_more=true 应继续翻页");
      assert.deepEqual(server.methods, ["POST", "POST"], "索引表走 data source query（POST）");
      assert.deepEqual(
        server.paths,
        [`/v1/data_sources/${indexDataSourceId}/query`, `/v1/data_sources/${indexDataSourceId}/query`],
        "不再读页面子块",
      );
      assert.deepEqual(server.bodies[0], { page_size: 100 }, "首页请求体只有 page_size");
      assert.deepEqual(server.bodies[1], { page_size: 100, start_cursor: "cursor-page-2" }, "翻页带 start_cursor");

      assert.equal(await memory.indexText(), first);
      assert.equal(server.requests, 2, "索引缓存 TTL 内不得再发请求");

      // 目录单独返回：不参与打分，也不占记忆的字符预算
      const profiles = [
        { pageId: "p1", id: "mem-1", text: "架构规则：每轮都要在场".repeat(5), kind: "profile", status: "active", source: "pa", scope: "system" },
      ];
      const sel = memory.select(profiles, "深色主题", { maxInjectChars: 10, indexText: first });
      assert.equal(sel.index, first, "目录要原样作为独立字段 index 返回");
      assert.ok(sel.index.length > 10, "目录长度已超过记忆字数上限");
      assert.equal(sel.lines.length, 0, "目录不得挤占记忆条目预算");

      // 写入路径 touch 标记 → 下次读取重新拉取
      fs.writeFileSync(indexDirtyFile, new Date(clock).toISOString(), "utf8");
      assert.equal(await memory.indexText(), first, "清缓存后重拉，同一份数据拼行应一致");
      assert.equal(server.requests, 4, "写入标记应清空索引缓存并重新翻完两页");
    } finally {
      memory.close();
      await server.close();
    }

    // 失败降级：不传 indexDataSourceId → 走内置默认索引表
    assert.equal(
      DEFAULT_INDEX_DATA_SOURCE_ID,
      "413b4619-9bae-80ee-bde0-000bb0ba7fb0",
      "默认值必须是「记忆目录」新表的 data source（旧内联表 acccf805 已归档）",
    );
    const broken = await fakeNotion(() => 500);
    const memory2 = newMemory(broken.baseUrl);
    try {
      assert.equal(await memory2.indexText(), "", "读取失败降级为空字符串");
      assert.equal(broken.requests, 1, "HTTP 500 不重试");
      assert.equal(
        broken.paths[0],
        `/v1/data_sources/${DEFAULT_INDEX_DATA_SOURCE_ID}/query`,
        "不配置时默认查内置索引表 data source",
      );
      assert.ok(
        logs.some((line) => line.includes("记忆目录读取失败")),
        `失败要留一条 warn，实际：${JSON.stringify(logs)}`,
      );
      assert.equal(await memory2.indexText(), "", "冷却期内仍返回空串");
      assert.equal(broken.requests, 1, "失败冷却（60s）内不得每轮重打 Notion");
    } finally {
      memory2.close();
      await broken.close();
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
