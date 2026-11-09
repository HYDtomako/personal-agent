/**
 * 「记忆目录」索引行真机核对：只读统计 + dry-run，`--apply [分类]` 才 PATCH（最多一次）。
 *
 * 步骤：
 *  1) 真机 query Memory 库，统计各分类 active 条数与关键词（复用 memory-tools 的 summarizeByKind）；
 *  2) 用同一套 UI 文案规则（memory-tools 的 buildIndexRowText）重算每个分类那一行应有的文本；
 *  3) 与索引表现有行逐项比对（名称/内容/关键词），相同就写「幂等、本轮未写入」；
 *  4) --apply <分类>：走真实 production 路径 syncIndexRow（先打印原值，只写这一行）。
 *
 * 凭据与 id 全部来自运行时：NOTION_TOKEN 优先，其次 ~/.pi/agent/auth.json 的 notion.key；
 * Memory data source 取 NOTION_MEMORY_DS / config.json notion.dataSourceId；
 * 索引表 data source 取 NOTION_INDEX_DS / 代码里的默认值。
 *
 * 用法：
 *   node scripts/notion-index-snapshot-livecheck.mjs                 # 只读
 *   node scripts/notion-index-snapshot-livecheck.mjs --apply project # 真有差异时写这一行
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";
const DEFAULT_INDEX_DATA_SOURCE_ID = "413b4619-9bae-80ee-bde0-000bb0ba7fb0";

function authKey() {
  const fromEnv = (process.env.NOTION_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    const authPath = path.join(process.env.USERPROFILE ?? os.homedir(), ".pi", "agent", "auth.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    return String(auth.notion?.key ?? "").trim();
  } catch {
    return "";
  }
}

function configValue(key) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "config.json"), "utf8"));
    return String(config.notion?.[key] ?? "").trim();
  } catch {
    return "";
  }
}

const TOKEN = authKey();
const MEMORY_DS = (process.env.NOTION_MEMORY_DS ?? "").trim() || configValue("dataSourceId");
const INDEX_DS =
  (process.env.NOTION_INDEX_DS ?? "").trim() || configValue("indexDataSourceId") || DEFAULT_INDEX_DATA_SOURCE_ID;

if (!TOKEN) {
  console.error("FAIL 拿不到 NOTION_TOKEN（环境变量与 ~/.pi/agent/auth.json 都没有 notion.key）");
  process.exit(1);
}
if (!MEMORY_DS) {
  console.error("FAIL 拿不到 Memory data source id（NOTION_MEMORY_DS / config.json notion.dataSourceId）");
  process.exit(1);
}
// memory-tools 在模块加载时读环境变量：先注入，再 import
process.env.NOTION_TOKEN = TOKEN;
process.env.NOTION_MEMORY_DS = MEMORY_DS;
process.env.PI_USER_ID = process.env.PI_USER_ID ?? "livecheck";

const applyIndex = process.argv.indexOf("--apply");
const applyKind = applyIndex >= 0 ? String(process.argv[applyIndex + 1] ?? "").trim() : "";
if (applyIndex >= 0 && (!applyKind || applyKind.startsWith("--"))) {
  console.error("FAIL --apply 必须跟一个分类名（memory/taste/project/profile/context）");
  process.exit(1);
}

async function call(method, apiPath, body) {
  const res = await fetch(NOTION_API + apiPath, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${apiPath} → ${res.status} ${json.message ?? ""}`.trim());
  return json;
}

function plain(rt) {
  if (!Array.isArray(rt)) return "";
  return rt.map((x) => x?.plain_text ?? x?.text?.content ?? "").join("");
}

function textProp(value) {
  if (!value) return "";
  return plain(value.title) || plain(value.rich_text);
}

function selectProp(value) {
  return value?.select?.name ?? "";
}

async function queryAll(dataSourceId) {
  const out = [];
  let cursor;
  do {
    const page = await call("POST", `/data_sources/${dataSourceId}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    out.push(...(page.results ?? []));
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** Memory 库一行 → 与 memory-tools.toEntry 同字段。 */
function toEntry(row) {
  const props = row.properties ?? {};
  return {
    pageId: row.id,
    id: textProp(props["ID"]) || row.id,
    text: textProp(props["内容"]) || textProp(props["名称"]),
    kind: selectProp(props["类型"]) || "memory",
    status: selectProp(props["状态"]) || "active",
    keywords: textProp(props["关键词"]).trim() || undefined,
  };
}

