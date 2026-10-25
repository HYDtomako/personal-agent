import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeSource, type ReplySource } from "./protocol.ts";

export interface ConversationInput {
  text: string;
  uploadPaths?: string[];
  source?: ReplySource;
  idempotencyKey?: string;
}

export interface ConversationResult {
  reply: string;
  meta?: Record<string, unknown>;
  error?: string;
}

export interface ConversationRequest {
  id: string;
  text: string;
  uploadPaths: string[];
  source: ReplySource;
  idempotencyKey?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  reply?: string;
  meta?: Record<string, unknown>;
  error?: string;
  settledAt?: string;
}

export interface ConversationQueueOptions {
  file: string;
  execute: (request: ConversationRequest) => Promise<ConversationResult>;
  onAccepted?: (request: ConversationRequest) => void;
  onSettled?: (request: ConversationRequest) => Promise<void> | void;
  log?: (message: string) => void;
  now?: () => number;
  /** 等待执行的上限，不包括唯一的 running 请求。默认 100。 */
  maxQueue?: number;
}

const RESTART_ERROR = "PA重启导致本轮中断；已派发后台任务将独立恢复";
const KEEP_TERMINAL = 1000;
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const SETTLEMENT_CONCURRENCY = 4;
const RETRY_MS = 1000;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

type NormalizedInput = Required<Pick<ConversationInput, "text" | "uploadPaths" | "source">> & Pick<ConversationInput, "idempotencyKey">;
type Waiter = { resolve: (request: ConversationRequest) => void; reject: (error: Error) => void };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function errorText(error: unknown): string {
  try {
    const text = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
    return text?.trim() ? text : "未知错误（执行器未提供错误信息）";
  } catch { return "未知错误（错误信息不可序列化）"; }
}

function normalizeInput(input: ConversationInput): NormalizedInput {
  if (!object(input) || typeof input.text !== "string") throw new Error("请求 text 必须是字符串");
  if (input.text.length > 200_000 || input.text.includes("\0")) throw new Error("请求 text 超长（最多 200000 字符）或包含空字节");
  const uploads = input.uploadPaths === undefined ? [] : input.uploadPaths;
  if (!Array.isArray(uploads) || uploads.length > 64 || [...uploads].some((p) => typeof p !== "string" || !p.trim() || p.length > 4096 || p.includes("\0"))) {
    throw new Error("uploadPaths 必须是最多 64 个非空路径，每个最多 4096 字符");
  }
  if (!input.text.trim() && uploads.length === 0) throw new Error("请求文本和附件不能同时为空");
  if (input.source !== undefined && (!object(input.source) || typeof input.source.channel !== "string")) throw new Error("请求 source 无效");
  if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 512 || input.idempotencyKey.includes("\0"))) {
    throw new Error("idempotencyKey 必须是 1–512 字符的非空字符串");
  }
  return {
    text: input.text,
    uploadPaths: [...uploads],
    source: normalizeSource(input.source),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  };
}

function samePayload(a: NormalizedInput, b: NormalizedInput): boolean {
  return a.text === b.text && JSON.stringify(a.uploadPaths) === JSON.stringify(b.uploadPaths) && JSON.stringify(a.source) === JSON.stringify(b.source);
}

function normalizeResult(value: ConversationResult): ConversationResult {
  if (!object(value) || typeof value.reply !== "string") throw new Error("execute 返回值无效：reply 必须是字符串");
  if (value.error !== undefined && (typeof value.error !== "string" || !value.error.trim())) throw new Error("execute 返回值无效：error 必须是非空字符串");
  let meta: Record<string, unknown> | undefined;
  if (value.meta !== undefined) {
    if (!object(value.meta)) throw new Error("execute 返回值无效：meta 必须是 JSON 对象");
    // JSON 快照隔离执行器后续修改；循环引用 / BigInt 会明确失败，不会卡住队列。
    const snapshot: unknown = JSON.parse(JSON.stringify(value.meta));
    if (!object(snapshot)) throw new Error("execute 返回值无效：meta 必须能序列化为 JSON 对象");
    meta = snapshot;
  }
  return { reply: value.reply, ...(meta === undefined ? {} : { meta }), ...(value.error === undefined ? {} : { error: value.error }) };
}

