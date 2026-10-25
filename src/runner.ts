import { spawn, type ChildProcess } from "node:child_process";

/**
 * pi 执行器：每条消息 spawn 一个 `pi --mode json` 子进程，按行解析事件流，
 * 边跑边把"在干什么、说了什么"推给 GUI。
 *
 * 单套工具：不再按模式给不同工具集，本地读写/命令（read/bash/edit/write）
 * 与联网、记忆、时间、任务、模型等扩展工具全部可用。
 *
 * 身份注入：使用者标识经环境变量 PI_USER_ID 传给扩展，由系统写死，
 * 不经过模型，也不作为工具参数让模型填——模型填的那个字段是骗得过的。
 */

export interface PiResult {
  ok: boolean;
  /** 最终答复（助手最后一条消息的正文） */
  text: string;
  durationMs: number;
  /** 本次运行的 token 用量与费用（可用则给出） */
  usage?: { tokens: number; cost: number };
  /** 失败原因（超时、启动失败、pi 异常退出） */
  error?: string;
}

export type PiEvent =
  | { kind: "delta"; text: string }
  | { kind: "tool_start"; id: string; name: string; detail: string }
  | { kind: "tool_end"; id: string; name: string; isError: boolean; detail: string }
  | { kind: "usage"; tokens: number; cost: number }
  | { kind: "done"; ok: boolean; text: string; durationMs: number; error?: string };

export interface RunOptions {
  model?: string;
  sessionFile?: string;
  /** 以 @路径 传给 pi 的附件（图片 / 取文后的文本） */
  attachPaths?: string[];
  /** 使用者的记忆键，经 PI_USER_ID 注入扩展 */
  userId?: string;
  priority?: "interactive" | "scheduled";
  onEvent?: (e: PiEvent) => void;
  /** 内部使用：给运行实例打标（GUI 用来关联中止操作） */
  label?: string;
  /** 只做材料分析，不允许调用工具 */
  noTools?: boolean;
  /** 覆盖本次运行的超时时间 */
  timeoutMs?: number;
  /** 单轮系统上下文，不由模型参数提供。 */
  env?: Record<string, string>;
  tools?: string[];
}

export interface RunnerOptions {
  command: string;
  args: string[];
  thinking: string;
  env?: Record<string, string>;
  /** pi 的工作目录（它能自由读写的范围；注意这不是沙箱） */
  cwd: string;
  maxConcurrent: number;
  timeoutMs: number;
}

interface Job extends RunOptions {
  prompt: string;
  resolve: (r: PiResult) => void;
}

const MAX_CAPTURE = 2_000_000; // stdout 最大收集字节数，防爆内存

