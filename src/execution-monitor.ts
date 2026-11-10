import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

export interface PiUsage { tokens: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }
export type StopReason = "completed" | "failed" | "cancelled" | "timed_out" | "tool_budget" | "repeated_tool_failure" | "output_limit";
export interface RunMetrics {
  queueMs: number;
  firstTextMs?: number;
  modelCalls: number;
  toolCalls: number;
  toolErrors: number;
  /** 工具耗时之和；并发工具可能重叠，不应从总耗时中直接扣除。 */
  toolMs: number;
  stopReason: StopReason;
}
export interface ExecutionLimits { maxToolCalls?: number; maxRepeatedToolFailures?: number }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)) ?? "null").digest("hex");
}
function amount(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
function limit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("执行预算必须是非负整数（0 表示关闭该项限制）");
  return result;
}
function hasText(message: any): boolean {
  return typeof message?.content === "string" ? !!message.content.trim() : Array.isArray(message?.content) && message.content.some((part: any) => part?.type === "text" && typeof part.text === "string" && part.text.trim());
}

/** 只观察真实事件；相同成功动作不算循环，参数、结果变化或成功都会重置连续失败计数。 */
export class ExecutionMonitor {
  private readonly maxTools: number;
  private readonly maxFailures: number;
  private readonly started: number;
  private firstTextMs?: number;
  private modelCalls = 0;
  private toolCalls = 0;
  private toolErrors = 0;
  private toolMs = 0;
  private lastFailure = "";
  private repeatedFailures = 0;
  private pending = new Map<string, { name: string; action: string; started: number }>();
  private seenTools = new Set<string>();
  private seenMessages = new Set<string>();
  private totals?: PiUsage;

  constructor(limits: ExecutionLimits = {}, started = performance.now()) {
    this.maxTools = limit(limits.maxToolCalls, 100);
    this.maxFailures = limit(limits.maxRepeatedToolFailures, 5);
    this.started = started;
  }

  observe(event: Record<string, any>, now = performance.now()): StopReason | undefined {
    const firstText = () => { this.firstTextMs ??= Math.max(0, now - this.started); };
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta" && event.assistantMessageEvent.delta) firstText();
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      if (hasText(message)) firstText();
      const id = typeof message.id === "string" && message.id ? message.id : undefined;
      if (id && this.seenMessages.has(id)) return;
      if (id) this.seenMessages.add(id);
      this.modelCalls++;
      if (message.usage) {
        const usage = message.usage;
        const input = amount(usage.input), output = amount(usage.output), cacheRead = amount(usage.cacheRead), cacheWrite = amount(usage.cacheWrite);
        const totals = this.totals ??= { tokens: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        totals.tokens += typeof usage.totalTokens === "number" ? amount(usage.totalTokens) : input + output + cacheRead + cacheWrite;
        totals.cost += amount(usage.cost?.total);
        totals.input += input; totals.output += output; totals.cacheRead += cacheRead; totals.cacheWrite += cacheWrite;
      }
    }
    if (["agent_end", "agent_settled"].includes(event.type) && Array.isArray(event.messages)) {
      if (event.messages.some((message: any) => message?.role === "assistant" && hasText(message))) firstText();
      if (!this.modelCalls) for (const message of event.messages) if (message?.role === "assistant") this.observe({ type: "message_end", message }, now);
    }
    if (event.type === "tool_execution_start") {
      const id = String(event.toolCallId ?? `anonymous-${this.toolCalls}`);
      if (this.seenTools.has(id)) return;
      this.seenTools.add(id);
      this.pending.set(id, { name: String(event.toolName ?? "tool"), action: fingerprint([event.toolName, event.args]), started: now });
      this.toolCalls++;
      if (this.maxTools && this.toolCalls > this.maxTools) return "tool_budget";
    }
    if (event.type === "tool_execution_end") {
      const id = event.toolCallId === undefined ? [...this.pending].find(([, tool]) => tool.name === String(event.toolName ?? "tool"))?.[0] : String(event.toolCallId);
      const tool = id === undefined ? undefined : this.pending.get(id);
      if (!tool || id === undefined) return;
      this.pending.delete(id);
      this.toolMs += Math.max(0, now - tool.started);
      if (event.isError === true) {
        this.toolErrors++;
        const failure = fingerprint([tool.action, event.result]);
        this.repeatedFailures = failure === this.lastFailure ? this.repeatedFailures + 1 : 1;
        this.lastFailure = failure;
        if (this.maxFailures && this.repeatedFailures >= this.maxFailures) return "repeated_tool_failure";
      } else {
        this.lastFailure = "";
        this.repeatedFailures = 0;
      }
    }
  }

  usage(): PiUsage | undefined { return this.totals ? { ...this.totals } : undefined; }
  metrics(queueMs: number, stopReason: StopReason, now = performance.now()): RunMetrics {
    return { queueMs, firstTextMs: this.firstTextMs, modelCalls: this.modelCalls, toolCalls: this.toolCalls, toolErrors: this.toolErrors,
      toolMs: this.toolMs + [...this.pending.values()].reduce((sum, tool) => sum + Math.max(0, now - tool.started), 0), stopReason };
  }
}
