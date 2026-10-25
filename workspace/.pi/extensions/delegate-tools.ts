/**
 * 委派工具只通过主服务的短 HTTP 请求提交/查询持久后台任务。
 * PA 不启动执行器、不创建工作区、不等待 CA；执行、--auto、deadline 与验收由后台负责。
 * 身份、原回复渠道与验收上下文来自主程序注入的环境变量，不接受模型传入的来源字段。
 */

interface ExtensionAPI {
  registerTool(tool: ToolRegistration): void;
}

interface ToolRegistration {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
}

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CONFIG_PATH = path.join(ROOT_DIR, "config.json");
const HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MINUTES = 60;
const MAX_TIMEOUT_MINUTES = 240;

interface Config {
  agent?: { userId?: string };
  gui?: { port?: number; token?: string };
  [key: string]: unknown;
}

interface Job {
  id: string;
  status: string;
  name?: string;
  worker?: string;
  cwd?: string;
  executionCwd?: string;
  createdAt?: string;
  requestId?: string;
  notifiedAt?: string | number;
  message?: string;
  deliveryManaged?: boolean;
  deliveryHold?: boolean;
  projectIdentity?: unknown;
  delivery?: unknown;
}

interface DeliverySummary {
  mode?: string;
  state?: string;
  identity: Record<string, string>;
  executionCwd?: string;
  worktreePath?: string;
  changeCount?: number;
  conflictCount?: number;
  targetUpdated?: boolean;
  alreadyPresent?: boolean;
  cleanupDone?: boolean;
  committed?: boolean;
  pushed?: boolean;
  deployed?: boolean;
  error?: string;
}

interface ApiResponse {
  status: number;
  data: Record<string, unknown>;
}

