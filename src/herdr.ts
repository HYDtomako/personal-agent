import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";

export interface HerdrAgent {
  name?: string;
  agent?: string;
  agent_status?: string;
  pane_id?: string;
  workspace_id?: string;
  terminal_id?: string | number;
  agent_session?: Record<string, unknown> | null;
  state_change_seq?: number;
  completion_seq?: number;
  launch_pending?: boolean;
  interactive_ready?: boolean;
}

/** Small, injectable boundary. None of these operations waits for a CA task to finish. */
export interface HerdrAdapterLike {
  ensureServer(): Promise<void>;
  createWorkspace(input: { cwd: string; label: string }): Promise<{ workspaceId: string; paneId: string }>;
  startAgent(input: { name: string; worker: string; paneId: string; cwd?: string }): Promise<void>;
  prompt(name: string, text: string): Promise<void>;
  listAgents(): Promise<HerdrAgent[]>;
  readPane(paneId: string, lines: number): Promise<string>;
  sendText(paneId: string, text: string): Promise<void>;
  sendKeys(paneId: string, keys: string[]): Promise<void>;
  closeWorkspace(workspaceId: string): Promise<void>;
}

type CliResult = { stdout: string; stderr: string; code: number };
const CURRENT = process.env.HERDR_EXE?.trim()
  || path.join(os.homedir(), ".herdr", "packages", "standalone", "current", process.platform === "win32" ? "herdr.exe" : "herdr");
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const MCP_AUTH_REQUIRED = "检测到项目MCP，需要另行明确授权，未自动启用";
class UnsafeKimiProjectError extends Error {}
function normalizedDirectory(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  const withoutTrailing = normalized.length > path.parse(normalized).root.length ? normalized.replace(/[\\/]+$/, "") : normalized;
  return process.platform === "win32" ? withoutTrailing.toLowerCase() : withoutTrailing;
}

function jsonOutput(raw: string): Record<string, any> | undefined {
  for (const candidate of [raw.trim(), ...raw.trim().split(/\r?\n/).reverse()]) {
    if (!candidate.startsWith("{")) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* CLI diagnostics can precede the JSON response. */ }
  }
  return undefined;
}

function checked(result: CliResult): Record<string, any> | undefined {
  const json = jsonOutput(result.stdout) ?? jsonOutput(result.stderr);
  if (result.code !== 0 || json?.error) {
    const detail = json?.error?.message ?? json?.error?.code ?? (result.stderr.trim() || result.stdout.trim());
    throw new Error(`herdr: ${String(detail || `exit ${result.code}`).slice(-3000)}`);
  }
  return json;
}

/** Parameter-array CLI only; killing a timed-out CLI never kills the herdr server. */
export class HerdrAdapter implements HerdrAdapterLike {
  private readonly executable: string;
  private serverStart?: Promise<void>;

  constructor(opts: { executable?: string } = {}) {
    this.executable = opts.executable ?? (existsSync(CURRENT) ? CURRENT : "herdr");
  }