export class PiRunner {
  private readonly opts: RunnerOptions;
  private readonly queues: Record<"interactive" | "scheduled", Job[]> = { interactive: [], scheduled: [] };
  private readonly running = new Set<ChildProcess>();
  private active = 0;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
  }

  run(prompt: string, options: RunOptions): Promise<PiResult> {
    return new Promise((resolve) => {
      const priority = options.priority ?? "interactive";
      this.queues[priority].push({ ...options, prompt, resolve });
      this.pump();
    });
  }

  /** 中止所有正在运行的 pi 进程（GUI 的"停止"按钮）。 */
  abortAll(): number {
    const n = this.running.size;
    for (const child of this.running) killTree(child.pid);
    this.running.clear();
    return n;
  }

  get busy(): number {
    return this.active;
  }

  private pump(): void {
    while (this.active < this.opts.maxConcurrent) {
      // 交互任务优先：只有没有交互任务排队时，才轮到定时任务
      const job = this.queues.interactive.shift() ?? this.queues.scheduled.shift();
      if (!job) return;
      this.active++;
      this.execute(job)
        .catch((err) => ({
          ok: false,
          text: "",
          durationMs: 0,
          error: `执行异常: ${err instanceof Error ? err.message : String(err)}`,
        }))
        .then((result) => {
          this.active--;
          job.resolve({ ok: result.ok, text: result.text, durationMs: result.durationMs, usage: result.usage, error: result.error });
          this.pump();
        });
    }
  }

  private execute(
    job: Job,
  ): Promise<{ ok: boolean; text: string; durationMs: number; usage?: { tokens: number; cost: number }; error?: string }> {
    const started = Date.now();
    const emit = (e: PiEvent): void => {
      try {
        job.onEvent?.(e);
      } catch {
        /* 事件回调异常不影响本次运行 */
      }
    };

    const args = [...this.opts.args];
    if (!args.includes("--mode")) args.push("--mode", "json");
    if (job.noTools && !args.includes("--no-tools")) args.push("--no-tools");
    if (!job.noTools && job.tools?.length) args.push("--tools", job.tools.join(","));
    if (this.opts.thinking) args.push("--thinking", this.opts.thinking);
    if (job.model) args.push("--model", job.model);
    // 记忆：有会话文件则续接（pi 跨进程加载历史），否则无状态
    if (job.sessionFile) args.push("--session", job.sessionFile);
    else args.push("--no-session");
    for (const p of job.attachPaths ?? []) args.push("@" + p);
    args.push(job.prompt);

    // 直接 spawn（不经 shell/cmd），避免引号解析与编码问题
    const child = spawn(this.opts.command, args, {
      cwd: this.opts.cwd,
      windowsHide: true,
      // stdin 直接忽略（立即 EOF）：pi 在非 TTY 管道下可能等待 stdin，导致挂起
      stdio: ["ignore", "pipe", "pipe"],
      // 各模型的 API key、使用者身份只经环境变量注入，不落在工作目录里
      env: { ...process.env, ...(this.opts.env ?? {}), ...(job.env ?? {}), PI_USER_ID: job.userId ?? "" },
    });
    this.running.add(child);

    let buf = "";
    let finalText = "";
    // 最后一条 assistant 消息的正文（agent_end 缺失时兜底）
    let lastText = "";
    let usage: { tokens: number; cost: number } | undefined;
    let stderr = "";
    let timedOut = false;
    // 超时诊断：记着正在跑的工具和最后一次活动，超时时拼进错误文案
    let pendingTool: { name: string; detail: string; at: number } | null = null;
    let toolCount = 0;
    let lastActivityAt = Date.now();
    let timeoutReason = "";

    const timeoutMs = job.timeoutMs ?? this.opts.timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      const secs = (ms: number): number => Math.round(ms / 1000);
      const parts: string[] = [];
      if (pendingTool) {
        const target = pendingTool.detail ? `「${pendingTool.detail.slice(0, 60)}」` : "";
        parts.push(`卡在 ${pendingTool.name}${target} 已 ${secs(Date.now() - pendingTool.at)} 秒`);
      } else {
        parts.push(`最近 ${secs(Date.now() - lastActivityAt)} 秒无工具调用（模型无响应）`);
      }
      parts.push(`本轮 ${toolCount} 次工具调用`);
      const produced = (finalText || lastText).trim().length;
      if (produced) parts.push(`已产出 ${produced} 字`);
      timeoutReason = `pi 处理超时（>${secs(timeoutMs)} 秒），${parts.join("；")}，已终止`;
      killTree(child.pid);
    }, timeoutMs);

    const handle = (ev: Record<string, unknown>): void => {
      const type = String(ev.type ?? "");
      if (type === "message_update") {
        const ame = ev.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (ame?.type === "text_delta" && ame.delta) {
          lastActivityAt = Date.now();
          emit({ kind: "delta", text: ame.delta });
        }
        return;
      }
      if (type === "tool_execution_start") {
        const detail = describeTool(ev.toolName, ev.args);
        pendingTool = { name: String(ev.toolName ?? "tool"), detail, at: Date.now() };
        toolCount++;
        lastActivityAt = Date.now();
        emit({
          kind: "tool_start",
          id: String(ev.toolCallId ?? ""),
          name: String(ev.toolName ?? "tool"),
          detail,
        });
        return;
      }
      if (type === "tool_execution_end") {
        pendingTool = null;
        lastActivityAt = Date.now();
        emit({
          kind: "tool_end",
          id: String(ev.toolCallId ?? ""),
          name: String(ev.toolName ?? "tool"),
          isError: ev.isError === true,
          detail: previewResult(ev.result),
        });
        return;
      }
      if (type === "message_end") {
        const m = ev.message as { role?: string; content?: unknown; usage?: { totalTokens?: number; cost?: { total?: number } } } | undefined;
        if (m?.role === "assistant") {
          const text = textOf(m.content);
          // 先记着，等 agent_end 汇总本次运行全部轮次的正文，别在这里覆盖
          if (text) lastText = text;
          const u = m.usage;
          if (u) {
            usage = { tokens: Number(u.totalTokens ?? 0), cost: Number(u.cost?.total ?? 0) };
            emit({ kind: "usage", tokens: usage.tokens, cost: usage.cost });
          }
        }
        return;
      }
      if (type === "agent_settled" || type === "agent_end") {
        // agent_end 的 messages 是本次运行新产生的全部消息（不含历史）。
        // 把各轮 assistant 正文按顺序拼起来，避免前面轮次的正文被最后一条盖掉。
        const msgs = ev.messages;
        if (Array.isArray(msgs)) {
          const parts: string[] = [];
          for (const m of msgs as Array<{ role?: string; content?: unknown }>) {
            if (m?.role === "assistant") {
              const text = textOf(m.content);
              if (text) parts.push(text);
            }
          }
          if (parts.length) finalText = parts.join("\n\n");
        }
      }
    };

    return new Promise((resolve) => {
      child.stdout.on("data", (d: Buffer) => {
        if (buf.length > MAX_CAPTURE) return;
        buf += d.toString("utf8");
        // JSONL：只按 \n 切，最后一段可能不完整，留在缓冲里等下一块
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            handle(JSON.parse(line) as Record<string, unknown>);
          } catch {
            /* 非 JSON 行（理论上不该有）忽略 */
          }
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        if (stderr.length < 8000) stderr += d.toString("utf8");
      });

      const finish = (r: { ok: boolean; text: string; durationMs: number; usage?: { tokens: number; cost: number }; error?: string }): void => {
        this.running.delete(child);
        emit({ kind: "done", ok: r.ok, text: r.text, durationMs: r.durationMs, error: r.error });
        resolve(r);
      };

      child.on("error", (err) => {
        clearTimeout(timer);
        finish({ ok: false, text: "", durationMs: Date.now() - started, error: `无法启动 pi: ${err.message}` });
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (!finalText) finalText = lastText; // agent_end 没等到时用最后一条兜底
        const durationMs = Date.now() - started;
        if (timedOut) {
          finish({
            ok: false,
            text: finalText,
            durationMs,
            error: timeoutReason || `pi 处理超时（>${Math.round(timeoutMs / 1000)} 秒），已终止`,
          });
          return;
        }
        if (code === 0) {
          finish({ ok: true, text: finalText, durationMs, usage });
          return;
        }
        const tail = (stderr.trim() || `退出码 ${code}`).slice(-1000);
        finish({ ok: false, text: finalText, durationMs, error: `pi 执行失败: ${tail}` });
      });
    });
  }
}

