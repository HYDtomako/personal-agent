import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeSource, type ReplySource } from "./protocol.ts";

export interface NotificationRecord {
  id: string;
  source: ReplySource;
  text: string;
  kind: "reply" | "job" | "attention";
  createdAt: string;
  ackedAt?: string;
}

export interface NotificationStoreOptions {
  file: string;
  now?: () => number;
}

export type NotificationInput = Pick<NotificationRecord, "id" | "source" | "text" | "kind">;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function normalizeInput(input: NotificationInput): NotificationInput {
  if (!object(input)) throw new Error("通知必须是对象");
  if (typeof input.id !== "string" || !input.id.trim() || input.id.length > 512 || input.id.includes("\0")) {
    throw new Error("通知 id 必须是 1–512 字符的非空字符串");
  }
  if (typeof input.text !== "string") throw new Error("通知 text 必须是字符串");
  if (!["reply", "job", "attention"].includes(input.kind)) throw new Error("通知 kind 无效");
  if (!object(input.source) || typeof input.source.channel !== "string") throw new Error("通知 source 无效");
  return { id: input.id, source: normalizeSource(input.source), text: input.text, kind: input.kind };
}

// 同目录临时文件 + fsync + 原子 rename。绝不先删除旧文件，也不在读取失败时重建空存储。
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
  // Windows 不支持目录 fsync；其他平台尽力刷新 rename 的目录项。rename 后不能再报告未提交。
  if (process.platform !== "win32") {
    let directoryFd: number | undefined;
    try { directoryFd = openSync(directory, "r"); fsyncSync(directoryFd); } catch { /* 部分文件系统不支持 */ }
    finally { if (directoryFd !== undefined) { try { closeSync(directoryFd); } catch { /* 已提交 */ } } }
  }
}

/** 单进程、单实例持有一个文件。只存储 outbox，不执行任何网络发送。 */
export class NotificationStore {
  private readonly file: string;
  private readonly now: () => number;
  private records = new Map<string, NotificationRecord>();

  constructor(options: NotificationStoreOptions) {
    if (!options || typeof options.file !== "string" || !options.file.trim() || options.file.includes("\0")) {
      throw new Error("通知存储 file 无效");
    }
    if (options.now !== undefined && typeof options.now !== "function") throw new Error("通知存储 now 无效");
    this.file = path.resolve(options.file);
    this.now = options.now ?? Date.now;
    let content: string;
    try { content = readFileSync(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`无法读取通知存储 ${this.file}；原文件未覆盖`, { cause: error });
    }
    try {
      const data: unknown = JSON.parse(content);
      if (!object(data) || data.version !== 1 || !Array.isArray(data.notifications)) throw new Error("不支持的通知存储格式");
      for (const value of data.notifications) {
        if (!object(value)) throw new Error("通知记录不是对象");
        const input = normalizeInput(value as unknown as NotificationInput);
        if (!timestamp(value.createdAt) || (value.ackedAt !== undefined && !timestamp(value.ackedAt))) throw new Error("通知时间戳无效");
        if (this.records.has(input.id)) throw new Error(`重复通知 id: ${input.id}`);
        this.records.set(input.id, { ...input, createdAt: value.createdAt, ...(value.ackedAt === undefined ? {} : { ackedAt: value.ackedAt as string }) });
      }
    } catch (error) {
      throw new Error(`通知存储损坏或格式不兼容：${this.file}；拒绝覆盖原文件`, { cause: error });
    }
  }

  /** 同 id、同内容返回原记录（包括已确认记录）；不同内容拒绝，避免静默丢掉通知。 */
  put(input: NotificationInput): NotificationRecord {
    const normalized = normalizeInput(input);
    const existing = this.records.get(normalized.id);
    if (existing) {
      if (existing.text !== normalized.text || existing.kind !== normalized.kind || JSON.stringify(existing.source) !== JSON.stringify(normalized.source)) {
        throw new Error(`通知 id 冲突：${normalized.id} 已用于不同内容`);
      }
      return structuredClone(existing);
    }
    const record: NotificationRecord = { ...normalized, createdAt: new Date(this.now()).toISOString() };
    const next = new Map(this.records);
    next.set(record.id, record);
    this.save(next);
    return structuredClone(record);
  }

  /** 按入库顺序返回最早的未确认通知；读取不会确认或删除。 */
  pending(channel?: ReplySource["channel"], limit = 20): NotificationRecord[] {
    if (channel !== undefined && !["gui", "qq", "telegram"].includes(channel)) throw new Error("通知 channel 无效");
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("通知 limit 必须是非负整数");
    const result: NotificationRecord[] = [];
    for (const record of this.records.values()) {
      if (result.length >= limit) break;
      if (!record.ackedAt && (channel === undefined || record.source.channel === channel)) result.push(structuredClone(record));
    }
    return result;
  }

  /** 存在即返回 true，重复确认不改时间也不写盘；未知 id 返回 false。 */
  ack(id: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.ackedAt) return true;
    const next = new Map(this.records);
    next.set(id, { ...record, ackedAt: new Date(this.now()).toISOString() });
    this.save(next);
    return true;
  }

  get(id: string): NotificationRecord | undefined {
    const record = this.records.get(id);
    return record === undefined ? undefined : structuredClone(record);
  }

  private save(next: Map<string, NotificationRecord>): void {
    // 已确认记录也保留，以保证通知 id 的持久幂等性；未确认记录永不清理。
    writeAtomic(this.file, { version: 1, notifications: [...next.values()] });
    this.records = next;
  }
}
