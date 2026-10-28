// 离线验证「后台任务 → 对话短汇报」：不启动服务、不调用模型、不派发任务、不写 memory/。
// 从 src/main.ts 截取 report-summary 区块和 handleDelegationEvent，用桩依赖跑真实代码路径。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src", "main.ts"), "utf8");
let checks = 0;
const pass = (message) => { checks += 1; console.log(`ok ${checks} ${message}`); };

/** 从声明起点按括号配对截出整个函数（跳过字符串、模板、注释）。 */
function sliceDeclaration(text, signature) {
  const start = text.indexOf(signature);
  assert(start >= 0, `main.ts 缺少 ${signature}`);
  const open = text.indexOf("{", start + signature.length);
  assert(open > 0, `${signature} 缺少函数体`);
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") { const nl = text.indexOf("\n", i); i = nl < 0 ? text.length : nl; continue; }
    if (ch === "/" && text[i + 1] === "*") { const close = text.indexOf("*/", i + 2); i = close < 0 ? text.length : close + 1; continue; }
    if (ch === "\"" || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") { depth -= 1; if (depth === 0) return text.slice(start, i + 1); }
  }
  throw new Error(`${signature} 函数体未闭合`);
}

function sliceBlock(text, beginMark, endMark) {
  const from = text.indexOf(beginMark);
  const to = text.indexOf(endMark);
  assert(from >= 0 && to > from, `main.ts 缺少 ${beginMark} / ${endMark} 区块标记`);
  const bodyStart = text.indexOf("\n", from + beginMark.length) + 1;
  assert(bodyStart > 0 && bodyStart < to, `${beginMark} 与 ${endMark} 之间没有代码`);
  return text.slice(bodyStart, to);
}

const blockSource = sliceBlock(source, "// BEGIN report-summary", "// END report-summary");
const blockJs = stripTypeScriptTypes(blockSource, { mode: "transform" });
const handlerJs = stripTypeScriptTypes(sliceDeclaration(source, "async function handleDelegationEvent("), { mode: "transform" });

const logs = [];
function loadBlock(scheduler) {
  return new Function(
    "log", "setTimeout", "clearTimeout",
    `${blockJs}\nreturn { summarizeForUser, summaryFallback, summaryPrompt, cleanUserReport, withSummaryDeadline, userReportTimeoutMs, userReportMaxChars };`,
  )(
    (...args) => { logs.push(args.map(String).join(" ")); },
    scheduler.setTimeout,
    scheduler.clearTimeout,
  );
}

/** 手动推进的计时器：测试绝不真等 60 秒。 */
function makeScheduler() {
  const pending = new Map();
  let seq = 0;
  return {
    setTimeout: (callback, ms) => { seq += 1; pending.set(seq, { callback, ms }); return { id: seq, unref() {} }; },
    clearTimeout: (handle) => { if (handle && pending.has(handle.id)) pending.delete(handle.id); },
    delays: () => [...pending.values()].map((item) => item.ms),
    fireAll: () => { const items = [...pending.entries()]; pending.clear(); for (const [, item] of items) item.callback(); },
    size: () => pending.size,
  };
}

const live = makeScheduler();
const api = loadBlock(live);
const input = (over = {}) => ({
  id: "ca-selftest-1", kind: "completed", verdict: "passed",
  rawText: '{"verdict":"passed","summary":"ok","checks":["\\u5df2\\u8dd1 tsc","diff --git a/x b/x"],"tools":["read","bash"]}\nPID 1234\n/memory/worktrees/ca-selftest-1',
  ...over,
});
const FALLBACK = "后台任务 ca-selftest-1 验收通过，明细见任务面板。";

