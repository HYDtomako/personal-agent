// 离线验证终态通知：不启动服务、不调用模型、不派发任务、不写 memory/。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deliveryText } from "../src/delivery-pipeline.ts";
import {
  NOTICE_FALLBACK, SENTENCE_MAX, attentionNotice, cleanupHoldFacts, exceptionFacts, factsFromDelivery,
  factsFromReview, failureFacts, finalizeUserNotice, noticePrompt, unsettledFacts,
} from "../src/user-notice.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src", "main.ts"), "utf8");
const MARKER = "CA_REPORT_zz9";
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

function factLines(prompt) {
  return prompt.split("\n").filter((line) => /^(结论|改动|没核过|要用户动手)：/.test(line));
}

function assertSpoken(text, facts, label) {
  assert.equal(finalizeUserNotice(text, facts), text, `${label} 不是可发送的一句：${text}`);
  assert.ok([...text].length <= SENTENCE_MAX, `${label} 超长`);
  assert.equal(text.split(/(?<=[。！？])/u).filter(Boolean).length, 1, `${label} 不是一句`);
  assert.doesNotMatch(text, /原先|未核实|无需动手|要确认预览|node_modules|tsconfig|[/\\]|\{/);
  if (facts.verdict === "unverified" || facts.unchecked) assert.match(text, /没核/);
  if (facts.verdict !== "unverified" && !facts.unchecked) assert.doesNotMatch(text, /没核/);
}

try {
  assert.equal(NOTICE_FALLBACK, "事情已经收尾，通知没写出来，细节在验收文件里。");
  assert.equal(finalizeUserNotice("", factsFromReview({ verdict: "passed" })), NOTICE_FALLBACK);
  assert.equal(finalizeUserNotice(NOTICE_FALLBACK, unsettledFacts()), NOTICE_FALLBACK);
  pass("模型失败时的固定短句");

  const passedFacts = factsFromReview({ verdict: "passed", summary: "登录失败时会说明原因，刷新后仍保持登录" });
  const passedPrompt = noticePrompt(passedFacts);
  assert.deepEqual(factLines(passedPrompt), [
    "结论：通过",
    "改动：登录失败时会说明原因，刷新后仍保持登录",
    "没核过：没有",
    "要用户动手：不用",
  ]);
  assert.doesNotMatch(factLines(passedPrompt).join("\n"), /报告|终端|快照|清单|checks/);
  const passedSentence = finalizeUserNotice("登录提示改好了。", passedFacts);
  assertSpoken(passedSentence, passedFacts, "验收通过");
  pass(`验收通过的事实进提示词，句子是：${passedSentence}`);

  const echoed = factsFromReview({
    verdict: "passed",
    summary: `登录提示改好了 ${MARKER} npx tsc /tmp/a.ts {"ok":true}`,
    report: MARKER,
    lastOutput: `终端快照 ${MARKER}`,
  });
  assert.equal(echoed.changed, "登录提示改好了");
  assert.doesNotMatch(noticePrompt(echoed), new RegExp(MARKER));
  assert.doesNotMatch(noticePrompt(echoed), /tsc|\/tmp|ok/);
  pass("验收摘要里的英文报告记号和路径不会进模型输入");

  const englishOnly = factsFromReview({ verdict: "passed", summary: `${MARKER} npx tsc --noEmit /memory/worktrees/ca-x` });
  assert.equal(englishOnly.changed, "已经按验收改好了");
  assert.doesNotMatch(noticePrompt(englishOnly), new RegExp(MARKER));
  pass("纯英文原始输出不会被当成改动事实");

  const nasty = ["核对没过：npx tsc --noEmit 失败", "Error: boom", "    at run (D:\\pi-agent\\src\\main.ts:10:1)", "工作树 /memory/worktrees/ca-x"].join("\n");
  const failedFacts = factsFromReview({ verdict: "failed", summary: nasty, task: "详见 src/main.ts" });
  assert.equal(failedFacts.changed, "核对没过");
  assert.equal(failedFacts.needsUser, true);
  assert.doesNotMatch(noticePrompt(failedFacts), /tsc|boom|main|worktree|src/);
  const failedSentence = finalizeUserNotice("这版没通过。", failedFacts);
  assertSpoken(failedSentence, failedFacts, "验收没过");
  const reviewFile = {
    verdict: "failed",
    summary: nasty,
    checks: ["npx tsc --noEmit", "D:\\pi-agent\\src\\main.ts"],
    detail: `后台任务 ca-x：验收未通过。\n${nasty}`.slice(0, 6000),
    rawReply: JSON.stringify({ verdict: "failed", summary: nasty, checks: ["npx tsc --noEmit"], failures: ["tsc"] }),
  };
  assert.match(reviewFile.detail, /npx tsc/);
  assert.match(reviewFile.rawReply, /failures/);
  assert.equal(reviewFile.checks.length, 2);
  assert.doesNotMatch(noticePrompt(failedFacts), /npx tsc|failures/);
  pass("栈、路径和检查清单留在验收记录，不进通知提示词");

  const unverified = factsFromReview({ verdict: "unverified", summary: `${"没跑完的检查".repeat(20)}` });
  assert.equal(unverified.unchecked, "这块还没核过");
  assert.equal(unverified.verdict, "unverified");
  assert.ok([...unverified.changed].length <= 40);
  assert.match(noticePrompt(unverified), /没核过：这块还没核过/);
  assert.doesNotMatch(factLines(noticePrompt(unverified)).join("\n"), /没跑完的检查{8}/);
  assert.equal(finalizeUserNotice("已经改好了。", unverified), NOTICE_FALLBACK);
  assert.equal(finalizeUserNotice("已经改好了。这块还没核过。", unverified), NOTICE_FALLBACK);
  const gapSentence = finalizeUserNotice("这块还没核过。", unverified);
  assertSpoken(gapSentence, unverified, "未核实");
  pass("没核过时不能先说做完了再改口");

  assert.equal(finalizeUserNotice("做了项目，仓库无tsconfig、node_modules为。", passedFacts), NOTICE_FALLBACK);
  assert.equal(finalizeUserNotice("做了项目：+ESM+，零运行时依赖，非。", passedFacts), NOTICE_FALLBACK);
  assert.equal(finalizeUserNotice("原先这件事还没完成。现在已经按目标做完。做了登录提示。过，核对通过。无需动手。", passedFacts), NOTICE_FALLBACK);
  pass("填空句和半截技术词不能直接发");

  const deliveredRecord = {
    id: "ca-1", state: "cleaned", mode: "git-worktree",
    targetReview: { verdict: "passed", summary: "原项目上的登录提示已经改清楚" },
    executionReview: { verdict: "passed", summary: `${MARKER} npx tsc --noEmit passed at /memory/worktrees/ca-1` },
    changes: [{ path: "src/login.ts", kind: "modify" }],
    worktreePath: "/memory/worktrees/ca-1",
    report: { summary: MARKER },
    identity: { targetCwd: "D:\\pi-agent", kind: "git", targetBranch: "refs/heads/main" },
    alreadyPresent: false, targetUpdated: true, cleanupDone: true,
    error: "backup kept at D:\\pi-agent\\backup",
  };
  const deliveredFacts = factsFromDelivery(deliveredRecord);
  assert.equal(deliveredFacts.verdict, "passed");
  assert.equal(deliveredFacts.changed, "原项目上的登录提示已经改清楚");
  assert.equal(deliveryText(deliveredRecord), deliveredFacts.changed);
  assert.doesNotMatch(noticePrompt(deliveredFacts), new RegExp(MARKER));
  assert.doesNotMatch(noticePrompt(deliveredFacts), /tsc|worktree|login|pi-agent|backup/);
  assert.doesNotMatch(deliveryText(deliveredRecord), /原先/);
  pass("交付完成只采用验收结论，执行输出和路径不进提示词");

  const rolled = {
    id: "ca-2", state: "rolled_back", mode: "git-worktree",
    targetReview: { verdict: "failed", summary: "登录提示仍是旧的，用户看不出失败原因" },
    changes: [{ path: "src/login.ts" }],
    worktreePath: "D:\\pi-agent\\memory\\worktrees\\ca-2",
    error: `rollback kept /memory/worktrees/ca-2 ${MARKER}`,
  };
  const rolledFacts = factsFromDelivery(rolled);
  assert.equal(rolledFacts.verdict, "failed");
  assert.equal(rolledFacts.changed, "登录提示仍是旧的，用户看不出失败原因");
  assert.equal(deliveryText(rolled), rolledFacts.changed);
  assert.doesNotMatch(noticePrompt(rolledFacts), new RegExp(`${MARKER}|worktree|login`));
  pass("交付撤回用验收结论，不带路径");

  const broken = exceptionFacts(`工作树 /memory/worktrees/ca-x 变了 ${MARKER} npx tsc`);
  assert.equal(broken.verdict, "unverified");
  assert.equal(broken.unchecked, "这块还没核过");
  assert.doesNotMatch(noticePrompt(broken), new RegExp(`${MARKER}|worktree|tsc|memory`));
  assert.match(noticePrompt(broken), /没核过：这块还没核过/);
  pass("交付中断的报错去掉路径和原始记号后再进事实");

  for (const [status, kind] of [["timed_out", "plain"], ["failed", "direct"], ["cancelled", "delivery"]]) {
    const facts = failureFacts(status, kind);
    assert.equal(facts.verdict, "unverified");
    assert.equal(facts.unchecked, "这块还没核过");
    assert.equal(facts.needsUser, status !== "cancelled");
    assert.doesNotMatch(factLines(noticePrompt(facts)).join("\n"), /报告|快照|原先/);
  }
  assert.match(failureFacts("timed_out", "direct").changed, /到点停了/);
  assert.match(failureFacts("timed_out", "direct").changed, /原项目/);
  pass("失败、超时、取消只产生未核实事实，不贴原始报错");

  const longHint = attentionNotice("ca-x", `${MARKER}\n`.repeat(30) + "{\"summary\":\"done\"}");
  assert.doesNotMatch(longHint, new RegExp(MARKER));
  assert.match(longHint, /连续一段时间未观察到进展/);
  assert.equal(attentionNotice("ca-x", "15 分钟无进展"), "后台任务 ca-x 需要关注：15 分钟无进展。\n任务未因 PA 对话结束而停止，整体执行时限仍有效；你可以继续聊天或取消该任务。");
  pass("需要关注仍是短提示，不贴原始输出");

  const system = readFileSync(path.join(root, "workspace", ".pi", "SYSTEM.example.md"), "utf8");
  assert.match(system, /没有从验收文件或工具结果里读到的内容，不要说成事实/);
  assert.match(system, /要纠正自己，先补上证据，不要只喊「我说错了」/);
  pass("系统提示词要求没读到就不能当事实");

  const handlerJs = stripTypeScriptTypes(sliceDeclaration(source, "async function handleDelegationEvent("), { mode: "transform" });
  const speakJs = stripTypeScriptTypes(sliceDeclaration(source, "async function speakFromFacts("), { mode: "transform" });
  const buildHandler = (deps) => new Function(
    "broadcastJobs", "notifications", "store", "server", "deliveryPipeline", "delegations",
    "reviewDelegation", "unsettledFacts", "exceptionFacts", "factsFromDelivery", "factsFromReview",
    "failureFacts", "cleanupHoldFacts", "speakFromFacts", "finalizeUserNotice", "NOTICE_FALLBACK",
    "attentionNotice", "redactSensitive",
    `${handlerJs}\nreturn handleDelegationEvent;`,
  )(
    deps.broadcastJobs, deps.notifications, deps.store, deps.server, deps.deliveryPipeline, deps.delegations,
    deps.reviewDelegation, deps.unsettledFacts, deps.exceptionFacts, deps.factsFromDelivery, deps.factsFromReview,
    deps.failureFacts, deps.cleanupHoldFacts, deps.speakFromFacts, deps.finalizeUserNotice, deps.NOTICE_FALLBACK,
    deps.attentionNotice, deps.redactSensitive,
  );
  const buildSpeak = (deps) => new Function(
    "reviewRunner", "currentModelSpec", "reviewTimeoutMs", "noticePrompt", "finalizeUserNotice", "NOTICE_FALLBACK",
    `${speakJs}\nreturn speakFromFacts;`,
  )(deps.reviewRunner, deps.currentModelSpec, deps.reviewTimeoutMs, deps.noticePrompt, deps.finalizeUserNotice, deps.NOTICE_FALLBACK);

  function harness(over = {}) {
    const order = [];
    const notes = new Map();
    const chats = [];
    const prompts = [];
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
      deliveryPipeline: { run: async () => ({ record: deliveredRecord, text: `交付原文 ${MARKER}`, delivered: true, holdProject: false }) },
      delegations: { setDeliveryHold: () => order.push("hold") },
      reviewDelegation: async () => ({ verdict: "passed", summary: "登录失败时会说明原因，刷新后仍保持登录", text: `不要采用 ${MARKER}`, stage: undefined }),
      unsettledFacts,
      exceptionFacts,
      factsFromDelivery,
      factsFromReview,
      failureFacts,
      cleanupHoldFacts,
      speakFromFacts: async (facts) => {
        prompts.push(noticePrompt(facts));
        order.push("speak");
        if (facts.verdict === "unverified" || facts.unchecked) return "这块还没核过。";
        if (facts.verdict === "failed") return "这版没通过。";
        return "登录提示改好了。";
      },
      finalizeUserNotice,
      NOTICE_FALLBACK,
      attentionNotice,
      redactSensitive: (text) => text,
      ...over,
    };
    return { notes, chats, order, prompts, handler: buildHandler(deps) };
  }

  const job = {
    id: "ca-x", status: "completed", deliveryManaged: false, source: { channel: "telegram", chatId: "-100", threadId: 1 },
    message: `完成 ${MARKER}`, task: `task ${MARKER}`, lastOutput: `终端快照 ${MARKER}`, report: { summary: MARKER },
  };
  const completed = harness();
  await completed.handler(job, "terminal");
  const notification = completed.notes.get("job:ca-x:terminal:terminal");
  assert.equal(notification.text, "登录提示改好了。");
  assert.equal(notification.kind, "job");
  assert.deepEqual(completed.chats.map((item) => item.text), ["登录提示改好了。"]);
  assert.equal(completed.prompts.length, 1);
  assert.doesNotMatch(completed.prompts[0], new RegExp(MARKER));
  assert.doesNotMatch(completed.prompts[0], /终端快照|不要采用/);
  assert.deepEqual(factLines(completed.prompts[0]), factLines(passedPrompt));
  assert.equal(completed.order.filter((item) => item.startsWith("put:")).length, 1);
  assert(completed.order.findIndex((item) => item.startsWith("put:")) < completed.order.findIndex((item) => item.startsWith("append:")));
  pass("对话和通知是同一句，提示词里没有原始报告");

  const deliveredRun = harness();
  await deliveredRun.handler({ ...job, deliveryManaged: true, deliveryAttempt: 2 }, "terminal");
  const deliveredNote = deliveredRun.notes.get("job:ca-x:terminal:terminal:delivery-2");
  assert.equal(deliveredNote.text, "登录提示改好了。");
  assert.doesNotMatch(deliveredRun.prompts[0], new RegExp(MARKER));
  assert.match(deliveredRun.prompts[0], /原项目上的登录提示已经改清楚/);
  assert.match(deliveredRun.prompts[0], /结论：通过/);
  assert(deliveredRun.order.includes("hold"));
  pass("交付分支去重 id 带 :delivery-N，提示词只用验收结论");

  const leaked = harness({
    deliveryPipeline: { run: async () => ({ text: `交付原文：diff --git a/x b/x 工作树 /memory/worktrees/ca-x ${MARKER}`, delivered: false, holdProject: true }) },
  });
  await leaked.handler({ ...job, deliveryManaged: true, deliveryAttempt: 0 }, "terminal");
  const leakedNote = leaked.notes.get("job:ca-x:terminal:terminal:delivery-0");
  assert.equal(leakedNote.text, "这块还没核过。");
  assert.doesNotMatch(leakedNote.text, new RegExp(`${MARKER}|diff|worktree|原先`));
  assert.doesNotMatch(leaked.prompts[0], new RegExp(MARKER));
  assert.doesNotMatch(factLines(leaked.prompts[0]).join("\n"), /diff|worktree|原先/);
  assert.match(leaked.prompts[0], /没核过：这块还没核过/);
  pass("交付原文不会进入聊天或提示词");

  const interrupted = harness({
    deliveryPipeline: { run: async () => ({
      text: `原先改动只在副本里 ${MARKER}`,
      delivered: false,
      holdProject: true,
      interrupted: true,
      interruptError: `工作树 /memory/worktrees/ca-x 变了 ${MARKER}`,
      record: deliveredRecord,
    }) },
  });
  await interrupted.handler({ ...job, deliveryManaged: true, deliveryAttempt: 1 }, "terminal");
  assert.equal(interrupted.notes.get("job:ca-x:terminal:terminal:delivery-1").text, "这块还没核过。");
  assert.match(interrupted.prompts[0], /结论：没核过/);
  assert.doesNotMatch(interrupted.prompts[0], new RegExp(MARKER));
  assert.doesNotMatch(factLines(interrupted.prompts[0]).join("\n"), /原先|worktree|登录提示已经改清楚/);
  pass("交付中断不把已通过的记录或原始报错说成完成");

  const failedRun = harness();
  await failedRun.handler({
    ...job, status: "timed_out", message: `超过 60 分钟 ${MARKER}`, cleanupError: `pane 未关闭 /memory/worktrees/ca-x ${MARKER}`,
  }, "terminal");
  const failedNote = failedRun.notes.get("job:ca-x:terminal:terminal");
  assert.equal(failedNote.text, "这块还没核过。");
  assert.equal(failedRun.prompts[0], noticePrompt(cleanupHoldFacts()));
  assert.doesNotMatch(failedNote.text, new RegExp(`${MARKER}|tsc|pane|worktree|60`));
  assert.doesNotMatch(failedRun.prompts[0], new RegExp(MARKER));
  pass("收尾报错不进聊天，事实标明没核过");

  const timedOut = harness();
  await timedOut.handler({ ...job, status: "timed_out", deliveryManaged: false, direct: true, message: MARKER, cleanupError: undefined }, "terminal");
  assert.equal(timedOut.prompts[0], noticePrompt(failureFacts("timed_out", "direct")));
  assert.doesNotMatch(timedOut.prompts[0], new RegExp(MARKER));
  assert.equal(timedOut.notes.get("job:ca-x:terminal:terminal").text, "这块还没核过。");
  pass("超时通知不采用任务消息里的原始输出");

  const attention = harness({ speakFromFacts: async () => { throw new Error("attention 不调用模型"); } });
  await attention.handler({ ...job, attentionSequence: 7, message: "15 分钟无进展" }, "attention");
  const attentionNote = attention.notes.get("job:ca-x:attention:7");
  assert.equal(attentionNote.kind, "attention");
  assert.equal(attentionNote.text, "后台任务 ca-x 需要关注：15 分钟无进展。\n任务未因 PA 对话结束而停止，整体执行时限仍有效；你可以继续聊天或取消该任务。");
  pass("attention 保持短提示，不改写成终态句子");

  const dumped = harness();
  await dumped.handler({ ...job, attentionSequence: 8, message: `CA 自述完成 ${MARKER} {"summary":"done"}` }, "attention");
  assert.doesNotMatch(dumped.notes.get("job:ca-x:attention:8").text, new RegExp(MARKER));
  assert.match(dumped.notes.get("job:ca-x:attention:8").text, /连续一段时间未观察到进展/);
  pass("attention 遇到原始报告时改回短提示");

  const repeated = harness({ speakFromFacts: async () => { throw new Error("不应重写"); } });
  repeated.notes.set("job:ca-x:terminal:terminal", { id: "job:ca-x:terminal:terminal", text: "已存在的短汇报", kind: "job", source: job.source });
  await repeated.handler(job, "terminal");
  assert.equal(repeated.chats[0].text, "已存在的短汇报");
  assert(!repeated.order.some((item) => item.startsWith("put:")));
  pass("同一事件已有通知时不重写");

  const qq = harness();
  await qq.handler({ ...job, source: { channel: "qq", target: "private:12345" } }, "terminal");
  assert.equal(qq.notes.get("job:ca-x:terminal:terminal").text, notification.text);
  assert.equal(qq.chats[0].text, notification.text);
  pass("QQ 与 Telegram 保存同一句");

  const fallbackRun = harness({ speakFromFacts: async () => { throw new Error(`model down ${MARKER}`); } });
  await fallbackRun.handler(job, "terminal");
  assert.equal(fallbackRun.notes.get("job:ca-x:terminal:terminal").text, NOTICE_FALLBACK);
  assert.equal(fallbackRun.chats[0].text, NOTICE_FALLBACK);
  assert.doesNotMatch(fallbackRun.notes.get("job:ca-x:terminal:terminal").text, new RegExp(`${MARKER}|原先`));
  pass("模型调用抛错时聊天和通知都是固定短句");

  const templateRun = harness({
    speakFromFacts: async () => "原先这件事还没完成。现在已经按目标做完。做了登录提示。过，核对通过。无需动手。",
  });
  await templateRun.handler(job, "terminal");
  assert.equal(templateRun.notes.get("job:ca-x:terminal:terminal").text, NOTICE_FALLBACK);
  pass("模型若写出填空句，发送前换成固定短句");

  const calls = [];
  const speak = buildSpeak({
    reviewRunner: { run: async (prompt, options) => { calls.push({ prompt, options }); return { ok: true, text: "登录提示改好了。" }; } },
    currentModelSpec: () => "test-model",
    reviewTimeoutMs: 180000,
    noticePrompt,
    finalizeUserNotice,
    NOTICE_FALLBACK,
  });
  assert.equal(await speak(passedFacts), "登录提示改好了。");
  assert.equal(calls[0].prompt, noticePrompt(passedFacts));
  assert.equal(calls[0].options.noTools, true);
  assert.equal(calls[0].options.model, "test-model");
  assert.equal(calls[0].options.timeoutMs, 45000);
  assert.equal(Object.keys(calls[0].options).sort().join(), "model,noTools,timeoutMs");
  const down = buildSpeak({
    reviewRunner: { run: async () => { throw new Error(`down ${MARKER}`); } },
    currentModelSpec: () => "test-model",
    reviewTimeoutMs: 180000,
    noticePrompt, finalizeUserNotice, NOTICE_FALLBACK,
  });
  assert.equal(await down(passedFacts), NOTICE_FALLBACK);
  const rejected = buildSpeak({
    reviewRunner: { run: async () => ({ ok: false, text: `${MARKER} 原先现在做了` }) },
    currentModelSpec: () => "test-model",
    reviewTimeoutMs: 1000,
    noticePrompt, finalizeUserNotice, NOTICE_FALLBACK,
  });
  assert.equal(await rejected(passedFacts), NOTICE_FALLBACK);
  pass("模型调用只提交验收事实；失败或拒绝时返回固定短句");

  const handlerSource = sliceDeclaration(source, "async function handleDelegationEvent(");
  const speakSource = sliceDeclaration(source, "async function speakFromFacts(");
  const reviewSource = sliceDeclaration(source, "async function evaluateDelegation(");
  assert.match(handlerSource, /speakFromFacts\(facts\)/);
  assert.match(handlerSource, /finalizeUserNotice\(spoken, facts\)/);
  assert.match(handlerSource, /reviewDelegation\(job\)/);
  assert.match(handlerSource, /deliveryPipeline\.run\(job\)/);
  assert.match(handlerSource, /attentionNotice\(job\.id, job\.message\)/);
  assert.match(handlerSource, /text: job\.source\.channel === "qq" \? text\.slice\(0, 3000\) : text/);
  assert.match(handlerSource, /const id = `job:\$\{job\.id\}:\$\{event\}:\$\{stamp\}\$\{event === "terminal" && job\.deliveryManaged \? `:delivery-\$\{job\.deliveryAttempt \?\? 0\}` : ""\}`;/);
  assert.doesNotMatch(handlerSource, /outcome\.text|review\.text|\.report|\.lastOutput|\.task|renderFiveNotice|userNoticeFromReview/);
  assert.match(speakSource, /noticePrompt\(facts\)/);
  assert.match(speakSource, /noTools:\s*true/);
  assert.match(speakSource, /NOTICE_FALLBACK/);
  assert.doesNotMatch(speakSource, /lastOutput|\.report|rawReply|sessionFile|终端快照|CA 报告|tools:\s*\[/);
  assert.match(reviewSource, /CA 报告（待核实）/);
  assert.match(reviewSource, /终端快照（待核实）/);
  assert.match(reviewSource, /tools: \["read", "bash"\]/);
  assert.match(reviewSource, /checks: checks\.map/);
  assert.match(reviewSource, /detail,/);
  assert.match(reviewSource, /rawReply:/);
  assert.match(source, /\.slice\(0, 6000\)/);
  assert.match(source, /memory", "delegation-reviews"/);
  assert.doesNotMatch(reviewSource, /noticePrompt|speakFromFacts/);
  const telegram = readFileSync(path.join(root, "app", "telegram-client.mjs"), "utf8");
  assert.match(telegram, /splitTelegramText\(notification\.text\)/);
  assert.match(source, /text: notification\.text/);
  assert.doesNotMatch(telegram, /原先|renderFiveNotice|noticePrompt/);
  pass("验收仍独立运行并落盘；聊天模型看不到报告；QQ 与 Telegram 转发同一条通知");

  console.log(`\nPASS ${checks} report-summary checks；未启动服务、未调用模型、未写入 memory/`);
} catch (error) {
  console.error(`\nFAIL report-summary selftest（${checks} passed）`);
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
