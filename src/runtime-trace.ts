import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";

export interface TraceUsage { tokens: number; cost: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
export interface TraceMetrics {
  queueMs?: number; firstTextMs?: number; modelCalls?: number; toolCalls: number; toolErrors: number; toolMs: number;
  stopReason: string; source?: "runner" | "events";
}
export interface TraceContextStats { budgetChars: number; chars: number; selected: number; omitted: number; duplicates: number }
export interface RequestTimings {
  queueMs: number; sessionMs: number; attachmentsMs: number; memoryMs: number; contextMs?: number;
  preparationMs: number; runnerQueueMs?: number; runMs: number; totalMs: number; firstTextMs?: number;
}
export interface RuntimeTrace {
  requestId: string; at: string; model: string; ok: boolean;
  timings: RequestTimings; metrics?: TraceMetrics; usage?: TraceUsage; context?: TraceContextStats;
}
interface RunView { ok: boolean; text: string; durationMs: number; usage?: TraceUsage; metrics?: TraceMetrics }
interface ObservedEvent { kind: string; id?: string; text?: string; tokens?: number; cost?: number; cumulative?: boolean; isError?: boolean }
const MAX_BYTES = 2 * 1024 * 1024;
const CONTEXT = channel("personal-agent.context");
const amount = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** 兼容已有单次 usage 事件与增强执行器的 cumulative 事件；只观察，不重放或控制工具。 */
export class RunTraceObserver {
  private readonly started: number;
  private firstTextMs?: number;
  private calls = 0;
  private totals?: TraceUsage;
  private tools = 0;
  private errors = 0;
  private toolMs = 0;
  private pending = new Map<string, number>();
  constructor(started = performance.now()) { this.started = started; }
  observe(event: ObservedEvent, now = performance.now()): void {
    if ((event.kind === "delta" || event.kind === "done") && event.text) this.firstTextMs ??= Math.max(0, now - this.started);
    if (event.kind === "usage") {
      this.calls++;
      const next = { tokens: amount(event.tokens), cost: amount(event.cost) };
      this.totals = event.cumulative ? next : { tokens: (this.totals?.tokens ?? 0) + next.tokens, cost: (this.totals?.cost ?? 0) + next.cost };
    }
    if (event.kind === "tool_start") {
      const id = event.id ?? `anonymous-${this.tools}`;
      if (!this.pending.has(id)) { this.tools++; this.pending.set(id, now); }
    }
    if (event.kind === "tool_end") {
      const id = event.id ?? this.pending.keys().next().value;
      const began = id === undefined ? undefined : this.pending.get(id);
      if (id !== undefined && began !== undefined) {
        this.pending.delete(id); this.toolMs += Math.max(0, now - began);
        if (event.isError) this.errors++;
      }
    }
  }
  finish(result: RunView, now = performance.now()): { usage?: TraceUsage; metrics: TraceMetrics; firstTextAfterSubmitMs?: number } {
    const native = result.metrics;
    const first = native?.firstTextMs !== undefined ? (native.queueMs ?? 0) + native.firstTextMs
      : this.firstTextMs ?? (result.text ? Math.max(0, now - this.started) : undefined);
    return {
      usage: native ? result.usage : this.totals ? { ...this.totals } : result.usage,
      metrics: native ? { ...native, source: "runner" } : {
        firstTextMs: this.firstTextMs, modelCalls: this.calls || undefined, toolCalls: this.tools, toolErrors: this.errors,
        toolMs: this.toolMs + [...this.pending.values()].reduce((sum, began) => sum + Math.max(0, now - began), 0),
        stopReason: result.ok ? "completed" : "failed", source: "events",
      },
      firstTextAfterSubmitMs: first,
    };
  }
}

export async function measureAsync<T>(timings: RequestTimings, key: "sessionMs" | "attachmentsMs" | "memoryMs", action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await action(); } finally { timings[key] += Math.max(0, performance.now() - started); }
}
export function measureSync<T>(timings: RequestTimings, key: "memoryMs", action: () => T): T {
  const started = performance.now();
  try { return action(); } finally { timings[key] += Math.max(0, performance.now() - started); }
}

