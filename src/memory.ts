import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 记忆：Pi 会话文件（短期） + 长期事实库（永久）。
 *
 * 短期记忆就是每个用户的一份 Pi 会话文件（memory/user-<id>.jsonl）。
 * 上下文变长时，压缩由 Pi CLI 在这份文件内部完成；这里不改名、不另起摘要、不把摘要注回提示词。
 * 只有用户明确开新对话时，resetSession 才把当前文件改名挪进 archive/，更早的归档原样保留。
 *
 * 长期事实库：JSONL，由 pi 的 remember/recall/forget 工具直接读写
 * （workspace/.pi/extensions/memory-tools.ts）——**文件路径与格式必须与扩展保持一致**，
 * 这里只负责"按相关性挑选、注入本次对话"和"条目超量时自动合并"。
 */

interface LtEntry {
  id: string;
  t: string;
  text: string;
}

export interface MemoryOptions {
  /** 记忆根目录（<仓库根>/memory） */
  dir: string;
  /** 每次注入的长期记忆字符上限 */
  maxInjectChars?: number;
  /** 注入的相关度门槛（query 二元组被条目覆盖的比例，0-1） */
  minRelevanceScore?: number;
  /** 跑一次纯文本 pi 调用（长期记忆合并用） */
  runText: (prompt: string) => Promise<string>;
  log: (...args: unknown[]) => void;
}

const DEFAULT_INJECT_CHARS = 800; // 每轮注入长期记忆的字符上限
const DEFAULT_MIN_RELEVANCE = 0.2; // 注入的相关度门槛：问题词组被条目覆盖的比例
const LT_MERGE_THRESHOLD = 60; // 超过此条数触发自动合并
const LT_MERGE_TARGET = 40; // 合并后目标条数

export class MemoryStore {
  readonly archiveDir: string;
  private readonly longTermDir: string;
  private readonly opts: MemoryOptions;
  private readonly merging = new Set<string>();

  constructor(opts: MemoryOptions) {
    this.opts = opts;
    this.archiveDir = path.join(opts.dir, "archive");
    this.longTermDir = path.join(opts.dir, "long-term");
    mkdirSync(this.archiveDir, { recursive: true });
    mkdirSync(this.longTermDir, { recursive: true });
  }

  /** 该用户的 Pi 会话文件。不创建、不改名、不估计体积。压缩由 Pi 在这份文件内部完成。 */
  async sessionFor(userId: string): Promise<{ file: string }> {
    return { file: path.join(this.opts.dir, `user-${userId}.jsonl`) };
  }

