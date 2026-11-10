import { readFileSync } from "node:fs";
import type { ScheduledTask } from "./tasks.ts";

/**
 * 配置：单一使用者的个人 agent。
 *
 * 通信凭据在本文件里：`telegram.token`（Bot API，由 tg-bridge.mjs 读取）、
 * `gui.token`（局域网访问口令）。模型与检索 key 在 `pi`。
 * QQ 不是主入口，也不在这里配账号；可选信箱目录才是 `delegations.qqBridgeDir`。
 *
 * 注意几处"必须与扩展对齐"的约定（扩展是独立进程，自己读配置文件）：
 *  - `agent.userId`：扩展用它校验身份（workspace/.pi/extensions/{memory,model,task}-tools.ts）
 *  - `pi.models` / `pi.defaultModel`：model_manage 工具读写 `.model-state.json` 用
 *  - `tasks`：task_manage 工具直接改写这个数组，主程序监视文件变化后热更新
 *  - `telegram`：字段与 tg-bridge.mjs 的 loadCfg、app/launch.ts 的启停判断对齐
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
    /** 本轮追加背景 JSON 的字符预算，不截断用户原文；默认 12000。 */
    maxBackgroundChars?: number;
  };
  gui: {
    /** 监听地址；127.0.0.1=只本机。改成 0.0.0.0 必须同时设 token */
    host?: string;
    port?: number;
    /** 访问口令（留空=不校验；局域网访问时必填） */
    token?: string;
  };
  /**
   * Telegram 桥（tg-bridge.mjs）。整段缺失时启动器不拉桥。
   * 段在且 `enabled !== false` 时视为启用，必须有 token（与 app/launch.ts 一致）。
   */
  telegram?: {
    /** false：启动器跳过桥接，直接跑 tg-bridge 也会马上退出。 */
    enabled?: boolean;
    /** BotFather 的 bot token。启用时必填，不要写进 apiBase。 */
    token?: string;
    /** Bot API 根地址，默认 https://api.telegram.org。 */
    apiBase?: string;
    /** curl -x 代理。缺省 socks5h://127.0.0.1:10808；不要填空字符串。 */
    proxy?: string;
    /** 允许转发进 PA 的 Telegram user id。空数组时桥只回显 id，不转发消息。 */
    allowFrom?: Array<string | number>;
    /** getUpdates 长轮询秒数，0–50，默认 30。 */
    pollTimeoutSec?: number;
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
  positive("agent.maxBackgroundChars", cfg.agent.maxBackgroundChars);
  if (cfg.agent.maxBackgroundChars !== undefined && cfg.agent.maxBackgroundChars < 2) throw new Error(`config ${path}: agent.maxBackgroundChars 至少为 2`);
  positive("notion.timeoutMs", cfg.notion?.timeoutMs);
  positive("notion.connectTimeoutMs", cfg.notion?.connectTimeoutMs);
  positive("memory.cacheTtlSeconds", cfg.memory?.cacheTtlSeconds);
  for (const field of ["timeoutMs", "maxTimeoutMs", "idleWarningMs", "pollIntervalMs", "startupTimeoutMs", "maxConcurrent", "reviewTimeoutMs"] as const) {
    positive(`delegations.${field}`, cfg.delegations?.[field]);
  }
  // 未显式设 timeoutMs 时不比较：默认 1h 由 DelegationManager 按 maxTimeoutMs 自动 clamp。
  if (cfg.delegations?.timeoutMs !== undefined && cfg.delegations.timeoutMs > (cfg.delegations.maxTimeoutMs ?? 14_400_000)) {
    throw new Error(`config ${path}: delegations.timeoutMs 不能大于 maxTimeoutMs`);
  }
  if (cfg.delegations?.mode !== undefined && !["direct", "worktree"].includes(cfg.delegations.mode)) {
    throw new Error(`config ${path}: delegations.mode 只能是 direct 或 worktree`);
  }
  validateTelegram(cfg, path);
  return cfg;
}

function validateTelegram(cfg: AgentConfig, path: string): void {
  const tg = cfg.telegram;
  if (tg === undefined) return;
  if (tg === null || typeof tg !== "object" || Array.isArray(tg)) {
    throw new Error(`config ${path}: telegram 必须是对象`);
  }
  if (tg.enabled !== undefined && typeof tg.enabled !== "boolean") {
    throw new Error(`config ${path}: telegram.enabled 必须是布尔值`);
  }
  if (tg.token !== undefined && typeof tg.token !== "string") {
    throw new Error(`config ${path}: telegram.token 必须是字符串`);
  }
  const enabled = tg.enabled !== false;
  if (enabled && !tg.token?.trim()) {
    throw new Error(`config ${path}: telegram 已启用但 token 为空（不需要桥接时设 telegram.enabled=false，或删掉整段 telegram）`);
  }
  if (enabled && tg.token && /BotFather|必填|你的-|placeholder|REPLACE/i.test(tg.token)) {
    throw new Error(`config ${path}: telegram.token 还是示例占位，请换成 BotFather 发的 token，或设 telegram.enabled=false`);
  }
  if (tg.apiBase !== undefined) {
    if (typeof tg.apiBase !== "string" || !tg.apiBase.trim()) {
      throw new Error(`config ${path}: telegram.apiBase 必须是 http(s) 地址`);
    }
    let url: URL;
    try {
      url = new URL(tg.apiBase);
    } catch {
      throw new Error(`config ${path}: telegram.apiBase 不是合法 URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`config ${path}: telegram.apiBase 只支持 http 或 https`);
    }
    if (url.username || url.password) throw new Error(`config ${path}: telegram.apiBase 不要携带账号密码`);
    if (/\/bot[^/]*\d+:/i.test(url.pathname)) {
      throw new Error(`config ${path}: telegram.apiBase 不要包含 bot token，token 单独写在 telegram.token`);
    }
  }
  if (tg.proxy !== undefined) {
    if (typeof tg.proxy !== "string" || !tg.proxy.trim()) {
      throw new Error(`config ${path}: telegram.proxy 必须是代理 URL（缺省由桥接使用 socks5h://127.0.0.1:10808；不要填空字符串）`);
    }
    let url: URL;
    try {
      url = new URL(tg.proxy);
    } catch {
      throw new Error(`config ${path}: telegram.proxy 不是合法 URL`);
    }
    if (!["socks5:", "socks5h:", "socks4:", "socks4a:", "http:", "https:"].includes(url.protocol)) {
      throw new Error(`config ${path}: telegram.proxy 协议只支持 socks5、socks5h、socks4、socks4a、http、https`);
    }
  }
  if (tg.allowFrom !== undefined) {
    if (!Array.isArray(tg.allowFrom)) {
      throw new Error(`config ${path}: telegram.allowFrom 必须是 Telegram 数字 id 数组（留空则只回显 id、不转发）`);
    }
    for (const id of tg.allowFrom) {
      const text = typeof id === "number" ? String(id) : id;
      if (typeof text !== "string" || !/^-?\d{1,20}$/.test(text.trim())) {
        throw new Error(`config ${path}: telegram.allowFrom 里的每一项都必须是 Telegram 数字 id`);
      }
    }
  }
  if (tg.pollTimeoutSec !== undefined && (!Number.isSafeInteger(tg.pollTimeoutSec) || tg.pollTimeoutSec < 0 || tg.pollTimeoutSec > 50)) {
    throw new Error(`config ${path}: telegram.pollTimeoutSec 必须是 0 到 50 的整数（getUpdates 长轮询秒数，默认 30）`);
  }
}
