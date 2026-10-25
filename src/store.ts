import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

/**
 * 对话记录：GUI 显示用的消息流水，追加写 JSONL。
 *
 * 与 pi 的会话文件是两回事——那个是给模型看的上下文（JSONL 事件流，含工具调用细节），
 * 这个是给人看的展示层（谁说了什么、跑了什么工具、花了多少 token）。
 * 两者都不进 git。
 */

export interface ChatMeta {
  durationMs?: number;
  tokens?: number;
  cost?: number;
  error?: string;
  requestId?: string;
  jobId?: string;
  /** 本次运行调用的工具（按顺序） */
  tools?: Array<{ name: string; detail: string; isError?: boolean }>;
  /** 助手产出的图片（相对 workspace 的路径） */
  images?: string[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  /** ISO 时间戳 */
  t: string;
  /** 来源标记（定时任务等） */
  via?: string;
  meta?: ChatMeta;
}

const KEEP_ON_COMPACT = 2000; // 超过上限时保留的最后条数
const COMPACT_THRESHOLD = 5000;

export class ChatStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    mkdirSync(path.dirname(file), { recursive: true });
  }

  all(): ChatMessage[] {
    if (!existsSync(this.file)) return [];
    const out: ChatMessage[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line) as ChatMessage;
        if (m?.role && typeof m.text === "string") out.push(m);
      } catch {
        /* 跳过坏行 */
      }
    }
    return out;
  }

  /** 最近 n 条（默认全部）。 */
  recent(n?: number): ChatMessage[] {
    const all = this.all();
    return n && all.length > n ? all.slice(-n) : all;
  }

  append(msg: Omit<ChatMessage, "id" | "t"> & { id?: string; t?: string }): ChatMessage {
    const full: ChatMessage = {
      id: msg.id ?? newId(),
      t: msg.t ?? new Date().toISOString(),
      ...msg,
    } as ChatMessage;
    appendFileSync(this.file, JSON.stringify(full) + "\n");
    return full;
  }

  appendOnce(msg: Omit<ChatMessage, "id" | "t"> & { id: string; t?: string }): { message: ChatMessage; inserted: boolean } {
    const existing = this.all().find((item) => item.id === msg.id);
    if (existing) return { message: existing, inserted: false };
    return { message: this.append(msg), inserted: true };
  }

  /** 新对话：把当前记录归档到同目录的 archive/，页面重新从空开始（不真删，留个底）。 */
  clear(): void {
    if (!existsSync(this.file)) return;
    const dir = path.join(path.dirname(this.file), "archive");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      renameSync(this.file, path.join(dir, `chat-${stamp}.jsonl`));
    } catch {
      writeFileSync(this.file, "");
    }
  }

  /** 文件过大时裁掉旧记录（启动时调用）。 */
  compact(): boolean {
    if (!existsSync(this.file)) return false;
    const lines = readFileSync(this.file, "utf8").split("\n").filter((l) => l.trim());
    if (lines.length <= COMPACT_THRESHOLD) return false;
    const kept = lines.slice(-KEEP_ON_COMPACT);
    writeFileSync(this.file, kept.join("\n") + "\n");
    return true;
  }
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
