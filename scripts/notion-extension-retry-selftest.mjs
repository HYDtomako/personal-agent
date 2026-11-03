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

  await test("notion_search 网络错误重试 3 次，文案含 cause", async () => {
    installFetch(() => {
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
