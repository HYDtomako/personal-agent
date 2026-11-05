// 离线验证「后台任务终态 → 聊天五件事」：不启动服务、不调用模型、不派发任务、不写 memory/。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deliveryText } from "../src/delivery-pipeline.ts";
import {
  USER_NOTICE_MAX, cleanupHoldNotice, failureNotice, finalizeUserNotice, noticeReady, renderFiveNotice,
  unsettledNotice, userNoticeFromReview,
} from "../src/user-notice.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src", "main.ts"), "utf8");
let checks = 0;
const pass = (message) => { checks += 1; console.log(`ok ${checks} ${message}`); };

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

const forbidden = /[/\\]|`|\{|\}|\bnpx\b|\bnpm\b|\btsc\b|\bPID\b|worktree|node_modules|\.ts\b|\.js\b|Error:|at run|:[\\/]|--\w/;

function assertNotice(text, label) {
  assert.equal(noticeReady(text), true, `${label} 五字段不齐：${text}`);
  assert.ok([...text].length <= USER_NOTICE_MAX, `${label} 超长 ${[...text].length}：${text}`);
  assert.equal([...text].length, text.length, `${label} 按字符计数应与码点数一致`);
  assert.doesNotMatch(text, forbidden, `${label} 夹了不能进聊天的内容：${text}`);
  assert.equal(text.indexOf("原先"), 0);
  assert.ok(text.indexOf("现在") > 0 && text.indexOf("做了") > text.indexOf("现在"));
  assert.match(text, /过，|挂，|未核实，/);
  assert.match(text, /无需动手|要确认预览|要修/);
}

try {
  assert.equal(USER_NOTICE_MAX, 150);

  const passed = userNoticeFromReview({
    verdict: "passed",
    task: "把登录失败的提示改清楚",
    summary: "登录失败时会说明原因，刷新后仍保持登录",
  });
  assertNotice(passed, "验收通过");
  assert.match(passed, /^原先这件事还没完成。现在已经按目标做完。做了把登录失败的提示改清楚。过，登录失败时会说明原因，刷新后仍保持登录。无需动手。$/);
  pass(`例1 验收通过 ${[...passed].length} 字：${passed}`);

  const nasty = [
    "核对没过：npx tsc --noEmit 失败",
    "Error: boom",
    "    at run (D:\\pi-agent\\src\\main.ts:10:1)",
    "工作树 /memory/worktrees/ca-x",
  ].join("\n");
  const failed = userNoticeFromReview({
    verdict: "failed",
    task: "把登录失败的提示改清楚\n详见 src/main.ts",
    summary: nasty,
  });
  assertNotice(failed, "验收没过");
  assert.match(failed, /挂，核对没过。要修没通过的阻塞。$/);
  assert.doesNotMatch(failed, /src|main|pi-agent|tsc|boom/);
  const reviewFile = {
    verdict: "failed",
    summary: nasty,
    checks: ["npx tsc --noEmit", "D:\\pi-agent\\src\\main.ts"],
    detail: `后台任务 ca-x：验收未通过。\n${nasty}`.slice(0, 6000),
    rawReply: JSON.stringify({ verdict: "failed", summary: nasty, checks: ["npx tsc --noEmit"], failures: ["tsc"] }),
    text: failed,
  };
  assert.match(reviewFile.detail, /npx tsc/);
  assert.match(reviewFile.detail, /main\.ts/);
  assert.match(reviewFile.rawReply, /failures/);
  assert.equal(reviewFile.checks.length, 2);
  assert.doesNotMatch(reviewFile.text, forbidden);
  pass(`例2 验收没过（栈和路径只留在文件）${[...failed].length} 字：${failed}`);

  const delivered = deliveryText({
    id: "ca-1", state: "cleaned", mode: "git-worktree",
    targetReview: { verdict: "passed", summary: "原项目上的登录提示已经改清楚" },
    executionReview: { verdict: "passed", summary: "npx tsc --noEmit passed at /memory/worktrees/ca-1" },
    changes: [{ path: "src/login.ts", kind: "modify" }],
    worktreePath: "/memory/worktrees/ca-1",
    identity: { targetCwd: "D:\\pi-agent", kind: "git", targetBranch: "refs/heads/main" },
    alreadyPresent: false, targetUpdated: true, cleanupDone: true,
    error: "backup kept at D:\\pi-agent\\backup",
  });
  assertNotice(delivered, "交付完成");
  assert.match(delivered, /^原先改动只在副本里。现在原项目已经是改完的样子。做了核对通过后放回原项目。过，原项目上的登录提示已经改清楚。无需动手。$/);
  pass(`例3 交付完成 ${[...delivered].length} 字：${delivered}`);

  const rolled = deliveryText({
    id: "ca-2", state: "rolled_back", mode: "git-worktree",
    targetReview: { verdict: "failed", summary: "登录提示仍是旧的，用户看不出失败原因" },
    changes: [{ path: "src/login.ts" }],
    worktreePath: "D:\\pi-agent\\memory\\worktrees\\ca-2",
    alreadyPresent: false, targetUpdated: false,
    error: "rollback kept /memory/worktrees/ca-2",
  });
  assertNotice(rolled, "交付撤回");
  assert.match(rolled, /挂，/);
  assert.match(rolled, /要修没通过的阻塞/);
  pass(`例4 交付撤回 ${[...rolled].length} 字：${rolled}`);

  const flooded = renderFiveNotice({
    before: "原先".repeat(80),
    now: "现在".repeat(80),
    did: "处理".repeat(80),
    outcome: "未核实",
    reason: "原因".repeat(80) + " npx tsc /tmp/a.ts",
    action: "要确认预览",
  });
  assertNotice(flooded, "超长硬截");
  assert.doesNotMatch(flooded, /tsc|\/tmp/);
  pass("超长原文先丢掉命令和路径，再硬截到 150 且五字段还在");

  const poisoned = finalizeUserNotice("后台任务 ca-x：验收通过。\n- 已跑 npx tsc --noEmit\n- PID 4321 /memory/worktrees/ca-x\n{\"checks\":[\"a\"]}");
  assertNotice(poisoned, "脏原文兜底");
  assert.doesNotMatch(poisoned, /tsc|PID|worktree|checks/);
  pass("不能渲染成五件事的原文不会原样进聊天");

  assertNotice(failureNotice("timed_out", "plain"), "超时");
  assertNotice(failureNotice("failed", "direct"), "直接失败");
  assertNotice(failureNotice("cancelled", "delivery"), "取消");
  pass("失败、超时、取消也是五件事，不贴原始报错");

  const handlerJs = stripTypeScriptTypes(sliceDeclaration(source, "async function handleDelegationEvent("), { mode: "transform" });
  const buildHandler = (deps) => new Function(
    "broadcastJobs", "notifications", "store", "server", "deliveryPipeline", "delegations",
    "reviewDelegation", "unsettledNotice", "failureNotice", "cleanupHoldNotice", "finalizeUserNotice", "redactSensitive",
    `${handlerJs}\nreturn handleDelegationEvent;`,
  )(
    deps.broadcastJobs, deps.notifications, deps.store, deps.server, deps.deliveryPipeline, deps.delegations,
    deps.reviewDelegation, deps.unsettledNotice, deps.failureNotice, deps.cleanupHoldNotice, deps.finalizeUserNotice, deps.redactSensitive,
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
      deliveryPipeline: { run: async () => ({ text: delivered, delivered: true, holdProject: false }) },
      delegations: { setDeliveryHold: () => order.push("hold") },
      reviewDelegation: async () => ({ verdict: "passed", summary: "登录失败时会说明原因", text: passed }),
      unsettledNotice,
      failureNotice,
      cleanupHoldNotice,
      finalizeUserNotice,
      redactSensitive: (text) => text,
      ...over,
    };
    return { notes, chats, order, handler: buildHandler(deps) };
  }

  const job = {
    id: "ca-x", status: "completed", deliveryManaged: false, source: { channel: "telegram", chatId: "-100", threadId: 1 },
    message: "完成 npx tsc /memory/worktrees/ca-x", task: "task", lastOutput: "",
  };
  const completed = harness();
  await completed.handler(job, "terminal");
  const notification = completed.notes.get("job:ca-x:terminal:terminal");
  assert.equal(notification.text, passed);
  assert.equal(notification.kind, "job");
  assert.deepEqual(completed.chats.map((item) => item.text), [passed]);
  assert.equal(completed.order.filter((item) => item.startsWith("put:")).length, 1);
  assert(completed.order.findIndex((item) => item.startsWith("put:")) < completed.order.findIndex((item) => item.startsWith("append:")));
  assertNotice(notification.text, "聊天通知");
  pass("落库：对话文本就是五件事，不经过第二次改写");

  const deliveredRun = harness();
  await deliveredRun.handler({ ...job, deliveryManaged: true, deliveryAttempt: 2 }, "terminal");
  const deliveredNote = deliveredRun.notes.get("job:ca-x:terminal:terminal:delivery-2");
  assert.equal(deliveredNote.text, delivered);
  assert(deliveredRun.order.includes("hold"));
  pass("交付分支：去重 id 带 :delivery-N，聊天用交付五件事");

  const leaked = harness({
    deliveryPipeline: { run: async () => ({ text: "交付原文：diff --git a/x b/x 工作树 /memory/worktrees/ca-x", delivered: false, holdProject: true }) },
  });
  await leaked.handler({ ...job, deliveryManaged: true, deliveryAttempt: 0 }, "terminal");
  const leakedNote = leaked.notes.get("job:ca-x:terminal:terminal:delivery-0");
  assertNotice(leakedNote.text, "脏交付文案");
  assert.doesNotMatch(leakedNote.text, /diff|worktree|git/);
  pass("交付原文若夹路径，聊天仍回落到五件事");

  const failedRun = harness();
  await failedRun.handler({ ...job, status: "timed_out", message: "超过 60 分钟 npx tsc", cleanupError: "pane 未关闭 /memory/worktrees/ca-x" }, "terminal");
  const failedNote = failedRun.notes.get("job:ca-x:terminal:terminal");
  assertNotice(failedNote.text, "收尾未确认");
  assert.match(failedNote.text, /收尾尚未确认/);
  assert.doesNotMatch(failedNote.text, /tsc|pane|worktree|60/);
  pass("失败分支：收尾报错不进聊天，只留五件事");

  const attention = harness({ finalizeUserNotice: () => { throw new Error("attention 不允许改写"); } });
  await attention.handler({ ...job, attentionSequence: 7, message: "15 分钟无进展" }, "attention");
  const attentionNote = attention.notes.get("job:ca-x:attention:7");
  assert.equal(attentionNote.kind, "attention");
  assert.equal(attentionNote.text, "后台任务 ca-x 需要关注：15 分钟无进展。\n任务未因 PA 对话结束而停止，整体执行时限仍有效；你可以继续聊天或取消该任务。");
  pass("attention 事件：保持原有文案，不套五件事");

  const repeated = harness();
  repeated.notes.set("job:ca-x:terminal:terminal", { id: "job:ca-x:terminal:terminal", text: "已存在的短汇报", kind: "job", source: job.source });
  await repeated.handler(job, "terminal");
  assert.equal(repeated.chats[0].text, "已存在的短汇报");
  assert(!repeated.order.some((item) => item.startsWith("put:")));
  pass("幂等：同一事件已有通知时不重写");

  const qq = harness();
  await qq.handler({ ...job, source: { channel: "qq", target: "private:12345" } }, "terminal");
  assert.equal(qq.notes.get("job:ca-x:terminal:terminal").text, passed);
  pass("QQ 分支：仍按 3000 字截断入口，短通知原样入库");

  const handlerSource = sliceDeclaration(source, "async function handleDelegationEvent(");
  assert.doesNotMatch(source, /summarizeForUser|rewriteReportWithModel|userReportMaxChars/);
  assert.match(handlerSource, /finalizeUserNotice\(text\)/);
  assert.match(handlerSource, /text: job\.source\.channel === "qq" \? text\.slice\(0, 3000\) : text/);
  assert.match(handlerSource, /const id = `job:\$\{job\.id\}:\$\{event\}:\$\{stamp\}\$\{event === "terminal" && job\.deliveryManaged \? `:delivery-\$\{job\.deliveryAttempt \?\? 0\}` : ""\}`;/);
  assert.match(source, /\.slice\(0, 6000\)/);
  assert.match(source, /memory", "delegation-reviews"/);
  assert.match(source, /checks: checks\.map/);
  assert.match(source, /detail,/);
  assert.match(source, /rawReply:/);
  assert.match(source, /review\.detail/);
  assert.match(source, /tools: \["read", "bash"\]/);
  pass("源码约束：验收仍独立跑并落盘明细；聊天只渲染五字段");

  console.log(`\nPASS ${checks} report-summary checks；未启动服务、未调用模型、未写入 memory/`);
} catch (error) {
  console.error(`\nFAIL report-summary selftest（${checks} passed）`);
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
