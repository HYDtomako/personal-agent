import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { ExecutionMonitor, type ExecutionLimits, type PiUsage, type RunMetrics, type StopReason } from "./execution-monitor.ts";

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
  usage?: PiUsage;
  metrics?: RunMetrics;
  /** 失败原因（超时、启动失败、pi 异常退出） */
  error?: string;
}

export type PiEvent =
  | { kind: "delta"; text: string }
  | { kind: "tool_start"; id: string; name: string; detail: string }
  | { kind: "tool_end"; id: string; name: string; isError: boolean; detail: string }
  | { kind: "usage"; tokens: number; cost: number; cumulative?: true }
  | { kind: "done"; ok: boolean; text: string; durationMs: number; error?: string };

export interface RunOptions extends ExecutionLimits {
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

export interface RunnerOptions extends ExecutionLimits {
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
  enqueuedAt: number;
  prompt: string;
  resolve: (r: PiResult) => void;
}

const MAX_CAPTURE = 2_000_000; // 单条 JSON 事件的字符上限

export class PiRunner {
  private readonly opts: RunnerOptions;
  private readonly queues: Record<"interactive" | "scheduled", Job[]> = { interactive: [], scheduled: [] };
  private readonly running = new Set<ChildProcess>();
  private readonly aborters = new WeakMap<ChildProcess, () => boolean>();
  private active = 0;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
  }

  run(prompt: string, options: RunOptions): Promise<PiResult> {
    return new Promise((resolve) => {
      const priority = options.priority ?? "interactive";
      this.queues[priority].push({ ...options, prompt, resolve, enqueuedAt: performance.now() });
      this.pump();
    });
  }

