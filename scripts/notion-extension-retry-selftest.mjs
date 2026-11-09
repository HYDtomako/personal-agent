import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Notion 扩展 call() 重试自测。不打真实 Notion，只 mock 全局 fetch。
 *
 * 覆盖 remember/recall（memory-tools）和 notion_search/notion_read（notion-tools）：
 *  - 网络层错误重试 3 次，退避 300ms / 800ms（含 fetch failed、cause code、AbortError）
 *  - 第 3 次成功则不算失败
 *  - HTTP 500 / 401 / 其它非 429 不重试
 *  - 429 保持原退避：900 / 1800 / 2700ms，最多 4 次
 *  - 失败文案带上 error.cause 的 code 与 message
 */

process.env.NOTION_TOKEN = "selftest-token";
process.env.NOTION_MEMORY_DS = "ds-selftest";
process.env.NOTION_MEMORY_DB = "db-selftest";
process.env.PI_USER_ID = "notion-retry-selftest";

const root = path.resolve(import.meta.dirname, "..");

function loadTools(mod) {
  const tools = {};
  mod.default({
    registerTool(tool) {
      tools[tool.name] = tool;
    },
  });
  return tools;
}

const memoryTools = loadTools(
  await import(pathToFileURL(path.join(root, "workspace/.pi/extensions/memory-tools.ts")).href),
);
const notionTools = loadTools(
  await import(pathToFileURL(path.join(root, "workspace/.pi/extensions/notion-tools.ts")).href),
);

const realNow = Date.now;
const realSetTimeout = globalThis.setTimeout;
let clock = realNow();
Date.now = () => clock;
const delays = [];
globalThis.setTimeout = (fn, ms, ...args) => {
  const n = typeof ms === "number" ? ms : 0;
  if (n > 0 && n < 10_000) {
    delays.push(n);
    clock += n;
    return realSetTimeout(fn, 0, ...args);
  }
  return realSetTimeout(fn, ms, ...args);
};

const watchdog = setTimeout(() => {
  console.error("FAIL 自测超时（30s）：重试可能没有收敛");
  process.exit(1);
}, 30_000);
watchdog.unref?.();

let fetchCount = 0;
let passed = 0;
const failures = [];

function beginCase() {
  delays.length = 0;
  fetchCount = 0;
  clock += 1_000;
}

function installFetch(impl) {
  globalThis.fetch = async (...args) => {
    fetchCount += 1;
    return impl(fetchCount, args);
  };
}

