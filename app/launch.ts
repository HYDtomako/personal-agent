#!/usr/bin/env node
/**
 * 桌面启动器：串行启停 PA 主服务与 Telegram 桥接，复用已运行的单实例，再开窗口。
 *
 * 为什么不引 Electron：服务本身冷启动只要 ~170ms，慢的从来不是服务，而是"打开浏览器"那一步
 * ——默认浏览器（这台机器上是 360）冷启动、黑窗口一直占着、以及浏览器比服务先起来导致的竞态
 * （页面在服务就绪前发 /api/history 会失败，停在空白页要手动刷新）。
 * 这里不加任何依赖，只把顺序做对，并借用系统已有的 Edge/Chrome 的 --app 模式：
 * 窗口没有标签栏、没有地址栏，任务栏里就是一个独立窗口。
 *
 * 用法：
 *   node app/launch.ts               后台起服务，开窗口后本进程退出（服务继续跑）
 *   node app/launch.ts --console     服务跑在当前控制台里（看日志用，Ctrl+C 一起退出）
 *   node app/launch.ts --no-window   确保主服务和 Telegram 都在后台运行，不开窗口
 *   node app/launch.ts --restart     只重启本项目的主服务和 Telegram，再开窗口
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appName } from "./name.ts";
import { acquireInstance, projectProcesses, stopProjectProcesses } from "./runtime.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(appDir, "..");
/**
 * 服务入口用绝对路径：进程列表里 `node <仓库路径>\src\main.ts` 一眼能认出属于本项目的启动器，
 * 外部按命令行清理进程的脚本（QQ 桥接那套）才不会把它和别的项目的 src/main.ts 认混。
 */
const serverEntry = path.join(root, "src", "main.ts");
const argv = process.argv.slice(2);
const consoleMode = argv.includes("--console");
const noWindow = argv.includes("--no-window");
const restart = argv.includes("--restart");
const say = (...a: unknown[]): void => console.log(...a);

/** config.json 里的 gui 段（启动器只需要这三个字段） */
interface GuiConf {
  host: string;
  port: number;
  token: string;
  workspace: string;
  telegram: { enabled?: boolean; token?: string } | undefined;
}

function readGui(): GuiConf | null {
  const file = path.join(root, "config.json");
  if (!existsSync(file)) return null;
  const cfg = JSON.parse(readFileSync(file, "utf8")) as {
    gui?: { host?: string; port?: number; token?: string };
    agent?: { workspace?: string };
    telegram?: { enabled?: boolean; token?: string };
  };
  return {
    host: cfg.gui?.host ?? "127.0.0.1",
    port: Number(cfg.gui?.port ?? 8787),
    token: cfg.gui?.token ?? "",
    workspace: path.resolve(root, cfg.agent?.workspace ?? "workspace"),
    telegram: cfg.telegram,
  };
}

const WILDCARD = new Set(["", "0.0.0.0", "::", "localhost"]);
/** 通配监听地址不能直接连，换回回环地址（要开的窗口就在本机）。 */
const dialHost = (host: string): string => (WILDCARD.has(host) ? "127.0.0.1" : host);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tcpOpen(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v: boolean): void => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/**
 * 这个端口上是不是"我们的"服务——不只要求能连上，还要 /api/status 回我们认识的 JSON。
 * 否则别的程序占了同一个端口时，我们会傻乎乎地开个窗口指着它的页面。
 */
