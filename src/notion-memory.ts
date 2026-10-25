import { rankByQuery } from "./memory.ts";

/**
 * Notion Memory 数据库读取层。
 *
 * 2026-10-22 起 Notion 是唯一 active 记忆源；本地长期库只读归档。
 * 这里只负责"取 active 条目、按相关性挑选、拼成注入文本"，写入由
 * workspace/.pi/extensions/memory-tools.ts 直接调 Notion API 完成。
 */

export type MemoryKind = "memory" | "taste" | "profile" | "project" | "context";

export interface NotionMemoryEntry {
  pageId: string;
  id: string;
  text: string;
  kind: MemoryKind;
  status: string;
  source: string;
  scope: string;
  date?: string;
  basis?: string;
  keywords?: string;
}

export interface NotionMemoryOptions {
  token: string;
  dataSourceId: string;
  timeoutMs?: number;
}

interface NotionPage {
  id: string;
  properties?: Record<string, unknown>;
}

const API = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";
const PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 8000;

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

function toEntry(page: NotionPage): NotionMemoryEntry | undefined {
  const props = page.properties ?? {};
  const text = textProp(props["内容"]) || textProp(props["名称"]);
  if (!text) return undefined;
  const kind = (selectProp(props["类型"]) || "memory") as MemoryKind;
  return {
    pageId: page.id,
    id: textProp(props["ID"]) || page.id,
    text,
    kind,
    status: selectProp(props["状态"]) || "active",
    source: selectProp(props["来源"]),
    scope: selectProp(props["作用域"]),
    date: dateProp(props["时间"]),
    basis: textProp(props["依据"]) || undefined,
    keywords: textProp(props["关键词"]) || undefined,
  };
}

export class NotionMemory {
  private readonly token: string;
  private readonly dataSourceId: string;
  private readonly timeoutMs: number;

  constructor(opts: NotionMemoryOptions) {
    this.token = opts.token;
    this.dataSourceId = opts.dataSourceId;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(API + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        if (res.status === 429 && attempt < 2) {
          clearTimeout(timer);
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        const json = (await res.json().catch(() => ({}))) as { message?: string };
        if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ""}`);
        return json as T;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`${method} ${path} 被限流`);
  }

  /** 全部 active 条目（含 legacy 无状态页；archived 排除）。 */
  async listActive(): Promise<NotionMemoryEntry[]> {
    const out: NotionMemoryEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.call<{ results?: NotionPage[]; has_more?: boolean; next_cursor?: string }>(
        "POST",
        `/data_sources/${this.dataSourceId}/query`,
        { page_size: PAGE_SIZE, ...(cursor ? { start_cursor: cursor } : {}) },
      );
      for (const item of page.results ?? []) {
        const entry = toEntry(item);
        if (entry && entry.status !== "archived") out.push(entry);
      }
      cursor = page.has_more ? page.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  /**
   * 选本次注入：profile 始终在场，其余按与当前问题二元组覆盖度排序。
   * 总字数封顶 maxInjectChars，装不下的按分数从低往高砍。
   */
  select(
    entries: NotionMemoryEntry[],
    query: string,
    opts: { maxInjectChars?: number; minRelevanceScore?: number } = {},
  ): { lines: string[]; total: number; picked: NotionMemoryEntry[] } {
    const maxChars = opts.maxInjectChars ?? 800;
    const minScore = Math.max(opts.minRelevanceScore ?? 0.25, 0.25);

    const profiles = entries.filter((e) => e.kind === "profile");
    const nonProfiles = entries.filter((e) => e.kind !== "profile");
    const scores = rankByQuery(query, nonProfiles.map((e) => `${e.text} ${e.keywords ?? ""}`));
    const candidates = nonProfiles
      .map((e, i) => ({ e, score: scores[i] ?? 0 }))
      .filter((x) => x.score >= minScore)
      .sort((a, b) => b.score - a.score);
    const topScore = candidates[0]?.score ?? 0;
    const scored =
      topScore < minScore
        ? []
        : candidates.filter((x) => x.score >= Math.max(minScore, topScore * 0.3)).slice(0, 6).map((x) => x.e);

    const picked: NotionMemoryEntry[] = [];
    const lines: string[] = [];
    let used = 0;
    for (const entry of [...profiles, ...scored]) {
      const line = `- [${entry.kind}] ${entry.text}`;
      if (used + line.length > maxChars) continue;
      lines.push(line);
      picked.push(entry);
      used += line.length;
    }
    return { lines, total: entries.length, picked };
  }
}
