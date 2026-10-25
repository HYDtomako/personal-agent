import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireInstance, assertNoQQDescendants, isEntryProcess, listNodeProcesses, projectProcesses, sleep, stopProjectProcesses } from "../app/runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = mkdtempSync(path.join(tmpdir(), "pi-agent app test-"));
const unrelated = mkdtempSync(path.join(tmpdir(), "qqbot isolation test-"));
const children = [];

function run(entry, args = []) {
  const child = spawn(process.execPath, [entry, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout.on("data", (data) => output += data);
  child.stderr.on("data", (data) => output += data);
  return {
    child,
    done: new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, output }));
    }),
  };
}

const fixtureMain = `import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { acquireInstance } from '../app/runtime.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!await acquireInstance(root, 'main')) process.exit(0);
const cfg = JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8'));
createServer((req,res) => {
  if(req.headers['x-token'] !== cfg.gui.token) { res.writeHead(401); res.end(); return; }
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({pid:process.pid,userId:'test',workspace:path.join(root,'workspace'),model:'fake',busy:0}));
}).listen(cfg.gui.port, '127.0.0.1');`;
const fixtureTelegram = `import { acquireInstance } from './app/runtime.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
if (!await acquireInstance(root, 'telegram')) process.exit(0);
setInterval(()=>{}, 1000);`;