  /** 中止所有正在运行的 pi 进程（GUI 的"停止"按钮）。 */
  abortAll(): number {
    let n = 0;
    for (const child of this.running) if (this.aborters.get(child)?.()) n++;
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
          job.resolve(result);
          this.pump();
        });
    }
  }

  private async execute(job: Job): Promise<PiResult> {
    const started = performance.now();
    const queueMs = Math.max(0, started - job.enqueuedAt);
    const monitor = new ExecutionMonitor({
      maxToolCalls: job.maxToolCalls ?? this.opts.maxToolCalls,
      maxRepeatedToolFailures: job.maxRepeatedToolFailures ?? this.opts.maxRepeatedToolFailures,
    }, started);
    const emit = (event: PiEvent) => { try { job.onEvent?.(event); } catch { /* UI 回调不影响执行状态。 */ } };
    const args = [...this.opts.args];
    if (!args.includes("--mode")) args.push("--mode", "json");
    if (job.noTools && !args.includes("--no-tools")) args.push("--no-tools");
    if (!job.noTools && job.tools?.length) args.push("--tools", job.tools.join(","));
    if (this.opts.thinking) args.push("--thinking", this.opts.thinking);
    if (job.model) args.push("--model", job.model);
    if (job.sessionFile) args.push("--session", job.sessionFile);
    else args.push("--no-session");
    for (const file of job.attachPaths ?? []) args.push("@" + file);
    args.push(job.prompt);

    const child = spawn(this.opts.command, args, {
      cwd: this.opts.cwd, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(this.opts.env ?? {}), ...(job.env ?? {}), PI_USER_ID: job.userId ?? "" },
    });
    this.running.add(child);
    let stopped: { reason: StopReason; error: string } | undefined;
    let finished = false;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let buffer = "", finalText = "", lastText = "", stderr = "";
    let spawnError: string | undefined;
    let lastActivityAt = performance.now();
    const pendingTools = new Map<string, { name: string; detail: string; at: number }>();
    const decoder = new StringDecoder("utf8");
    const stop = (reason: StopReason, error: string): boolean => {
      if (finished || stopped) return false;
      stopped = { reason, error };
      if (child.exitCode === null && child.signalCode === null) killTree(child.pid);
      // taskkill 在受限环境可能失败；仍须终止本轮主进程，不能永远占着队列。
      fallback = setTimeout(() => { if (!finished) { try { child.kill("SIGKILL"); } catch { /* 等待真实 close，绝不提前释放执行锁。 */ } } }, 1000);
      fallback.unref();
      return true;
    };
    this.aborters.set(child, () => stop("cancelled", "PA 本轮已取消；已派发后台任务独立运行"));
    const timeoutMs = job.timeoutMs ?? this.opts.timeoutMs;
    const timer = setTimeout(() => {
      const tool = [...pendingTools.values()].at(-1);
      const detail = tool
        ? "卡在 " + tool.name + (tool.detail ? "「" + tool.detail.slice(0, 60) + "」" : "") + " 已 " + Math.round((performance.now() - tool.at) / 1000) + " 秒"
        : "最近 " + Math.round((performance.now() - lastActivityAt) / 1000) + " 秒无新活动";
      stop("timed_out", "pi 处理超时（>" + Math.round(timeoutMs / 1000) + " 秒），" + detail + "，本轮 " + monitor.metrics(queueMs, "timed_out").toolCalls + " 次工具调用");
    }, timeoutMs);

    const handle = (event: Record<string, any>): void => {
      const guard = monitor.observe(event);
      const type = event.type;
      if (type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update?.type === "text_delta" && typeof update.delta === "string" && update.delta) {
          lastActivityAt = performance.now();
          emit({ kind: "delta", text: update.delta });
        }
      } else if (type === "tool_execution_start") {
        const name = String(event.toolName ?? "tool"), id = String(event.toolCallId ?? "");
        const detail = describeTool(event.toolName, event.args);
        pendingTools.set(id, { name, detail, at: performance.now() });
        lastActivityAt = performance.now();
        emit({ kind: "tool_start", id, name, detail });
      } else if (type === "tool_execution_end") {
        const id = String(event.toolCallId ?? "");
        pendingTools.delete(id);
        lastActivityAt = performance.now();
        emit({ kind: "tool_end", id, name: String(event.toolName ?? "tool"), isError: event.isError === true, detail: previewResult(event.result) });
      } else if (type === "message_end" && event.message?.role === "assistant") {
        const text = textOf(event.message.content);
        if (text) lastText = text;
        const usage = monitor.usage();
        if (usage) emit({ kind: "usage", tokens: usage.tokens, cost: usage.cost, cumulative: true });
      } else if (type === "agent_settled" || type === "agent_end") {
        if (Array.isArray(event.messages)) {
          const texts = event.messages.filter((message: any) => message?.role === "assistant").map((message: any) => textOf(message.content)).filter(Boolean);
          if (texts.length) finalText = texts.join("\n\n");
        }
      }
      if (guard === "tool_budget") stop(guard, "PA 本轮工具调用预算已耗尽，已停止继续执行；已产生的外部操作需要核实，未自动重试。");
      if (guard === "repeated_tool_failure") stop(guard, "同一工具以相同参数连续返回相同失败，PA 本轮已停止；请调整条件后继续，未自动重试工具。");
    };
    const parse = (line: string) => {
      if (!line.trim() || stopped) return;
      if (line.length > MAX_CAPTURE) { stop("output_limit", "pi 单条输出事件过大，本轮已停止，结果未确认"); return; }
      let event: unknown;
      try { event = JSON.parse(line); } catch { return; }
      if (event && typeof event === "object" && !Array.isArray(event)) handle(event as Record<string, unknown>);
    };

    return new Promise((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        if (stopped) return;
        buffer += decoder.write(chunk);
        let newline: number;
        while (!stopped && (newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          parse(line);
        }
        if (buffer.length > MAX_CAPTURE) { buffer = ""; stop("output_limit", "pi 单条输出事件过大，本轮已停止，结果未确认"); }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { if (stderr.length < 8000) stderr = (stderr + chunk).slice(0, 8000); });
      child.on("error", (error) => { spawnError = "无法启动 pi: " + error.message; });
      // close 在 stdout/stderr 结束后触发；exit 可能早于最后一个 JSON 事件。
      child.once("close", (code) => {
        if (finished) return;
        buffer += decoder.end();
        if (!stopped) parse(buffer); // 兼容最后一行没有换行。
        finished = true;
        clearTimeout(timer);
        if (fallback) clearTimeout(fallback);
        this.running.delete(child);
        this.aborters.delete(child);
        finalText ||= lastText;
        const ok = !stopped && !spawnError && code === 0;
        const error = stopped?.error ?? spawnError ?? (ok ? undefined : "pi 执行失败: " + (stderr.trim() || "退出码 " + code).slice(-1000));
        const reason = stopped?.reason ?? (ok ? "completed" : "failed");
        const result: PiResult = { ok, text: finalText, durationMs: Math.max(0, performance.now() - started), usage: monitor.usage(), metrics: monitor.metrics(queueMs, reason), error };
        emit({ kind: "done", ok, text: finalText, durationMs: result.durationMs, error });
        resolve(result);
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