  /**
   * 新对话：把当前会话文件改名挪进 archive/。
   * 不删除更早的归档，也不写摘要。当前文件不存在时直接返回。
   */
  resetSession(userId: string): void {
    const file = path.join(this.opts.dir, `user-${userId}.jsonl`);
    if (!existsSync(file)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archive = path.join(this.archiveDir, `user-${userId}-${stamp}.jsonl`);
    try {
      renameSync(file, archive);
      this.opts.log(`[memory] 新对话：当前会话已改名归档（${path.basename(archive)}）`);
    } catch (err) {
      this.opts.log("[memory] 归档会话失败:", err instanceof Error ? err.message : err);
    }
  }

  /**
   * 选本次要注入的长期记忆：相关度命中的条目（≥minRelevanceScore）。
   * 不设条数硬线，总字数封顶 maxInjectChars；装不下的按分数从低往高砍。
   */
  select(userId: string, query: string): { lines: string[]; total: number } {
    const entries = this.loadLt(userId);
    if (entries.length === 0) return { lines: [], total: 0 };
    const minScore = Math.max(this.opts.minRelevanceScore ?? DEFAULT_MIN_RELEVANCE, 0.25);
    const scores = rankByQuery(query, entries.map((e) => e.text));
    const top = scores.length ? Math.max(...scores) : 0;
    const cutoff = Math.max(minScore, top * 0.3);
    const picked =
      top < minScore
        ? []
        : entries
            .map((e, i) => ({ e, s: scores[i] ?? 0 }))
            .filter((x) => x.s >= cutoff)
            .sort((a, b) => b.s - a.s)
            .slice(0, 6)
            .map((x) => x.e);

    const maxChars = this.opts.maxInjectChars ?? DEFAULT_INJECT_CHARS;
    const lines: string[] = [];
    let used = 0;
    for (const e of picked) {
      const line = "- " + e.text;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length;
    }
    return { lines, total: entries.length };
  }

  /** 长期记忆超量时自动合并（后台进行，不阻塞回复）。 */
  async mergeIfNeeded(userId: string): Promise<void> {
    if (this.merging.has(userId)) return;
    const entries = this.loadLt(userId);
    if (entries.length <= LT_MERGE_THRESHOLD) return;

    this.merging.add(userId);
    this.opts.log(`[memory] 长期记忆 ${entries.length} 条超过阈值，开始自动合并…`);
    try {
      const prompt =
        `以下是用户的长期记忆条目（JSON 数组）。请合并整理：\n` +
        `1. 合并重复或高度相关的条目，保留全部关键信息（日期、人名、偏好等具体值不能丢）\n` +
        `2. 删除明显过时或相互矛盾的内容（保留较新的）\n` +
        `3. 输出 JSON 数组，每项形如 {"text":"一句完整的话"}，条数控制在 ${LT_MERGE_TARGET} 条以内\n` +
        `只输出 JSON，不要解释、不要代码块标记。\n\n${JSON.stringify(entries.map((e) => e.text))}`;
      const out = await this.opts.runText(prompt);
      const cleaned = out.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
      const parsed = JSON.parse(cleaned) as Array<{ text?: string }>;
      const merged: LtEntry[] = parsed
        .map((x) => String(x?.text ?? "").trim())
        .filter(Boolean)
        .slice(0, LT_MERGE_TARGET)
        .map((t) => ({ id: newId(), t: new Date().toISOString(), text: t }));
      if (merged.length === 0) throw new Error("合并结果为空");
      this.saveLt(userId, merged);
      this.opts.log(`[memory] 合并完成：${entries.length} → ${merged.length} 条`);
    } catch (err) {
      this.opts.log("[memory] 合并失败，保留原记忆：", err instanceof Error ? err.message : err);
    } finally {
      this.merging.delete(userId);
    }
  }

  // ── 长期事实库（路径/格式与 memory-tools 扩展一致）──

  private ltFile(userId: string): string {
    // 文件名规则必须与 memory-tools 扩展一致（两边各自算路径，靠这条约定对齐）
    return path.join(this.longTermDir, `${userId.replace(/[^0-9A-Za-z_-]/g, "") || "unknown"}.jsonl`);
  }

  private loadLt(userId: string): LtEntry[] {
    try {
      const f = this.ltFile(userId);
      if (!existsSync(f)) return [];
      const out: LtEntry[] = [];
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as LtEntry;
          if (e?.text) out.push(e);
        } catch {
          /* 跳过坏行 */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private saveLt(userId: string, entries: LtEntry[]): void {
    writeFileSync(this.ltFile(userId), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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

/** 关键词重叠度（查询二元组被条目覆盖的比例）。 */
export function overlap(query: string, entry: string): number {
  const q = contentBigrams(query);
  if (q.size === 0) return 0;
  const e = contentBigrams(entry);
  let hit = 0;
  for (const g of q) if (e.has(g)) hit++;
  return hit / q.size;
}

/**
 * 对一组候选条目做 IDF 加权相关度：高频词（偏好/处理/问题）权重低，
 * 罕见词权重高。同时要求“整段短语覆盖”或“至少两个独立片段”，
 * 避免只命中一个泛词就注入无关记忆。
 */
export function rankByQuery(query: string, entries: string[]): number[] {
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