async function probe(host: string, port: number, token: string, timeoutMs = 1200): Promise<Record<string, unknown> | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/api/status`, {
      signal: ctl.signal,
      headers: token ? { "x-token": token } : {},
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    return j && typeof j.userId === "string" && typeof j.workspace === "string" ? j : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 服务输出落到 memory/server.log——没有控制台可看了，排障就靠它。 */
function logFile(): string {
  const dir = path.join(root, "memory");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "server.log");
  try {
    if (statSync(file).size > 3 * 1024 * 1024) renameSync(file, `${file}.1`);
  } catch {
    /* 不存在或改名失败都无所谓 */
  }
  return file;
}

function tailLog(file: string, lines = 12): string {
  try {
    return readFileSync(file, "utf8").trim().split("\n").slice(-lines).join("\n");
  } catch {
    return "(还没有日志)";
  }
}

/** 没有控制台可打印时用系统弹窗报错，否则用户只会看到"双击了但什么都没发生"。 */
function complain(title: string, text: string): void {
  if (consoleMode) {
    say(`\n[启动失败] ${title}\n${text}\n`);
    return;
  }
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  const ps = `Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show(${q(text)}, ${q(title)}, 'OK', 'Warning')`;
  try {
    spawnSync("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], { windowsHide: true, timeout: 60_000 });
  } catch {
    /* 弹窗都失败就算了 */
  }
}

function startServer(): { child: ChildProcess; log: string } {
  const log = logFile();
  say(`[app] 启动服务：node ${serverEntry}`);
  if (consoleMode) {
    // 前台：这个控制台就是日志窗口
    return { child: spawn(process.execPath, [serverEntry], { cwd: root, stdio: "inherit", windowsHide: true }), log };
  }
  const out = openSync(log, "a");
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    // detached：脱离启动器的控制台与作业，关掉启动器不会连带杀掉服务
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  closeSync(out);
  return { child, log };
}

/** 优先系统自带的 Edge/Chrome。 */
function findBrowser(): string | null {
  const env = process.env;
  const dirs = [env["ProgramFiles(x86)"], env["ProgramFiles"], env["LOCALAPPDATA"], "C:\\Program Files", "C:\\Program Files (x86)"]
    .filter((d): d is string => !!d);
  for (const rel of ["Microsoft\\Edge\\Application\\msedge.exe", "Google\\Chrome\\Application\\chrome.exe"]) {
    for (const dir of dirs) {
      const p = path.join(dir, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * 窗口参数：尺寸只在浏览器还没有记住这个页面的窗口大小时起作用
 * （Chromium 会按 app 维度保存你拖过的大小，之后它说了算）。
 * 写成 1180x880 而不是 1180,880：命令要过 cmd 的 start，逗号是它的参数分隔符。
 */
function windowArgs(url: string): string[] {
  return [`--app=${url}`, "--no-first-run", "--no-default-browser-check", "--window-size=1180x880"];
}

function openWindow(url: string): void {
  const browser = findBrowser();
  if (!browser) {
    // 没有 Edge/Chrome：退回默认浏览器（会带标签栏，但至少能用）
    say("[app] 没找到 Edge/Chrome，改用默认浏览器");
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  // 经 cmd 的 start 而不是直接 spawn：快捷方式是以"最小化"启动的（为了不弹黑窗口），
  // 那个显示状态会被子进程继承，直接 spawn 出去的话浏览器第一个窗口也是最小化的。
  // start 默认按正常状态显示，正好把状态重置掉。
  say(`[app] 打开窗口：${path.basename(browser)}`);
  spawn("cmd", ["/c", "start", "", browser, ...windowArgs(url)], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

async function ensureTelegram(gui: GuiConf): Promise<void> {
  if (!gui.telegram || gui.telegram.enabled === false) {
    say("[app] Telegram 未启用，跳过桥接。");
    return;
  }
  if (!gui.telegram.token?.trim()) throw new Error("Telegram 已启用但 token 为空，请检查 config.json。");
  const existing = projectProcesses(root).telegram;
  if (existing.length > 1) throw new Error("检测到多个 Telegram 桥接，请运行 restart-pa.bat 收敛为一个。");
  if (existing.length) {
    say(`[app] Telegram 桥接已在运行 · PID ${existing[0].ProcessId}`);
    return;
  }
  const file = path.join(root, "memory", "telegram.log");
  mkdirSync(path.dirname(file), { recursive: true });
  const out = openSync(file, "a");
  const child = spawn(process.execPath, [path.join(root, "tg-bridge.mjs")], {
    cwd: root, detached: true, windowsHide: true, stdio: ["ignore", out, out],
  });
  child.on("error", () => {});
  child.unref();
  closeSync(out);
  await sleep(1000);
  const running = projectProcesses(root).telegram;
  if (running.length !== 1) throw new Error(`Telegram 桥接未能正常启动。\n${tailLog(file)}`);
  say(`[app] Telegram 桥接已启动 · PID ${running[0].ProcessId} · 日志 ${file}`);
}

async function main(): Promise<number> {
  const gui = readGui();
  if (!gui) throw new Error(`缺少 ${path.join(root, "config.json")}，请先配置。`);
  const operation = await acquireInstance(root, "operation", 45_000);
  if (!operation) throw new Error("另一个 PA 启停操作尚未完成，请稍后重试。");
  let foreground: ChildProcess | undefined;
  try {
    if (restart) await stopProjectProcesses(root);
    const host = dialHost(gui.host);
    const url = `http://${host}:${gui.port}/${gui.token ? `?token=${encodeURIComponent(gui.token)}` : ""}`;
    let status = await probe(host, gui.port, gui.token);
    const existing = projectProcesses(root).main;
    if (existing.length > 1) throw new Error("检测到多个 PA 主服务，请运行 restart-pa.bat 收敛为一个。");
    if (!status && !existing.length) {
      if (await tcpOpen(host, gui.port)) {
        throw new Error(`端口 ${gui.port} 被其他程序占用，已取消启动；不会停止占用者。`);
      }
      const started = startServer();
      if (consoleMode) foreground = started.child;
      started.child.on("error", () => {});
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        status = await probe(host, gui.port, gui.token, 800);
        if (status || started.child.exitCode !== null) break;
        await sleep(150);
      }
    } else if (!status) {
      const deadline = Date.now() + 25_000;
      while (!status && Date.now() < deadline) {
        await sleep(150);
        status = await probe(host, gui.port, gui.token, 800);
      }
    }
    if (!status) throw new Error(`PA 服务未就绪。\n${tailLog(path.join(root, "memory", "server.log"))}`);
    const running = projectProcesses(root).main;
    if (running.length !== 1 || status.pid !== running[0].ProcessId
      || path.resolve(String(status.workspace)).toLowerCase() !== gui.workspace.toLowerCase()) {
      throw new Error(`端口 ${gui.port} 上的服务身份与当前项目不符，已取消操作。`);
    }
    say(`[app] PA 服务就绪 · PID ${status.pid} · 端口 ${gui.port} · 模型 ${String(status.model ?? "?")}`);
    await ensureTelegram(gui);
    if (!noWindow) openWindow(url);
    say("[app] 关窗口不会停止后台服务；重复点击只复用现有进程。");
  } finally {
    await operation.release();
  }
  if (!foreground) return 0;
  if (foreground.exitCode !== null) return foreground.exitCode;
  return await new Promise<number>((resolve) => foreground!.once("exit", (code) => resolve(code ?? 0)));
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    complain(`${appName()} 启动失败`, err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