try {
  const identity = { ExecutablePath: process.execPath, CommandLine: `"${process.execPath}"  "${path.join(root, "src", "main.ts")}"` };
  assert(isEntryProcess(identity, path.join(root, "src", "main.ts")));
  assert(!isEntryProcess({ ...identity, CommandLine: `"${process.execPath}" "D:\\pi-napcatqq\\src\\main.ts"` }, path.join(root, "src", "main.ts")));
  assert(!isEntryProcess({ ...identity, CommandLine: `"${process.execPath}" -e "${path.join(root, "src", "main.ts")}"` }, path.join(root, "src", "main.ts")));
  console.log("ok 精确入口识别，不匹配 QQbot、同名 main.ts 或嵌入字符串");
  const nestedQQ = [
    { ProcessId: 10, ParentProcessId: 0, ...identity },
    { ProcessId: 11, ParentProcessId: 10, ExecutablePath: "C:\\Windows\\System32\\cmd.exe", CommandLine: "cmd.exe" },
    { ProcessId: 12, ParentProcessId: 11, ExecutablePath: process.execPath, CommandLine: `"${process.execPath}" "${path.join(path.dirname(root), "pi-napcatqq", "src", "main.ts")}"` },
  ];
  assert.throws(() => assertNoQQDescendants(root, 10, nestedQQ), /拒绝连带停止/);
  assertNoQQDescendants(root, 10, nestedQQ.map((p) => p.ProcessId === 12 ? { ...p, ParentProcessId: 99 } : p));
  console.log("ok QQbot 即使经 cmd 挂在 PA 子进程树下，也拒绝连带停止");

  const first = await acquireInstance(fixture, "test");
  assert(first);
  assert.equal(await acquireInstance(fixture, "test"), null);
  await first.release();
  const reacquired = await acquireInstance(fixture, "test");
  assert(reacquired);
  await reacquired.release();
  console.log("ok 原子单实例锁及释放后重获");

  for (const dir of ["app", "src", "public", "workspace"]) mkdirSync(path.join(fixture, dir));
  for (const file of ["launch.ts", "stop.ts", "runtime.mjs", "name.ts"]) copyFileSync(path.join(root, "app", file), path.join(fixture, "app", file));
  writeFileSync(path.join(fixture, "public", "index.html"), "<title>启动器自检</title>");
  writeFileSync(path.join(fixture, "src", "main.ts"), fixtureMain);
  writeFileSync(path.join(fixture, "tg-bridge.mjs"), fixtureTelegram);
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  writeFileSync(path.join(fixture, "config.json"), JSON.stringify({
    gui: { host: "127.0.0.1", port, token: "fixture-token" },
    agent: { workspace: "workspace" }, telegram: { enabled: true, token: "fake-token" },
  }));
  mkdirSync(path.join(unrelated, "src"));
  writeFileSync(path.join(unrelated, "src", "main.ts"), "setInterval(()=>{},1000);");
  const other = run(path.join(unrelated, "src", "main.ts"));
  await sleep(300);
  const otherBefore = listNodeProcesses().find((info) => info.ProcessId === other.child.pid);
  assert(otherBefore);

  const launches = await Promise.all([
    run(path.join(fixture, "app", "launch.ts"), ["--no-window"]).done,
    run(path.join(fixture, "app", "launch.ts"), ["--no-window"]).done,
  ]);
  for (const launched of launches) assert.equal(launched.code, 0, launched.output);
  const before = projectProcesses(fixture);
  assert.equal(before.main.length, 1);
  assert.equal(before.telegram.length, 1);
  console.log("ok 并发点击后主服务与 Telegram 各一个，认证健康检查正常");

  const duplicateMain = await run(path.join(fixture, "src", "main.ts")).done;
  const duplicateTelegram = await run(path.join(fixture, "tg-bridge.mjs")).done;
  assert.equal(duplicateMain.code, 0);
  assert.equal(duplicateTelegram.code, 0);
  assert.equal(projectProcesses(fixture).main[0].ProcessId, before.main[0].ProcessId);
  assert.equal(projectProcesses(fixture).telegram[0].ProcessId, before.telegram[0].ProcessId);
  console.log("ok 绕过启动器直接运行也拒绝重复实例");

  const repeated = await run(path.join(fixture, "app", "launch.ts"), ["--no-window"]).done;
  assert.equal(repeated.code, 0, repeated.output);
  assert.equal(projectProcesses(fixture).main[0].ProcessId, before.main[0].ProcessId);
  assert.equal(projectProcesses(fixture).telegram[0].ProcessId, before.telegram[0].ProcessId);
  console.log("ok 重复启动复用现有 PID");

  const restarted = await run(path.join(fixture, "app", "launch.ts"), ["--restart", "--no-window"]).done;
  assert.equal(restarted.code, 0, restarted.output);
  const after = projectProcesses(fixture);
  assert.equal(after.main.length, 1);
  assert.equal(after.telegram.length, 1);
  assert.notEqual(after.main[0].ProcessId, before.main[0].ProcessId);
  assert.notEqual(after.telegram[0].ProcessId, before.telegram[0].ProcessId);
  const otherAfter = listNodeProcesses().find((info) => info.ProcessId === other.child.pid);
  assert.equal(otherAfter?.CreationDate, otherBefore.CreationDate);
  console.log("ok 一键重启仅替换本项目进程，不影响同名入口的其他 Node 服务");

  process.kill(after.telegram[0].ProcessId);
  await sleep(300);
  const recovered = await run(path.join(fixture, "app", "launch.ts"), ["--no-window"]).done;
  assert.equal(recovered.code, 0, recovered.output);
  const recovery = projectProcesses(fixture);
  assert.equal(recovery.main[0].ProcessId, after.main[0].ProcessId);
  assert.equal(recovery.telegram.length, 1);
  assert.notEqual(recovery.telegram[0].ProcessId, after.telegram[0].ProcessId);
  console.log("ok 桥接退出后再次点击只补启动桥接，主服务保持不变");

  const stopped = await run(path.join(fixture, "app", "stop.ts")).done;
  assert.equal(stopped.code, 0, stopped.output);
  assert.equal(projectProcesses(fixture).main.length, 0);
  assert.equal(projectProcesses(fixture).telegram.length, 0);
  assert.equal(listNodeProcesses().find((info) => info.ProcessId === other.child.pid)?.CreationDate, otherBefore.CreationDate);
  console.log("ok 停止同时结束本项目两个进程，不使用端口杀进程");

  const blocker = createServer((socket) => socket.destroy());
  await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  const occupied = await run(path.join(fixture, "app", "launch.ts"), ["--no-window", "--console"]).done;
  assert.equal(occupied.code, 1, occupied.output);
  assert(occupied.output.includes("被其他程序占用"), occupied.output);
  assert(blocker.listening);
  await new Promise((resolve) => blocker.close(resolve));
  console.log("ok 外部端口占用时拒绝启动，保留占用者");
  console.log("\n启动器自检全部通过（未连接 Telegram 或调用模型）。");
} finally {
  await stopProjectProcesses(fixture);
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill();
  }
  await sleep(300);
  rmSync(fixture, { recursive: true, force: true });
  rmSync(unrelated, { recursive: true, force: true });
}