try {
  assert.equal(api.userReportTimeoutMs, 60_000, "改写超时必须是独立常量 60000ms");
  assert.equal(api.userReportMaxChars, 200);
  let prompt = "";
  const good = "验收通过。已完成类型检查与自测，未提交、未推送、未部署；无需你操作。";
  assert.equal(await api.summarizeForUser(input(), async (text) => { prompt = text; return good; }), good);
  assert.match(prompt, /不要 Markdown 符号/);
  assert.match(prompt, /不要 JSON/);
  assert.match(prompt, /不要 diff/);
  assert.match(prompt, /原先是什么样/);
  assert.match(prompt, /现在是什么样/);
  assert.match(prompt, /做了什么/);
  assert.match(prompt, /成没成/);
  assert.match(prompt, /需不需要动手/);
  assert.match(prompt, /不超过 200 个汉字/);
  assert.match(prompt, /未能确认/);
  assert.match(prompt, /不可信数据/);
  assert.match(prompt, /系统判定：验收通过/);
  assert.match(prompt, /PID 1234/, "原始明细必须交给模型（否则无法判断提交/推送/部署状态）");
  pass("正常改写：走一次模型调用，提示词含五段式/长度/不编造/不可信原文约束");

  assert.equal(await api.summarizeForUser(input(), async () => { throw new Error("model down"); }), FALLBACK);
  assert.equal(await api.summarizeForUser(input(), () => { throw new Error("sync boom"); }), FALLBACK);
  assert.equal(await api.summarizeForUser(input(), async () => ""), FALLBACK);
  assert.equal(await api.summarizeForUser(input(), async () => "   \n  "), FALLBACK);
  assert.equal(await api.summarizeForUser(input(), async () => '{"verdict":"passed","summary":"ok"}'), FALLBACK);
  assert.equal(await api.summarizeForUser(input(), async () => "```text\n验收通过\n```"), FALLBACK);
  assert.equal(await api.summarizeForUser(input(), async () => "结论：验收通过，明细 {\"a\":1}"), FALLBACK);
  assert(logs.some((line) => line.includes("改用模板")), "回退必须留日志");
  pass("回退：抛错/同步抛错/空串/空白/JSON/代码块/含花括号一律返回模板文案，不抛异常");

  const tightened = await api.summarizeForUser(input(), async () => "**结论**：验收通过\n- 未提交、未推送、未部署\n> 未跑全量测试");
  assert.equal(tightened, "结论：验收通过 未提交、未推送、未部署 未跑全量测试");
  assert(!tightened.includes("*") && !tightened.includes("-") && !tightened.includes("\n"));
  const long = await api.summarizeForUser(input(), async () => "验".repeat(300));
  assert.equal([...long].length, 201, `超长必须截断到 200 字 + 省略号，实际 ${[...long].length}`);
  assert(long.endsWith("…"));
  pass("清洗：去掉 Markdown 符号/编号/多行，超长按 200 字截断");

  const timeouts = makeScheduler();
  const timeoutApi = loadBlock(timeouts);
  const blocked = timeoutApi.summarizeForUser(input({ verdict: "failed", id: "ca-selftest-hang" }), () => new Promise(() => {}));
  assert.deepEqual(timeouts.delays(), [60_000], "硬期限必须是 60000ms");
  timeouts.fireAll();
  assert.equal(await blocked, "后台任务 ca-selftest-hang 验收未通过，有未解决项，详见任务面板。尚未提交、未推送、未部署。");
  assert.equal(timeouts.size(), 0, "计时器必须清理");
  assert.equal(live.size(), 0, "正常路径的计时器也必须清理");
  pass("超时：模型不响应 60 秒即回退模板，且清理计时器");

  const verdicts = {
    passed: "验收通过，明细见任务面板。",
    failed: "验收未通过，有未解决项，详见任务面板。尚未提交、未推送、未部署。",
    unverified: "已结束，但未完成独立验收，详见任务面板。",
    delivered: "已交付并通过原目标复验，明细见任务面板。尚未提交、未推送、未部署。",
    undelivered: "交付未完成，需要关注，详见任务面板。",
    unsettled: "已完成执行，但收尾尚未确认，明细见任务面板。",
    error: "执行失败，详见任务面板。",
    timeout: "达到执行时限，详见任务面板。",
    cancelled: "已取消，详见任务面板。",
  };
  for (const [verdict, tail] of Object.entries(verdicts)) {
    assert.equal(api.summaryFallback(input({ verdict })), `后台任务 ca-selftest-1 ${tail}`);
    assert(!/PID|端口|worktrees|diff|JSON/.test(tail), "模板不得含明细字段");
  }
  pass("模板：9 种结论各有一句短文案，均不含 PID/路径/diff");

  // ── 用真实 handleDelegationEvent 跑完整落库路径：改写抛错时通知与对话记录仍写入 ──
  const buildHandler = (summarize, deps) => new Function(
    "broadcastJobs", "notifications", "store", "server", "deliveryPipeline", "delegations", "projects",
    "reviewDelegation", "summarizeForUser", "rewriteReportWithModel", "redactSensitive",
    `${handlerJs}\nreturn handleDelegationEvent;`,
  )(
    deps.broadcastJobs, deps.notifications, deps.store, deps.server, deps.deliveryPipeline, deps.delegations, deps.projects,
    deps.reviewDelegation, summarize, deps.rewriteReportWithModel, deps.redactSensitive,
  );

  function harness(over = {}) {
    const order = [];
    const notes = new Map();
    const chats = [];
    const deps = {
      broadcastJobs: () => order.push("broadcastJobs"),
      notifications: {
        get: (id) => notes.get(id),
        put: (record) => { order.push(`put:${record.text}`); notes.set(record.id, record); return record; },
        ack: (id) => { order.push(`ack:${id}`); return true; },
      },
      store: {
        appendOnce: (message) => { order.push(`append:${message.text}`); chats.push(message); return { message, inserted: true }; },
      },
      server: { broadcast: () => order.push("broadcast") },
      deliveryPipeline: { run: async () => ({ text: "交付原文：diff --git ... 工作树 /memory/worktrees/ca-x", delivered: true, holdProject: false }) },
      delegations: { setDeliveryHold: () => {} },
      projects: { get: () => undefined },
      reviewDelegation: async () => ({
        verdict: "passed", summary: "ok",
        text: "后台任务 ca-x：验收通过。\n- 已跑 npx tsc --noEmit\n- PID 4321 端口 8787 /memory/worktrees/ca-x\n{\"checks\":[\"a\"]}",
      }),
      rewriteReportWithModel: async () => { throw new Error("model unreachable"); },
      redactSensitive: (text) => text,
      ...over,
    };
    return { deps, notes, chats, order, handler: buildHandler(over.summarize ?? ((item, rewrite) => api.summarizeForUser(item, rewrite)), deps) };
  }

  const completed = harness();
  const job = {
    id: "ca-x", status: "completed", deliveryManaged: false, source: { channel: "telegram", chatId: "-100", threadId: 1 },
    message: "完成", task: "task", lastOutput: "",
  };
  await completed.handler(job, "terminal");
  const notification = completed.notes.get("job:ca-x:terminal:terminal");
  assert(notification, "通知必须落库");
  assert.equal(notification.text, "后台任务 ca-x 验收通过，明细见任务面板。");
  assert.equal(notification.kind, "job");
  assert.deepEqual(completed.chats.map((item) => item.text), [notification.text], "对话里的文本必须与通知一致");
  assert.equal(completed.order.filter((item) => item.startsWith("put:")).length, 1);
  assert(completed.order.findIndex((item) => item.startsWith("put:")) < completed.order.findIndex((item) => item.startsWith("append:")), "通知先于对话记录");
  assert(!notification.text.includes("tsc") && !notification.text.includes("PID") && !notification.text.includes("worktrees"), "对话里不能出现明细");
  pass("落库：模型抛错时仍写通知与对话记录，且对话文本是模板短文案（明细只留在面板）");

  const delivered = harness();
  await delivered.handler({ ...job, deliveryManaged: true, deliveryAttempt: 2 }, "terminal");
  const deliveredNote = delivered.notes.get("job:ca-x:terminal:terminal:delivery-2");
  assert(deliveredNote, "交付任务的去重 id 必须保留 deliveryAttempt 后缀");
  assert.equal(deliveredNote.text, "后台任务 ca-x 已交付并通过原目标复验，明细见任务面板。尚未提交、未推送、未部署。");
  pass("交付分支：去重 id 带 :delivery-N，回退到交付模板");

  const failed = harness({ reviewDelegation: async () => ({ verdict: "failed", summary: "x", text: "原始验收" }) });
  await failed.handler({ ...job, status: "timed_out", message: "超过 60 分钟", cleanupError: "pane 未关闭" }, "terminal");
  assert.equal(failed.notes.get("job:ca-x:terminal:terminal").text, "后台任务 ca-x 达到执行时限，详见任务面板。");
  pass("失败分支：超时回退模板，收尾未确认等明细不进入对话");

  const attention = harness({ summarize: async () => { throw new Error("attention 不允许改写"); } });
  await attention.handler({ ...job, attentionSequence: 7, message: "15 分钟无进展" }, "attention");
  const attentionNote = attention.notes.get("job:ca-x:attention:7");
  assert.equal(attentionNote.kind, "attention");
  assert.equal(attentionNote.text, "后台任务 ca-x 需要关注：15 分钟无进展。\n任务未因 PA 对话结束而停止，整体执行时限仍有效；你可以继续聊天或取消该任务。");
  pass("attention 事件：保持原有文案，不调用改写");

  const repeated = harness();
  repeated.notes.set("job:ca-x:terminal:terminal", { id: "job:ca-x:terminal:terminal", text: "已存在的短汇报", kind: "job", source: job.source });
  await repeated.handler(job, "terminal");
  assert.equal(repeated.chats[0].text, "已存在的短汇报", "已通知过的事件不重复改写");
  assert(!repeated.order.some((item) => item.startsWith("put:")), "已有通知不重复写");
  pass("幂等：同一事件已有通知时跳过改写，直接复用文本");

  const qq = harness();
  await qq.handler({ ...job, source: { channel: "qq", target: "private:12345" } }, "terminal");
  assert.equal(qq.notes.get("job:ca-x:terminal:terminal").text, "后台任务 ca-x 验收通过，明细见任务面板。");
  pass("QQ 分支：仍按 3000 字截断旧逻辑，短汇报原样入库");

  // ── 源码级约束：面板留明细、对话只留汇报、其它行为未改 ──
  const handlerSource = sliceDeclaration(source, "async function handleDelegationEvent(");
  assert.equal((source.match(/summarizeForUser\(/g) ?? []).length, 2, "summarizeForUser 只应有定义处与唯一调用处");
  assert.match(handlerSource, /text = event === "terminal" \? await summarizeForUser\(/);
  assert.match(handlerSource, /text: job\.source\.channel === "qq" \? text\.slice\(0, 3000\) : text/);
  assert.match(handlerSource, /const id = `job:\$\{job\.id\}:\$\{event\}:\$\{stamp\}\$\{event === "terminal" && job\.deliveryManaged \? `:delivery-\$\{job\.deliveryAttempt \?\? 0\}` : ""\}`;/);
  assert.match(source, /\.slice\(0, 6000\)/, "独立验收原文仍完整拼装（6000 字）并落盘");
  assert.match(source, /memory", "delegation-reviews"/);
  assert.match(source, /message: review\.text/, "任务面板仍返回完整验收原文");
  assert.match(source, /noTools: true, tools: \[\]/, "改写调用不开放 read/bash");
  assert.equal((source.match(/\brewriteReportWithModel\b/g) ?? []).length, 2, "改写只走 reviewRunner 这一处实现与一处引用");
  pass("源码约束：仅 terminal 改写、QQ 截断与通知 id 未变、面板/落盘仍保留完整原文");

  console.log(`\nPASS ${checks} report-summary checks；未启动服务、未调用模型、未写入 memory/`);
} catch (error) {
  console.error(`\nFAIL report-summary selftest（${checks} passed）`);
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