/** 指标副本：白名单落盘；上下文模块通过内置诊断通道选配接入，无直接导入依赖。 */
export class RuntimeTraceStore {
  private readonly file: string;
  private readonly redact: (text: string) => string;
  private readonly contexts = new Map<string, { stats?: TraceContextStats; durationMs?: number }>();
  private readonly listener: (message: unknown) => void;
  constructor(file: string, redact: (text: string) => string = (text) => text) {
    this.file = file; this.redact = redact;
    this.listener = (message) => {
      try {
        if (!message || typeof message !== "object") return;
        const value = message as { requestId?: unknown; stats?: unknown; durationMs?: unknown };
        if (typeof value.requestId !== "string" || !this.contexts.has(value.requestId) || !value.stats || typeof value.stats !== "object") return;
        const fields = value.stats as Record<keyof TraceContextStats, unknown>;
        const keys: Array<keyof TraceContextStats> = ["budgetChars", "chars", "selected", "omitted", "duplicates"];
        if (keys.some((key) => typeof fields[key] !== "number" || !Number.isSafeInteger(fields[key]) || (fields[key] as number) < 0)) return;
        if ((fields.budgetChars as number) < 2 || (fields.chars as number) > (fields.budgetChars as number)) return;
        const stats = Object.fromEntries(keys.map((key) => [key, fields[key]])) as unknown as TraceContextStats;
        this.contexts.set(value.requestId, { stats, durationMs: typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0 ? value.durationMs : undefined });
      } catch { /* 诊断订阅者异常不能中断业务。 */ }
    };
    CONTEXT.subscribe(this.listener);
  }
  begin(requestId: string): void { this.contexts.set(requestId, {}); }
  contextFor(requestId: string): { stats?: TraceContextStats; durationMs?: number } | undefined { const context = this.contexts.get(requestId); return context ? structuredClone(context) : undefined; }
  end(requestId: string): void { this.contexts.delete(requestId); }
  close(): void { CONTEXT.unsubscribe(this.listener); this.contexts.clear(); }

  append(trace: RuntimeTrace): void {
    const { requestId, at, model, ok, timings, metrics, usage, context } = trace;
    const timingKeys: Array<keyof RequestTimings> = ["queueMs", "sessionMs", "attachmentsMs", "memoryMs", "contextMs", "preparationMs", "runnerQueueMs", "runMs", "totalMs", "firstTextMs"];
    const safeTimings = Object.fromEntries(timingKeys.map((key) => [key, timings[key]]).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0));
    const safeMetrics = metrics && { queueMs: metrics.queueMs, firstTextMs: metrics.firstTextMs, modelCalls: metrics.modelCalls, toolCalls: metrics.toolCalls, toolErrors: metrics.toolErrors, toolMs: metrics.toolMs, stopReason: metrics.stopReason, source: metrics.source };
    const safeUsage = usage && { tokens: usage.tokens, cost: usage.cost, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite };
    const safeContext = context && { budgetChars: context.budgetChars, chars: context.chars, selected: context.selected, omitted: context.omitted, duplicates: context.duplicates };
    const line = JSON.stringify({ requestId, at, model, ok, timings: safeTimings, metrics: safeMetrics, usage: safeUsage, context: safeContext }, (_key, value) => typeof value === "string" ? this.redact(value) : value) + "\n";
    if (Buffer.byteLength(line) > MAX_BYTES) throw new Error("诊断记录超出大小上限");
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (existsSync(this.file) && statSync(this.file).size + Buffer.byteLength(line) > MAX_BYTES) { rmSync(`${this.file}.1`, { force: true }); renameSync(this.file, `${this.file}.1`); }
    appendFileSync(this.file, line, { encoding: "utf8", mode: 0o600 });
  }
}

export function readRuntimeTraces(file: string): RuntimeTrace[] {
  if (!existsSync(file)) return [];
  const rows: RuntimeTrace[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try { const value = JSON.parse(line); if (typeof value.requestId === "string" && typeof value.ok === "boolean" && Number.isFinite(value.timings?.totalMs)) rows.push(value); }
    catch { /* 跳过半行，诊断不影响任务事实。 */ }
  }
  return rows;
}
export function summarizeRuntimeTraces(rows: RuntimeTrace[]) {
  const percentile = (values: number[], ratio: number) => {
    const ordered = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    return ordered.length ? ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)] : undefined;
  };
  const total = rows.map((row) => row.timings.totalMs);
  const first = rows.flatMap((row) => row.timings.firstTextMs === undefined ? [] : [row.timings.firstTextMs]);
  return { requests: rows.length, succeeded: rows.filter((row) => row.ok).length, firstTextSamples: first.length,
    totalMs: { p50: percentile(total, 0.5), p95: percentile(total, 0.95) }, firstTextMs: { p50: percentile(first, 0.5), p95: percentile(first, 0.95) },
    tokens: rows.reduce((sum, row) => sum + (row.usage?.tokens ?? 0), 0), cost: rows.reduce((sum, row) => sum + (row.usage?.cost ?? 0), 0) };
}