function readRecord(value: unknown): ConversationRequest {
  if (!object(value) || typeof value.id !== "string" || !value.id.trim() || value.id.length > 512 || value.id.includes("\0")) throw new Error("请求 id 无效");
  if (!Array.isArray(value.uploadPaths) || !object(value.source)) throw new Error("请求缺少 uploadPaths/source");
  const input = normalizeInput(value as unknown as ConversationInput);
  if (value.status !== "queued" && value.status !== "running" && !TERMINAL.has(value.status as string)) throw new Error("请求 status 无效");
  if (!timestamp(value.createdAt)) throw new Error("请求 createdAt 无效");
  for (const key of ["startedAt", "finishedAt", "settledAt"]) {
    if (value[key] !== undefined && !timestamp(value[key])) throw new Error(`请求 ${key} 无效`);
  }
  if (value.reply !== undefined && typeof value.reply !== "string") throw new Error("请求 reply 无效");
  if (value.meta !== undefined && !object(value.meta)) throw new Error("请求 meta 无效");
  if (value.error !== undefined && (typeof value.error !== "string" || !value.error.trim())) throw new Error("请求 error 无效");
  const terminal = TERMINAL.has(value.status as string);
  if (terminal && !value.finishedAt) throw new Error("终态请求缺少 finishedAt");
  if (!terminal && ["finishedAt", "reply", "meta", "error", "settledAt"].some((key) => value[key] !== undefined)) throw new Error("未完成请求包含终态字段");
  if (value.status === "running" && !value.startedAt) throw new Error("running 请求缺少 startedAt");
  if (value.status === "queued" && value.startedAt !== undefined) throw new Error("queued 请求不应有 startedAt");
  if (value.status === "completed" && (typeof value.reply !== "string" || value.error !== undefined)) throw new Error("completed 请求结果无效");
  if ((value.status === "failed" || value.status === "cancelled") && !value.error) throw new Error("失败/取消请求缺少原因");
  return { ...value, ...input } as unknown as ConversationRequest;
}

// 两个存储各自独立，不引入第三个共享文件；同目录原子替换，写失败不改变内存快照。
function writeAtomic(file: string, value: unknown): void {
  const content = JSON.stringify(value) + "\n";
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let ownsTemporary = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    ownsTemporary = true;
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    ownsTemporary = false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* 保留原始错误 */ } }
    if (ownsTemporary) { try { unlinkSync(temporary); } catch { /* 保留原始错误 */ } }
  }
  if (process.platform !== "win32") {
    let directoryFd: number | undefined;
    try { directoryFd = openSync(directory, "r"); fsyncSync(directoryFd); } catch { /* 部分文件系统不支持目录 fsync */ }
    finally { if (directoryFd !== undefined) { try { closeSync(directoryFd); } catch { /* rename 已提交 */ } } }
  }
}

/** 一个进程内一个实例独占文件/会话；所有来源共用唯一执行锁。 */
export class ConversationQueue {
  private readonly file: string;
  private readonly execute: ConversationQueueOptions["execute"];
  private readonly onAccepted?: ConversationQueueOptions["onAccepted"];
  private readonly onSettled?: ConversationQueueOptions["onSettled"];
  private readonly log?: ConversationQueueOptions["log"];
  private readonly now: () => number;
  private readonly maxQueue: number;
  private records = new Map<string, ConversationRequest>();
  private keys = new Map<string, string>();
  private waiters = new Map<string, Set<Waiter>>();
  private active = false;
  private scheduled = false;
  private executing = false;
  private fault?: Error;
  private settling = new Set<string>();
  private retryAt = new Map<string, number>();
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor(options: ConversationQueueOptions) {
    if (!options || typeof options.file !== "string" || !options.file.trim() || options.file.includes("\0")) throw new Error("请求队列 file 无效");
    if (typeof options.execute !== "function") throw new Error("请求队列 execute 必须是函数");
    for (const key of ["onAccepted", "onSettled", "log", "now"] as const) {
      if (options[key] !== undefined && typeof options[key] !== "function") throw new Error(`请求队列 ${key} 必须是函数`);
    }
    this.maxQueue = options.maxQueue ?? 100;
    if (!Number.isSafeInteger(this.maxQueue) || this.maxQueue < 1) throw new Error("maxQueue 必须是正整数");
    this.file = path.resolve(options.file);
    this.execute = options.execute;
    this.onAccepted = options.onAccepted;
    this.onSettled = options.onSettled;
    this.log = options.log;
    this.now = options.now ?? Date.now;
    this.load();
    const interrupted = [...this.records.values()].filter((record) => record.status === "running");
    if (interrupted.length) {
      const next = new Map(this.records);
      const finishedAt = this.isoNow();
      for (const record of interrupted) next.set(record.id, { ...record, status: "failed", finishedAt, error: RESTART_ERROR });
      // 必须先保存恢复结果；绝不能重新执行已开始的、有副作用的 PA 请求。
      this.save(next);
    }
  }

