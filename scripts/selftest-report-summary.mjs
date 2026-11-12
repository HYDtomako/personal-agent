// 离线验证终态通知：不启动服务、不调用模型、不派发任务、不写 memory/。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deliveryText } from "../src/delivery-pipeline.ts";
import { NOTICE_FALLBACK, RETELL_MAX, acceptUserCopy, attentionNotice, retellPrompt } from "../src/user-notice.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src", "main.ts"), "utf8");
const MARKER = "CA_REPORT_zz9";
const SNAP = "终端快照" + "甲乙丙丁戊己庚辛壬癸".repeat(4);
const PASSED = "登录以前失败了只会弹一句看不懂的话。现在失败时会把原因说清楚。这件事做完了，我核对过，是通过的。";
const FAILED = "这版没能用。登录提示还是旧的，我核对过，没通过。";
const OPEN = "登录提示那边有改动，但这块还没核过。";
let checks = 0;
const pass = (message) => { checks += 1; console.log(`ok ${checks} ${message}`); };

function sliceDeclaration(text, signature) {
  const start = text.indexOf(signature);
  assert(start >= 0, `main.ts 缺少 ${signature}`);
  let paren = 0;
  let angle = 0;
  let quote = null;
  let started = false;
  let open = -1;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(") { paren += 1; started = true; }
    else if (ch === ")") paren -= 1;
    else if (ch === "<" && paren === 0 && started) angle += 1;
    else if (ch === ">" && paren === 0 && angle > 0) angle -= 1;
    else if (ch === "{" && paren === 0 && angle === 0 && started) { open = i; break; }
  }
  assert(open > 0, `${signature} 缺少函数体`);
  let depth = 0;
  quote = null;
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

function copyFor(input) {
  if (input.acceptance?.verdict === "failed") return FAILED;
  if (input.acceptance?.verdict === "passed") return PASSED;
  return OPEN;
}

try {
  assert.equal(NOTICE_FALLBACK, "事情已经收尾，通知没写出来，细节在验收文件里。");
  assert.equal(acceptUserCopy("", [SNAP]), NOTICE_FALLBACK);
  assert.equal(acceptUserCopy(NOTICE_FALLBACK, [SNAP]), NOTICE_FALLBACK);
  assert.equal(acceptUserCopy(PASSED, [SNAP, `{"summary":"${MARKER}"}`]), PASSED);
  assert.equal(acceptUserCopy("原先这件事还没完成。现在已经按目标做完。做了登录提示。过，核对通过。无需动手。", []), NOTICE_FALLBACK);
  assert.equal(acceptUserCopy("做了项目，仓库无tsconfig、node_modules为。", []), NOTICE_FALLBACK);
  assert.equal(acceptUserCopy("做了项目：+ESM+，零运行时依赖，非。", []), NOTICE_FALLBACK);
  assert.equal(acceptUserCopy(`登录提示改好了。${MARKER}`, [`{"summary":"${MARKER}"}`]), NOTICE_FALLBACK);
  assert.equal(acceptUserCopy(SNAP, [SNAP]), NOTICE_FALLBACK);
  assert.equal(acceptUserCopy(`${OPEN}${SNAP.slice(0, 40)}`, [SNAP]), NOTICE_FALLBACK);
  const long = Array.from({ length: 6 }, () => `${"好".repeat(90)}。`).join("");
  const clipped = acceptUserCopy(long, []);
  assert.notEqual(clipped, NOTICE_FALLBACK);
  assert.ok([...clipped].length <= RETELL_MAX);
  assert.ok(clipped.endsWith("。"));
  assert.equal(acceptUserCopy("好".repeat(500), []), NOTICE_FALLBACK);
  pass("用户文案可以是一小段；原文、快照、填空句和半截词不会发出去");

  const report = { summary: `登录提示改清楚了 ${MARKER}`, changedFiles: ["src/login.ts"] };
  const prompt = retellPrompt({
    task: "把登录失败的提示改清楚",
    status: "completed",
    report,
    acceptance: { verdict: "passed", summary: "登录失败时会说明原因" },
  });
  assert.match(prompt, new RegExp(MARKER));
  assert.match(prompt, /CA 交付/);
  assert.match(prompt, /原先功能或状态/);
  assert.match(prompt, /有没有验证过/);
  assert.doesNotMatch(prompt, new RegExp(SNAP));
  assert.doesNotMatch(prompt, /终端快照（待核实）/);
  assert.equal(acceptUserCopy(PASSED, [JSON.stringify(report), SNAP]), PASSED);
  assert.doesNotMatch(PASSED, new RegExp(MARKER));
  pass("转述提示词带上 CA 交付；用户看到的那段不是报告原文");

  assert.equal(deliveryText({
    state: "cleaned", mode: "git-worktree",
    targetReview: { verdict: "passed", summary: `原项目 ${MARKER}` },
    executionReview: { verdict: "passed", summary: `${MARKER} npx tsc /memory/worktrees/ca-1` },
  }), "原项目已更新");
  assert.equal(deliveryText({ state: "rolled_back", targetReview: { verdict: "failed", summary: SNAP } }), "改动已撤回");
  assert.equal(deliveryText({ state: "blocked", executionReview: { verdict: "failed", summary: "bad" } }), "验收没通过");
  assert.equal(deliveryText({ state: "changes_ready" }), "这块还没核过");
  pass("任务列表状态不是聊天文案，也不带报告原文");

  assert.equal(attentionNotice("ca-x", "15 分钟无进展"), "后台任务 ca-x 需要关注：15 分钟无进展。\n任务未因 PA 对话结束而停止，整体执行时限仍有效；你可以继续聊天或取消该任务。");
  assert.doesNotMatch(attentionNotice("ca-x", `${MARKER} ${SNAP}`), new RegExp(`${MARKER}|终端快照`));
  assert.match(attentionNotice("ca-x", `${MARKER} {"summary":"done"}`), /连续一段时间未观察到进展/);
  pass("需要关注仍是短提示，不贴原始输出");

  const system = readFileSync(path.join(root, "workspace", ".pi", "SYSTEM.example.md"), "utf8");
  assert.match(system, /按 CA 的交付用白话转述/);
  assert.match(system, /原先什么样、改了什么、做完没有、验证过没有/);
  assert.match(system, /不要贴 CA 原报告或终端输出/);
  assert.match(system, /没有从验收文件或工具结果里读到的内容，不要说成事实/);
  assert.match(system, /不要只喊「我说错了」/);
  pass("系统提示词要求按交付白话转述，没读到不能当事实");

  const handlerJs = stripTypeScriptTypes(sliceDeclaration(source, "async function handleDelegationEvent("), { mode: "transform" });
  const retellJs = stripTypeScriptTypes(sliceDeclaration(source, "async function retellForUser("), { mode: "transform" });
  const buildHandler = (deps) => new Function(
    "broadcastJobs", "notifications", "store", "server", "deliveryPipeline", "delegations",
    "reviewDelegation", "retellForUser", "acceptUserCopy", "NOTICE_FALLBACK", "attentionNotice", "redactSensitive",
    `${handlerJs}\nreturn handleDelegationEvent;`,
  )(
    deps.broadcastJobs, deps.notifications, deps.store, deps.server, deps.deliveryPipeline, deps.delegations,
    deps.reviewDelegation, deps.retellForUser, deps.acceptUserCopy, deps.NOTICE_FALLBACK, deps.attentionNotice, deps.redactSensitive,
  );
  const buildRetell = (deps) => new Function(
    "reviewRunner", "currentModelSpec", "reviewTimeoutMs", "retellPrompt", "acceptUserCopy", "NOTICE_FALLBACK",
    `${retellJs}\nreturn retellForUser;`,
  )(deps.reviewRunner, deps.currentModelSpec, deps.reviewTimeoutMs, deps.retellPrompt, deps.acceptUserCopy, deps.NOTICE_FALLBACK);

  function harness(over = {}) {
    const order = [];
    const notes = new Map();
    const chats = [];
    const seen = [];
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
      deliveryPipeline: {
        run: async () => ({
          text: `交付原文 ${MARKER} ${SNAP}`,
          delivered: true,
          holdProject: false,
          record: { targetReview: { verdict: "passed", summary: "登录失败时会说明原因" }, executionReview: { verdict: "passed", summary: `${MARKER} npx tsc` } },
        }),
      },
      delegations: { setDeliveryHold: () => order.push("hold") },
      reviewDelegation: async () => {
        order.push("review");
        return { verdict: "passed", summary: "登录失败时会说明原因", text: `不要采用 ${MARKER}`, stage: undefined };
      },
      retellForUser: async (input) => {
        seen.push(input);
        order.push("retell");
        return copyFor(input);
      },
      acceptUserCopy,
      NOTICE_FALLBACK,
      attentionNotice,
      redactSensitive: (value) => value,
      ...over,
    };
    return { notes, chats, order, seen, handler: buildHandler(deps) };
  }

  const job = {
    id: "ca-x", status: "completed", deliveryManaged: false,
    source: { channel: "telegram", chatId: "-100", threadId: 1 },
    message: `完成 ${MARKER}`, task: "把登录失败的提示改清楚",
    lastOutput: SNAP, report: report,
  };

  const completed = harness();
  await completed.handler(job, "terminal");
  const notification = completed.notes.get("job:ca-x:terminal:terminal");
  assert.equal(notification.text, PASSED);
  assert.equal(notification.kind, "job");
  assert.deepEqual(completed.chats.map((item) => item.text), [PASSED]);
  assert.equal(completed.seen.length, 1);
  assert.equal(completed.seen[0].report, report);
  assert.match(retellPrompt(completed.seen[0]), new RegExp(MARKER));
  assert.doesNotMatch(retellPrompt(completed.seen[0]), /终端快照甲/);
  assert.doesNotMatch(notification.text, new RegExp(MARKER));
  assert.doesNotMatch(notification.text, /终端快照/);
  assert.equal(completed.order.filter((item) => item === "review").length, 1);
  assert(completed.order.findIndex((item) => item.startsWith("put:")) < completed.order.findIndex((item) => item.startsWith("append:")));
  pass("对话和通知是同一段转述，能看见交付，但不贴报告和快照");

  const deliveredRun = harness();
  await deliveredRun.handler({ ...job, deliveryManaged: true, deliveryAttempt: 2 }, "terminal");
  const deliveredNote = deliveredRun.notes.get("job:ca-x:terminal:terminal:delivery-2");
  assert.equal(deliveredNote.text, PASSED);
  assert.equal(deliveredRun.seen[0].acceptance.verdict, "passed");
  assert.equal(deliveredRun.seen[0].report, report);
  assert.doesNotMatch(deliveredNote.text, new RegExp(`${MARKER}|终端快照`));
  assert(deliveredRun.order.includes("hold"));
  assert(!deliveredRun.order.includes("review"));
  pass("交付分支去重 id 带 :delivery-N，转述用验收结论和 CA 交付");

  const leaked = harness({
    deliveryPipeline: { run: async () => ({ text: `交付原文 ${MARKER} ${SNAP}`, delivered: false, holdProject: true }) },
  });
  await leaked.handler({ ...job, deliveryManaged: true, deliveryAttempt: 0 }, "terminal");
  assert.equal(leaked.notes.get("job:ca-x:terminal:terminal:delivery-0").text, OPEN);
  assert.equal(leaked.seen[0].acceptance, undefined);
  assert.doesNotMatch(JSON.stringify(leaked.seen[0]), /终端快照甲/);
  assert.match(retellPrompt(leaked.seen[0]), new RegExp(MARKER));
  pass("交付管道上的原文不会变成聊天内容");

  const interrupted = harness({
    deliveryPipeline: { run: async () => ({
      text: `原先改动只在副本里 ${MARKER}`,
      delivered: false,
      holdProject: true,
      interrupted: true,
      interruptError: `${SNAP} ${MARKER}`,
      record: { targetReview: { verdict: "passed", summary: "登录失败时会说明原因" } },
    }) },
  });
  await interrupted.handler({ ...job, deliveryManaged: true, deliveryAttempt: 1 }, "terminal");
  assert.equal(interrupted.seen[0].acceptance.verdict, "unverified");
  assert.equal(interrupted.notes.get("job:ca-x:terminal:terminal:delivery-1").text, OPEN);
  assert.doesNotMatch(interrupted.notes.get("job:ca-x:terminal:terminal:delivery-1").text, /终端快照|原先这件事/);
  pass("交付中断时转述按没核过说，不把已通过记录说成落稳");

  const failedRun = harness();
  await failedRun.handler({
    ...job, status: "completed", cleanupError: `pane 未关闭 ${SNAP} ${MARKER}`,
  }, "terminal");
  assert.equal(failedRun.order.filter((item) => item === "review").length, 1);
  assert.equal(failedRun.seen[0].acceptance.verdict, "unverified");
  assert.equal(failedRun.notes.get("job:ca-x:terminal:terminal").text, OPEN);
  assert.doesNotMatch(failedRun.notes.get("job:ca-x:terminal:terminal").text, new RegExp(`${MARKER}|终端快照|pane`));
  pass("收尾未确认时仍先验收，聊天不贴报错");

  const timedOut = harness();
  await timedOut.handler({ ...job, status: "timed_out", message: MARKER, cleanupError: undefined }, "terminal");
  assert.equal(timedOut.order.filter((item) => item === "review").length, 0);
  assert.match(timedOut.seen[0].note, /没有做完独立验收/);
  assert.equal(timedOut.notes.get("job:ca-x:terminal:terminal").text, OPEN);
  assert.doesNotMatch(JSON.stringify(timedOut.seen[0]), /终端快照甲/);
  pass("超时把交付交给转述，并说明没有独立验收");

  const attention = harness({ retellForUser: async () => { throw new Error("attention 不转述"); } });
  await attention.handler({ ...job, attentionSequence: 7, message: "15 分钟无进展" }, "attention");
  assert.equal(attention.notes.get("job:ca-x:attention:7").text, "后台任务 ca-x 需要关注：15 分钟无进展。\n任务未因 PA 对话结束而停止，整体执行时限仍有效；你可以继续聊天或取消该任务。");
  pass("attention 不走转述");

  const dumped = harness();
  await dumped.handler({ ...job, attentionSequence: 8, message: `${MARKER} ${SNAP}` }, "attention");
  assert.doesNotMatch(dumped.notes.get("job:ca-x:attention:8").text, new RegExp(`${MARKER}|终端快照`));
  pass("attention 遇到原始输出时改回短提示");

  const repeated = harness({ retellForUser: async () => { throw new Error("不应重写"); } });
  repeated.notes.set("job:ca-x:terminal:terminal", { id: "job:ca-x:terminal:terminal", text: "已存在的转述", kind: "job", source: job.source });
  await repeated.handler(job, "terminal");
  assert.equal(repeated.chats[0].text, "已存在的转述");
  assert(!repeated.order.some((item) => item.startsWith("put:")));
  pass("同一事件已有通知时不重写");

  const qq = harness();
  await qq.handler({ ...job, source: { channel: "qq", target: "private:12345" } }, "terminal");
  assert.equal(qq.notes.get("job:ca-x:terminal:terminal").text, notification.text);
  assert.equal(qq.chats[0].text, notification.text);
  pass("QQ 与 Telegram 保存同一段");

  const fallbackRun = harness({ retellForUser: async () => { throw new Error(`model down ${MARKER}`); } });
  await fallbackRun.handler(job, "terminal");
  assert.equal(fallbackRun.notes.get("job:ca-x:terminal:terminal").text, NOTICE_FALLBACK);
  assert.equal(fallbackRun.chats[0].text, NOTICE_FALLBACK);
  assert.doesNotMatch(fallbackRun.notes.get("job:ca-x:terminal:terminal").text, new RegExp(MARKER));
  pass("转述调用抛错时聊天和通知都是固定短句");

  const echo = harness({ retellForUser: async () => JSON.stringify(report) + SNAP });
  await echo.handler(job, "terminal");
  assert.equal(echo.notes.get("job:ca-x:terminal:terminal").text, NOTICE_FALLBACK);
  pass("模型若回贴报告或快照，发送前换成固定短句");

  const calls = [];
  const retell = buildRetell({
    reviewRunner: { run: async (body, options) => { calls.push({ body, options }); return { ok: true, text: PASSED }; } },
    currentModelSpec: () => "test-model",
    reviewTimeoutMs: 180000,
    retellPrompt,
    acceptUserCopy,
    NOTICE_FALLBACK,
  });
  const input = { task: "把登录失败的提示改清楚", status: "completed", report, acceptance: { verdict: "passed", summary: "登录失败时会说明原因" } };
  assert.equal(await retell(input, [JSON.stringify(report), SNAP]), PASSED);
  assert.match(calls[0].body, new RegExp(MARKER));
  assert.doesNotMatch(calls[0].body, /终端快照甲/);
  assert.equal(calls[0].options.noTools, true);
  assert.equal(calls[0].options.model, "test-model");
  assert.equal(Object.keys(calls[0].options).sort().join(), "model,noTools,timeoutMs");
  const down = buildRetell({
    reviewRunner: { run: async () => { throw new Error(`down ${MARKER} ${SNAP}`); } },
    currentModelSpec: () => "test-model",
    reviewTimeoutMs: 180000,
    retellPrompt, acceptUserCopy, NOTICE_FALLBACK,
  });
  assert.equal(await down(input, [SNAP]), NOTICE_FALLBACK);
  const rejected = buildRetell({
    reviewRunner: { run: async () => ({ ok: false, text: `${MARKER} ${SNAP}` }) },
    currentModelSpec: () => "test-model",
    reviewTimeoutMs: 1000,
    retellPrompt, acceptUserCopy, NOTICE_FALLBACK,
  });
  assert.equal(await rejected(input, [SNAP]), NOTICE_FALLBACK);
  pass("模型调用提交的是交付转述；失败时不把原文退给用户");

  const handlerSource = sliceDeclaration(source, "async function handleDelegationEvent(");
  const retellSource = sliceDeclaration(source, "async function retellForUser(");
  const reviewSource = sliceDeclaration(source, "async function evaluateDelegation(");
  assert.match(handlerSource, /retellForUser\(\{ task: job\.task, status: job\.status, report: job\.report, acceptance, note \}, guard\)/);
  assert.match(handlerSource, /acceptUserCopy\(spoken, guard\)/);
  assert.match(handlerSource, /reviewDelegation\(job\)/);
  assert.match(handlerSource, /deliveryPipeline\.run\(job\)/);
  assert.match(handlerSource, /const guard = \[JSON\.stringify\(job\.report \?\? ""\), job\.lastOutput\];/);
  assert.match(handlerSource, /attentionNotice\(job\.id, job\.message\)/);
  assert.match(handlerSource, /text: job\.source\.channel === "qq" \? text\.slice\(0, 3000\) : text/);
  assert.doesNotMatch(handlerSource, /speakFromFacts|noticePrompt|factsFromReview|factsFromDelivery|outcome\.text|renderFiveNotice/);
  assert.match(retellSource, /retellPrompt\(input\)/);
  assert.match(retellSource, /noTools:\s*true/);
  assert.match(retellSource, /NOTICE_FALLBACK/);
  assert.doesNotMatch(retellSource, /lastOutput|终端快照|speakFromFacts|noticePrompt/);
  assert.match(reviewSource, /CA 报告（待核实）/);
  assert.match(reviewSource, /终端快照（待核实）/);
  assert.match(reviewSource, /tools: \["read", "bash"\]/);
  assert.match(reviewSource, /checks: checks\.map/);
  assert.match(reviewSource, /rawReply:/);
  assert.match(source, /\.slice\(0, 6000\)/);
  assert.match(source, /memory", "delegation-reviews"/);
  assert.doesNotMatch(reviewSource, /retellPrompt|retellForUser/);
  assert.doesNotMatch(source, /speakFromFacts|noticePrompt|factsFromReview/);
  const telegram = readFileSync(path.join(root, "app", "telegram-client.mjs"), "utf8");
  assert.match(telegram, /splitTelegramText\(notification\.text\)/);
  assert.match(source, /text: notification\.text/);
  pass("验收仍独立运行并落盘；转述看交付不看终端快照；QQ 与 Telegram 转发同一条通知");

  console.log(`\nPASS ${checks} report-summary checks；未启动服务、未调用模型、未写入 memory/`);
} catch (error) {
  console.error(`\nFAIL report-summary selftest（${checks} passed）`);
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
