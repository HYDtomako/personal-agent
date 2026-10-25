import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalize = (value) => path.resolve(value).replace(/\\/g, "/").toLowerCase();

/** Windows named pipes are released by the OS, including after taskkill or a crash. */
export async function acquireInstance(root, role, waitMs = 0) {
  if (process.platform !== "win32") throw new Error("桌面进程管理目前仅支持 Windows。");
  const key = createHash("sha256").update(normalize(root)).digest("hex").slice(0, 20);
  const address = `\\\\.\\pipe\\pi-agent-${key}-${role}`;
  const deadline = Date.now() + waitMs;
  do {
    const server = createServer((socket) => socket.end());
    const acquired = await new Promise((resolve, reject) => {
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE") resolve(false);
        else reject(error);
      });
      server.listen(address, () => resolve(true));
    });
    if (acquired) {
      server.unref();
      return { release: () => new Promise((resolve) => server.close(resolve)) };
    }
    if (Date.now() >= deadline) return null;
    await sleep(150);
  } while (true);
}

function listWindowsProcesses() {
  const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine) | ConvertTo-Json -Compress`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  if (result.error || result.status !== 0) throw new Error("无法核验 Node 进程身份；为避免影响其他项目，已取消操作。");
  const parsed = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, "") || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function listNodeProcesses() {
  return listWindowsProcesses().filter((info) => info.ExecutablePath && path.basename(info.ExecutablePath).toLowerCase() === "node.exe");
}

export function assertNoQQDescendants(root, pid, processes) {
  const descendants = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const info of processes) {
      if (descendants.has(info.ParentProcessId) && !descendants.has(info.ProcessId)) {
        descendants.add(info.ProcessId);
        changed = true;
      }
    }
  }
  const qqEntry = path.join(path.dirname(root), "pi-napcatqq", "src", "main.ts");
  const napcatDir = normalize(path.join(path.dirname(root), "NapCat.Shell.Windows.Node")) + "/";
  for (const info of processes) {
    if (!descendants.has(info.ProcessId)) continue;
    if (isEntryProcess(info, qqEntry) || (info.ExecutablePath && normalize(info.ExecutablePath).startsWith(napcatDir))) {
      throw new Error(`QQbot/NapCat 进程 ${info.ProcessId} 位于 PA 子进程树中，拒绝连带停止。`);
    }
  }
}

export function isEntryProcess(info, entry) {
  if (!info?.ExecutablePath || !info?.CommandLine) return false;
  const args = info.CommandLine.match(/"[^\"]*"|[^\s]+/g)?.map((arg) => arg.replace(/^"|"$/g, "")) ?? [];
  return path.basename(info.ExecutablePath).toLowerCase() === "node.exe"
    && args.length >= 2 && path.isAbsolute(args[1]) && normalize(args[1]) === normalize(entry);
}

export function projectProcesses(root, processes = listNodeProcesses()) {
  return {
    main: processes.filter((info) => isEntryProcess(info, path.join(root, "src", "main.ts"))),
    telegram: processes.filter((info) => isEntryProcess(info, path.join(root, "tg-bridge.mjs"))),
  };
}

export async function stopProjectProcesses(root) {
  const initialSnapshot = listWindowsProcesses();
  const initial = projectProcesses(root, initialSnapshot);
  for (const info of [...initial.main, ...initial.telegram]) assertNoQQDescendants(root, info.ProcessId, initialSnapshot);
  for (const [role, candidates] of [["telegram", initial.telegram], ["main", initial.main]]) {
    const entry = path.join(root, role === "main" ? "src/main.ts" : "tg-bridge.mjs");
    for (const candidate of candidates) {
      const snapshot = listWindowsProcesses();
      const current = snapshot.find((info) => info.ProcessId === candidate.ProcessId);
      if (!current) continue;
      if (current.CreationDate !== candidate.CreationDate || !isEntryProcess(current, entry)) {
        throw new Error(`进程 ${candidate.ProcessId} 身份已变化，拒绝终止。`);
      }
      assertNoQQDescendants(root, current.ProcessId, snapshot);
      const result = spawnSync("taskkill", ["/PID", String(current.ProcessId), "/T", "/F"], { windowsHide: true, timeout: 15_000 });
      if (result.error || result.status !== 0) {
        if (listNodeProcesses().some((info) => info.ProcessId === current.ProcessId && info.CreationDate === current.CreationDate)) {
          throw new Error(`无法停止 ${role} 进程 ${current.ProcessId}。`);
        }
      }
      console.log(`[app] 已停止 ${role} · PID ${current.ProcessId}`);
    }
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const remaining = projectProcesses(root);
    if (!remaining.main.length && !remaining.telegram.length) return;
    await sleep(150);
  }
  throw new Error("PA 进程仍未退出，已取消后续启动。");
}