/** 取消息里的正文（content 可能是字符串或分段数组）。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const seg of content as Array<{ type?: string; text?: string }>) {
    if (seg?.type === "text" && typeof seg.text === "string") parts.push(seg.text);
  }
  return parts.join("\n").trim();
}

/** 给工具调用挑一个能一眼看懂的目标（命令、路径、查询词…）。 */
function describeTool(name: unknown, rawArgs: unknown): string {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof args[k] === "string" ? String(args[k]) : "");
  const detail =
    str("command") ||
    str("cmd") ||
    str("path") ||
    str("file_path") ||
    str("query") ||
    str("url") ||
    str("target") ||
    str("text") ||
    str("name") ||
    str("prompt") ||
    (() => {
      try {
        const j = JSON.stringify(args);
        return j === "{}" || j === "[]" ? "" : j; // 无参数工具就别显示一对空括号
      } catch {
        return "";
      }
    })();
  const one = detail.replace(/\s+/g, " ").trim();
  return one.length > 160 ? one.slice(0, 160) + "…" : one;
}

/** 工具结果预览（只取一小段，用于 GUI 里折叠显示）。 */
function previewResult(raw: unknown): string {
  const r = raw as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const text = Array.isArray(r?.content)
    ? r!.content.map((c) => (c?.type === "text" ? String(c.text ?? "") : `[${c?.type ?? "?"}]`)).join(" ")
    : typeof raw === "string"
      ? raw
      : "";
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 300 ? one.slice(0, 300) + "…" : one;
}

/** 结束整个进程树（Windows 下 pi 会再拉 bash 子进程）。 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
  }
}
