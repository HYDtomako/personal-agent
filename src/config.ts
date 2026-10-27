import { readFileSync } from "node:fs";
import type { ScheduledTask } from "./tasks.ts";

/**
 * 配置：单一使用者的个人 agent，没有任何通信平台的凭据。
 *
 * 注意几处"必须与扩展对齐"的约定（扩展是独立进程，自己读配置文件）：
 *  - `agent.userId`：扩展用它校验身份（workspace/.pi/extensions/{memory,model,task}-tools.ts）
 *  - `pi.models` / `pi.defaultModel`：model_manage 工具读写 `.model-state.json` 用
 *  - `tasks`：task_manage 工具直接改写这个数组，主程序监视文件变化后热更新
 */
export interface AgentConfig {
  agent: {
    /** 使用者的记忆键与身份标识（记忆按它归档；扩展用它做校验） */
    userId: string;
    /** pi 的工作目录（相对仓库根；它能自由读写的范围，注意这不是沙箱） */
    workspace?: string;
    maxConcurrent?: number;
    /** PA 单轮时限，不包含后台 CA 的执行时间。 */
    timeoutMs?: number;
  };
  gui: {
    /** 监听地址；127.0.0.1=只本机。改成 0.0.0.0 必须同时设 token */
    host?: string;
    port?: number;
    /** 访问口令（留空=不校验；局域网访问时必填） */
    token?: string;
  };
  telegram?: {
    proxy?: string;
  };
  delegations?: {
    /** direct（默认）：CA 直接在原项目修改；worktree：隔离树 + 回写。 */
    mode?: "direct" | "worktree";
    timeoutMs?: number;
    maxTimeoutMs?: number;
    idleWarningMs?: number;
    pollIntervalMs?: number;
    startupTimeoutMs?: number;
    maxConcurrent?: number;
    reviewTimeoutMs?: number;
    qqBridgeDir?: string;
  };
  pi: {
    command: string;
    args: string[];
    thinking: string;
    tavilyKey?: string;
    aliyunKey?: string;
    aliyunBaseUrl?: string;
    defaultModel?: string;
    models?: Record<string, string>;
  };
  memory?: {
    windowMs?: number;
    summarizeMinBytes?: number;
    /** 上下文窗口 token 数（默认 128k；压缩判定是 文件字节÷3 的粗估） */
    contextWindow?: number;
    /** 会话累积到窗口的这个比例就归档压缩（默认 0.8） */
    compressAt?: number;
    /** 每轮注入长期记忆的字符上限（默认 800） */
    maxInjectChars?: number;
    /** 注入的相关度门槛：问题词组被记忆条目覆盖的比例（0-1，默认 0.2） */
    minRelevanceScore?: number;
    /** Notion 记忆内存缓存有效期（秒，默认 300=5 分钟；TTL 内不发请求） */
    cacheTtlSeconds?: number;
  };
  notion?: {
    /** Notion Memory 数据库的 data source id（2025-09-03 API 查询用） */
    dataSourceId?: string;
    /** Notion Memory 数据库 id（扩展新建页面用） */
    databaseId?: string;
    /** 单次 Notion API 尝试的超时（毫秒，默认 3500；重试共 3 次） */
    timeoutMs?: number;
    /** 建连/TLS 握手超时（毫秒，默认 3000） */
    connectTimeoutMs?: number;
  };
  files?: {
    maxTextChars?: number;
    maxTotalChars?: number;
    pdftotext?: string;
  };
  web?: {
    maxTextChars?: number;
  };
  video?: {
    enabled?: boolean;
    ytDlp?: string;
    proxy?: string;
    maxDurationSec?: number;
    maxTranscriptChars?: number;
    timeoutMs?: number;
    summaryTimeoutMs?: number;
    keepArtifacts?: boolean;
  };
  tasks?: ScheduledTask[];
}

export function loadConfig(path: string): AgentConfig {
  const cfg = JSON.parse(readFileSync(path, "utf8")) as AgentConfig;
  if (!cfg.agent?.userId) throw new Error(`config ${path}: agent.userId 缺失（用作记忆归档与身份校验的键）`);
  if (!cfg.pi?.command) throw new Error(`config ${path}: pi.command 缺失（启动 pi 的命令，如 node）`);
  if (!Array.isArray(cfg.pi?.args)) throw new Error(`config ${path}: pi.args 缺失（pi CLI 的路径与参数）`);
  if (cfg.gui?.host && cfg.gui.host !== "127.0.0.1" && cfg.gui.host !== "localhost" && !cfg.gui.token) {
    throw new Error(
      `config ${path}: gui.host 不是本机地址（${cfg.gui.host}）却没有设 gui.token——那等于把有 shell 权限的 agent 开放给整个网段`,
    );
  }
  const positive = (name: string, value: number | undefined) => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`config ${path}: ${name} 必须为正整数`);
  };
  positive("agent.timeoutMs", cfg.agent.timeoutMs);
  positive("agent.maxConcurrent", cfg.agent.maxConcurrent);
  positive("notion.timeoutMs", cfg.notion?.timeoutMs);
  positive("notion.connectTimeoutMs", cfg.notion?.connectTimeoutMs);
  positive("memory.cacheTtlSeconds", cfg.memory?.cacheTtlSeconds);
  for (const field of ["timeoutMs", "maxTimeoutMs", "idleWarningMs", "pollIntervalMs", "startupTimeoutMs", "maxConcurrent", "reviewTimeoutMs"] as const) {
    positive(`delegations.${field}`, cfg.delegations?.[field]);
  }
  if ((cfg.delegations?.timeoutMs ?? 3_600_000) > (cfg.delegations?.maxTimeoutMs ?? 14_400_000)) {
    throw new Error(`config ${path}: delegations.timeoutMs 不能大于 maxTimeoutMs`);
  }
  if (cfg.delegations?.mode !== undefined && !["direct", "worktree"].includes(cfg.delegations.mode)) {
    throw new Error(`config ${path}: delegations.mode 只能是 direct 或 worktree`);
  }
  return cfg;
}
