import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PiRunner } from "../src/runner.ts";
import { ChatStore } from "../src/store.ts";
import { normalizeSource } from "../src/protocol.ts";

const directory = mkdtempSync(path.join(tmpdir(), "pa-runner-background-"));
const file = path.join(directory, "fake-pi.mjs");
writeFileSync(file, `
const args = process.argv.slice(2);
const prompt = args.at(-1);
if (prompt === 'timeout') setInterval(() => {}, 1000);
else setTimeout(() => {
  const text = JSON.stringify({args, user:process.env.PI_USER_ID, request:process.env.PI_REQUEST_ID, review:process.env.PI_REVIEW_JOB_ID});
  console.log(JSON.stringify({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text}]}]}));
}, prompt === 'slow' ? 100 : 0);
`);
let runner;
try {
  runner = new PiRunner({ command: process.execPath, args: [file], thinking: "minimal", cwd: directory, maxConcurrent: 2, timeoutMs: 5000, env: { PI_USER_ID: "global-forgery" } });
  const [slow, fast] = await Promise.all([
    runner.run("slow", { userId: "owner", env: { PI_REQUEST_ID: "request-a", PI_USER_ID: "job-forgery" } }),
    runner.run("fast", { userId: "owner", env: { PI_REQUEST_ID: "request-b" } }),
  ]);
  assert.equal(slow.ok, true);
  assert.equal(fast.ok, true);
  assert.equal(JSON.parse(slow.text).request, "request-a");
  assert.equal(JSON.parse(fast.text).request, "request-b");
  assert.equal(JSON.parse(slow.text).user, "owner");
  console.log("ok 独立子进程收到各自请求上下文，身份不可由 job env 覆盖");

  const review = new PiRunner({ command: process.execPath, args: [file, "--no-extensions", "--no-skills", "--no-prompt-templates"], thinking: "minimal", cwd: directory, maxConcurrent: 1, timeoutMs: 5000 });
  const response = await review.run("review", { userId: "owner", tools: ["read", "bash"], env: { PI_REVIEW_JOB_ID: "ca-test" } });
  assert.equal(response.ok, true);
  const data = JSON.parse(response.text);
  for (const arg of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session", "--tools", "read,bash"]) assert(data.args.includes(arg), arg);
  assert.equal(data.review, "ca-test");
  assert.equal(data.request, undefined);
  console.log("ok 验收独立执行器无对话 session，禁扩展/技能并限制内置工具");

  const timeout = await runner.run("timeout", { userId: "owner", timeoutMs: 200 });
  assert.equal(timeout.ok, false);
  assert.match(timeout.error, /超时/);
  const after = await runner.run("after", { userId: "owner", env: { PI_REQUEST_ID: "after-timeout" } });
  assert.equal(after.ok, true);
  console.log("ok 单轮超时如实失败并释放执行槽，下一轮正常回应");

  const store = new ChatStore(path.join(directory, "chat.jsonl"));
  assert.equal(store.appendOnce({ id: "reply:test", role: "assistant", text: "ok", meta: { requestId: "test" } }).inserted, true);
  assert.equal(store.appendOnce({ id: "reply:test", role: "assistant", text: "ok" }).inserted, false);
  assert.equal(store.all().length, 1);
  assert.equal(normalizeSource({ channel: "telegram", chatId: "-42", threadId: 0 }).threadId, 0);
  assert.throws(() => normalizeSource({ channel: "qq", target: "arbitrary-path" }));
  console.log("ok 对话回执幂等入库，渠道参数校验与 TG 路由兼容");
} finally {
  runner?.abortAll();
  rmSync(directory, { recursive: true, force: true });
}
