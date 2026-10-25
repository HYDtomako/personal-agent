import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv.includes("--run")) {
  console.log("Dry run: --run explicitly enables a real Kimi task in a new disposable Git fixture and one GUI chat. No QQ/TG sends.");
  process.exit(0);
}
const cfg = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8"));
const base = `http://127.0.0.1:${cfg.gui.port}`;
const headers = { "content-type": "application/json", ...(cfg.gui.token ? { "x-token": cfg.gui.token } : {}) };
async function api(route, body) {
  const r = await fetch(base + route, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  const d = await r.json(); if (!r.ok) throw new Error(`Local API ${r.status}: ${String(d.error ?? "failure")}`); return d;
}
assert.equal((await api("/api/status")).projectDelivery, true);
const cwd = mkdtempSync(path.join(root, "workspace", "delivery-live-"));
function git(args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  if (r.error || r.status !== 0) throw new Error(r.error?.message || r.stderr); return r.stdout.trim();
}
git(["init", "-b", "fixture-delivery"]); git(["config", "core.autocrlf", "false"]);
const expected = ["WORKTREE_OK", "USER_STAGED", "USER_UNSTAGED", ""].join(String.fromCharCode(10));
writeFileSync(path.join(cwd, "message.txt"), "BASE" + String.fromCharCode(10));
const verify = `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; const value=readFileSync(new URL('./message.txt',import.meta.url),'utf8'); assert.equal(value,${JSON.stringify(expected)}); console.log('DELIVERY_VERIFY_OK');`;
writeFileSync(path.join(cwd, "verify.mjs"), verify);
const syntax = spawnSync(process.execPath, ["--check", path.join(cwd, "verify.mjs")], { encoding: "utf8", windowsHide: true });
assert.equal(syntax.status, 0, syntax.stderr);
git(["add", "."]); git(["-c", "user.name=PA isolated fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture only baseline"]);
writeFileSync(path.join(cwd, "message.txt"), ["BASE", "USER_STAGED", ""].join(String.fromCharCode(10))); git(["add", "message.txt"]);
writeFileSync(path.join(cwd, "message.txt"), ["BASE", "USER_STAGED", "USER_UNSTAGED", ""].join(String.fromCharCode(10)));
writeFileSync(path.join(cwd, "user-note.txt"), "KEEP_UNTRACKED" + String.fromCharCode(10));
const before = { head: git(["rev-parse", "HEAD"]), branch: git(["symbolic-ref", "HEAD"]), index: git(["ls-files", "--stage"]), verify };
const task = "这是自动交付测试，仅限本次新建 Git 测试仓库。只把 message.txt 第一行 BASE 改成 WORKTREE_OK，必须完整保留 USER_STAGED、USER_UNSTAGED 两行和 user-note.txt。不能修改 verify.mjs。运行 node verify.mjs，必须得到 DELIVERY_VERIFY_OK 和退出码0，否则报告failed，不能改用替代标准。不要提交、推送、安装、联网、部署、重启服务或发消息；只在系统提供的隔离工作树操作，原目录由PA交付。最后按系统约定写结果报告。";
const { job: accepted } = await api("/api/delegations", { task, cwd, worker: "kimi", timeoutMs: 300000 });
const evidenceDir = path.join(root, "memory", "selftest-evidence"); mkdirSync(evidenceDir, { recursive: true });
const evidenceFile = path.join(evidenceDir, `git-delivery-${accepted.id}.json`);
const manifest = { jobId: accepted.id, cwd, createdAt: new Date().toISOString(), before, result: "running" };
writeFileSync(evidenceFile, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ jobId: accepted.id, cwd, evidenceFile }, null, 2));
const { request: chat } = await api("/api/requests", { text: "这是本人授权的并行自检。不要使用工具，不要解释，不要添加标点或引号，不要等待编码任务。仅原样回复下一行：\n并行验证通过", source: { channel: "gui" }, idempotencyKey: `git-delivery-check:${accepted.id}` });
const deadline = Date.now() + 300000; let job;
for (;;) {
  job = (await api(`/api/delegations/${accepted.id}`)).job;
  if (job.notifiedAt || ["failed", "timed_out", "cancelled"].includes(job.status) || Date.now() >= deadline) break;
  await new Promise(resolve => setTimeout(resolve, 1500));
}
const finalChat = (await api(`/api/requests/${chat.id}`)).request;
const checks = {
  caCompleted: job.status === "completed", targetDelivered: job.delivery?.state === "cleaned",
  executionReviewPassed: job.delivery?.executionReview?.verdict === "passed", targetReviewPassed: job.delivery?.targetReview?.verdict === "passed",
  finalContent: readFileSync(path.join(cwd, "message.txt"), "utf8") === expected,
  stagedIndexPreserved: git(["ls-files", "--stage"]) === before.index,
  branchPreserved: git(["symbolic-ref", "HEAD"]) === before.branch,
  noCommit: git(["rev-parse", "HEAD"]) === before.head,
  verifyUnchanged: readFileSync(path.join(cwd, "verify.mjs"), "utf8") === before.verify,
  untrackedPreserved: readFileSync(path.join(cwd, "user-note.txt"), "utf8") === "KEEP_UNTRACKED" + String.fromCharCode(10),
  worktreeRemoved: !!job.delivery?.cleanupDone && !existsSync(job.delivery.worktreePath),
  chatReplied: finalChat.status === "completed" && finalChat.reply.trim() === "并行验证通过",
  chatBeforeCodingEnded: Date.parse(finalChat.finishedAt) < Date.parse(job.finishedAt),
};
const test = spawnSync(process.execPath, [path.join(cwd, "verify.mjs")], { encoding: "utf8", windowsHide: true, timeout: 10000 });
checks.originalTestPassed = test.status === 0 && test.stdout.includes("DELIVERY_VERIFY_OK");
const report = { ...manifest, requestId: chat.id, result: Object.values(checks).every(Boolean) ? "passed" : "failed", checks, job: { status: job.status, message: job.message, delivery: job.delivery }, chat: { durationMs: finalChat.meta?.durationMs, status: finalChat.status }, test: { exit: test.status, stdout: test.stdout, stderr: test.stderr } };
writeFileSync(evidenceFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ result: report.result, checks, chatMs: finalChat.meta?.durationMs, delivery: job.delivery?.state, evidenceFile }, null, 2));
if (report.result !== "passed") process.exitCode = 1;