function fetchFailed() {
  const cause = new Error("read ECONNRESET");
  cause.code = "ECONNRESET";
  const error = new TypeError("fetch failed");
  error.cause = cause;
  return error;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textOf(result) {
  return result.content.map((part) => part.text).join("\n");
}

async function test(name, fn) {
  beginCase();
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}`);
    console.log(`  ${error instanceof Error ? error.stack ?? error.message : error}`);
  }
}

async function main() {
  await test("memory 网络错误重试 3 次，文案含 cause", async () => {
    installFetch(() => {
      throw fetchFailed();
    });
    await assert.rejects(
      () => memoryTools.remember.execute("1", { text: "网络重试自测" }),
      (error) => {
        assert.match(error.message, /网络错误/);
        assert.match(error.message, /fetch failed/);
        assert.match(error.message, /ECONNRESET/);
        assert.match(error.message, /read ECONNRESET/);
        assert.equal(error.cause?.cause?.code, "ECONNRESET");
        return true;
      },
    );
    assert.equal(fetchCount, 3);
    assert.deepEqual(delays, [300, 800]);
  });

  await test("memory 网络抖动第 3 次成功", async () => {
    installFetch((n) => {
      if (n < 3) throw fetchFailed();
      return jsonResponse(200, { results: [], has_more: false });
    });
    const result = await memoryTools.recall.execute("1", {});
    assert.equal(fetchCount, 3);
    assert.deepEqual(delays, [300, 800]);
    assert.match(textOf(result), /Notion 长期记忆/);
    assert.doesNotMatch(textOf(result), /读取失败/);
  });

  await test("memory 仅 cause code 为 ECONNRESET 时也重试", async () => {
    installFetch(() => {
      const error = new Error("wrapped transport");
      error.cause = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      throw error;
    });
    const result = await memoryTools.recall.execute("1", {});
    assert.equal(fetchCount, 3);
    assert.deepEqual(delays, [300, 800]);
    assert.match(textOf(result), /ECONNRESET/);
    assert.match(textOf(result), /connection reset/);
  });

  await test("memory AbortError 重试 3 次", async () => {
    installFetch(() => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    });
    const result = await memoryTools.recall.execute("1", {});
    assert.equal(fetchCount, 3);
    assert.deepEqual(delays, [300, 800]);
    assert.match(textOf(result), /AbortError/);
  });

  await test("memory HTTP 500 不重试", async () => {
    installFetch(() => jsonResponse(500, { message: "server blew up" }));
    const result = await memoryTools.recall.execute("1", { query: "主题" });
    assert.equal(fetchCount, 1);
    assert.deepEqual(delays, []);
    assert.match(textOf(result), /500/);
    assert.match(textOf(result), /server blew up/);
    assert.doesNotMatch(textOf(result), /网络错误/);
  });

  await test("memory HTTP 401 不重试", async () => {
    installFetch(() => jsonResponse(401, { message: "unauthorized" }));
    const result = await memoryTools.recall.execute("1", {});
    assert.equal(fetchCount, 1);
    assert.deepEqual(delays, []);
    assert.match(textOf(result), /401/);
    assert.match(textOf(result), /unauthorized/);
  });

  await test("memory HTTP 400 文案含 network 也不重试", async () => {
    installFetch(() => jsonResponse(400, { message: "network is invalid filter" }));
    const result = await memoryTools.recall.execute("1", {});
    assert.equal(fetchCount, 1);
    assert.deepEqual(delays, []);
    assert.match(textOf(result), /400/);
  });

  await test("memory 429 按原退避重试后成功", async () => {
    installFetch((n) =>
      n < 3
        ? jsonResponse(429, { message: "rate limited" })
        : jsonResponse(200, { results: [], has_more: false }),
    );
    const result = await memoryTools.recall.execute("1", {});
    assert.equal(fetchCount, 3);
    assert.deepEqual(delays, [900, 1800]);
    assert.match(textOf(result), /Notion 长期记忆/);
    assert.doesNotMatch(textOf(result), /读取失败/);
  });

  await test("memory 429 四次后失败，不按网络错误重试", async () => {
    installFetch(() => jsonResponse(429, { message: "rate limited" }));
    const result = await memoryTools.recall.execute("1", {});
    assert.equal(fetchCount, 4);
    assert.deepEqual(delays, [900, 1800, 2700]);
    assert.match(textOf(result), /429/);
    assert.doesNotMatch(textOf(result), /网络错误/);
  });

  // ── recall 按目录短 id 精确取回 + 附页面正文 ──
  const PAGE_ID = "11112222-3333-4444-8555-666677778888";
  const SHORT_ID = "778888";

  function memoryPage(id, body, kind = "memory") {
    return {
      object: "page",
      id,
      properties: {
        名称: { title: [{ plain_text: body.slice(0, 30) }] },
        内容: { rich_text: [{ plain_text: body }] },
        ID: { rich_text: [{ plain_text: id }] },
        类型: { select: { name: kind } },
        状态: { select: { name: "active" } },
        时间: { date: { start: "2026-11-01" } },
      },
    };
  }

  function childrenResponse(lines) {
    return {
      object: "list",
      has_more: false,
      results: lines.map((line) => ({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", plain_text: line }] },
      })),
    };
  }

  /** 记忆库 query + 页面子块两个接口的假实现 */
  function installMemoryAndBlocks(pages, children) {
    installFetch((n, args) => {
      const url = String(args[0]);
      if (url.includes("/children")) return children();
      void n;
      return jsonResponse(200, { object: "list", results: pages, has_more: false });
    });
  }

  await test("recall 按短 id 精确取回并附页面正文", async () => {
    installMemoryAndBlocks([memoryPage(PAGE_ID, "用户偏好深色主题")], () =>
      jsonResponse(200, childrenResponse(["来源：pa · memory", "正文第一段：深色主题", "正文第二段：不要高亮"])),
    );
    const result = await memoryTools.recall.execute("1", { id: `#${SHORT_ID}` });
    const out = textOf(result);
    assert.equal(fetchCount, 2, "一次 query + 一次读正文");
    assert.match(out, /用户偏好深色主题/);
    assert.match(out, new RegExp(`#${SHORT_ID}`), "要带上短 id 便于核对");
    assert.match(out, new RegExp(PAGE_ID), "要带上完整 pageId");
    assert.match(out, /页面正文要点/);
    assert.match(out, /正文第一段：深色主题\n正文第二段：不要高亮/, "正文按块顺序、块间换行");
    assert.doesNotMatch(out, /读取失败/);
  });

  await test("recall 用完整 pageId（无连字符/大写）也能命中", async () => {
    installMemoryAndBlocks([memoryPage(PAGE_ID, "用户偏好深色主题")], () =>
      jsonResponse(200, childrenResponse(["正文"])),
    );
    const upper = PAGE_ID.replace(/-/g, "").toUpperCase();
    const result = await memoryTools.recall.execute("1", { id: upper });
    assert.match(textOf(result), /用户偏好深色主题/, "大小写不敏感、连字符可有可无");
  });

  await test("recall id 优先于 query", async () => {
    installMemoryAndBlocks(
      [memoryPage(PAGE_ID, "用户偏好深色主题"), memoryPage("99990000-1111-4222-8333-444455556666", "深色主题相关的另一条")],
      () => jsonResponse(200, childrenResponse(["正文"])),
    );
    const result = await memoryTools.recall.execute("1", { id: SHORT_ID, query: "另一条" });
    const out = textOf(result);
    assert.match(out, /用户偏好深色主题/, "给了 id 就只返回那一条");
    assert.doesNotMatch(out, /深色主题相关的另一条/);
  });

  await test("recall 正文读取失败只降级，不整体失败", async () => {
    installFetch((n, args) => {
      const url = String(args[0]);
      if (url.includes("/children")) return jsonResponse(500, { message: "block blew up" });
      void n;
      return jsonResponse(200, { object: "list", results: [memoryPage(PAGE_ID, "用户偏好深色主题")], has_more: false });
    });
    const result = await memoryTools.recall.execute("1", { id: SHORT_ID });
    const out = textOf(result);
    assert.match(out, /用户偏好深色主题/, "属性列内容照常返回");
    assert.match(out, /页面正文读取失败/);
    assert.match(out, /block blew up/);
    assert.doesNotMatch(out, /已降级到本地只读归档/, "不该走到归档降级");
  });

  await test("recall 正文超长截断到 1500 字", async () => {
    const long = "啊".repeat(2000);
    installMemoryAndBlocks([memoryPage(PAGE_ID, "用户偏好深色主题")], () =>
      jsonResponse(200, childrenResponse([long])),
    );
    const out = textOf(await memoryTools.recall.execute("1", { id: SHORT_ID }));
    assert.match(out, /正文已截断到 1500 字/);
    assert.ok(!out.includes("啊".repeat(1501)), "截断后正文不得超过 1500 字");
  });

  await test("recall id 不存在时给提示且不读正文", async () => {
    installMemoryAndBlocks([memoryPage(PAGE_ID, "用户偏好深色主题")], () => jsonResponse(200, childrenResponse(["正文"])));
    const out = textOf(await memoryTools.recall.execute("1", { id: "#zzzzzz" }));
    assert.match(out, /没有找到 id=/);
    assert.equal(fetchCount, 2, "记忆库 query + 目录表 query，都不该读正文");
  });

  await test("recall 按目录行短 id 取回目录行原文", async () => {
    const IDX_PAGE_ID = "413b4619-9bae-8177-892a-f4e14dd60ecd";
    installFetch((n, args) => {
      const url = String(args[0]);
      if (url.includes("/children")) return jsonResponse(200, childrenResponse(["coding 全派 CA", "浏览器用 ego lite"]));
      if (url.includes("413b4619-9bae-80ee-bde0-000bb0ba7fb0")) {
        return jsonResponse(200, {
          object: "list",
          has_more: false,
          results: [
            {
              object: "page",
              id: IDX_PAGE_ID,
              properties: {
                名称: { title: [{ plain_text: "memory 20" }] },
                分组: { select: { name: "memory" } },
                内容: { rich_text: [{ plain_text: "20 条事实与配置，逐条见页面正文" }] },
                关键词: { rich_text: [{ plain_text: "coding,委派" }] },
              },
            },
          ],
        });
      }
      void n;
      return jsonResponse(200, { object: "list", results: [memoryPage(PAGE_ID, "用户偏好深色主题")], has_more: false });
    });
    const out = textOf(await memoryTools.recall.execute("1", { id: "#d60ecd" }));
    assert.match(out, /这是记忆目录的一行/);
    assert.match(out, /\[memory\] memory 20/);
    assert.match(out, /20 条事实与配置，逐条见页面正文/);
    assert.match(out, /#d60ecd/);
    assert.match(out, /页面正文要点/);
    assert.match(out, /coding 全派 CA/, "目录行正文按块顺序取到");
  });

  await test("recall query 精确命中 ≤3 条时也附正文", async () => {
    installMemoryAndBlocks(
      [
        memoryPage(PAGE_ID, "用户偏好深色主题"),
        memoryPage("99990000-1111-4222-8333-444455556666", "另一条：深色主题的例外"),
      ],
      () => jsonResponse(200, childrenResponse(["正文要点"])),
    );
    const out = textOf(await memoryTools.recall.execute("1", { query: "深色主题" }));
    assert.match(out, /命中 2 条/);
    assert.equal((out.match(/页面正文要点/g) ?? []).length, 2, "两条命中的都要带正文");
    assert.equal(fetchCount, 3, "一次 query + 两条各读一次正文");
  });

  await test("recall query 精确命中 >3 条时不附正文", async () => {
    const many = [1, 2, 3, 4].map((i) =>
      memoryPage(`${i}1112222-3333-4444-8555-666677778888`, `深色主题第 ${i} 条`),
    );
    installMemoryAndBlocks(many, () => jsonResponse(200, childrenResponse(["正文要点"])));
    const out = textOf(await memoryTools.recall.execute("1", { query: "深色主题" }));
    assert.match(out, /命中 4 条/);
    assert.doesNotMatch(out, /页面正文要点/);
    assert.equal(fetchCount, 1, "超过 3 条就只查属性列");
  });

  await test("notion_search 网络错误重试 3 次，文案含 cause", async () => {    installFetch(() => {
      throw fetchFailed();
    });
    await assert.rejects(
      () => notionTools.notion_search.execute("1", { query: "pa-work" }),
      (error) => {
        assert.match(error.message, /网络错误/);
        assert.match(error.message, /fetch failed/);
        assert.match(error.message, /ECONNRESET/);
        assert.match(error.message, /read ECONNRESET/);
        assert.equal(error.cause?.cause?.code, "ECONNRESET");
        return true;
      },
    );
    assert.equal(fetchCount, 3);
    assert.deepEqual(delays, [300, 800]);
  });

  await test("notion_search 非网络异常不重试", async () => {
    installFetch(() => {
      throw new Error("boom");
    });
    await assert.rejects(() => notionTools.notion_search.execute("1", { query: "x" }), /boom/);
    assert.equal(fetchCount, 1);
    assert.deepEqual(delays, []);
  });

  await test("notion_search HTTP 500 不重试", async () => {
    installFetch(() => jsonResponse(500, { message: "upstream" }));
    await assert.rejects(
      () => notionTools.notion_search.execute("1", { query: "x" }),
      (error) => {
        assert.match(error.message, /500/);
        assert.match(error.message, /upstream/);
        assert.doesNotMatch(error.message, /网络错误/);
        return true;
      },
    );
    assert.equal(fetchCount, 1);
    assert.deepEqual(delays, []);
  });

  await test("notion_search HTTP 401 不重试", async () => {
    installFetch(() => jsonResponse(401, { message: "bad token" }));
    await assert.rejects(() => notionTools.notion_search.execute("1", { query: "x" }), /401/);
    assert.equal(fetchCount, 1);
    assert.deepEqual(delays, []);
  });

  await test("notion_search 429 退避后成功", async () => {
    installFetch((n) => (n < 3 ? jsonResponse(429, { message: "rate limited" }) : jsonResponse(200, { results: [] })));
    const result = await notionTools.notion_search.execute("1", { query: "pa-work" });
    assert.equal(fetchCount, 3);
    assert.deepEqual(delays, [900, 1800]);
    assert.match(textOf(result), /没有搜到|搜索结果/);
  });

  await test("notion_read 网络错误信息含 cause", async () => {
    installFetch(() => {
      throw fetchFailed();
    });
    const result = await notionTools.notion_read.execute("1", {
      page_id: "3feb46199bae80399ff5ffa86f5d9002",
    });
    // markdown 失败会再走 blocks，两条路径各自重试 3 次。
    assert.equal(fetchCount, 6);
    assert.deepEqual(delays, [300, 800, 300, 800]);
    assert.match(textOf(result), /fetch failed/);
    assert.match(textOf(result), /ECONNRESET/);
    assert.match(textOf(result), /read ECONNRESET/);
  });

  clearTimeout(watchdog);
  Date.now = realNow;
  globalThis.setTimeout = realSetTimeout;
  console.log(
    `\n${passed}/${passed + failures.length} 通过` + (failures.length ? `，失败：${failures.join("、")}` : ""),
  );
  if (failures.length) process.exit(1);
  console.log("UNIT ALL PASS");
}

main().catch((error) => {
  clearTimeout(watchdog);
  console.error("FAIL 自测异常退出:", error);
  process.exit(1);
});