  private run(args: string[], timeoutMs = 20_000, executable = this.executable): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (error?: Error, code?: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      };
      const timer = setTimeout(() => {
        finish(new Error(`herdr ${args.slice(0, 2).join(" ")} CLI timeout (${timeoutMs}ms)`));
        child.kill();
      }, timeoutMs);
      const collect = (chunks: Buffer[]) => (data: Buffer) => {
        if (settled) return;
        size += data.length;
        if (size > OUTPUT_LIMIT) {
          finish(new Error("herdr CLI output exceeded 2 MiB"));
          child.kill();
        } else chunks.push(data);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.once("error", (error) => finish(error));
      child.once("close", (code) => finish(undefined, code));
    });
  }

  private async serverRunning(timeoutMs: number): Promise<boolean> {
    try {
      const result = await this.run(["status"], timeoutMs);
      return result.code === 0 && /status:\s*running\b/i.test(`${result.stdout}\n${result.stderr}`);
    } catch { return false; }
  }

  ensureServer(): Promise<void> {
    if (this.serverStart) return this.serverStart;
    const start = this.ensureServerOnce();
    this.serverStart = start;
    void start.finally(() => { if (this.serverStart === start) this.serverStart = undefined; }).catch(() => {});
    return start;
  }

  private async ensureServerOnce(): Promise<void> {
    if (await this.serverRunning(5000)) return;
    // Windows app restarts use taskkill /T. detached alone does not remove the
    // parent's process-tree relationship. Let a short-lived helper parent the
    // server, and wait for that helper to exit before treating startup as safe.
    const helper = `const { spawn } = require("node:child_process");\n` +
      `const child = spawn(process.argv[1], ["server"], { detached: true, stdio: "ignore", windowsHide: true, shell: false });\n` +
      `child.once("error", error => { console.error(error.message); process.exitCode = 1; });\n` +
      `child.once("spawn", () => child.unref());`;
    checked(await this.run(["--input-type=commonjs", "-e", helper, this.executable], 5000, process.execPath));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (await this.serverRunning(2000)) return;
    }
    throw new Error("herdr server 未能在启动宽限内就绪");
  }

  async createWorkspace(input: { cwd: string; label: string }): Promise<{ workspaceId: string; paneId: string }> {
    const json = checked(await this.run(["workspace", "create", "--cwd", input.cwd, "--label", input.label, "--no-focus"]));
    const workspaceId = json?.result?.workspace?.workspace_id;
    const paneId = json?.result?.root_pane?.pane_id;
    if (typeof workspaceId !== "string" || !workspaceId || typeof paneId !== "string" || !paneId) {
      throw new Error("herdr workspace create 没有返回 workspace_id / pane_id");
    }
    return { workspaceId, paneId };
  }

  async startAgent(input: { name: string; worker: string; paneId: string; cwd?: string }): Promise<void> {
    // Native directory trust persists independently of MCP contents. Check on EVERY
    // Kimi launch, not just when its Trust menu happens to be visible.
    const safeCwd = input.worker === "kimi" && input.cwd !== undefined ? await this.checkKimiProject(input.cwd) : undefined;
    const args = ["agent", "start", input.name, "--kind", input.worker, "--pane", input.paneId, "--timeout", "60000"];
    // Kimi's --yolo still prompts. --auto is the explicitly authorised mode.
    if (input.worker === "kimi") args.push("--", "--auto");
    const started = this.run(args, 80_000).then((result) => { checked(result); });
    if (input.worker !== "kimi") { await started; return; }
    const controller = new AbortController();
    try {
      // herdr may keep its start RPC pending until Trust is dismissed. Supervise
      // the UI concurrently, but never permit a prompt until BOTH have succeeded.
      // Promise.all installs rejection handlers on both, including a late failure.
      await Promise.all([started, this.waitForKimiUi(input.paneId, controller.signal, input.cwd, safeCwd)]);
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  }

  private async metadataExists(file: string): Promise<boolean> {
    try { await lstat(file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }

  /** Metadata only: never open, parse, or copy project MCP contents/credentials. */
  private async checkKimiProject(cwd: string): Promise<string> {
    try {
      if (!cwd || !path.isAbsolute(cwd) || cwd.includes("\0")) throw new Error("cwd 路径不明");
      const lexical = path.resolve(cwd);
      const actual = path.normalize(await realpath(lexical));
      if (!(await stat(actual)).isDirectory()) throw new Error("cwd 不是目录");
      const ancestors = new Set<string>();
      for (const origin of [lexical, actual]) {
        let directory = origin;
        for (;;) {
          ancestors.add(directory);
          const parent = path.dirname(directory);
          if (parent === directory) break;
          directory = parent;
        }
      }
      const rejectConfig = async (file: string) => {
        if (await this.metadataExists(file)) throw new Error(`存在项目 MCP 路径：${file}`);
      };
      let needsGitRoot = process.env.GIT_DIR !== undefined || process.env.GIT_WORK_TREE !== undefined;
      for (const directory of ancestors) {
        await rejectConfig(path.join(directory, ".mcp.json"));
        if (await this.metadataExists(path.join(directory, ".git"))) needsGitRoot = true;
      }
      for (const directory of new Set([lexical, actual])) {
        const kimiDirectory = path.join(directory, ".kimi-code");
        // A dangling/invalid .kimi-code path is not evidence that MCP is absent.
        if (await this.metadataExists(kimiDirectory)) {
          if (!(await stat(kimiDirectory)).isDirectory()) throw new Error(".kimi-code 路径不明");
          await realpath(kimiDirectory);
        }
        await rejectConfig(path.join(kimiDirectory, "mcp.json"));
      }
      if (needsGitRoot) {
        const result = await this.run(["-C", actual, "rev-parse", "--show-toplevel"], 5000, "git");
        const root = result.stdout.trim();
        if (result.code !== 0 || !root || /[\r\n\0]/.test(root) || !path.isAbsolute(root)) throw new Error("无法确认真实 Git 工作树根目录");
        const actualRoot = await realpath(root);
        if (!(await stat(actualRoot)).isDirectory()) throw new Error("Git 工作树根路径不明");
        await rejectConfig(path.join(root, ".mcp.json"));
        await rejectConfig(path.join(actualRoot, ".mcp.json"));
      }
      return actual;
    } catch (error) {
      throw new UnsafeKimiProjectError(`${MCP_AUTH_REQUIRED}；${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private isExpectedTrustMenu(text: string, cwd: string): boolean {
    const lines = text.split("\n").map((line) => line.trim().replace(/^[│┃]\s*/, "").replace(/\s*[│┃]$/, "").trim());
    // Kimi 2.2 asks "Trust this folder?" and selects "Trust and continue"; older
    // builds selected "Trust this folder" directly. Accept only a selected trust
    // action, never the Exit row, and keep the exact-cwd check in both layouts.
    const selectedTrust = lines.some((line) => /^❯\s+Trust this folder\s*$/i.test(line));
    const selectedContinue = lines.some((line) => /^❯\s+Trust and continue\s*$/i.test(line));
    const trustTitle = lines.some((line) => /^Trust this folder\?\s*$/i.test(line));
    if (!selectedTrust && !(selectedContinue && trustTitle)) return false;
    const directories = lines.filter((line) => path.isAbsolute(line));
    return directories.length === 1 && !directories[0].includes("\0") && normalizedDirectory(directories[0]) === normalizedDirectory(cwd);
  }

  /** CLI readiness can precede Kimi's mounted input UI; never send into that gap. */
  private async waitForKimiUi(paneId: string, signal: AbortSignal, cwd?: string, safeCwd?: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    let previousReady: string | undefined;
    let trustSent = false;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      try {
        const text = (await this.readPaneWithTimeout(paneId, 100, Math.min(5000, Math.max(1, deadline - Date.now()))))
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "").trim();
        signal.throwIfAborted();
        const ready = /Welcome\s+to\s+Kimi\s+Code/i.test(text)
          && /\bNever\s+Ask\b|完全自动/i.test(text)
          && /\bcontext\s*[:：]?\s*\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*%\s*context\b/i.test(text);
        if (ready && previousReady === text && Date.now() < deadline) return;
        previousReady = ready ? text : undefined;
        if (!ready && !trustSent && cwd !== undefined && safeCwd && this.isExpectedTrustMenu(text, safeCwd)) {
          const checkedCwd = await this.checkKimiProject(cwd);
          signal.throwIfAborted();
          if (normalizedDirectory(checkedCwd) !== normalizedDirectory(safeCwd)) throw new UnsafeKimiProjectError(`${MCP_AUTH_REQUIRED}；cwd 在启动期间发生变化`);
          if (Date.now() >= deadline) break;
          signal.throwIfAborted();
          trustSent = true; // Even an uncertain CLI response must never lead to a second Enter.
          await this.sendKeys(paneId, ["enter"]);
          signal.throwIfAborted();
        }
      } catch (error) {
        if (signal.aborted || error instanceof UnsafeKimiProjectError) throw error;
        // A transient read error breaks stability but may recover within the same deadline.
        previousReady = undefined;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(500, remaining), undefined, { signal });
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    throw new Error("Kimi 界面未在 30 秒内连续两次稳定就绪（Welcome to Kimi Code / Never Ask / context footer）；未发送任务");
  }

  async prompt(name: string, text: string): Promise<void> {
    checked(await this.run(["agent", "prompt", name, text]));
  }

  async listAgents(): Promise<HerdrAgent[]> {
    const json = checked(await this.run(["agent", "list"]));
    const agents = json?.result?.agents;
    if (!Array.isArray(agents) || agents.some((value) => !value || typeof value !== "object")) {
      throw new Error("herdr agent list 返回格式无效");
    }
    return agents;
  }

  readPane(paneId: string, lines: number): Promise<string> {
    return this.readPaneWithTimeout(paneId, lines, 20_000);
  }

  private async readPaneWithTimeout(paneId: string, lines: number, timeoutMs: number): Promise<string> {
    const result = await this.run(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)], timeoutMs);
    const json = checked(result);
    const text = json?.result?.text ?? json?.result?.output ?? json?.result?.content;
    return (typeof text === "string" ? text : result.stdout).trim();
  }

  async sendText(paneId: string, text: string): Promise<void> {
    checked(await this.run(["pane", "send-text", paneId, text]));
  }

  async sendKeys(paneId: string, keys: string[]): Promise<void> {
    checked(await this.run(["pane", "send-keys", paneId, ...keys]));
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    if (!workspaceId) throw new Error("拒绝关闭无标识的 herdr workspace");
    try {
      checked(await this.run(["workspace", "close", workspaceId]));
    } catch (error) {
      // Retried cleanup after a crash is idempotent, but transport failures are not success.
      if (!/\bworkspace\b[^\n]*(?:not found|does not exist|already closed)|\bWORKSPACE_NOT_FOUND\b/i.test(String(error))) throw error;
    }
  }
}
