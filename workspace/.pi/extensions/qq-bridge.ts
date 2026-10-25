/**
 * qq-bridge 扩展：与 QQ bot 通信（bot 目录由环境变量 QQ_BOT_DIR 指定）。
 *
 * 文件信箱，异步、互不阻塞：
 *  - 收：每轮对话开始前（before_agent_start）读取 memory/bridge/to-guga.jsonl 里 bot
 *    留的言，读走后清空，并把内容注入本次上下文 —— 胡同学经 QQ bot 转达的话会自动出现。
 *  - 发：qq_send 工具把消息追加到 memory/bridge/to-qq.jsonl，bot 桥接每 3 秒轮询并
 *    通过 OneBot 真发到 QQ（群或私聊）。
 *
 * 安全：bot 侧已校验「只有胡同学能留言」；本扩展只读写这两个信箱文件与 bot 配置里的
 * 默认群号，不碰任何密钥，也不做文件/命令之外的额外能力。
 */

interface ExtensionAPI {
  registerTool(tool: ToolRegistration): void;
  on(event: string, handler: (event: { prompt?: string }, ctx: unknown) => unknown): void;
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

import path from "node:path";
import os from "node:os";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// QQ bot 的目录（与 bot 侧 extensions/bridge-tools.ts、src/main.ts 约定一致；可用 QQ_BOT_DIR 覆盖）
const BOT_DIR = process.env.QQ_BOT_DIR?.trim() || path.join(os.homedir(), "pi-napcatqq");
const BRIDGE_DIR = path.join(BOT_DIR, "memory", "bridge");
const TO_GUGA = path.join(BRIDGE_DIR, "to-guga.jsonl");
const TO_QQ = path.join(BRIDGE_DIR, "to-qq.jsonl");
const BOT_CONFIG = path.join(BOT_DIR, "config.json");

const MAX_TEXT_LEN = 3000;

/** 读走 bot 留的言并清空信箱，返回可注入的文本（无留言返回空串）。 */
function drainInbox(): string {
  try {
    if (!existsSync(TO_GUGA)) return "";
    const raw = readFileSync(TO_GUGA, "utf8");
    if (!raw.trim()) return "";
    writeFileSync(TO_GUGA, "");
    const parts: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { text?: string; t?: string; from?: string };
        if (e?.text) parts.push(`- ${e.text}`);
      } catch {
        /* 跳过坏行 */
      }
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

function defaultGroup(): string {
  try {
    return String(JSON.parse(readFileSync(BOT_CONFIG, "utf8"))?.bot?.defaultGroup ?? "");
  } catch {
    return "";
  }
}

const SCHEMA = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description:
        "要发到 QQ 的消息正文（纯文本，不要 Markdown）。写给人看的简洁答复：只回答对方问的事，不写工作报告。",
    },
    to: {
      type: "string",
      description: "目标，形如 group:<群号> 或 private:<QQ号>；不填则发到 bot 的默认目标",
    },
  },
  required: ["text"],
};

export default function qqBridgeExtension(pi: ExtensionAPI) {
  // 收：把 bot 的留言注入本轮上下文（读走即清空，不重复）
  pi.on("before_agent_start", async () => {
    const pending = drainInbox();
    if (!pending) return;
    return {
      message: {
        customType: "qq-bridge",
        display: true,
        content:
          `[来自 QQ bot（企鹅主任）的留言]\n${pending}\n\n` +
          `以上是胡同学经 QQ bot 转达给你的。要回到 QQ（群或私聊），用 qq_send 工具；` +
          `不填 to 就发到 bot 的默认群。`,
      },
    };
  });

  // 发：写 to-qq.jsonl，bot 桥接 3 秒内真发到 QQ
  pi.registerTool({
    name: "qq_send",
    label: "QQ Send",
    description: "把一条消息发给 QQ（经 QQ bot / 企鹅主任发送到群或私聊）。",
    promptSnippet: "qq_send: send a message to QQ via the 企鹅主任 bot (group or private)",
    promptGuidelines: [
      "胡同学让你往 QQ 群/某人发消息、或你要把结果回给 QQ 时调用。",
      "text 是要发的原文，纯文本、不要 Markdown。",
      "只写给对方看的结论：先回答他问的事，必要时补 1-3 条要点，全文尽量 400 字以内。",
      "别把工作报告发过去：查证过程、PID、文件路径、命令、配置项、备份位置、工具名、时间戳都不要，这些留在对话里给胡同学看。",
      "是回执就一两句话说清「做没做、成没成、他还需要做什么」。",
      "to 不填则发到 bot 的默认群；指定时用 group:<群号> 或 private:<QQ号>。",
      "发送是异步的（bot 几秒内送出），提交成功后如实告诉胡同学「已提交，稍后送达」。",
    ],
    parameters: SCHEMA,
    async execute(_id, params) {
      const body = String(params.text ?? "").trim();
      if (!body) return result("要发送的内容为空。");
      if (body.length > MAX_TEXT_LEN) return result(`内容太长（${body.length} 字），请压缩到 ${MAX_TEXT_LEN} 字以内。`);

      const to = String(params.to ?? "").trim();
      let type = "group";
      let id = defaultGroup();
      if (to) {
        const m = to.match(/^(group|private)\s*[:：]\s*(.+)$/i);
        if (m) {
          type = m[1].toLowerCase();
          id = m[2].trim();
        } else {
          id = to.replace(/[^0-9]/g, "");
        }
      }
      if (!id) return result("没指定目标，且 bot 配置里也没有默认群。用 to=group:<群号> 或 private:<QQ号> 指定。");

      mkdirSync(BRIDGE_DIR, { recursive: true });
      appendFileSync(TO_QQ, JSON.stringify({ t: new Date().toISOString(), type, id, text: body }) + "\n");
      return result(`已提交，几秒内会由企鹅主任发送到 ${type} ${id}。内容：\n${body}`);
    },
  });
}

function result(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}
