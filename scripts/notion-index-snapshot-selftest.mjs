import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { NotionMemory } from "../src/notion-memory.ts";

/**
 * 记忆目录（索引表）两件事的自测，不碰真实 Notion：
 *  A. 磁盘快照降级链：快照命中、快照损坏按不存在、失败/空返回不覆盖已有快照、脏标记失效内存缓存
 *  B. 目录行重算：条数与关键词统计、行文本生成、0 条分类跳过、文本未变不 PATCH
 */

process.env.NOTION_TOKEN = "selftest-token";
process.env.NOTION_MEMORY_DS = "ds-selftest-memory";
process.env.NOTION_MEMORY_DB = "db-selftest";
process.env.NOTION_INDEX_DS = "ds-selftest-index";
process.env.PI_USER_ID = "notion-index-selftest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-notion-index-"));
const TOKEN = "selftest-token";
const MEMORY_DS = process.env.NOTION_MEMORY_DS;
const INDEX_DS = process.env.NOTION_INDEX_DS;

let passed = 0;
const failures = [];
let logs = [];
const log = (message) => logs.push(message);

const watchdog = setTimeout(() => {
  console.error("FAIL 自测超时（90s）：可能存在连接未释放或重试未收敛");
  process.exit(1);
}, 90_000);
watchdog.unref?.();