/** 索引表一行 → 名称/内容/关键词/分组（与 memory-tools.toIndexRow 同规则）。 */
function toIndexRow(row) {
  const props = row.properties ?? {};
  return {
    pageId: row.id,
    group: selectProp(props["分组"]).trim(),
    title: ["名称", "清单"].map((name) => textProp(props[name]).trim()).find(Boolean) ?? "",
    titleProp: props["名称"] !== undefined ? "名称" : "清单",
    content: textProp(props["内容"]).trim(),
    keywords: textProp(props["关键词"]).trim(),
  };
}

async function main() {
  const tools = await import(pathToFileURL(path.join(REPO_ROOT, "workspace/.pi/extensions/memory-tools.ts")).href);
  const { summarizeByKind, buildIndexRowText } = tools;

  console.log(`Memory data source：${MEMORY_DS}`);
  console.log(`索引表 data source：${INDEX_DS}`);
  console.log(`模式：${applyKind ? `APPLY（只写 ${applyKind} 这一行）` : "dry-run（只读）"}\n`);

  const memoryRows = await queryAll(MEMORY_DS);
  const indexRows = (await queryAll(INDEX_DS)).map(toIndexRow);
  const entries = memoryRows.map(toEntry);
  const summaries = summarizeByKind(entries);
  const activeTotal = entries.filter((e) => e.status !== "archived").length;

  console.log(`【真机 Memory 库】共 ${memoryRows.length} 行，active ${activeTotal} 条`);
  for (const s of summaries) console.log(`  ${s.kind}: ${s.count} 条`);
  const emptyKinds = ["memory", "taste", "project", "profile", "context"].filter(
    (kind) => !summaries.some((s) => s.kind === kind),
  );
  if (emptyKinds.length) console.log(`  0 条的分类（跳过不写）：${emptyKinds.join("、")}`);
  console.log("");

  console.log(`【索引表】共 ${indexRows.length} 行`);
  for (const row of indexRows) console.log(`  分组=${row.group || "(空)"} pageId=${row.pageId}`);
  console.log("");

  const diffs = [];
  let identical = 0;
  let skipped = 0;
  for (const summary of summaries) {
    const matches = indexRows.filter((row) => row.group === summary.kind);
    if (matches.length !== 1) {
      skipped++;
      console.log(`SKIP ${summary.kind}：分组精确匹配到 ${matches.length} 行（要求恰好 1 行）→ 只 log 不写`);
      continue;
    }
    const row = matches[0];
    const next = buildIndexRowText(summary.kind, summary, row);
    const fields = [
      ["名称", row.title, next.title],
      ["内容", row.content, next.content],
      ["关键词", row.keywords, next.keywords],
    ];
    const changed = fields.filter(([, before, after]) => before !== after);
    console.log(`== ${summary.kind}（真实 ${summary.count} 条 active）`);
    if (changed.length === 0) {
      identical++;
      console.log("   三项都一致 → 幂等、本轮未写入");
      console.log(`   ${row.title} · ${row.content} · ${row.keywords}`);
      continue;
    }
    diffs.push({ kind: summary.kind, row, next });
    for (const [name, before, after] of fields) {
      if (before === after) {
        console.log(`   ${name}：一致（${before || "(空)"}）`);
      } else {
        console.log(`   ${name}：`);
        console.log(`     现有：${before || "(空)"}`);
        console.log(`     重算：${after || "(空)"}`);
      }
    }
  }

  console.log(`\n合计：${summaries.length} 个非空分类，一致 ${identical} 个，待更新 ${diffs.length} 个，跳过 ${skipped} 个`);
  if (diffs.length === 0) {
    console.log("结论：重算结果与现有行文本完全相同 → 幂等、本轮未写入");
    return;
  }
  if (!applyKind) {
    console.log("结论：dry-run 不写入（--apply <分类> 才会 PATCH，且只写一行）");
    return;
  }
  const target = diffs.find((item) => item.kind === applyKind);
  if (!target) {
    console.log(`结论：${applyKind} 没有待更新差异（可能已一致），本轮未写入`);
    return;
  }
  console.log(`\nAPPLY：PATCH ${target.kind} 行 pageId=${target.row.pageId}`);
  console.log(`原值（回滚用）：${target.row.titleProp}=「${target.row.title}」内容=「${target.row.content}」关键词=「${target.row.keywords}」`);
  const result = await tools.syncIndexRow(target.kind);
  console.log(`production 路径 syncIndexRow("${target.kind}") 返回：${result}`);
  const after = (await queryAll(INDEX_DS)).map(toIndexRow).find((row) => row.pageId === target.row.pageId);
  console.log(`写后回读：分组=${after?.group} 名称=「${after?.title}」内容=「${after?.content}」关键词=「${after?.keywords}」`);
  console.log(`与重算结果一致：${after?.title === target.next.title && after?.content === target.next.content && after?.keywords === target.next.keywords}`);
}

