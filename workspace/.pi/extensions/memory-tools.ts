/**
 * memory-tools 扩展：长期记忆（Notion 唯一 active 源）。
 *
 * 2026-10-22 起：
 *  - 写入只进 Notion Memory 数据库（Memory 库）。
 *  - recall 默认查 Notion；只有 source=archive 才读本地冻结归档。
 *  - forget 只把页面状态改为 archived，不删除页面。
 *  - 本地 memory/long-term/*.jsonl 是 2026-10-22 前的只读归档，绝不写入。
 *
 * 身份：使用者标识由主程序经 PI_USER_ID 注入；Notion 配置经
 * NOTION_TOKEN / NOTION_MEMORY_DS / NOTION_MEMORY_DB 注入。
 */

interface ExtensionAPI {
  registerTool(tool: ToolRegistration): void;
}

interface ToolRegistration {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
}

import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(MODULE_DIR, "../../..");
const MEM_DIR = path.join(ROOT_DIR, "memory", "long-term");
/** 主进程的 Notion 记忆缓存目录（见 src/notion-memory.ts 的 NotionMemoryCache） */
const CACHE_DIR = path.join(ROOT_DIR, "data");
const CACHE_DIRTY_FILE = path.join(CACHE_DIR, "notion-memory-cache.dirty");

const TOKEN = (process.env.NOTION_TOKEN ?? "").trim();
const DATA_SOURCE_ID = (process.env.NOTION_MEMORY_DS ?? "").trim();
const DATABASE_ID = (process.env.NOTION_MEMORY_DB ?? "").trim();
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";
const TIMEOUT_MS = 15_000;
const MAX_TEXT_LEN = 400;
const SIMILAR_THRESHOLD = 0.7;
const MAX_LIST_LINES = 100;
const KINDS = ["memory", "taste", "project", "profile", "context"] as const;
type Kind = (typeof KINDS)[number];

interface Entry {
  pageId: string;
  id: string;
  text: string;
  kind: Kind;
  status: string;
  source: string;
  scope: string;
  date?: string;
  basis?: string;
  keywords?: string;
}

interface LocalEntry {
  id: string;
  t: string;
  text: string;
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function configured(): string | undefined {
  if (!TOKEN) return "缺少 NOTION_TOKEN，无法访问 Notion 记忆。";
  if (!DATA_SOURCE_ID) return "缺少 NOTION_MEMORY_DS（Notion Memory data source id）。";
  if (!DATABASE_ID) return "缺少 NOTION_MEMORY_DB（Notion Memory database id）。";
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 写入成功后给主进程留标记：下一轮无视 TTL 重新拉一次 Notion。
 * 本扩展跑在 pi 子进程里、主服务是另一个进程，只能靠文件通信；
 * 标记只是优化，写失败不影响记忆本身。
 */
function markCacheDirty(): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_DIRTY_FILE, new Date().toISOString(), "utf8");
  } catch {
    /* 标记失败忽略：最坏情况是缓存多留一个 TTL */
  }
}

