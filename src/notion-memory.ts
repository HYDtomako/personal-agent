import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
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
  /** 单次尝试的总超时（毫秒，默认 3500） */
  timeoutMs?: number;
  /** 建连/TLS 握手超时（毫秒，默认 3000）：丢包时不再干等整轮超时 */
  connectTimeoutMs?: number;
  /** API 根地址（默认 https://api.notion.com；仅自测与代理场景用） */
  baseUrl?: string;
  log?: (message: string) => void;
}

interface NotionPage {
  id: string;
  properties?: Record<string, unknown>;
}

const API_BASE = "https://api.notion.com";
const NOTION_VERSION = "2025-09-03";
const PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 3500;
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const MAX_ATTEMPTS = 3;
/** 网络层异常（不是 429）的指数退避：300ms / 800ms */
const RETRY_DELAYS_MS = [300, 800];

/** 可重试的网络层错误码（连接被重置、建连失败、DNS 抖动等） */
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 日志与注入文案里用的错误描述：错误名 + 错误码 + 消息 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return `${error.name}${code ? ` ${code}` : ""}: ${error.message}`;
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code ?? "";
  if (RETRYABLE_NETWORK_CODES.has(code)) return true;
  // AbortError/TimeoutError（本文件的超时与取消）、TypeError（fetch failed 一类）
  if (error.name === "AbortError" || error.name === "TimeoutError" || error instanceof TypeError) return true;
  return /fetch failed|socket hang up|connect timeout|network/i.test(error.message);
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
  private readonly connectTimeoutMs: number;
  private readonly baseUrl: string;
  private readonly log?: (message: string) => void;
  private agents?: { http: HttpAgent; https: HttpsAgent };

  constructor(opts: NotionMemoryOptions) {
    this.token = opts.token;
    this.dataSourceId = opts.dataSourceId;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.baseUrl = (opts.baseUrl ?? API_BASE).replace(/\/+$/, "");
    this.log = opts.log;
  }

  /** keep-alive 连接池：不再每轮重新 TLS 握手（原来握手偶发 1.5s+）。 */
  private agent(secure: boolean): HttpAgent | HttpsAgent {
    if (!this.agents) {
      const options = { keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 4 };
      this.agents = { http: new HttpAgent(options), https: new HttpsAgent(options) };
    }
    return secure ? this.agents.https : this.agents.http;
  }

  /** 释放连接池（结束时调用；常驻进程不会用到）。 */
  close(): void {
    this.agents?.http.destroy();
    this.agents?.https.destroy();
    this.agents = undefined;
  }

  private send(method: string, pathname: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const url = new URL(`${this.baseUrl}/v1${pathname}`);
    const secure = url.protocol === "https:";
    const port = url.port || (secure ? 443 : 80);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const headers: Record<string, string | number> = {
      Authorization: `Bearer ${this.token}`,
      "Notion-Version": NOTION_VERSION,
      Accept: "application/json",
    };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = payload.length;
    }
    const request = secure ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      let settled = false;
      let totalTimer: ReturnType<typeof setTimeout> | undefined;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const clearTimers = () => {
        if (totalTimer) clearTimeout(totalTimer);
        if (connectTimer) clearTimeout(connectTimer);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(error);
      };
      const req = request(
        { protocol: url.protocol, hostname: url.hostname, port, path: url.pathname + url.search, method, headers, agent: this.agent(secure) },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", fail);
          res.on("end", () => {
            if (settled) return;
            settled = true;
            clearTimers();
            const raw = Buffer.concat(chunks).toString("utf8");
            let json: unknown;
            try {
              json = raw ? JSON.parse(raw) : {};
            } catch {
              json = { message: raw.slice(0, 200) };
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on("error", fail);
      connectTimer = setTimeout(() => {
        const error = new Error(`连接 ${url.host} 超时（${this.connectTimeoutMs}ms）`);
        error.name = "TimeoutError";
        req.destroy(error);
        fail(error);
      }, this.connectTimeoutMs);
      req.on("socket", (socket) => {
        const connected = () => {
          if (connectTimer) clearTimeout(connectTimer);
        };
        if (!socket.connecting) connected();
        else socket.once("connect", connected);
      });
      totalTimer = setTimeout(() => {
        const error = new Error(`${method} ${pathname} 超时（${this.timeoutMs}ms）`);
        error.name = "TimeoutError";
        req.destroy(error);
        fail(error);
      }, this.timeoutMs);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * 单次 API 调用。重试范围：
   *  - 429：保持原有退避（800ms × 次数）
   *  - 网络层异常（连接重置、建连/握手超时、fetch failed 一类）：300ms / 800ms，共 3 次尝试
   * 其它 HTTP 错误（400/401/404/5xx）不重试，直接抛给上层降级。
   */
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const { status, json } = await this.send(method, path, body);
        if (status === 429 && attempt < MAX_ATTEMPTS - 1) {
          const delay = 800 * (attempt + 1);
          this.log?.(`[notion] ${method} ${path} → 429 限流，${delay}ms 后重试（${attempt + 1}/${MAX_ATTEMPTS}）`);
          await sleep(delay);
          continue;
        }
        if (status < 200 || status >= 300) {
          const message = (json as { message?: string } | undefined)?.message ?? "";
          const error = new Error(`${method} ${path} → ${status} ${message}`.trim()) as Error & { status?: number };
          error.status = status;
          throw error;
        }
        return json as T;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        lastError = normalized;
        const status = (normalized as Error & { status?: number }).status;
        if (status !== undefined) throw normalized; // HTTP 错误不重试
        if (!isRetryableNetworkError(normalized) || attempt >= MAX_ATTEMPTS - 1) throw normalized;
        const delay = RETRY_DELAYS_MS[attempt] ?? 800;
        this.log?.(`[notion] ${method} ${path} 网络错误（${describeError(normalized)}），${delay}ms 后重试（${attempt + 1}/${MAX_ATTEMPTS}）`);
        await sleep(delay);
      }
    }
    throw lastError ?? new Error(`${method} ${path} 重试耗尽`);
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

/**
 * 长期记忆的读取缓存：内存（TTL）→ 磁盘快照 → 上层本地冻结归档。
 *
 * 为什么需要它：每轮对话都同步拉全量 data_sources/query，Notion 一抖动整轮就等
 * 8 秒然后降级到 2026-10-22 的冻结归档，用户在界面上什么都看不到。现在的约定：
 *  - TTL 内零请求；TTL 到点先刷新，刷新失败继续用旧数据（只标 stale，绝不清空）
 *  - 每次成功拉取都原子写 data/notion-memory-cache.json（不按时间过期，只被下次覆盖）
 *  - 进程重启后先用快照兜底，再按 TTL 正常刷新
 *  - memory-tools 写完记忆留下 dirty 标记（跨进程只能靠文件），下一轮无视 TTL 立即重拉
 */
export interface NotionMemorySnapshot {
  fetchedAt: number;
  entries: NotionMemoryEntry[];
}

export type NotionMemoryLevel = "network" | "cache" | "snapshot";

export interface NotionMemoryLoad {
  entries: NotionMemoryEntry[];
  /** 本轮数据来自哪一级：network=本轮现拉，cache=内存缓存，snapshot=磁盘快照 */
  level: NotionMemoryLevel;
  /** 条目原本的拉取时间（epoch ms） */
  fetchedAt: number;
  /** 本轮刷新失败、用的旧数据 */
  stale: boolean;
  /** 注入头文案，例如「Notion 快照（10:32 拉取，已过 2 小时），本轮刷新失败」 */
  label: string;
}

export interface NotionMemoryCacheOptions {
  memory: NotionMemory;
  snapshotFile: string;
  dirtyFile: string;
  /** 内存缓存有效期（毫秒，默认 300000 = 5 分钟） */
  ttlMs?: number;
  log?: (message: string) => void;
  /** 便于自测注入时钟 */
  now?: () => number;
}

const DEFAULT_TTL_MS = 300_000;

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** 本地时间 HH:MM（只用于人看的注入文案） */
function clockOf(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 距今多久：刚刚 / N 分钟 / N 小时 / N 天 */
export function formatAge(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时`;
  return `${Math.floor(diff / 86_400_000)} 天`;
}

export class NotionMemoryCache {
  private readonly memory: NotionMemory;
  private readonly snapshotFile: string;
  private readonly dirtyFile: string;
  private readonly ttlMs: number;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private entries?: NotionMemoryEntry[];
  private fetchedAt = 0;
  private source: "network" | "snapshot" = "network";
  private restored = false;
  private inflight?: Promise<NotionMemorySnapshot>;
  private failures = 0;

  constructor(opts: NotionMemoryCacheOptions) {
    this.memory = opts.memory;
    this.snapshotFile = opts.snapshotFile;
    this.dirtyFile = opts.dirtyFile;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  /** 每轮对话开头调用。TTL 内零请求；dirty 标记存在则无视 TTL 立即重拉。 */
  async load(): Promise<NotionMemoryLoad> {
    const now = this.now();
    const dirty = this.dirtyPresent();
    this.restore();

    if (!dirty && this.entries && now - this.fetchedAt < this.ttlMs) {
      return this.result(this.source === "snapshot" ? "snapshot" : "cache", false);
    }

    const reason = dirty
      ? "dirty 标记（记忆刚被写入）"
      : this.entries
        ? `缓存已过期（${clockOf(this.fetchedAt)} 拉取，已过 ${formatAge(this.fetchedAt, now)}）`
        : "首次拉取";
    const started = this.now();
    try {
      const snapshot = await this.refresh();
      const elapsed = this.now() - started;
      this.failures = 0;
      this.entries = snapshot.entries;
      this.fetchedAt = snapshot.fetchedAt;
      this.source = "network";
      this.log(`[memory] Notion 刷新成功：${snapshot.entries.length} 条 active（${reason}；耗时 ${elapsed}ms）`);
      return this.result("network", false);
    } catch (error) {
      this.failures++;
      const elapsed = this.now() - started;
      const detail = describeError(error);
      if (this.entries) {
        const level: NotionMemoryLevel = this.source === "snapshot" ? "snapshot" : "cache";
        this.log(
          `[memory] Notion 刷新失败（${detail}；耗时 ${elapsed}ms；第 ${this.failures} 次），继续用${level === "snapshot" ? "磁盘快照" : "内存缓存"}：` +
            `${clockOf(this.fetchedAt)} 拉取，已过 ${formatAge(this.fetchedAt, this.now())}，本轮标记 stale`,
        );
        return this.result(level, true);
      }
      this.log(`[memory] Notion 刷新失败（${detail}；耗时 ${elapsed}ms）且没有内存缓存/可用快照，降级到本地冻结归档`);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** 拉一次并原子落盘快照；并发调用共用一个请求。 */
  private async refresh(): Promise<NotionMemorySnapshot> {
    if (!this.inflight) {
      this.inflight = (async () => {
        const entries = await this.memory.listActive();
        const snapshot: NotionMemorySnapshot = { fetchedAt: this.now(), entries };
        this.writeSnapshot(snapshot);
        this.clearDirty();
        return snapshot;
      })();
      const clear = () => {
        this.inflight = undefined;
      };
      this.inflight.then(clear, clear);
    }
    return await this.inflight;
  }

  private result(level: NotionMemoryLevel, stale: boolean): NotionMemoryLoad {
    const clock = clockOf(this.fetchedAt);
    const age = formatAge(this.fetchedAt, this.now());
    const label =
      level === "network"
        ? `Notion 权威（${clock} 拉取）`
        : level === "cache"
          ? `Notion 缓存（${clock} 拉取，已过 ${age}）${stale ? "，本轮刷新失败" : ""}`
          : `Notion 快照（${clock} 拉取，已过 ${age}）${stale ? "，本轮刷新失败" : ""}`;
    return { entries: this.entries ?? [], level, fetchedAt: this.fetchedAt, stale, label };
  }

  /** 进程重启后的第一轮：先用磁盘快照把 entries 填上，后续照常按 TTL 刷新。 */
  private restore(): void {
    if (this.restored) return;
    this.restored = true;
    const snapshot = this.readSnapshot();
    if (!snapshot) return;
    this.entries = snapshot.entries;
    this.fetchedAt = snapshot.fetchedAt;
    this.source = "snapshot";
    this.log(
      `[memory] 已从磁盘快照恢复 ${snapshot.entries.length} 条（${clockOf(snapshot.fetchedAt)} 拉取，已过 ${formatAge(snapshot.fetchedAt, this.now())}）`,
    );
  }

  private readSnapshot(): NotionMemorySnapshot | undefined {
    if (!existsSync(this.snapshotFile)) return undefined;
    try {
      const raw = JSON.parse(readFileSync(this.snapshotFile, "utf8")) as Partial<NotionMemorySnapshot>;
      if (typeof raw?.fetchedAt !== "number" || !Number.isFinite(raw.fetchedAt) || !Array.isArray(raw.entries)) {
        this.log(`[memory] 磁盘快照格式异常（${this.snapshotFile}），按不存在处理`);
        return undefined;
      }
      const entries = raw.entries.filter((entry): entry is NotionMemoryEntry => !!entry && typeof (entry as NotionMemoryEntry).text === "string");
      if (raw.entries.length > 0 && entries.length === 0) {
        this.log(`[memory] 磁盘快照内容损坏（${this.snapshotFile}），按不存在处理`);
        return undefined;
      }
      return { fetchedAt: raw.fetchedAt, entries };
    } catch (error) {
      this.log(`[memory] 磁盘快照读取失败（${describeError(error)}），按不存在处理`);
      return undefined;
    }
  }

  /** 先写 .tmp 再 rename：进程被杀也不会留下半个 JSON。 */
  private writeSnapshot(snapshot: NotionMemorySnapshot): void {
    try {
      mkdirSync(path.dirname(this.snapshotFile), { recursive: true });
      const tmp = `${this.snapshotFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
      renameSync(tmp, this.snapshotFile);
    } catch (error) {
      this.log(`[memory] 磁盘快照写入失败（${describeError(error)}）：${this.snapshotFile}`);
    }
  }

  private dirtyPresent(): boolean {
    try {
      return existsSync(this.dirtyFile);
    } catch {
      return false;
    }
  }

  private clearDirty(): void {
    try {
      if (existsSync(this.dirtyFile)) unlinkSync(this.dirtyFile);
    } catch (error) {
      this.log(`[memory] dirty 标记清理失败（${describeError(error)}）：${this.dirtyFile}`);
    }
  }
}

