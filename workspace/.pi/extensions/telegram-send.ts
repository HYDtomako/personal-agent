/**
 * telegram_send：由模型把终态通知发到用户的 Telegram 私聊。
 * 目标只认本轮环境变量里的私聊 id，并且必须在 telegram.allowFrom 里。
 * 不写通知队列，主程序也不代发。
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

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { noticeSendDecision } from "../../../src/user-notice.ts";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CONFIG_PATH = path.join(ROOT_DIR, "config.json");

interface TelegramConfig {
  enabled: boolean;
  token: string;
  apiBase: string;
  proxy: string;
  allowFrom: string[];
}

function loadTelegram(): TelegramConfig {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { telegram?: Record<string, unknown> };
    const telegram = cfg.telegram ?? {};
    return {
      enabled: telegram.enabled !== false,
      token: String(telegram.token ?? "").trim(),
      apiBase: String(telegram.apiBase ?? "https://api.telegram.org").replace(/\/+$/, ""),
      proxy: String(telegram.proxy ?? "socks5h://127.0.0.1:10808"),
      allowFrom: Array.isArray(telegram.allowFrom) ? telegram.allowFrom.map(String) : [],
    };
  } catch {
    return { enabled: false, token: "", apiBase: "https://api.telegram.org", proxy: "", allowFrom: [] };
  }
}

function refused(detail: string): ToolResult {
  return { content: [{ type: "text", text: `未发送 detail=${detail}` }] };
}

function privateChatId(allowFrom: string[]): string {
  const wanted = String(process.env.PI_TELEGRAM_CHAT_ID ?? "").trim();
  if (!/^[1-9]\d*$/.test(wanted)) return "";
  return allowFrom.map((id) => id.trim()).includes(wanted) ? wanted : "";
}

function curl(args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", ["-sS", "--connect-timeout", "15", "-m", "30", "--write-out", "\n%{http_code}", ...args], { windowsHide: true });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { out += chunk; });
    child.stderr.resume();
    child.stdin.on("error", reject);
    child.stdin.end(input, "ascii");
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error("curl failed"));
        return;
      }
      const separator = out.lastIndexOf("\n");
      const status = Number(out.slice(separator + 1));
      if (separator < 0 || !Number.isInteger(status) || status < 200 || status >= 300) {
        reject(new Error("telegram http"));
        return;
      }
      resolve(out.slice(0, separator));
    });
  });
}

async function sendPrivate(chatId: string, text: string, cfg: TelegramConfig): Promise<void> {
  const body = new URLSearchParams({
    chat_id: chatId,
    text,
    disable_web_page_preview: "true",
  }).toString();
  const raw = await curl([
    "-x", cfg.proxy,
    "-H", "content-type: application/x-www-form-urlencoded",
    "--data-binary", "@-",
    `${cfg.apiBase}/bot${cfg.token}/sendMessage`,
  ], body);
  const data = JSON.parse(raw) as { ok?: boolean; result?: { chat?: { id?: number; type?: string } } };
  if (data.ok !== true || data.result?.chat?.type !== "private" || String(data.result.chat.id) !== chatId) {
    throw new Error("not private");
  }
}

export default function telegramSendExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "telegram_send",
    label: "Telegram Send",
    description: "把终态通知发到胡同学的 Telegram 私聊。目标已固定，不能改成群或其他人。",
    promptSnippet: "telegram_send: send the completion notice to the user's Telegram private chat",
    promptGuidelines: [
      "用于后台任务结束，以及本轮超时或中途出错时的白话通知。",
      "text 要讲清原先什么样、这次改了什么、做完没有、哪些验证过、哪些没验证成、还要不要用户动手。",
      "用自己的话写成一两段，不要分条，不要套固定格式，不要照抄别的任务。",
      "少写代码、命令、路径和文件名。不要发空话。任务确实没做完时直说没做完；已经做完的不要说成没做完。",
      "不要传 chat id。工具拒绝时按理由改一版再发，主程序不会替你转发。",
    ],
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "发给私聊的白话通知，纯文本，不要 Markdown。" },
      },
      required: ["text"],
    },
    async execute(_id, params) {
      const cfg = loadTelegram();
      if (!cfg.enabled || !cfg.token || cfg.token.includes("BotFather")) return refused("telegram-not-configured");
      const chatId = privateChatId(cfg.allowFrom);
      if (!chatId) return refused("no-private-chat");
      const decision = noticeSendDecision(String(params.text ?? ""));
      if (!decision.send) return refused(decision.detail);
      try {
        await sendPrivate(chatId, decision.text, cfg);
      } catch {
        return refused("send-failed");
      }
      return { content: [{ type: "text", text: "已发到 Telegram 私聊" }] };
    },
  });
}