function text(message: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: message }], ...(details ? { details } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownerGuard(cfg: Config): string {
  const owner = String(cfg.agent?.userId ?? "");
  const asker = (process.env.PI_USER_ID ?? "").trim();
  if (!owner) return "配置异常（未设置 agent.userId）。";
  if (asker !== owner) return "身份不匹配，无法操作外部 agent。";
  return "";
}

/** 只在内存中收集凭据用于脱敏；绝不返回配置、headers 或原始 job 对象。 */
function redactor(cfg: Config): (message: string) => string {
  const secrets = new Set<string>();
  const secretField = /key|token|secret|password|credential|authorization/i;
  function collect(value: unknown, sensitive = false): void {
    if (typeof value === "string" && sensitive && value.trim()) {
      for (const secret of new Set([value, value.trim()])) {
        secrets.add(secret);
        secrets.add(JSON.stringify(secret).slice(1, -1));
        try { secrets.add(encodeURIComponent(secret)); } catch { /* 非法 Unicode 不影响原值脱敏 */ }
      }
    } else if (Array.isArray(value)) {
      value.forEach((item) => collect(item, sensitive));
    } else if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) collect(item, sensitive || secretField.test(key));
    }
  }
  collect(cfg);
  collect(process.env);
  const values = [...secrets].sort((a, b) => b.length - a.length);
  return (message) => {
    let safe = message;
    for (const value of values) safe = safe.split(value).join("[REDACTED]");
    return safe
      .replace(/(Bearer\s+)[^\s"',;]+/gi, "$1[REDACTED]")
      .replace(/((?:api[-_]?key|x-token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',;}\]]+/gi, "$1[REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[REDACTED]");
  };
}

function describeError(value: unknown, depth = 0): string {
  if (depth > 3 || value == null) return "未知错误";
  if (typeof value === "string") return value || "未知错误";
  if (value instanceof Error || isRecord(value)) {
    const info = value as { message?: unknown; code?: unknown; error?: unknown; cause?: unknown };
    const parts: string[] = [];
    if (info.code != null) parts.push(String(info.code));
    if (info.message != null) parts.push(String(info.message));
    if (!parts.length && info.error != null) parts.push(describeError(info.error, depth + 1));
    if (info.cause != null) parts.push(`cause=${describeError(info.cause, depth + 1)}`);
    return parts.join("；") || "主服务返回错误";
  }
  return String(value);
}

async function guarded(
  action: string,
  mutating: boolean,
  execute: (cfg: Config) => Promise<ToolResult>,
): Promise<ToolResult> {
  let cfg: Config;
  try {
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (!isRecord(parsed)) throw new Error("invalid config");
    cfg = parsed as Config;
  } catch {
    return text("读取配置失败，无法校验身份。", { ok: false });
  }
  const guard = ownerGuard(cfg);
  if (guard) return text(guard, { ok: false });
  if (mutating && process.env.PI_REVIEW_JOB_ID !== undefined) {
    return text("后台验收上下文禁止派发、追问、按键、取消、关闭任务或重试交付（agent_integrate），避免递归派活；只可查询状态和读取缓存快照。", { ok: false });
  }
  const redact = redactor(cfg);
  function scrub(value: unknown): unknown {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
    return value;
  }
  try {
    return scrub(await execute(cfg)) as ToolResult;
  } catch (err) {
    const note = action === "派发" ? "\n未确认后台接收，不要盲目重发；可稍后查询持久任务。" : "";
    return text(`${action}失败：${redact(describeError(err)).slice(0, 1800)}${note}`, { ok: false });
  }
}

async function request(cfg: Config, route = "", body?: Record<string, unknown>, expectedStatus?: number, endpoint: "delegations" | "status" = "delegations"): Promise<ApiResponse> {
  const configuredBase = (process.env.PI_API_URL ?? "").trim();
  let base: URL;
  try {
    if (configuredBase) {
      base = new URL(configuredBase);
    } else {
      const port = Number(cfg.gui?.port ?? 8787);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
      base = new URL(`http://127.0.0.1:${port}`);
    }
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new Error("invalid base");
    }
  } catch {
    throw new Error("主服务地址无效，请检查 PI_API_URL 或 gui.port（应为 HTTP(S) 服务地址）。");
  }
  const token = (process.env.PI_GUI_TOKEN ?? "").trim() || String(cfg.gui?.token ?? "").trim();
  if (!token) throw new Error("主服务认证未配置，请设置 PI_GUI_TOKEN 或 gui.token。");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/api/${endpoint}${route}`.split("?")[0];
  base.search = route.includes("?") ? route.slice(route.indexOf("?")) : "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let status: number | undefined;
  let raw: string;
  let httpOk: boolean;
  try {
    const response = await fetch(base.toString(), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        accept: "application/json",
        "x-token": token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
      redirect: "error", // 不把认证令牌跟随重定向发送到其他地址。
    });
    status = response.status;
    httpOk = response.ok;
    raw = await response.text();
  } catch (err) {
    const timedOut = controller.signal.aborted || (err instanceof Error && err.name === "TimeoutError");
    throw new Error(`HTTP${status === undefined ? "" : ` ${status}`} ${timedOut ? `timeout（${HTTP_TIMEOUT_MS} ms）` : "请求失败"}：${describeError(err)}`);
  } finally {
    clearTimeout(timer);
  }
  let data: unknown;
  try { data = JSON.parse(raw); } catch {
    if (!httpOk) throw new Error(`HTTP ${status}：${raw || "主服务未返回错误详情"}`);
    throw new Error(`HTTP ${status}：主服务返回非 JSON，未确认操作成功。`);
  }
  // /api/status 是普通状态对象，不要求 delegations API 的 {ok:true} 包装。
  if (!httpOk || !isRecord(data) || (endpoint === "delegations" ? data.ok !== true : data.ok === false)) {
    throw new Error(`HTTP ${status}：${describeError(isRecord(data) ? data.error ?? data.message ?? data : data)}`);
  }
  if (expectedStatus !== undefined && status !== expectedStatus) {
    throw new Error(`HTTP ${status}：提交合同要求 HTTP ${expectedStatus}，未确认任务已持久接收。`);
  }
  return { status, data };
}

async function requireProjectDelivery(cfg: Config, notSubmitted: string): Promise<void> {
  let response: ApiResponse;
  try { response = await request(cfg, "", undefined, 200, "status"); }
  catch (err) { throw new Error(`无法确认 PA主服务自动交付版本，${notSubmitted}：${describeError(err)}`); }
  if (response.data.projectDelivery !== true) {
    throw new Error(`PA主服务未加载自动交付版本，${notSubmitted}；不得退回原地派发或手动创建隔离树。`);
  }
}

function jobFrom(response: ApiResponse, value: unknown = response.data.job): Job {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() || typeof value.status !== "string" || !value.status.trim()) {
    throw new Error(`HTTP ${response.status}：主服务 job 缺少 id/status，未确认操作结果。`);
  }
  return value as unknown as Job;
}

function statusMeaning(status: string): string {
  switch (status) {
    case "queued": case "pending": case "accepted": return "队列已接收，尚未执行完成";
    case "starting": return "执行器启动中，尚未完成";
    case "running": case "working": return "执行中，尚未完成";
    case "needs_attention": case "blocked": case "blocked_at_start": case "waiting_input":
      return "需要关注；查看缓存中的问题，不代表成功完成";
    case "idle": return "暂时空闲，不代表成功完成";
    case "completed": case "succeeded": case "done": return "CA 已报告完成，待独立验收；须核验实际改动和测试结果";
    case "reviewing": return "执行已结束，正在独立验收";
    case "failed": return "执行失败，不是成功完成";
    case "timed_out": case "timeout": return "CA 执行超时，不是成功完成";
    case "cancelled": case "canceled": return "任务已取消，不是成功完成";
    case "closed": return "资源已关闭，不等于任务成功完成";
    default: return "未识别状态，不能据此声称成功完成";
  }
}

const DELIVERY_STAGES: Record<string, string> = {
  preparing: "准备交付环境中", prepared: "交付环境已准备", changes_ready: "变更已就绪，待验收/回写",
  applying: "回写原项目中", applied: "已回写，待原目标复验", verified: "原目标复验通过，待清理",
  cleaned: "原目标已验收并清理", blocked: "交付受阻，需要处理", rolled_back: "已回滚，未完成交付",
  partial: "部分回写，未完成交付", failed: "交付失败",
};

function publicString(value: unknown, limit = 1200): string | undefined {
  return typeof value === "string" && value ? value.slice(0, limit) : undefined;
}

function targetIdentity(job: Job): Record<string, string> {
  const delivery = isRecord(job.delivery) ? job.delivery : {};
  const identity = isRecord(delivery.identity) ? delivery.identity : {};
  const project = isRecord(job.projectIdentity) ? job.projectIdentity : {};
  const result: Record<string, string> = {};
  for (const field of ["targetRoot", "targetCwd", "targetBranch", "targetHead"]) {
    const value = publicString(identity[field]) ?? publicString(project[field]);
    if (value) result[field] = value;
  }
  if (!result.targetCwd && publicString(job.cwd)) result.targetCwd = publicString(job.cwd)!;
  return result;
}

/** 只投影交付摘要：不返回 changes 内容、基线、diff 或两个验收的大快照。 */
function deliverySummary(job: Job): DeliverySummary | undefined {
  if (!isRecord(job.delivery)) return undefined;
  const delivery = job.delivery;
  const summary: DeliverySummary = {
    mode: publicString(delivery.mode, 80), state: publicString(delivery.state, 80), identity: targetIdentity(job),
    executionCwd: publicString(job.executionCwd) ?? publicString(delivery.executionCwd),
    worktreePath: publicString(delivery.worktreePath),
    changeCount: Array.isArray(delivery.changes) ? delivery.changes.length : undefined,
    conflictCount: Array.isArray(delivery.conflicts) ? delivery.conflicts.length : undefined,
  };
  for (const field of ["targetUpdated", "alreadyPresent", "cleanupDone", "committed", "pushed", "deployed"] as const) {
    if (typeof delivery[field] === "boolean") summary[field] = delivery[field];
  }
  if (delivery.error) summary.error = describeError(delivery.error).slice(0, 1200);
  return summary;
}

function formatJob(job: Job): string {
  const delivery = deliverySummary(job);
  const identity = targetIdentity(job);
  const executionCwd = publicString(job.executionCwd) ?? delivery?.executionCwd;
  const meaning = job.status === "completed" && job.notifiedAt
    ? "CA 执行已结束；交付以主服务结论为准，不等于原项目已更新"
    : statusMeaning(job.status);
  const lines = [
    `「${publicString(job.name) || job.id}」（${publicString(job.worker) || "未知执行器"}） | job ID=${job.id} | 状态=${job.status}（${meaning}）`,
    `原项目=${identity.targetCwd || "未提供"} | 目标分支=${identity.targetBranch || "未提供/非 Git"}`,
  ];
  if (executionCwd) lines.push(`执行路径=${executionCwd}`);
  if (job.status === "completed" && !job.notifiedAt) lines.push("验收/交付中；隔离树验收通过也不代表原项目已更新。");
  if (job.deliveryHold === true) lines.push("需要处理：交付挂起（deliveryHold），不能当作成功交付；取消/关闭任务不会解除原项目占用。");
  if (delivery) {
    const updated = delivery.state === "rolled_back" ? "已回滚，不能确认交付"
      : delivery.state === "partial" ? "部分回写，需处理"
      : delivery.alreadyPresent === true ? "已包含本次变更"
      : delivery.targetUpdated === true ? "已回写" : "尚未确认回写/包含";
    const cleanup = delivery.mode === "in-place" ? (delivery.cleanupDone === true ? "清理已完成（无临时树）" : "清理未完成（原地修改，无临时树）")
      : delivery.cleanupDone === true ? "已清理" : "未清理";
    const operations = (["committed", "pushed", "deployed"] as const).map((key, index) => {
      const label = ["提交", "推送", "部署"][index];
      return delivery[key] === false ? `未${label}` : delivery[key] === true ? `已${label}（需核实授权）` : `${label}未确认`;
    }).join(" / ");
    lines.push(`交付=${DELIVERY_STAGES[delivery.state || ""] || "阶段未知"}（${delivery.mode || "模式未知"}） | 变更文件=${delivery.changeCount ?? "未知"} | 原项目=${updated} | 临时树=${cleanup}`);
    lines.push(`本任务${operations}`);
    if (delivery.error) lines.push(`交付错误：${delivery.error}`);
    if (delivery.conflictCount) lines.push(`冲突项=${delivery.conflictCount}；保留现场，不覆盖冲突。`);
  } else {
    lines.push("交付=legacy（未提供交付记录），无法据此确认原项目已更新。");
  }
  if (publicString(job.message)) lines.push(`主服务结论：${publicString(job.message)}`);
  return lines.join("\n");
}

function jobDetails(job: Job): Record<string, unknown> {
  const delivery = deliverySummary(job);
  const identity = targetIdentity(job);
  return {
    ok: true, id: job.id, job_id: job.id, name: publicString(job.name), worker: publicString(job.worker),
    status: job.status, cwd: publicString(job.cwd), createdAt: publicString(job.createdAt),
    executionCwd: publicString(job.executionCwd) ?? delivery?.executionCwd, targetBranch: identity.targetBranch,
    notifiedAt: typeof job.notifiedAt === "number" ? job.notifiedAt : publicString(job.notifiedAt),
    deliveryManaged: job.deliveryManaged === true, deliveryHold: job.deliveryHold === true,
    message: publicString(job.message), requestId: publicString(job.requestId), ...(delivery ? { delivery } : { deliveryMode: "legacy" }),
  };
}

function targetRoute(params: Record<string, unknown>): string {
  const target = String(params.target ?? "").trim();
  if (!target) throw new Error("需要 target（受管任务的 job ID、名称或 pane ID）。");
  if (target === "." || target === "..") throw new Error("target 不能是路径跳转片段。");
  return `/${encodeURIComponent(target)}`;
}

const TARGET = { type: "string", description: "受主服务管理的 job ID、名称或 pane ID；不能接管无关终端" };
const SCHEMA_DISPATCH = {
  type: "object",
  properties: {
    task: { type: "string", description: "完整任务：用户目标、允许改动范围、验收条件、必要上下文与项目规则；不得携带密钥" },
    cwd: { type: "string", description: "原项目目录（本机绝对路径）。默认 direct：CA 直接在这里修改，不创建隔离树或副本" },
    isolation: { type: "string", enum: ["direct", "worktree"], description: "默认 direct（直接改原项目）；只有用户明确要求隔离、或任务风险很高时才用 worktree" },
    worker: { type: "string", description: "可选执行器，默认 kimi；只有用户明确要求才改用 claude/codex 等" },
    name: { type: "string", description: "可选任务名称，未填时由后台生成" },
    timeout_minutes: { type: "number", exclusiveMinimum: 0, maximum: MAX_TIMEOUT_MINUTES, default: DEFAULT_TIMEOUT_MINUTES, description: "CA 独立执行 deadline（分钟），默认 60，最大 240；不是 PA 等待时间" },
    wait_ms: { type: "number", description: "仅兼容旧调用，完全忽略；派发始终只等短 HTTP 接收回执，不等执行器启动或任务完成" },
  },
  required: ["task", "cwd"],
  additionalProperties: false,
};
const SCHEMA_STATUS = { type: "object", properties: { target: TARGET }, required: [], additionalProperties: false };
const SCHEMA_READ = {
  type: "object",
  properties: { target: TARGET, lines: { type: "number", description: "缓存快照末尾行数，默认 60，限制为 10–200 行" } },
  required: ["target"],
  additionalProperties: false,
};
const SCHEMA_WAIT = {
  type: "object",
  properties: {
    target: TARGET,
    until: { type: "string", description: "旧参数，忽略；只返回当前状态，不等待目标状态" },
    timeout_ms: { type: "number", description: "旧参数，忽略；不长等、不轮询，也不改变约 10 秒 HTTP 超时" },
  },
  required: ["target"],
  additionalProperties: false,
};
const SCHEMA_REPLY = {
  type: "object",
  properties: {
    target: TARGET,
    text: { type: "string", description: "给受管任务补充要求、回答问题；仅提交后续指令，不等执行完成" },
    wait_ms: { type: "number", description: "兼容旧调用，完全忽略；不占用 PA 等待 CA" },
  },
  required: ["target", "text"],
  additionalProperties: false,
};
const SCHEMA_KEYS = {
  type: "object",
  properties: {
    target: TARGET,
    keys: { type: "string", description: "空格分隔的按键序列，如 down enter；只用于处理已观察到的交互问题" },
    text: { type: "string", description: "可选：先原样输入的文字" },
  },
  required: ["target"],
  additionalProperties: false,
};
const SCHEMA_TARGET = { type: "object", properties: { target: TARGET }, required: ["target"], additionalProperties: false };

export default function delegateToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "agent_dispatch",
    label: "Agent Dispatch",
    description: "向主服务提交持久后台编程任务，立即取得 job ID；不等执行器启动或 CA 完成。",
    promptSnippet: "agent_dispatch: enqueue a persistent background coding job (default kimi), then end this PA turn",
    promptGuidelines: [
      "编程实现、修复、重构、测试应完整委派；默认 kimi，只有用户明确要求才换其他执行器。",
      "Kimi 的 --auto（完全自动）由后台 adapter 保证；不切回询问模式，也不扩大用户授权范围。",
      "沿用已配置的 DeepSeek/deepseek-flash，不要每次用按键重选模型。",
      "wait_ms 完全忽略。timeout_minutes 是 CA 独立 deadline，默认 60 分钟、上限 240 分钟，不是 PA 等待。",
      "收到 job ID 只说明后台接收；立即结束当前轮，普通聊天继续，不要循环 agent_wait/read/status。",
      "先 GET /api/status 确认 projectDelivery=true 再提交。查询历史任务不受此门控。",
      "默认 isolation=direct：CA 直接在 cwd 原项目里修改；没有 worktree、没有回写、没有交付 hold。改动会立即落在原项目，PA 之后只做独立验收。",
      "只有用户明确要求隔离，或任务风险很高时，才传 isolation=worktree。worktree 模式才会创建隔离树并在通过后回写原项目。",
      "不论哪种模式，CA 都不能自行 commit/push/stash/reset/merge 或删除项目；需要额外授权时报告。",
      "自动交付默认不提交、不推送、不部署/发布，也不重启业务服务；MCP 不得绕过任务授权或交付边界。",
      "completed 只是 CA 执行完成；direct 模式下改动已经在原项目，仍需独立验收；主服务结论自动回原渠道，验收上下文不得再派活或重试交付。",
    ],
    parameters: SCHEMA_DISPATCH,
    execute(_id, params) {
      return guarded("派发", true, async (cfg) => {
        const task = String(params.task ?? "").trim();
        const cwd = String(params.cwd ?? "").trim();
        const worker = (String(params.worker ?? "").trim() || "kimi").toLowerCase();
        if (!task) throw new Error("任务描述为空。");
        if (!cwd || !path.isAbsolute(cwd)) throw new Error("cwd 必须是目标项目在本机的绝对路径。");
        if (!existsSync(cwd)) throw new Error("目标目录不存在，请先确认项目路径。");
        if (!/^[a-z0-9_-]+$/.test(worker)) throw new Error("worker 名称无效。");
        const minutes = params.timeout_minutes === undefined ? DEFAULT_TIMEOUT_MINUTES : params.timeout_minutes;
        if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_TIMEOUT_MINUTES || Math.round(minutes * 60_000) < 1) {
          throw new Error("timeout_minutes 必须大于 0 且不超过 240 分钟（默认 60）。");
        }
        const isolation = params.isolation === undefined ? undefined : String(params.isolation);
        if (isolation !== undefined && !["direct", "worktree"].includes(isolation)) throw new Error("isolation 只能是 direct 或 worktree。");
        const body: Record<string, unknown> = { task, cwd, worker, timeoutMs: Math.round(minutes * 60_000), ...(isolation ? { isolation } : {}) };
        const name = String(params.name ?? "").trim();
        if (name) body.name = name;
        const requestId = (process.env.PI_REQUEST_ID ?? "").trim();
        if (requestId) body.requestId = requestId;
        await requireProjectDelivery(cfg, "任务未派发");
        const job = jobFrom(await request(cfg, "", body, 202));
        return text(
          `后台已接收持久任务：${formatJob(job)}。\n这只是接收回执，不代表执行成功。普通聊天可继续；完成/失败后主服务会独立唤起验收并自动回原渠道。请立即结束当前轮，不要本轮反复查询。`,
          { ...jobDetails(job), accepted: true },
        );
      });
    },
  });

  pi.registerTool({
    name: "agent_status",
    label: "Agent Status",
    description: "单次查询受管后台任务的状态快照；未启动的排队任务、已结束任务也可查询。",
    promptSnippet: "agent_status: get a managed job snapshot or list persisted jobs without waiting",
    promptGuidelines: ["用户问进度时查询一次即可；queued/starting/needs_attention 不代表成功完成，不要轮询等结果。"],
    parameters: SCHEMA_STATUS,
    execute(_id, params) {
      return guarded("查询", false, async (cfg) => {
        if (String(params.target ?? "").trim()) {
          const job = jobFrom(await request(cfg, targetRoute(params)));
          return text(`当前状态快照：${formatJob(job)}`, jobDetails(job));
        }
        const response = await request(cfg);
        if (!Array.isArray(response.data.jobs)) throw new Error(`HTTP ${response.status}：主服务缺少 jobs 列表。`);
        const jobs = response.data.jobs.map((job) => jobFrom(response, job));
        return text(jobs.length ? `受管任务快照（${jobs.length} 个）：\n${jobs.map(formatJob).join("\n")}` : "当前没有受管后台任务。", { ok: true, jobs: jobs.map(jobDetails) });
      });
    },
  });

  pi.registerTool({
    name: "agent_read",
    label: "Agent Read",
    description: "读取受管任务已缓存的输出快照；不直接读取终端、不等待新输出。",
    promptSnippet: "agent_read: read a managed job's cached output snapshot, never wait for new output",
    promptGuidelines: ["验收时核对实际输出、改动与测试；需要关注时查看缓存中的具体问题。不要循环读取等待完成。"],
    parameters: SCHEMA_READ,
    execute(_id, params) {
      return guarded("读取", false, async (cfg) => {
        const rawLines = Number(params.lines ?? 60);
        const lines = Number.isFinite(rawLines) ? Math.min(200, Math.max(10, Math.round(rawLines))) : 60;
        const response = await request(cfg, `${targetRoute(params)}/output?lines=${lines}`);
        const job = jobFrom(response);
        if (typeof response.data.output !== "string") throw new Error(`HTTP ${response.status}：主服务缺少缓存 output 字符串。`);
        return text(`缓存快照：${formatJob(job)}\n${response.data.output || "（暂无缓存输出，不代表完成）"}`, jobDetails(job));
      });
    },
  });

  pi.registerTool({
    name: "agent_wait",
    label: "Agent Snapshot (Wait Compatibility)",
    description: "兼容旧名称：只查询一次状态快照，忽略 until/timeout_ms；不等待、不 sleep、不轮询。",
    promptSnippet: "agent_wait: compatibility alias for one quick status snapshot; it never waits for CA completion",
    promptGuidelines: ["不能用它占用 PA 等待 CA；长任务派发后应结束当前轮，由后台独立验收和回传。"],
    parameters: SCHEMA_WAIT,
    execute(_id, params) {
      return guarded("快照查询", false, async (cfg) => {
        const job = jobFrom(await request(cfg, targetRoute(params)));
        return text(`仅查询一次快照：${formatJob(job)}\nuntil / timeout_ms 已忽略，不等待目标状态。请结束当前轮，不要反复查询；后台会独立回传结果。`, jobDetails(job));
      });
    },
  });

  pi.registerTool({
    name: "agent_integrate",
    label: "Agent Integrate",
    description: "短请求重试已完成 CA 的自动交付；先确认服务支持，再 POST integrate，不重跑 CA、不等待交付结束。",
    promptSnippet: "agent_integrate: retry background delivery of a completed job without rerunning CA or waiting",
    promptGuidelines: [
      "只有用户本轮明确要求“重试交付”，或本轮消息点名该 job ID/名称时才可调用；历史任务不是待办，禁止自动复活。",
      "只用于 CA completed、已有 notifiedAt、存在 delivery 且未 cleaned 的任务；后端校验资格并继续后台处理。",
      "变更前先 GET /api/status 严格确认 projectDelivery=true；缺 flag 或预检失败不能 POST，不能退回重派 CA。",
      "不重新派 CA，不清除失败记录，不强行覆盖冲突、不切目标分支；只在原授权范围内重试交付。",
      "接收回执不代表已回写或已验收；结束当前轮，主服务后台继续并自动回原渠道，不循环等待。",
      "owner 与 PI_REVIEW_JOB_ID 限制仍适用，后台验收上下文只读，不能调用此工具。",
    ],
    parameters: SCHEMA_TARGET,
    execute(_id, params) {
      return guarded("重试交付", true, async (cfg) => {
        const route = targetRoute(params);
        await requireProjectDelivery(cfg, "未重试交付");
        const body: Record<string, unknown> = {};
        const requestId = (process.env.PI_REQUEST_ID ?? "").trim();
        const requestText = (process.env.PI_REQUEST_TEXT ?? "").trim();
        if (requestId) body.requestId = requestId;
        if (requestText) body.requestText = requestText;
        const job = jobFrom(await request(cfg, `${route}/integrate`, body, 202));
        return text(`后台已接收重试交付请求，不重跑 CA、不覆盖冲突；尚不代表原项目交付成功。\n${formatJob(job)}\n后台继续处理并自动回传，请结束当前轮，不要循环查询。`, { ...jobDetails(job), accepted: true });
      });
    },
  });

  pi.registerTool({
    name: "agent_reply",
    label: "Agent Reply",
    description: "仅向受管后台任务提交后续指令，不等待执行完成；终态不能用 reply 复活。",
    promptSnippet: "agent_reply: submit a follow-up instruction to a managed job without waiting",
    promptGuidelines: ["补充要求或回答普通问题后结束当前轮；已观察到的选项弹框可用 agent_keys，不要循环等待。"],
    parameters: SCHEMA_REPLY,
    execute(_id, params) {
      return guarded("发送后续指令", true, async (cfg) => {
        const route = targetRoute(params);
        const message = String(params.text ?? "").trim();
        if (!message) throw new Error("需要非空 text。");
        const job = jobFrom(await request(cfg, `${route}/reply`, { text: message }));
        return text(`后台已接收后续指令；仅提交，不等待执行结束。\n${formatJob(job)}\n请结束当前轮，完成/失败将自动回原渠道。`, jobDetails(job));
      });
    },
  });

  pi.registerTool({
    name: "agent_keys",
    label: "Agent Keys",
    description: "通过主服务给受管任务提交按键/文字操作；不能接管无关终端。",
    promptSnippet: "agent_keys: submit keyboard input only for a managed job",
    promptGuidelines: [
      "只处理缓存中已看清的交互问题；按键如 enter/esc/down/up/tab/ctrl+c，文字可用 text 原样输入。",
      "不逐次切换已配置的 DeepSeek/deepseek-flash；Kimi 默认完全自动，仍遵守用户授权范围。",
    ],
    parameters: SCHEMA_KEYS,
    execute(_id, params) {
      return guarded("发送按键", true, async (cfg) => {
        const route = targetRoute(params);
        const keys = String(params.keys ?? "").trim();
        const literal = String(params.text ?? "");
        if (!keys && !literal) throw new Error("keys 和 text 至少要给一个。");
        const job = jobFrom(await request(cfg, `${route}/keys`, { keys, ...(literal ? { text: literal } : {}) }));
        return text(`主服务已接受按键/文字操作请求，不代表任务完成。\n${formatJob(job)}`, jobDetails(job));
      });
    },
  });

  for (const action of ["cancel", "close"] as const) {
    const cancel = action === "cancel";
    pi.registerTool({
      name: `agent_${action}`,
      label: cancel ? "Agent Cancel" : "Agent Close",
      description: cancel ? "请求后台取消受管任务，不操作无关终端。" : "请求后台关闭受管任务资源；未验收或仍需现场检查时不要关闭。",
      promptSnippet: cancel ? "agent_cancel: request cancellation of a managed background job" : "agent_close: request managed job resource cleanup after review",
      promptGuidelines: [cancel ? "只在用户要求取消或任务已不再需要时使用；取消不等于成功完成。" : "在验收完成且不需保留现场时使用；后台验收上下文禁止调用。", "deliveryHold 表示仍需处理；取消/关闭资源不会解除原项目占用或把交付改成成功。"],
      parameters: SCHEMA_TARGET,
      execute(_id, params) {
        return guarded(cancel ? "取消" : "关闭", true, async (cfg) => {
          const job = jobFrom(await request(cfg, `${targetRoute(params)}/${action}`, {}));
          return text(`主服务已接受${cancel ? "取消" : "关闭"}请求。\n${formatJob(job)}`, jobDetails(job));
        });
      },
    });
  }
}
