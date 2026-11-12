import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { captureChildOutput } from "../src/child-output.ts";
import { ProjectDelivery } from "../src/project-delivery.ts";

function nodeChild(script, stdio = ["ignore", "pipe", "pipe"]) {
  return spawn(process.execPath, ["-e", script], { stdio, windowsHide: true });
}

test("reassembles CJK and emoji split across chunks, keeps a final line without newline, and finishes on close", async () => {
  const text = "跨块你好🙂\n末行无换行";
  const child = nodeChild(`
    const buf = Buffer.from(${JSON.stringify(text)});
    const cut = buf.indexOf(Buffer.from("你")) + 1;
    const err = Buffer.from("错误🙂");
    process.stdout.write(buf.subarray(0, cut));
    process.stderr.write(err.subarray(0, 1));
    setTimeout(() => {
      process.stdout.write(buf.subarray(cut));
      process.stderr.write(err.subarray(1));
    }, 30);
  `);
  let settled = false;
  const pending = captureChildOutput(child).then((result) => {
    settled = true;
    return result;
  });
  child.on("exit", () => {
    assert.equal(settled, false);
  });
  const result = await pending;
  assert.equal(result.code, 0);
  assert.equal(result.stdout, text);
  assert.equal(result.stdout.includes("\uFFFD"), false);
  assert.equal(result.stderr, "错误🙂");
});

test("a final JSON line without a newline survives a split inside a multibyte character", async () => {
  const line = JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "摘要你好🙂" }] } });
  const child = nodeChild(`
    const buf = Buffer.from(${JSON.stringify(line)});
    const cut = buf.indexOf(Buffer.from("你")) + 1;
    process.stdout.write(buf.subarray(0, cut));
    setTimeout(() => process.stdout.write(buf.subarray(cut)), 20);
  `);
  const result = await captureChildOutput(child);
  assert.equal(result.stdout, line);
  assert.equal(JSON.parse(result.stdout).message.content[0].text, "摘要你好🙂");
});

test("decoder.end flushes a trailing partial UTF-8 sequence on close", async () => {
  const child = nodeChild("process.stdout.write(Buffer.from([0xe4]));");
  const result = await captureChildOutput(child);
  assert.equal(result.stdout, "\uFFFD");
});

test("stderr tail is sliced after decoding, so a character split at the window stays intact", async () => {
  const child = nodeChild(`
    const head = Buffer.alloc(7999, 0x61);
    const all = Buffer.concat([head, Buffer.from("你尾")]);
    const cut = head.length + 1;
    process.stderr.write(all.subarray(0, cut));
    setTimeout(() => process.stderr.write(all.subarray(cut)), 20);
  `);
  const result = await captureChildOutput(child, { maxStderr: 8000 });
  assert.equal(result.stderr.length, 8000);
  assert.equal(result.stderr.endsWith("你尾"), true);
  assert.equal(result.stderr.includes("\uFFFD"), false);
});

test("project delivery git() keeps a Chinese emoji path when git stdout is split mid-character", { timeout: 30000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pa-utf8-git-"));
  const previousPath = process.env.PATH;
  const previousReal = process.env.PA_REAL_GIT;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousReal === undefined) delete process.env.PA_REAL_GIT;
    else process.env.PA_REAL_GIT = previousReal;
    rmSync(root, { recursive: true, force: true });
  });
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  assert.equal(realGit.startsWith("/"), true);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "repo");
  mkdirSync(bin);
  mkdirSync(repo);
  const wrapper = path.join(bin, "git");
  writeFileSync(wrapper, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const real = spawn(process.env.PA_REAL_GIT, process.argv.slice(2), { stdio: ["inherit", "pipe", "inherit"] });
const chunks = [];
real.stdout.on("data", (chunk) => chunks.push(chunk));
real.on("error", (error) => { process.stderr.write(String(error && error.message || error)); process.exit(127); });
real.on("close", (code) => {
  const buf = Buffer.concat(chunks);
  if (buf.length === 0) process.exit(code ?? 0);
  let cut = buf.length > 1 ? 1 : buf.length;
  for (let i = 1; i < buf.length; i++) if ((buf[i] & 0xc0) === 0x80) { cut = i; break; }
  process.stdout.write(buf.subarray(0, cut), () => {
    setTimeout(() => process.stdout.write(buf.subarray(cut), () => process.exit(code ?? 0)), 20);
  });
});
`);
  chmodSync(wrapper, 0o755);
  const git = (args) => {
    const result = spawnSync(realGit, args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  };
  const name = "你好🔑.txt";
  git(["init", "-b", "main"]);
  git(["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  writeFileSync(path.join(repo, name), "内容\n");
  git(["add", "."]);
  git(["-c", "user.name=PA fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline"]);
  process.env.PA_REAL_GIT = realGit;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  const engine = new ProjectDelivery({
    rootDir: path.join(root, "records"),
    worktreesDir: path.join(root, "worktrees"),
    gitTimeoutMs: 20000,
  });
  const record = await engine.prepare({ id: "utf8", cwd: repo });
  assert.equal(record.state, "prepared", record.error);
  assert.deepEqual(Object.keys(record.baseline).sort(), ["a.txt", name].sort());
});
