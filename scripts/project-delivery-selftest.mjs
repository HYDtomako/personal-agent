import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectDelivery } from "../src/project-delivery.ts";

const temp = mkdtempSync(path.join(tmpdir(), "pa-project-delivery-"));
const repos = [];
let count = 0;
function git(cwd, args) {
  const r = spawnSync("git", ["-c", "core.hooksPath=" + path.join(temp, "empty-hooks"), "-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  if (r.error || r.status !== 0) throw new Error(r.error?.message || r.stderr);
  return r.stdout.trim();
}
function fixture(label) {
  const root = path.join(temp, label); mkdirSync(root); repos.push(root);
  git(root, ["init", "-b", "main"]); git(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(root, "a.txt"), "base\n"); writeFileSync(path.join(root, "remove.txt"), "old\n");
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\nignored.tmp\n");
  git(root, ["add", "."]); git(root, ["-c", "user.name=PA fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture baseline"]);
  return root;
}
const engine = new ProjectDelivery({ rootDir: path.join(temp, "records"), worktreesDir: path.join(temp, "worktrees") });
const pass = { verdict: "passed", summary: "fake reviewer verified fixture" };
async function prepare(root, id) { const r = await engine.prepare({ id, cwd: root, identity: engine.identify(root) }); assert.equal(r.state, "prepared", r.error); return r; }
async function candidate(id) { const r = await engine.capture(id); assert.equal(r.state, "changes_ready", r.error); await engine.markReview(id, "execution", pass); return r; }
async function finish(id) { await engine.markReview(id, "target", pass); const r = await engine.cleanup(id); assert.equal(r.state, "cleaned", r.cleanupError); return r; }
function ok(name) { console.log(`ok ${++count} ${name}`); }
try {
  mkdirSync(path.join(temp, "empty-hooks"));
  const root = fixture("dirty source"); const head = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(root, "a.txt"), "user staged\n"); git(root, ["add", "a.txt"]);
  writeFileSync(path.join(root, "a.txt"), "user staged\nuser unstaged\n"); writeFileSync(path.join(root, "personal.txt"), "user untracked\n");
  const index = git(root, ["ls-files", "--stage"]);
  const r = await prepare(root, "dirty");
  assert.notEqual(r.executionCwd, root); assert.equal(readFileSync(path.join(r.executionCwd, "a.txt"), "utf8"), "user staged\nuser unstaged\n");
  assert.equal(readFileSync(path.join(r.executionCwd, "personal.txt"), "utf8"), "user untracked\n");
  assert.equal(git(root, ["rev-parse", "HEAD"]), head); assert.equal(git(root, ["symbolic-ref", "HEAD"]), "refs/heads/main");
  assert.equal(git(root, ["ls-files", "--stage"]), index); ok("隔离树包含staged/unstaged/untracked基线，不切原分支或改原index");
  writeFileSync(path.join(r.executionCwd, "a.txt"), "user staged\nuser unstaged\nCA addition\n");
  writeFileSync(path.join(r.executionCwd, "new.bin"), Buffer.from([0, 255, 3, 4])); unlinkSync(path.join(r.executionCwd, "remove.txt"));
  await candidate("dirty"); writeFileSync(path.join(root, "other-user.txt"), "unrelated concurrent user file");
  const applied = await engine.apply("dirty"); assert.equal(applied.state, "applied", applied.error);
  assert.match(readFileSync(path.join(root, "a.txt"), "utf8"), /user unstaged\nCA addition/); assert(!existsSync(path.join(root, "remove.txt")));
  assert.deepEqual(readFileSync(path.join(root, "new.bin")), Buffer.from([0, 255, 3, 4])); assert(existsSync(path.join(root, "other-user.txt")));
  assert.equal(git(root, ["ls-files", "--stage"]), index); assert.equal(git(root, ["rev-parse", "HEAD"]), head); ok("修改/新增/binary/删除回写，不碰原index、提交或无关新文件");
  const done = await finish("dirty"); assert(!existsSync(r.worktreePath)); assert(existsSync(done.baselineDir)); assert.equal(git(root, ["worktree", "list", "--porcelain"]).split("worktree ").length, 2); ok("原目标通过后仅清理自己工作树，保留基线和增量证据");

  const sameRoot = fixture("already"); const sameTree = await prepare(sameRoot, "already");
  writeFileSync(path.join(sameTree.executionCwd, "a.txt"), "fixed\n"); await candidate("already"); writeFileSync(path.join(sameRoot, "a.txt"), "fixed\n");
  const already = await engine.apply("already"); assert.equal(already.state, "applied"); assert.equal(already.alreadyPresent, true); assert.equal(already.targetUpdated, false); await finish("already"); ok("原目标已包含相同结果时幂等，不重复写入");

  const conflictRoot = fixture("conflict"); const conflictTree = await prepare(conflictRoot, "conflict");
  writeFileSync(path.join(conflictTree.executionCwd, "a.txt"), "CA\n"); writeFileSync(path.join(conflictTree.executionCwd, "z.txt"), "must not partially apply\n"); await candidate("conflict");
  writeFileSync(path.join(conflictRoot, "a.txt"), "new user edit\n"); const conflict = await engine.apply("conflict");
  assert.equal(conflict.state, "blocked"); assert(!existsSync(path.join(conflictRoot, "z.txt"))); assert.equal(readFileSync(path.join(conflictRoot, "a.txt"), "utf8"), "new user edit\n"); assert(existsSync(conflictTree.worktreePath)); ok("冲突整批阻断，不部分覆盖，不删工作树");

  const branchRoot = fixture("branch"); const pin = engine.identify(branchRoot); git(branchRoot, ["checkout", "-b", "other"]);
  const branch = await engine.prepare({ id: "branch", cwd: branchRoot, identity: pin }); assert.equal(branch.state, "blocked"); assert.equal(git(branchRoot, ["symbolic-ref", "HEAD"]), "refs/heads/other"); ok("提交后目标切分支会阻断，不自动切回");

  const indexRoot = fixture("index"); const indexTree = await prepare(indexRoot, "index"); writeFileSync(path.join(indexTree.executionCwd, "a.txt"), "CA\n"); await candidate("index");
  writeFileSync(path.join(indexRoot, "user.txt"), "user\n"); git(indexRoot, ["add", "user.txt"]); assert.equal((await engine.apply("index")).state, "blocked"); assert.equal(readFileSync(path.join(indexRoot, "a.txt"), "utf8"), "base\n"); ok("原index被用户更新时阻断，不stash/reset或覆盖");

  const rollbackRoot = fixture("rollback"); const rollbackTree = await prepare(rollbackRoot, "rollback"); writeFileSync(path.join(rollbackTree.executionCwd, "a.txt"), "CA\n"); await candidate("rollback"); await engine.apply("rollback");
  await engine.markReview("rollback", "target", { verdict: "failed", summary: "fixture test failed" }); assert.equal((await engine.rollback("rollback")).state, "rolled_back"); assert.equal(readFileSync(path.join(rollbackRoot, "a.txt"), "utf8"), "base\n"); assert(existsSync(rollbackTree.worktreePath)); ok("目标复验失败可安全还原本次增量，保留现场");

  const laterRoot = fixture("later edit"); const laterTree = await prepare(laterRoot, "later"); writeFileSync(path.join(laterTree.executionCwd, "a.txt"), "CA\n"); await candidate("later"); await engine.apply("later"); writeFileSync(path.join(laterRoot, "a.txt"), "new user after apply\n");
  assert.equal((await engine.rollback("later")).state, "partial"); assert.equal(readFileSync(path.join(laterRoot, "a.txt"), "utf8"), "new user after apply\n"); ok("回滚遇到用户新修改时保留，不强行恢复旧值");

  const recoverRoot = fixture("recover"); const recoverTree = await prepare(recoverRoot, "recover"); writeFileSync(path.join(recoverTree.executionCwd, "a.txt"), "after crash\n"); await candidate("recover");
  const journal = engine.get("recover"); journal.state = "applying"; journal.pendingPath = "a.txt"; writeFileSync(path.join(temp, "records/recover/state.json"), JSON.stringify(journal)); writeFileSync(path.join(recoverRoot, "a.txt"), "after crash\n");
  const restarted = new ProjectDelivery({ rootDir: path.join(temp, "records"), worktreesDir: path.join(temp, "worktrees") });
  const recovered = await restarted.apply("recover"); assert.equal(recovered.state, "applied", recovered.error); assert.equal(recovered.pendingPath, undefined); assert(recovered.appliedPaths.includes("a.txt")); await restarted.markReview("recover", "target", pass); assert.equal((await restarted.cleanup("recover")).state, "cleaned"); ok("applying崩溃窗口按journal幂等恢复，不重复破坏");

  const commitRoot = fixture("ca commit"); const commitTree = await prepare(commitRoot, "commit"); writeFileSync(path.join(commitTree.executionCwd, "a.txt"), "unauthorized\n"); git(commitTree.executionCwd, ["add", "a.txt"]); git(commitTree.executionCwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "simulate unauthorized CA commit"]);
  assert.equal((await engine.capture("commit")).state, "blocked"); assert(existsSync(commitTree.worktreePath)); ok("CA自行提交/改HEAD时阻断，不自动集成或删除提交");

  const plain = path.join(temp, "plain"); mkdirSync(plain); writeFileSync(path.join(plain, "code.txt"), "old\n"); mkdirSync(path.join(plain, "memory")); writeFileSync(path.join(plain, "memory/private.txt"), "not copied");
  const plainRecord = await prepare(plain, "plain"); assert.equal(plainRecord.mode, "in-place"); assert.equal(plainRecord.executionCwd, plain); assert(plainRecord.exclusions.includes("memory"));
  writeFileSync(path.join(plain, "code.txt"), "new\n"); await candidate("plain"); await engine.apply("plain"); await finish("plain"); assert.equal(readFileSync(path.join(plain, "code.txt"), "utf8"), "new\n"); assert(existsSync(path.join(plain, "memory/private.txt"))); ok("非Git有界备份后原地验收，绝不删原目录");
  const collisionRoot = fixture("preexisting"); const occupied = path.join(temp, "worktrees/preexisting"); mkdirSync(occupied); writeFileSync(path.join(occupied, "human.txt"), "not owned by PA");
  const collision = await engine.prepare({ id: "preexisting", cwd: collisionRoot, identity: engine.identify(collisionRoot) }); assert.equal(collision.state, "blocked"); assert.equal(readFileSync(path.join(occupied, "human.txt"), "utf8"), "not owned by PA");
  assert.throws(() => engine.identify(occupied), /内部交付目录/); ok("不接管预先存在目录，内部工作树不能冒充新交付目标");
  const corrupt = path.join(temp, "records/plain/state.json"); writeFileSync(corrupt, "{bad"); assert.throws(() => engine.get("plain")); assert.equal(readFileSync(corrupt, "utf8"), "{bad"); assert.throws(() => engine.get("../outside")); ok("损坏存储和越界标识拒绝处理");
  console.log(`PASS ${count} project delivery tests; only disposable repositories were modified`);
} finally {
  for (const root of repos) {
    const listing = git(root, ["worktree", "list", "--porcelain"]);
    for (const line of listing.split("\n")) if (line.startsWith("worktree ")) { const tree = line.slice(9); if (path.resolve(tree) !== path.resolve(root) && path.resolve(tree).startsWith(path.resolve(temp) + path.sep)) git(root, ["worktree", "remove", "--force", tree]); }
  }
  rmSync(temp, { recursive: true, force: true });
}
