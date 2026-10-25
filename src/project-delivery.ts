import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ProjectIdentity {
  kind: "git" | "directory"; projectKey: string; targetRoot: string; targetCwd: string; relativeCwd: string;
  gitDir?: string; commonDir?: string; targetBranch?: string | null; targetHead?: string;
}
export interface ReviewResult { verdict: "passed" | "failed" | "unverified"; summary: string }
interface Entry { hash: string; size: number; mode: number }
export interface DeliveryChange { path: string; kind: "add" | "modify" | "delete"; beforeHash?: string; afterHash?: string }
export interface DeliveryRecord {
  version: 1; id: string; mode: "git-worktree" | "in-place";
  state: "preparing" | "prepared" | "changes_ready" | "applying" | "applied" | "verified" | "cleaned" | "blocked" | "rolled_back" | "partial" | "failed";
  identity: ProjectIdentity; executionCwd: string; worktreePath?: string; baselineDir: string; createdAt: string; updatedAt: string;
  changes: DeliveryChange[]; baseline: Record<string, Entry>; candidate?: Record<string, Entry>; indexSignature?: string;
  executionReview?: ReviewResult; targetReview?: ReviewResult;
  targetUpdated: boolean; alreadyPresent: boolean; cleanupDone: boolean; committed: false; pushed: false; deployed: false;
  error?: string; conflicts?: string[]; exclusions: string[]; snapshotReady?: boolean; worktreeCreateStarted?: boolean;
  appliedPaths: string[]; pendingPath?: string; cleanupError?: string;
}
const key = (p: string) => process.platform === "win32" ? path.normalize(p).toLowerCase() : path.normalize(p);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const same = (a?: Entry, b?: Entry) => a?.hash === b?.hash && a?.mode === b?.mode;
const clone = <T>(v: T): T => structuredClone(v);
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const skipped = new Set([".git", "node_modules", "memory", "backup", "backups", ".zcode", ".kimi", ".claude", ".cache", "dist", "build", "coverage"]);

function absent(p: string): boolean {
  try { lstatSync(p); return false; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; throw e; }
}
function relative(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  if (!p || path.isAbsolute(p) || parts.some(s => !s || s === "." || s === ".." || s.toLowerCase() === ".git" || /[\x00-\x1f:]/.test(s))) throw new Error(`不安全的项目路径：${p}`);
  return parts.join("/");
}
function safeFile(root: string, rel: string): string {
  const parts = relative(rel).split("/"); let cursor = root;
  if (lstatSync(root).isSymbolicLink()) throw new Error("项目根目录不能是符号链接");
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (!absent(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`拒绝跟随符号链接：${rel}`);
  }
  return cursor;
}
function readSmall(file: string): string {
  if (!lstatSync(file).isFile() || statSync(file).size > 4 * 1024 * 1024) throw new Error("Git 元数据过大或不是文件");
  return readFileSync(file, "utf8").trim();
}
function readHead(gitDir: string, commonDir: string): { branch: string | null; head: string } {
  const value = readSmall(path.join(gitDir, "HEAD"));
  if (/^[0-9a-f]{40,64}$/i.test(value)) return { branch: null, head: value };
  const branch = value.startsWith("ref: ") ? value.slice(5) : "";
  if (!branch.startsWith("refs/heads/") || branch.includes("..") || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch)) throw new Error("不支持或无效的 HEAD 引用");
  const loose = path.join(commonDir, ...branch.split("/"));
  let head = absent(loose) ? "" : readSmall(loose);
  if (!head && !absent(path.join(commonDir, "packed-refs"))) {
    const line = readSmall(path.join(commonDir, "packed-refs")).split("\n").find(s => s.trim().endsWith(` ${branch}`));
    head = line?.split(" ")[0] ?? "";
  }
  if (!/^[0-9a-f]{40,64}$/i.test(head)) throw new Error("仓库没有可用提交或引用布局不受支持；未自动创建提交");
  return { branch, head };
}

