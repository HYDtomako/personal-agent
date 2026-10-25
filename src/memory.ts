import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 记忆：会话窗口（短期） + 长期事实库（永久）。
 *
 * 会话窗口：同一人 windowMs 内的连续消息续接同一个 pi 会话文件（完整上下文）；
 * 过期后旧窗口归档，并惰性压缩成 ≤300 字摘要带入新窗口（只在实际有人回来时才花这次调用）。
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
  /** 上下文窗口 token 数（默认 128k） */
  contextWindow?: number;
  /** 会话累积到窗口的这个比例就触发压缩，默认 0.8 */
  compressAt?: number;
  /** 已弃用：本地使用不再按时间过期 */
  windowMs?: number;
  /** 已弃用：改为按 token 触发，不再看体积 */
  summarizeMinBytes?: number;
  /** 每次注入的长期记忆字符上限 */
  maxInjectChars?: number;
  /** 注入的相关度门槛（query 二元组被条目覆盖的比例，0-1） */
  minRelevanceScore?: number;
  /** 把旧会话压成摘要（pi 无工具调用，由主程序注入） */
  summarize: (sessionFile: string) => Promise<string>;
  /** 跑一次纯文本 pi 调用（长期记忆合并用） */
  runText: (prompt: string) => Promise<string>;
  log: (...args: unknown[]) => void;
}

const DEFAULT_CONTEXT_WINDOW = 128_000; // 上下文窗口 token 数（默认值，可被 config 覆盖）
const DEFAULT_COMPRESS_AT = 0.8; // 会话累积到窗口的这个比例就压缩
const DEFAULT_INJECT_CHARS = 800; // 每轮注入长期记忆的字符上限
const DEFAULT_MIN_RELEVANCE = 0.2; // 注入的相关度门槛：问题词组被条目覆盖的比例
const LT_MERGE_THRESHOLD = 60; // 超过此条数触发自动合并
const LT_MERGE_TARGET = 40; // 合并后目标条数
const SUMMARY_SUFFIX = ".summary.txt"; // 后台预热摘要的落盘后缀（<归档>.summary.txt）
const PREFETCH_WAIT_MS = 90_000; // 预热进行中时，新消息最多等它这么久出摘要，超时这轮不要摘要

export class MemoryStore {
  readonly archiveDir: string;
  private readonly longTermDir: string;
  private readonly opts: MemoryOptions;
  private readonly windows = new Map<string, { file: string; last: number }>();
  private readonly merging = new Set<string>();
  /** 正在进行的后台预热：归档路径 → 摘要 Promise（同一归档不重复跑，同时供下一轮等待） */
  private readonly prefetching = new Map<string, Promise<string>>();
  /** 已经注入过的摘要文件（文件名），同一窗口不重复注入 */
  private readonly consumedSummaries = new Set<string>();

  constructor(opts: MemoryOptions) {
    this.opts = opts;
    this.archiveDir = path.join(opts.dir, "archive");
    this.longTermDir = path.join(opts.dir, "long-term");
    mkdirSync(this.archiveDir, { recursive: true });
    mkdirSync(this.longTermDir, { recursive: true });
  }

  /**
   * 会话文件：本地使用不看时间，只看 token——累积到窗口阈值就归档并压缩，开新窗。
   * 上一轮结束时已由 prefetch 归档并预热好摘要的，这里直接读文件，不再花一次 pi 调用。
   */
  async sessionFor(userId: string): Promise<{ file: string; summary: string }> {
    const file = this.sessionFile(userId);
    const budget = this.budgetTokens();

    // 兜底路径：上一轮结束后的预热没跑（进程刚启动、预热失败等），只能现在同步压缩
    if (existsSync(file) && estimateTokens(file) >= budget) {
      const archive = this.newArchivePath(userId);
      try {
        renameSync(file, archive);
        // 归档同名（同一毫秒）且已有预热摘要时直接用，别再压一遍
        const summary = readSummary(archive) || (await this.opts.summarize(archive));
        if (summary) this.opts.log(`[memory] 窗口达阈值，已压缩（${Math.round(statSync(archive).size / 1024)}KB）`);
        return { file, summary };
      } catch (err) {
        this.opts.log("[memory] 归档/压缩失败:", err instanceof Error ? err.message : err);
      }
    }

    // 会话文件不存在或为空 = 上一轮已被后台预热归档，把它的摘要取来注入（只注入一次）
    const missing = !existsSync(file) || estimateTokens(file) === 0;
    if (!missing) return { file, summary: "" };
    return { file, summary: await this.takePrefetchedSummary(userId) };
  }

  /**
   * 后台预热压缩：本轮对话刚结束时调用（此时 pi 会话的 prompt cache 还热）。
   * 归档 + 压缩都提前做，摘要落盘到 <归档>.summary.txt，下一轮 sessionFor 直接读文件，
   * 不用等到用户开口才同步冷启动——隔几分钟 cache TTL 就过期，同样的调用要贵十倍。
   * 预热只是优化：任何失败只记日志，不抛、不影响主流程。
   */
  async prefetch(userId: string): Promise<void> {
    try {
      const file = this.sessionFile(userId);
      if (!existsSync(file)) return;
      const tokens = estimateTokens(file);
      const budget = this.budgetTokens();
      if (tokens < budget) return;

      const archive = this.newArchivePath(userId);
      // 同一归档不重复跑（重名只可能出现在同一毫秒，这里连同已落盘摘要一起挡掉）
      if (existsSync(archive + SUMMARY_SUFFIX) || this.prefetching.has(archive)) return;

      renameSync(file, archive);
      this.opts.log(`[memory] 后台预热开始：${path.basename(archive)}（约 ${tokens} tok，阈值 ${budget}）`);
      const task = this.summarizeToFile(archive);
      this.prefetching.set(archive, task);
      const done = () => this.prefetching.delete(archive);
      task.then(done, done);
      const summary = await task;
      this.opts.log(
        summary
          ? `[memory] 后台预热完成：${path.basename(archive)}，摘要 ${summary.length} 字符`
          : `[memory] 后台预热未产出摘要：${path.basename(archive)}`,
      );
    } catch (err) {
      this.opts.log("[memory] 后台预热失败:", err instanceof Error ? err.message : err);
    }
  }

