import path from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.ts";
import { MemoryStore } from "../src/memory.ts";
import { ChatStore } from "../src/store.ts";
import { ingestUploads } from "../src/uploads.ts";
import { PiRunner } from "../src/runner.ts";
import { GuiServer } from "../src/server.ts";

/**
 * 主流程回归自检：不调真实模型、不连外部服务，只验证纯逻辑与约定。
 * 用法：node scripts/smoke.ts
 *
 * 最有价值的几项：
 *  - 记忆：扩展注册与本地归档只读（写入只进 Notion，未配置时拒绝写入，不回落本地）
 *  - 执行器：chat/agent 两条路真的给了不同的工具开关，身份真的进了环境变量
 *  - GUI 服务：接口通不通、路径穿越挡没挡住
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tmp = path.join(root, "memory", "selftest-tmp");

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

// ── 1. 配置 ──
console.log("[配置]");
const example = loadConfig(path.join(root, "config.example.json"));
check("示例配置可加载", !!example.agent.userId && !!example.pi.command);
let threw = "";
try {
  loadConfig(path.join(root, "package.json"));
} catch (e) {
  threw = e instanceof Error ? e.message : String(e);
}
check("缺字段时明确报错", threw.includes("agent.userId") || threw.includes("pi.command"), threw.slice(0, 60));

// 非本机地址必须带口令
const badCfg = path.join(tmp, "bad.json");
writeFileSync(badCfg, JSON.stringify({ ...example, gui: { host: "0.0.0.0", port: 1 } }));
let guard = "";
try {
  loadConfig(badCfg);
} catch (e) {
  guard = e instanceof Error ? e.message : String(e);
}
check("对外监听无口令被拦下", guard.includes("token"), guard.slice(0, 60));

function userIdFromConfig(p: string, fallback: string): string {
  try {
    return String(JSON.parse(readFileSync(p, "utf8"))?.agent?.userId ?? "") || fallback;
  } catch {
    return fallback;
  }
}
const userId = userIdFromConfig(path.join(root, "config.json"), example.agent.userId);

// ── 2. 对话记录 ──
console.log("[对话记录]");
const storeFile = path.join(tmp, "chat.jsonl");
const store = new ChatStore(storeFile);
check("空仓库可读", store.all().length === 0);
const u = store.append({ role: "user", text: "你好" });
store.append({ role: "assistant", text: "在", meta: { tokens: 10, durationMs: 1200 } });
check("追加后可读回", store.all().length === 2 && store.all()[0].id === u.id, u.id);
check("带 id 与时间戳", !!u.id && !Number.isNaN(Date.parse(u.t)));
check("recent 截取末尾", store.recent(1).length === 1 && store.recent(1)[0].role === "assistant");
store.append({ role: "assistant", text: "" });
check("空文本不丢结构", store.all()[2].role === "assistant");
const big = new ChatStore(path.join(tmp, "big.jsonl"));
for (let i = 0; i < 60; i++) big.append({ role: "user", text: `第${i}条` });
check("未超阈值不压缩", big.compact() === false);

// ── 3. 上传取文 ──
console.log("[上传取文]");
const txtFile = path.join(tmp, "笔记.txt");
writeFileSync(txtFile, "这是一份纯文本笔记。\n第二行。", "utf8");
const pngFile = path.join(tmp, "shot.png");
writeFileSync(pngFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
const zipFile = path.join(tmp, "包.zip");
writeFileSync(zipFile, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));

const ing = await ingestUploads([txtFile, pngFile, zipFile, path.join(tmp, "不存在.pdf")], {
  dir: path.join(tmp, "attach"),
  log: () => {},
});
check("文本原样接收", ing.attach.includes(txtFile));
check("图片直接交给 pi", ing.attach.includes(pngFile));
check("压缩包被拒并说明原因", ing.rejected.some((r) => r.includes("包.zip")), ing.rejected.find((r) => r.includes("包.zip")) ?? "");
check("不存在的文件被拒", ing.rejected.some((r) => r.includes("不存在.pdf")));
check("附件说明可用", ing.notes.length === 2, ing.notes.join(" / "));

// ── 4. 记忆：扩展注册 + 本地归档只读 ──
console.log("[记忆]");
const memory = new MemoryStore({
  dir: path.join(root, "memory"),
  summarize: async () => "",
  runText: async () => "",
  log: () => {},
});

type Tool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> };
const tools: Tool[] = [];
const extPath = pathToFileURL(path.join(root, "workspace", ".pi", "extensions", "memory-tools.ts")).href;
const savedNotion = {
  token: process.env.NOTION_TOKEN,
  ds: process.env.NOTION_MEMORY_DS,
  db: process.env.NOTION_MEMORY_DB,
};
delete process.env.NOTION_TOKEN;
delete process.env.NOTION_MEMORY_DS;
delete process.env.NOTION_MEMORY_DB;
process.env.PI_USER_ID = userId;
const extMod = (await import(extPath)) as { default: (pi: { registerTool: (t: Tool) => void }) => void };
extMod.default({ registerTool: (tool) => tools.push(tool) });
if (savedNotion.token !== undefined) process.env.NOTION_TOKEN = savedNotion.token;
if (savedNotion.ds !== undefined) process.env.NOTION_MEMORY_DS = savedNotion.ds;
if (savedNotion.db !== undefined) process.env.NOTION_MEMORY_DB = savedNotion.db;
const remember = tools.find((x) => x.name === "remember")!;
const recall = tools.find((x) => x.name === "recall")!;
const forget = tools.find((x) => x.name === "forget")!;
check("扩展注册了记忆工具", !!remember && !!recall && !!forget);

const ltFile = path.join(root, "memory", "long-term", `${userId.replace(/[^0-9A-Za-z_-]/g, "") || "unknown"}.jsonl`);
const beforeMtime = existsSync(ltFile) ? statSync(ltFile).mtimeMs : 0;
const sel = memory.select(userId, "自检");
const afterMtime = existsSync(ltFile) ? statSync(ltFile).mtimeMs : 0;
check("本地归档可读且不被写入", beforeMtime === afterMtime, `注入 ${sel.lines.length}/${sel.total} 条`);

const refused = await remember.execute("1", { text: "[自检] 不应写入任何地方" });
check(
  "未配置 Notion 时拒绝写入（不回落本地）",
  refused.content[0].text.includes("NOTION") || refused.content[0].text.includes("Notion"),
  refused.content[0].text.slice(0, 60),
);

const sess = await memory.sessionFor(userId);
check("会话文件路径约定", sess.file === path.join(root, "memory", `user-${userId}.jsonl`), sess.file);

// ── 5. 执行器：身份注入与事件解析（用假 pi 回显参数）──
console.log("[执行器]");
// 假 pi：把收到的参数原样回显。参数必须排在脚本路径之后，
// 否则会被 node 自己解析成选项（真实 pi 也是这个调用形态）
// 假 pi 要按真实协议吐 JSONL，否则会被 runner 当成无效行丢掉
const probeFile = path.join(tmp, "probe-args.mjs");
writeFileSync(
  probeFile,
  [
    "const argv = process.argv.slice(2).join(' ');",
    "const info = 'user=' + process.env.PI_USER_ID;",
    "const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    'say({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "echo hi" } });',
    'say({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "hi" }] } });',
    'say({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你" } });',
    'say({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "好" } });',
    'say({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: argv + " | " + info }], usage: { totalTokens: 42, cost: { total: 0.0042 } } } });',
    "",
  ].join("\n"),
);
const probe = new PiRunner({
  command: process.execPath,
  args: [probeFile],
  thinking: "minimal",
  cwd: root,
  maxConcurrent: 1,
  timeoutMs: 30_000,
});

const events: string[] = [];
let toolDetail = "";
const chatRun = await probe.run("测试", {
  userId,
  onEvent: (e) => {
    events.push(e.kind);
    if (e.kind === "tool_start") toolDetail = `${e.name}:${e.detail}`;
  },
});
check("用 json 模式跑", chatRun.text.includes("--mode json"));
check("身份经环境变量注入", chatRun.text.includes(`user=${userId}`));
check("不给工具白名单", !chatRun.text.includes("--tools"));
check("不排除工具", !chatRun.text.includes("--exclude-tools"));
check("文字增量被解析", events.filter((k) => k === "delta").length === 2, events.join(","));
check("工具调用被解析", toolDetail === "bash:echo hi", toolDetail);
check("用量被解析", chatRun.usage?.tokens === 42 && Math.abs((chatRun.usage?.cost ?? 0) - 0.0042) < 1e-9, JSON.stringify(chatRun.usage));
check("结束事件已发出", events.includes("done"), events.join(","));

check("附件以 @路径 传入", (await probe.run("测试", { userId, attachPaths: ["D:/x/y.png"] })).text.includes("@D:/x/y.png"));

// ── 6. GUI 服务：接口与路径穿越防护 ──
console.log("[GUI 服务]");
const port = 18787;
const wsFile = path.join(root, "workspace", "smoke-测试文件.txt");
writeFileSync(wsFile, "workspace 里的文件", "utf8");
let received: { text: string; uploadPaths: string[] } | null = null;
let resetCalled = false;
const token = "smoke-token";
const server = new GuiServer({
  workspace: path.join(root, "workspace"),
  publicDir: path.join(root, "public"),
  uploadDir: path.join(tmp, "uploads"),
  host: "127.0.0.1",
  port,
  token,
  log: () => {},
  onMessage: (input) => (received = input),
  onExternal: async (input) => {
    received = { text: input.text, uploadPaths: [] };
    return "smoke-reply";
  },
  onAbort: () => {},
  onReset: () => { resetCalled = true; },
  status: () => ({ model: "test-model", busy: false }),
  history: () => store.recent(10),
});
await server.listen();
const base = `http://127.0.0.1:${port}`;
const T = `?token=${token}`;

const page = await fetch(`${base}/${T}`);
check("页面可访问", page.ok && (await page.text()).includes("咕嘎一号"));
check("无 token 被拒", (await fetch(`${base}/api/status`)).status === 401);

const st = await (await fetch(`${base}/api/status${T}`)).json();
check("状态接口可用", st.model === "test-model", JSON.stringify(st));

const hist = await (await fetch(`${base}/api/history${T}`)).json();
check("历史接口可用", Array.isArray(hist) && hist.length > 0, `${hist.length} 条`);

const sent = await fetch(`${base}/api/send${T}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "动手看看", uploads: ["/tmp/a.txt"] }),
});
check("发送接口接受消息", sent.ok);
await new Promise((r) => setTimeout(r, 50));
check("附件透传到主程序", received?.uploadPaths?.[0] === "/tmp/a.txt", JSON.stringify(received));

check("空消息被拒", (await fetch(`${base}/api/send${T}`, { method: "POST", body: "{}" })).status === 400);

const resetRes = await fetch(`${base}/api/reset${T}`, { method: "POST" });
check("重置接口可用", resetRes.ok && resetCalled);

const up = await fetch(`${base}/api/upload?name=甲.txt&token=${token}`, { method: "POST", body: Buffer.from("上传内容") });
const upJson = await up.json();
check("上传落盘", up.ok && existsSync(upJson.path), upJson.path);

const wsFileUrl = `${base}/api/file?p=${encodeURIComponent("smoke-测试文件.txt")}&token=${token}`;
check("workspace 文件可读", (await fetch(wsFileUrl)).ok);

const travUrls = ["../config.json", "..%2Fconfig.json", "..\\config.json", "../../config.json"];
let blocked = true;
for (const t of travUrls) {
  const r = await fetch(`${base}/api/file?p=${t}&token=${token}`);
  if (r.ok) blocked = false;
}
check("路径穿越被挡", blocked, travUrls.join(" / "));

unlinkSync(wsFile);
rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? "\n全部通过。" : `\n${failed} 项失败。`);
process.exit(failed === 0 ? 0 : 1);