export class ProjectDelivery {
  private readonly root: string; private readonly trees: string; private readonly hooks: string;
  private readonly maxFiles: number; private readonly maxBytes: number; private readonly timeout: number;
  private busy = new Map<string, Promise<DeliveryRecord>>();
  constructor(opts: { rootDir: string; worktreesDir?: string; maxFiles?: number; maxSnapshotBytes?: number; gitTimeoutMs?: number }) {
    this.root = path.resolve(opts.rootDir); this.trees = path.resolve(opts.worktreesDir ?? path.join(this.root, "worktrees"));
    this.hooks = path.join(this.root, ".empty-hooks"); this.maxFiles = opts.maxFiles ?? 20000; this.maxBytes = opts.maxSnapshotBytes ?? 256 * 1024 * 1024; this.timeout = opts.gitTimeoutMs ?? 30000;
    mkdirSync(this.root, { recursive: true }); mkdirSync(this.trees, { recursive: true }); mkdirSync(this.hooks, { recursive: true });
    if (readdirSync(this.hooks).length) throw new Error("用于禁用 Git hooks 的目录不是空目录");
  }
  identify(cwd: string, allowManaged = false): ProjectIdentity {
    if (!path.isAbsolute(cwd)) throw new Error("项目目录必须是绝对路径");
    const targetCwd = path.normalize(realpathSync.native(cwd)); if (!statSync(targetCwd).isDirectory()) throw new Error("项目目录不存在");
    if (!allowManaged && [this.root, this.trees].some(base => key(targetCwd) === key(base) || key(targetCwd).startsWith(key(base) + path.sep))) throw new Error("PA 内部交付目录不能作为新任务原目标，请使用原项目路径");
    let cursor = targetCwd;
    for (;;) {
      const marker = path.join(cursor, ".git");
      if (!absent(marker)) {
        if (lstatSync(marker).isSymbolicLink()) throw new Error("拒绝符号链接 .git");
        let gitDir = marker;
        if (statSync(marker).isFile()) { const v = readSmall(marker); if (!v.startsWith("gitdir: ")) throw new Error("损坏的 .git 文件"); gitDir = path.resolve(cursor, v.slice(8)); }
        gitDir = path.normalize(realpathSync.native(gitDir));
        const commonFile = path.join(gitDir, "commondir");
        const commonDir = path.normalize(realpathSync.native(absent(commonFile) ? gitDir : path.resolve(gitDir, readSmall(commonFile))));
        const h = readHead(gitDir, commonDir);
        return { kind: "git", projectKey: `git:${key(commonDir)}`, targetRoot: cursor, targetCwd, relativeCwd: path.relative(cursor, targetCwd), gitDir, commonDir, targetBranch: h.branch, targetHead: h.head };
      }
      const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    return { kind: "directory", projectKey: `dir:${key(targetCwd)}`, targetRoot: targetCwd, targetCwd, relativeCwd: "" };
  }
  get(id: string): DeliveryRecord | undefined {
    const file = this.stateFile(id); if (absent(file)) return undefined;
    const r = JSON.parse(readFileSync(file, "utf8")) as DeliveryRecord;
    if (r.version !== 1 || r.id !== id || !r.identity || !path.isAbsolute(r.identity.targetRoot) || !r.baseline || !Array.isArray(r.changes) || !Array.isArray(r.appliedPaths)) throw new Error("交付记录损坏，拒绝覆盖");
    if (!["git-worktree", "in-place"].includes(r.mode) || !["preparing", "prepared", "changes_ready", "applying", "applied", "verified", "cleaned", "blocked", "rolled_back", "partial", "failed"].includes(r.state)) throw new Error("交付模式或状态无效");
    if (!path.isAbsolute(r.identity.targetCwd) || typeof r.identity.relativeCwd !== "string" || path.isAbsolute(r.identity.relativeCwd) || key(path.resolve(r.identity.targetRoot, r.identity.relativeCwd)) !== key(r.identity.targetCwd)) throw new Error("交付目标路径无效");
    if (r.mode === "git-worktree" ? (r.identity.kind !== "git" || !r.worktreePath || key(r.executionCwd) !== key(path.resolve(r.worktreePath, r.identity.relativeCwd))) : (r.identity.kind !== "directory" || r.worktreePath !== undefined || key(r.executionCwd) !== key(r.identity.targetCwd))) throw new Error("交付执行路径与模式不匹配");
    if (r.identity.relativeCwd) relative(r.identity.relativeCwd);
    if (r.identity.kind === "git" && (!r.identity.commonDir || !path.isAbsolute(r.identity.commonDir) || !r.identity.gitDir || !path.isAbsolute(r.identity.gitDir) || !/^[a-f0-9]{40,64}$/i.test(r.identity.targetHead ?? ""))) throw new Error("Git 交付身份损坏");
    if (r.baselineDir !== path.join(this.root, id, "blobs") || (r.worktreePath && key(r.worktreePath) !== key(path.join(this.trees, id)))) throw new Error("交付记录路径不属于受管目录");
    for (const entries of [r.baseline, r.candidate ?? {}]) for (const [name, e] of Object.entries(entries)) {
      relative(name); if (!/^[a-f0-9]{64}$/.test(e.hash) || !Number.isSafeInteger(e.size) || e.size < 0 || !Number.isSafeInteger(e.mode)) throw new Error("快照条目无效");
    }
    for (const c of r.changes) relative(c.path); for (const p of r.appliedPaths) relative(p); if (r.pendingPath) relative(r.pendingPath);
    return clone(r);
  }
  private stateFile(id: string): string { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("交付 id 无效"); return path.join(this.root, id, "state.json"); }
  private save(r: DeliveryRecord): DeliveryRecord {
    r.updatedAt = new Date().toISOString(); const file = this.stateFile(r.id); mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`; const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(r, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temp, file); } finally { if (!absent(temp)) unlinkSync(temp); }
    return clone(r);
  }
  private serial(id: string, fn: () => Promise<DeliveryRecord>): Promise<DeliveryRecord> {
    if (this.busy.has(id)) return Promise.reject(new Error("该任务正在进行文件交付操作"));
    const p = fn(); this.busy.set(id, p); void p.finally(() => { if (this.busy.get(id) === p) this.busy.delete(id); }).catch(() => {}); return p;
  }
  private require(id: string): DeliveryRecord { const r = this.get(id); if (!r) throw new Error("交付记录不存在"); return r; }
  private git(cwd: string, args: string[], allowed = [0]): Promise<{ text: string; code: number }> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };
      for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[k];
      const child = spawn("git", ["-c", `core.hooksPath=${this.hooks}`, "-c", "core.quotePath=false", "-C", cwd, ...args], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "", settled = false;
      const done = (e?: Error, code?: number | null) => { if (settled) return; settled = true; clearTimeout(timer); if (e) reject(e); else if (!allowed.includes(code ?? -1)) reject(new Error(`Git ${args[0]} 失败：${err.slice(-1200)}`)); else resolve({ text: out, code: code ?? -1 }); };
      const timer = setTimeout(() => { child.kill(); done(new Error(`Git ${args[0]} 超时`)); }, this.timeout);
      child.stdout.on("data", d => { out += d.toString("utf8"); if (out.length > 32 * 1024 * 1024) { child.kill(); done(new Error("Git 输出超过上限")); } });
      child.stderr.on("data", d => { err = (err + d).slice(-8000); }); child.on("error", e => done(e)); child.on("close", c => done(undefined, c));
    });
  }
  private async confirmIdentity(i: ProjectIdentity): Promise<void> {
    const current = this.identify(i.targetCwd);
    if (JSON.stringify(current) !== JSON.stringify(i)) throw new Error("目标目录、分支或 HEAD 已变化；未自动切换或覆盖");
    if (i.kind === "git") {
      const top = (await this.git(i.targetCwd, ["rev-parse", "--show-toplevel"])).text.trim();
      const head = (await this.git(i.targetCwd, ["rev-parse", "HEAD"])).text.trim();
      if (key(realpathSync.native(top)) !== key(i.targetRoot) || head !== i.targetHead) throw new Error("Git 实际根或 HEAD 与提交时身份不符");
    }
  }
  private async stage(cwd: string): Promise<string> {
    const stages = (await this.git(cwd, ["ls-files", "--stage", "-z"])).text;
    for (const line of stages.split("\0").filter(Boolean)) if (!/^100(?:644|755) [a-f0-9]{40,64} 0\t/.test(line)) throw new Error("不自动处理符号链接、子模块或未解决的 index 冲突");
    const flags = (await this.git(cwd, ["ls-files", "-v", "-z"])).text;
    if (flags.split("\0").filter(Boolean).some(line => line[0] !== "H")) throw new Error("不自动处理 sparse/skip-worktree/assume-unchanged index");
    const debug = (await this.git(cwd, ["ls-files", "--debug"])).text;
    const bits = [...debug.matchAll(/^\s+size:\s+\d+\s+flags:\s+([0-9a-f]+)/gmi)].map(match => match[1]);
    if (bits.length !== stages.split("\0").filter(Boolean).length) throw new Error("不能确认 Git index 标志，拒绝自动回写");
    return hash(stages + "\0" + flags + "\0" + bits.join(","));
  }
  private entry(file: string, blobs?: string): Entry | undefined {
    if (absent(file)) return undefined; const s = lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink > 1) throw new Error(`不支持链接或非普通文件：${file}`);
    if (s.size > Math.min(this.maxBytes, 32 * 1024 * 1024)) throw new Error(`文件超过自动快照上限：${file}`);
    const content = readFileSync(file); const after = lstatSync(file);
    if (s.size !== after.size || s.mtimeMs !== after.mtimeMs) throw new Error(`快照期间文件正在变化：${file}`);
    const h = hash(content);
    if (blobs && absent(path.join(blobs, h))) {
      const fd = openSync(path.join(blobs, h), "wx", 0o600);
      try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    }
    if (blobs && hash(readFileSync(path.join(blobs, h))) !== h) throw new Error("已有快照 blob 损坏，拒绝继续准备或回写");
    return { hash: h, size: content.length, mode: s.mode & 0o777 };
  }
  private async snapshot(root: string, git: boolean, blobs: string, exclusions: string[]): Promise<Record<string, Entry>> {
    mkdirSync(blobs, { recursive: true }); let names: string[] = [];
    if (git) {
      await this.stage(root);
      names = (await this.git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).text.split("\0").filter(Boolean);
    } else {
      const walk = (dir: string, prefix: string) => {
        for (const item of readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${item.name}` : item.name; const full = path.join(dir, item.name);
          if (skipped.has(item.name) || key(full) === key(this.root) || key(full) === key(this.trees)) { exclusions.push(rel); continue; }
          if (item.isSymbolicLink()) throw new Error(`非 Git 快照不跟随链接：${rel}`);
          if (item.isDirectory()) { if (!absent(path.join(full, ".git"))) { exclusions.push(rel); continue; } walk(full, rel); }
          else names.push(rel);
          if (names.length > this.maxFiles) throw new Error("项目文件数超过自动快照上限");
        }
      }; walk(root, "");
    }
    names = [...new Set(names.map(relative))].sort(); if (names.length > this.maxFiles) throw new Error("项目文件数超过自动快照上限");
    const result: Record<string, Entry> = {}; let bytes = 0; let count = 0;
    for (const name of names) {
      const entry = this.entry(safeFile(root, name), blobs);
      if (entry) { bytes += entry.size; if (bytes > this.maxBytes) throw new Error("项目大小超过自动快照上限"); result[name] = entry; }
      if (++count % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    return result;
  }
  private async assertWorktree(r: DeliveryRecord): Promise<void> {
    if (!r.worktreePath || key(r.worktreePath) !== key(path.join(this.trees, r.id))) throw new Error("工作树不是本任务的受管路径");
    const listing = (await this.git(r.identity.targetRoot, ["worktree", "list", "--porcelain", "-z"])).text.split("\0");
    if (!listing.some(line => line.startsWith("worktree ") && key(line.slice(9)) === key(r.worktreePath!))) throw new Error("工作树登记不匹配，拒绝接管或删除");
    const actual = this.identify(r.worktreePath, true);
    if (actual.kind !== "git" || actual.targetBranch !== null || actual.targetHead !== r.identity.targetHead || actual.commonDir !== r.identity.commonDir) throw new Error("CA 工作树 HEAD/分支/仓库发生变化；不自动纳入提交或删除");
  }
  prepare(input: { id: string; cwd: string; identity?: ProjectIdentity }): Promise<DeliveryRecord> {
    return this.serial(input.id, async () => {
      let r = this.get(input.id);
      if (r && r.state !== "preparing") return r;
      const identity = input.identity ?? this.identify(input.cwd);
      if (r && JSON.stringify(r.identity) !== JSON.stringify(identity)) throw new Error("相同任务不能更换交付身份");
      if (!r) {
        const now = new Date().toISOString(); const tree = identity.kind === "git" ? path.join(this.trees, input.id) : undefined;
        r = { version: 1, id: input.id, mode: tree ? "git-worktree" : "in-place", state: "preparing", identity: clone(identity), executionCwd: tree ? path.join(tree, identity.relativeCwd) : identity.targetCwd,
          ...(tree ? { worktreePath: tree } : {}), baselineDir: path.join(this.root, input.id, "blobs"), createdAt: now, updatedAt: now, baseline: {}, changes: [], exclusions: [], appliedPaths: [], targetUpdated: false, alreadyPresent: false, cleanupDone: false, committed: false, pushed: false, deployed: false };
        this.save(r);
      }
      try {
        await this.confirmIdentity(identity);
        if (!r.snapshotReady) {
          r.baseline = await this.snapshot(identity.targetRoot, identity.kind === "git", r.baselineDir, r.exclusions);
          r.indexSignature = identity.kind === "git" ? await this.stage(identity.targetRoot) : undefined;
          r.snapshotReady = true; this.save(r);
        }
        if (r.mode === "git-worktree") {
          if (absent(r.worktreePath!)) {
            r.worktreeCreateStarted = true; this.save(r);
            await this.git(identity.targetRoot, ["worktree", "add", "--detach", "--no-checkout", r.worktreePath!, identity.targetHead!]);
          } else if (!r.worktreeCreateStarted) throw new Error("受管工作树路径预先存在，拒绝接管或删除不是本任务创建的目录");
          await this.assertWorktree(r);
          await this.git(r.worktreePath!, ["read-tree", "HEAD"]);
          let copied = 0;
          for (const [name, e] of Object.entries(r.baseline)) {
            const dest = safeFile(r.worktreePath!, name); const current = this.entry(dest);
            if (current && !same(current, e)) throw new Error(`未准备完成的工作树含未知修改：${name}`);
            if (!current) { mkdirSync(path.dirname(dest), { recursive: true }); copyFileSync(path.join(r.baselineDir, e.hash), dest); chmodSync(dest, e.mode); }
            if (++copied % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
          }
          mkdirSync(r.executionCwd, { recursive: true });
        }
        await this.confirmIdentity(identity);
        const rechecked = await this.snapshot(identity.targetRoot, identity.kind === "git", r.baselineDir, []);
        if (JSON.stringify(rechecked) !== JSON.stringify(r.baseline) || (identity.kind === "git" && await this.stage(identity.targetRoot) !== r.indexSignature)) throw new Error("准备期间原工作区发生变化，保留快照并停止，不让 CA 使用混合基线");
        r.state = "prepared"; r.error = undefined; return this.save(r);
      } catch (e) { r.state = "blocked"; r.error = message(e); return this.save(r); }
    });
  }
  capture(id: string): Promise<DeliveryRecord> {
    return this.serial(id, async () => {
      const r = this.require(id);
      if (["applying", "partial", "applied", "verified", "cleaned"].includes(r.state)) return r;
      try {
        await this.confirmIdentity(r.identity); if (r.mode === "git-worktree") await this.assertWorktree(r);
        const root = r.worktreePath ?? r.identity.targetRoot;
        const candidate = await this.snapshot(root, r.mode === "git-worktree", r.baselineDir, r.exclusions);
        const changes: DeliveryChange[] = [];
        for (const name of [...new Set([...Object.keys(r.baseline), ...Object.keys(candidate)])].sort()) {
          const before = r.baseline[name], after = candidate[name]; if (same(before, after)) continue;
          changes.push({ path: name, kind: !before ? "add" : !after ? "delete" : "modify", ...(before ? { beforeHash: before.hash } : {}), ...(after ? { afterHash: after.hash } : {}) });
        }
        if (r.mode === "git-worktree" && changes.length > 500) throw new Error("本次增量超过 500 个文件，保留工作树，不自动进行大批回写");
        r.candidate = candidate; r.changes = changes; r.executionReview = undefined; r.targetReview = undefined; r.error = undefined; r.conflicts = [];
        r.state = "changes_ready"; r.appliedPaths = []; r.pendingPath = undefined;
        writeFileSync(path.join(this.root, id, "changes.json"), JSON.stringify(changes, null, 2), { mode: 0o600 });
        return this.save(r);
      } catch (e) { r.state = "blocked"; r.error = message(e); return this.save(r); }
    });
  }
  async markReview(id: string, stage: "execution" | "target", result: ReviewResult): Promise<DeliveryRecord> {
    const r = this.require(id); if (!["passed", "failed", "unverified"].includes(result.verdict) || typeof result.summary !== "string") throw new Error("验收结果格式无效");
    if (stage === "execution") { r.executionReview = clone(result); if (result.verdict !== "passed") { r.state = "blocked"; r.error = "执行目录验收未通过：" + result.summary; } }
    else { r.targetReview = clone(result); if (result.verdict === "passed" && ["applied", "verified"].includes(r.state)) { r.state = "verified"; r.error = undefined; } }
    return this.save(r);
  }
  private async originalSafe(r: DeliveryRecord): Promise<void> {
    await this.confirmIdentity(r.identity);
    if (r.mode === "git-worktree" && await this.stage(r.identity.targetRoot) !== r.indexSignature) throw new Error("原项目 index/staged 内容已变化；不覆盖用户工作");
  }
  private checkCandidates(r: DeliveryRecord): void {
    if (!r.candidate) throw new Error("缺少候选快照");
    if (r.worktreePath) for (const c of r.changes) if (!same(this.entry(safeFile(r.worktreePath, c.path)), r.candidate[c.path])) throw new Error(`工作树在验收后又变化：${c.path}`);
  }
  private targetConflicts(r: DeliveryRecord): string[] {
    return r.changes.filter(c => { const current = this.entry(safeFile(r.identity.targetRoot, c.path)); return !same(current, r.baseline[c.path]) && !same(current, r.candidate?.[c.path]); }).map(c => c.path);
  }
  private writeEntry(r: DeliveryRecord, name: string, entry?: Entry): void {
    const dest = safeFile(r.identity.targetRoot, name);
    if (!entry) { if (!absent(dest)) unlinkSync(dest); return; }
    const blob = path.join(r.baselineDir, entry.hash); if (hash(readFileSync(blob)) !== entry.hash) throw new Error("快照 blob 校验失败");
    mkdirSync(path.dirname(dest), { recursive: true }); const temp = path.join(path.dirname(dest), `.pa-${r.id}-${randomUUID()}.tmp`);
    try { copyFileSync(blob, temp); chmodSync(temp, entry.mode); renameSync(temp, dest); }
    finally { if (!absent(temp)) unlinkSync(temp); }
  }
  apply(id: string): Promise<DeliveryRecord> {
    return this.serial(id, async () => {
      const r = this.require(id);
      if (["applied", "verified", "cleaned"].includes(r.state)) return r;
      if (r.executionReview?.verdict !== "passed" || !r.candidate) throw new Error("未通过执行目录验收，拒绝回写");
      if (r.mode === "in-place") { r.state = "applied"; r.targetUpdated = r.changes.length > 0; r.alreadyPresent = !r.changes.length; return this.save(r); }
      try {
        await this.originalSafe(r); await this.assertWorktree(r); this.checkCandidates(r);
        r.conflicts = this.targetConflicts(r); if (r.conflicts.length) throw new Error("目标文件存在并发修改：" + r.conflicts.join("、"));
        r.state = "applying"; r.error = undefined; this.save(r);
        for (const c of r.changes) {
          await this.originalSafe(r);
          const current = this.entry(safeFile(r.identity.targetRoot, c.path)); const desired = r.candidate[c.path];
          if (same(current, desired)) {
            if (r.pendingPath === c.path) { if (!r.appliedPaths.includes(c.path)) r.appliedPaths.push(c.path); r.pendingPath = undefined; this.save(r); }
            continue;
          }
          if (!same(current, r.baseline[c.path])) throw new Error(`应用前目标又变化：${c.path}`);
          r.pendingPath = c.path; this.save(r);
          this.writeEntry(r, c.path, desired);
          if (!r.appliedPaths.includes(c.path)) r.appliedPaths.push(c.path);
          r.pendingPath = undefined; this.save(r);
        }
        r.targetUpdated = r.appliedPaths.length > 0; r.alreadyPresent = !r.targetUpdated; r.state = "applied"; return this.save(r);
      } catch (e) {
        r.error = message(e);
        r.state = r.appliedPaths.length || r.pendingPath ? "partial" : "blocked";
        return this.save(r);
      }
    });
  }
  rollback(id: string): Promise<DeliveryRecord> {
    return this.serial(id, async () => {
      const r = this.require(id);
      if (r.mode === "in-place") { r.state = "blocked"; r.error = "非 Git 原地修改不盲目回滚；已保留备份供核对"; return this.save(r); }
      try {
        await this.originalSafe(r);
        const paths = [...new Set([...r.appliedPaths, ...(r.pendingPath ? [r.pendingPath] : [])])];
        for (const name of paths) { const current = this.entry(safeFile(r.identity.targetRoot, name)); if (!same(current, r.baseline[name]) && !same(current, r.candidate?.[name])) throw new Error(`回滚会覆盖用户新修改：${name}`); }
        for (const name of paths.reverse()) { if (!same(this.entry(safeFile(r.identity.targetRoot, name)), r.baseline[name])) this.writeEntry(r, name, r.baseline[name]); }
        r.state = "rolled_back"; r.appliedPaths = []; r.pendingPath = undefined; r.targetUpdated = false; r.error = "本次回写已安全还原；工作树与备份保留"; return this.save(r);
      } catch (e) { r.state = "partial"; r.error = message(e); return this.save(r); }
    });
  }
  cleanup(id: string): Promise<DeliveryRecord> {
    return this.serial(id, async () => {
      const r = this.require(id); if (r.state === "cleaned") return r;
      if (r.state !== "verified" || r.targetReview?.verdict !== "passed") throw new Error("原目标尚未复验通过，保留工作树");
      try {
        await this.originalSafe(r);
        if (r.mode === "git-worktree") {
          if (r.changes.some(c => !same(this.entry(safeFile(r.identity.targetRoot, c.path)), r.candidate?.[c.path]))) throw new Error("目标在验收后有变化，保留工作树");
          if (!absent(r.worktreePath!)) {
            await this.assertWorktree(r);
            const current = await this.snapshot(r.worktreePath!, true, r.baselineDir, []);
            if (JSON.stringify(current) !== JSON.stringify(r.candidate)) throw new Error("临时工作树有未归档的新改动，保留现场");
            await this.git(r.identity.targetRoot, ["worktree", "remove", "--force", r.worktreePath!]);
          } else {
            const list = (await this.git(r.identity.targetRoot, ["worktree", "list", "--porcelain", "-z"])).text;
            if (list.split("\0").some(s => s.startsWith("worktree ") && key(s.slice(9)) === key(r.worktreePath!))) throw new Error("工作树目录缺失但登记仍在，保留记录待核对");
          }
        }
        r.state = "cleaned"; r.cleanupDone = true; r.cleanupError = undefined; return this.save(r);
      } catch (e) { r.cleanupError = message(e); return this.save(r); }
    });
  }
}