  /** 压缩一份归档并把结果落盘；失败返回空串，不抛。 */
  private async summarizeToFile(archive: string): Promise<string> {
    try {
      const summary = (await this.opts.summarize(archive)).trim();
      if (summary) writeFileSync(archive + SUMMARY_SUFFIX, summary, "utf8");
      return summary;
    } catch (err) {
      this.opts.log("[memory] 预热压缩失败:", err instanceof Error ? err.message : err);
      return "";
    }
  }

  /**
   * 取上一轮预热出来的摘要：找该用户最新一份带摘要（或正在预热）的归档；
   * 已注入过就返回空串（同一窗口只注入一次）；预热还在跑就等它，最多等 PREFETCH_WAIT_MS。
   */
  private async takePrefetchedSummary(userId: string): Promise<string> {
    try {
      const latest = this.latestArchived(userId);
      if (!latest) return "";
      const name = path.basename(latest.summaryFile);
      if (this.consumedSummaries.has(name)) return "";

      let summary = readSummary(latest.archive);
      if (!summary) {
        const running = this.prefetching.get(latest.archive);
        if (!running) return "";
        const timeout = new Promise<string>((resolve) => {
          const timer = setTimeout(() => resolve(""), PREFETCH_WAIT_MS);
          timer.unref();
        });
        summary = (await Promise.race([running, timeout])).trim();
      }
      if (!summary) return "";

      this.consumedSummaries.add(name);
      this.opts.log(`[memory] 注入后台预热摘要：${path.basename(latest.archive)}（${summary.length} 字符）`);
      return summary;
    } catch (err) {
      this.opts.log("[memory] 读取预热摘要失败:", err instanceof Error ? err.message : err);
      return "";
    }
  }

  /** 该用户最新一份有摘要、或正在预热的归档（归档名含 ISO 时间戳，按名字排就是按时间排）。 */
  private latestArchived(userId: string): { archive: string; summaryFile: string } | undefined {
    const prefix = `user-${userId}-`;
    const stampTail = /^\d{4}-\d{2}-\d{2}T[\d-]+Z\.jsonl$/;
    let best: { archive: string; summaryFile: string; name: string } | undefined;
    try {
      for (const name of readdirSync(this.archiveDir)) {
        if (!name.startsWith(prefix) || !stampTail.test(name.slice(prefix.length))) continue;
        const archive = path.join(this.archiveDir, name);
        const summaryFile = archive + SUMMARY_SUFFIX;
        if (!existsSync(summaryFile) && !this.prefetching.has(archive)) continue;
        if (!best || name > best.name) best = { archive, summaryFile, name };
      }
    } catch (err) {
      this.opts.log("[memory] 读取归档目录失败:", err instanceof Error ? err.message : err);
      return undefined;
    }
    return best ? { archive: best.archive, summaryFile: best.summaryFile } : undefined;
  }

  private sessionFile(userId: string): string {
    return path.join(this.opts.dir, `user-${userId}.jsonl`);
  }

  /** 归档命名规则：user-<userId>-<ISO 时间戳>.jsonl */
  private newArchivePath(userId: string): string {
    return path.join(this.archiveDir, `user-${userId}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  }

  /** 触发压缩的 token 阈值（contextWindow × compressAt），sessionFor 与 prefetch 共用同一套算法 */
  private budgetTokens(): number {
    const window = this.opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const ratio = this.opts.compressAt ?? DEFAULT_COMPRESS_AT;
    return Math.round(window * ratio);
  }

  /** 新对话：丢弃当前会话窗口（归档而非删除），下次消息从空上下文开始。 */
  resetSession(userId: string): void {
    const file = path.join(this.opts.dir, `user-${userId}.jsonl`);
    this.windows.delete(userId);
    if (!existsSync(file)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archive = path.join(this.archiveDir, `user-${userId}-${stamp}.jsonl`);
    try {
      renameSync(file, archive);
      this.opts.log(`[memory] 新对话：会话窗口已归档（${path.basename(archive)}）`);
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

  /** 清理 24 小时前的归档，控制磁盘占用。 */
  cleanupArchives(): void {
    const cutoff = Date.now() - 24 * 3600_000;
    try {
      for (const f of readdirSync(this.archiveDir)) {
        const p = path.join(this.archiveDir, f);
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      }
    } catch {
      /* ignore */
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

/** 粗估文件 token 数（本地只看量级、够触发即可）：UTF-8 字节数 ÷ 3。 */
function estimateTokens(file: string): number {
  try {
    return Math.round(statSync(file).size / 3);
  } catch {
    return 0;
  }
}

/** 读预热摘要文本；不存在或读不了给空串。 */
function readSummary(archive: string): string {
  try {
    const f = archive + SUMMARY_SUFFIX;
    if (!existsSync(f)) return "";
    return readFileSync(f, "utf8").trim();
  } catch {
    return "";
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
