/**
 * task-tools 扩展：用自然语言管理定时任务。
 *
 * 工具读写 config.json 的 tasks 数组；主程序监视该文件变化后热更新调度器。
 *
 * 身份：使用者标识由主程序经环境变量 PI_USER_ID 注入，不作为工具参数。
 *
 * 两个刻意的限制：
 *  - 结果只写进本地对话记录（到点你打开页面就能看到）；
 *  - 任务与交互消息使用同一套工具（本地读写/命令 + 联网等全部可用）。
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

import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(MODULE_DIR, "../../..");
const CONFIG_PATH = path.join(ROOT_DIR, "config.json");

interface TaskItem {
  name: string;
  time?: string;
  at?: string;
  days?: number[];
  enabled?: boolean;
  prompt: string;
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function readConfig(): Record<string, unknown> & { agent?: { userId?: string }; tasks?: TaskItem[] } {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

const SCHEMA = {
  type: "object",
  properties: {
    op: { type: "string", description: "操作：add（添加）/ list（列表）/ delete（删除）/ enable（启用）/ disable（停用）" },
    name: { type: "string", description: "任务名称（≤20 字），add/delete/enable/disable 时必填" },
    time: { type: "string", description: "循环任务时刻 HH:MM（24 小时制）：每天/每周重复时用；与 at 二选一" },
    at: { type: "string", description: "一次性任务时刻 \"YYYY-MM-DD HH:MM\"：只触发一次，触发后自动删除；与 time 二选一" },
    days: { type: "array", items: { type: "number" }, description: "配合 time 使用：周几触发（1=周一...7=周日），不传=每天" },
    prompt: { type: "string", description: "到点要执行的任务内容（一段给机器人自己的指令），add 时必填" },
  },
  required: ["op"],
};

export default function taskToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "task_manage",
    label: "Task Manage",
    description: "管理定时任务（添加/列表/删除/启用/停用），到点自动执行并把结果发到私聊。",
    promptSnippet: "task_manage: add/list/delete/enable/disable scheduled tasks",
    promptGuidelines: [
      "把胡同学的自然语言转成结构化参数，时间类型按他的说法选：",
      "  · \"每天X点\" → time=\"HH:MM\"（不传 days）",
      "  · \"每周三X点\" / \"周一和周五X点\" → time=\"HH:MM\" + days=[3] / [1,5]",
      "  · \"明天X点\" / \"9月25日X点\" → at=\"YYYY-MM-DD HH:MM\"（一次性，触发后自动删除）",
      "  日期要用 current_time 工具核对后再写，不要自己推算；不确定是每天还是一次时，问清楚再建。",
      "任务结果会写进本地对话记录，到点打开页面就能看到。",
      "本工具只支持\"固定时刻触发\"的任务，不支持每隔几分钟/几小时的间隔任务；有这类需求时如实说明限制。",
      "任务走问答工具（联网、课表式查询等），没有本地文件和命令权限；需要动本地的事不要建成定时任务。",
      "返回的执行结果要如实转告胡同学。",
    ],
    parameters: SCHEMA,
    async execute(_id, params) {
      const cfg = readConfig();
      const owner = String(cfg.agent?.userId ?? "");
      const asker = (process.env.PI_USER_ID ?? "").trim();
      if (!owner) return text("配置异常（未设置 agent.userId）。");
      if (asker !== owner) return text("身份不匹配，无法管理定时任务。");

      const op = String(params.op ?? "").trim();
      const tasks: TaskItem[] = Array.isArray(cfg.tasks) ? (cfg.tasks as TaskItem[]) : [];
      const save = (newTasks: TaskItem[]): ToolResult => {
        cfg.tasks = newTasks;
        writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
        return text(`已完成。当前共 ${newTasks.length} 个定时任务。`);
      };

      switch (op) {
        case "list": {
          if (tasks.length === 0) return text("还没有定时任务。");
          const lines = tasks.map((t) => {
            const when = t.at
              ? `一次性 ${t.at}`
              : `${t.days?.length ? "每周" + t.days.map((d) => "一二三四五六日"[d - 1]).join("、") : "每天"} ${t.time}`;
            return `${t.enabled === false ? "[停用]" : "[启用]"} ${t.name} | ${when}`;
          });
          return text(`共 ${tasks.length} 个定时任务：\n${lines.join("\n")}`);
        }
        case "add": {
          const name = String(params.name ?? "").trim();
          const time = String(params.time ?? "").trim();
          const at = String(params.at ?? "").trim();
          const prompt = String(params.prompt ?? "").trim();
          if (!name || name.length > 20) return text("任务名称缺失或过长（≤20 字）。");
          if (tasks.some((t) => t.name === name)) return text(`已有同名任务「${name}」。`);
          if (tasks.length >= 20) return text("任务数量已达上限（20 个）。");
          if (!time && !at) return text("需要 time（循环：HH:MM）或 at（一次性：YYYY-MM-DD HH:MM）。");
          if (time && at) return text("time 和 at 只能选一个：循环任务用 time，一次性任务用 at。");
          let normTime = "";
          if (time) {
            const tm = time.match(/^(\d{1,2}):([0-5]\d)$/);
            if (!tm || Number(tm[1]) > 23) return text(`时间格式不对：「${time}」，应为 HH:MM 24 小时制。`);
            normTime = `${String(Number(tm[1])).padStart(2, "0")}:${tm[2]}`;
          }
          let normAt = "";
          if (at) {
            const am = at.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[\sT](\d{1,2}):(\d{2})$/);
            if (!am) return text(`一次性时间格式不对：「${at}」，应为 YYYY-MM-DD HH:MM。`);
            const dt = new Date(Number(am[1]), Number(am[2]) - 1, Number(am[3]), Number(am[4]), Number(am[5]));
            if (isNaN(dt.getTime())) return text(`无效时间：${at}`);
            if (dt.getTime() < Date.now() - 60_000) return text(`「${at}」已经过去了，换一个将来的时间。`);
            normAt = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
          }
          if (!prompt) return text("任务内容缺失。");
          const task: TaskItem = {
            name,
            enabled: true,
            prompt: prompt.slice(0, 300),
            ...(normTime ? { time: normTime } : {}),
            ...(normAt ? { at: normAt } : {}),
          };
          if (Array.isArray(params.days) && params.days.length) {
            task.days = (params.days as unknown[]).map(Number).filter((n) => n >= 1 && n <= 7);
          }
          return save([...tasks, task]);
        }
        case "delete": {
          const name = String(params.name ?? "").trim();
          const newTasks = tasks.filter((t) => t.name !== name);
          if (newTasks.length === tasks.length) return text(`没有找到「${name}」。`);
          return save(newTasks);
        }
        case "enable":
        case "disable": {
          const name = String(params.name ?? "").trim();
          const t = tasks.find((x) => x.name === name);
          if (!t) return text(`没有找到「${name}」。`);
          return save(tasks.map((x) => (x.name === name ? { ...x, enabled: op === "enable" } : x)));
        }
        default:
          return text("未知操作，应为 add/list/delete/enable/disable。");
      }
    },
  });
}