/**
 * 磁盘快照真机演练：只传 indexDirtyFile（和 main.ts 一样），快照路径由代码自己推导。
 *  1) 真机拉一次索引表 → 快照落盘 data/notion-memory-index.snapshot.json；
 *  2) 换一个打不通的 baseUrl 再读 → 应降级到这份快照，而不是空串。
 */
async function snapshotDrill() {
  const { NotionMemory } = await import(pathToFileURL(path.join(REPO_ROOT, "src/notion-memory.ts")).href);
  const dirtyFile = path.join(REPO_ROOT, "data", "notion-memory-index.dirty");
  const expected = path.join(REPO_ROOT, "data", "notion-memory-index.snapshot.json");
  const logs = [];
  const shared = { token: TOKEN, dataSourceId: MEMORY_DS, indexDataSourceId: INDEX_DS, indexDirtyFile: dirtyFile, log: (line) => logs.push(line) };

  console.log(`indexDirtyFile：${dirtyFile}`);
  console.log(`推导出的快照路径：${expected}\n`);

  const live = new NotionMemory({ ...shared, timeoutMs: 8000 });
  const text = await live.indexText();
  live.close();
  console.log(`1) 真机拉取目录：${text.length} 字，${text.split("\n").length} 行`);
  for (const line of logs) console.log(`   log| ${line}`);
  if (!fs.existsSync(expected)) {
    console.log(`FAIL 快照没有落盘：${expected}`);
    return;
  }
  const snapshot = JSON.parse(fs.readFileSync(expected, "utf8"));
  console.log(`   快照已落盘：${expected}`);
  console.log(`   fetchedAt=${snapshot.fetchedAt}（${new Date(snapshot.fetchedAt).toISOString()}）text=${snapshot.text.length} 字`);
  console.log(`   .tmp 残留：${fs.existsSync(`${expected}.tmp`)}`);
  console.log(`   快照文本与刚拉的一致：${snapshot.text === text}`);

  logs.length = 0;
  const offline = new NotionMemory({ ...shared, baseUrl: "http://127.0.0.1:9", timeoutMs: 1500, connectTimeoutMs: 1000 });
  const fallback = await offline.indexText();
  offline.close();
  console.log(`\n2) 网络打不通时读目录：${fallback.length} 字`);
  for (const line of logs) console.log(`   log| ${line}`);
  console.log(`   降级到快照且内容一致：${fallback === snapshot.text}`);
  console.log(`   不是空串：${fallback.length > 0}`);
}

if (process.argv.includes("--snapshot")) {
  await snapshotDrill();
} else {
  await main();
}