async function test(name, fn) {
  logs = [];
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}`);
    console.log(`  ${error instanceof Error ? (error.stack ?? error.message) : error}`);
    for (const line of logs) console.log(`  log| ${line}`);
  }
}

// ── 假 Notion：数据源 query / 页面 PATCH 都由 behavior 决定 ──────────────
function listOf(results, nextCursor = null) {
  return { object: "list", results, has_more: Boolean(nextCursor), next_cursor: nextCursor };
}

function indexRow({ group, title, content, keywords, titleProp = "名称", id = "0a1b2c3d-4e5f-6789-abcd-ef0123450000" }) {
  const richText = (value) => (value === undefined ? [] : [{ type: "text", plain_text: value }]);
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

function memoryRow({ text, kind = "memory", status = "active", keywords, id = "mem-1" }) {
  const richText = (value) => (value === undefined ? [] : [{ type: "text", plain_text: value }]);
  return {
    object: "page",
    id,
    properties: {
      名称: { type: "title", title: richText(text.slice(0, 20)) },
      内容: { type: "rich_text", rich_text: richText(text) },
      ID: { type: "rich_text", rich_text: richText(id) },
      类型: { type: "select", select: { name: kind } },
      状态: { type: "select", select: status === "active" ? { name: "active" } : { name: status } },
      关键词: { type: "rich_text", rich_text: richText(keywords) },
    },
  };
}

async function fakeNotion(behavior, payload = () => listOf([])) {
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
      const action = behavior(state.requests, state);
      if (action === "reset") {
        req.socket.destroy();
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

function workDir(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    snapshotFile: path.join(dir, "notion-memory-index.snapshot.json"),
    dirtyFile: path.join(dir, "notion-memory-index.dirty"),
  };
}

function newMemory(baseUrl, files, extra = {}) {
  return new NotionMemory({
    token: TOKEN,
    dataSourceId: MEMORY_DS,
    baseUrl,
    timeoutMs: 2000,
    connectTimeoutMs: 1000,
    log,
    indexDataSourceId: INDEX_DS,
    indexSnapshotFile: files.snapshotFile,
    indexDirtyFile: files.dirtyFile,
    ...extra,
  });
}

const SNAPSHOT_TEXT = "[memory] memory 3 · 事实与配置 · 3 条事实与配置，逐条见页面正文 · coding｜委派";

/** 手写一份快照（模拟上个进程留下的，用于「已过 N 分钟」与「不覆盖」两条断言） */
function writeSnapshot(file, { fetchedAt, text }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fetchedAt, text }, null, 2) + "\n", "utf8");
}

// ── A. 磁盘快照降级链 ──────────────────────────────────────────────────
async function partA() {
  await test("A1 拉取成功即原子落盘快照（.tmp 已 rename 掉、含 fetchedAt 与 text）", async () => {
    const files = workDir("a1");
    const server = await fakeNotion(
      () => "ok",
      () =>
        listOf([
          indexRow({ group: "memory", title: "memory 3 · 事实与配置", content: "3 条事实与配置，逐条见页面正文", keywords: "coding｜委派" }),
          indexRow({ group: "profile", title: "profile 2 · 每轮必带的架构规则", content: "2 条每轮必带的架构规则，逐条见页面正文", keywords: "Notion｜记忆" }),
        ]),
    );
    const memory = newMemory(server.baseUrl, files);
    try {
      const text = await memory.indexText();
      assert.equal(
        text,
        [
          `${SNAPSHOT_TEXT} · #450000`,
          "[profile] profile 2 · 每轮必带的架构规则 · 2 条每轮必带的架构规则，逐条见页面正文 · Notion｜记忆 · #450000",
        ].join("\n"),
      );
      assert.ok(fs.existsSync(files.snapshotFile), "快照应已落盘");
      assert.ok(!fs.existsSync(`${files.snapshotFile}.tmp`), ".tmp 应已 rename 掉");
      const snapshot = JSON.parse(fs.readFileSync(files.snapshotFile, "utf8"));
      assert.equal(typeof snapshot.fetchedAt, "number", "快照必须含 fetchedAt");
      assert.equal(typeof snapshot.text, "string", "快照必须含 text");
      assert.ok(snapshot.text.includes("[memory] memory 3"), "快照 text 是拼好的目录文本");
    } finally {
      memory.close();
      await server.close();
    }
  });

  await test("A2 网络失败时命中磁盘快照降级，日志带拉取时刻与已过 N 分钟", async () => {
    const files = workDir("a2");
    writeSnapshot(files.snapshotFile, { fetchedAt: Date.now() - 5 * 60_000, text: SNAPSHOT_TEXT });
    const broken = await fakeNotion(() => 500);
    const memory = newMemory(broken.baseUrl, files);
    try {
      assert.equal(await memory.indexText(), SNAPSHOT_TEXT, "网络失败要返回快照文本，不得清空");
      assert.equal(broken.requests, 1, "HTTP 500 不重试");
      const line = logs.find((item) => item.includes("记忆目录来自磁盘快照"));
      assert.ok(line, `应说明目录来自磁盘快照，实际：${JSON.stringify(logs)}`);
      assert.match(line, /记忆目录来自磁盘快照（\d{2}:\d{2} 拉取，已过 5 分钟）/, `日志要点明拉取时刻与时长：${line}`);
      // 失败冷却仍然生效：60s 内不再打 Notion，但仍返回快照
      assert.equal(await memory.indexText(), SNAPSHOT_TEXT);
      assert.equal(broken.requests, 1, "失败冷却（INDEX_FAILURE_TTL_MS）内不得重打 Notion");
    } finally {
      memory.close();
      await broken.close();
    }
  });

  await test("A3 快照损坏（坏 JSON / 字段类型不符 / 空文本）一律按不存在处理，不抛错", async () => {
    const cases = [
      { name: "bad-json", raw: "{ 这不是 JSON", expect: /记忆目录快照读取失败.*按不存在处理/ },
      { name: "bad-type", raw: JSON.stringify({ fetchedAt: "2026-11-01", text: SNAPSHOT_TEXT }), expect: /格式异常.*按不存在处理/ },
      { name: "no-text", raw: JSON.stringify({ fetchedAt: Date.now() }), expect: /格式异常.*按不存在处理/ },
      { name: "blank-text", raw: JSON.stringify({ fetchedAt: Date.now(), text: "   " }), expect: /格式异常.*按不存在处理/ },
    ];
    for (const item of cases) {
      const files = workDir(`a3-${item.name}`);
      fs.writeFileSync(files.snapshotFile, item.raw, "utf8");
      const broken = await fakeNotion(() => 500);
      const memory = newMemory(broken.baseUrl, files);
      try {
        assert.equal(await memory.indexText(), "", `${item.name}：没有可用快照时应返回空串`);
        const line = logs.find((entry) => item.expect.test(entry));
        assert.ok(line, `${item.name} 应打一行日志，实际：${JSON.stringify(logs)}`);
        assert.equal(fs.readFileSync(files.snapshotFile, "utf8"), item.raw, "读失败不得改动快照文件");
      } finally {
        memory.close();
        await broken.close();
      }
    }
  });

  await test("A4 网络失败/本轮空返回都不覆盖已有快照", async () => {
    const files = workDir("a4");
    const old = Date.now() - 60 * 60_000;
    writeSnapshot(files.snapshotFile, { fetchedAt: old, text: SNAPSHOT_TEXT });
    const before = fs.readFileSync(files.snapshotFile, "utf8");

    // 失败：不写
    const broken = await fakeNotion(() => 500);
    const memory = newMemory(broken.baseUrl, files);
    try {
      await memory.indexText();
      assert.equal(fs.readFileSync(files.snapshotFile, "utf8"), before, "拉取失败不得改动快照");
    } finally {
      memory.close();
      await broken.close();
    }

    // 成功但索引表 0 行（空串）：保留旧快照，不覆盖成空串
    const empty = await fakeNotion(
      () => "ok",
      () => listOf([]),
    );
    const memory2 = newMemory(empty.baseUrl, files);
    try {
      assert.equal(await memory2.indexText(), "", "索引表真的空了，本轮就是空串");
      assert.equal(fs.readFileSync(files.snapshotFile, "utf8"), before, "空串不得覆盖已有快照");
      assert.ok(
        logs.some((line) => line.includes("记忆目录本轮为空串，保留原有磁盘快照")),
        `应留一条保留快照的日志，实际：${JSON.stringify(logs)}`,
      );
      // 下一次网络失败仍能拿回旧快照
      const broken2 = await fakeNotion(() => 500);
      const memory3 = newMemory(broken2.baseUrl, files);
      try {
        assert.equal(await memory3.indexText(), SNAPSHOT_TEXT, "旧快照仍在，可继续降级");
      } finally {
        memory3.close();
        await broken2.close();
      }
    } finally {
      memory2.close();
      await empty.close();
    }
  });

  await test("A5 脏标记（mtime 变化）使内存缓存失效并重新拉取", async () => {
    const files = workDir("a5");
    let payload = () =>
      listOf([indexRow({ group: "memory", title: "memory 3 · 事实与配置", content: "3 条事实与配置，逐条见页面正文", keywords: "coding｜委派" })]);
    const server = await fakeNotion(
      () => "ok",
      () => payload(),
    );
    const memory = newMemory(server.baseUrl, files);
    try {
      const first = await memory.indexText();
      assert.equal(server.requests, 1);
      assert.equal(await memory.indexText(), first);
      assert.equal(server.requests, 1, "TTL 内不得重打 Notion");
      payload = () =>
        listOf([indexRow({ group: "memory", title: "memory 4 · 事实与配置", content: "4 条事实与配置，逐条见页面正文", keywords: "coding｜委派｜CA" })]);
      // 模拟 memory-tools 写完记忆后 touch 标记
      fs.writeFileSync(files.dirtyFile, new Date().toISOString(), "utf8");
      const second = await memory.indexText();
      assert.equal(server.requests, 2, "脏标记应清空索引内存缓存并重拉");
      assert.notEqual(second, first, "重拉后应是新目录文本");
      assert.ok(second.includes("memory 4"), `新文本应反映新行：${second}`);
      const snapshot = JSON.parse(fs.readFileSync(files.snapshotFile, "utf8"));
      assert.ok(snapshot.text.includes("memory 4"), "重拉成功也应刷新磁盘快照");
    } finally {
      memory.close();
      await server.close();
    }
  });
}