  start(): void {
    this.assertHealthy();
    this.active = true;
    this.schedule();
  }

  /** 不杀死正在运行的 worker/hook，也不释放其锁；它们仍可完成持久化。 */
  stop(): void {
    this.active = false;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  submit(input: ConversationInput): ConversationRequest {
    this.assertHealthy();
    const normalized = normalizeInput(input);
    if (normalized.idempotencyKey !== undefined) {
      const id = this.keys.get(normalized.idempotencyKey);
      if (id !== undefined) {
        const existing = this.records.get(id)!;
        if (!samePayload(existing, normalized)) throw new Error("idempotencyKey 冲突：同一个键不能用于不同请求内容");
        return structuredClone(existing);
      }
    }
    if ([...this.records.values()].filter((record) => record.status === "queued").length >= this.maxQueue) {
      throw new Error(`请求队列已满（最多 ${this.maxQueue} 个排队请求），请稍后重试`);
    }
    const record: ConversationRequest = { id: randomUUID(), ...normalized, status: "queued", createdAt: this.isoNow() };
    const next = new Map(this.records);
    next.set(record.id, record);
    this.save(next);
    // onAccepted 是通知而非事务：回调失败不能让调用方以为已持久化的请求未接收。
    try {
      const accepted = this.onAccepted?.(structuredClone(record));
      if (accepted !== undefined) Promise.resolve(accepted).catch((error) => this.report(`onAccepted ${record.id}: ${errorText(error)}`));
    } catch (error) { this.report(`onAccepted ${record.id}: ${errorText(error)}`); }
    this.schedule();
    return structuredClone(record);
  }

  get(id: string): ConversationRequest | undefined {
    const record = this.records.get(id);
    return record === undefined ? undefined : structuredClone(record);
  }

  /** 最新提交的记录优先。 */
  list(limit = 50): ConversationRequest[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("请求 limit 必须是非负整数");
    return limit === 0 ? [] : [...this.records.values()].slice(-limit).reverse().map((record) => structuredClone(record));
  }

  async wait(id: string): Promise<ConversationRequest> {
    const record = this.records.get(id);
    if (!record) throw new Error(`请求不存在：${id}`);
    if (TERMINAL.has(record.status)) return structuredClone(record);
    this.assertHealthy();
    return new Promise((resolve, reject) => {
      const waiters = this.waiters.get(id) ?? new Set<Waiter>();
      waiters.add({ resolve, reject });
      this.waiters.set(id, waiters);
    });
  }

  cancelQueued(reason = "请求已取消（尚未执行）"): number {
    this.assertHealthy();
    if (typeof reason !== "string" || !reason.trim() || reason.length > 10_000) throw new Error("取消原因必须是非空字符串，最多 10000 字符");
    const queued = [...this.records.values()].filter((record) => record.status === "queued");
    if (!queued.length) return 0;
    const next = new Map(this.records);
    const finishedAt = this.isoNow();
    for (const record of queued) next.set(record.id, { ...record, status: "cancelled", error: reason, finishedAt });
    this.save(next);
    for (const record of queued) this.resolveWaiters(next.get(record.id)!);
    this.schedule();
    return queued.length;
  }

  private load(): void {
    let content: string;
    try { content = readFileSync(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`无法读取请求队列 ${this.file}；原文件未覆盖`, { cause: error });
    }
    try {
      const data: unknown = JSON.parse(content);
      if (!object(data) || data.version !== 1 || !Array.isArray(data.requests)) throw new Error("不支持的请求存储格式");
      for (const value of data.requests) {
        const record = readRecord(value);
        if (this.records.has(record.id)) throw new Error(`重复请求 id: ${record.id}`);
        if (record.idempotencyKey !== undefined) {
          if (this.keys.has(record.idempotencyKey)) throw new Error("重复 idempotencyKey");
          this.keys.set(record.idempotencyKey, record.id);
        }
        this.records.set(record.id, record);
      }
    } catch (error) {
      throw new Error(`请求队列损坏或格式不兼容：${this.file}；拒绝覆盖原文件`, { cause: error });
    }
  }

  private isoNow(): string { return new Date(this.now()).toISOString(); }

  private assertHealthy(): void { if (this.fault) throw this.fault; }

  private report(message: string): void {
    try { this.log?.(`[requests] ${message}`); } catch { /* 日志不能影响队列 */ }
  }

  private failClosed(error: unknown): Error {
    if (!this.fault) {
      this.fault = new Error(`请求队列已停止调度，请检查存储后重启：${errorText(error)}`, { cause: error });
      this.stop();
      for (const waiters of this.waiters.values()) for (const waiter of waiters) waiter.reject(this.fault);
      this.waiters.clear();
      this.report(this.fault.message);
    }
    return this.fault;
  }

  private save(next: Map<string, ConversationRequest>): void {
    this.assertHealthy();
    try {
      // 至少保留最近 1000 个终态和 7 天历史。未回执项、幂等键永久保留，避免丢回执/重复副作用。
      const terminal = [...next.values()].filter((record) => TERMINAL.has(record.status));
      const recent = new Set(terminal.slice(-KEEP_TERMINAL).map((record) => record.id));
      const cutoff = this.now() - RETAIN_MS;
      for (const record of terminal) {
        if (!recent.has(record.id) && record.settledAt && record.idempotencyKey === undefined && Date.parse(record.finishedAt!) < cutoff && Date.parse(record.settledAt) < cutoff) next.delete(record.id);
      }
      writeAtomic(this.file, { version: 1, requests: [...next.values()] });
    } catch (error) { throw this.failClosed(error); }
    this.records = next;
    this.keys = new Map([...next.values()].filter((record) => record.idempotencyKey !== undefined).map((record) => [record.idempotencyKey!, record.id]));
  }

  private resolveWaiters(record: ConversationRequest): void {
    const waiters = this.waiters.get(record.id);
    this.waiters.delete(record.id);
    if (waiters) for (const waiter of waiters) waiter.resolve(structuredClone(record));
  }

  private schedule(): void {
    if (!this.active || this.fault || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.active || this.fault) return;
      // 先释放/取得执行锁，再派发独立的回执任务。二者不 await 对方。
      this.pumpExecution();
      if (this.active && !this.fault) this.pumpSettlements();
    });
  }

  private pumpExecution(): void {
    if (this.executing) return;
    const record = [...this.records.values()].find((candidate) => candidate.status === "queued");
    if (!record) return;
    try {
      const running: ConversationRequest = { ...record, status: "running", startedAt: this.isoNow() };
      const next = new Map(this.records);
      next.set(record.id, running);
      this.save(next);
      this.executing = true;
      void this.run(running);
    } catch (error) { this.failClosed(error); }
  }

  private async run(record: ConversationRequest): Promise<void> {
    try {
      let result: ConversationResult;
      try { result = normalizeResult(await this.execute(structuredClone(record))); }
      catch (error) { result = { reply: "", error: `PA请求执行失败：${errorText(error)}` }; }
      // 其他写入失败时本实例已 fail closed；保留盘上的 running，交给重启恢复，绝不重跑。
      this.assertHealthy();
      const terminal: ConversationRequest = { ...record, ...result, status: result.error === undefined ? "completed" : "failed", finishedAt: this.isoNow() };
      const next = new Map(this.records);
      next.set(record.id, terminal);
      this.save(next);
      this.resolveWaiters(terminal);
    } catch (error) { this.failClosed(error); }
    finally { this.executing = false; this.schedule(); }
  }

  private pumpSettlements(): void {
    if (!this.onSettled) return;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    let nextRetry = Infinity;
    for (const record of this.records.values()) {
      if (!this.active || this.fault || this.settling.size >= SETTLEMENT_CONCURRENCY) break;
      if (!TERMINAL.has(record.status) || record.settledAt || this.settling.has(record.id)) continue;
      const due = this.retryAt.get(record.id) ?? 0;
      if (due > Date.now()) { nextRetry = Math.min(nextRetry, due); continue; }
      this.settling.add(record.id);
      void this.settle(record);
    }
    if (Number.isFinite(nextRetry) && this.settling.size < SETTLEMENT_CONCURRENCY) {
      this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.schedule(); }, Math.max(1, nextRetry - Date.now()));
      this.retryTimer.unref();
    }
  }

  private async settle(record: ConversationRequest): Promise<void> {
    try {
      // 回调至少一次；主线程须以 request.id 向 NotificationStore.put 等幂等写入。
      await this.onSettled!(structuredClone(record));
      if (this.fault) return;
      const current = this.records.get(record.id)!;
      const next = new Map(this.records);
      next.set(record.id, { ...current, settledAt: this.isoNow() });
      this.save(next);
      this.retryAt.delete(record.id);
    } catch (error) {
      if (!this.fault) {
        this.retryAt.set(record.id, Date.now() + RETRY_MS);
        this.report(`onSettled ${record.id} 失败，稍后重试：${errorText(error)}`);
      }
    } finally { this.settling.delete(record.id); this.schedule(); }
  }
}