/** 字符二元组集合（中文友好，无需分词）。 */
function bigrams(s: string): Set<string> {
  const t = s.replace(/[\s，。：；、！？,.:;!?()（）【】\[\]"'“”‘’]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 查询用的停用词/虚词：去掉它们，避免“日期/怎么/记住”造成假命中。 */
const QUERY_STOP_WORDS = [
  "之前", "现在", "以后", "以前", "为什么", "怎么", "什么", "如何", "哪里", "哪个",
  "这个", "那个", "这些", "那些", "可以", "需要", "应该", "已经", "还是", "或者",
  "而且", "但是", "因为", "所以", "如果", "然后", "一下", "一点", "一些",
  "让我", "让你", "记住", "记得", "告诉", "知道", "觉得", "认为", "时候", "地方", "方式", "办法",
  "我", "你", "他", "她", "它", "的", "了", "吗", "呢", "吧", "啊", "呀", "是", "这", "那", "个",
].sort((a, b) => b.length - a.length);

function contentBigramList(s: string): string[] {
  let t = s
    .toLowerCase()
    .replace(/[\d\s，。：；、！？,.:;!?()（）【】\[\]"'“”‘’\-_/\\|]+/g, "");
  for (const w of QUERY_STOP_WORDS) t = t.split(w).join("");
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    if (!seen.has(g)) {
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}

function contentBigrams(s: string): Set<string> {
  return new Set(contentBigramList(s));
}

function similarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / Math.min(A.size, B.size);
}

function overlap(query: string, entry: string): number {
  const q = contentBigrams(query);
  if (q.size === 0) return 0;
  const e = contentBigrams(entry);
  let hit = 0;
  for (const g of q) if (e.has(g)) hit++;
  return hit / q.size;
}

/** IDF 加权 + 多片段覆盖：避免只命中一个泛词就注入无关记忆。 */
function rankByQuery(query: string, entries: string[]): number[] {
  const qList = contentBigramList(query);
  if (qList.length === 0 || entries.length === 0) return entries.map(() => 0);
  const q = new Set(qList);
  const dfs = new Map<string, number>();
  for (const entry of entries) {
    const seen = new Set<string>();
    for (const g of contentBigrams(entry)) {
      if (!q.has(g) || seen.has(g)) continue;
      seen.add(g);
      dfs.set(g, (dfs.get(g) ?? 0) + 1);
    }
  }
  let total = 0;
  const weights = new Map<string, number>();
  for (const g of qList) {
    const df = dfs.get(g) ?? 0;
    const w = df > 0 ? 1 / Math.log(1 + df) : 0;
    weights.set(g, w);
    total += w;
  }
  if (total === 0) return entries.map(() => 0);
  return entries.map((entry) => {
    const E = contentBigrams(entry);
    let hit = 0;
    let score = 0;
    let runs = 0;
    let prev = false;
    for (const g of qList) {
      const matched = E.has(g);
      if (matched) {
        hit++;
        score += weights.get(g) ?? 0;
        if (!prev) runs++;
      }
      prev = matched;
    }
    const coverage = hit / qList.length;
    const accepted = coverage >= 0.8 || (runs >= 2 && coverage >= 0.5);
    return accepted ? score / total : 0;
  });
}

/** Notion 是云端共享页面：邮箱、密码、令牌不原样写入。 */
function scrub(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[邮箱已隐藏]")
    .replace(/(密码|password|token|app_password|密钥)\s*[:：=]\s*\S+/gi, "$1：[已隐藏]");
}

function plain(rt: unknown): string {
  if (!Array.isArray(rt)) return "";
  return rt
    .map((x) => {
      const item = x as { plain_text?: string; text?: { content?: string } };
      return item.plain_text ?? item.text?.content ?? "";
    })
    .join("");
}

function textProp(value: unknown): string {
  const v = value as { title?: unknown; rich_text?: unknown } | undefined;
  if (!v) return "";
  return plain(v.title) || plain(v.rich_text);
}

function selectProp(value: unknown): string {
  const v = value as { select?: { name?: string } } | undefined;
  return v?.select?.name ?? "";
}

function dateProp(value: unknown): string | undefined {
  const v = value as { date?: { start?: string } } | undefined;
  return v?.date?.start;
}

function toEntry(page: { id: string; properties?: Record<string, unknown> }): Entry | undefined {
  const props = page.properties ?? {};
  const body = textProp(props["内容"]) || textProp(props["名称"]);
  if (!body) return undefined;
  const kind = (selectProp(props["类型"]) || "memory") as Kind;
  return {
    pageId: page.id,
    id: textProp(props["ID"]) || page.id,
    text: body,
    kind: KINDS.includes(kind) ? kind : "memory",
    status: selectProp(props["状态"]) || "active",
    source: selectProp(props["来源"]),
    scope: selectProp(props["作用域"]),
    date: dateProp(props["时间"]),
    basis: textProp(props["依据"]) || undefined,
    keywords: textProp(props["关键词"]) || undefined,
  };
}

let lastCallAt = 0;

async function call<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
  const wait = 320 - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();

  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(NOTION_API + apiPath, {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (res.status === 429 && attempt < 3) {
        clearTimeout(timer);
        await sleep(900 * (attempt + 1));
        continue;
      }
      const json = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(`${method} ${apiPath} → ${res.status} ${json.message ?? ""}`);
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${method} ${apiPath} 被限流`);
}

async function listActive(kind?: Kind): Promise<Entry[]> {
  const out: Entry[] = [];
  let cursor: string | undefined;
  do {
    const page = await call<{ results?: Array<{ id: string; properties?: Record<string, unknown> }>; has_more?: boolean; next_cursor?: string }>(
      "POST",
      `/data_sources/${DATA_SOURCE_ID}/query`,
      { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    );
    for (const item of page.results ?? []) {
      const entry = toEntry(item);
      if (!entry || entry.status === "archived") continue;
      if (kind && entry.kind !== kind) continue;
      out.push(entry);
    }
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return out;
}

function titleOf(text: string): string {
  const t = scrub(text).replace(/\s+/g, " ").trim();
  return t.length > 34 ? t.slice(0, 34) + "…" : t;
}

function scopeOf(source: string, kind: Kind): string {
  if (kind === "profile") return "system";
  if (/Refined-X|博客|站点|Cloudflare|wrangler|og-default/i.test(source)) return "project";
  if (/企鹅主任|napcatqq|QQ ?bot|QQbot|娱乐模式|replyFrequency/i.test(source)) return "project";
  if (/kimi|agent_dispatch|委派|coding agent|\bCA\b/.test(source)) return "project";
  if (/Notion|notion-map|notion_sync/i.test(source)) return "project";
  if (/Telegram|tg-bridge|邮箱|Gmail|邮件|浏览器|browser|ego lite|Chrome|CDP|代理|proxy|v2ray|Shadowrocket|视频|video_subtitle|字幕/i.test(source)) return "pa";
  return "personal";
}

function props(
  entry: { text: string; id: string; t?: string; basis?: string; keywords?: string },
  kind: Kind,
  scope: string,
): Record<string, unknown> {
  return {
    名称: { title: [{ type: "text", text: { content: titleOf(entry.text) } }] },
    内容: { rich_text: [{ type: "text", text: { content: entry.text } }] },
    ID: { rich_text: [{ type: "text", text: { content: entry.id } }] },
    类型: { select: { name: kind } },
    状态: { select: { name: "active" } },
    来源: { select: { name: "pa" } },
    作用域: { select: { name: scope } },
    ...(entry.basis !== undefined
      ? { 依据: { rich_text: entry.basis ? [{ type: "text", text: { content: entry.basis } }] : [] } }
      : {}),
    ...(entry.keywords !== undefined
      ? { 关键词: { rich_text: entry.keywords ? [{ type: "text", text: { content: entry.keywords } }] : [] } }
      : {}),
    ...(entry.t ? { 时间: { date: { start: entry.t } } } : {}),
  };
}

function bodyBlocks(
  entry: { text: string; id: string; t?: string; basis?: string },
  kind: Kind,
): Array<Record<string, unknown>> {
  const line = (content: string) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content } }] },
  });
  return [
    line(`来源：pa · ${kind}${entry.t ? ` · 写入 ${entry.t.slice(0, 10)}` : ""}`),
    line(entry.text),
    ...(entry.basis ? [line(`依据：${entry.basis}`)] : []),
    line(`条目ID：${entry.id}`),
  ];
}

async function rewriteBody(pageId: string, blocks: Array<Record<string, unknown>>): Promise<void> {
  const kids = await call<{ results?: Array<{ id: string }> }>("GET", `/blocks/${pageId}/children?page_size=100`);
  for (const block of kids.results ?? []) await call("DELETE", `/blocks/${block.id}`);
  await call("PATCH", `/blocks/${pageId}/children`, { children: blocks });
}

async function createEntry(text: string, kind: Kind, basis?: string, keywords?: string): Promise<string> {
  const id = newId();
  const now = new Date().toISOString();
  const scope = scopeOf(text, kind);
  await call("POST", "/pages", {
    parent: { database_id: DATABASE_ID },
    properties: props(
      { text, id, t: now, ...(basis ? { basis } : {}), ...(keywords ? { keywords } : {}) },
      kind,
      scope,
    ),
    children: bodyBlocks({ text, id, t: now, ...(basis ? { basis } : {}) }, kind),
  });
  return id;
}

function crossTypeHint(target: Entry, score: number): string {
  return [
    `发现一条相似的 [${target.kind}] 条目（id=${target.id}，相似度 ${score.toFixed(2)}）：`,
    `"${target.text}"`,
    "",
    "先不要重复新建。请判断：",
    `1) 同一件事，只是类型判断不同 → merge_with:"${target.id}"（合并/改类型）`,
    `2) 事实与原则/依据的关系 → link_to:"${target.id}"（新建并关联）`,
    "3) 确实是新增信息 → force_new:true",
  ].join("\n");
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function currentUser(): string {
  return (process.env.PI_USER_ID ?? "").trim();
}

function archiveFile(userId: string): string {
  return path.join(MEM_DIR, `${userId.replace(/[^0-9A-Za-z_-]/g, "") || "unknown"}.jsonl`);
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as Record<string, unknown>;
      if (typeof item.text === "string" && item.text) out.push(item);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

/** 本地只读归档：2026-10-22 前的长期记忆，默认不读。 */
function readArchive(query: string, kind?: Kind): Entry[] {
  const userId = currentUser();
  const main = readJsonl(archiveFile(userId)) as unknown as LocalEntry[];
  const tasteFile = path.join(MEM_DIR, "taste.jsonl");
  const tasteIds = new Set(
    readJsonl(tasteFile)
      .map((x) => String(x.id ?? ""))
      .filter(Boolean),
  );
  const entries: Entry[] = main.map((e) => ({
    pageId: "",
    id: e.id,
    text: e.text,
    kind: (tasteIds.has(e.id) ? "taste" : "memory") as Kind,
    status: "archive",
    source: "本地归档",
    scope: "",
    date: e.t,
  }));
  const filtered = entries.filter((e) => !kind || e.kind === kind);
  if (!query) return filtered;
  const exact = query.length >= 2 ? filtered.filter((e) => e.text.includes(query)) : [];
  if (exact.length > 0) return exact.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const scores = rankByQuery(query, filtered.map((e) => e.text));
  const top = scores.length ? Math.max(...scores) : 0;
  if (top < 0.25) return [];
  return filtered
    .map((e, i) => ({ e, s: scores[i] ?? 0 }))
    .filter((x) => x.s >= Math.max(0.25, top * 0.3))
    .sort((a, b) => b.s - a.s)
    .slice(0, 20)
    .map((x) => x.e);
}

function formatEntries(entries: Entry[], total: number, label: string, query: string, totalLabel = "active"): string {
  if (entries.length === 0) {
    return `${label}里没有找到${query ? `含「${query}」的` : ""}条目（共 ${total} 条 ${totalLabel}）。`;
  }
  const lines = entries.slice(0, MAX_LIST_LINES).map(
    (e) => `- [${e.kind}] ${e.id} | ${e.text}${e.basis ? `（依据：${e.basis}）` : ""}${e.date ? `（${e.date.slice(0, 10)}）` : ""}`,
  );
  const more = entries.length > MAX_LIST_LINES ? `\n（只列前 ${MAX_LIST_LINES} 条，共 ${entries.length} 条命中）` : "";
  return `${label}（共 ${total} 条 ${totalLabel}；命中 ${entries.length} 条）：\n${lines.join("\n")}${more}`;
}

const SCHEMA_REMEMBER = {
  type: "object",
  properties: {
    text: { type: "string", description: "要长期记住的事实（一句话，不超过 400 字）" },
    kind: {
      type: "string",
      enum: KINDS,
      description: "类型：memory=事实/安排（默认）；taste=稳定偏好/审美/价值观；project=项目状态；profile=每轮必带的架构规则（少用）；context=短期上下文",
    },
    merge_with: {
      type: "string",
      description: "跨类型相似且其实是同一件事时：合并到已有条目的 id 或 page id，更新该条目的类型和内容",
    },
    link_to: {
      type: "string",
      description: "跨类型相关但不重复时：新建本条目并关联到目标条目的 id 或 page id，写入 依据 字段",
    },
    force_new: {
      type: "boolean",
      description: "确定是新增信息时跳过跨类型相似检查；不要用它绕过真正的重复",
    },
    keywords: {
      type: "string",
      description: "可选：2-5 个检索关键词，逗号分隔（项目名、主题、同义说法）。taste/project 条目建议填；不写进原则正文",
    },
  },
  required: ["text"],
};

const SCHEMA_RECALL = {
  type: "object",
  properties: {
    query: { type: "string", description: "可选：检索关键词，不填则列出全部" },
    kind: { type: "string", enum: KINDS, description: "可选：只查某一类" },
    source: {
      type: "string",
      enum: ["notion", "archive"],
      description: "默认 notion；只有 Notion 找不到且用户问 2026-10-22 前旧事时，才用 archive 读本地只读归档",
    },
  },
  required: [],
};

const SCHEMA_FORGET = {
  type: "object",
  properties: {
    target: { type: "string", description: "要归档的记忆 id、页面 id 或文本片段" },
    reason: { type: "string", description: "可选：归档原因（会写进页面正文）" },
  },
  required: ["target"],
};

export default function memoryToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "remember",
    label: "Remember",
    description: "把一条事实/偏好写入 Notion 长期记忆库；会跨类型查重，避免 memory 与 taste 各存一份。",
    promptSnippet: "remember: persist a fact to Notion memory",
    promptGuidelines: [
      "当胡同学说\"记住…\"\"以后记得…\"\"别忘了…\"\"帮我留个心眼\"时调用；写入后简短确认已记住。",
      "Notion 是唯一 active 记忆源；本地 memory/long-term 已冻结，绝不要写本地 JSONL。",
      "只记明确要求记的、或明显长期有效的事实（身份、偏好、长期安排）。不要记普通闲聊、一次性问题、临时信息。",
      "kind 默认 memory；稳定的偏好/审美/价值观用 taste；项目状态用 project；需要每轮在场的架构规则用 profile（少用）。",
      "taste 写判断标准/偏好本身，不要把 memory 事实原句再存一遍；一条内容能被 memory 完全推出时，不单独建 taste。",
      "taste/project 条目尽量给 keywords（2-5 个检索词，逗号分隔：项目名、主题、同义说法），用于找回；不要把它写进原则正文。",
      "remember 会先查全部 active 条目：同类型高度相似自动更新；跨类型高度相似会返回候选，不要直接重复新建。",
      "跨类型候选：同一件事只是类型判断不同 → merge_with 合并/改类型；事实与原则/依据的关系 → link_to 新建并关联；确实新增 → force_new。",
      "敏感凭据（密码、token、完整邮箱）不要写入长期记忆；会被打码。",
    ],
    parameters: SCHEMA_REMEMBER,
    async execute(_id, params) {
      const problem = configured();
      if (problem) return text(problem);
      const raw = scrub(String(params.text ?? "").trim());
      if (!raw) return text("要记住的内容为空。");
      if (raw.length > MAX_TEXT_LEN) return text(`内容太长（${raw.length} 字），请压缩到 ${MAX_TEXT_LEN} 字以内。`);
      const kind = KINDS.includes(params.kind as Kind) ? (params.kind as Kind) : "memory";
      const now = new Date().toISOString();
      const entries = await listActive();
      const findTarget = (target: string) =>
        entries.find(
          (e) => e.id === target || e.pageId === target || e.pageId.replace(/-/g, "") === target,
        );
      const mergeWith = String(params.merge_with ?? "").trim();
      const linkTo = String(params.link_to ?? "").trim();
      const keywords = String(params.keywords ?? "").trim();

      if (mergeWith) {
        const target = findTarget(mergeWith);
        if (!target) return text(`没有找到要合并的条目：${mergeWith}`);
        const scope = kind === "profile" ? "system" : target.scope || scopeOf(raw, kind);
        const basis = target.basis;
        const mergedKeywords = keywords || target.keywords;
        await call("PATCH", `/pages/${target.pageId}`, {
          properties: props(
            {
              text: raw,
              id: target.id,
              t: now,
              ...(basis ? { basis } : {}),
              ...(mergedKeywords ? { keywords: mergedKeywords } : {}),
            },
            kind,
            scope,
          ),
        });
        await rewriteBody(
          target.pageId,
          bodyBlocks({ text: raw, id: target.id, t: now, ...(basis ? { basis } : {}) }, kind),
        );
        markCacheDirty();
        return text(`已合并到原有条目（${kind}，id=${target.id}）：\n旧：${target.text}\n新：${raw}`);
      }

      if (linkTo) {
        const target = findTarget(linkTo);
        if (!target) return text(`没有找到要关联的条目：${linkTo}`);
        const basis = target.id || target.pageId;
        const id = await createEntry(raw, kind, basis, keywords || undefined);
        markCacheDirty();
        return text(`已新建并关联（${kind}，id=${id}）→ [${target.kind}] ${basis}：${raw}`);
      }

      if (!params.force_new) {
        const exact = entries.find((e) => e.text === raw);
        if (exact) {
          if (exact.kind === kind) return text(`这条已经在记忆里了（${kind}，id=${exact.id}）：${raw}`);
          return text(crossTypeHint(exact, 1));
        }
        const best = entries.map((e) => ({ e, s: similarity(e.text, raw) })).sort((a, b) => b.s - a.s)[0];
        if (best && best.s >= SIMILAR_THRESHOLD) {
          if (best.e.kind === kind) {
            const scope = best.e.scope || scopeOf(raw, kind);
            const basis = best.e.basis;
            const mergedKeywords = keywords || best.e.keywords;
            await call("PATCH", `/pages/${best.e.pageId}`, {
              properties: props(
                {
                  text: raw,
                  id: best.e.id,
                  t: now,
                  ...(basis ? { basis } : {}),
                  ...(mergedKeywords ? { keywords: mergedKeywords } : {}),
                },
                kind,
                scope,
              ),
            });
            await rewriteBody(
              best.e.pageId,
              bodyBlocks({ text: raw, id: best.e.id, t: now, ...(basis ? { basis } : {}) }, kind),
            );
            markCacheDirty();
            return text(`已更新原有 Notion 记忆条目（${kind}，id=${best.e.id}）：\n旧：${best.e.text}\n新：${raw}`);
          }
          return text(crossTypeHint(best.e, best.s));
        }
      }

      const id = await createEntry(raw, kind, undefined, keywords || undefined);
      markCacheDirty();
      return text(`已写入 Notion（${kind}，id=${id}）：${raw}`);
    },
  });

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "查询 Notion 长期记忆库（默认列出全部，可按关键词/类型检索）；必要时可读本地只读归档。",
    promptSnippet: "recall: search Notion long-term memory",
    promptGuidelines: [
      "胡同学问\"你记得我什么\"\"我让你记过什么\"时调用；需要确认某个久远事实时也可以主动查。",
      "默认查 Notion；注入到对话里的只是相关的一部分，怀疑有没显示的条目时先用它检索，不要直接说\"不记得\"。",
      "只有 Notion 里找不到、且胡同学问的是 2026-10-22 之前的旧事时，才传 source=archive 查本地归档。",
    ],
    parameters: SCHEMA_RECALL,
    async execute(_id, params) {
      const query = String(params.query ?? "").trim();
      const kind = KINDS.includes(params.kind as Kind) ? (params.kind as Kind) : undefined;
      const source = String(params.source ?? "notion");
      if (source === "archive") {
        const entries = readArchive(query, kind);
        const total = readJsonl(archiveFile(currentUser())).length;
        return text(formatEntries(entries, total, "本地只读归档（2026-10-22 前）", query, "归档"));
      }
      const problem = configured();
      if (problem) {
        const entries = readArchive(query, kind);
        const total = readJsonl(archiveFile(currentUser())).length;
        return text(`${problem}\n已降级到本地只读归档。\n${formatEntries(entries, total, "本地只读归档（2026-10-22 前）", query, "归档")}`);
      }
      try {
        const entries = await listActive(kind);
        if (!query) {
          const sorted = [...entries].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
          return text(formatEntries(sorted, entries.length, "Notion 长期记忆", query));
        }
        // 先精确包含；没有再按内容词重叠度取前 20，避免日期/虚词把无关条目带进来。
        const exact = query.length >= 2 ? entries.filter((e) => e.text.includes(query) || (e.keywords ?? "").includes(query)) : [];
        if (exact.length > 0) {
          const sorted = exact.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
          return text(formatEntries(sorted, entries.length, "Notion 长期记忆", query));
        }
        const scores = rankByQuery(
          query,
          entries.map((e) => `${e.text} ${e.keywords ?? ""}`),
        );
        const top = scores.length ? Math.max(...scores) : 0;
        const hit =
          top < 0.25
            ? []
            : entries
                .map((e, i) => ({ e, score: scores[i] ?? 0 }))
                .filter((x) => x.score >= Math.max(0.25, top * 0.3))
                .sort((a, b) => b.score - a.score)
                .slice(0, 20)
                .map((x) => x.e);
        return text(formatEntries(hit, entries.length, "Notion 长期记忆", query));
      } catch (error) {
        const entries = readArchive(query, kind);
        const total = readJsonl(archiveFile(currentUser())).length;
        return text(
          `Notion 读取失败：${error instanceof Error ? error.message : error}\n已降级到本地只读归档。\n${formatEntries(entries, total, "本地只读归档（2026-10-22 前）", query, "归档")}`,
        );
      }
    },
  });

  pi.registerTool({
    name: "forget",
    label: "Forget",
    description: "把 Notion 长期记忆条目归档（软删除，页面保留可恢复）。",
    promptSnippet: "forget: archive an entry in Notion memory",
    promptGuidelines: [
      "胡同学说\"忘掉…\"\"删掉那条记忆\"时调用；归档前把将归档的条目原文复述给他确认。",
      "这是归档不是物理删除：只把状态改成 archived，页面保留；不要直接调 Notion API 删页面。",
      "如果条目之间有矛盾，优先归档旧条；不要按命中频率删。",
    ],
    parameters: SCHEMA_FORGET,
    async execute(_id, params) {
      const problem = configured();
      if (problem) return text(problem);
      const target = String(params.target ?? "").trim();
      if (!target) return text("要归档哪条？给我 id 或文本片段。");
      const reason = String(params.reason ?? "").trim();
      const entries = await listActive();
      const hit = entries.filter((e) => e.id === target || e.pageId === target || e.pageId.replace(/-/g, "") === target || e.text.includes(target));
      if (hit.length === 0) return text(`没有匹配「${target}」的 active 记忆条目。`);
      const stamp = new Date().toISOString();
      for (const entry of hit) {
        await call("PATCH", `/pages/${entry.pageId}`, { properties: { 状态: { select: { name: "archived" } } } });
        await call("PATCH", `/blocks/${entry.pageId}/children`, {
          children: [
            {
              object: "block",
              type: "paragraph",
              paragraph: {
                rich_text: [
                  {
                    type: "text",
                    text: { content: `归档：${stamp}（来源：pa）${reason ? `；原因：${reason}` : ""}` },
                  },
                ],
              },
            },
          ],
        });
      }
      markCacheDirty();
      return text(`已归档 ${hit.length} 条（页面保留，可恢复）：\n${hit.map((e) => `- [${e.kind}] ${e.text}`).join("\n")}`);
    },
  });
}