// ── B. 目录行重算（memory-tools 纯函数 + syncIndexRow）─────────────────
function fakeTimers() {
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  let clock = realNow();
  Date.now = () => clock;
  globalThis.setTimeout = (fn, ms, ...args) => {
    const delay = typeof ms === "number" ? ms : 0;
    if (delay > 0 && delay < 10_000) {
      clock += delay;
      return realSetTimeout(fn, 0, ...args);
    }
    return realSetTimeout(fn, ms, ...args);
  };
  return {
    advance: (ms) => {
      clock += ms;
    },
    restore: () => {
      Date.now = realNow;
      globalThis.setTimeout = realSetTimeout;
    },
  };
}

async function partB() {
  const tools = await import(pathToFileURL(path.join(REPO_ROOT, "workspace/.pi/extensions/memory-tools.ts")).href);
  const { summarizeByKind, buildIndexRowText, syncIndexRow } = tools;
  assert.equal(typeof summarizeByKind, "function");
  assert.equal(typeof buildIndexRowText, "function");
  assert.equal(typeof syncIndexRow, "function");

  const timers = fakeTimers();
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  let stderr = [];

  /**
   * 按路径分发的假 fetch：Memory 库 query / 索引表 query / 页面 PATCH。
   * memoryRows、indexRows 由每个用例决定，PATCH 只记录不落库。
   */
  function installFetch(memoryRows, indexRows) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const method = String(init.method ?? "GET").toUpperCase();
      const parsed = new URL(String(url));
      const pathname = parsed.pathname + parsed.search;
      let body;
      try {
        body = init.body ? JSON.parse(init.body) : undefined;
      } catch {
        body = undefined;
      }
      calls.push({ method, pathname, body });
      if (method === "POST" && pathname === `/v1/data_sources/${MEMORY_DS}/query`) {
        return Response.json(listOf(memoryRows));
      }
      if (method === "POST" && pathname === `/v1/data_sources/${INDEX_DS}/query`) {
        return Response.json(listOf(indexRows));
      }
      if (method === "PATCH" && pathname.startsWith("/v1/pages/")) {
        return Response.json({ object: "page", id: pathname.split("/").at(-1) });
      }
      throw new Error(`自测没有安排这个请求：${method} ${pathname}`);
    };
    return calls;
  }

  try {
    await test("B1 分类统计：跳过 0 条分类、排除 archived、关键词去重且顺序稳定", async () => {
      const entries = [
        { kind: "memory", status: "active", keywords: "coding,委派" },
        { kind: "memory", status: "active", keywords: "委派,CA" },
        { kind: "memory", status: "archived", keywords: "不该出现" },
        { kind: "taste", status: "active", keywords: "汇报风格" },
        { kind: "project", status: "active", keywords: undefined },
      ];
      const summaries = summarizeByKind(entries);
      assert.deepEqual(
        summaries.map((item) => item.kind),
        ["memory", "taste", "project"],
        "0 条分类（profile/context）不得出现在结果里",
      );
      assert.equal(summaries[0].count, 2, "archived 不计入条数");
      assert.equal(summaries[0].keywords, "coding｜委派｜CA", "去重后用「｜」拼接，保持首次出现顺序");
      assert.equal(summaries[1].keywords, "汇报风格");
      assert.equal(summaries[2].keywords, "", "没有关键词就是空串");
      // 顺序稳定：同一份输入跑两次结果完全一致
      assert.deepEqual(summarizeByKind(entries), summaries);
      const shuffled = [entries[1], entries[0], entries[3], entries[4], entries[2]];
      assert.equal(summarizeByKind(shuffled).find((item) => item.kind === "memory").keywords, "委派｜CA｜coding", "顺序跟条目顺序走，规则可复现");
    });

    await test("B2 行文本生成与索引表现有格式一致", async () => {
      const current = { title: "memory 20 · 事实与配置", content: "20 条事实与配置，逐条见页面正文" };
      const next = buildIndexRowText("memory", { count: 21, keywords: "coding｜委派｜CA" }, current);
      assert.deepEqual(next, {
        title: "memory 21 · 事实与配置",
        content: "21 条事实与配置，逐条见页面正文",
        keywords: "coding｜委派｜CA",
      });
      // 行内已有说法以行内为准（不覆盖人手写的文案）
      assert.equal(
        buildIndexRowText("project", { count: 5, keywords: "pi-agent" }, { title: "project 4 · 项目状态", content: "4 条项目状态" }).title,
        "project 5 · 项目状态",
      );
      // 标题里没有说法（只有数字）时用内置说法，不生成 `memory 3 · 3`
      assert.equal(
        buildIndexRowText("memory", { count: 3, keywords: "" }, { title: "memory · 20", content: "20 条长期记忆" }).title,
        "memory 3 · 事实与配置",
      );
      // 内容列沿用该列自己的说法，只换开头的条数（不把「答题方式与做法」改成标题那句）
      assert.equal(
        buildIndexRowText("taste", { count: 19, keywords: "" }, {
          title: "taste 18 · 怎么答、怎么做",
          content: "18 条答题方式与做法，逐条见页面正文",
        }).content,
        "19 条答题方式与做法，逐条见页面正文",
      );
      // 内容列完全没有条数前缀时不动它（不编造文案）
      assert.equal(
        buildIndexRowText("taste", { count: 2, keywords: "" }, { title: "旧表行", content: "只写了说明" }).content,
        "只写了说明",
      );
      // 内容列空着才用内置说法补一句
      assert.equal(
        buildIndexRowText("taste", { count: 2, keywords: "" }, { title: "", content: "" }).content,
        "2 条怎么答、怎么做",
      );
      // 0 条分类根本不进统计 → 调用方无从生成清空行
      assert.equal(summarizeByKind([]).length, 0, "全空时没有任何分类，绝不生成清空行");
    });

    await test("B3 文本未变不 PATCH（幂等）", async () => {
      stderr = [];
      process.stderr.write = (chunk, ...rest) => {
        stderr.push(String(chunk));
        return true;
      };
      const memoryRows = [memoryRow({ text: "偏好深色主题", keywords: "coding,委派", id: "m1" })];
      const indexRows = [
        indexRow({ group: "memory", title: "memory 1 · 事实与配置", content: "1 条事实与配置，逐条见页面正文", keywords: "coding｜委派", id: "idx-memory" }),
      ];
      const calls = installFetch(memoryRows, indexRows);
      const result = await syncIndexRow("memory");
      assert.equal(result, "unchanged");
      assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "文本未变不得 PATCH");
      assert.ok(stderr.join("").includes("未变化"), `应日志说明未变化：${stderr.join("")}`);
    });

    await test("B4 文本变了才 PATCH 该行，且先打印原值", async () => {
      stderr = [];
      process.stderr.write = (chunk, ...rest) => {
        stderr.push(String(chunk));
        return true;
      };
      const memoryRows = [
        memoryRow({ text: "偏好深色主题", keywords: "coding,委派", id: "m1" }),
        memoryRow({ text: "周三交稿", keywords: "CA", id: "m2" }),
      ];
      const indexRows = [
        indexRow({ group: "memory", title: "memory 20 · 事实与配置", content: "20 条事实与配置，逐条见页面正文", keywords: "旧关键词", id: "idx-memory" }),
        indexRow({ group: "profile", title: "profile 2 · 每轮必带的架构规则", content: "2 条每轮必带的架构规则，逐条见页面正文", keywords: "Notion", id: "idx-profile" }),
      ];
      const calls = installFetch(memoryRows, indexRows);
      const result = await syncIndexRow("memory");
      assert.equal(result, "patched");
      const patches = calls.filter((call) => call.method === "PATCH");
      assert.equal(patches.length, 1, "只 PATCH 一次");
      assert.equal(patches[0].pathname, "/v1/pages/idx-memory", "只改「分组=memory」那一行");
      const props = patches[0].body.properties;
      assert.deepEqual(Object.keys(props).sort(), ["名称", "内容", "关键词"].sort(), "只动名称/内容/关键词三类文本属性");
      assert.equal(props["名称"].title[0].text.content, "memory 2 · 事实与配置");
      assert.equal(props["内容"].rich_text[0].text.content, "2 条事实与配置，逐条见页面正文");
      assert.equal(props["关键词"].rich_text[0].text.content, "coding｜委派｜CA");
      const out = stderr.join("");
      assert.ok(out.includes("（原值，回滚用）"), `PATCH 前要打印原值：${out}`);
      assert.ok(out.includes("20 条事实与配置，逐条见页面正文") && out.includes("旧关键词"), `原值内容要完整：${out}`);
      assert.ok(out.includes("已更新"), `更新后要日志：${out}`);
    });

    await test("B5 分组匹配不到/匹配到多行 → 只 log，不新建也不改别的行", async () => {
      stderr = [];
      process.stderr.write = (chunk, ...rest) => {
        stderr.push(String(chunk));
        return true;
      };
      const memoryRows = [memoryRow({ text: "偏好深色主题", keywords: "coding", id: "m1" })];
      // 没有「分组=memory」的行
      let calls = installFetch(memoryRows, [
        indexRow({ group: "profile", title: "profile 2 · 每轮必带的架构规则", content: "2 条每轮必带的架构规则，逐条见页面正文", keywords: "Notion", id: "idx-profile" }),
        indexRow({ group: "说明", title: "总览 · 记忆目录用法", content: "索引用法与统计", keywords: "索引", id: "idx-help" }),
      ]);
      assert.equal(await syncIndexRow("memory"), "skipped", "匹配不到就跳过");
      assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "不得新建或改别的行");
      assert.equal(calls.filter((call) => call.method === "POST" && call.pathname === "/v1/pages").length, 0, "绝不新建行");
      assert.ok(stderr.join("").includes("得到 0 行"), `应日志说明匹配 0 行：${stderr.join("")}`);

      // 同一个分组有两行（重复行）：认不准就不动
      stderr = [];
      calls = installFetch(memoryRows, [
        indexRow({ group: "memory", title: "memory 1 · 事实与配置", content: "1 条事实与配置", keywords: "coding", id: "idx-a" }),
        indexRow({ group: "memory", title: "memory 9 · 事实与配置", content: "9 条事实与配置", keywords: "coding", id: "idx-b" }),
      ]);
      assert.equal(await syncIndexRow("memory"), "skipped", "匹配到多行也跳过");
      assert.equal(calls.filter((call) => call.method === "PATCH").length, 0);
      assert.ok(stderr.join("").includes("得到 2 行"), `应日志说明匹配 2 行：${stderr.join("")}`);
    });

    await test("B6 该分类 0 条 active → 跳过不写（不把行清空）", async () => {
      stderr = [];
      process.stderr.write = (chunk, ...rest) => {
        stderr.push(String(chunk));
        return true;
      };
      const memoryRows = [memoryRow({ text: "只有 memory 条目", keywords: "coding", id: "m1" })];
      const indexRows = [
        indexRow({ group: "context", title: "context 3 · 短期上下文", content: "3 条短期上下文，逐条见页面正文", keywords: "临时", id: "idx-context" }),
      ];
      const calls = installFetch(memoryRows, indexRows);
      assert.equal(await syncIndexRow("context"), "skipped");
      assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "0 条分类不得 PATCH（否则会把行清空）");
      assert.equal(
        calls.filter((call) => call.pathname === `/v1/data_sources/${INDEX_DS}/query`).length,
        0,
        "0 条分类连索引表都不用查",
      );
      assert.ok(stderr.join("").includes("当前 0 条 active"), `应日志说明跳过原因：${stderr.join("")}`);
    });

    await test("B7 旧内联表标题列是「清单」时 PATCH 回「清单」，不动「名称」", async () => {
      stderr = [];
      process.stderr.write = (chunk, ...rest) => {
        stderr.push(String(chunk));
        return true;
      };
      const memoryRows = [memoryRow({ text: "汇报先给结论", kind: "taste", keywords: "汇报风格", id: "m2" })];
      const indexRows = [indexRow({ group: "taste", title: "taste 18 · 怎么答、怎么做", content: "18 条答题方式与做法，逐条见页面正文", keywords: "旧", titleProp: "清单", id: "idx-taste" })];
      const calls = installFetch(memoryRows, indexRows);
      assert.equal(await syncIndexRow("taste"), "patched");
      const patch = calls.find((call) => call.method === "PATCH");
      assert.ok(patch, "应有一次 PATCH");
      assert.deepEqual(Object.keys(patch.body.properties).sort(), ["关键词", "内容", "清单"].sort(), "标题列名跟着真实表结构走");
      assert.equal(patch.body.properties["清单"].title[0].text.content, "taste 1 · 怎么答、怎么做");
    });
  } finally {
    process.stderr.write = realStderrWrite;
    timers.restore();
  }
}

async function main() {
  await partA();
  await partB();
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
