// 离线验证终态通知：不启动服务、不调用模型、不派发任务、不写 memory/。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deliveryText } from "../src/delivery-pipeline.ts";
import { RETELL_MAX, acceptUserCopy, attentionNotice, noticeSendDecision, retellFallbackRecord, retellPrompt, telegramPrivateChatId, userCopyRejectDetail } from "../src/user-notice.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src", "main.ts"), "utf8");
const MARKER = "CA_REPORT_zz9";
const SNAP = "终端快照" + "甲乙丙丁戊己庚辛壬癸".repeat(4);
const PASSED = "登录以前失败了只会弹一句看不懂的话。现在失败时会把原因说清楚。这件事做完了，我核对过，是通过的。";
const OPEN = "登录提示那边有改动，但这块还没核过。";
const PLACEHOLDER = "事情已经收尾，通知没写出来，细节在验收文件里。";
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

try {
  assert.equal(acceptUserCopy("", [SNAP]), "");
  assert.equal(acceptUserCopy(PLACEHOLDER, [SNAP]), "");
  assert.equal(userCopyRejectDetail(PLACEHOLDER, []), "placeholder");
  assert.equal(acceptUserCopy(`前面还有一句。${PLACEHOLDER}`, []), "");
  assert.equal(acceptUserCopy(PASSED, [SNAP, `{"summary":"${MARKER}"}`]), PASSED);
  assert.equal(acceptUserCopy("原先这件事还没完成。现在已经按目标做完。做了登录提示。过，核对通过。无需动手。", []), "");
  assert.equal(userCopyRejectDetail("原先这件事还没完成。现在已经按目标做完。做了登录提示。过，核对通过。无需动手。", []), "template");
  assert.equal(acceptUserCopy("做了项目，仓库无tsconfig、node_modules为。", []), "");
  assert.equal(userCopyRejectDetail("做了项目，仓库无tsconfig、node_modules为。", []), "toolchain");
  const OLD_LATIN = /[A-Za-z][A-Za-z0-9_.:/+-]{2,}/;
  const withNames = "登录失败时会说明原因。Cursor 上的 PR16 已经合进去了，我核对过，是通过的。";
  assert.match(withNames, OLD_LATIN);
  assert.equal(userCopyRejectDetail(withNames, []), null);
  assert.equal(acceptUserCopy(withNames, []), withNames);
  const withPath = "改动在 src/login.ts，登录失败时会说明原因。我核对过，是通过的。";
  assert.match(withPath, /[/\\]/);
  assert.match(withPath, OLD_LATIN);
  assert.equal(acceptUserCopy(withPath, []), withPath);
  const withBackslash = "改动在 D:\\work\\login.ts，登录失败时会说明原因。我核对过，是通过的。";
  assert.match(withBackslash, /[/\\]/);
  assert.equal(acceptUserCopy(withBackslash, []), withBackslash);
  const withAcronym = "做了项目：+ESM+，零运行时依赖，非。";
  assert.match(withAcronym, OLD_LATIN);
  assert.equal(acceptUserCopy(withAcronym, []), withAcronym);
  assert.equal(acceptUserCopy("Cursor PR16 is merged.", []), "");
  assert.equal(userCopyRejectDetail("Cursor PR16 is merged.", []), "no-han");
  assert.equal(userCopyRejectDetail("   ", []), "empty");
  assert.equal(userCopyRejectDetail("说明写在 https://example.com/login 。我核对过。", []), "url");
  assert.equal(acceptUserCopy("说明写在 https://example.com/login 。我核对过。", []), "");
  const withMarker = `登录提示改好了。${MARKER}`;
  assert.match(withMarker, OLD_LATIN);
  assert.equal(acceptUserCopy(withMarker, [`{"summary":"${MARKER}"}`]), withMarker);
  assert.equal(acceptUserCopy(SNAP, [SNAP]), "");
  assert.equal(userCopyRejectDetail(SNAP, [SNAP]), "pasted");
  assert.equal(acceptUserCopy(`${OPEN}${SNAP.slice(0, 40)}`, [SNAP]), "");
  const long = Array.from({ length: 6 }, () => `${"好".repeat(90)}。`).join("");
  const clipped = acceptUserCopy(long, []);
  assert.notEqual(clipped, "");
  assert.ok([...clipped].length <= RETELL_MAX);
  assert.ok(clipped.endsWith("。"));
  assert.equal(acceptUserCopy("好".repeat(500), []), "");
  assert.equal(userCopyRejectDetail("好".repeat(500), []), "no-sentence");
  const longDraft = `登录提示改好了。${"甲".repeat(500)}`;
  const record = retellFallbackRecord({ reason: "filter-rejection", detail: "pasted\nraw", draft: longDraft, jobId: "ca-1" });
  assert.match(record, /^\[notify\] 转述未采用 reason=filter-rejection job=ca-1 detail=pasted raw draft=/);
  assert.match(record, /共\d+字/);
  assert.equal(record.includes("\n"), false);
  assert.match(retellFallbackRecord({ reason: "exception", detail: "", draft: "" }), /reason=exception detail=\(无\) draft=\(空\)/);
  assert.match(retellFallbackRecord({ reason: "call-failure", detail: "timeout", draft: withNames, jobId: "ca-x" }), /reason=call-failure job=ca-x detail=timeout draft=登录失败时会说明原因/);
  pass("合格中文会留下，夹英文词也可以；空话、占位句、原文和快照不发给用户");

  const report = { summary: `登录提示改清楚了 ${MARKER}`, changedFiles: ["src/login.ts"] };
  const prompt = retellPrompt({
    task: "把登录失败的提示改清楚",
    status: "completed",
    report,
    acceptance: { verdict: "passed", summary: "登录失败时会说明原因" },
  });
  assert.match(prompt, new RegExp(MARKER));
  assert.match(prompt, /CA 交付/);
  assert.match(prompt, /原先是什么样/);
  assert.match(prompt, /这次改了什么/);
  assert.match(prompt, /做完没有/);
  assert.match(prompt, /哪些验证过/);
  assert.match(prompt, /哪些没验证成/);
  assert.match(prompt, /还要不要他动手/);
  assert.match(prompt, /telegram_send/);
  assert.match(prompt, /主服务不会替你入队/);
  assert.doesNotMatch(prompt, /戳一戳|0\.4|娱乐模式/);
  assert.doesNotMatch(prompt, new RegExp(SNAP));
  assert.doesNotMatch(prompt, /终端快照（待核实）/);
  const spoken = "登录失败以前只会弹一句看不懂的话。这次改成会说明是超时还是账号不对，Cursor 上这件事做完了。我核对过失败提示的两条路径，都通过了；页面上旧按钮没另写脚本，所以那部分还没核。你刷新一下就能看到，不用重启。";
  assert.equal(noticeSendDecision(spoken).send, true);
  assert.equal(noticeSendDecision(spoken).text, spoken);
  assert.match(spoken, /Cursor/);
  assert.doesNotMatch(spoken, /戳一戳/);
  assert.equal(noticeSendDecision(PLACEHOLDER).send, false);
  assert.equal(noticeSendDecision("Cursor PR16 is merged.").detail, "no-han");
  assert.equal(telegramPrivateChatId(["100000002"], { channel: "telegram", chatId: "-100" }), "100000002");
  assert.equal(telegramPrivateChatId(["100000002"], { channel: "telegram", chatId: "100000002" }), "100000002");
  assert.equal(telegramPrivateChatId([], { channel: "telegram", chatId: "100000002" }), "");
  assert.equal(acceptUserCopy(PASSED, [JSON.stringify(report), SNAP]), PASSED);
  assert.doesNotMatch(PASSED, new RegExp(MARKER));
  pass("提示词要求按这次任务写完整白话并用 telegram_send 发送；示例任务不会被照抄");

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
  assert.match(system, /telegram_send 发到用户的 Telegram 私聊/);
  assert.match(system, /原先什么样、这次改了什么、做完没有、哪些验证过、哪些没验证成、还要不要用户动手/);
  assert.match(system, /主服务不会替你入队或转发/);
  assert.match(system, /不要贴 CA 原报告或终端输出/);
  assert.doesNotMatch(system, /戳一戳/);
  assert.match(system, /没有从验收文件或工具结果里读到的内容，不要说成事实/);
  assert.match(system, /不要只喊「我说错了」/);
  pass("系统提示词要求模型自己把终态通知发到 Telegram 私聊，没读到不能当事实");

  const handlerJs = stripTypeScriptTypes(sliceDeclaration(source, "async function handleDelegationEvent("), { mode: "transform" });
  const retellJs = stripTypeScriptTypes(sliceDeclaration(source, "async function retellForUser("), { mode: "transform" });
  const buildHandler = (deps) => new Function(
    "broadcastJobs", "notifications", "store", "server", "deliveryPipeline", "delegations",
    "reviewDelegation", "retellForUser", "attentionNotice", "redactSensitive",
    "log", "retellFallbackRecord", "telegramPrivateChatId", "telegramAllowFrom",
    `${handlerJs}\nreturn handleDelegationEvent;`,
  )(
    deps.broadcastJobs, deps.notifications, deps.store, deps.server, deps.deliveryPipeline, deps.delegations,
    deps.reviewDelegation, deps.retellForUser, deps.attentionNotice, deps.redactSensitive,
    deps.log, deps.retellFallbackRecord, deps.telegramPrivateChatId, deps.telegramAllowFrom,
  );
  const buildRetell = (deps) => new Function(
    "runner", "currentModelSpec", "reviewTimeoutMs", "userId", "retellPrompt",
    "log", "retellFallbackRecord", "userCopyRejectDetail",
    `${retellJs}\nreturn retellForUser;`,
  )(
    deps.runner, deps.currentModelSpec, deps.reviewTimeoutMs, deps.userId, deps.retellPrompt,
    deps.log, deps.retellFallbackRecord, deps.userCopyRejectDetail,
  );

  function harness(over = {}) {
    const order = [];
    const notes = new Map();
    const chats = [];
    const seen = [];
    const logs = [];
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
      },
      attentionNotice,
      redactSensitive: (value) => value,
      log: (message) => logs.push(String(message)),
      retellFallbackRecord,
      telegramPrivateChatId,
      telegramAllowFrom: ["100000002"],
      ...over,
    };
    return { notes, chats, order, seen, logs, handler: buildHandler(deps) };
  }

  const job = {
    id: "ca-x", status: "completed", deliveryManaged: false,
    source: { channel: "telegram", chatId: "-100", threadId: 1 },
    message: `完成 ${MARKER}`, task: "把登录失败的提示改清楚",
    lastOutput: SNAP, report: report,
  };

  function unsent(run, id = "job:ca-x:terminal:terminal") {
    assert.equal(run.notes.get(id), undefined);
    assert.deepEqual(run.chats, []);
    assert.ok(!run.order.some((item) => item.startsWith("put:") || item.startsWith("append:")));
    assert.doesNotMatch(JSON.stringify(run.chats), /事情已经收尾|通知没写出来|没做完/);
  }

  const completed = harness();
  await completed.handler(job, "terminal");
  unsent(completed);
  assert.equal(completed.seen.length, 1);
  assert.equal(completed.seen[0].report, report);
  assert.equal(completed.seen[0].chatId, "100000002");
  assert.notEqual(completed.seen[0].chatId, "-100");
  assert.match(retellPrompt(completed.seen[0]), new RegExp(MARKER));
  assert.match(retellPrompt(completed.seen[0]), /telegram_send/);
  assert.doesNotMatch(retellPrompt(completed.seen[0]), /终端快照甲|戳一戳/);
  assert.equal(completed.order.filter((item) => item === "review").length, 1);
  assert.deepEqual(completed.logs, []);
  pass("终态只把交付交给模型去发 Telegram 私聊，主程序不入队");

  const deliveredRun = harness();
  await deliveredRun.handler({ ...job, deliveryManaged: true, deliveryAttempt: 2 }, "terminal");
  unsent(deliveredRun, "job:ca-x:terminal:terminal:delivery-2");
  assert.equal(deliveredRun.seen[0].acceptance.verdict, "passed");
  assert.equal(deliveredRun.seen[0].chatId, "100000002");
  assert.equal(deliveredRun.seen[0].report, report);
  assert(deliveredRun.order.includes("hold"));
  assert(!deliveredRun.order.includes("review"));
  pass("交付分支仍把验收结论交给模型，主程序不代发");

  const leaked = harness({
    deliveryPipeline: { run: async () => ({ text: `交付原文 ${MARKER} ${SNAP}`, delivered: false, holdProject: true }) },
  });
  await leaked.handler({ ...job, deliveryManaged: true, deliveryAttempt: 0 }, "terminal");
  unsent(leaked, "job:ca-x:terminal:terminal:delivery-0");
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
  unsent(interrupted, "job:ca-x:terminal:terminal:delivery-1");
  assert.match(interrupted.seen[0].note, /收尾还没确认/);
  pass("交付中断时按没核过交给模型，主程序不把中断说成已经落稳");

  const failedRun = harness();
  await failedRun.handler({
    ...job, status: "completed", cleanupError: `pane 未关闭 ${SNAP} ${MARKER}`,
  }, "terminal");
  assert.equal(failedRun.order.filter((item) => item === "review").length, 1);
  assert.equal(failedRun.seen[0].acceptance.verdict, "unverified");
  unsent(failedRun);
  assert.doesNotMatch(JSON.stringify(failedRun.chats), new RegExp(`${MARKER}|终端快照|pane`));
  pass("收尾未确认时仍先验收，主程序不把报错发给用户");

  const timedOut = harness();
  await timedOut.handler({ ...job, status: "timed_out", message: MARKER, cleanupError: undefined }, "terminal");
  assert.equal(timedOut.order.filter((item) => item === "review").length, 0);
  assert.match(timedOut.seen[0].note, /没有做完独立验收/);
  unsent(timedOut);
  assert.doesNotMatch(JSON.stringify(timedOut.seen[0]), /终端快照甲/);
  pass("超时把交付交给模型，并说明没有独立验收，主程序不代发");

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
  unsent(qq);
  assert.equal(qq.seen[0].chatId, "100000002");
  pass("QQ 来源的终态也只准备发到 Telegram 私聊，主程序不代发");

  const fallbackRun = harness({ retellForUser: async () => { throw new Error(`model down ${MARKER}`); } });
  await fallbackRun.handler(job, "terminal");
  unsent(fallbackRun);
  assert.match(fallbackRun.logs.join("\n"), new RegExp(`reason=exception job=ca-x detail=model down ${MARKER}`));
  assert.match(fallbackRun.logs.join("\n"), /draft=\(空\)/);
  assert.doesNotMatch(fallbackRun.logs.join("\n"), /事情已经收尾|通知没写出来|没做完/);
  pass("转述调用抛错时不给用户发占位句，日志记下异常");

  const calls = [];
  const retellLogs = [];
  function retellWith(run, logs, timeoutMs = 180000) {
    return buildRetell({
      runner: { run },
      currentModelSpec: () => "test-model",
      reviewTimeoutMs: timeoutMs,
      userId: "me",
      retellPrompt,
      log: (line) => logs.push(String(line)),
      retellFallbackRecord,
      userCopyRejectDetail,
    });
  }
  function toolRound(text, endDetail, result) {
    return async (body, options) => {
      calls.push({ body, options });
      options.onEvent?.({ kind: "tool_start", id: "1", name: "telegram_send", detail: text });
      options.onEvent?.({ kind: "tool_end", id: "1", name: "telegram_send", isError: false, detail: endDetail });
      return result;
    };
  }
  const input = { task: "把登录失败的提示改清楚", status: "completed", report, acceptance: { verdict: "passed", summary: "登录失败时会说明原因" }, jobId: "ca-x", chatId: "100000002" };
  const retell = retellWith(toolRound(withNames, "已发到 Telegram 私聊", { ok: true, text: "已发" }), retellLogs);
  assert.equal(await retell(input, [JSON.stringify(report), SNAP]), undefined);
  assert.deepEqual(retellLogs, []);
  assert.match(calls[0].body, new RegExp(MARKER));
  assert.match(calls[0].body, /telegram_send/);
  assert.match(calls[0].body, /原先是什么样/);
  assert.doesNotMatch(calls[0].body, /终端快照甲|戳一戳/);
  assert.equal(calls[0].options.noTools, undefined);
  assert.equal(calls[0].options.tools, undefined);
  assert.equal(calls[0].options.model, "test-model");
  assert.equal(calls[0].options.userId, "me");
  assert.equal(calls[0].options.env.PI_TELEGRAM_CHAT_ID, "100000002");
  assert.equal(calls[0].options.env.PI_REVIEW_JOB_ID, "ca-x");
  const missingChatLogs = [];
  const missingChat = retellWith(async () => { throw new Error("不应调用模型"); }, missingChatLogs);
  await missingChat({ ...input, chatId: "" }, []);
  assert.match(missingChatLogs.join("\n"), /reason=call-failure job=ca-x detail=no-private-chat/);
  const downLogs = [];
  const down = retellWith(async () => { throw new Error(`down ${MARKER} ${SNAP}`); }, downLogs);
  await down(input, [SNAP]);
  assert.match(downLogs.join("\n"), /reason=exception job=ca-x/);
  assert.match(downLogs.join("\n"), new RegExp(`detail=down ${MARKER}`));
  const rejectedLogs = [];
  const rejected = retellWith(async () => ({ ok: false, text: `${MARKER} ${SNAP}`, error: `unavailable ${MARKER}` }), rejectedLogs, 1000);
  await rejected(input, [SNAP]);
  assert.match(rejectedLogs.join("\n"), /reason=call-failure job=ca-x/);
  assert.match(rejectedLogs.join("\n"), new RegExp(`detail=unavailable ${MARKER}`));
  assert.match(rejectedLogs.join("\n"), new RegExp(`draft=${MARKER}`));
  const filteredLogs = [];
  const filtered = retellWith(toolRound("Cursor PR16 is merged.", "未发送 detail=no-han", { ok: true, text: "" }), filteredLogs);
  await filtered(input, []);
  assert.match(filteredLogs.join("\n"), /reason=filter-rejection job=ca-x detail=no-han draft=Cursor PR16 is merged\./);
  const failedQualifiedLogs = [];
  const failedQualified = retellWith(toolRound(withPath, "未发送 detail=send-failed", { ok: true, text: "" }), failedQualifiedLogs);
  await failedQualified(input, []);
  assert.match(failedQualifiedLogs.join("\n"), /reason=call-failure job=ca-x detail=send-failed/);
  assert.match(failedQualifiedLogs.join("\n"), /draft=改动在 src\/login\.ts/);
  assert.doesNotMatch([downLogs, rejectedLogs, filteredLogs, failedQualifiedLogs].flat().join("\n"), /没做完|事情已经收尾|通知没写出来/);
  const placeholderLogs = [];
  const placeholderRetell = retellWith(toolRound(PLACEHOLDER, "未发送 detail=placeholder", { ok: true, text: "" }), placeholderLogs);
  await placeholderRetell(input, []);
  assert.match(placeholderLogs.join("\n"), /reason=filter-rejection job=ca-x detail=placeholder draft=事情已经收尾/);
  pass("模型自己发送；失败时用户收不到占位句，并按调用失败、过滤或异常记下草稿");

  const composedLogs = [];
  const composed = harness({
    retellForUser: retellWith(toolRound("Cursor only", "未发送 detail=no-han", { ok: true, text: "Cursor only" }), composedLogs),
  });
  await composed.handler(job, "terminal");
  unsent(composed);
  assert.equal(composedLogs.length, 1);
  assert.match(composedLogs[0], /reason=filter-rejection job=ca-x detail=no-han draft=Cursor only/);
  assert.deepEqual(composed.logs, []);
  const composedOkLogs = [];
  const composedOk = harness({
    retellForUser: retellWith(toolRound(withNames, "已发到 Telegram 私聊", { ok: true, text: "已发" }), composedOkLogs),
  });
  await composedOk.handler(job, "terminal");
  unsent(composedOk);
  assert.deepEqual(composedOkLogs, []);
  assert.deepEqual(composedOk.logs, []);
  const composedDownLogs = [];
  const composedDown = harness({
    retellForUser: retellWith(async () => { throw new Error(`boom ${MARKER}`); }, composedDownLogs),
  });
  await composedDown.handler(job, "terminal");
  unsent(composedDown);
  assert.equal(composedDownLogs.length, 1);
  assert.match(composedDownLogs[0], new RegExp(`reason=exception job=ca-x detail=boom ${MARKER}`));
  assert.deepEqual(composedDown.logs, []);
  pass("模型发出合格中文后主程序不再转发；失败只记在转述日志里");

  const handlerSource = sliceDeclaration(source, "async function handleDelegationEvent(");
  const retellSource = sliceDeclaration(source, "async function retellForUser(");
  const reviewSource = sliceDeclaration(source, "async function evaluateDelegation(");
  assert.match(handlerSource, /chatId: telegramPrivateChatId\(telegramAllowFrom, job\.source\)/);
  assert.match(handlerSource, /终态通知由模型用 telegram_send 自己发，主程序不入队/);
  assert.match(handlerSource, /reason: "exception"/);
  assert.doesNotMatch(handlerSource, /reason: "filter-rejection"|acceptUserCopy\(spoken/);
  assert.match(retellSource, /reason: "call-failure"/);
  assert.match(retellSource, /reason: "filter-rejection"/);
  assert.match(retellSource, /reason: "exception"/);
  assert.match(retellSource, /retellFallbackRecord/);
  assert.match(retellSource, /runner\.run\(/);
  assert.match(retellSource, /PI_TELEGRAM_CHAT_ID/);
  assert.match(retellSource, /name === "telegram_send"/);
  assert.doesNotMatch(retellSource, /noTools|reviewRunner|notifications\.put/);
  assert.match(handlerSource, /reviewDelegation\(job\)/);
  assert.match(handlerSource, /deliveryPipeline\.run\(job\)/);
  assert.match(handlerSource, /const guard = \[JSON\.stringify\(job\.report \?\? ""\), job\.lastOutput\];/);
  assert.match(handlerSource, /attentionNotice\(job\.id, job\.message\)/);
  assert.match(handlerSource, /text: job\.source\.channel === "qq" \? text\.slice\(0, 3000\) : text/);
  assert.doesNotMatch(handlerSource, /speakFromFacts|noticePrompt|factsFromReview|factsFromDelivery|outcome\.text|renderFiveNotice/);
  assert.match(retellSource, /retellPrompt\(input\)/);
  assert.doesNotMatch(retellSource, /NOTICE_FALLBACK|事情已经收尾|通知没写出来/);
  assert.doesNotMatch(handlerSource, /NOTICE_FALLBACK|事情已经收尾|通知没写出来/);
  assert.doesNotMatch(source, /事情已经收尾，通知没写出来/);
  assert.doesNotMatch(retellSource, /lastOutput|终端快照|speakFromFacts|noticePrompt/);
  const extension = readFileSync(path.join(root, "workspace", ".pi", "extensions", "telegram-send.ts"), "utf8");
  assert.match(extension, /noticeSendDecision/);
  assert.match(extension, /PI_TELEGRAM_CHAT_ID/);
  assert.match(extension, /已发到 Telegram 私聊/);
  assert.match(extension, /sendMessage/);
  assert.doesNotMatch(extension, /notifications\.put/);
  assert.match(extension, /不要用「没做完」搪塞/);
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
  pass("验收仍独立运行并落盘；终态由模型发到 Telegram 私聊，主程序不代发");

  console.log(`\nPASS ${checks} report-summary checks；未启动服务、未调用模型、未写入 memory/`);
} catch (error) {
  console.error(`\nFAIL report-summary selftest（${checks} passed）`);
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
