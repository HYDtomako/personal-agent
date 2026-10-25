import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectDelivery } from "../src/project-delivery.ts";
import { DeliveryPipeline } from "../src/delivery-pipeline.ts";
const temp = mkdtempSync(path.join(tmpdir(), "pa-pipeline-"));
const engine = new ProjectDelivery({ rootDir: path.join(temp, "records"), worktreesDir: path.join(temp, "trees") });
const repos = [];
function git(root, args) { const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, timeout: 15000 }); if (r.status !== 0 || r.error) throw new Error(r.stderr || r.error.message); return r.stdout.trim(); }
async function job(id) {
  const cwd = path.join(temp, id); mkdirSync(cwd); repos.push(cwd);
  git(cwd, ["init", "-b", "main"]); git(cwd, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(cwd, "answer.txt"), "before\n"); git(cwd, ["add", "."]); git(cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const identity = engine.identify(cwd); const prepared = await engine.prepare({ id, cwd, identity }); assert.equal(prepared.state, "prepared", prepared.error);
  writeFileSync(path.join(prepared.executionCwd, "answer.txt"), "after\n");
  return { id, cwd, task: "fixture change", status: "completed", deliveryManaged: true, projectIdentity: identity, closedAt: new Date().toISOString() };
}
let tests = 0; const ok = text => console.log(`ok ${++tests} ${text}`);
try {
  const good = await job("good"); const stages = [];
  const pipeline = new DeliveryPipeline({ projects: engine, review: async (j, stage, r) => {
    stages.push(stage); const dir = stage === "execution" ? r.executionCwd : r.identity.targetCwd;
    assert.equal(readFileSync(path.join(dir, "answer.txt"), "utf8"), "after\n");
    if (stage === "execution") assert.equal(readFileSync(path.join(j.cwd, "answer.txt"), "utf8"), "before\n");
    return { verdict: "passed", summary: stage + " fixture verified" };
  } });
  const result = await pipeline.run(good); assert.equal(result.delivered, true); assert.equal(result.record.state, "cleaned"); assert.deepEqual(stages, ["execution", "target"]); assert.equal(result.record.committed, false); assert.equal(result.record.pushed, false); assert.equal(result.record.deployed, false); ok("执行树验收后才回写，原目录实际复验后清理且不发布");
  await pipeline.run(good); assert.equal(stages.length, 2); ok("成功通知重试不重跑验收或重复回写");

  const badExecution = await job("bad-execution"); let calls = 0;
  const stopped = await new DeliveryPipeline({ projects: engine, review: async () => { calls++; return { verdict: "failed", summary: "bad worktree" }; } }).run(badExecution);
  assert.equal(stopped.delivered, false); assert.equal(calls, 1); assert.equal(readFileSync(path.join(badExecution.cwd, "answer.txt"), "utf8"), "before\n"); assert(existsSync(stopped.record.worktreePath)); ok("隔离验收失败不回写并保留成果");

  const badTarget = await job("bad-target");
  const rolled = await new DeliveryPipeline({ projects: engine, review: async (_j, stage) => ({ verdict: stage === "execution" ? "passed" : "failed", summary: "fixture target failure" }) }).run(badTarget);
  assert.equal(rolled.record.state, "rolled_back"); assert.equal(rolled.holdProject, false); assert.equal(readFileSync(path.join(badTarget.cwd, "answer.txt"), "utf8"), "before\n"); ok("原目录复验失败自动安全回滚本次增量");

  const race = await job("race");
  const partial = await new DeliveryPipeline({ projects: engine, review: async (j, stage) => {
    if (stage === "target") writeFileSync(path.join(j.cwd, "answer.txt"), "new human edit\n");
    return { verdict: stage === "execution" ? "passed" : "failed", summary: "concurrent user edit" };
  } }).run(race);
  assert.equal(partial.holdProject, true); assert.equal(partial.record.state, "partial"); assert.equal(readFileSync(path.join(race.cwd, "answer.txt"), "utf8"), "new human edit\n"); ok("无法安全回滚时保留用户新内容并要求项目hold");

  const retry = await job("retry"); let allow = false;
  const retryPipeline = new DeliveryPipeline({ projects: engine, review: async () => ({ verdict: allow ? "passed" : "unverified", summary: "fixture" }) });
  assert.equal((await retryPipeline.run(retry)).delivered, false); allow = true;
  assert.equal((await retryPipeline.run({ ...retry, deliveryAttempt: 1 })).delivered, true); ok("重试交付复用原工作树，不重新运行CA");

  const slow = await job("slow"); let release; const gate = new Promise(resolve => release = resolve); let reviews = 0;
  const shared = new DeliveryPipeline({ projects: engine, review: async (_j, stage) => { reviews++; if (stage === "execution") await gate; return { verdict: "passed", summary: "fixture" }; } });
  const a = shared.run(slow), b = shared.run(slow); assert.equal(a, b); release(); await a; assert.equal(reviews, 2); ok("重复回调共享同一交付事务，不并发应用文件");
  console.log(`PASS ${tests} pipeline tests; all repositories and reviews isolated`);
} finally {
  for (const root of repos) for (const line of git(root, ["worktree", "list", "--porcelain"]).split("\n")) if (line.startsWith("worktree ")) {
    const tree = path.resolve(line.slice(9)); if (tree !== path.resolve(root) && tree.startsWith(path.resolve(temp) + path.sep)) git(root, ["worktree", "remove", "--force", tree]);
  }
  rmSync(temp, { recursive: true, force: true });
}
